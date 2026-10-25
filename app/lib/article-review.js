/**
 * lib/article-review.js
 * 文章终审：七维质量分 + 硬伤/软伤检测 + 高风险人工签发。
 * 对应 OmniRank writing/geo_article_expert.py 的规则化部分。
 *
 * 设计约束：
 * - 纯规则、零依赖、确定性：同一输入必然得到同一份 review，不调用任何模型；
 * - 只做「能不能发」的判断，不改写正文，也不替运营做最终决定；
 * - 硬伤（hard）触发即不可发布，风险至少为 high，必须人工签发；
 * - 软伤（soft）只提示优化方向，累计 3 项及以上把风险抬到 medium。
 *
 * 评分口径（权重合计 100）：
 *   事实密度 20 / 证据可核 20 / 结构可摘录 15 / 实体清晰 15 / 意图对齐 15 / 可读性 10 / 差异化 5
 * 总分 = Σ（权重 × 维度得分）/ 100，保留 1 位小数。
 *
 * 等级口径（与发布闸门分开看）：
 *   硬伤 > 0 → 不可发布；总分 ≥ 85 优秀；≥ 70 合格；≥ 60 需修改（已过 60 分底线，
 *   按契约 publishable 仍为 true，但建议改完再发）；< 60 → 不可发布。
 *
 * 注意：标题同时命中「绝对化用语」与「标题承诺过度」时会记两条硬伤，
 * 因为两者判定口径不同（一处查全文措辞，一处查标题承诺），不做去重。
 */

/** 七维质量分：key 供程序使用，label 进报告，weight 合计 100。 */
export const REVIEW_DIMENSIONS = Object.freeze(
  [
    { key: 'factDensity', label: '事实密度', weight: 20, description: '含数字/年份的句子占比，衡量可被引用的事实颗粒度' },
    { key: 'evidenceTraceability', label: '证据可核', weight: 20, description: '含链接/「来源：」/「据…」句占比，衡量证据可追溯性' },
    { key: 'structureExtractability', label: '结构可摘录', weight: 15, description: '小标题、列表、问答结构的完备程度，决定 AI 能否整段摘录' },
    { key: 'entityClarity', label: '实体清晰', weight: 15, description: '品牌名、城市、服务是否在前 200 字交代清楚' },
    { key: 'intentAlignment', label: '意图对齐', weight: 15, description: '标题与正文对 brief.keywords / brief.term 的覆盖度' },
    { key: 'readability', label: '可读性', weight: 10, description: '平均句长与段落长度是否处于合理区间' },
    { key: 'differentiation', label: '差异化', weight: 5, description: '「相比/不同」类表达或 brief.differentiators 的命中情况' },
  ].map((item) => Object.freeze(item)),
);

/** 等级阈值：优秀 / 合格 / 需修改（发布底线 60）。 */
const LEVEL_THRESHOLDS = Object.freeze({ excellent: 85, qualified: 70, revise: 60 });

/** 正文中文字符下限（低于即判篇幅不足）。 */
const MIN_BODY_HAN = 800;

/** 事实密度满分对应的占比：40% 的句子带数字/年份即给满。 */
const FACT_TARGET_RATIO = 0.4;

/** 证据可核满分对应的占比：25% 的句子带出处即给满。 */
const EVIDENCE_TARGET_RATIO = 0.25;

/** 实体信息检查窗口：正文前 200 字。 */
const ENTITY_HEAD_CHARS = 200;

/** 单段超过该字数且无换行，判「段落过长」。 */
const MAX_PARAGRAPH_HAN = 300;

/** 风险中文标签。 */
const RISK_LABELS = Object.freeze({ low: '低', medium: '中', high: '高' });

/** 绝对化/承诺类用语（负向断言避免「不最好」「不保证」误报）。 */
const ABSOLUTE_RULES = Object.freeze([
  { label: '最好', re: /(?<![不非])最好/ },
  { label: '第一', re: /(?<![不非])第一(?!次|步|时间|天|年|月|季|批|条|篇|阶段|个)/ },
  { label: '唯一', re: /(?<![不非])唯一/ },
  { label: '顶级', re: /顶级/ },
  { label: '保证', re: /(?<![不无没])保证/ },
  { label: '100%', re: /100\s*%/ },
  { label: '稳赚', re: /稳赚/ },
  { label: '绝对', re: /绝对(?![不没])/ },
  { label: '永久', re: /永久/ },
]);

/** 标题里的承诺型表述（「一定的」这类限定用法不算）。 */
const TITLE_PROMISE_RULES = Object.freeze([
  { label: '保证', re: /(?<![不无没])保证/ },
  { label: '一定', re: /一定(?!的|程度|范围|时间|要|能)/ },
  { label: '100%', re: /100\s*%/ },
  { label: '立刻', re: /立刻/ },
  { label: '马上', re: /马上/ },
]);

/** 带百分比数字（无来源即硬伤）。 */
const PERCENT_RE = /\d+(?:\.\d+)?\s*%/;

/** 段落内的出处标记：有其一即认为数字/案例可核。 */
const SOURCE_MARKER_RE = /https?:\/\/|来源[:：]|出处[:：]|据|引用|引自|官网|公开|报告|统计/;

/** 常见姓氏白名单：只认「姓氏 + 先生/女士」，避免把「这位先生」误判成化名。 */
const CASE_SURNAMES =
  '张王李赵刘陈杨黄周吴徐孙马朱胡林郭何高罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘蒋蔡余杜叶程苏魏吕丁任沈' +
  '姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤';

/** 虚构案例信号：某客户 / 我们的客户 / 张先生式化名。 */
const CASE_SIGNAL_RE = new RegExp(
  `某(?:客户|商家|学员|企业|公司)|(?:我们|我司|本公司)(?:的)?(?:客户|学员|商家)|[${CASE_SURNAMES}](?:先生|女士)`,
);

/** 案例可核标记：有授权或来源就不算编造。 */
const CASE_SOURCE_RE = /来源|授权|脱敏|案例来源|https?:\/\//;

/** 差异化信号词（命中即加分）。 */
const DIFFERENTIATION_MARKERS = Object.freeze([
  '相比',
  '对比',
  '不同于',
  '区别于',
  '不同点',
  '差异',
  '而不是',
  '相比之下',
  '相较',
]);

/** 低分维度的改稿建议（按维度固定顺序取用）。 */
const DIMENSION_ADVICE = Object.freeze({
  factDensity: '事实密度偏低：补入可核验的数字（价格、周期、数量、年份），别只写形容词。',
  evidenceTraceability: '证据可核偏低：关键结论后面补链接或「来源：」标注，让读者能自己核对。',
  structureExtractability: '结构可摘录偏低：拆出 2 个以上小标题，把并列信息改成列表，补一段问答。',
  entityClarity: '实体清晰偏低：在前 200 字里写清品牌名、所在城市和主营服务，别让 AI 猜。',
  intentAlignment: '意图对齐偏低：标题与正文都要覆盖 brief 的关键词或 term，别跑题。',
  readability: '可读性偏低：拆长句、分段，让平均句长落在 8–45 字、段落落在 25–250 字。',
  differentiation: '差异化偏低：用「相比/不同」说清与同类的边界，或引用 brief.differentiators。',
});

/** 硬伤对应的改稿建议。 */
const DEFECT_ADVICE = Object.freeze({
  absolute_claim: '删除或改写绝对化用语（最好/第一/唯一/顶级/保证/100%/稳赚/绝对/永久），换成条件式表述。',
  unsourced_number: '带百分比的数字必须补来源链接或「来源：」标注；补不上就改成定性描述。',
  fabricated_case: '删掉无授权的客户案例与「某客户/张先生」式化名；要么拿到书面授权并脱敏，要么改成流程说明。',
  title_overpromise: '标题去掉保证/一定/100%/立刻/马上等承诺，改成「条件 + 范围」的表述。',
  insufficient_length: `正文不足 ${MIN_BODY_HAN} 个中文字符：补足可核验的细节（报价、流程、边界）后再送审。`,
  long_paragraph: `单段超过 ${MAX_PARAGRAPH_HAN} 字且无换行：按语义拆成 2–4 段，方便 AI 与读者摘录。`,
  no_headings: '缺少小标题：按「是什么/多少钱/怎么做/和谁不同」补 2 级以上标题。',
  no_lists: '缺少列表：把并列的档位、步骤、判断条件改成无序或有序列表。',
  intent_mismatch: '标题没有覆盖 brief 的关键词：把目标词放进标题前半句，避免标题党式自造词。',
  duplicate_title: '标题与已有文章重复：换一个角度或限定词，避免站内关键词自噬。',
});

function asText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function asList(value) {
  return Array.isArray(value) ? value.filter((item) => item != null) : [];
}

function round1(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10) / 10;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 中文字符数（只数汉字，标点、数字、英文不计）。 */
function countHan(text) {
  const matched = asText(text).match(/[\u4e00-\u9fff]/g);
  return matched ? matched.length : 0;
}

/** 按句切分：句号/问号/叹号/分号/换行都视为句子边界，只保留含汉字的句子。 */
function splitSentences(text) {
  return asText(text)
    .split(/[。！？!?；;\n]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => countHan(sentence) > 0);
}

/** 按空行切块（Markdown 的自然段）。 */
function splitBlocks(text) {
  return asText(text)
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
}

/** 是否小标题行：Markdown 标题、中文序号标题、独立加粗行。 */
function isHeadingLine(line) {
  const trimmed = asText(line).trim();
  if (!trimmed) return false;
  if (/^#{1,6}\s+\S/.test(trimmed)) return true;
  if (/^[一二三四五六七八九十]+、\S{1,40}$/.test(trimmed)) return true;
  if (/^（[一二三四五六七八九十]+）\S{1,40}$/.test(trimmed)) return true;
  if (/^\*\*[^*]+\*\*[:：]?$/.test(trimmed)) return true;
  return false;
}

/** 去掉小标题行与列表符号，得到用于句级分析的正文。 */
function stripMarkup(text) {
  return asText(text)
    .split('\n')
    .filter((line) => !isHeadingLine(line) && !/^\s*$/.test(line))
    .join('\n')
    .replace(/^\s*(?:[-*+]|\d+[.、)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\*\*|__|`/g, '');
}

/** 有效段落块：排除只有小标题的块。 */
function contentBlocks(text) {
  return splitBlocks(text).filter((block) => {
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return false;
    if (lines.every(isHeadingLine)) return false;
    return countHan(block) > 0;
  });
}

/** 列表项数量。 */
function countListItems(text) {
  return (asText(text).match(/^\s*(?:[-*+]|\d+[.、)])\s+\S/gm) || []).length;
}

/** 是否有问答结构：问/答行，或正文里有两个以上问号。 */
function hasQaStructure(text) {
  const source = asText(text);
  if (/^\s*(?:问|答)[:：]/m.test(source)) return true;
  return (source.match(/[？?]/g) || []).length >= 2;
}

/** 摘要片段（用于缺陷说明）。 */
function snippet(text, max = 40) {
  const chars = Array.from(asText(text).replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

/** 表格单元格转义。 */
function cell(value) {
  return asText(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/** 标题归一化：去空白与常见标点，用于重复检测。 */
function normalizeTitle(text) {
  return asText(text)
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。！？、：；""''「」『』（）()【】[\]《》<>·—\-_/|,.!?:;"']/g, '')
    .toLowerCase();
}

/** 收集 brief 里的目标词（keywords 支持字符串或 {term} 对象，term 单独收）。 */
function collectKeywords(brief) {
  const raw = [];
  for (const item of asList(brief && brief.keywords)) {
    if (typeof item === 'string') raw.push(item);
    else if (item && typeof item === 'object') raw.push(item.term ?? item.text ?? item.keyword);
  }
  raw.push(brief && brief.term, brief && brief.keyword);
  return [...new Set(raw.map((item) => asText(item).trim()).filter(Boolean))];
}

// ---------------------------------------------------------------------------
// 七维打分：每个函数返回 { score: 0-100 整数, reasons: 中文说明数组 }
// ---------------------------------------------------------------------------

/** 事实密度：含数字/年份的句子占比，40% 给满。 */
function scoreFactDensity({ body }) {
  const sentences = splitSentences(stripMarkup(body));
  if (sentences.length === 0) return { score: 0, reasons: ['正文没有可分析的句子，事实密度按 0 分'] };
  const withFact = sentences.filter((sentence) => /\d/.test(sentence));
  const ratio = withFact.length / sentences.length;
  const score = clamp(Math.round((ratio / FACT_TARGET_RATIO) * 100), 0, 100);
  return {
    score,
    reasons: [
      `${withFact.length}/${sentences.length} 句含数字或年份（占 ${round1(ratio * 100)}%），` +
        `按 ${FACT_TARGET_RATIO * 100}% 为满分折算 → ${score} 分`,
    ],
  };
}

/** 证据可核：含链接/「来源：」/「据…」的句子占比，25% 给满。 */
function scoreEvidence({ body }) {
  const sentences = splitSentences(stripMarkup(body));
  if (sentences.length === 0) return { score: 0, reasons: ['正文没有可分析的句子，证据可核按 0 分'] };
  const traced = sentences.filter((sentence) => SOURCE_MARKER_RE.test(sentence));
  const ratio = traced.length / sentences.length;
  const score = clamp(Math.round((ratio / EVIDENCE_TARGET_RATIO) * 100), 0, 100);
  return {
    score,
    reasons: [
      `${traced.length}/${sentences.length} 句带链接或出处标记（占 ${round1(ratio * 100)}%），` +
        `按 ${EVIDENCE_TARGET_RATIO * 100}% 为满分折算 → ${score} 分`,
    ],
  };
}

/** 结构可摘录：小标题 35 + 列表 25 + 问答 20 + 分段 20。 */
function scoreStructure({ body }) {
  const lines = asText(body)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const headingCount = lines.filter(isHeadingLine).length;
  const listItems = countListItems(body);
  const qa = hasQaStructure(body);
  const blocks = contentBlocks(body).length;

  const headingScore = headingCount >= 2 ? 35 : headingCount === 1 ? 20 : 0;
  const listScore = listItems >= 3 ? 25 : listItems > 0 ? 15 : 0;
  const qaScore = qa ? 20 : 0;
  const blockScore = blocks >= 4 ? 20 : blocks >= 2 ? 12 : blocks === 1 ? 5 : 0;
  const score = headingScore + listScore + qaScore + blockScore;

  return {
    score,
    reasons: [
      `小标题 ${headingCount} 个（${headingScore} 分）、列表项 ${listItems} 条（${listScore} 分）、` +
        `问答结构 ${qa ? '有' : '无'}（${qaScore} 分）、有效段落 ${blocks} 段（${blockScore} 分）`,
    ],
  };
}

/** 实体清晰：前 200 字是否交代品牌名（40）、城市（30）、服务（30）。 */
function scoreEntity({ body, brand }) {
  const head = Array.from(asText(body)).slice(0, ENTITY_HEAD_CHARS).join('');
  const names = [brand.name, brand.legalName, ...asList(brand.aliases)]
    .map((item) => asText(item).trim())
    .filter(Boolean);
  const city = asText(brand.city).trim();
  const services = asList(brand.services)
    .map((item) => asText(item).trim())
    .filter(Boolean);
  const industry = asText(brand.industry).trim();
  const serviceNeedles = services.length > 0 ? services : industry ? [industry] : [];

  const checks = [];
  if (names.length > 0) {
    checks.push({ label: `品牌名「${names[0]}」`, weight: 40, hit: names.some((name) => head.includes(name)) });
  }
  if (city) checks.push({ label: `城市「${city}」`, weight: 30, hit: head.includes(city) });
  if (serviceNeedles.length > 0) {
    checks.push({
      label: `服务「${serviceNeedles.slice(0, 3).join('、')}」`,
      weight: 30,
      hit: serviceNeedles.some((service) => head.includes(service)),
    });
  }

  if (checks.length === 0) {
    return { score: 0, reasons: ['brand 未提供品牌名/城市/服务，无法核对实体，按 0 分'] };
  }

  const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0);
  const hitWeight = checks.filter((check) => check.hit).reduce((sum, check) => sum + check.weight, 0);
  const score = Math.round((hitWeight / totalWeight) * 100);
  const hitLabels = checks.filter((check) => check.hit).map((check) => check.label);
  const missLabels = checks.filter((check) => !check.hit).map((check) => check.label);
  const reasons = [
    `前 200 字命中：${hitLabels.length > 0 ? hitLabels.join('、') : '无'}` +
      `（${hitWeight}/${totalWeight} 权重）→ ${score} 分`,
  ];
  if (missLabels.length > 0) reasons.push(`未命中：${missLabels.join('、')}，读者与 AI 都难以确认实体`);

  return { score, reasons };
}

/** 意图对齐：正文覆盖 70 分 + 标题覆盖 30 分；brief 没给目标词按中性 50 分。 */
function scoreIntent({ title, body, keywords }) {
  if (keywords.length === 0) {
    return { score: 50, reasons: ['brief 未提供 keywords/term，意图对齐无法判定，按中性 50 分'] };
  }
  const bodyHits = keywords.filter((keyword) => asText(body).includes(keyword));
  const titleHits = keywords.filter((keyword) => asText(title).includes(keyword));
  const bodyPart = (bodyHits.length / keywords.length) * 70;
  const titlePart = (titleHits.length / keywords.length) * 30;
  const score = clamp(Math.round(bodyPart + titlePart), 0, 100);
  return {
    score,
    reasons: [
      `目标词 ${keywords.length} 个：正文命中 ${bodyHits.length} 个（${round1((bodyHits.length / keywords.length) * 100)}%）、` +
        `标题命中 ${titleHits.length} 个；正文 70 分 + 标题 30 分加权 → ${score} 分`,
    ],
  };
}

/** 差异化：每次命中 50 分，两处及以上给满；含 brief.differentiators。 */
function scoreDifferentiation({ body, brief }) {
  const source = asText(body);
  const markers = DIFFERENTIATION_MARKERS.filter((marker) => source.includes(marker));
  const declared = asList(brief && brief.differentiators)
    .map((item) => asText(item).trim())
    .filter((item) => item && source.includes(item));
  const hits = markers.length + declared.length;
  const score = clamp(hits * 50, 0, 100);
  if (hits === 0) {
    return { score: 0, reasons: ['未出现「相比/不同」类表达，也未命中 brief.differentiators → 0 分'] };
  }
  return {
    score,
    reasons: [
      `命中差异化信号 ${hits} 处：${[...markers, ...declared].slice(0, 4).join('、')} → ${score} 分`,
    ],
  };
}

/** 可读性：平均句长理想 8–45 字，平均段落理想 25–250 字，越界扣分。 */
function scoreReadability({ body }) {
  const prose = stripMarkup(body);
  const sentences = splitSentences(prose);
  const blocks = contentBlocks(body);
  if (sentences.length === 0) return { score: 0, reasons: ['正文为空，可读性按 0 分'] };

  const avgSentence = countHan(prose) / sentences.length;
  const avgBlock = blocks.length > 0 ? countHan(body) / blocks.length : countHan(body);
  let score = 100;
  const reasons = [];

  if (avgSentence > 45) {
    const penalty = Math.min(40, (avgSentence - 45) * 0.8);
    score -= penalty;
    reasons.push(`平均句长 ${round1(avgSentence)} 字 > 45，扣 ${round1(penalty)} 分`);
  } else if (avgSentence < 8) {
    score -= 15;
    reasons.push(`平均句长 ${round1(avgSentence)} 字 < 8，句子过碎，扣 15 分`);
  } else {
    reasons.push(`平均句长 ${round1(avgSentence)} 字，处于 8–45 字合理区间`);
  }

  if (avgBlock > 250) {
    const penalty = Math.min(30, (avgBlock - 250) / 10);
    score -= penalty;
    reasons.push(`平均段落 ${round1(avgBlock)} 字 > 250，扣 ${round1(penalty)} 分`);
  } else if (avgBlock < 25) {
    score -= 10;
    reasons.push(`平均段落 ${round1(avgBlock)} 字 < 25，段落过碎，扣 10 分`);
  } else {
    reasons.push(`平均段落 ${round1(avgBlock)} 字，处于 25–250 字合理区间`);
  }

  const finalScore = clamp(Math.round(score), 0, 100);
  reasons.push(`可读性得分 ${finalScore}`);
  return { score: finalScore, reasons };
}

/** 维度 key → 打分函数。 */
const SCORERS = Object.freeze({
  factDensity: scoreFactDensity,
  evidenceTraceability: scoreEvidence,
  structureExtractability: scoreStructure,
  entityClarity: scoreEntity,
  intentAlignment: scoreIntent,
  readability: scoreReadability,
  differentiation: scoreDifferentiation,
});

// ---------------------------------------------------------------------------
// 缺陷检测
// ---------------------------------------------------------------------------

/** 硬伤：绝对化、无来源数字、虚构案例、标题承诺、篇幅不足。 */
function findHardDefects({ title, body, hanCount }) {
  const defects = [];
  const scanText = `${title}\n${body}`;

  // 1) 绝对化用语：标题与正文一起查
  const absoluteHits = ABSOLUTE_RULES.filter((rule) => rule.re.test(scanText)).map((rule) => rule.label);
  if (absoluteHits.length > 0) {
    defects.push({
      type: 'hard',
      code: 'absolute_claim',
      label: '绝对化用语',
      detail: `出现「${absoluteHits.join('」「')}」等绝对化/承诺用语，违反广告法与平台规则，必须删除或改写。`,
    });
  }

  // 2) 无来源数字：整段没有链接/来源标记的百分比数字
  const unsourced = splitBlocks(body).filter(
    (block) => PERCENT_RE.test(block) && !SOURCE_MARKER_RE.test(block),
  );
  if (unsourced.length > 0) {
    defects.push({
      type: 'hard',
      code: 'unsourced_number',
      label: '无来源数字',
      detail: `${unsourced.length} 个段落出现百分比数字但无链接或「来源：」标注，首段摘录：「${snippet(unsourced[0])}」。`,
    });
  }

  // 3) 虚构案例信号：化名/某客户，且同段没有授权或来源
  const caseParagraphs = splitBlocks(body).filter(
    (block) => CASE_SIGNAL_RE.test(block) && !CASE_SOURCE_RE.test(block),
  );
  if (caseParagraphs.length > 0) {
    defects.push({
      type: 'hard',
      code: 'fabricated_case',
      label: '虚构案例信号',
      detail: `${caseParagraphs.length} 个段落出现「某客户/张先生」式案例但无授权或来源，首段摘录：「${snippet(caseParagraphs[0])}」。`,
    });
  }

  // 4) 标题承诺过度
  const promiseHits = TITLE_PROMISE_RULES.filter((rule) => rule.re.test(title)).map((rule) => rule.label);
  if (promiseHits.length > 0) {
    defects.push({
      type: 'hard',
      code: 'title_overpromise',
      label: '标题承诺过度',
      detail: `标题「${snippet(title)}」含承诺型表述「${promiseHits.join('」「')}」，给出无法兑现的确定结果，属高风险标题党。`,
    });
  }

  // 5) 篇幅不足
  if (hanCount < MIN_BODY_HAN) {
    defects.push({
      type: 'hard',
      code: 'insufficient_length',
      label: '篇幅不足',
      detail: `正文仅 ${hanCount} 个中文字符，低于 ${MIN_BODY_HAN} 字下限，内容密度不足，难以被 AI 整段摘录。`,
    });
  }

  return defects;
}

/** 软伤：段落过长、无小标题、无列表、意图不一致、标题重复。 */
function findSoftDefects({ title, body, keywords, existingTitles }) {
  const defects = [];
  const lines = asText(body)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  // 1) 段落过长
  const longLines = lines.filter((line) => !isHeadingLine(line) && countHan(line) > MAX_PARAGRAPH_HAN);
  if (longLines.length > 0) {
    const longest = longLines.reduce((max, line) => Math.max(max, countHan(line)), 0);
    defects.push({
      type: 'soft',
      code: 'long_paragraph',
      label: '段落过长',
      detail: `${longLines.length} 段超过 ${MAX_PARAGRAPH_HAN} 字且无换行（最长 ${longest} 字），手机端阅读与整段摘录都吃力。`,
    });
  }

  // 2) 无小标题
  if (!lines.some(isHeadingLine)) {
    defects.push({
      type: 'soft',
      code: 'no_headings',
      label: '无小标题',
      detail: '全文没有小标题，信息层级扁平，AI 难以按节摘录。',
    });
  }

  // 3) 无列表
  if (countListItems(body) === 0) {
    defects.push({
      type: 'soft',
      code: 'no_lists',
      label: '无列表',
      detail: '全文没有列表，并列的档位/步骤/条件都埋在段落里，可扫描性差。',
    });
  }

  // 4) 标题与 brief 意图不一致
  if (keywords.length > 0 && !keywords.some((keyword) => asText(title).includes(keyword))) {
    defects.push({
      type: 'soft',
      code: 'intent_mismatch',
      label: '标题与意图不一致',
      detail: `标题未覆盖 brief 的目标词（${keywords.slice(0, 4).join('、')}），搜不到也点不准。`,
    });
  }

  // 5) 标题与已发布文章重复
  const normalized = normalizeTitle(title);
  if (normalized) {
    const duplicate = existingTitles.some((item) => {
      const existing = typeof item === 'string' ? item : item && (item.title ?? item.term);
      return normalizeTitle(existing) === normalized;
    });
    if (duplicate) {
      defects.push({
        type: 'soft',
        code: 'duplicate_title',
        label: '标题重复',
        detail: `标题与已有文章重复（归一化后完全一致）：${snippet(title)}，会与站内旧文争夺同一关键词。`,
      });
    }
  }

  return defects;
}

/** 按总分与硬伤数映射等级。 */
function totalToLevel(total, hardCount) {
  if (hardCount > 0) return '不可发布';
  if (total >= LEVEL_THRESHOLDS.excellent) return '优秀';
  if (total >= LEVEL_THRESHOLDS.qualified) return '合格';
  if (total >= LEVEL_THRESHOLDS.revise) return '需修改';
  return '不可发布';
}

/** 汇总改稿建议：先硬伤、再软伤、最后低分维度，去重后最多 6 条。 */
function buildRecommendations({ dimensions, defects }) {
  const recommendations = [];
  const push = (advice) => {
    if (advice && !recommendations.includes(advice)) recommendations.push(advice);
  };

  for (const defect of defects) push(DEFECT_ADVICE[defect.code]);
  for (const dimension of dimensions) {
    if (dimension.score >= 70) continue;
    push(DIMENSION_ADVICE[dimension.key]);
  }

  if (recommendations.length === 0) {
    recommendations.push('七维均无短板、无硬伤，可按计划发布；发布后回填 URL 并做同题复测。');
  }
  return recommendations.slice(0, 6);
}

/**
 * 终审一篇文章（纯函数，不改写入参）。
 *
 * @param {object} [input]
 * @param {string} [input.title] 文章标题
 * @param {string} [input.body] 正文（Markdown 或纯文本）
 * @param {object} [input.brand] 品牌信息（name/legalName/aliases/city/services/industry/differentiators）
 * @param {object} [input.brief] 内容 brief（keywords/term/differentiators）
 * @param {Array<string|{title?:string}>} [input.existingTitles] 已发布标题，用于重复检测
 * @returns {{
 *   total: number,
 *   level: '优秀'|'合格'|'需修改'|'不可发布',
 *   dimensions: Array<{key:string,label:string,weight:number,score:number,reasons:string[]}>,
 *   defects: Array<{type:'hard'|'soft',code:string,label:string,detail:string}>,
 *   hardCount: number,
 *   softCount: number,
 *   risk: 'low'|'medium'|'high',
 *   needsHumanSignoff: boolean,
 *   publishable: boolean,
 *   recommendations: string[]
 * }}
 */
export function reviewArticle({ title = '', body = '', brand = {}, brief = {}, existingTitles = [] } = {}) {
  const safeTitle = asText(title).trim();
  const safeBody = asText(body);
  const safeBrand = brand && typeof brand === 'object' ? brand : {};
  const safeBrief = brief && typeof brief === 'object' ? brief : {};
  const hanCount = countHan(safeBody);
  const keywords = collectKeywords(safeBrief);
  const context = { title: safeTitle, body: safeBody, brand: safeBrand, brief: safeBrief, keywords };

  // 1) 七维得分（顺序固定，便于报告对照）
  const dimensions = REVIEW_DIMENSIONS.map((dimension) => {
    const result = SCORERS[dimension.key](context);
    return {
      key: dimension.key,
      label: dimension.label,
      weight: dimension.weight,
      score: result.score,
      reasons: result.reasons,
    };
  });

  // 2) 总分 = Σ(权重 × 得分) / 100，保留 1 位
  const total = round1(dimensions.reduce((sum, dimension) => sum + dimension.weight * dimension.score, 0) / 100);

  // 3) 硬伤 + 软伤（硬伤永远排在前面）
  const defects = [
    ...findHardDefects({ title: safeTitle, body: safeBody, hanCount }),
    ...findSoftDefects({ title: safeTitle, body: safeBody, keywords, existingTitles: asList(existingTitles) }),
  ];
  const hardCount = defects.filter((defect) => defect.type === 'hard').length;
  const softCount = defects.length - hardCount;

  // 4) 风险与发布闸门
  const risk = hardCount > 0 ? 'high' : total < LEVEL_THRESHOLDS.revise || softCount >= 3 ? 'medium' : 'low';
  const publishable = hardCount === 0 && total >= LEVEL_THRESHOLDS.revise;
  const needsHumanSignoff = risk === 'high';

  return {
    total,
    level: totalToLevel(total, hardCount),
    dimensions,
    defects,
    hardCount,
    softCount,
    risk,
    needsHumanSignoff,
    publishable,
    recommendations: buildRecommendations({ dimensions, defects }),
  };
}

/**
 * 把 review 渲染成 Markdown：终审结论 / 七维得分 / 硬伤 / 软伤 / 建议。
 * 无硬伤、无软伤、无建议时该节正文写「无」。
 *
 * @param {object} review reviewArticle 的返回值
 * @returns {string}
 */
export function renderReviewMarkdown(review) {
  const data = review && typeof review === 'object' ? review : null;
  if (!data) return '暂无审核结果';

  const dimensions = asList(data.dimensions);
  const defects = asList(data.defects);
  const hard = defects.filter((defect) => defect && defect.type === 'hard');
  const soft = defects.filter((defect) => defect && defect.type === 'soft');
  const recommendations = asList(data.recommendations);
  const total = Number(data.total);
  const totalText = Number.isFinite(total) ? total.toFixed(1) : '—';
  const hardCount = Number.isFinite(data.hardCount) ? data.hardCount : hard.length;
  const softCount = Number.isFinite(data.softCount) ? data.softCount : soft.length;
  const riskLabel = RISK_LABELS[data.risk] || '未知';

  const lines = [];

  lines.push('# 文章终审报告');
  lines.push('');
  lines.push('## 终审结论');
  lines.push('');
  lines.push(`- 总分：${totalText} / 100`);
  lines.push(`- 等级：${data.level || '未评级'}`);
  lines.push(`- 风险：${riskLabel}`);
  lines.push(`- 硬伤 ${hardCount} 项 / 软伤 ${softCount} 项`);
  lines.push(`- 可发布：${data.publishable ? '是' : '否'}`);
  lines.push(`- 人工签发：${data.needsHumanSignoff ? '需要（高风险，必须人工复核后签发）' : '不需要'}`);
  lines.push('');

  lines.push('## 七维得分');
  lines.push('');
  lines.push('| 维度 | 权重 | 得分 | 加权贡献 | 主要依据 |');
  lines.push('| --- | ---: | ---: | ---: | --- |');
  for (const dimension of dimensions) {
    const weight = Number(dimension.weight) || 0;
    const score = Number(dimension.score) || 0;
    const contribution = round1((weight * score) / 100);
    const reason = asList(dimension.reasons)[0] || '—';
    lines.push(
      `| ${cell(dimension.label)} | ${weight} | ${score} | ${contribution.toFixed(1)} | ${cell(reason)} |`,
    );
  }
  lines.push(`| **合计** | **100** | — | **${totalText}** | 总分 = Σ（权重 × 得分）/ 100 |`);
  lines.push('');

  lines.push('## 硬伤');
  lines.push('');
  if (hard.length === 0) {
    lines.push('无');
  } else {
    for (const defect of hard) lines.push(`- **${cell(defect.label)}**：${cell(defect.detail)}`);
  }
  lines.push('');

  lines.push('## 软伤');
  lines.push('');
  if (soft.length === 0) {
    lines.push('无');
  } else {
    for (const defect of soft) lines.push(`- **${cell(defect.label)}**：${cell(defect.detail)}`);
  }
  lines.push('');

  lines.push('## 建议');
  lines.push('');
  if (recommendations.length === 0) {
    lines.push('无');
  } else {
    for (const recommendation of recommendations) lines.push(`- ${cell(recommendation)}`);
  }
  lines.push('');

  return lines.join('\n');
}
