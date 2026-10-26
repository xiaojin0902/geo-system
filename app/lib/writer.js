import { systemName } from './branding.js';
/**
 * 内容生成 + 事实核查（Phase 3，SPEC §3.10；content-brief 负责）
 *
 * 设计原则（与 SPEC §0 红线一致）：
 * - 证据优先：写作只能使用 brief.mustIncludeFacts 里的事实，没有依据的数字/案例/资质一律不写；
 * - 无 Key 也能跑通：engine 为 null / 不可用 / 调用失败时回退「模板骨架」，不抛异常；
 * - 生成结果必须过 factCheckDraft，违规交给 CLI 标记 needs_review。
 *
 * 导出（签名严格按 SPEC §3.10，不要改）：
 *   buildWritingPrompt({brand, brief, question}) -> {system, user}
 *   factCheckDraft({text, brief, brand}) -> {passed, wordCount, violations:[{type, detail, snippet}]}
 *   async generateDraft({brand, brief, question, engine = null}) -> {text, mode:'llm'|'template', engineId, warnings}
 *
 * 本文件为自研实现，提示词为本项目自写，不复制任何第三方提示词原文。
 */

const DEFAULT_ABSOLUTE = [
  '最好',
  '第一',
  '唯一',
  '顶级',
  '保证',
  '100%',
  '稳赚',
  '绝对',
  '最强',
  '最低价',
  '零风险',
  '包涨粉',
  '包成交',
];

/** 绝对化/承诺类用语规则：label 用于报告，source 用正则源码（每次新建，避免 /g 状态污染） */
const ABSOLUTE_RULES = [
  { label: '最好', source: '(?<![不非])最好', flags: 'g' },
  { label: '第一', source: '(?<![不非])第一(?!次|步|时间|天|年|月|季|批|条|篇|阶段|个)', flags: 'g' },
  { label: '唯一', source: '(?<![不非])唯一', flags: 'g' },
  { label: '顶级', source: '顶级', flags: 'g' },
  { label: '保证', source: '(?<![不无没])保证', flags: 'g' },
  { label: '100%', source: '100\\s*%', flags: 'g' },
  { label: '稳赚', source: '稳赚', flags: 'g' },
  { label: '绝对', source: '绝对', flags: 'g' },
  { label: '最强', source: '(?<![不非])最强', flags: 'g' },
  { label: '最低价', source: '最低价', flags: 'g' },
  { label: '零风险', source: '零风险', flags: 'g' },
  { label: '包涨粉', source: '包涨粉', flags: 'g' },
  { label: '包成交', source: '包成交', flags: 'g' },
];

/** 段落里的「数字 + 单位」：元/月/天/条/篇/倍/% 等 */
const NUMBER_UNIT_SOURCE = '(\\d[\\d,]*(?:\\.\\d+)?)\\s*(元|月|天|条|篇|倍|%|年|周|小时|分钟|次|人|家|个|万)';

/** 段内出处标记：命中任一即认为该段数字有出处（元/月 这类价格本身也可能来自 evidenceFacts） */
const SOURCE_MARKER_RE = /来源|引用|据|官网|公开|价格表|品牌自述|统计口径|出处|引自|详见|资料|https?:\/\//;

/** 案例式表述（无授权标记即视为编造风险） */
const CASE_RULES = [
  { label: '我们的客户/学员', source: '(?:我们|我司|本公司)(?:的)?(?:客户|学员|商家)' },
  { label: '某客户/某商家', source: '(?:某|一位|有个|这个)(?:客户|商家|学员)' },
  { label: '客户案例/成功案例', source: '(?:客户|成功|真实|服务)案例' },
  { label: '帮助 XX 做到', source: '帮助[^。！？\\n]{1,20}(?:做到|实现|涨粉|成单|成交|翻倍|提升)' },
  { label: '服务过 N 家', source: '服务(?:过|了)\\s*\\d+\\s*(?:家|个|位)' },
];

const CASE_AUTH_RE = /(?:已获|获得|经)(?:客户)?(?:书面)?授权|客户同意|授权发布|脱敏处理|案例来源|可核验/;
const CASE_NEGATION_RE = /没有(?:客户)?案例|不写(?:客户)?案例|不做(?:客户)?案例|无(?:客户)?案例/;

function safeString(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function arrayOf(value) {
  return Array.isArray(value) ? value.filter((item) => item != null) : [];
}

/** 非空白字符数（中文按字计；Markdown 标记也计入，作为粗略字数） */
function countWordLike(text) {
  return Array.from(safeString(text).replace(/\s+/g, '')).length;
}

function snippetAround(text, index, length, radius = 18) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}

/** 归一化数字：去掉千分位逗号 */
function normalizeNumber(value) {
  return safeString(value).replace(/,/g, '').trim();
}

/** 收集「有出处」的数字：只来自 brief.mustIncludeFacts 与品牌可核验字段，不含 outline 的说明性数字 */
function collectSourcedNumbers(brief, brand) {
  const sources = [];
  sources.push(...arrayOf(brief?.mustIncludeFacts).map(safeString));
  const b = brand || {};
  sources.push(...arrayOf(b.evidenceFacts).map(safeString));
  if (b.priceRange) sources.push(safeString(b.priceRange));
  if (b.contact && typeof b.contact === 'object') {
    sources.push(...Object.values(b.contact).map(safeString));
  }
  const set = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/\d[\d,]*/g)) set.add(normalizeNumber(match[0]));
  }
  return set;
}

function scanBannedWords(text, bannedWords) {
  const violations = [];
  for (const word of arrayOf(bannedWords).map(safeString).filter(Boolean)) {
    const index = text.indexOf(word);
    if (index === -1) continue;
    violations.push({
      type: 'banned_word',
      detail: `命中品牌禁用词「${word}」`,
      snippet: snippetAround(text, index, word.length),
    });
  }
  return violations;
}

function scanAbsolute(text) {
  const violations = [];
  for (const rule of ABSOLUTE_RULES) {
    const regex = new RegExp(rule.source, rule.flags);
    const match = regex.exec(text);
    if (!match) continue;
    violations.push({
      type: 'absolute',
      detail: `命中绝对化/承诺用语「${rule.label}」`,
      snippet: snippetAround(text, match.index, match[0].length),
    });
  }
  return violations;
}

/** 按空行切段；标题行不参与数字扫描（结构标题不是事实陈述） */
function splitParagraphs(text) {
  return safeString(text)
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function scanUnsourcedNumbers(text, sourcedNumbers) {
  const violations = [];
  for (const paragraph of splitParagraphs(text)) {
    if (/^\s*#{1,6}\s/.test(paragraph)) continue;
    if (SOURCE_MARKER_RE.test(paragraph)) continue;
    const tokens = [];
    const regex = new RegExp(NUMBER_UNIT_SOURCE, 'g');
    for (const match of paragraph.matchAll(regex)) {
      const normalized = normalizeNumber(match[1]);
      if (sourcedNumbers.has(normalized)) continue;
      const token = `${match[1]} ${match[2]}`.replace(/\s+/g, ' ');
      if (!tokens.includes(token)) tokens.push(token);
    }
    if (!tokens.length) continue;
    violations.push({
      type: 'unsourced_number',
      detail: `段落出现数字（${tokens.join('、')}）但同段没有来源标记，也不是 brief 里已给出的事实`,
      snippet: `${paragraph.slice(0, 80)}${paragraph.length > 80 ? '…' : ''}`.replace(/\s+/g, ' '),
    });
  }
  return violations;
}

function scanFabricatedCases(text) {
  const violations = [];
  for (const paragraph of splitParagraphs(text)) {
    if (CASE_AUTH_RE.test(paragraph) || CASE_NEGATION_RE.test(paragraph)) continue;
    for (const rule of CASE_RULES) {
      const match = new RegExp(rule.source).exec(paragraph);
      if (!match) continue;
      violations.push({
        type: 'fabricated_case',
        detail: `出现案例式表述「${rule.label}」但没有授权/可核验标记`,
        snippet: snippetAround(paragraph, match.index, match[0].length, 14),
      });
    }
  }
  return violations;
}

/**
 * 事实核查：四类违规（banned_word / absolute / unsourced_number / fabricated_case）。
 * @param {{text?:string, brief?:object, brand?:object}} params
 * @returns {{passed:boolean, wordCount:number, violations:Array<{type:string,detail:string,snippet:string}>}}
 */
export function factCheckDraft({ text = '', brief = {}, brand = {} } = {}) {
  const body = safeString(text);
  const violations = [];
  const bannedWords = arrayOf(brand?.contentRules?.bannedWords);

  violations.push(...scanBannedWords(body, bannedWords));
  violations.push(...scanAbsolute(body));
  violations.push(...scanUnsourcedNumbers(body, collectSourcedNumbers(brief, brand)));
  violations.push(...scanFabricatedCases(body));

  return {
    passed: violations.length === 0,
    wordCount: countWordLike(body),
    violations,
  };
}

/* ------------------------------------------------------------------ */
/* 写作指令                                                            */
/* ------------------------------------------------------------------ */

function questionTextOf(question) {
  if (typeof question === 'string') return question.trim();
  if (question && typeof question === 'object') return safeString(question.text ?? question.question).trim();
  return '';
}

/**
 * 拼写作指令：system = 角色与红线；user = 目标问题 + 事实 + 证据要求 + 禁用词 + 大纲 + 输出要求。
 * @param {{brand?:object, brief?:object, question?:object|string}} params
 * @returns {{system:string, user:string}}
 */
export function buildWritingPrompt({ brand = {}, brief = {}, question = null } = {}) {
  const b = brand || {};
  const targetQuestion = questionTextOf(question) || safeString(brief?.targetQuestion);
  const facts = arrayOf(brief?.mustIncludeFacts).map(safeString);
  const requirements = arrayOf(brief?.evidenceRequirements).map(safeString);
  const checks = arrayOf(brief?.factCheckList).map(safeString);
  const banned = [...new Set([...DEFAULT_ABSOLUTE, ...arrayOf(brief?.banned).map(safeString)])];
  const outline = arrayOf(brief?.outline);
  const title = safeString(brief?.title) || `${b.name || '品牌'}内容草稿`;

  const system = [
    `你是「${systemName()}」内容团队的中文写作助手，负责把给定事实写成可被 AI 搜索引用的问答/指南类文章。`,
    '硬性规则：',
    '1. 只能使用【必须引用的可验证事实】里的事实；没有依据的数字、客户案例、资质、排名一律不写，改写成方法描述或标注「待补充可验证事实」。',
    `2. 全文禁止出现绝对化/承诺类用语：${banned.join('、')}。`,
    '3. 每个 H2 小节末尾标注本节来源，例如「（来源：品牌官网）」「（品牌自述）」；无法核验就写「（待补充可验证事实）」。',
    '4. 只输出 Markdown 正文，不要出现「作为一个 AI」「以下是」「希望本文」等元话语，不要解释写作过程。',
    '5. 不承诺效果（不承诺涨粉、成单、排名或被 AI 推荐），只描述可交付的内容与流程。',
  ].join('\n');

  const userLines = [];
  userLines.push(`【品牌】${b.name || '品牌'}${b.legalName ? `（${b.legalName}）` : ''}${b.city ? ` · 所在地：${b.city}` : ''}`);
  userLines.push(`【目标问题】${targetQuestion || '（未提供）'}`);
  userLines.push(`【文章标题】${title}`);
  if (brief?.searchIntent) userLines.push(`【搜索意图】${safeString(brief.searchIntent)}`);
  if (brief?.format) userLines.push(`【建议形态】${safeString(brief.format)}`);
  userLines.push('');
  userLines.push('【必须引用的可验证事实】（只能引用这些，不要改写数字）');
  if (facts.length) {
    facts.forEach((fact, index) => userLines.push(`${index + 1}. ${fact}`));
  } else {
    userLines.push('（暂无可用事实：正文只写方法/流程，出现待补充的地方写「待补充可验证事实」。）');
  }
  userLines.push('');
  userLines.push('【文章结构（必须覆盖以下 H2，顺序可微调）】');
  if (outline.length) {
    for (const section of outline) {
      const h2 = safeString(section?.h2) || '未命名小节';
      userLines.push(`## ${h2}`);
      for (const point of arrayOf(section?.points).map(safeString).filter(Boolean)) {
        userLines.push(`- ${point}`);
      }
    }
  } else {
    userLines.push('（未提供 outline：按「结论 → 判断标准 → 品牌可核验信息 → 证据与来源」组织。）');
  }
  userLines.push('');
  userLines.push('【证据要求】');
  for (const requirement of requirements) userLines.push(`- ${requirement}`);
  userLines.push('');
  userLines.push('【禁用词】');
  userLines.push(banned.join('、'));
  userLines.push('');
  if (checks.length) {
    userLines.push('【发布前核查】');
    for (const check of checks) userLines.push(`- ${check}`);
    userLines.push('');
  }
  userLines.push('【输出要求】');
  userLines.push('- 输出 Markdown 正文：一个 H1 标题 + 上述 H2 小节。');
  userLines.push('- 每个 H2 下写 2-4 段，句子短、可核对；每节末尾标注来源。');
  userLines.push('- 不使用 emoji，不写「作为一个 AI」，不写无法核验的数字、案例、资质、排名。');
  userLines.push('- 事实不足时写「待补充可验证事实」，不要编造。');

  return { system, user: userLines.join('\n') };
}

/* ------------------------------------------------------------------ */
/* 草稿生成                                                            */
/* ------------------------------------------------------------------ */

/** 判断某个 outline 小节是否是「证据与来源」小节 */
function isEvidenceSection(h2) {
  const text = safeString(h2);
  return (text.includes('证据') || text.includes('事实')) && text.includes('来源');
}

/** outline 要点里如果带阿拉伯数字或禁用/绝对化用语，就不放进模板骨架，保证模板模式 0 违规 */
function isSafeOutlinePoint(point) {
  const text = safeString(point);
  if (!text.trim()) return false;
  if (/\d/.test(text)) return false;
  const bannedHit = scanBannedWords(text, DEFAULT_ABSOLUTE);
  const absoluteHit = scanAbsolute(text);
  return bannedHit.length === 0 && absoluteHit.length === 0;
}

/** 文本里是否含品牌禁用词或绝对化用语（用于模板标题兜底） */
function hasForbiddenWording(text, brand) {
  const banned = [
    ...arrayOf(brand?.contentRules?.bannedWords).map(safeString),
    ...DEFAULT_ABSOLUTE,
  ];
  return scanBannedWords(text, banned).length > 0 || scanAbsolute(text).length > 0;
}

/**
 * 模板标题：brief.title 可能原样带着用户问题里的「保证/第一」等表述，
 * 模板骨架不能把这类表述当成自己的标题，改用中性标题，正式标题交给编辑调整。
 */
function templateTitle(brief, brand) {
  const raw = safeString(brief?.title);
  const fallback = `${brand?.name || '品牌'}内容草稿`;
  if (!raw) return fallback;
  return hasForbiddenWording(raw, brand) ? `${fallback}（主题见内容 brief）` : raw;
}

/**
 * 模板模式：按 brief.outline 生成 Markdown 骨架。
 * 只使用 brief 已有字段，不生成任何具体数字/客户/资质。
 */
function buildTemplateDraft({ brand = {}, brief = {} } = {}) {
  const b = brand || {};
  const title = templateTitle(brief, b);
  const facts = arrayOf(brief?.mustIncludeFacts).map(safeString);
  const outline = arrayOf(brief?.outline)
    .filter((section) => section && safeString(section.h2))
    .map((section) => ({ h2: safeString(section.h2), points: arrayOf(section.points) }));
  const sections = outline.length
    ? outline
    : [
        { h2: '先给结论', points: [] },
        { h2: '证据与来源', points: [] },
      ];

  const lines = [
    `# ${title}`,
    '',
    '> 模板模式：当前未接入写作引擎，本稿是按内容 brief 生成的结构骨架。所有「（待补）」段落必须人工补写；事实统一列在「事实与来源」小节，没有来源的数字、案例、资质一律不写。',
    '',
  ];

  let factsWritten = false;
  for (const section of sections) {
    lines.push(`## ${section.h2}`, '');
    if (isEvidenceSection(section.h2)) {
      factsWritten = true;
      lines.push('（待补：逐条核对下列事实，并在正文标注每处引用。）', '');
      if (facts.length) {
        lines.push('以下事实原样引用自内容 brief：', '');
        for (const fact of facts) lines.push(`- ${fact}`);
      } else {
        lines.push('- 待补充可验证事实：本主题暂无可用事实来源。');
      }
      lines.push('');
    } else {
      lines.push(`（待补：围绕「${section.h2}」补写正文段落，只使用「事实与来源」小节里的事实。）`, '');
    }
    const safePoints = section.points.filter(isSafeOutlinePoint);
    if (safePoints.length) {
      lines.push('本节要点：', '');
      for (const point of safePoints) lines.push(`- ${point}`);
      lines.push('');
    }
  }

  if (!factsWritten) {
    lines.push('## 事实与来源', '');
    if (facts.length) {
      lines.push('以下事实原样引用自内容 brief：', '');
      for (const fact of facts) lines.push(`- ${fact}`);
    } else {
      lines.push('- 待补充可验证事实：本主题暂无可用事实来源。');
    }
    lines.push('');
  }

  return `${lines.join('\n').trim()}\n`;
}

/** 清理 LLM 输出里的元话语（「作为一个 AI」「以下是…」「希望本文…」）与代码围栏 */
function stripMetaTalk(raw) {
  const source = safeString(raw).trim();
  if (!source) return { text: '', changed: false };
  let text = source;
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(text);
  if (fenced) text = fenced[1].trim();
  const original = text;

  const metaLine = /^(?:作为(?:一个)?\s*(?:AI|人工智能|语言模型|大模型)[^。！？\n]*[。！？]?|以下是(?:我|根据)[^。！？\n]*(?:：|。)?|希望(?:这|本)篇[^。！？\n]*[。！？]?)$/;
  text = text
    .split('\n')
    .filter((line) => !metaLine.test(line.trim()))
    .join('\n')
    .trim();
  // 行内元话语（可能出现在段落开头/中间）：整句删掉
  text = text
    .replace(/作为(?:一个)?\s*(?:AI|人工智能|语言模型|大模型)[^。！？\n]*[。！？]?/g, '')
    .replace(/^\s+/, '')
    .trim();
  return { text, changed: text !== original };
}

function outlineOf(brief) {
  return arrayOf(brief?.outline)
    .map((section) => safeString(section?.h2))
    .filter(Boolean);
}

/**
 * 生成草稿。
 * - engine 为 null / 不可用 / 调用失败 → 模板骨架（mode='template'），不抛异常；
 * - engine 可用 → 写作指令 → engine.ask(prompt, {brand, timeoutMs}) → 清理元话语（mode='llm'）。
 * 无论哪种模式都会跑一次 factCheckDraft，违规只写进 warnings，最终状态由 CLI 决定。
 */
export async function generateDraft({ brand = {}, brief = {}, question = null, engine = null } = {}) {
  const b = brand || {};
  const warnings = [];
  const engineId = engine && typeof engine === 'object' && engine.id != null ? String(engine.id) : null;

  const finish = (text, mode) => {
    const check = factCheckDraft({ text, brief, brand: b });
    if (check.violations.length > 0) {
      const types = [...new Set(check.violations.map((item) => item.type))].join('、');
      warnings.push(`事实核查发现 ${check.violations.length} 条违规（${types}），落库前必须人工复核。`);
    }
    return { text, mode, engineId, warnings };
  };

  const template = (reason) => {
    if (reason) warnings.push(reason);
    const rawTitle = safeString(brief?.title);
    if (rawTitle && hasForbiddenWording(rawTitle, b)) {
      warnings.push('内容标题含绝对化/禁用词（如「保证」「第一」），模板已改用中性标题，正式标题请人工调整。');
    }
    return finish(buildTemplateDraft({ brand: b, brief }), 'template');
  };

  if (!engine || typeof engine.ask !== 'function') {
    return template(
      engine
        ? '写作引擎缺少 ask() 方法，已回退模板骨架。'
        : '未提供写作引擎（无 API Key 时属预期行为），使用模板骨架。',
    );
  }
  if (engineId === 'mock') {
    warnings.push('当前写作引擎为 mock 演示引擎，输出只用于流程验证，不是真实成稿。');
  }

  const prompt = buildWritingPrompt({ brand: b, brief, question });
  const askInput = `${prompt.system}\n\n${prompt.user}`;

  let result;
  try {
    result = await engine.ask(askInput, { brand: b, timeoutMs: 120_000 });
  } catch (error) {
    return template(`写作引擎 ${engineId || 'unknown'} 调用失败：${error?.message || String(error)}；已回退模板骨架。`);
  }

  // 兼容 engine.ask 直接返回字符串的实现
  const payload = typeof result === 'string' ? { text: result, status: 'ok' } : result || {};
  const status = payload.status == null ? 'ok' : String(payload.status);
  const rawText = safeString(payload.text);

  if (status !== 'ok' || !rawText.trim()) {
    const reason = payload.error
      || (status === 'unavailable' ? '引擎不可用（可能未配置 API Key）' : `引擎状态 ${status}，未产出可用文本`);
    return template(`写作引擎 ${engineId || 'unknown'} 未产出可用文本：${reason}；已回退模板骨架。`);
  }

  const stripped = stripMetaTalk(rawText);
  if (stripped.changed) warnings.push('已清理 LLM 输出中的元话语（如「作为一个 AI」「以下是」）。');
  if (!stripped.text.trim()) {
    return template('清理元话语后正文为空，已回退模板骨架。');
  }

  const text = `${stripped.text.trim()}\n`;
  const expected = outlineOf(brief);
  const missing = expected.filter((h2) => !text.includes(h2));
  if (missing.length) {
    warnings.push(`LLM 草稿缺少小节：${missing.map((h2) => `「${h2}」`).join('、')}，请人工补齐。`);
  }
  if (!/^#{1,6}\s/m.test(text)) {
    warnings.push('LLM 输出缺少 Markdown 标题结构，请人工检查。');
  }

  return finish(text, 'llm');
}
