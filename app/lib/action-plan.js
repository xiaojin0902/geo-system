/**
 * lib/action-plan.js
 * 诊断报告的行动章节：把「评分 / 证据 / 引用源 / 竞品缺口」变成 Top10 行动清单 + 30 天计划。
 *
 * 对应 OmniRank 的 action_plan_agent 与报告 Module 6/7，但这里刻意不用 LLM：
 *   · 规则模板：同样的诊断结果永远得到同一份清单，可复算、可单测、可复核；
 *   · 每条行动必须带 evidence：没有证据的行动等于拍脑袋，客户没法核对、
 *     执行完也没法归因。所以 evidence 里必须出现具体数字或事实（覆盖率、被引次数、
 *     提及条数、得分），而不是「加强内容建设」这类空话；
 *   · 规则按优先级依次出行动，够了（10 条）就停，避免清单变成许愿池。
 *
 * 为什么第 1 周必须先修采集：
 *   覆盖率不足 50% 时分数本身不可用（score.js 口径：没测成 ≠ 0 分）。此时讨论
 *   内容、竞品、负面都是空中楼阁——基线都没立住，后面三周的动作就无法归因。
 *   所以第 1 周永远是「修复阻塞项 + 采集复跑」，第 4 周永远是「复测同题并与基线对比」。
 *
 * 设计红线：
 *   · 纯函数：不联网、不读文件、不调模型，输入 → 输出完全确定；
 *   · 只消费上游结果，不重算评分和份额（唯一现算的是「题目未提及占比」，因为
 *     上游没有按题目聚合过）；
 *   · 不编造品牌数字：所有 evidence 都来自入参，没有就写 0 或省略，绝不虚构。
 */

/** 行动清单上限：超过 10 条客户执行不过来，清单就失去优先级的意义 */
const MAX_ACTIONS = 10;

/** 覆盖率红线，与 score.js 的 MIN_COVERAGE_RATIO 保持一致 */
const MIN_COVERAGE = 0.5;

/** 需要优先修「可抓取性」的等级：隐形 / 落后 */
const WEAK_LEVELS = Object.freeze(['隐形', '落后']);

/** 三层评分元数据，与 score.js / report.js 保持同一口径 */
const LAYER_META = Object.freeze([
  { key: 'awareness', label: '品牌认知层', weight: 20 },
  { key: 'decision', label: '区域决策层', weight: 40 },
  { key: 'scenario', label: '场景拓展层', weight: 40 },
]);

/** 每层对应的问题类型，写进行动理由里，方便客户对号入座 */
const LAYER_INTENT = Object.freeze({
  awareness: '「你是谁、做什么、在哪」',
  decision: '「选谁、和竞品比怎么样」',
  scenario: '「预算多少、什么场景适合」',
});

/** 没有其他风险可写时，也必须给足两条：风险提示不能是空白章节 */
const GENERIC_RISKS = Object.freeze([
  '执行口径：本清单由规则模板生成（无 LLM 参与），执行前需人工核对品牌事实与发布账号权限。',
  '效果口径：本清单不承诺被 AI 推荐、排名或成单；只用同题复测验证变化。',
]);

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** 缺失值保持 null：它和真实的 0 不是一回事，规则判断时要区分 */
function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 比率 → 「30.0%」；非法值按 0 处理，保证 evidence 里永远有数字 */
function pct(ratio) {
  return `${(Math.max(0, toNumber(ratio)) * 100).toFixed(1)}%`;
}

/** 分数 → 一位小数；缺失写「—」，用于非 evidence 的展示位 */
function fmtScore(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(1) : '—';
}

/** 题目文本可能是超长问句，截断后再放进行动名，保持一行可读 */
function truncate(value, max = 46) {
  const chars = Array.from(toText(value));
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

/* ------------------------------------------------------------------ */
/* 输入归一化                                                          */
/* ------------------------------------------------------------------ */

/** 从 rows 里取题目文本：兼容 question 对象 / 字符串 / questionText 三种形态 */
function questionTextOf(row) {
  const question = row ? row.question : null;
  if (typeof question === 'string') return question.trim();
  if (question && typeof question === 'object') {
    return toText(question.text) || toText(question.title) || toText(question.question);
  }
  return toText(row ? row.questionText : '');
}

/**
 * 按题目聚合「未提及占比」。
 * 为什么这条要现算：上游 analytics.js 只按域名 / 引擎聚合，没有「按题」视角；
 * 而行动清单需要知道「哪两道题最缺可被引用的事实」。
 * 口径与评分一致：只统计采集成功的回答，拒答 / 引擎错误不进分母。
 * @param {Array} rows getRunDetail().rows
 * @returns {Array<{question:string,total:number,notMentioned:number,ratio:number}>}
 */
function collectQuestionGaps(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!row || !row.answer || row.answer.status !== 'ok') continue;
    const question = questionTextOf(row);
    if (!question) continue;
    const entry = map.get(question) ?? { question, total: 0, notMentioned: 0 };
    entry.total += 1;
    if (row.judgment && row.judgment.verdict === 'not_mentioned') entry.notMentioned += 1;
    map.set(question, entry);
  }
  return [...map.values()]
    .filter((item) => item.notMentioned > 0)
    .map((item) => ({ ...item, ratio: item.notMentioned / item.total }))
    .sort(
      (a, b) =>
        b.ratio - a.ratio ||
        b.notMentioned - a.notMentioned ||
        (a.question < b.question ? -1 : 1),
    );
}

/**
 * 把 5 个入参整理成内部上下文。
 * 原则：只读、不重算——上游给了就用，缺了就给安全的缺省值（多数是 null/0）。
 */
function normalizeContext({ brand, score, insights, rows, competitors }) {
  const safeBrand = brand && typeof brand === 'object' ? brand : {};
  const safeScore = score && typeof score === 'object' ? score : {};
  const safeInsights = insights && typeof insights === 'object' ? insights : {};
  const safeRows = Array.isArray(rows) ? rows : [];
  const safeCompetitors = Array.isArray(competitors) ? competitors : [];

  const sample = safeInsights.sample && typeof safeInsights.sample === 'object' ? safeInsights.sample : {};
  const coverage = safeScore.coverage && typeof safeScore.coverage === 'object' ? safeScore.coverage : {};
  const citations = safeInsights.citations && typeof safeInsights.citations === 'object' ? safeInsights.citations : {};
  const sov = safeInsights.sov && typeof safeInsights.sov === 'object' ? safeInsights.sov : {};
  const sentiment = safeInsights.sentiment && typeof safeInsights.sentiment === 'object' ? safeInsights.sentiment : {};

  const sampleTotal = toNullableNumber(sample.total) ?? safeRows.length;
  const sampleOk = toNullableNumber(sample.ok) ?? toNumber(coverage.ok);
  const sampleMentioned = toNumber(sample.mentioned);
  const rawMentionRate = toNullableNumber(sample.mentionRate);
  const mentionRate = rawMentionRate ?? (sampleOk > 0 ? sampleMentioned / sampleOk : 0);

  const ratio = toNullableNumber(coverage.ratio);
  const total = toNullableNumber(safeScore.total);
  const level = toText(safeScore.level);

  const layers = {};
  const scoredLayers = [];
  for (const meta of LAYER_META) {
    const raw = safeScore.layers && typeof safeScore.layers === 'object' ? safeScore.layers[meta.key] : null;
    const rawWeight = raw ? Number(raw.weight) : Number.NaN;
    const layer = {
      key: meta.key,
      label: meta.label,
      weight: Number.isFinite(rawWeight) ? rawWeight : meta.weight,
      score: toNullableNumber(raw && raw.score),
      ok: toNullableNumber(raw && raw.ok),
    };
    layers[meta.key] = layer;
    if (layer.score !== null) scoredLayers.push(layer);
  }

  const opportunities = (Array.isArray(safeInsights.opportunities) ? safeInsights.opportunities : [])
    .filter((item) => item && toText(item.domain))
    .map((item) => ({
      domain: toText(item.domain),
      count: toNumber(item.count),
      share: toNumber(item.share),
      typeLabel: toText(item.typeLabel) || '站外站点',
      reason: toText(item.reason),
    }));

  const sameNameThreats = (Array.isArray(safeInsights.sameNameThreats) ? safeInsights.sameNameThreats : [])
    .filter((item) => item && toText(item.domain))
    .map((item) => ({
      domain: toText(item.domain),
      count: toNumber(item.count),
      share: toNumber(item.share),
      message: toText(item.message),
    }));

  const sovCompetitors = (Array.isArray(sov.competitors) ? sov.competitors : [])
    .filter((item) => item && toText(item.name))
    .map((item) => ({
      name: toText(item.name),
      mentions: toNumber(item.mentions),
      share: toNullableNumber(item.share),
    }))
    .filter((item) => item.share !== null);

  const brandName = toText(safeBrand.name) || '本品牌';
  const competitorNames = safeCompetitors
    .map((item) => (typeof item === 'string' ? item : toText(item && item.name)))
    .filter(Boolean);

  return {
    brand: safeBrand,
    brandName,
    rows: safeRows,
    sample: {
      total: sampleTotal,
      ok: sampleOk,
      mentioned: sampleMentioned,
      mentionRate,
    },
    score: { total, level, layers },
    scoredLayers,
    coverage: {
      ratio,
      ok: toNumber(coverage.ok),
      planned: toNumber(coverage.planned),
    },
    citations: {
      total: toNumber(citations.total),
      uniqueDomains: toNumber(citations.uniqueDomains),
      ownShare: toNumber(citations.ownShare),
    },
    opportunities,
    sameNameThreats,
    sov: {
      brandMentions: toNumber(sov.brandMentions),
      brandShare: toNumber(sov.brandShare),
      competitors: sovCompetitors,
    },
    sentiment: {
      positive: toNumber(sentiment.positive),
      neutral: toNumber(sentiment.neutral),
      negative: toNumber(sentiment.negative),
      score: toNumber(sentiment.score),
    },
    questionGaps: collectQuestionGaps(safeRows),
    competitorCount: competitorNames.length || sovCompetitors.length,
  };
}

/** 上下文里有没有任何可分析的信号：没有就返回空 plan，而不是硬编行动 */
function hasAnySignal(ctx) {
  return Boolean(
    ctx.sample.total > 0 ||
      ctx.sample.ok > 0 ||
      ctx.score.total !== null ||
      ctx.coverage.ratio !== null ||
      ctx.scoredLayers.length > 0 ||
      ctx.opportunities.length > 0 ||
      ctx.sov.competitors.length > 0 ||
      ctx.sentiment.negative > 0,
  );
}

/* ------------------------------------------------------------------ */
/* 规则 1-8：按优先级产出候选行动                                       */
/* ------------------------------------------------------------------ */

/** 规则 1：覆盖率 < 50% → 先修采集（没测成 ≠ 0 分，不补采就没有可信分数） */
function ruleCoverage(ctx) {
  if (ctx.coverage.ratio === null || ctx.coverage.ratio >= MIN_COVERAGE) return null;
  const missing = Math.max(0, ctx.coverage.planned - ctx.coverage.ok);
  return {
    action: '先修采集：补齐失败样本，把覆盖率提到 50% 以上',
    why: '覆盖率不足一半时分数不可用（没测成 ≠ 0 分）；先补采再谈内容，否则后面所有动作都无法归因',
    evidence: `覆盖率 ${pct(ctx.coverage.ratio)}（有效 ${ctx.coverage.ok} / 计划 ${ctx.coverage.planned}），未成功采集 ${missing} 条`,
    effort: '低',
    owner: '恒野',
    deadline: '3 天内',
  };
}

/** 规则 2：隐形 / 落后 → 官网可抓取性体检与修复（承接 audit-site 的结论方向） */
function ruleCrawlability(ctx) {
  if (!WEAK_LEVELS.includes(ctx.score.level)) return null;
  const parts = [
    `总分 ${fmtScore(ctx.score.total)}，等级「${ctx.score.level}」`,
    `样本 ${ctx.sample.total} 条中只有 ${ctx.sample.mentioned} 条提到${ctx.brandName}`,
  ];
  if (ctx.coverage.ratio !== null) parts.push(`覆盖率 ${pct(ctx.coverage.ratio)}`);
  return {
    action: '官网可抓取性体检 + 修复：先跑 audit-site，按结论处理 robots.txt、HTTPS、AI 爬虫 UA',
    why: 'AI 先要抓得到官网，才可能把它当来源；robots 屏蔽、HTTPS 不通、AI UA 被 WAF 拦截，都会让站点在检索阶段直接出局',
    evidence: parts.join('；'),
    effort: '中',
    owner: '双方',
    deadline: '1 周内',
  };
}

/**
 * 规则 3：每个高频被引域名一条动作，但**动作必须与站点类型匹配**。
 * 真实数据教训：AI 讲「某某公司是做什么的」时大量引用工商/企查站，
 * 对这类站的正确动作是「补全工商信息并挂官网链接」，不是「去建内容页」（你建不了）。
 */
function rulesFromOpportunities(ctx) {
  return ctx.opportunities.slice(0, 5).map((item, index) => {
    const isRegistry = item.typeLabel === '工商/企查';
    return {
      action: isRegistry
        ? `补全 ${item.domain} 上的工商信息：经营范围、官网链接、公司简介（工商/企查）`
        : `在 ${item.domain} 建立可被引用的内容页（${item.typeLabel}）`,
      why: isRegistry
        ? 'AI 回答「这家公司是做什么的」时最信工商/企查站；这里信息残缺或没有官网链接，AI 就只能停在工商字段，找不到你的内容'
        : 'AI 已经在该站取材，但引用里没有你；把品牌事实做成该站可收录、可引用的内容页，才有机会进入回答',
      evidence: `${item.domain} 被 AI 引用 ${item.count} 次，占全部引用 ${pct(item.share)}；自有站点引用占 ${pct(ctx.citations.ownShare)}（本轮共 ${ctx.citations.total} 条引用）`,
      effort: isRegistry ? '低' : item.typeLabel.includes('百科') ? '高' : '中',
      owner: isRegistry ? '客户' : '双方',
      deadline: index < 2 ? '2 周内' : '3 周内',
    };
  });
}

/**
 * 规则 3.5：同名实体威胁（真实数据驱动）。
 * AI 讲你的品牌名时，引用的是别家同名公司的站点 —— 这不是「机会」，是「实体被抢」。
 * 唯一有效动作是把「全称 + 城市 + 业务词」做成全网一致的实体信号。
 */
function ruleSameNameThreat(ctx) {
  const threats = Array.isArray(ctx.sameNameThreats) ? ctx.sameNameThreats : [];
  if (!threats.length) return [];
  const domains = threats.map((item) => item.domain).join('、');
  return [
    {
      action: '做品牌实体区分：全渠道统一「芜湖恒野数字科技有限公司」+ 城市 + 业务词',
      why: 'AI 讲「恒野」时引用的是同名别家公司的站点，说明它没能把「恒野」和你的公司绑定；不解决实体混淆，后面所有内容都在替别人做嫁衣',
      evidence: `同名实体站点 ${domains} 共被引用 ${threats.reduce((sum, item) => sum + item.count, 0)} 次；自有站点引用占 ${pct(ctx.citations?.ownShare ?? 0)}`,
      effort: '中',
      owner: '双方',
      deadline: '1 周内',
    },
  ];
}

/** 规则 4：竞品份额高于本品牌 → 做差异说明（只引公开信息，不贬低对手） */
function ruleCompetitor(ctx) {
  const ahead = ctx.sov.competitors
    .filter((item) => item.share > ctx.sov.brandShare)
    .sort((a, b) => b.share - a.share || b.mentions - a.mentions);
  if (!ahead.length) return null;
  const top = ahead.slice(0, 3);
  return {
    action: '做一页有据可查的差异说明（只引公开信息、不贬低对手）',
    why: `${top.map((item) => item.name).join('、')} 在同类问题里的提及份额高于本品牌；客户会先拿 AI 回答做筛选，差异说明要能被引用，而不是自说自话`,
    evidence: `竞品 ${top
      .map((item) => `${item.name} 提及 ${item.mentions} 条 / 份额 ${pct(item.share)}`)
      .join('；')}；本品牌提及 ${ctx.sov.brandMentions} 条 / 份额 ${pct(ctx.sov.brandShare)}`,
    effort: '中',
    owner: '恒野',
    deadline: '2 周内',
  };
}

/** 规则 5：有负面情感 → 核实原话、补公开事实（不删帖、不写公关话术） */
function ruleNegative(ctx) {
  if (ctx.sentiment.negative <= 0) return null;
  return {
    action: '负面表述处理：先核实原话与来源，再补公开事实回应',
    why: '负面句子会被 AI 当成对品牌的评价反复转述；先确认原话是否属实，再用可核实的事实回应。删帖或公关话术删不干净，还会二次扩散',
    evidence: `负面 ${ctx.sentiment.negative} 条 / 提及 ${ctx.sample.mentioned} 条，情感分 ${fmtScore(ctx.sentiment.score)}（范围 -1 ~ 1）`,
    effort: '中',
    owner: '双方',
    deadline: '1 周内',
  };
}

/** 规则 6：三层里得分最低且 score 非 null 的那一层 → 补该层题型内容 */
function ruleLowestLayer(ctx) {
  if (!ctx.scoredLayers.length) return null;
  const sorted = [...ctx.scoredLayers].sort(
    (a, b) =>
      a.score - b.score ||
      LAYER_META.findIndex((meta) => meta.key === a.key) - LAYER_META.findIndex((meta) => meta.key === b.key),
  );
  const lowest = sorted[0];
  const parts = [`${lowest.label}得分 ${fmtScore(lowest.score)} / ${lowest.weight}`];
  if (lowest.ok !== null) parts.push(`有效 ${lowest.ok} 题`);
  parts.push(ctx.scoredLayers.length >= 2 ? '三层中最低' : '当前唯一有有效得分的层');
  return {
    action: `补「${lowest.label}」题型的内容（当前该层得分最低）`,
    why: `该层对应客户${LAYER_INTENT[lowest.key]}类问题，得分最低说明 AI 回答这类问题时最缺可引用的事实；先补这一层，比平均发力更快拉总分`,
    evidence: parts.join('，'),
    effort: '中',
    owner: '双方',
    deadline: '2 周内',
  };
}

/** 规则 7：未提及占比最高的 2 道题 → 各补一篇可被引用的事实型内容 */
function rulesFromQuestionGaps(ctx) {
  return ctx.questionGaps.slice(0, 2).map((item) => ({
    action: `针对「${truncate(item.question)}」产出可被引用的事实型内容`,
    why: '该题未提及占比最高，说明 AI 回答这道题时没有可引用的事实源；用问答/清单格式给事实、数字与出处，复测时才能归因',
    evidence: `该题 ${item.total} 条回答中 ${item.notMentioned} 条未提及（${pct(item.ratio)}），是未提及占比最高的题目之一`,
    effort: '中',
    owner: '双方',
    deadline: '3 周内',
  }));
}

/** 规则 8：兜底 baseline —— 连一条规则都没触发时，先做最能被 AI 读取的基础资产 */
function ruleBaseline(ctx) {
  return {
    action: '打底：建 llms.txt 与 Organization JSON-LD，把服务页做成可引用的事实页',
    why: 'AI 引擎认识一个品牌，先看站点说明书与结构化数据；没有这些，后面内容做得再多也缺少「你是谁」的权威锚点',
    evidence: `样本 ${ctx.sample.total} 条中提及 ${ctx.sample.mentioned} 条（${pct(ctx.sample.mentionRate)}），${ctx.citations.total} 条引用中自有站点占 ${pct(ctx.citations.ownShare)}`,
    effort: '低',
    owner: '恒野',
    deadline: '2 周内',
  };
}

/* ------------------------------------------------------------------ */
/* 30 天计划                                                           */
/* ------------------------------------------------------------------ */

/**
 * 生成 4 周计划。
 * 硬约束（写死在这里，避免调用方漏配）：
 *   · 恰好 4 周，每周 2-4 个任务；
 *   · 第 1 周 = 修复阻塞项 + 采集复跑（没有可对比基线，后面都是白做）；
 *   · 第 4 周 = 复测同题并与基线对比（不测就无法判断行动有效无效）。
 */
function buildDays30(ctx) {
  const weakCompetitors = ctx.sov.competitors
    .filter((item) => item.share > ctx.sov.brandShare)
    .sort((a, b) => b.share - a.share || b.mentions - a.mentions)
    .slice(0, 3);
  const opportunityDomains = ctx.opportunities.slice(0, 2).map((item) => item.domain);
  const serviceText = Array.isArray(ctx.brand.services)
    ? ctx.brand.services.filter((item) => typeof item === 'string' && item.trim()).slice(0, 3).join('、')
    : '';
  const lowest = [...ctx.scoredLayers].sort((a, b) => a.score - b.score)[0];
  const lowCoverage = ctx.coverage.ratio !== null && ctx.coverage.ratio < MIN_COVERAGE;

  const week1Tasks = [
    lowCoverage
      ? `修采集阻塞：逐引擎核对失败原因（engine_error / refused / 配额 / key），把覆盖率从 ${pct(ctx.coverage.ratio)} 补到 50% 以上，再复跑同批题目`
      : '复核采集：把本轮失败样本逐条归因（engine_error / refused / 配额 / key），再用同批题目复跑一轮确认稳定',
    '跑 audit-site 体检官网：确认 robots.txt 放行 AI 爬虫、HTTPS 可访问、AI UA 不被 WAF 拦截',
    `记录基线：把总分 ${fmtScore(ctx.score.total)}、提及率 ${pct(ctx.sample.mentionRate)}、引用域名 ${ctx.citations.uniqueDomains} 个、本品牌份额 ${pct(ctx.sov.brandShare)} 写入 30 天看板`,
  ];

  const week2Tasks = [
    opportunityDomains.length
      ? `在 ${opportunityDomains.join('、')} 各建 1 个可被引用的内容页（问答/清单格式，附品牌事实与联系方式）`
      : '在官网补 3 个事实页：服务清单、报价区间、交付流程（不写没有出处的数字）',
    `按 P0 题目产出 3 篇问答内容${serviceText ? `（围绕 ${serviceText}）` : ''}，事实只用品牌公开资料`,
    '给新页面补 Article / FAQPage 结构化数据与内链，方便 AI 摘录与定位',
  ];

  const week3Tasks = [
    weakCompetitors.length
      ? `发布差异说明页：只引公开信息对比 ${weakCompetitors.map((item) => item.name).join('、')}，逐条标注来源，不贬低对手`
      : '补一页「服务范围与交付边界」说明，减少 AI 回答里的模糊表述',
    ctx.sentiment.negative > 0
      ? '核实负面原话与出处，补 1 页公开事实回应（不删帖、不写公关话术）'
      : '把客户高频问题整理成 FAQ（至少 10 问），每问给出可核实的事实',
    lowest
      ? `按「${lowest.label}」题型补 3 题内容，每题配事实清单与可引用来源`
      : '按三层题型各补 1 篇内容，先把三层缺口都填上',
  ];

  const week4Tasks = [
    '复测同题并与基线对比：用第 1 周完全相同的题目与引擎复跑一轮',
    '对比总分、提及率、引用来源与竞品份额的变化，输出 1 页复盘（哪些动作有效、哪些无效）',
    '更新 30 天看板：未解决项转入下一周期，并按新数据重算下一轮 Top10',
  ];

  return [
    { week: '第1周', goal: '修复阻塞项 + 采集复跑，先把可判断的基线立住', tasks: week1Tasks },
    { week: '第2周', goal: '站外铺位 + 官网事实页，让 AI 有内容可引', tasks: week2Tasks },
    { week: '第3周', goal: '差异说明 + 负面处理 + 短板层补题', tasks: week3Tasks },
    { week: '第4周', goal: '复测同题并与基线对比，决定下一轮优先级', tasks: week4Tasks },
  ];
}

/**
 * 2-4 条风险提示：优先写「本轮数据本身的局限」，再写「执行 / 效果口径」。
 * 风险也要带数字，否则和免责声明没区别。
 */
function buildRisks(ctx) {
  const risks = [];
  if (ctx.coverage.ratio !== null) {
    risks.push(
      `样本口径：覆盖率 ${pct(ctx.coverage.ratio)}（有效 ${ctx.coverage.ok} / 计划 ${ctx.coverage.planned}），单轮回答有随机性，分数只代表本次采集时段，不能外推为长期表现。`,
    );
  } else {
    risks.push(
      `样本口径：本轮共 ${ctx.sample.total} 条样本，单轮回答有随机性，任何结论都要同题复测确认。`,
    );
  }

  if (ctx.coverage.ratio !== null && ctx.coverage.ratio < MIN_COVERAGE) {
    risks.push(
      `覆盖率 ${pct(ctx.coverage.ratio)} 低于 50%：分数与等级暂不可用（没测成 ≠ 0 分），补采完成前不要对外引用。`,
    );
  }

  const ahead = ctx.sov.competitors.filter((item) => item.share > ctx.sov.brandShare);
  if (ahead.length) {
    const top = ahead.sort((a, b) => b.share - a.share)[0];
    risks.push(
      `竞品「${top.name}」份额 ${pct(top.share)} 高于本品牌 ${pct(ctx.sov.brandShare)}：先复测确认稳定，再对外沟通差异，不承诺排名或推荐。`,
    );
  }

  if (ctx.sentiment.negative > 0) {
    risks.push(
      `负面 ${ctx.sentiment.negative} 条：先核实原话与来源，用公开事实回应，禁止删帖或公关话术，避免二次扩散。`,
    );
  }

  for (const risk of GENERIC_RISKS) {
    if (risks.length >= 2) break;
    risks.push(risk);
  }
  return risks.slice(0, 4);
}

/* ------------------------------------------------------------------ */
/* 对外入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 生成行动清单。
 * @param {object} [input]
 * @param {object} [input.brand] 品牌 {name, city, scope, industry, services}
 * @param {object} [input.score] score.js 的输出 {total, level, coverage:{ratio}, layers}
 * @param {object} [input.insights] analytics.js 的 analyzeRun 输出 {sample, citations, sov, sentiment, opportunities}
 * @param {Array} [input.rows] getRunDetail().rows（[{question, answer, judgment}]）
 * @param {Array} [input.competitors] [{name, mentions}] 或 []
 * @returns {{top10:Array, days30:Array, risks:string[], generatedFrom:{total:number,coverage:number,mentionedRate:number,competitorCount:number}}}
 */
export function buildActionPlan({ brand, score, insights, rows, competitors } = {}) {
  const ctx = normalizeContext({ brand, score, insights, rows, competitors });

  // 没有任何信号：不硬编行动，交给渲染层提示「样本不足」
  if (!hasAnySignal(ctx)) {
    return {
      top10: [],
      days30: [],
      risks: [],
      generatedFrom: { total: 0, coverage: 0, mentionedRate: 0, competitorCount: 0 },
    };
  }

  const candidates = [
    ruleCoverage(ctx),
    ruleCrawlability(ctx),
    // 同名实体威胁排在机会之前：不先解决「AI 以为你是别家」，后面的铺内容都在替别人做
    ...ruleSameNameThreat(ctx),
    ...rulesFromOpportunities(ctx),
    ruleCompetitor(ctx),
    ruleNegative(ctx),
    ruleLowestLayer(ctx),
    ...rulesFromQuestionGaps(ctx),
  ].filter(Boolean);

  // 兜底 baseline：所有规则都没命中时，至少给出一条可执行的基础动作
  if (candidates.length === 0) candidates.push(ruleBaseline(ctx));

  const top10 = candidates.slice(0, MAX_ACTIONS).map((item, index) => ({
    rank: index + 1,
    action: item.action,
    why: item.why,
    evidence: item.evidence,
    effort: item.effort,
    owner: item.owner,
    deadline: item.deadline,
  }));

  return {
    top10,
    days30: buildDays30(ctx),
    risks: buildRisks(ctx),
    generatedFrom: {
      total: ctx.sample.total,
      coverage: ctx.coverage.ratio ?? 0,
      mentionedRate: ctx.sample.mentionRate,
      competitorCount: ctx.competitorCount,
    },
  };
}

/** rank → 优先级标签：前三名 P0，中间 P1，最后 P2（只用于展示，不写进 JSON 契约） */
function priorityTag(rank) {
  if (rank <= 3) return '[P0]';
  if (rank <= 7) return '[P1]';
  return '[P2]';
}

/**
 * 把行动清单渲染成 Markdown 章节（报告 Module 6/7 直接插入）。
 * 空清单只返回一句提示，不输出空标题——报告里出现三个空小节比没有还糟。
 * @param {object} plan buildActionPlan 的返回值
 * @returns {string}
 */
export function renderActionPlanMarkdown(plan) {
  const safePlan = plan && typeof plan === 'object' ? plan : {};
  const top10 = Array.isArray(safePlan.top10) ? safePlan.top10 : [];
  if (top10.length === 0) return '样本不足，暂不生成行动清单';

  const days30 = Array.isArray(safePlan.days30) ? safePlan.days30 : [];
  const risks = Array.isArray(safePlan.risks) ? safePlan.risks : [];
  const lines = ['## Top10 行动', ''];

  top10.forEach((item, index) => {
    const rank = Number.isFinite(Number(item.rank)) ? Number(item.rank) : index + 1;
    lines.push(
      `${rank}. ${priorityTag(rank)} ${item.action} —— ${item.why}（${item.evidence}） · ${item.owner} · ${item.deadline}`,
    );
  });

  lines.push('', '## 30 天计划', '');
  for (const week of days30) {
    lines.push(`### ${week.week} · ${week.goal}`, '');
    for (const task of Array.isArray(week.tasks) ? week.tasks : []) {
      lines.push(`- ${task}`);
    }
    lines.push('');
  }

  lines.push('## 风险提示', '');
  for (const risk of risks) lines.push(`- ${risk}`);

  return lines.join('\n');
}
