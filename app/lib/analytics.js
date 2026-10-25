/**
 * lib/analytics.js
 * 可见度分析：把「采集到的回答 + 判定」变成商业上能用的四个结论。
 *
 * 这是 GEO 产品的核心章节，而不是附加报表：
 *   1. 引用源分析 —— AI 到底在引用哪些站？我的品牌有没有在这些站出现过？
 *   2. 竞品份额（SoV）—— 同一批问题里，我和竞品的提及份额分别是多少？
 *   3. 曝光质量 —— 不只是「有没有提」，还有「占了多大篇幅、排在第几句」。
 *   4. 情感倾向 —— 提到我时是推荐、中性还是负面。
 *
 * 设计红线：
 *   · 全部纯函数、确定性，不联网、不调模型（可复算、可单测、可复跑）；
 *   · 「没测成」不进分母（与 score.js 口径一致）；
 *   · demo 数据同样会被分析，但 demo 标记由上层报告负责展示，这里不伪造真实感。
 */

/** 情感词典（规则版）。刻意做小：宁可判 neutral，也不要瞎贴标签。 */
export const SENTIMENT_LEXICON = Object.freeze({
  positive: [
    '推荐', '口碑不错', '专业', '靠谱', '领先', '优势', '适合', '稳定', '好评',
    '值得', '首选', '成熟', '经验丰富', '交付质量', '响应快',
  ],
  negative: [
    '不推荐', '较差', '差评', '投诉', '负面', '风险', '不足', '偏贵', '太贵',
    '响应慢', '交付慢', '不专业', '踩坑', '避雷',
  ],
});

/** 引用源分类：把「AI 引用了哪些站」变成「我该去哪些站铺内容」。 */
const DOMAIN_TYPES = Object.freeze([
  {
    type: 'social',
    label: '社媒/问答',
    suffixes: ['zhihu.com', 'xiaohongshu.com', 'douyin.com', 'weibo.com', 'bilibili.com',
      'douban.com', 'mp.weixin.qq.com', 'weixin.qq.com', 'tieba.baidu.com', 'jianshu.com'],
  },
  {
    type: 'media',
    label: '媒体/门户',
    suffixes: ['sohu.com', '163.com', 'sina.com.cn', 'sina.com', 'ifeng.com', 'qq.com',
      '36kr.com', 'people.com.cn', 'xinhuanet.com', 'chinadaily.com.cn', 'thepaper.cn'],
  },
  {
    type: 'encyclopedia',
    label: '百科/知识库',
    suffixes: ['baike.baidu.com', 'wikipedia.org', 'zh.wikipedia.org', 'baike.so.com'],
  },
  {
    type: 'search',
    label: '搜索引擎',
    suffixes: ['baidu.com', 'google.com', 'bing.com', 'sogou.com', 'so.com'],
  },
  {
    // 工商信息源：AI 讲「某某公司是做什么的」时最常引这类站点。
    // 对它们的正确动作不是「去建内容页」，而是「把工商信息补全并挂上官网链接」。
    type: 'registry',
    label: '工商/企查',
    suffixes: ['qcc.com', 'tianyancha.com', 'aiqicha.baidu.com', 'qixin.com', 'riskbird.com',
      'huaxiataike.com', 'gsxt.gov.cn', 'creditchina.gov.cn'],
  },
]);

const POSITIVE_RE = new RegExp(SENTIMENT_LEXICON.positive.join('|'), 'gu');
const NEGATIVE_RE = new RegExp(SENTIMENT_LEXICON.negative.join('|'), 'gu');

/**
 * 证据等级（对应 OmniRank report_evidence 的 A/B/C）：
 *   A = 有原话 + 有可点开的引用来源（最强，可对外引用）
 *   B = 有原话但引擎没返回引用（能说「它这么说过」，但不能说「依据是哪个网页」）
 *   C = 没有原话（拒答 / 引擎错误）——只能证明「问了没答」，不能当证据
 * @param {{answer?:{status?:string,text?:string,citations?:any[]}}} row
 * @returns {'A'|'B'|'C'}
 */
export function gradeEvidence(row) {
  const answer = row?.answer ?? {};
  const text = String(answer.text ?? '').trim();
  if (answer.status !== 'ok' || !text) return 'C';
  return Array.isArray(answer.citations) && answer.citations.length ? 'A' : 'B';
}

const round = (value, digits = 4) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const pct = (part, total) => (total > 0 ? round(part / total, 4) : 0);

/** 句子切分：中英文标点 + 换行。空串会被过滤。 */
export function splitSentences(text) {
  return String(text ?? '')
    .split(/[。！？!?\n]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 品牌的所有写法（正式名 / 全称 / 别名）。 */
export function brandNames(brand = {}) {
  const names = [brand.name, brand.legalName, ...(Array.isArray(brand.aliases) ? brand.aliases : [])]
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim());
  return [...new Set(names)];
}

/** 文本里是否出现品牌（任一写法）。返回命中的名称，便于核对。 */
export function matchBrand(text, brand = {}) {
  const source = String(text ?? '');
  for (const name of brandNames(brand)) {
    if (source.includes(name)) return name;
  }
  return null;
}

/** 引用域名归一化：去掉 www.、小写。非法 URL 返回空串。 */
export function domainOf(url) {
  try {
    const { hostname } = new URL(String(url ?? '').trim());
    const clean = hostname.toLowerCase().replace(/^www\./u, '');
    // 真实数据里出现过被拼接坏的 hostname（形如 `hengyecangchu.xn--com*(...`）：
    // 它既不是合法域名，也不该出现在引用源排行里，直接丢弃比渲染成乱码好。
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/u.test(clean)) return '';
    if (clean.length > 253) return '';
    return clean;
  } catch {
    return '';
  }
}

/** 域名的第一段标签（zhuanlan.zhihu.com → zhuanlan；douyin.example.com → douyin） */
function firstLabel(domain) {
  return String(domain ?? '').toLowerCase().split('.')[0] ?? '';
}

/**
 * 域名 → 类型（social/media/encyclopedia/search/other）。
 * 三级判定：完全相等 → 后缀匹配 → **首段标签匹配**。
 * 为什么要第三级：真实站点大量使用子域名（zhuanlan.zhihu.com / baike.baidu.com），
 * 演示数据也用 xxx.example.com；只看后缀会把它们全判成「其他」。
 */
export function classifyDomain(domain) {
  const value = String(domain ?? '').toLowerCase();
  for (const rule of DOMAIN_TYPES) {
    if (rule.suffixes.some((suffix) => value === suffix || value.endsWith(`.${suffix}`))) {
      return { type: rule.type, label: rule.label };
    }
  }
  const label = firstLabel(value);
  const LABEL_RULES = {
    zhihu: 'social', xiaohongshu: 'social', douyin: 'social', weibo: 'social',
    bilibili: 'social', douban: 'social', weixin: 'social', tieba: 'social',
    sohu: 'media', sina: 'media', ifeng: 'media', news: 'media', '36kr': 'media',
    baike: 'encyclopedia', wikipedia: 'encyclopedia', zhwiki: 'encyclopedia',
    baidu: 'search', google: 'search', bing: 'search',
  };
  const hit = LABEL_RULES[label];
  if (hit) {
    const rule = DOMAIN_TYPES.find((item) => item.type === hit);
    return { type: rule.type, label: rule.label };
  }
  return { type: 'other', label: '其他站点' };
}

/**
 * 同名实体站点：域名里带本品牌拼音/字号，但不是我们的站。
 * 真实案例：AI 讲「恒野」时引用了 hn-hengye.com（河南恒野农牧）、hengyecangchu.com（恒野仓储），
 * 这些站我们无权发内容，**绝不能出现在「机会缺口」里**，否则给出的建议无法执行。
 * @param {string} domain
 * @param {string[]} hints
 */
function isSameNameDomain(domain, hints) {
  const value = String(domain ?? '').toLowerCase();
  return hints.some((hint) => hint && value.includes(hint));
}

function isOwnDomain(domain, ownDomains) {
  return ownDomains.some((own) => own && (domain === own || domain.endsWith(`.${own}`)));
}

/**
 * 分析一轮诊断结果。
 * @param {object} options
 * @param {object} [options.brand] 品牌（name / legalName / aliases / competitors / urls）
 * @param {Array} [options.rows] getRunDetail().rows（[{question, answer, judgment}]）
 * @returns {object} 见文件头四块结论
 */
export function analyzeRun({ brand = {}, rows = [] } = {}) {
  const names = brandNames(brand);
  const competitors = (Array.isArray(brand.competitors) ? brand.competitors : [])
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim());
  const ownDomains = (Array.isArray(brand.urls) ? brand.urls : [])
    .map((url) => domainOf(url))
    .filter(Boolean);
  const sameNameHints = (Array.isArray(brand.sameNameDomainHints) ? brand.sameNameDomainHints : [])
    .map((item) => String(item ?? '').toLowerCase().trim())
    .filter(Boolean);

  const safeRows = Array.isArray(rows) ? rows : [];
  const okRows = safeRows.filter((row) => row?.answer?.status === 'ok');
  const mentionedRows = okRows.filter(
    (row) => row?.judgment && row.judgment.verdict !== 'not_mentioned'
      && row.judgment.verdict !== 'unknown'
      && row.judgment.verdict !== 'engine_error',
  );

  // ---------------------------------------------------------------- 曝光质量
  let wordShareSum = 0;
  let positionWeightSum = 0;
  let firstSentenceHits = 0;
  for (const row of mentionedRows) {
    const sentences = splitSentences(row.answer.text);
    if (!sentences.length) continue;
    const totalChars = sentences.reduce((sum, sentence) => sum + sentence.length, 0) || 1;
    const hitIndexes = sentences
      .map((sentence, index) => (names.some((name) => sentence.includes(name)) ? index : -1))
      .filter((index) => index >= 0);

    if (!hitIndexes.length) continue;
    const hitChars = hitIndexes.reduce((sum, index) => sum + sentences[index].length, 0);
    wordShareSum += hitChars / totalChars;

    // 位置加权：论文 Position-Adjusted Word Count 的思路，位置越靠前权重越高
    const firstIndex = hitIndexes[0];
    positionWeightSum += Math.exp(-firstIndex / sentences.length) * (hitChars / totalChars);
    if (firstIndex === 0) firstSentenceHits += 1;
  }
  const mentionedCount = mentionedRows.length;

  // ---------------------------------------------------------------- 引用源
  const domainMap = new Map(); // domain -> {count, titles:Set, own:boolean}
  let citationTotal = 0;
  for (const row of safeRows) {
    const cites = Array.isArray(row?.answer?.citations) ? row.answer.citations : [];
    for (const cite of cites) {
      const domain = domainOf(cite?.url);
      if (!domain) continue;
      citationTotal += 1;
      const own = isOwnDomain(domain, ownDomains)
        || names.some((name) => String(cite?.title ?? '').includes(name));
      const sameName = !own && isSameNameDomain(domain, sameNameHints);
      const entry = domainMap.get(domain) ?? {
        domain,
        count: 0,
        titles: new Set(),
        own: false,
        sameName: false,
      };
      entry.count += 1;
      entry.own = entry.own || own;
      entry.sameName = entry.sameName || sameName;
      if (cite?.title) entry.titles.add(String(cite.title).slice(0, 60));
      domainMap.set(domain, entry);
    }
  }

  const byDomain = [...domainMap.values()]
    .map((entry) => {
      const meta = classifyDomain(entry.domain);
      return {
        domain: entry.domain,
        count: entry.count,
        share: pct(entry.count, citationTotal),
        type: entry.own ? 'own' : meta.type,
        typeLabel: entry.own ? '自有站点' : entry.sameName ? '同名实体站点（不可用）' : meta.label,
        sameName: entry.sameName,
        titles: [...entry.titles].slice(0, 3),
      };
    })
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));

  const ownCitations = byDomain.filter((item) => item.type === 'own').reduce((sum, item) => sum + item.count, 0);
  const sourceMix = { own: 0, social: 0, media: 0, encyclopedia: 0, search: 0, other: 0 };
  for (const item of byDomain) sourceMix[item.type] = (sourceMix[item.type] ?? 0) + item.count;

  // ---------------------------------------------------------------- 竞品 SoV
  const engineOf = (row) => String(row?.answer?.engine ?? 'unknown');
  const competitorStats = competitors.map((name) => {
    const hitRows = okRows.filter((row) => String(row?.answer?.text ?? '').includes(name));
    const engines = [...new Set(hitRows.map(engineOf))];
    return { name, mentions: hitRows.length, rate: pct(hitRows.length, okRows.length), engines };
  });
  const brandMentions = mentionedCount;
  const competitorMentions = competitorStats.reduce((sum, item) => sum + item.mentions, 0);
  const sovTotal = brandMentions + competitorMentions;
  const sov = {
    brandShare: pct(brandMentions, sovTotal),
    competitors: competitorStats
      .map((item) => ({ ...item, share: pct(item.mentions, sovTotal) }))
      .sort((a, b) => b.mentions - a.mentions),
  };

  // ---------------------------------------------------------------- 情感
  const sentiment = { positive: 0, neutral: 0, negative: 0, score: 0 };
  for (const row of mentionedRows) {
    const hitSentences = splitSentences(row.answer.text)
      .filter((sentence) => names.some((name) => sentence.includes(name)));
    const scope = hitSentences.length ? hitSentences.join('。') : String(row.answer.text ?? '');
    const positiveHits = (scope.match(POSITIVE_RE) ?? []).length;
    const negativeHits = (scope.match(NEGATIVE_RE) ?? []).length;
    if (positiveHits > negativeHits) sentiment.positive += 1;
    else if (negativeHits > positiveHits) sentiment.negative += 1;
    else sentiment.neutral += 1;
  }
  const sentimentTotal = mentionedCount || 1;
  sentiment.score = round(
    (sentiment.positive - sentiment.negative) / sentimentTotal,
    4,
  );

  // ---------------------------------------------------------------- query fan-out
  // 引擎把用户问题改写成了哪些检索词。这是「内容该覆盖什么词」的最直接证据。
  const fanoutMap = new Map(); // query -> {count, engines:Set}
  for (const row of safeRows) {
    const queries = Array.isArray(row?.answer?.searchQueries) ? row.answer.searchQueries : [];
    for (const raw of queries) {
      const value = String(raw ?? '').trim();
      if (!value) continue;
      const entry = fanoutMap.get(value) ?? { query: value, count: 0, engines: new Set() };
      entry.count += 1;
      entry.engines.add(engineOf(row));
      fanoutMap.set(value, entry);
    }
  }
  const fanoutTop = [...fanoutMap.values()]
    .map((entry) => ({ query: entry.query, count: entry.count, engines: [...entry.engines] }))
    .sort((a, b) => b.count - a.count || a.query.localeCompare(b.query));
  const fanout = {
    total: fanoutTop.reduce((sum, item) => sum + item.count, 0),
    unique: fanoutTop.length,
    // 改写词里出现品牌名的比例：越高说明引擎「知道你是谁」，但也可能是引导性污染
    brandInQueries: fanoutTop.filter((item) => names.some((name) => item.query.includes(name))).length,
    top: fanoutTop.slice(0, 10),
  };

  // ---------------------------------------------------------------- 判定分布（10 态）
  const verdictCounts = {};
  for (const row of safeRows) {
    const verdict = row?.judgment?.verdict ?? 'unknown';
    verdictCounts[verdict] = (verdictCounts[verdict] ?? 0) + 1;
  }

  // ---------------------------------------------------------------- 证据等级
  const evidence = { A: 0, B: 0, C: 0 };
  for (const row of safeRows) evidence[gradeEvidence(row)] += 1;

  // ---------------------------------------------------------------- 引擎分布
  const engineMap = new Map();
  for (const row of safeRows) {
    const engine = engineOf(row);
    const entry = engineMap.get(engine) ?? { engine, answers: 0, ok: 0, mentioned: 0 };
    entry.answers += 1;
    if (row?.answer?.status === 'ok') entry.ok += 1;
    if (mentionedRows.includes(row)) entry.mentioned += 1;
    engineMap.set(engine, entry);
  }
  const engines = [...engineMap.values()]
    .map((entry) => ({ ...entry, mentionRate: pct(entry.mentioned, entry.ok) }))
    .sort((a, b) => b.answers - a.answers);

  // ---------------------------------------------------------------- 机会
  const opportunities = byDomain
    .filter((item) => item.type !== 'own' && !item.sameName)
    .slice(0, 5)
    .map((item) => ({
      domain: item.domain,
      count: item.count,
      share: item.share,
      typeLabel: item.typeLabel,
      reason:
        item.type === 'registry'
          ? `该站是工商/企查信息源，被 AI 引用 ${item.count} 次 → 先把工商信息补全（经营范围、官网链接、简介），让 AI 能顺链找到你的站`
          : `该站已被 AI 引用 ${item.count} 次，但引用里没有你的站点 → 优先在这里建立可被引用的内容或页面`,
    }));

  // 同名实体威胁：这类站占走了「你名字」的引用位，但内容不是你写的
  const sameNameThreats = byDomain
    .filter((item) => item.sameName)
    .slice(0, 5)
    .map((item) => ({
      domain: item.domain,
      count: item.count,
      share: item.share,
      message: `同名实体站点被 AI 引用 ${item.count} 次（占 ${(item.share * 100).toFixed(1)}%）：AI 在讲「${brand.name ?? '品牌'}」时可能引的是别家，需要做实体区分（全称+城市+业务词、官网 schema、工商信息挂官网链接）`,
    }));

  return {
    sample: {
      total: safeRows.length,
      ok: okRows.length,
      mentioned: mentionedCount,
      recommended: okRows.filter((row) => row.judgment?.verdict === 'recommended').length,
      mentionRate: pct(mentionedCount, okRows.length),
      recommendationRate: pct(
        okRows.filter((row) => row.judgment?.verdict === 'recommended').length,
        okRows.length,
      ),
    },
    exposure: {
      avgWordShare: mentionedCount ? round(wordShareSum / mentionedCount) : 0,
      avgPositionWeight: mentionedCount ? round(positionWeightSum / mentionedCount) : 0,
      firstSentenceRate: mentionedCount ? round(firstSentenceHits / mentionedCount) : 0,
    },
    citations: {
      total: citationTotal,
      uniqueDomains: byDomain.length,
      ownShare: pct(ownCitations, citationTotal),
      byDomain,
      sourceMix,
    },
    sov: { brandMentions, brandShare: sov.brandShare, competitors: sov.competitors },
    sentiment,
    engines,
    fanout,
    evidence,
    verdictCounts,
    sameNameThreats,
    opportunities,
  };
}

/**
 * 把分析结果渲染成 Markdown 行（供 report.js 直接插入章节）。
 * @param {object} insights analyzeRun 的返回值
 * @param {object} [options]
 * @returns {string[]}
 */
export function renderInsightsMarkdown(insights, options = {}) {
  const { maxDomains = 10, maxCompetitors = 5 } = options;
  const lines = [];
  const fmtPctLocal = (ratio) => `${(Number(ratio ?? 0) * 100).toFixed(1)}%`;
  if (!insights || !insights.sample || insights.sample.total === 0) {
    lines.push('本轮没有可分析的样本。');
    return lines;
  }

  const { sample, exposure, citations, sov, sentiment, opportunities } = insights;
  lines.push(
    `样本 ${sample.total} 条（有效 ${sample.ok} 条），提及率 ${fmtPctLocal(sample.mentionRate)}，被推荐率 ${fmtPctLocal(sample.recommendationRate)}。`,
    '',
    '**曝光质量**（不只看"有没有提"，还看占多大篇幅、排多前）',
    '',
    '| 指标 | 数值 | 含义 |',
    '| --- | --- | --- |',
    `| 篇幅占比 | ${fmtPctLocal(exposure.avgWordShare)} | 提到你的句子占回答字数的比例 |`,
    `| 位置权重 | ${exposure.avgPositionWeight.toFixed(3)} | 越靠前越高（指数衰减，上限 1） |`,
    `| 首句命中率 | ${fmtPctLocal(exposure.firstSentenceRate)} | 你的名字出现在第一句的比例 |`,
    '',
  );

  if (sov.competitors.length || sov.brandMentions) {
    lines.push('**竞品份额（SoV）** —— 同一批问题里谁被提到的份额更大', '');
    lines.push('| 品牌 | 提及题数 | 份额 |', '| --- | --- | --- |');
    lines.push(`| **本品牌** | ${sov.brandMentions} | ${fmtPctLocal(sov.brandShare)} |`);
    for (const item of sov.competitors.slice(0, maxCompetitors)) {
      lines.push(`| ${item.name} | ${item.mentions} | ${fmtPctLocal(item.share)} |`);
    }
    lines.push('');
  }

  if (citations.total > 0) {
    lines.push('**引用源分析** —— AI 在引用哪些站，决定你该去哪里铺内容', '');
    lines.push('| 域名 | 被引次数 | 占全部引用 | 类型 |', '| --- | --- | --- | --- |');
    for (const item of citations.byDomain.slice(0, maxDomains)) {
      lines.push(`| ${item.domain} | ${item.count} | ${fmtPctLocal(item.share)} | ${item.typeLabel} |`);
    }
    lines.push('');
    lines.push(
      `全部引用 ${citations.total} 条、去重后 ${citations.uniqueDomains} 个域名；自有站点占 ${fmtPctLocal(citations.ownShare)}。`,
      '',
    );
  } else {
    lines.push('本轮回答没有返回可解析的引用来源（有些引擎不返回 citations），引用源分析为空。', '');
  }

  if (insights.fanout && insights.fanout.unique > 0) {
    lines.push('**Query fan-out（引擎把你的问题改写成了这些检索词）**', '');
    lines.push('| 改写出的检索词 | 出现次数 | 出现在哪些引擎 |', '| --- | --- | --- |');
    for (const item of insights.fanout.top) {
      lines.push(`| ${item.query} | ${item.count} | ${item.engines.join('、')} |`);
    }
    lines.push('');
    lines.push(
      `共 ${insights.fanout.total} 条改写词、去重 ${insights.fanout.unique} 条；其中 ${insights.fanout.brandInQueries} 条含品牌名。`,
      '',
    );
  }

  if (insights.verdictCounts) {
    const labels = {
      recommended: '推荐',
      conditionally_recommended: '条件推荐',
      candidate: '候选',
      listed: '列入',
      mentioned: '仅提及',
      not_mentioned: '未提及',
      ambiguous: '歧义',
      unknown: '未知',
      refused: '拒答',
      engine_error: '引擎错误',
    };
    const entries = Object.entries(insights.verdictCounts).sort((a, b) => b[1] - a[1]);
    lines.push(
      '**判定分布（10 态）** —— 决定分数分母的硬轴',
      '',
      entries.map(([key, count]) => `${labels[key] ?? key} ${count}`).join(' · '),
      '',
    );
  }

  if (insights.evidence) {
    lines.push(
      '**证据等级**（A=原话+可点开来源 / B=有原话无引用 / C=无原话）',
      '',
      `A ${insights.evidence.A} 条 · B ${insights.evidence.B} 条 · C ${insights.evidence.C} 条。` +
        '对外汇报只引用 A 级证据；B 级只能说明「AI 这么说过」，不能说「依据是哪个网页」。',
      '',
    );
  }

  lines.push(
    '**情感倾向**（规则词典判定，只覆盖明确褒贬词；判不出就记为中性）',
    '',
    `正面 ${sentiment.positive} 条 · 中性 ${sentiment.neutral} 条 · 负面 ${sentiment.negative} 条（得分 ${sentiment.score.toFixed(2)}，范围 -1 ~ 1）`,
    '',
  );

  if (insights.sameNameThreats && insights.sameNameThreats.length) {
    lines.push('**同名实体威胁**（不是机会，是无法发内容的竞品站）', '');
    for (const threat of insights.sameNameThreats) lines.push(`- ${threat.message}`);
    lines.push('');
  }

  if (opportunities.length) {
    lines.push('**机会缺口（按引用次数排序）**', '');
    for (const item of opportunities) {
      lines.push(`- \`${item.domain}\`（${item.typeLabel}，被引 ${item.count} 次）：${item.reason}`);
    }
    lines.push('');
  }

  return lines;
}
