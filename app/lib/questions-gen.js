/**
 * lib/questions-gen.js
 * 自动出题：给定品牌，生成「真实用户会问 AI 的问题」。
 *
 * 设计参考：OmniRank tools/keyword_generator.py 的三层出题法——认知层、决策层、场景层，
 * 每层再落到具体意图上。这里只沿用「三层 × 六意图」的设计结论，模板、文案与实现都是自研，
 * 不复制其源码或提示词原文。
 *
 * 为什么问题里绝对不能出现品牌名（硬规则）：
 * GEO 诊断的做法，是把问题原样丢给 AI 引擎，看它会不会在回答里主动提到并推荐这个品牌。
 * 一旦问题里已经写了品牌名，模型就会顺着问题作答（等于自问自答），品牌的「被提及率」
 * 被凭空抬高，分数虚高；做竞品对比时也会先把注意力锚定到我们，带偏诊断结论。
 * 所以本模块在模板填充前后各做一次「去品牌名」检查：字段值里的品牌名先剔除，
 * 成品题目再过一遍兜底替换，命中就换成「这类」等泛称，并写入 warnings 留痕。
 *
 * 约束：
 * - 零依赖、纯函数：不读文件、不发网络请求、不碰 Math.random / Date.now。
 * - 确定性：同一 brand + seed 必须一字不差地复现。seed 只用于数组下标偏移，
 *   让同一品牌能出多批顺序/组合不同的题，不引入任何随机源。
 * - 字段缺失一律安全兜底，绝不抛错；每一次兜底都写进 warnings，方便排查。
 */

/** 六种意图（顺序即出题、展示顺序；认知→决策→场景） */
export const QUESTION_INTENTS = Object.freeze([
  'what',
  'city',
  'compare',
  'price',
  'howto',
  'risk',
]);

/** 三层（顺序即报告里的分组顺序） */
const TIERS = Object.freeze(['awareness', 'decision', 'scenario']);

/** 层 → 中文标题（渲染 Markdown 用） */
const TIER_LABELS = Object.freeze({
  awareness: '认知层',
  decision: '决策层',
  scenario: '场景层',
});

/**
 * 意图 → 层。
 * 认知层解决「你是谁、在哪」，决策层解决「选谁、多少钱」，场景层解决「怎么落地、怎么避坑」。
 * 这三层正好对应真实用户从「知道」到「掏钱」的心理路径，出题覆盖全链路才不会被单一阶段的
 * 答案带偏。
 */
const INTENT_TIER = Object.freeze({
  what: 'awareness',
  city: 'awareness',
  compare: 'decision',
  price: 'decision',
  howto: 'scenario',
  risk: 'scenario',
});

/** count 缺省值：三层 × 六意图，每意图约 4 题 */
const DEFAULT_COUNT = 24;

/** 服务名最多取几个（防止品牌配置乱写导致候选爆炸） */
const MAX_SERVICES = 8;

/** 字段缺失时的安全兜底词；宁可题目泛一点，也不能编造品牌不具备的服务 */
const FALLBACK_CITY = '本地';
const FALLBACK_SERVICE = '相关服务';
const FALLBACK_CUSTOMER = '中小企业';
const FALLBACK_COMPETITOR = '外地老牌公司';

// ---------------------------------------------------------------- 内部小工具

/** 统一成去首尾空白的字符串；非字符串一律当空串 */
function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 统一成数组：数组原样返回，字符串包一层，其余当空数组 */
function asList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) return [value];
  return [];
}

/** 去重且保持首次出现顺序 */
function uniqueList(list) {
  return [...new Set(list)];
}

/**
 * 确定性下标偏移：等价于左旋 list，但只依赖 seed，不依赖随机源。
 * seed 不同 → 偏移不同 → 出的题顺序不同；seed 相同 → 结果完全一致。
 */
function rotate(list, offset) {
  if (!Array.isArray(list) || list.length <= 1) return Array.isArray(list) ? list.slice() : [];
  const shift = ((Math.trunc(offset) % list.length) + list.length) % list.length;
  return list.slice(shift).concat(list.slice(0, shift));
}

/** 把 seed 归一化成正整数；非法值退回 1，保证默认行为稳定 */
function normalizeSeed(seed) {
  const value = Number(seed);
  if (!Number.isFinite(value) || value === 0) return 1;
  const normalized = Math.abs(Math.trunc(value)) % 2147483647;
  return normalized || 1;
}

/**
 * count 归一化。
 * 它是「上限」不是承诺值：候选不足或去重后可能略少，所以这里只负责把非法值拉回 24，
 * 负数/0 返回 0（调用方明确要空批次时不该被强行塞题）。
 */
function normalizeCount(count) {
  if (count === undefined || count === null || count === '') return DEFAULT_COUNT;
  const value = Number(count);
  if (!Number.isFinite(value)) return DEFAULT_COUNT;
  return Math.max(0, Math.trunc(value));
}

/** warnings 收集器：Set 去重 + 保持首次出现顺序，避免同一条兜底刷屏 */
function createWarnings() {
  const messages = new Set();
  return {
    add(message) {
      if (message) messages.add(message);
    },
    list() {
      return [...messages];
    },
  };
}

/**
 * 收集「绝对不能出现在题目里」的名字：品牌名、工商全称、别名、歧义别名。
 * 按长度倒序处理，先替换长串（如「芜湖恒野数字科技有限公司」），再替换短串（如「恒野」），
 * 避免长串被短串提前切碎后留下残渣。
 */
function collectForbiddenNames(brand) {
  const raw = [
    brand.name,
    brand.legalName,
    ...asList(brand.aliases),
    ...asList(brand.ambiguousAliases),
  ];
  return uniqueList(raw.map(asText).filter(Boolean)).sort((a, b) => b.length - a.length);
}

/**
 * 清洗字段值：剔除品牌名、压缩空白、去掉结尾标点（避免往模板里塞出「，。」）。
 * 这里命中品牌名会写 warning —— 字段本身带品牌名（例如服务叫「恒野GEO」）很常见，
 * 不剔除就会让题目把品牌名带出去。
 */
function sanitizeValue(value, forbiddenNames, warnings) {
  let result = asText(value);
  if (!result) return '';
  for (const name of forbiddenNames) {
    if (result.includes(name)) {
      result = result.split(name).join('');
      warnings.add(
        `字段值里的品牌名「${name}」已剔除：问题中带品牌名会引导 AI 顺着品牌作答，污染诊断结果`,
      );
    }
  }
  return result
    .replace(/\s+/g, ' ')
    .replace(/[，,、；;：:]+$/, '')
    .trim();
}

/**
 * 选一个「安全泛称」来替换品牌名：泛称本身不能又包含任何品牌名/别名，
 * 否则替换完仍然泄漏（极端情况如品牌名就是「这」）。没有安全的就用空串直接删掉，
 * 宁可句子略生硬，也不能把品牌名留在题目里。
 */
function pickSafeReplacement(forbiddenNames) {
  const candidates = ['这类', '相关服务商', '专业团队', ''];
  return (
    candidates.find(
      (candidate) => !forbiddenNames.some((name) => candidate.includes(name)),
    ) ?? ''
  );
}

/**
 * 成品题目的最后一道闸：再扫一遍品牌名，命中就替换成泛称。
 * 前面的字段清洗已经能挡掉绝大多数情况，这里是防御性兜底——只要这里触发，
 * 说明有新的填充路径绕过了清洗，warning 会把它暴露出来。
 */
function finalizeText(rawText, forbiddenNames, warnings) {
  let result = asText(rawText).replace(/\s+/g, ' ').trim();
  if (!result) return '';
  const replacement = pickSafeReplacement(forbiddenNames);
  for (const name of forbiddenNames) {
    if (result.includes(name)) {
      result = result.split(name).join(replacement);
      warnings.add(
        `题目里检出品牌名「${name}」，已替换为泛称：问题里带品牌名会引导 AI 回答，污染诊断结果`,
      );
    }
  }
  // 中英文/数字边界补空格，避免「老板 IP一般多少钱」「做GEO优化」这类贴字，读起来更自然
  result = result
    .replace(/([A-Za-z0-9])([\u4e00-\u9fa5])/g, '$1 $2')
    .replace(/([\u4e00-\u9fa5])([A-Za-z0-9])/g, '$1 $2');
  return result.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- 模板（三层 × 六意图）

/**
 * 每个意图一组模板变体。
 * 共同点：句子里只出现「服务、城市、行业、目标客户、竞品」这类公开信息，
 * 品牌名一律不出现；模板本身不写死任何行业，靠 brand 字段填充。
 * 每层两个意图、每个意图至少 4 个变体，保证单服务品牌时每层也能凑够 6 题。
 */
const VARIANTS = {
  // 认知层 · what：先让 AI 解释「这类服务是什么」，用户此刻还没进入选型
  what: [
    (ctx) => `${ctx.service}到底是做什么的？主要解决什么问题？`,
    (ctx) => `${ctx.customer}想做${ctx.service}，一般包含哪些具体工作？`,
    (ctx) => `${ctx.service}和传统营销推广相比，核心区别在哪？`,
    (ctx) => `第一次了解${ctx.service}，需要先搞清哪些基本概念？`,
    (ctx) => `${ctx.region}的${ctx.service}服务通常包含哪些交付内容？`,
  ],

  // 认知层 · city：让 AI 报本地/全国范围内的候选池，这是「被发现」的主战场
  city: [
    (ctx) => `${ctx.region}有哪些做${ctx.service}的公司或工作室？`,
    (ctx) => `${ctx.region}做${ctx.service}的服务商哪家比较靠谱？`,
    (ctx) => `想找${ctx.region}的${ctx.service}团队，一般通过什么渠道？`,
    (ctx) => `${ctx.region}做${ctx.service}的公司，服务范围一般覆盖到哪？`,
    (ctx) => `${ctx.region}有没有专注${ctx.service}的小团队？`,
  ],

  // 决策层 · compare：用户已经在几个候选之间摇摆，需要对比参照物
  // 注意对照物可以是竞品，但绝不能是我们自己的品牌名。
  compare: [
    (ctx) => `${ctx.competitor}和本地${ctx.service}工作室，哪个更适合${ctx.customer}？`,
    (ctx) => `自己招人做${ctx.service}，还是直接找${ctx.service}服务商？`,
    (ctx) => `${ctx.service}和${ctx.altService}有什么区别？该怎么选？`,
    (ctx) => `找${ctx.service}服务商时，大公司和小团队怎么选？`,
    (ctx) => `${ctx.localPhrase}和${ctx.remoteLabel}做${ctx.service}，差别在哪？`,
  ],

  // 决策层 · price：价格是决策层最硬的信号，也最容易让 AI 编数字，值得多问几种问法
  price: [
    (ctx) => `${ctx.service}一般多少钱一个月？`,
    (ctx) => `${ctx.region}${ctx.service}的收费标准大概是多少？`,
    (ctx) => `${ctx.service}的报价为什么差这么多？怎么判断贵不贵？`,
    (ctx) => `${ctx.service}一般按什么方式收费？有没有隐藏费用？`,
    (ctx) => `预算有限时，${ctx.service}的哪些环节可以省、哪些不能省？`,
  ],

  // 场景层 · howto：用户准备动手了，关心第一步、判断标准与验证方法
  howto: [
    (ctx) => `怎么判断一家${ctx.service}服务商靠不靠谱？`,
    (ctx) => `${ctx.customer}想找${ctx.service}，第一步该做什么？`,
    (ctx) => `找${ctx.service}服务商时，应该先看案例还是先看报价？`,
    (ctx) => `找${ctx.service}服务商，远程合作和上门沟通各要注意什么？`,
    (ctx) => `怎么验证${ctx.service}服务商的案例和数据是真实的？`,
  ],

  // 场景层 · risk：用户担心被坑，关心合同、承诺与止损；出这层题是为了拿到真实的负面信号
  risk: [
    (ctx) => `找${ctx.service}服务商，常见的坑有哪些？`,
    (ctx) => `怎么避免被${ctx.service}服务商套路？合同里要写清什么？`,
    (ctx) => `${ctx.service}服务商承诺效果，可信吗？`,
    (ctx) => `便宜和贵的${ctx.service}服务，风险分别在哪？`,
    (ctx) => `合作中途效果不好，${ctx.service}项目怎么止损、怎么解约？`,
  ],
};

// ---------------------------------------------------------------- 品牌归一化

/**
 * 把外部传入的 brand 归一化成出题要用的字段集合。
 * 所有缺失/非法/含品牌名的字段都在这里被兜底或清洗，后续流程只认归一化结果，
 * 这样 generateQuestions 永远不会因为品牌配置不全而抛错。
 */
function normalizeBrand(rawBrand, warnings) {
  const brand = rawBrand && typeof rawBrand === 'object' ? rawBrand : {};
  const forbiddenNames = collectForbiddenNames(brand);

  // 城市：缺省用「本地」；本地化问法不写死城市名，方便给没填城市的品牌直接用
  const rawCity = asText(brand.city);
  const city = sanitizeValue(rawCity, forbiddenNames, warnings) || FALLBACK_CITY;
  if (!rawCity) warnings.add('字段 city 缺失，已用「本地」兜底');

  // 行业：只作为兜底服务名来源，不直接塞进句子（行业常带斜杠和长描述，硬塞会别扭）
  const industry = sanitizeValue(brand.industry, forbiddenNames, warnings);

  // 服务：优先 brand.services；为空时按约定用 industry + 「服务」兜底
  const services = uniqueList(
    asList(brand.services)
      .map((service) => sanitizeValue(service, forbiddenNames, warnings))
      .filter(Boolean),
  ).slice(0, MAX_SERVICES);

  let serviceTerms;
  if (services.length > 0) {
    serviceTerms = services;
  } else if (industry) {
    serviceTerms = [industry.endsWith('服务') ? industry : `${industry}服务`];
    warnings.add('字段 services 为空，已用 industry 拼出兜底服务名');
  } else {
    serviceTerms = [FALLBACK_SERVICE];
    warnings.add('字段 services 与 industry 均为空，已用「相关服务」兜底');
  }

  // 服务范围：含「全国」就同时出「全国」和「本地」两种问法，否则只出本地
  const scope = asText(brand.scope);
  const nationwide = scope.includes('全国');
  if (!scope) warnings.add('字段 scope 缺失，按本地范围出题');

  // 目标客户：用于场景层的主语替换；缺失时用「中小企业」
  const customers = uniqueList(
    asList(brand.targetCustomers)
      .map((customer) => sanitizeValue(customer, forbiddenNames, warnings))
      .filter(Boolean),
  );
  if (customers.length === 0) {
    customers.push(FALLBACK_CUSTOMER);
    warnings.add('字段 targetCustomers 为空，已用「中小企业」兜底');
  }

  // 竞品：对比题需要参照物；缺失时用泛化对照（仍然不带我们自己的品牌名）
  const competitors = uniqueList(
    asList(brand.competitors)
      .map((competitor) => sanitizeValue(competitor, forbiddenNames, warnings))
      .filter(Boolean),
  );
  if (competitors.length === 0) {
    competitors.push(FALLBACK_COMPETITOR);
    warnings.add('字段 competitors 为空，对比题改用泛化对照对象');
  }

  // 地域标签：本地在前、全国在后；统一去重，避免 city 本身就是「全国」时出重复题
  const regions = uniqueList(nationwide ? [city, '全国'] : [city]);

  return {
    city,
    industry,
    nationwide,
    serviceTerms,
    customers,
    competitors,
    regions,
    forbiddenNames,
  };
}

// ---------------------------------------------------------------- 候选生成

/**
 * 按意图生成候选题目池。
 * 每个意图内：模板变体 × 服务 ×（城市意图再 × 地域），全部用 seed 做下标偏移，
 * 因此同 seed 稳定、不同 seed 组合不同。城市意图把地域放在最内层轮转，
 * 保证 count 不大时也能同时抽到「全国」和「本地」两种问法。
 */
function buildCandidatePools(brandData, seed, warnings) {
  const pools = {};
  const intentOrder = rotate([...QUESTION_INTENTS], seed % QUESTION_INTENTS.length);

  for (const intent of intentOrder) {
    const intentIndex = QUESTION_INTENTS.indexOf(intent);
    // 每个意图的首个模板是「最典型问法」，固定排第一（保证正确 seed 下一定能出这条）；
    // 其余变体按 seed 轮转，用来出多批不同的题。
    const variants = [
      VARIANTS[intent][0],
      ...rotate(VARIANTS[intent].slice(1), seed + intentIndex * 11),
    ];
    const services = rotate(brandData.serviceTerms, seed + intentIndex * 7);
    const customers = rotate(brandData.customers, seed + intentIndex * 5);
    const competitors = rotate(brandData.competitors, seed + intentIndex * 3);
    const items = [];

    // 服务在外层、模板在内层：轮询取题时同一批的前几条会落在不同问法上，
    // 不会出现「前 8 条全是同一个句式、只换了服务名」这种一眼看穿的模板题。
    for (let serviceIndex = 0; serviceIndex < services.length; serviceIndex += 1) {
      for (let variantIndex = 0; variantIndex < variants.length; variantIndex += 1) {
        const service = services[serviceIndex];
        // 对比题的另一个参照物：优先用品牌配置里的第二个服务，只有一个服务时退回「自己投广告」
        const altService =
          services.length > 1
            ? services[(serviceIndex + 1) % services.length]
            : '自己投广告';

        // 城市意图：地域全部轮一遍；其他意图：按下标挑一个地域，保持整批题的本地/全国混合
        const regionList =
          intent === 'city'
            ? brandData.regions
            : [
                brandData.regions[
                  (variantIndex + serviceIndex + seed + intentIndex) % brandData.regions.length
                ],
              ];

        for (const region of regionList) {
          const ctx = {
            service,
            altService,
            region,
            industry: brandData.industry,
            customer: customers[(variantIndex + serviceIndex + seed) % customers.length],
            competitor:
              competitors[(variantIndex + serviceIndex + seed + intentIndex) % competitors.length],
            localPhrase:
              brandData.city === FALLBACK_CITY ? '本地团队' : `${brandData.city}本地团队`,
            remoteLabel: brandData.nationwide ? '全国线上团队' : '外地团队',
          };
          const text = finalizeText(variants[variantIndex](ctx), brandData.forbiddenNames, warnings);
          if (text) items.push({ text, intent, tier: INTENT_TIER[intent] });
        }
      }
    }

    pools[intent] = items;
  }

  return { pools, intentOrder };
}

/**
 * 轮询选取：按意图轮流各取一条，避免某个意图把 count 名额吃光。
 * 这样即使 count 只有十几条，三层也都有覆盖，不会退化成「全是城市题」。
 * 完全相同的题目（去重后）只保留一条。
 */
function selectCandidates({ pools, intentOrder }, limit) {
  const selected = [];
  const seen = new Set();
  const cursors = new Map(intentOrder.map((intent) => [intent, 0]));

  let progressed = true;
  while (selected.length < limit && progressed) {
    progressed = false;
    for (const intent of intentOrder) {
      if (selected.length >= limit) break;
      const pool = pools[intent] || [];
      let cursor = cursors.get(intent) || 0;
      while (cursor < pool.length) {
        const item = pool[cursor];
        cursor += 1;
        if (seen.has(item.text)) continue;
        seen.add(item.text);
        selected.push(item);
        progressed = true;
        break;
      }
      cursors.set(intent, cursor);
    }
  }

  return selected;
}

/** 优先级规则：认知层前 3 题 P0；决策层前 4 题 P0（决策层 P0 优先）；场景层只用 P1/P2 */
function priorityFor(tier, indexInTier) {
  if (tier === 'awareness') return indexInTier < 3 ? 'P0' : 'P1';
  if (tier === 'decision') return indexInTier < 4 ? 'P0' : 'P1';
  return indexInTier < 2 ? 'P1' : 'P2';
}

/**
 * 排序并落字段：先按层分组（认知→决策→场景），再在层内按生成顺序编优先级。
 * 固定层顺序能让报告和 Markdown 每次都长一个样，方便比对不同 seed 的批次。
 */
function finalizeQuestions(selected) {
  const tierRank = new Map(TIERS.map((tier, index) => [tier, index]));
  const ordered = selected
    .slice()
    .sort((a, b) => (tierRank.get(a.tier) ?? 99) - (tierRank.get(b.tier) ?? 99));

  const counters = { awareness: 0, decision: 0, scenario: 0 };

  return ordered.map((item) => {
    const indexInTier = counters[item.tier] ?? 0;
    counters[item.tier] = indexInTier + 1;
    return {
      text: item.text,
      intent: item.intent,
      tier: item.tier,
      priority: priorityFor(item.tier, indexInTier),
      source: 'generated',
    };
  });
}

// ---------------------------------------------------------------- 对外 API

/**
 * 生成「真实用户会问 AI 的问题」。
 *
 * @param {object} [options]
 * @param {object} [options.brand] 品牌配置：{name, city, scope, industry, services, targetCustomers, competitors, ambiguousAliases}
 * @param {number} [options.count=24] 题目数量上限（去重后可能略少）
 * @param {number} [options.seed=1] 批次种子；只做下标偏移，不引入随机源
 * @returns {{questions: Array<{text: string, intent: string, tier: string, priority: string, source: string}>, warnings: string[]}}
 */
export function generateQuestions(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const { brand, count = DEFAULT_COUNT, seed = 1 } = opts;

  const warnings = createWarnings();
  const brandData = normalizeBrand(brand, warnings);

  const limit = normalizeCount(count);
  if (limit <= 0) return { questions: [], warnings: warnings.list() };

  const normalizedSeed = normalizeSeed(seed);
  const built = buildCandidatePools(brandData, normalizedSeed, warnings);
  const selected = selectCandidates(built, limit);

  return {
    questions: finalizeQuestions(selected),
    warnings: warnings.list(),
  };
}

/**
 * 把题目渲染成 Markdown：按层分组，每行带优先级与意图标注，方便贴进报告或人工复核。
 * 空数组（或无效输入）返回「暂无题目」，不抛错。
 *
 * @param {Array<{text: string, intent: string, tier: string, priority: string}>} questions
 * @returns {string}
 */
export function renderQuestionsMarkdown(questions) {
  const list = asList(questions).filter(
    (question) => question && typeof question === 'object' && asText(question.text),
  );
  if (list.length === 0) return '暂无题目';

  const groups = new Map();
  for (const question of list) {
    const tier = asText(question.tier) || 'unknown';
    if (!groups.has(tier)) groups.set(tier, []);
    groups.get(tier).push(question);
  }

  // 已知层固定顺序在前，未知层（后续扩展用）按首次出现顺序补在后面
  const orderedTiers = [
    ...TIERS.filter((tier) => groups.has(tier)),
    ...[...groups.keys()].filter((tier) => !TIERS.includes(tier)),
  ];

  return orderedTiers
    .map((tier) => {
      const label = TIER_LABELS[tier] || tier || '其他';
      const lines = groups.get(tier).map((question) => {
        const priority = asText(question.priority) || 'P1';
        const intent = asText(question.intent) || 'unknown';
        return `- [${priority}] ${asText(question.text)}（${intent}）`;
      });
      return [`## ${label}`, ...lines].join('\n');
    })
    .join('\n\n');
}
