/**
 * lib/weekly.js
 * 客户周报：把「最近一轮 + 上一轮」的可见度数据整理成一份可以直接发给客户的周报。
 *
 * 设计红线：
 *   · 纯函数、确定性：同输入必须得到同输出（生成时间可由调用方固定）；
 *   · 零依赖、不联网、不读写数据库：只消费调用方传入的 brand / runs / insights / previous / plan；
 *   · 不编数据：没有对比就写「首轮基线」，没有变化就不假装有变化；
 *   · 对外可读：Markdown 给客户直接粘贴，HTML 自包含（内联样式）可直接发邮件。
 *
 * 数据口径与 lib/analytics.js 保持一致：
 *   · 提及率、自有引用占比都是 0~1 的比率，展示时转百分比；
 *   · 比率变化用百分点（pt），综合分变化用分；
 *   · previous 缺失或上期为 0 时，delta 一律为 null，避免「增长 100%」这类夸大。
 */

const ASIA_TIME_ZONE = 'Asia/Shanghai';
const DAY_MS = 86400000;
const MAX_HIGHLIGHTS = 6;
const MIN_HIGHLIGHTS = 3;
const MAX_ACTIONS = 5;
const MAX_CITATION_TOP = 5;
const MAX_COMPETITORS = 5;

/** 亮点类型 → 中文标签 */
const HIGHLIGHT_LABEL = Object.freeze({
  up: '上升',
  down: '下降',
  flat: '持平',
  risk: '风险',
});

/** 采集类型 → 中文标签（未知类型原样展示，不猜测） */
const KIND_LABEL = Object.freeze({
  live: '真实采集',
  mock: '演示数据',
  demo: '演示数据',
});

/** 判断值是否可以转成有限数字；空串、null、NaN 一律视为缺失 */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/** 四舍五入到指定小数位；顺手把 -0 归一成 0，避免 JSON 里出现 -0 */
function round(value, digits = 1) {
  const factor = 10 ** digits;
  const num = Math.round((Number(value) + Number.EPSILON) * factor) / factor;
  return Object.is(num, -0) ? 0 : num;
}

function pad2(value) {
  return String(value ?? '0').padStart(2, '0');
}

/** 归一成可展示的纯日期 YYYY-MM-DD；非法输入返回 null */
function normalizeDay(value) {
  const text = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
    const parsed = Date.parse(`${text}T00:00:00Z`);
    return Number.isFinite(parsed) ? text : null;
  }
  return localDateOf(text);
}

/** ISO 时间 → 北京时间日期（YYYY-MM-DD）；非法输入返回 null */
function localDateOf(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  const parts = {};
  for (const part of new Intl.DateTimeFormat('en-CA', {
    timeZone: ASIA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/** 纯日期加减天数（按 UTC 计算，避免夏令时影响） */
function addDays(day, days) {
  const base = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(base)) return day;
  const next = new Date(base + days * DAY_MS);
  return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`;
}

/** 日期 → MM-DD（用于「10-30 前完成」这类短句） */
function shortDay(day) {
  return /^\d{4}-\d{2}-\d{2}$/u.test(String(day ?? '')) ? String(day).slice(5) : String(day ?? '');
}

/** 0~1 比率 → 百分比文本，整数不带小数（25%、41.7%） */
function formatPercent(ratio) {
  const num = toNumber(ratio);
  if (num === null) return '—';
  const value = round(num * 100, 1);
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

/** 变化值 → 带符号文本；单位可以是 pt / 分 / 条 */
function formatDelta(delta, unit) {
  const num = toNumber(delta);
  if (num === null) return '—';
  const value = round(num, 1);
  const body = Number.isInteger(value) ? String(value) : value.toFixed(1);
  if (value > 0) return `+${body}${unit}`;
  return `${body}${unit}`;
}

/** 综合分展示 */
function formatScore(score) {
  const num = toNumber(score);
  return num === null ? '—' : `${round(num, 1)} 分`;
}

/** 文本归一：去首尾空白，非字符串返回空串 */
function textOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 生成时间归一为 ISO 字符串；非法输入回落到当前时间 */
function normalizeGeneratedAt(value) {
  const text = textOf(value);
  if (!text) return new Date().toISOString();
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

/** 按 startedAt 倒序（不修改入参）；时间相同或缺时间时保持原顺序 */
function orderRuns(runs) {
  const list = (Array.isArray(runs) ? runs : []).filter((item) => item && typeof item === 'object');
  return list
    .map((run, index) => ({ run, index }))
    .sort((a, b) => {
      const timeA = Date.parse(String(a.run.startedAt ?? ''));
      const timeB = Date.parse(String(b.run.startedAt ?? ''));
      const validA = Number.isFinite(timeA);
      const validB = Number.isFinite(timeB);
      if (validA && validB && timeA !== timeB) return timeB - timeA;
      if (validA !== validB) return validB ? 1 : -1;
      return a.index - b.index;
    })
    .map((entry) => entry.run);
}

/** 读取综合分：支持 insights.score.total / insights.score / run.total */
function readScore(source) {
  if (source === null || source === undefined) return null;
  if (typeof source !== 'object') return toNumber(source);
  return toNumber(source.score?.total) ?? toNumber(source.score) ?? toNumber(source.total);
}

/** 读取提及率；缺 mentionRate 时用 mentioned / ok 兜底 */
function readMentionRate(insights) {
  const direct = toNumber(insights?.sample?.mentionRate);
  if (direct !== null) return direct;
  const mentioned = toNumber(insights?.sample?.mentioned);
  const ok = toNumber(insights?.sample?.ok);
  if (mentioned !== null && ok !== null && ok > 0) return mentioned / ok;
  return null;
}

/** 读取引用总数；缺 total 时用 byDomain 的 count 求和兜底 */
function readCitationTotal(insights) {
  const total = toNumber(insights?.citations?.total);
  if (total !== null) return total;
  if (Array.isArray(insights?.citations?.byDomain)) {
    const sum = insights.citations.byDomain.reduce((acc, item) => acc + (toNumber(item?.count) ?? 0), 0);
    return sum;
  }
  return null;
}

/** 解析统计周期：显式传入优先，否则取最近一轮所在日期往前 7 天 */
function resolvePeriod(period, orderedRuns) {
  const explicitFrom = normalizeDay(period?.from);
  const explicitTo = normalizeDay(period?.to);
  const latestRunDay = orderedRuns
    .map((run) => localDateOf(run?.startedAt))
    .find((day) => Boolean(day)) ?? null;
  const to = explicitTo ?? latestRunDay ?? localDateOf(new Date().toISOString());
  const from = explicitFrom ?? addDays(to, -6);
  return { from, to };
}

/** 多引擎覆盖：保留契约里的三个字段，按回答数降序 */
function buildChannels(insights) {
  const engines = Array.isArray(insights?.engines) ? insights.engines : [];
  return engines
    .filter((item) => item && textOf(item.engine))
    .map((item) => ({
      engine: textOf(item.engine),
      answers: toNumber(item.answers) ?? toNumber(item.ok) ?? 0,
      mentionRate: toNumber(item.mentionRate) ?? 0,
    }))
    .sort((a, b) => b.answers - a.answers || a.engine.localeCompare(b.engine, 'zh-Hans-CN'))
    .slice(0, 10);
}

/** 引用源 Top5：先按份额、再按次数、最后按域名排序，保证确定性 */
function buildCitationTop(insights) {
  const byDomain = Array.isArray(insights?.citations?.byDomain) ? insights.citations.byDomain : [];
  const total = readCitationTotal(insights) ?? 0;
  return byDomain
    .filter((item) => item && textOf(item.domain))
    .map((item) => {
      const count = toNumber(item.count) ?? 0;
      const share = toNumber(item.share) ?? (total > 0 ? count / total : 0);
      return {
        domain: textOf(item.domain),
        typeLabel: textOf(item.typeLabel) || '其他',
        share,
      };
    })
    .sort((a, b) => b.share - a.share || a.domain.localeCompare(b.domain, 'zh-Hans-CN'))
    .slice(0, MAX_CITATION_TOP);
}

/** 竞品份额（含本品牌）：按份额降序，Top5 */
function buildCompetitorShare(insights, brandName) {
  const sov = insights?.sov;
  if (!sov || typeof sov !== 'object') return [];
  const rows = [];
  const brandShare = toNumber(sov.brandShare);
  if (brandShare !== null) rows.push({ name: brandName || '本品牌', share: brandShare });
  const competitors = Array.isArray(sov.competitors) ? sov.competitors : [];
  for (const item of competitors) {
    const name = textOf(item?.name);
    const share = toNumber(item?.share);
    // 竞品列表里出现同品牌自己时跳过，避免「本品牌」出现两行
    if (!name || share === null || name === (brandName || '本品牌')) continue;
    rows.push({ name, share });
  }
  return rows
    .sort((a, b) => b.share - a.share || a.name.localeCompare(b.name, 'zh-Hans-CN'))
    .slice(0, MAX_COMPETITORS);
}

/** 生成 headline：必须来自真实 delta，没有对比就明确写「首轮基线」 */
function buildHeadline({
  scoreNow,
  scorePrev,
  scoreDelta,
  mentionNow,
  mentionPrev,
  mentionDelta,
  ownShareNow,
  ownSharePrev,
}) {
  const hasMentionCompare = mentionNow !== null && mentionPrev !== null;
  const hasScoreCompare = scoreNow !== null && scorePrev !== null;
  if (!hasMentionCompare && !hasScoreCompare) return '首轮基线，暂无对比';

  // 自有站点引用是客户最关心的第二条信息，能拿到就挂在结论后面
  let ownClause = '';
  if (ownShareNow !== null) {
    if (ownShareNow === 0) {
      ownClause = '，自有站点引用仍是 0';
    } else if (ownSharePrev === 0) {
      ownClause = `，自有站点引用从 0 升至 ${formatPercent(ownShareNow)}`;
    } else {
      ownClause = `，自有站点引用 ${formatPercent(ownShareNow)}`;
    }
  }

  if (hasMentionCompare) {
    if (mentionPrev === 0) {
      return `AI 提及率从 0% 升至 ${formatPercent(mentionNow)}${ownClause}`;
    }
    if (mentionDelta !== null && mentionDelta >= 1) {
      return `AI 提及率 ${formatPercent(mentionPrev)} → ${formatPercent(mentionNow)}，上升 ${Math.abs(mentionDelta)}pt${ownClause}`;
    }
    if (mentionDelta !== null && mentionDelta <= -1) {
      return `AI 提及率 ${formatPercent(mentionPrev)} → ${formatPercent(mentionNow)}，下降 ${Math.abs(mentionDelta)}pt${ownClause}`;
    }
    return `AI 提及率 ${formatPercent(mentionPrev)} → ${formatPercent(mentionNow)}，基本持平${ownClause}`;
  }

  if (scorePrev === 0) {
    return `综合分从 0 回升到 ${formatScore(scoreNow)}${ownClause}`;
  }
  if (scoreDelta !== null && scoreDelta > 0) {
    return `综合分 ${formatScore(scorePrev)} → ${formatScore(scoreNow)}，上升 ${Math.abs(scoreDelta)} 分${ownClause}`;
  }
  if (scoreDelta !== null && scoreDelta < 0) {
    return `综合分 ${formatScore(scorePrev)} → ${formatScore(scoreNow)}，下降 ${Math.abs(scoreDelta)} 分${ownClause}`;
  }
  return `综合分 ${formatScore(scorePrev)} → ${formatScore(scoreNow)}，与上期持平${ownClause}`;
}

/** 生成 3~6 条亮点，按「分数 / 提及率 / 自有引用 / 竞品 / 引擎」的优先级排列 */
function buildHighlights({
  insights,
  previous,
  channels,
  competitorShare,
  brandName,
  scoreNow,
  scorePrev,
  scoreDelta,
  levelNow,
  mentionNow,
  mentionPrev,
  mentionDelta,
  ownShareNow,
  ownSharePrev,
  citationTotal,
  uniqueDomains,
  runsAvailable,
  latestKind,
  latestDay,
}) {
  const highlights = [];
  const seen = new Set();
  const push = (type, title, detail) => {
    const safeTitle = textOf(title);
    if (!safeTitle || seen.has(safeTitle) || highlights.length >= MAX_HIGHLIGHTS) return;
    seen.add(safeTitle);
    highlights.push({ type, title: safeTitle, detail: textOf(detail) });
  };

  const sampleOk = toNumber(insights?.sample?.ok);
  const sampleTotal = toNumber(insights?.sample?.total) ?? sampleOk;
  const sampleText = sampleOk === null
    ? '有效样本数暂缺'
    : `本轮有效样本 ${sampleOk} 条${sampleTotal !== null && sampleTotal !== sampleOk ? `（共 ${sampleTotal} 条）` : ''}`;

  // 1. 分数变化（有对比才谈变化，没有对比只报基线）
  if (scoreNow !== null && scorePrev !== null) {
    if (scorePrev === 0) {
      push(
        scoreNow > 0 ? 'up' : 'flat',
        `综合分 0 → ${formatScore(scoreNow)}`,
        '上期综合分为 0，本期重新建立有效基线，不计算百分比变化。',
      );
    } else {
      const delta = scoreDelta ?? 0;
      const type = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
      const change = delta === 0
        ? '与上期持平'
        : `较上期${delta > 0 ? '上升' : '下降'} ${Math.abs(delta)} 分`;
      push(
        type,
        `综合分 ${formatScore(scorePrev)} → ${formatScore(scoreNow)}`,
        `${change}；当前等级「${textOf(levelNow) || '未评级'}」。`,
      );
    }
  } else if (scoreNow !== null) {
    push(
      'flat',
      `综合分 ${formatScore(scoreNow)}（首轮基线）`,
      `当前等级「${textOf(levelNow) || '未评级'}」，暂无上一轮分数可对比。`,
    );
  }

  // 2. 提及率变化
  if (mentionNow !== null && mentionPrev !== null) {
    if (mentionPrev === 0) {
      push(
        mentionNow > 0 ? 'up' : 'flat',
        `AI 提及率 0% → ${formatPercent(mentionNow)}`,
        `上期提及率为 0，本期开始被 AI 提到；${sampleText}。`,
      );
    } else {
      const delta = mentionDelta ?? 0;
      const type = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
      const change = delta === 0
        ? '与上期持平'
        : `较上期${delta > 0 ? '上升' : '下降'} ${Math.abs(delta)}pt`;
      push(
        type,
        `AI 提及率 ${formatPercent(mentionPrev)} → ${formatPercent(mentionNow)}`,
        `${change}；${sampleText}。`,
      );
    }
  } else if (mentionNow !== null) {
    push(
      'flat',
      `AI 提及率 ${formatPercent(mentionNow)}（首轮基线）`,
      `${sampleText}，暂无上一轮提及率可对比。`,
    );
  }

  // 3. 自有站点引用
  if (citationTotal !== null) {
    if (citationTotal === 0) {
      push(
        'risk',
        '本轮没有可解析的引用来源',
        '引擎没有返回 citations，无法判断自有站点是否被引用；先确认采集链路，再谈引用优化。',
      );
    } else if (ownShareNow === 0) {
      push(
        'risk',
        '自有站点引用为 0',
        `本轮 ${citationTotal} 条引用、覆盖 ${uniqueDomains ?? '—'} 个域名，没有一条来自自有站点。`,
      );
    } else if (ownSharePrev === 0) {
      push(
        'up',
        '自有站点首次进入引用源',
        `自有站点引用占比 ${formatPercent(ownShareNow)}，上期为 0；继续把核心问答页做成可被引用的落地页。`,
      );
    } else if (ownSharePrev !== null) {
      const delta = round((ownShareNow - ownSharePrev) * 100, 1);
      const type = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
      push(
        type,
        `自有站点引用占比 ${formatPercent(ownSharePrev)} → ${formatPercent(ownShareNow)}`,
        delta === 0 ? '与上期持平。' : `较上期${delta > 0 ? '上升' : '下降'} ${Math.abs(delta)}pt。`,
      );
    } else {
      push(
        'flat',
        `自有站点引用占比 ${formatPercent(ownShareNow)}`,
        `本轮 ${citationTotal} 条引用，暂无上一轮数据可对比。`,
      );
    }
  }

  // 4. 竞品份额
  const brandRow = competitorShare.find((item) => item.name === (brandName || '本品牌')) ?? null;
  const competitorRows = competitorShare.filter((item) => item !== brandRow);
  const topCompetitor = competitorRows[0] ?? null;
  if (brandRow && topCompetitor) {
    if (topCompetitor.share > brandRow.share) {
      push(
        'risk',
        `竞品「${topCompetitor.name}」声量份额更高`,
        `竞品 ${formatPercent(topCompetitor.share)}，本品牌 ${formatPercent(brandRow.share)}；同一批问题里客户更容易先看到对方。`,
      );
    } else {
      push(
        'up',
        `本品牌声量份额 ${formatPercent(brandRow.share)}，高于全部竞品`,
        `第二名「${topCompetitor.name}」为 ${formatPercent(topCompetitor.share)}；保持当前内容节奏即可。`,
      );
    }
  } else if (brandRow) {
    push(
      'flat',
      `本品牌声量份额 ${formatPercent(brandRow.share)}`,
      '本轮没有可对比的竞品份额数据。',
    );
  }

  // 5. 多引擎覆盖
  if (channels.length) {
    const bestEngine = channels.reduce(
      (best, item) => (item.mentionRate > best.mentionRate ? item : best),
      channels[0],
    );
    const prevEngineCount = Array.isArray(previous?.engines) ? previous.engines.length : null;
    let type = 'flat';
    if (prevEngineCount !== null && channels.length > prevEngineCount) type = 'up';
    else if (prevEngineCount !== null && channels.length < prevEngineCount) type = 'down';
    push(
      type,
      `覆盖 ${channels.length} 个引擎，${bestEngine.engine} 提及率最高`,
      `${bestEngine.engine} 提及率 ${formatPercent(bestEngine.mentionRate)}（${bestEngine.answers} 条回答）；多引擎结论更稳，单引擎波动更大。`,
    );
  }

  // 6. 兜底：用真实但次要的信息补足 3 条，不编造变化
  if (highlights.length < MIN_HIGHLIGHTS) {
    if (sampleOk !== null) {
      push(
        'flat',
        `本轮有效样本 ${sampleOk} 条`,
        `样本量决定结论强度；${sampleOk < 8 ? '低于 8 条，建议下周补采。' : '已达到可参考的最低样本量。'}`,
      );
    }
    if (uniqueDomains !== null) {
      push(
        'flat',
        `引用源覆盖 ${uniqueDomains} 个域名`,
        `引用越分散，越需要挑 2~3 个高价值信源持续铺内容。`,
      );
    }
    const sentimentScore = toNumber(insights?.sentiment?.score);
    if (sentimentScore !== null) {
      push(
        'flat',
        `情感得分 ${round(sentimentScore, 2)}（范围 -1 ~ 1）`,
        `正面 ${toNumber(insights?.sentiment?.positive) ?? 0} 条、中性 ${toNumber(insights?.sentiment?.neutral) ?? 0} 条、负面 ${toNumber(insights?.sentiment?.negative) ?? 0} 条。`,
      );
    }
    if (runsAvailable > 0) {
      push(
        'flat',
        `已记录 ${runsAvailable} 轮采集`,
        `最新一轮为「${KIND_LABEL[latestKind] ?? latestKind ?? '未知类型'}」，开始日期 ${latestDay ?? '未知'}。`,
      );
    }
  }

  // 7. 空数据兜底：只陈述事实，不伪造趋势
  if (highlights.length < MIN_HIGHLIGHTS) {
    push('flat', '本周还没有可分析的采集数据', 'runs 与 insights 都为空，本周只建立记录，不下效果结论。');
    push('flat', '暂无上一轮对比', '没有历史轮次，首期只作为基线，不判断升降。');
    push('risk', '没有数据就无法验证动作', '下周先跑一轮完整采集（不少于 8 条样本），再决定内容投入方向。');
  }

  return highlights.slice(0, MAX_HIGHLIGHTS);
}

/** 生成风险与处置：同名实体 / 自有引用为 0 / 竞品份额反超 */
function buildRisks({ insights, brandName, brandShare, topCompetitor }) {
  const risks = [];
  const seen = new Set();
  const push = (title, detail, action) => {
    const safeTitle = textOf(title);
    if (!safeTitle || seen.has(safeTitle)) return;
    seen.add(safeTitle);
    risks.push({ title: safeTitle, detail: textOf(detail), action: textOf(action) });
  };

  const threats = Array.isArray(insights?.sameNameThreats) ? insights.sameNameThreats : [];
  for (const threat of threats.slice(0, 2)) {
    const domain = textOf(threat?.domain);
    const message = textOf(threat?.message);
    push(
      `同名实体「${domain || '未标注域名'}」抢占引用位`,
      message || 'AI 可能把同名实体当成你，客户看到的介绍未必是你的业务。',
      '统一「全称 + 城市 + 业务词」写法，补齐官网 schema，并把工商信息（经营范围、官网链接、简介）补全后挂回官网。',
    );
  }

  const ownShare = toNumber(insights?.citations?.ownShare);
  const citationTotal = readCitationTotal(insights);
  if (ownShare === 0) {
    push(
      '自有站点引用为 0',
      citationTotal === 0
        ? '本轮引用总数为 0（引擎未返回 citations），无法据此判断自有引用被挤占，但自有内容的可引用性仍是缺口。'
        : `本轮 ${citationTotal} 条引用里没有一条来自自有站点，AI 的答案依据都在别人手里。`,
      '官网补齐 llms.txt、核心问答页与 Organization/FAQ schema，并把同一批内容同步到知乎、公众号，先拿到第一个自有引用。',
    );
  }

  if (topCompetitor && brandShare !== null && topCompetitor.share > brandShare) {
    push(
      `竞品「${topCompetitor.name}」份额反超`,
      `竞品声量份额 ${formatPercent(topCompetitor.share)}，本品牌 ${formatPercent(brandShare)}；差距 ${round((topCompetitor.share - brandShare) * 100, 1)}pt。`,
      `围绕「${topCompetitor.name} vs ${brandName || '本品牌'}」「${brandName || '本品牌'}值不值得选」各补 2 篇对比与选型内容，本周内上线。`,
    );
  }

  return risks;
}

/** 兜底行动：plan 为空时至少给 3 条可执行动作 */
function fallbackActions(period) {
  return [
    {
      rank: 1,
      action: '补全组织化实体信息（全称 + 城市 + 业务词），并在官网加 Organization schema、工商信息挂官网链接',
      why: 'AI 先要知道「你是谁、在哪、做什么」，才可能在推荐类问题里把你列进去。',
      owner: '内容负责人',
      deadline: addDays(period.to, 5),
    },
    {
      rank: 2,
      action: '官网新增 llms.txt，并补齐 3 个核心问答页（价格、流程、案例各 1 页）',
      why: '自有站点引用为 0，通常不是内容不够，而是缺少 AI 能直接抓取和引用的结构化页面。',
      owner: '技术负责人',
      deadline: addDays(period.to, 7),
    },
    {
      rank: 3,
      action: '在知乎与公众号各铺 2 篇信源文（共 4 篇），覆盖本周高频问题',
      why: 'AI 更愿意引用已被收录、可验证的第三方信源；先把引用位占住，再谈官网转化。',
      owner: '内容负责人',
      deadline: addDays(period.to, 7),
    },
  ];
}

/** 行动清单：优先取 plan.top10 前 5，没有则用兜底 3 条 */
function buildActions(plan, period) {
  const top10 = Array.isArray(plan?.top10) ? plan.top10 : [];
  if (top10.length === 0) return fallbackActions(period);
  return top10.slice(0, MAX_ACTIONS).map((item, index) => ({
    rank: toNumber(item?.rank) ?? index + 1,
    action: textOf(item?.action) || '补齐一项可执行动作',
    why: textOf(item?.why) || '来自本周行动计划。',
    owner: textOf(item?.owner) || '内容负责人',
    deadline: textOf(item?.deadline) || addDays(period.to, 5 + index),
  }));
}

/** 下周计划：3~4 条，每条都必须带数量或时限 */
function buildNextWeek({ insights, brand, period, hasSameNameThreat, ownShareNow }) {
  const fanoutTop = Array.isArray(insights?.fanout?.top) ? insights.fanout.top : [];
  const topicQueries = fanoutTop
    .map((item) => textOf(item?.query))
    .filter(Boolean)
    .slice(0, 2);
  const industry = textOf(brand?.industry) || '核心业务';
  const city = textOf(brand?.city);
  const topicPhrase = topicQueries.length
    ? topicQueries.map((query) => `「${query}」`).join('')
    : `「${industry}多少钱」「${city ? `${city}${industry}` : `${industry}怎么选`}」`;

  const items = [
    `本周发布 3 篇主题文，覆盖${topicPhrase}等 5 个高频问题，${shortDay(addDays(period.to, 3))} 前完成初稿`,
  ];

  if (hasSameNameThreat) {
    items.push(
      `完成官网与 2 个工商平台的组织化实体信息补全（全称 + 城市 + 业务词），${shortDay(addDays(period.to, 5))} 前上线`,
    );
  } else {
    items.push(
      `在知乎与公众号各发布 2 篇信源文（共 4 篇），${shortDay(addDays(period.to, 5))} 前完成`,
    );
  }

  items.push(
    `官网补齐 llms.txt、schema 与 3 个核心问答页，${shortDay(addDays(period.to, 6))} 前上线`,
  );
  items.push(
    ownShareNow === 0
      ? `下周一复跑 2 轮采集、每轮不少于 8 条样本，验证自有引用能否从 0 突破到至少 1 个域名`
      : `下周一复跑 2 轮采集、每轮不少于 8 条样本，验证提及率能否再提升 5pt`,
  );

  return items.slice(0, 4);
}

/** 数据可信度：轮次不足 / 演示数据 / 样本偏少，全部命中时用「；」连接 */
function buildDataQuality({ orderedRuns, insights }) {
  const runsAvailable = orderedRuns.length;
  const latestKind = orderedRuns[0]?.kind ?? null;
  const effectiveSamples = toNumber(insights?.sample?.ok)
    ?? toNumber(insights?.sample?.total)
    ?? toNumber(orderedRuns[0]?.samples);
  const warnings = [];
  if (runsAvailable < 2) warnings.push('只有 1 轮数据，看不出趋势');
  if (latestKind === 'mock') warnings.push('本轮是演示数据，不能对外');
  if (effectiveSamples !== null && effectiveSamples < 8) warnings.push('样本偏少，结论仅供方向参考');
  return {
    runsAvailable,
    latestKind,
    warning: warnings.length ? warnings.join('；') : null,
  };
}

/**
 * 构建客户周报数据对象。
 *
 * @param {object} [options]
 * @param {object} [options.brand] 品牌对象（name/legalName/city/industry/urls/competitors）
 * @param {Array<{runId?:number,kind?:string,status?:string,samples?:number,total?:number,level?:string,startedAt?:string}>} [options.runs]
 *   该品牌的运行列表，按时间倒序（内部会再排一次，不修改入参）
 * @param {object|null} [options.insights] 最新一轮 analyzeRun 结果
 * @param {object|null} [options.previous] 上一轮 insights（同结构）
 * @param {{top10?:Array<{rank?:number,action?:string,why?:string,owner?:string,deadline?:string}>}|null} [options.plan]
 * @param {{from?:string,to?:string,generatedAt?:string}|null} [options.period] 统计周期；generatedAt 可固定生成时间
 * @param {string} [options.generatedAt] 可选：顶层固定生成时间（测试/复算用）
 * @returns {{
 *   title:string,
 *   period:{from:string,to:string},
 *   summary:{headline:string,scoreNow:number|null,scorePrev:number|null,scoreDelta:number|null,
 *     mentionNow:number|null,mentionPrev:number|null,mentionDelta:number|null,
 *     ownShareNow:number|null,ownSharePrev:number|null,citationNow:number|null,citationPrev:number|null},
 *   highlights:Array<{type:'up'|'down'|'flat'|'risk',title:string,detail:string}>,
 *   risks:Array<{title:string,detail:string,action:string}>,
 *   actions:Array<{rank:number,action:string,why:string,owner:string,deadline:string}>,
 *   channels:Array<{engine:string,answers:number,mentionRate:number}>,
 *   citations:{total:number,uniqueDomains:number,ownShare:number,top:Array<{domain:string,typeLabel:string,share:number}>},
 *   competitorShare:Array<{name:string,share:number}>,
 *   nextWeek:string[],
 *   generatedAt:string,
 *   dataQuality:{runsAvailable:number,latestKind:string|null,warning:string|null}
 * }}
 */
export function buildWeeklyReport(options = {}) {
  const input = options && typeof options === 'object' ? options : {};
  const {
    brand = {},
    runs = [],
    insights = null,
    previous = null,
    plan = null,
    period = null,
  } = input;
  const safeBrand = brand && typeof brand === 'object' ? brand : {};
  const brandName = textOf(safeBrand.name) || textOf(safeBrand.legalName) || '恒野';
  const orderedRuns = orderRuns(runs);
  const resolvedPeriod = resolvePeriod(period, orderedRuns);
  const generatedAt = normalizeGeneratedAt(input.generatedAt ?? period?.generatedAt);

  const scoreNow = readScore(insights) ?? readScore(orderedRuns[0]);
  const scorePrev = readScore(previous) ?? readScore(orderedRuns[1]);
  const mentionNow = readMentionRate(insights);
  const mentionPrev = readMentionRate(previous);
  const ownShareNow = toNumber(insights?.citations?.ownShare);
  const ownSharePrev = toNumber(previous?.citations?.ownShare);
  const citationNow = readCitationTotal(insights);
  const citationPrev = readCitationTotal(previous);
  const uniqueDomains = toNumber(insights?.citations?.uniqueDomains);
  const citationTotal = citationNow ?? 0;
  const brandShare = toNumber(insights?.sov?.brandShare);

  // 比率变化统一换算成百分点（pt）；上一期缺失或为 0 时 delta 为 null
  const scoreDelta = scoreNow !== null && scorePrev !== null && scorePrev !== 0
    ? round(scoreNow - scorePrev, 1)
    : null;
  const mentionDelta = mentionNow !== null && mentionPrev !== null && mentionPrev !== 0
    ? round((mentionNow - mentionPrev) * 100, 1)
    : null;

  const channels = buildChannels(insights);
  const competitorShare = buildCompetitorShare(insights, brandName);
  const brandRow = competitorShare.find((item) => item.name === brandName) ?? null;
  const topCompetitor = competitorShare.find((item) => item.name !== brandName) ?? null;

  const headline = buildHeadline({
    scoreNow,
    scorePrev,
    scoreDelta,
    mentionNow,
    mentionPrev,
    mentionDelta,
    ownShareNow,
    ownSharePrev,
  });

  const highlights = buildHighlights({
    insights,
    previous,
    channels,
    competitorShare,
    brandName,
    scoreNow,
    scorePrev,
    scoreDelta,
    levelNow: orderedRuns[0]?.level,
    mentionNow,
    mentionPrev,
    mentionDelta,
    ownShareNow,
    ownSharePrev,
    citationTotal: citationNow,
    uniqueDomains,
    runsAvailable: orderedRuns.length,
    latestKind: orderedRuns[0]?.kind ?? null,
    latestDay: localDateOf(orderedRuns[0]?.startedAt),
  });

  const risks = buildRisks({
    insights,
    brandName,
    brandShare: brandRow ? brandRow.share : brandShare,
    topCompetitor,
  });
  const actions = buildActions(plan, resolvedPeriod);
  const nextWeek = buildNextWeek({
    insights,
    brand: safeBrand,
    period: resolvedPeriod,
    hasSameNameThreat: Array.isArray(insights?.sameNameThreats) && insights.sameNameThreats.length > 0,
    ownShareNow,
  });
  const dataQuality = buildDataQuality({ orderedRuns, insights });

  return {
    title: `${brandName} · GEO 周报（${resolvedPeriod.from} ~ ${resolvedPeriod.to}）`,
    period: { from: resolvedPeriod.from, to: resolvedPeriod.to },
    summary: {
      headline,
      scoreNow,
      scorePrev,
      scoreDelta,
      mentionNow,
      mentionPrev,
      mentionDelta,
      ownShareNow,
      ownSharePrev,
      citationNow,
      citationPrev,
    },
    highlights,
    risks,
    actions,
    channels,
    citations: {
      total: citationTotal,
      uniqueDomains: uniqueDomains ?? 0,
      ownShare: ownShareNow ?? 0,
      top: buildCitationTop(insights),
    },
    competitorShare,
    nextWeek,
    generatedAt,
    dataQuality,
  };
}

/** Markdown 表格单元格转义：竖线会破坏表格，换行会破坏行结构 */
function mdCell(value) {
  return String(value ?? '—').replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
}

/** Markdown 指标表的一行 */
function metricRow(label, nowText, prevText, deltaText) {
  return `| ${mdCell(label)} | ${mdCell(nowText)} | ${mdCell(prevText)} | ${mdCell(deltaText)} |`;
}

/**
 * 渲染客户周报 Markdown（全中文，可直接贴进邮件或飞书）。
 * @param {object} report buildWeeklyReport 的返回值
 * @returns {string}
 */
export function renderWeeklyMarkdown(report) {
  const safe = report && typeof report === 'object' ? report : {};
  const summary = safe.summary && typeof safe.summary === 'object' ? safe.summary : {};
  const period = safe.period && typeof safe.period === 'object' ? safe.period : {};
  const highlights = Array.isArray(safe.highlights) ? safe.highlights : [];
  const risks = Array.isArray(safe.risks) ? safe.risks : [];
  const actions = Array.isArray(safe.actions) ? safe.actions : [];
  const channels = Array.isArray(safe.channels) ? safe.channels : [];
  const citations = safe.citations && typeof safe.citations === 'object' ? safe.citations : {};
  const citationTop = Array.isArray(citations.top) ? citations.top : [];
  const competitorShare = Array.isArray(safe.competitorShare) ? safe.competitorShare : [];
  const nextWeek = Array.isArray(safe.nextWeek) ? safe.nextWeek : [];
  const quality = safe.dataQuality && typeof safe.dataQuality === 'object' ? safe.dataQuality : {};

  // 引用条数不在契约的 delta 字段里，渲染时按本期/上期现算，缺一边就显示「—」
  const citationNowNum = toNumber(summary.citationNow);
  const citationPrevNum = toNumber(summary.citationPrev);
  const citationDelta = citationNowNum !== null && citationPrevNum !== null
    ? round(citationNowNum - citationPrevNum, 1)
    : null;

  const lines = [];
  lines.push(`# ${safe.title ?? '恒野 · GEO 周报'}`);
  lines.push('');
  lines.push(`> ${summary.headline ?? '首轮基线，暂无对比'}`);
  lines.push('');
  lines.push(`**统计周期**：${period.from ?? '—'} ~ ${period.to ?? '—'}`);
  lines.push('');

  lines.push('## 一、关键指标');
  lines.push('');
  lines.push('| 指标 | 本期 | 上期 | 变化 |');
  lines.push('| --- | --- | --- | --- |');
  lines.push(metricRow('综合评分', formatScore(summary.scoreNow), formatScore(summary.scorePrev), formatDelta(summary.scoreDelta, ' 分')));
  lines.push(metricRow('AI 提及率', formatPercent(summary.mentionNow), formatPercent(summary.mentionPrev), formatDelta(summary.mentionDelta, 'pt')));
  lines.push(metricRow('自有站点引用占比', formatPercent(summary.ownShareNow), formatPercent(summary.ownSharePrev), '—'));
  lines.push(metricRow('引用总数', `${citationNowNum ?? '—'} 条`, `${citationPrevNum ?? '—'} 条`, formatDelta(citationDelta, ' 条')));
  lines.push('');
  lines.push('说明：比率类变化用百分点（pt），分数变化用分；上期缺失或为 0 时不计变化。');
  lines.push('');

  lines.push('## 二、本周亮点');
  lines.push('');
  if (highlights.length === 0) {
    lines.push('本期没有可展示的亮点。');
  } else {
    for (const item of highlights) {
      const label = HIGHLIGHT_LABEL[item?.type] ?? '观察';
      lines.push(`- **【${label}】${item?.title ?? ''}**：${item?.detail ?? ''}`);
    }
  }
  lines.push('');

  lines.push('## 三、风险与处置');
  lines.push('');
  if (risks.length === 0) {
    lines.push('本期未发现需要单独处置的风险。');
  } else {
    lines.push('| 风险 | 说明 | 处置 |');
    lines.push('| --- | --- | --- |');
    for (const item of risks) {
      lines.push(`| ${mdCell(item?.title)} | ${mdCell(item?.detail)} | ${mdCell(item?.action)} |`);
    }
  }
  lines.push('');

  lines.push('## 四、本周行动');
  lines.push('');
  lines.push('| # | 动作 | 为什么 | 负责人 | 截止 |');
  lines.push('| --- | --- | --- | --- | --- |');
  if (actions.length === 0) {
    lines.push('| — | 暂无行动项，先补一轮采集。 | — | — | — |');
  } else {
    for (const item of actions) {
      lines.push(
        `| ${mdCell(item?.rank)} | ${mdCell(item?.action)} | ${mdCell(item?.why)} | ${mdCell(item?.owner)} | ${mdCell(item?.deadline)} |`,
      );
    }
  }
  lines.push('');

  lines.push('## 五、多引擎覆盖');
  lines.push('');
  if (channels.length === 0) {
    lines.push('本轮没有可用的引擎数据。');
  } else {
    lines.push('| 引擎 | 回答数 | 提及率 |');
    lines.push('| --- | --- | --- |');
    for (const item of channels) {
      lines.push(`| ${mdCell(item.engine)} | ${mdCell(item.answers)} | ${mdCell(formatPercent(item.mentionRate))} |`);
    }
  }
  lines.push('');

  lines.push('## 六、引用源');
  lines.push('');
  lines.push(
    `共 ${toNumber(citations.total) ?? 0} 条引用，去重后 ${toNumber(citations.uniqueDomains) ?? 0} 个域名，自有站点占 ${formatPercent(citations.ownShare)}。`,
  );
  lines.push('');
  if (citationTop.length === 0) {
    lines.push('本轮没有可用的引用源数据。');
  } else {
    lines.push('| 引用域名 | 类型 | 占比 |');
    lines.push('| --- | --- | --- |');
    for (const item of citationTop) {
      lines.push(`| ${mdCell(item.domain)} | ${mdCell(item.typeLabel)} | ${mdCell(formatPercent(item.share))} |`);
    }
  }
  lines.push('');

  lines.push('## 七、竞品声量份额');
  lines.push('');
  if (competitorShare.length === 0) {
    lines.push('本轮没有可对比的竞品份额数据。');
  } else {
    lines.push('| 品牌 | 声量份额 |');
    lines.push('| --- | --- |');
    for (const item of competitorShare) {
      lines.push(`| ${mdCell(item.name)} | ${mdCell(formatPercent(item.share))} |`);
    }
  }
  lines.push('');

  lines.push('## 八、下周计划');
  lines.push('');
  if (nextWeek.length === 0) {
    lines.push('- [ ] 先补一轮完整采集，再制定下周计划。');
  } else {
    for (const item of nextWeek) lines.push(`- [ ] ${item}`);
  }
  lines.push('');

  lines.push('## 九、数据说明');
  lines.push('');
  lines.push(`- 本周可用轮次：${toNumber(quality.runsAvailable) ?? 0} 轮`);
  lines.push(`- 最新一轮类型：${KIND_LABEL[quality.latestKind] ?? quality.latestKind ?? '未知'}`);
  lines.push(`- 数据提示：${quality.warning || '无'}`);
  lines.push(`- 生成时间：${safe.generatedAt ?? '—'}`);
  lines.push('');
  lines.push('---');
  lines.push('本报告由恒野 GEO 自研版生成，数据仅供优化方向参考，不作为效果承诺。');
  return lines.join('\n');
}

/** HTML 转义：品牌名、动作、引用域名都可能来自外部输入，必须全部转义 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

/** 指标卡（HTML 用色块展示 4 个核心数字） */
function htmlMetricCard(label, value, note) {
  return `<td class="wk-card"><div class="wk-card-label">${escapeHtml(label)}</div>`
    + `<div class="wk-card-value">${escapeHtml(value)}</div>`
    + `<div class="wk-card-note">${escapeHtml(note)}</div></td>`;
}

/** 亮点列表项 */
function htmlHighlight(item) {
  const type = ['up', 'down', 'flat', 'risk'].includes(item?.type) ? item.type : 'flat';
  return `<tr>`
    + `<td class="wk-badge-cell"><span class="wk-badge wk-badge-${type}">${escapeHtml(HIGHLIGHT_LABEL[type])}</span></td>`
    + `<td class="wk-highlight-body"><strong>${escapeHtml(item?.title)}</strong><span>${escapeHtml(item?.detail)}</span></td>`
    + `</tr>`;
}

/** 周报自包含 HTML（内联样式、零外部资源、零 JavaScript，可直接发邮件） */
export function renderWeeklyHtml(report) {
  const safe = report && typeof report === 'object' ? report : {};
  const summary = safe.summary && typeof safe.summary === 'object' ? safe.summary : {};
  const period = safe.period && typeof safe.period === 'object' ? safe.period : {};
  const highlights = Array.isArray(safe.highlights) ? safe.highlights : [];
  const risks = Array.isArray(safe.risks) ? safe.risks : [];
  const actions = Array.isArray(safe.actions) ? safe.actions : [];
  const channels = Array.isArray(safe.channels) ? safe.channels : [];
  const citations = safe.citations && typeof safe.citations === 'object' ? safe.citations : {};
  const citationTop = Array.isArray(citations.top) ? citations.top : [];
  const competitorShare = Array.isArray(safe.competitorShare) ? safe.competitorShare : [];
  const nextWeek = Array.isArray(safe.nextWeek) ? safe.nextWeek : [];
  const quality = safe.dataQuality && typeof safe.dataQuality === 'object' ? safe.dataQuality : {};

  const citationNowNum = toNumber(summary.citationNow);
  const citationPrevNum = toNumber(summary.citationPrev);
  const citationDelta = citationNowNum !== null && citationPrevNum !== null
    ? round(citationNowNum - citationPrevNum, 1)
    : null;

  const metricCards = [
    htmlMetricCard('综合评分', formatScore(summary.scoreNow), `上期 ${formatScore(summary.scorePrev)} · ${formatDelta(summary.scoreDelta, ' 分')}`),
    htmlMetricCard('AI 提及率', formatPercent(summary.mentionNow), `上期 ${formatPercent(summary.mentionPrev)} · ${formatDelta(summary.mentionDelta, 'pt')}`),
    htmlMetricCard('自有引用占比', formatPercent(summary.ownShareNow), `上期 ${formatPercent(summary.ownSharePrev)}`),
    htmlMetricCard('本期引用', `${citationNowNum ?? '—'} 条`, `上期 ${citationPrevNum ?? '—'} 条 · ${formatDelta(citationDelta, ' 条')}`),
  ].join('');

  const highlightRows = highlights.length
    ? highlights.map((item) => htmlHighlight(item)).join('')
    : '<tr><td colspan="2" class="wk-empty">本期没有可展示的亮点。</td></tr>';

  const riskRows = risks.length
    ? risks.map((item) => `<tr>`
      + `<td class="wk-strong">${escapeHtml(item?.title)}</td>`
      + `<td>${escapeHtml(item?.detail)}</td>`
      + `<td>${escapeHtml(item?.action)}</td>`
      + `</tr>`).join('')
    : '<tr><td colspan="3" class="wk-empty">本期未发现需要单独处置的风险。</td></tr>';

  const actionRows = actions.length
    ? actions.map((item) => `<tr>`
      + `<td class="wk-num">${escapeHtml(item?.rank)}</td>`
      + `<td class="wk-strong">${escapeHtml(item?.action)}</td>`
      + `<td>${escapeHtml(item?.why)}</td>`
      + `<td>${escapeHtml(item?.owner)}</td>`
      + `<td class="wk-nowrap">${escapeHtml(item?.deadline)}</td>`
      + `</tr>`).join('')
    : '<tr><td colspan="5" class="wk-empty">暂无行动项，先补一轮采集。</td></tr>';

  const channelRows = channels.length
    ? channels.map((item) => `<tr>`
      + `<td class="wk-strong">${escapeHtml(item.engine)}</td>`
      + `<td class="wk-num">${escapeHtml(item.answers)}</td>`
      + `<td class="wk-num">${escapeHtml(formatPercent(item.mentionRate))}</td>`
      + `</tr>`).join('')
    : '<tr><td colspan="3" class="wk-empty">本轮没有可用的引擎数据。</td></tr>';

  const citationRows = citationTop.length
    ? citationTop.map((item) => `<tr>`
      + `<td class="wk-strong">${escapeHtml(item.domain)}</td>`
      + `<td>${escapeHtml(item.typeLabel)}</td>`
      + `<td class="wk-num">${escapeHtml(formatPercent(item.share))}</td>`
      + `</tr>`).join('')
    : '<tr><td colspan="3" class="wk-empty">本轮没有可用的引用源数据。</td></tr>';

  const competitorRows = competitorShare.length
    ? competitorShare.map((item) => `<tr>`
      + `<td class="wk-strong">${escapeHtml(item.name)}</td>`
      + `<td class="wk-num">${escapeHtml(formatPercent(item.share))}</td>`
      + `</tr>`).join('')
    : '<tr><td colspan="2" class="wk-empty">本轮没有可对比的竞品份额数据。</td></tr>';

  const nextWeekItems = nextWeek.length
    ? nextWeek.map((item) => `<li>${escapeHtml(item)}</li>`).join('')
    : '<li>先补一轮完整采集，再制定下周计划。</li>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(safe.title ?? '恒野 · GEO 周报')}</title>
<style>
.wk-wrap{background:#0b1220;color:#e6edf7;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.7;padding:28px 20px;max-width:880px;margin:0 auto;border-radius:14px;font-size:14px}
.wk-wrap *{box-sizing:border-box}
.wk-head{border-bottom:1px solid #253248;padding-bottom:18px;margin-bottom:22px}
.wk-kicker{font-size:12px;letter-spacing:.16em;color:#6ee7b7;text-transform:uppercase;margin-bottom:8px}
.wk-title{font-size:25px;line-height:1.35;margin:0 0 8px;color:#f8fafc;font-weight:700}
.wk-period{color:#93a4bd;font-size:13px}
.wk-hero{background:linear-gradient(135deg,#16263a,#122033);border:1px solid #2b405c;border-left:4px solid #6ee7b7;border-radius:10px;padding:16px 18px;margin-bottom:22px}
.wk-hero-label{font-size:12px;color:#6ee7b7;letter-spacing:.08em;margin-bottom:6px}
.wk-hero-text{font-size:17px;line-height:1.6;color:#f1f5f9;font-weight:600}
.wk-cards{width:100%;border-collapse:separate;border-spacing:8px;margin:0 -8px 20px}
.wk-card{background:#131d2e;border:1px solid #253248;border-radius:10px;padding:14px 12px;width:25%;vertical-align:top}
.wk-card-label{font-size:12px;color:#93a4bd;margin-bottom:6px}
.wk-card-value{font-size:22px;font-weight:700;color:#f8fafc;line-height:1.3}
.wk-card-note{font-size:11px;color:#7c8ba1;margin-top:6px;line-height:1.5}
.wk-h2{font-size:17px;color:#f8fafc;margin:26px 0 10px;padding-left:10px;border-left:3px solid #6ee7b7;line-height:1.4}
.wk-table{width:100%;border-collapse:collapse;background:#101a29;border:1px solid #253248;border-radius:10px;overflow:hidden;margin-bottom:8px}
.wk-table th{background:#182638;color:#cbd5e1;font-size:12px;text-align:left;padding:10px 12px;font-weight:600}
.wk-table td{padding:10px 12px;border-top:1px solid #1e2d42;color:#dbe4ef;vertical-align:top;font-size:13px}
.wk-strong{color:#f1f5f9;font-weight:600}
.wk-num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.wk-nowrap{white-space:nowrap}
.wk-empty{color:#7c8ba1;text-align:center;padding:18px 12px}
.wk-badge-cell{width:62px;padding-right:0}
.wk-badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap}
.wk-badge-up{background:#0f3a2c;color:#6ee7b7;border:1px solid #1f6b53}
.wk-badge-down{background:#3a1720;color:#fda4af;border:1px solid #7f2436}
.wk-badge-flat{background:#33280e;color:#fcd34d;border:1px solid #71540f}
.wk-badge-risk{background:#3a1a12;color:#fdba74;border:1px solid #8a3a1c}
.wk-highlight-body span{display:block;color:#a9b8cc;font-size:13px;margin-top:3px}
.wk-list{margin:0;padding-left:20px;color:#dbe4ef}
.wk-list li{margin:6px 0}
.wk-note{background:#101a29;border:1px solid #253248;border-radius:10px;padding:14px 16px;color:#a9b8cc;font-size:12.5px;line-height:1.8}
.wk-foot{border-top:1px solid #253248;margin-top:22px;padding-top:14px;color:#64748b;font-size:11.5px;line-height:1.7}
@media (max-width:640px){.wk-card{display:block;width:100%}.wk-title{font-size:21px}}
</style>
</head>
<body style="margin:0;padding:0;background:#0b1220;">
<div class="wk-wrap">
<div class="wk-head">
<div class="wk-kicker">客户周报 · GEO 可见度</div>
<h1 class="wk-title">${escapeHtml(safe.title ?? '恒野 · GEO 周报')}</h1>
<div class="wk-period">统计周期：${escapeHtml(period.from ?? '—')} ~ ${escapeHtml(period.to ?? '—')} · 生成时间：${escapeHtml(safe.generatedAt ?? '—')}</div>
</div>
<div class="wk-hero">
<div class="wk-hero-label">本周结论</div>
<div class="wk-hero-text">${escapeHtml(summary.headline ?? '首轮基线，暂无对比')}</div>
</div>
<table class="wk-cards" role="presentation"><tr>${metricCards}</tr></table>
<h2 class="wk-h2">一、本周亮点</h2>
<table class="wk-table" role="presentation"><tbody>${highlightRows}</tbody></table>
<h2 class="wk-h2">二、风险与处置</h2>
<table class="wk-table"><thead><tr><th>风险</th><th>说明</th><th>处置</th></tr></thead><tbody>${riskRows}</tbody></table>
<h2 class="wk-h2">三、本周行动</h2>
<table class="wk-table"><thead><tr><th>#</th><th>动作</th><th>为什么</th><th>负责人</th><th>截止</th></tr></thead><tbody>${actionRows}</tbody></table>
<h2 class="wk-h2">四、多引擎覆盖</h2>
<table class="wk-table"><thead><tr><th>引擎</th><th>回答数</th><th>提及率</th></tr></thead><tbody>${channelRows}</tbody></table>
<h2 class="wk-h2">五、引用源</h2>
<div class="wk-note">共 ${escapeHtml(toNumber(citations.total) ?? 0)} 条引用，去重后 ${escapeHtml(toNumber(citations.uniqueDomains) ?? 0)} 个域名，自有站点占 ${escapeHtml(formatPercent(citations.ownShare))}。</div>
<table class="wk-table"><thead><tr><th>引用域名</th><th>类型</th><th>占比</th></tr></thead><tbody>${citationRows}</tbody></table>
<h2 class="wk-h2">六、竞品声量份额</h2>
<table class="wk-table"><thead><tr><th>品牌</th><th>声量份额</th></tr></thead><tbody>${competitorRows}</tbody></table>
<h2 class="wk-h2">七、下周计划</h2>
<ul class="wk-list">${nextWeekItems}</ul>
<h2 class="wk-h2">八、数据说明</h2>
<div class="wk-note">
可用轮次：${escapeHtml(toNumber(quality.runsAvailable) ?? 0)} 轮<br>
最新一轮类型：${escapeHtml(KIND_LABEL[quality.latestKind] ?? quality.latestKind ?? '未知')}<br>
数据提示：${escapeHtml(quality.warning || '无')}
</div>
<div class="wk-foot">本报告由恒野 GEO 自研版生成，数据仅供优化方向参考，不作为效果承诺。</div>
</div>
</body>
</html>`;
}
