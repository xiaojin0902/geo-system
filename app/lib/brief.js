/**
 * 内容 brief（content-brief 负责）
 *
 * 核心是「证据优先」（SPEC §0.5 / §3.7）：
 * - mustIncludeFacts 只能取自 brand.evidenceFacts 与品牌基础字段；
 * - 没有可核验事实时显式写「待补充可验证事实」，绝不编造客户案例、数字、资质、排名；
 * - banned 至少包含绝对化/承诺类词；outline 含「证据与来源」小节；distribution 要求回填 URL。
 *
 * 零依赖、纯函数；同一输入同输出。
 */
import { CLUSTERS, classifyCluster } from './keywords.js';

export const DEFAULT_BANNED = ['最好', '第一', '唯一', '顶级', '保证', '100%', '稳赚', '绝对'];
export const FORMATS = ['问答', '指南', '对比', '案例', '清单'];

const FORMAT_BY_CLUSTER = {
  品牌实体: '问答',
  本地推荐: '清单',
  价格费用: '指南',
  对比选择: '对比',
  流程交付: '指南',
  避坑风险: '清单',
  GEO认知: '指南',
  竞品替代: '对比',
};

const INTENT_DESC = {
  发现: '用户想确认品牌是谁、做什么、是否真实存在',
  本地: '用户想找本地/可面谈的服务商，先确认服务范围',
  比较: '用户已在多个候选之间，想比较差异与适用条件',
  推荐: '用户想要具体推荐、口碑或榜单参考',
  价格: '用户关心报价、费用构成与预算区间',
  流程: '用户关心合作流程、周期、交付物与售后',
  避坑: '用户担心被坑，想识别风险信号与合同要点',
  认知: '用户想理解 AI 搜索 / GEO 是什么、怎么做',
  替代: '用户想替换现有服务商，寻找同类替代方案',
};

function cleanText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’「『（(]+/, '')
    .replace(/["'“”‘’」』）)？?。.!！,，;；:：]+$/, '')
    .trim();
}

function truncate(text, max = 160) {
  const chars = Array.from(String(text ?? ''));
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

function normalizeQuestion(question) {
  if (typeof question === 'string') {
    const raw = String(question ?? '').replace(/\s+/g, ' ').trim();
    return { text: cleanText(raw), rawText: raw, intent: '', tier: '', priority: '' };
  }
  if (question && typeof question === 'object') {
    const raw = String(question.rawText ?? question.text ?? question.question ?? question.term ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      text: cleanText(raw),
      rawText: raw,
      intent: question.intent || '',
      tier: question.tier || '',
      priority: question.priority || '',
    };
  }
  return { text: '', rawText: '', intent: '', tier: '', priority: '' };
}

function normalizeKeyword(keyword, question, brand) {
  if (typeof keyword === 'string') {
    return { term: cleanText(keyword), cluster: '', intent: '', difficulty: null, priority: '' };
  }
  if (keyword && typeof keyword === 'object') {
    return {
      term: cleanText(keyword.term ?? keyword.text ?? question.text),
      cluster: keyword.cluster || '',
      intent: keyword.intent || '',
      difficulty: Number.isInteger(keyword.difficulty) ? keyword.difficulty : null,
      priority: keyword.priority || '',
    };
  }
  const cluster = question.text ? classifyCluster(question.text, brand) : '品牌实体';
  return { term: cleanText(question.text), cluster, intent: '', difficulty: null, priority: '' };
}

function pickFormat({ cluster, question, brand }) {
  const text = question.text;
  // 「案例」型必须真有一手案例事实，否则降级，避免诱导编造。
  if (/案例|复盘|真实经历/.test(text)) return '案例';
  if (FORMAT_BY_CLUSTER[cluster]) return FORMAT_BY_CLUSTER[cluster];
  return '指南';
}

/** 从题目/簇里抽出用于匹配 evidenceFacts 的 token */
function focusTokens(question, cluster, intent) {
  const text = question.text;
  const brandWords = ['团队', '人数', '创始人', '老板', '官网', '联系方式', '邮箱', '工作时间', '回复', '价格', '费用', '多少钱', '报价', '流程', '周期', '交付', '排期', '案例', '客户', '口碑', '评价', '定位', '口号', '承诺', '服务'];
  const tokens = new Set();
  for (const word of brandWords) if (text.includes(word)) tokens.add(word);
  const intentWords = {
    价格: ['价格', '元', '费用', '报价', '月'],
    流程: ['交付', '排期', '工作日', '回复'],
    推荐: ['定位', '服务', '承诺'],
    本地: ['芜湖', '合肥', '服务范围'],
    比较: ['服务', '价格'],
    认知: ['GEO', '定位', '服务'],
    避坑: ['承诺', '效果', '价格'],
    替代: ['服务', '价格'],
  };
  const clusterIntent = {
    品牌实体: '发现',
    本地推荐: '本地',
    价格费用: '价格',
    对比选择: '比较',
    流程交付: '流程',
    避坑风险: '避坑',
    GEO认知: '认知',
    竞品替代: '替代',
  }[cluster] || '';
  for (const word of intentWords[intent] || []) tokens.add(word);
  for (const word of intentWords[clusterIntent] || []) tokens.add(word);
  return [...tokens];
}

/**
 * 从 evidenceFacts 中挑与当前问题最相关的事实。
 * 只做「是否命中 token」的确定性打分，不改写事实原文。
 */
function matchEvidenceFacts(brand, question, cluster, intent) {
  const facts = (brand.evidenceFacts || []).filter((fact) => typeof fact === 'string' && fact.trim());
  if (facts.length === 0) return [];
  const tokens = focusTokens(question, cluster, intent);
  const extra = [brand.city, brand.name, ...(brand.services || [])].filter(Boolean);
  const candidates = [...new Set([...tokens, ...extra])];
  const scored = facts.map((fact, index) => {
    let score = 0;
    for (const token of candidates) if (fact.includes(token)) score += 1;
    if (/多少钱|价格|费用/.test(question.text) && /\d/.test(fact) && /元|费用|价格/.test(fact)) score += 1;
    return { fact, index, score };
  });
  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .map((item) => item.fact);
}

/** 组装「必须引用的可验证事实」：全部来自品牌配置，禁止任何外部生成数字 */
function buildMustIncludeFacts(brand, question, cluster, intent) {
  const facts = [];
  const add = (value) => {
    const text = String(value ?? '').trim();
    if (text && !facts.includes(text)) facts.push(text);
  };

  const aliasList = (brand.aliases || []).filter(
    (alias) => alias && alias !== brand.name && alias !== brand.legalName,
  );
  const identity = [];
  if (brand.name) identity.push(`品牌名「${brand.name}」`);
  if (brand.legalName) identity.push(`公司全称「${brand.legalName}」`);
  if (aliasList.length) identity.push(`对外也使用「${aliasList.join('、')}」`);
  if (identity.length) add(`[品牌基础字段] ${identity.join('，')}`);

  if (brand.city && brand.scope) add(`[品牌基础字段] 所在地「${brand.city}」；服务范围：${brand.scope}`);
  else if (brand.city) add(`[品牌基础字段] 所在地「${brand.city}」`);
  else if (brand.scope) add(`[品牌基础字段] 服务范围：${brand.scope}`);

  if (Array.isArray(brand.services) && brand.services.length) {
    add(`[品牌基础字段] 主营服务：${brand.services.join('、')}`);
  }
  if (Array.isArray(brand.targetCustomers) && brand.targetCustomers.length) {
    add(`[品牌基础字段] 主要服务对象：${brand.targetCustomers.join('、')}`);
  }

  const priceLike = cluster === '价格费用' || intent === '价格' || /价格|费用|多少钱|报价|收费/.test(question.text);
  if (priceLike && brand.priceRange) {
    add(`[品牌基础字段] 公开价格区间（以品牌当前报价为准）：${brand.priceRange}`);
  }

  const contactLike = cluster === '流程交付' || intent === '流程' || /联系|邮箱|电话|工作时间|多久|回复|响应/.test(question.text);
  if (contactLike && brand.contact) {
    const parts = [];
    if (brand.contact.email) parts.push(`邮箱 ${brand.contact.email}`);
    if (brand.contact.hours) parts.push(`工作时间 ${brand.contact.hours}`);
    if (brand.contact.replySla) parts.push(`响应时效 ${brand.contact.replySla}`);
    if (parts.length) add(`[品牌基础字段] 联系方式：${parts.join('；')}`);
  }

  if (Array.isArray(brand.urls) && brand.urls.length && /官网|网站|链接|地址/.test(question.text)) {
    add(`[品牌基础字段] 官方网站：${brand.urls.join('、')}`);
  }

  if (Array.isArray(brand.differentiators) && brand.differentiators.length) {
    add(`[品牌自述] ${brand.differentiators.join('；')}（引用时标注为「${brand.name || '品牌'}自述」）`);
  }

  const evidence = matchEvidenceFacts(brand, question, cluster, intent);
  for (const fact of evidence) add(`[evidenceFacts] ${fact}`);

  const noEvidence = !Array.isArray(brand.evidenceFacts) || brand.evidenceFacts.length === 0 || evidence.length === 0;
  if (noEvidence) {
    add('待补充可验证事实：本主题相关的真实交付案例、可公开数据或第三方引用；拿到之前正文只写流程与方法，不写结果数字与案例。');
  }

  return facts;
}

function buildEvidenceRequirements({ brand, cluster, intent, lastRunStats }) {
  const requirements = [
    '正文里的每个事实性表述都要能落回「必须引用的可验证事实」，对不上的句子删掉或改写成方法描述。',
    '涉及数字（价格、周期、数量）只引用品牌已公开且可核对的口径，并注明适用范围与生效时间。',
    '客户案例必须有客户授权与可核验链接；没有就写「待补充可验证事实」，不得虚构客户、案例与结果。',
    '资质、荣誉、排名类表述不得出现，除非能给出可查询的官方公示链接。',
    '效果类内容只描述交付了什么（服务内容/流程/交付物），不承诺涨粉、成单、排名或 AI 一定推荐。',
    '每篇至少给 2 条可点击来源（品牌官网、官方账号或公开报道），并标注访问日期。',
  ];
  if (cluster === '对比选择' || cluster === '竞品替代') {
    requirements.push('竞品信息只引用对方官网/官方账号等公开页面并标注抓取日期；只陈述事实，不贬低对手。');
  }
  if (cluster === '本地推荐') {
    requirements.push(`地名与服务范围以品牌披露为准（${brand.city || '本地'}及可面谈范围），不要扩大到未承诺的城市。`);
  }
  if (cluster === '价格费用' || intent === '价格') {
    requirements.push('报价与品牌当前价格表逐项一致，写清适用条件、周期与「以最终方案为准」。');
  }
  if (lastRunStats) {
    requirements.push(buildRunBaselineNote(lastRunStats));
  }
  return requirements;
}

function buildRunBaselineNote(lastRunStats) {
  const coverage = lastRunStats.coverage || {};
  const planned = coverage.planned ?? lastRunStats.planned_n ?? null;
  const ok = coverage.ok ?? lastRunStats.ok_n ?? null;
  const total = lastRunStats.total ?? null;
  const level = lastRunStats.level || '';
  const bits = [];
  if (planned != null && ok != null) {
    const ratio = planned > 0 ? ok / planned : 0;
    bits.push(`有效回答 ${ok}/${planned}（覆盖率 ${(ratio * 100).toFixed(1)}%）`);
  }
  if (total != null) bits.push(`总分 ${total}，等级「${level || '—'}」`);
  else bits.push('样本不足，暂不出总分');
  return `本次诊断基线：${bits.join('；')}。发布后回填 URL，7 天后用同一批问题复测并对比。`;
}

function evidenceSourceSection() {
  return {
    h2: '证据与来源',
    points: [
      '逐条列出本篇引用的来源（品牌官网/官方账号/公开报道），并标注访问日期。',
      '把正文逐句对照「必须引用的可验证事实」，删掉没有来源的句子。',
      '区分「可独立核验的事实」与「品牌自述」，后者在文中显式标注。',
    ],
  };
}

function buildOutline({ brand, question, cluster, format }) {
  const name = brand.name || '品牌';
  const service = (brand.services || []).filter(Boolean)[0] || '服务';
  const topic = truncate(question.text || '该问题', 40);
  const sharedSource = evidenceSourceSection();

  if (format === '对比') {
    return [
      {
        h2: '对比范围与判定口径',
        points: [
          `说明本文比较的对象与口径，围绕目标问题「${topic}」展开。`,
          '给出 3-5 个可比维度：服务范围、交付物、周期、价格口径、适用对象。',
          '说明信息来源与访问日期，不用传闻或截图二次转述做对比。',
        ],
      },
      {
        h2: '关键维度逐项对比',
        points: [
          '按维度列成表格，每个格子只写可核验事实。',
          '对方信息只引用其官网/官方账号等公开页面，并标注抓取日期。',
          '无法核实的格子写「待核实」，不猜测、不补数字。',
        ],
      },
      {
        h2: '什么情况适合哪一类',
        points: [
          '按目标、预算、团队规模给出条件式建议（如果…则…）。',
          '明确写出「不适合」的情况，降低误购。',
          '避免绝对化结论，不给「最好/第一」这类排序。',
        ],
      },
      {
        h2: `${name}的适用边界`,
        points: [
          `说明${name}的服务项目与交付物（引用品牌公开信息）。`,
          '写清可承接与不承接的范围，以及服务范围（所在地/线上/可面谈地点）。',
          '价格与排期以官方口径为准，不给口头承诺。',
        ],
      },
      sharedSource,
    ];
  }

  if (format === '问答') {
    return [
      {
        h2: '先给结论：直接回答这个问题',
        points: [
          `用 2-3 句话直接回答「${topic}」，先结论后展开。`,
          '结论只用「必须引用的可验证事实」支撑，不加入无来源数字。',
          '说明回答的适用范围与不适用情况。',
        ],
      },
      {
        h2: '拆解问题：用户真正想确认什么',
        points: [
          '把问题拆成 2-3 个可判断的小问题（是谁、做什么、在哪、怎么联系）。',
          '指出常见误读（例如把历史名/同名主体混在一起）。',
          '给出判断信息真假的方法，而不是只给结论。',
        ],
      },
      {
        h2: `${name}的可核验信息与边界`,
        points: [
          '列出公司全称、所在地、服务范围、主营服务，与品牌公开信息逐字一致。',
          '补充联系方式与响应时效，方便用户自行核验。',
          '明确不承诺效果，只描述交付内容。',
        ],
      },
      sharedSource,
    ];
  }

  if (format === '清单') {
    return [
      {
        h2: '快速自查清单',
        points: [
          '把用户要判断的事拆成 5-7 条勾选项，每条只问一个是非题。',
          '清单顺序按「先排除风险，再比较方案」排列。',
          '每条勾选项都给出判定依据，而不是主观感受。',
        ],
      },
      {
        h2: '逐条判断标准',
        points: [
          '为每条勾选项写清「什么算通过/什么算不通过」。',
          '涉及价格、周期时给出可核对的公开口径。',
          '把不确定的情况标为「待核实」，不硬下结论。',
        ],
      },
      {
        h2: `${name}能提供什么（对应服务）`,
        points: [
          `对应到${name}的公开服务项目与交付物，逐项说明。`,
          '写清适用对象与不适用的情况。',
          '联系与排期以官方口径为准。',
        ],
      },
      sharedSource,
    ];
  }

  if (format === '案例') {
    return [
      {
        h2: '背景与目标（需客户授权）',
        points: [
          '只写获得客户授权的案例；没有授权就改写成方法文章。',
          '交代客户类型、目标与约束，隐去可识别信息。',
          '不写无法核验的结果数字。',
        ],
      },
      {
        h2: '过程与关键动作',
        points: [
          '按时间顺序写清做了什么、为什么这样做。',
          '标出可复用的方法与判断标准，方便读者自查。',
          '把工具、周期、参与角色交代清楚。',
        ],
      },
      {
        h2: '结果、局限与复盘',
        points: [
          '只写有记录可查的结果，注明统计口径与时间。',
          '写清局限与不适用的场景，不做效果承诺。',
          '给出读者可自行验证的观察方法。',
        ],
      },
      sharedSource,
    ];
  }

  // 指南
  return [
    {
      h2: '先明确目标与判断标准',
      points: [
        `围绕「${topic}」先定义要解决的问题与成功标准。`,
        '列出 2-3 个判断维度（预算、周期、团队能力、服务范围）。',
        '说明本文信息的时间点与适用范围。',
      ],
    },
    {
      h2: '可执行步骤（1-2-3）',
      points: [
        '把做法拆成按顺序可执行的步骤，每步给出完成标志。',
        '标注每步需要准备的材料与大致周期（只写可核验口径）。',
        '给出常见卡点与应对方式。',
      ],
    },
    {
      h2: `${name}能提供的服务与交付物`,
      points: [
        `对应${name}公开的服务项目（${service}等），写清交付物边界。`,
        '说明服务范围、排期与联系方式。',
        '声明不承诺效果，只承诺交付。',
      ],
    },
    {
      h2: '常见问题与注意事项',
      points: [
        '列出 3-5 个用户最常问的问题并直接回答。',
        '写明容易踩的坑与识别方法。',
        '给出下一步行动建议（如何核验、如何咨询）。',
      ],
    },
    sharedSource,
  ];
}

function buildDistribution({ brand, cluster }) {
  const notes = {
    blog: `发布在品牌官网/独立域名，作为被 AI 引用的主来源；文首标注更新日期与作者。发布后回填 URL 以便监测归因。`,
    zhihu: '以「问题即标题」发布问答/专栏，正文首段给结论，文末附品牌公开来源。发布后回填 URL 以便监测归因。',
    wechat: `同步到${brand.name || '品牌'}公众号，面向已有客户与同行转发，保留原创声明。发布后回填 URL 以便监测归因。`,
    xhs: '拆成清单式短笔记（3-5 条判断标准），适合本地/避坑/价格类问题。发布后回填 URL 以便监测归因。',
  };
  const channels = [{ channel: '官网博客', note: notes.blog }, { channel: '知乎专栏', note: notes.zhihu }];
  if (cluster === '本地推荐' || cluster === '价格费用' || cluster === '避坑风险') {
    channels.push({ channel: '小红书', note: notes.xhs });
  } else if (cluster === '对比选择' || cluster === '竞品替代') {
    channels.push({ channel: '公众号', note: notes.wechat });
  } else {
    channels.push({ channel: '公众号', note: notes.wechat });
  }
  return channels;
}

function buildFactCheckList({ brand, cluster, intent }) {
  const list = [
    '公司全称、所在地、服务范围、联系方式与品牌配置逐字一致。',
    '所有价格与品牌当前价格表一致，并写明适用范围与有效期。',
    '全文检索禁用词（最好/第一/唯一/顶级/保证/100%/稳赚/绝对），出现即改写。',
    '每个案例都有客户授权与可核验链接；没有则删除或标「待补充可验证事实」。',
    '每个数字都有来源、口径与时间；没有来源的数字删除。',
    '每篇至少 2 条可点击来源，链接可正常打开。',
    '发布前通读一遍：是否出现承诺效果（涨粉/成单/排名/AI 必定推荐）的表述。',
  ];
  if (cluster === '对比选择' || cluster === '竞品替代') {
    list.push('竞品信息来自对方公开页面并注明抓取日期，全文无贬低性表述。');
  }
  if (cluster === '本地推荐') {
    list.push(`地名只写到品牌承诺范围（${brand.city || '本地'}及可面谈区域），不扩大到未承诺城市。`);
  }
  if (cluster === '价格费用' || intent === '价格') {
    list.push('报价保留「以最终方案为准」的表述，不写死总价。');
  }
  return list;
}

function buildTitle({ brand, question, keyword, format }) {
  const base = truncate(question.text || keyword.term || `${brand.name || '品牌'}内容方案`, 42);
  const suffix = {
    问答: `逐条回答：${base}`,
    指南: `${base}：一份可核对的实操指南`,
    对比: `${base}：对比维度与适用边界`,
    清单: `${base}：一份可直接用的判断清单`,
    案例: `${base}：过程复盘（需客户授权）`,
  }[format];
  const title = suffix || `${base}：内容方案`;
  return truncate(title, 60);
}

function intentOfQuestion(text, brand) {
  const raw = String(text || '');
  if (/推荐|哪家|排行|榜单/.test(raw)) return '推荐';
  if (/价格|多少钱|费用|收费|报价/.test(raw)) return '价格';
  if (/对比|比较|区别|怎么选|哪个好/.test(raw)) return '比较';
  if (/流程|多久|周期|交付|合作|售后/.test(raw)) return '流程';
  if (/坑|风险|骗|套路|避雷/.test(raw)) return '避坑';
  if (/本地|附近|同城|上门/.test(raw) || (brand?.city && raw.includes(brand.city))) return '本地';
  if (/geo|ai\s*搜索|大模型|收录/i.test(raw)) return '认知';
  if (/替代|取代|换掉/.test(raw)) return '替代';
  return '发现';
}

/**
 * 生成内容 brief。
 * @param {{brand?: object, question?: object|string, keyword?: object|string, lastRunStats?: object|null}} params
 */
export function buildBrief({ brand = {}, question, keyword = null, lastRunStats = null } = {}) {
  const q = normalizeQuestion(question);
  const kw = normalizeKeyword(keyword, q, brand);
  const intent = q.intent || kw.intent || intentOfQuestion(q.text || kw.term, brand);
  const cluster = (kw.cluster && CLUSTERS.includes(kw.cluster))
    ? kw.cluster
    : classifyCluster(q.text || kw.term, brand, intent);
  const format = pickFormat({ cluster, question: q, brand });

  const mustIncludeFacts = buildMustIncludeFacts(brand, q, cluster, intent);
  const evidenceRequirements = buildEvidenceRequirements({ brand, cluster, intent, lastRunStats });
  const outline = buildOutline({ brand, question: q, cluster, format });
  const banned = [...new Set([...(brand.contentRules?.bannedWords || []), ...DEFAULT_BANNED])];
  const factCheckList = buildFactCheckList({ brand, cluster, intent });
  const distribution = buildDistribution({ brand, cluster });
  const title = buildTitle({ brand, question: q, keyword: kw, format });
  const searchIntent = `${INTENT_DESC[intent] || INTENT_DESC['发现']}（意图：${intent}；关键词簇：${cluster}）`;

  return {
    title,
    format,
    targetQuestion: q.rawText || q.text || kw.term,
    searchIntent,
    mustIncludeFacts,
    evidenceRequirements,
    outline,
    banned,
    factCheckList,
    distribution,
  };
}

/** 渲染内容 brief 为 Markdown（供 CLI 写入 data/briefs/<slug>-<id>.md） */
export function renderBriefMarkdown(brief = {}) {
  const outline = Array.isArray(brief.outline) ? brief.outline : [];
  const facts = Array.isArray(brief.mustIncludeFacts) ? brief.mustIncludeFacts : [];
  const requirements = Array.isArray(brief.evidenceRequirements) ? brief.evidenceRequirements : [];
  const banned = Array.isArray(brief.banned) ? brief.banned : [];
  const checks = Array.isArray(brief.factCheckList) ? brief.factCheckList : [];
  const distribution = Array.isArray(brief.distribution) ? brief.distribution : [];

  const lines = [];
  lines.push(`# ${brief.title || '内容 brief'}`);
  lines.push('');
  lines.push('> 证据优先：没有可核验来源的数字、案例、资质、排名一律不写；拿不准就用「待补充可验证事实」。');
  lines.push('');
  lines.push('## 一、基本信息');
  lines.push('');
  lines.push(`- 目标问题：${brief.targetQuestion || '—'}`);
  lines.push(`- 搜索意图：${brief.searchIntent || '—'}`);
  lines.push(`- 建议形态：${brief.format || '—'}`);
  lines.push('');

  lines.push('## 二、必须引用的可验证事实');
  lines.push('');
  if (facts.length === 0) {
    lines.push('- 待补充可验证事实：本文暂无可用事实来源，先补齐再写。');
  } else {
    for (const fact of facts) lines.push(`- ${fact}`);
  }
  lines.push('');

  lines.push('## 三、证据要求');
  lines.push('');
  for (const item of requirements) lines.push(`- ${item}`);
  lines.push('');

  lines.push('## 四、文章结构（H2 级）');
  lines.push('');
  outline.forEach((section, index) => {
    lines.push(`### ${index + 1}. ${section.h2 || '（未命名小节）'}`);
    lines.push('');
    for (const point of section.points || []) lines.push(`- ${point}`);
    lines.push('');
  });

  lines.push('## 五、禁用词（绝对化 / 承诺类）');
  lines.push('');
  lines.push(banned.length ? banned.map((word) => `\`${word}\``).join('、') : '—');
  lines.push('');

  lines.push('## 六、发布前事实核查清单');
  lines.push('');
  for (const item of checks) lines.push(`- [ ] ${item}`);
  lines.push('');

  lines.push('## 七、分发与归因');
  lines.push('');
  if (distribution.length) {
    lines.push('| 渠道 | 发布要点 |');
    lines.push('| --- | --- |');
    for (const item of distribution) {
      const channel = String(item.channel || '').replace(/\|/g, '/');
      const note = String(item.note || '').replace(/\|/g, '/');
      lines.push(`| ${channel} | ${note} |`);
    }
  } else {
    lines.push('- 官网博客（发布后回填 URL 以便监测归因）');
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('恒野 GEO 自研版 · 内容 brief');
  lines.push('');

  return lines.join('\n');
}
