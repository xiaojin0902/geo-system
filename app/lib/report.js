/**
 * 诊断报告渲染（content-brief 负责）
 *
 * 一份 Markdown 内容 → 同时产出 Markdown 与自包含 HTML（内联 CSS、零外部资源、无 JS 依赖）。
 * 结构（SPEC §3.8）：demo 横幅 → 一句话结论 → 三层评分 + 覆盖排除说明 → 原话证据
 * → 竞品提及统计 → 机会缺口 → 7 天动作 → 数据说明与免责 → 页脚「恒野 GEO 自研版」。
 *
 * 说明：本实现为自研，只在设计层面参考过通用 GEO 报告结构，未复制任何第三方源码或提示词。
 */

import { analyzeRun, renderInsightsMarkdown } from './analytics.js';
import { buildActionPlan, renderActionPlanMarkdown } from './action-plan.js';

const LAYER_META = [
  { key: 'awareness', label: '品牌认知层', en: 'awareness', weight: 20 },
  { key: 'decision', label: '区域决策层', en: 'decision', weight: 40 },
  { key: 'scenario', label: '场景拓展层', en: 'scenario', weight: 40 },
];

const VERDICT_SCORE = {
  recommended: 1,
  conditionally_recommended: 0.85,
  candidate: 0.55,
  listed: 0.7,
  mentioned: 0.4,
  not_mentioned: 0,
};
const VERDICT_LABEL = {
  recommended: '被推荐',
  conditionally_recommended: '有条件推荐',
  candidate: '列为候选',
  listed: '被列入',
  mentioned: '仅提及',
  not_mentioned: '未提及',
  ambiguous: '归属不确定',
  unknown: '判定不确定',
  refused: '拒答',
  engine_error: '引擎错误',
};
const EXCLUDED_VERDICTS = ['unknown', 'ambiguous', 'refused', 'engine_error'];
const STATUS_LABEL = { ok: '成功', engine_error: '引擎错误', refused: '拒答', unavailable: '不可用' };
const TIER_LABEL = {
  brand_awareness: '品牌认知层',
  regional_industry: '区域决策层',
  super_tier1: '场景拓展层',
};
const TIER_ORDER = ['brand_awareness', 'regional_industry', 'super_tier1'];

/** 展示给用户的统一时区：品牌与客户在国内，报告按北京时间展示 */
export const REPORT_TIME_ZONE = 'Asia/Shanghai';
const ISO_DATETIME_PATTERN = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?';
const LOCAL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/;
const DATE_ONLY_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/g;

function pad2(value) {
  return String(value ?? '0').padStart(2, '0');
}

/**
 * 把 ISO 时间格式化为北京时间 `YYYY-MM-DD HH:mm:ss`（dateOnly 时只返回日期）。
 * 报告页所有展示给用户的时间都必须经过这里，避免出现 UTC 日期。
 */
export function formatLocal(iso, { dateOnly = false } = {}) {
  if (iso === null || iso === undefined || String(iso).trim() === '') return '—';
  const value = String(iso).trim();
  // 已经是本地格式（无时区）时不再转换，避免二次偏移
  if (LOCAL_DATETIME_PATTERN.test(value)) return dateOnly ? value.slice(0, 10) : value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const datePart = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  if (dateOnly) return datePart;
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${datePart} ${pad2(hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
}

/** 从报告 Markdown 的采集时间/首个 ISO 时间里取本地日期，用于校正上游传入的 UTC 日期 */
function reportLocalDate(markdown) {
  const source = String(markdown ?? '');
  // 优先取 ISO 时间戳（兼容旧报告），新报告里采集时间已是本地格式，直接取日期
  const iso = source.match(new RegExp(ISO_DATETIME_PATTERN));
  if (iso) return formatLocal(iso[0], { dateOnly: true });
  const meta = source.match(/采集时间[：:]\s*(\d{4}-\d{2}-\d{2})/);
  return meta ? meta[1] : null;
}

/** 判断一个纯日期是否是「UTC 截断日期」：与本地日期恰好相差一天 */
function isUtcTruncatedDate(token, localDate) {
  const tokenTime = Date.parse(`${token}T00:00:00Z`);
  const localTime = Date.parse(`${localDate}T00:00:00Z`);
  if (!Number.isFinite(tokenTime) || !Number.isFinite(localTime)) return false;
  return Math.abs(tokenTime - localTime) === 86400000;
}

/**
 * 本地化页面副标题里的时间。
 * CLI 会用 ISO.slice(0,10) 生成「DEMO 演示数据 · 2026-10-25」这样的 UTC 日期；
 * 渲染层按报告里的本地日期校正，保证页面所有时间口径一致。
 */
function localizeUserFacingTimes(text, markdown) {
  let out = String(text ?? '');
  out = out.replace(new RegExp(ISO_DATETIME_PATTERN, 'g'), (match) => formatLocal(match));
  const localDate = reportLocalDate(markdown);
  if (localDate) {
    out = out.replace(DATE_ONLY_PATTERN, (token) => {
      if (token === localDate) return token;
      return isUtcTruncatedDate(token, localDate) ? localDate : token;
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(value, max = 160) {
  const chars = Array.from(String(value ?? ''));
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function fmtScore(value) {
  return value == null || Number.isNaN(Number(value)) ? '—' : Number(value).toFixed(1);
}

function fmtPct(ratio) {
  return `${(Number(ratio || 0) * 100).toFixed(1)}%`;
}

function numericOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function cell(value) {
  return String(value ?? '—').replace(/\s+/g, ' ').replace(/\|/g, '/');
}

function normalizeReasons(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item)).filter(Boolean);
      if (typeof parsed === 'string') return [parsed];
    } catch {
      return value.split(/[；;\n]/).map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

function normalizeCitations(value) {
  let list = value;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      if (typeof item === 'string') return { title: item, url: '' };
      if (item && typeof item === 'object') {
        return { title: item.title || item.name || '来源', url: item.url || item.link || '' };
      }
      return null;
    })
    .filter(Boolean);
}

function tierToLayer(tier) {
  if (tier === 'brand_awareness') return 'awareness';
  if (tier === 'super_tier1') return 'scenario';
  return 'decision';
}

function tierLabel(tier) {
  return TIER_LABEL[tier] || '未分层级';
}

/* ------------------------------------------------------------------ */
/* 数据归一化                                                          */
/* ------------------------------------------------------------------ */

function normalizeRow(row = {}) {
  const question = row.question || {};
  const answer = row.answer || {};
  const judgment = row.judgment || {};
  const answerText = answer.answer_text ?? answer.answerText ?? answer.text ?? '';
  const status = answer.status || 'ok';
  const verdict = judgment.verdict
    || (status === 'engine_error' ? 'engine_error' : status === 'refused' ? 'refused' : status === 'unavailable' ? 'engine_error' : 'unknown');
  return {
    questionText: String(question.text || '').trim(),
    intent: question.intent || '',
    tier: question.tier || 'regional_industry',
    priority: question.priority || '',
    engine: answer.engine || '未知引擎',
    status,
    answerText: String(answerText || ''),
    citations: normalizeCitations(answer.citations ?? answer.citations_json),
    verdict,
    matchedText: String(judgment.matched_text ?? judgment.matchedText ?? ''),
    method: judgment.method || '',
    confidence: typeof judgment.confidence === 'number' ? judgment.confidence : null,
    reasons: normalizeReasons(judgment.reasons ?? judgment.reasons_json),
  };
}

function normalizeRows(detail) {
  const rows = Array.isArray(detail?.rows) ? detail.rows : [];
  return rows.map(normalizeRow);
}

/** 兼容 score.js 输出；缺失时从明细行现算，保证报告永远可读 */
function buildScoreView({ score = {}, run = {}, rows = [] }) {
  const layers = score.layers || {};
  const computed = {};
  for (const meta of LAYER_META) {
    const rowsOfLayer = rows.filter((row) => tierToLayer(row.tier) === meta.key);
    const scoredRows = rowsOfLayer.filter((row) => row.status === 'ok' && Object.prototype.hasOwnProperty.call(VERDICT_SCORE, row.verdict));
    const hits = scoredRows.reduce((sum, row) => sum + VERDICT_SCORE[row.verdict], 0);
    const scene = scoredRows.length ? round1((hits / scoredRows.length) * meta.weight) : null;
    computed[meta.key] = { ok: scoredRows.length, total: rowsOfLayer.length, hits: round1(hits), score: scene };
  }
  const view = {};
  for (const meta of LAYER_META) {
    const provided = layers[meta.key] || {};
    view[meta.key] = {
      ...meta,
      ok: numericOr(provided.ok, computed[meta.key].ok),
      total: computed[meta.key].total,
      hits: numericOr(provided.hits, computed[meta.key].hits),
      weighted: numericOr(provided.weighted, computed[meta.key].score),
      score: provided.score === undefined ? computed[meta.key].score : provided.score,
      provided: Boolean(layers[meta.key]),
    };
  }

  const coverage = score.coverage || {};
  const planned = numericOr(coverage.planned, numericOr(run.planned_n, new Set(rows.map((row) => row.questionText)).size));
  const ok = numericOr(coverage.ok, numericOr(run.ok_n, rows.filter((row) => row.status === 'ok').length));
  const ratio = typeof coverage.ratio === 'number' ? coverage.ratio : planned > 0 ? ok / planned : 0;
  let excluded = rows.filter((row) => EXCLUDED_VERDICTS.includes(row.verdict)).length;
  // score.js 里 excluded 是分项计数对象；优先采用它，保证报告口径与落库一致。
  if (typeof coverage.excluded === 'number') excluded = coverage.excluded;
  else if (coverage.excluded && Number.isFinite(coverage.excluded.total)) excluded = coverage.excluded.total;

  return {
    layers: view,
    total: score.total === undefined ? null : score.total,
    level: score.level || (score.total == null ? '样本不足' : '—'),
    coverage: { planned, ok, ratio, excluded },
    reasons: normalizeReasons(score.reasons),
  };
}

/* ------------------------------------------------------------------ */
/* Markdown 报告                                                       */
/* ------------------------------------------------------------------ */

function metaBlock({ brand, run, isDemo, rows }) {
  const engines = [...new Set(rows.map((row) => row.engine).filter(Boolean))];
  const engineSet = run.engine_set || engines.join('、') || '—';
  const lines = [
    `- 运行编号：run-${run.id ?? '—'}`,
    `- 数据类型：${isDemo ? 'demo（演示数据，非真实 AI 回答）' : 'live（真实引擎采集）'}`,
    `- 引擎：${engineSet}`,
    `- 计划样本 / 有效样本：${run.planned_n ?? '—'} / ${run.ok_n ?? '—'}`,
    `- 采集时间：${formatLocal(run.started_at)}${run.finished_at ? ` ～ ${formatLocal(run.finished_at)}` : ''}`,
    `- 运行状态：${run.status || '—'}`,
  ];
  if (brand?.legalName) lines.push(`- 品牌：${brand.name || ''}（${brand.legalName}）`.replace('（）', ''));
  return lines.join('\n');
}

function conclusionBlock({ scoreView, isDemo, brand }) {
  const { total, level, coverage } = scoreView;
  const lines = [];
  if (total == null) {
    lines.push(`**样本不足，暂不出总分。** 有效回答 ${coverage.ok}/${coverage.planned}（覆盖率 ${fmtPct(coverage.ratio)}），需覆盖率 ≥ 50% 且至少两层有有效数据才计总分。`);
  } else {
    lines.push(`**总分 ${fmtScore(total)} / 100，等级「${level}」；有效回答 ${coverage.ok}/${coverage.planned}（覆盖率 ${fmtPct(coverage.ratio)}）。**`);
  }
  const scored = LAYER_META.map((meta) => ({ ...meta, score: scoreView.layers[meta.key].score }))
    .filter((item) => item.score != null);
  if (scored.length >= 2) {
    const sorted = [...scored].sort((a, b) => b.score - a.score || LAYER_META.indexOf(a) - LAYER_META.indexOf(b));
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    lines.push(`- 相对强项：${best.label}（${fmtScore(best.score)} / ${best.weight}）`);
    lines.push(`- 相对短板：${worst.label}（${fmtScore(worst.score)} / ${worst.weight}）`);
  }
  if (isDemo) {
    lines.push('- 本轮是 DEMO 演示：分数与原文都来自 mock 演示引擎，只验证管线与样式，不作为对外结论。');
  }
  if (total == null) {
    lines.push(`- 一句话：本样本不足，暂不能判断「${brand?.name || '该品牌'}」在 AI 里的真实可见性，先补测到覆盖率 50% 以上。`);
  } else {
    const best = scored.length ? [...scored].sort((a, b) => b.score - a.score || LAYER_META.indexOf(a) - LAYER_META.indexOf(b))[0] : null;
    const worst = scored.length ? [...scored].sort((a, b) => a.score - b.score || LAYER_META.indexOf(a) - LAYER_META.indexOf(b))[0] : null;
    const detail = best && worst && best.key !== worst.key
      ? `，相对强项是${best.label}，相对短板是${worst.label}`
      : '';
    lines.push(`- 一句话：在当前样本下，「${brand?.name || '该品牌'}」的 AI 可见性等级为「${level}」（总分 ${fmtScore(total)}/100）${detail}。`);
  }
  return lines.join('\n');
}

function scoreTableBlock(scoreView) {
  const lines = [
    '| 层级 | 权重 | 有效题数 | 命中权重和 | 层得分 |',
    '| --- | --- | --- | --- | --- |',
  ];
  let validTotal = 0;
  let hitTotal = 0;
  for (const meta of LAYER_META) {
    const layer = scoreView.layers[meta.key];
    validTotal += layer.ok;
    hitTotal += layer.hits || 0;
    lines.push(`| ${meta.label}（${meta.en}） | ${meta.weight} | ${layer.ok} | ${fmtScore(layer.hits)} | ${fmtScore(layer.score)} |`);
  }
  lines.push(`| **合计** | 100 | ${validTotal} | ${fmtScore(hitTotal)} | **${scoreView.total == null ? '—' : fmtScore(scoreView.total)}** |`);
  return lines.join('\n');
}

function coverageBlock(scoreView) {
  const { coverage } = scoreView;
  const notTested = Math.max(0, coverage.planned - coverage.ok);
  const lines = [
    `- 采集口径：计划 ${coverage.planned} 题，有效回答 ${coverage.ok} 条，覆盖率 ${fmtPct(coverage.ratio)}；未成功采集 ${notTested} 条。`,
    `- 排除口径：本轮排除 ${coverage.excluded} 条（采集失败/拒答/不可用 + 判定为 unknown / ambiguous / refused / engine_error 的回答）。这些**不进分母**，只计入覆盖率。`,
    '- 计分口径：层得分 = 命中权重和 / 有效题数 × 层权重；覆盖率低于 50% 不出总分。',
    '- 重要提醒：**没测成 ≠ 0 分**。引擎失败、拒答或判定不确定，都不算品牌未被提及。',
  ];
  if (scoreView.reasons.length) {
    lines.push(`- 评分备注：${scoreView.reasons.slice(0, 4).join('；')}`);
  }
  return lines.join('\n');
}

function evidenceBlock(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.questionText || '（题目文本缺失）';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const blocks = [];
  for (const [questionText, items] of groups) {
    const first = items[0];
    blocks.push(`### ${questionText}`);
    const meta = [];
    if (first.intent) meta.push(`意图：${first.intent}`);
    meta.push(`层级：${tierLabel(first.tier)}`);
    if (first.priority) meta.push(`优先级：${first.priority}`);
    blocks.push(`（${meta.join(' · ')}）`);
    const lines = [];
    for (const row of items) {
      const extras = [];
      if (row.method) extras.push(`方法 ${row.method}`);
      if (row.confidence != null) extras.push(`置信 ${row.confidence}`);
      if (row.status !== 'ok') extras.push(`采集状态 ${STATUS_LABEL[row.status] || row.status}`);
      let line = `- **${row.engine}**：判定「${VERDICT_LABEL[row.verdict] || row.verdict}」`;
      if (extras.length) line += `（${extras.join('，')}）`;
      line += '。';
      if (row.status === 'ok') {
        const snippet = truncate(row.answerText.replace(/\s+/g, ' ').trim(), 160);
        line += snippet ? ` 原话节选：「${snippet}」` : ' 无回答正文。';
        if (row.matchedText) line += ` 命中片段：「${truncate(row.matchedText.replace(/\s+/g, ' '), 160)}」`;
        if (row.reasons.length) line += ` 判定说明：${row.reasons.slice(0, 3).join('；')}。`;
        if (row.citations.length) {
          const cites = row.citations.slice(0, 3).map((cite) => `${cite.title || '来源'}（${cite.url || '无链接'}）`);
          line += ` 引用：${cites.join('；')}。`;
        }
      } else {
        line += row.reasons.length ? ` 未产生可用回答：${row.reasons.slice(0, 2).join('；')}。` : ' 未产生可用回答。';
      }
      lines.push(line);
    }
    blocks.push(lines.join('\n'));
  }
  if (blocks.length === 0) blocks.push('本轮没有可展示的采集明细。');
  return blocks.join('\n\n');
}

function competitorStats(brand, rows) {
  const names = (brand?.competitors || []).filter(Boolean);
  return names
    .map((name) => {
      let questionCount = 0;
      let occurrences = 0;
      for (const row of rows) {
        if (row.status !== 'ok' || !row.answerText) continue;
        const hits = row.answerText.split(name).length - 1;
        if (hits > 0) {
          questionCount += 1;
          occurrences += hits;
        }
      }
      return { name, questionCount, occurrences };
    })
    .sort((a, b) => b.occurrences - a.occurrences || b.questionCount - a.questionCount || (a.name < b.name ? -1 : 1));
}

function competitorBlock(brand, rows) {
  const stats = competitorStats(brand, rows);
  if (stats.length === 0) return '品牌配置未登记竞品，本节跳过。';
  const lines = [
    '| 竞品 / 他者 | 被提及题数 | 出现次数 |',
    '| --- | --- | --- |',
    ...stats.map((item) => `| ${cell(item.name)} | ${item.questionCount} | ${item.occurrences} |`),
    '',
    '注：仅按回答原文做字符串扫描，命中不代表 AI 推荐该竞品，也不代表竞品优于本品牌。',
  ];
  return lines.join('\n');
}

function gapSections(rows) {
  const gaps = rows.filter((row) => row.verdict === 'not_mentioned');
  if (gaps.length === 0) return { text: '本轮没有 not_mentioned 的题目：要么均被提及，要么判定落在不确定档（见上方覆盖与排除说明）。', questionCount: 0, groups: [] };

  const groups = new Map();
  for (const tier of TIER_ORDER) groups.set(tier, []);
  for (const row of gaps) {
    const tier = TIER_ORDER.includes(row.tier) ? row.tier : 'regional_industry';
    groups.get(tier).push(row);
  }
  const blocks = [`共 ${gaps.length} 条未提及（题目 × 引擎），涉及 ${new Set(gaps.map((row) => row.questionText)).size} 道题。`];
  for (const tier of TIER_ORDER) {
    const items = groups.get(tier);
    if (!items.length) continue;
    blocks.push(`### ${tierLabel(tier)}（${items.length} 条）`);
    const head = ['| 优先级 | 题目 | 引擎 |', '| --- | --- | --- |'];
    const shown = items.slice(0, 12);
    for (const row of shown) head.push(`| ${cell(row.priority || '—')} | ${cell(row.questionText)} | ${cell(row.engine)} |`);
    blocks.push(head.join('\n'));
    if (items.length > shown.length) blocks.push(`（另有 ${items.length - shown.length} 条未列出，完整明细见数据库 run 记录。）`);
  }
  return { text: blocks.join('\n\n'), questionCount: new Set(gaps.map((row) => row.questionText)).size, groups: [...groups.entries()] };
}

function actionBlock({ brand, run, scoreView, rows, gap, isDemo, competitorStatsResult }) {
  const actions = [];
  if (isDemo) {
    actions.push('本轮 DEMO 结果只用于验收流程与报告样式；用 `--engines live` 复跑同一批问题，拿到真实基线后再对外沟通。');
  }
  if (scoreView.coverage.ratio < 0.5) {
    actions.push(`覆盖率仅 ${fmtPct(scoreView.coverage.ratio)}：先修失败采集（engine_error / refused / 配额与 key），把有效样本补到 50% 以上，再引用分数。`);
  }
  const topGap = gap.groups
    .map(([tier, items]) => ({ tier, count: items.length }))
    .sort((a, b) => b.count - a.count || TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier))[0];
  if (topGap && topGap.count > 0) {
    actions.push(`${tierLabel(topGap.tier)}有 ${topGap.count} 条未提及：先把「${brand?.name || '品牌'}是谁、做什么、在哪、怎么联系」在官网、公众号简介与公开资料页统一成同一版本，再逐题补内容。`);
  }
  const recommendedCount = rows.filter((row) => row.verdict === 'recommended').length;
  if (recommendedCount > 0) {
    actions.push(`本轮出现 ${recommendedCount} 条「被推荐」原话：逐条截图存档并记录引用来源，作为内容与销售的证据素材，7 天后复测同题看是否稳定。`);
  }
  const mentionedCompetitors = (competitorStatsResult || []).filter((item) => item.occurrences > 0);
  if (mentionedCompetitors.length) {
    const names = mentionedCompetitors.map((item) => item.name).join('、');
    actions.push(`回答里出现了竞品 ${names}：做一页「有据可查的差异说明」（只引用公开信息、不贬低对手），7 天后复测同题。`);
  }
  actions.push('按 P0 关键词各产 1 篇 brief（问答/清单优先），发布到官网博客与知乎，发布后回填 URL，7 天后用同一批问题复测归因。');
  const limited = actions.slice(0, 5);
  return limited.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

function dataNotesBlock({ brand, run, scoreView, rows, isDemo }) {
  const engines = [...new Set(rows.map((row) => row.engine).filter(Boolean))];
  const lines = [
    `- 数据来源：${engines.length ? engines.join('、') : run.engine_set || '—'}；运行编号 run-${run.id ?? '—'}；种类 ${run.kind || (isDemo ? 'demo' : 'live')}。`,
    `- 样本口径：计划 ${scoreView.coverage.planned} 题，有效回答 ${scoreView.coverage.ok} 条，覆盖率 ${fmtPct(scoreView.coverage.ratio)}；不确定判定 ${scoreView.coverage.excluded} 条不计入分母。`,
    '- 判定口径：先做确定性匹配（正式名 / 别名 / 否决名），再按上下文判断「推荐 / 列入 / 仅提及」；拿不准记 unknown，绝不折算成未提及。',
    '- 计分口径：三层权重 20 / 40 / 40，层得分 = 命中权重和 / 有效题数 × 层权重；中间量全部落库可复算。',
    '- 波动说明：AI 回答存在随机性与时效性，同一问题在不同时间、不同账号下结果可能不同；单轮样本只代表本次采集时段，不宜外推为长期表现。',
  ];
  if (isDemo) {
    lines.push('- DEMO 声明：本轮由 mock 演示引擎生成，回答带 `[DEMO]` 前缀，引用域名为 example.com，仅用于流程与样式验证，不具备事实效力。');
  } else {
    lines.push('- LIVE 声明：本轮为真实引擎采集，回答原文可能包含第三方内容；引用时请同时核对原始来源与时间。');
  }
  lines.push(`- 免责声明：本报告不构成效果承诺，不承诺被 AI 推荐、排名、涨粉或成单；「${brand?.name || '品牌'}」相关表述以品牌公开资料为准。`);
  return lines.join('\n');
}

/**
 * 生成报告 Markdown。
 * @param {{brand?:object, run?:object, detail?:object, score?:object}} params
 */
export function renderReportMarkdown({ brand = {}, run = {}, detail = {}, score = {} } = {}) {
  const detailBrand = detail && detail.brand ? detail.brand : {};
  const safeBrand = { ...detailBrand, ...brand };
  const isDemo = run.kind === 'demo';
  const rows = normalizeRows(detail);
  const scoreView = buildScoreView({ score, run, rows });
  const gap = gapSections(rows);
  const competitors = competitorStats(safeBrand, rows);
  // 可见度分析：引用源 / 竞品份额 / 曝光质量 / 情感，全部纯规则可复算
  const rawRows = Array.isArray(detail?.rows) ? detail.rows : [];
  const insights = analyzeRun({ brand: safeBrand, rows: rawRows });
  // 行动章节：规则模板生成 Top10 + 30 天计划（无 LLM，可复算）；样本不足时回退到旧版 7 天动作
  const actionPlan = buildActionPlan({
    brand: safeBrand,
    score,
    insights,
    rows: rawRows,
    competitors: insights.sov?.competitors ?? [],
  });
  const blocks = [];

  blocks.push(`# ${safeBrand.name || '品牌'} AI 可见性诊断报告${isDemo ? '（DEMO 演示）' : ''}`);

  if (isDemo) {
    blocks.push([
      '> **⚠️ DEMO 演示数据，非真实 AI 回答**',
      '>',
      '> 本轮使用 mock 演示引擎生成，仅用于验证流水线与报告样式，不得作为对外结论、报价依据或效果证明。',
    ].join('\n'));
  }

  blocks.push(metaBlock({ brand: safeBrand, run, isDemo, rows }));
  blocks.push('## 一、一句话结论');
  blocks.push(conclusionBlock({ scoreView, isDemo, brand: safeBrand }));
  blocks.push('## 二、三层评分与覆盖说明');
  blocks.push(scoreTableBlock(scoreView));
  blocks.push(coverageBlock(scoreView));
  blocks.push('## 三、原话证据（按题目）');
  blocks.push(evidenceBlock(rows));
  blocks.push('## 四、竞品 / 他者提及统计');
  blocks.push(competitorBlock(safeBrand, rows));
  blocks.push('## 五、引用源 · 竞品份额 · 曝光质量');
  blocks.push(renderInsightsMarkdown(insights).join('\n'));
  blocks.push('## 六、机会缺口（未提及题目）');
  blocks.push(gap.text);
  blocks.push('## 七、行动清单（Top10）与 30 天计划');
  blocks.push(
    actionPlan.top10.length
      ? renderActionPlanMarkdown(actionPlan)
      : actionBlock({ brand: safeBrand, run, scoreView, rows, gap, isDemo, competitorStatsResult: competitors }),
  );
  blocks.push('## 八、数据说明与免责声明');
  blocks.push(dataNotesBlock({ brand: safeBrand, run, scoreView, rows, isDemo }));
  blocks.push('---');
  blocks.push('恒野 GEO 自研版');

  return `${blocks.join('\n\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* 极简 Markdown → HTML（只覆盖本模块生成的语法）                       */
/* ------------------------------------------------------------------ */

function renderInline(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 链接只保留可读文本，不输出 <a>（页面保持零外链、零外部资源）
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1（$2）');
  return html;
}

function splitTableRow(line) {
  return String(line)
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((item) => item.trim());
}

function isTableSeparator(line) {
  return /^\|?[\s:|-]*-[\s:|-]*\|?$/.test(String(line).trim()) && String(line).includes('|');
}

function markdownToHtml(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) {
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^-{3,}$/.test(line)) {
      out.push('<hr>');
      i += 1;
      continue;
    }

    if (/^>/.test(line)) {
      const buffer = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buffer.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${markdownToHtml(buffer.join('\n'))}</blockquote>`);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(line);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        body.push(splitTableRow(lines[i]));
        i += 1;
      }
      const headHtml = header.map((item) => `<th>${renderInline(item)}</th>`).join('');
      const bodyHtml = body
        .map((cells) => `<tr>${cells.map((item) => `<td>${renderInline(item)}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<div class="table-wrap"><table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`);
      continue;
    }

    if (/^([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\d+\./.test(line);
      const items = [];
      while (i < lines.length) {
        const item = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!item) break;
        let content = item[2];
        if (/^\[[ xX]\]\s+/.test(content)) content = `☐ ${content.replace(/^\[[ xX]\]\s+/, '')}`;
        items.push(content);
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${tag}>`);
      continue;
    }

    const paragraph = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i].trim();
      if (!next) break;
      if (/^(#{1,6})\s+/.test(next) || /^>/.test(next) || /^([-*+]|\d+\.)\s+/.test(next) || /^-{3,}$/.test(next)) break;
      if (next.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) break;
      paragraph.push(next);
      i += 1;
    }
    out.push(`<p>${renderInline(paragraph.join(''))}</p>`);
  }

  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* HTML 页面                                                           */
/* ------------------------------------------------------------------ */

const BASE_CSS = `
:root{--ink:#1f2428;--muted:#5b6570;--line:#e3e7ec;--bg:#f5f6f8;--card:#ffffff;--accent:#1f6feb;--demo:#c62828;--demo-bg:#fdf1f1}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.78 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif;font-variant-numeric:tabular-nums}
.page{max-width:960px;margin:0 auto;padding:24px 18px 56px}
.doc{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:30px 34px;box-shadow:0 1px 2px rgba(20,30,50,.05)}
.demo-banner{background:var(--demo);color:#fff;border-radius:10px;padding:14px 18px;margin:0 0 18px;font-weight:700;line-height:1.65;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.demo-banner span{display:block;font-weight:400;font-size:14px;opacity:.94;margin-top:3px}
.page-subtitle{color:var(--muted);margin:0 0 12px;font-size:14.5px}
h1{font-size:26px;line-height:1.38;margin:0 0 16px;letter-spacing:.2px}
h2{font-size:20px;margin:34px 0 12px;padding-bottom:8px;border-bottom:2px solid var(--line)}
h3{font-size:17px;margin:24px 0 8px;color:#243040}
p{margin:8px 0;overflow-wrap:anywhere}
ul,ol{margin:8px 0;padding-left:24px}
li{margin:5px 0;overflow-wrap:anywhere}
blockquote{margin:14px 0;padding:12px 16px;background:var(--demo-bg);border-left:4px solid var(--demo);border-radius:0 8px 8px 0;overflow-wrap:anywhere}
blockquote p{margin:4px 0}
hr{border:0;border-top:1px solid var(--line);margin:34px 0 18px}
code{background:#f1f3f5;padding:1px 5px;border-radius:4px;font-size:.92em;overflow-wrap:anywhere}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:14px 0;border-radius:8px}
table{border-collapse:collapse;width:100%;min-width:540px;font-size:14.5px;background:var(--card)}
th,td{border:1px solid var(--line);padding:8px 11px;text-align:left;vertical-align:top}
th{background:#f1f4f8;font-weight:700;white-space:nowrap}
tbody tr:nth-child(even){background:#fafbfc}
.table-wrap td{overflow-wrap:anywhere}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12.5px;font-weight:700;line-height:1.7}
.demo-badge{background:#fde8e8;color:#a51b1b;border:1px solid #f3b9b9}
.live-badge{background:#e8f2fd;color:#12509b;border:1px solid #bcd8f7}
.hint{color:var(--muted);font-size:14px;margin:0 0 16px}
.empty{background:var(--card);border:1px dashed var(--line);border-radius:10px;padding:22px;color:var(--muted);text-align:center}
.site-footer{margin-top:26px;text-align:center;color:var(--muted);font-size:13px}
a{color:var(--accent)}
a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (max-width:640px){
  .page{padding:14px 10px 40px}
  body{font-size:15px}
  .doc{padding:18px 15px;border-radius:10px}
  h1{font-size:21px;margin-bottom:12px}
  h2{font-size:18px;margin-top:26px}
  h3{font-size:16px}
  .demo-banner{font-size:15px;padding:12px 14px}
  th,td{padding:6px 8px;font-size:13.5px}
  table{min-width:460px}
}
@media print{
  body{background:#fff}
  .page{max-width:none;padding:0}
  .doc{border:0;box-shadow:none;padding:0}
  .table-wrap{overflow:visible}
}
`;

const INDEX_CSS = `
${BASE_CSS}
.index-card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:22px 24px;box-shadow:0 1px 2px rgba(20,30,50,.05)}
.index-card h1{margin-top:0}
.index-table td.num{text-align:right;font-variant-numeric:tabular-nums}
.index-table td.nowrap{white-space:nowrap}
@media (max-width:640px){.index-card{padding:16px 14px}}
`;

/** 安全地把 Markdown 包成自包含单文件 HTML（内联 CSS、无 JS、无外链资源） */
export function renderReportHtml(markdown, { title = '恒野 GEO 诊断报告', subtitle = '', demo = false } = {}) {
  const source = String(markdown ?? '');
  const isDemo = demo === true || /DEMO 演示数据/.test(source);
  const banner = isDemo
    ? '<div class="demo-banner" role="alert">DEMO 演示数据，非真实 AI 回答<span>本轮由 mock 演示引擎生成，仅用于验证流水线与报告样式，不得作为对外结论或效果证明。</span></div>'
    : '';
  const subtitleHtml = subtitle ? `<p class="page-subtitle">${escapeHtml(localizeUserFacingTimes(subtitle, source))}</p>` : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="light">
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<main class="page">
${banner}
${subtitleHtml}
<article class="doc">
${markdownToHtml(source)}
</article>
</main>
</body>
</html>
`;
}

/** 运行列表页（自包含 HTML） */
export function renderIndexHtml({ brand = {}, runs = [] } = {}) {
  const list = Array.isArray(runs) ? runs : [];
  const anyDemo = list.some((run) => run && run.kind === 'demo');
  const brandName = brand?.name || '品牌';
  const banner = anyDemo
    ? '<div class="demo-banner" role="alert">存在 DEMO 演示数据，非真实 AI 回答<span>标记 DEMO 的运行只用于流程与样式验收，不得作为对外结论或效果证明。</span></div>'
    : '';
  const rows = list
    .map((run) => {
      const isDemo = run.kind === 'demo';
      const runId = String(run.id ?? '');
      return `<tr>
<td class="nowrap">run-${escapeHtml(runId || '—')}</td>
<td>${isDemo ? '<span class="badge demo-badge">DEMO</span>' : '<span class="badge live-badge">live</span>'}</td>
<td>${escapeHtml(String(run.engine_set || '—'))}</td>
<td class="num">${escapeHtml(String(run.planned_n ?? '—'))}</td>
<td class="num">${escapeHtml(String(run.ok_n ?? '—'))}</td>
<td>${escapeHtml(String(run.status || '—'))}</td>
<td class="nowrap">${escapeHtml(formatLocal(run.started_at))}</td>
<td>${runId ? `<a href="run-${escapeHtml(runId)}.html">查看报告</a>` : '—'}</td>
</tr>`;
    })
    .join('\n');
  const table = list.length
    ? `<div class="table-wrap"><table class="index-table"><thead><tr>
<th>运行</th><th>类型</th><th>引擎</th><th>计划样本</th><th>有效样本</th><th>状态</th><th>开始时间</th><th>报告</th>
</tr></thead><tbody>
${rows}
</tbody></table></div>`
    : `<p class="empty">还没有诊断运行记录。先执行 <code>node bin/geo.js diagnose --brand ${escapeHtml(brand?.slug || 'hengye')} --engines mock --limit 12</code> 跑一轮演示。</p>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="light">
<title>${escapeHtml(`${brandName} · GEO 诊断运行记录`)}</title>
<style>${INDEX_CSS}</style>
</head>
<body>
<main class="page">
${banner}
<section class="index-card">
<h1>${escapeHtml(`${brandName} · GEO 诊断运行记录`)}</h1>
<p class="hint">共 ${list.length} 轮诊断。DEMO 为演示数据，live 为真实引擎采集。</p>
${table}
</section>
<footer class="site-footer">恒野 GEO 自研版</footer>
</main>
</body>
</html>
`;
}
