/**
 * weekly.js 自测（客户周报）
 * 覆盖：标题与周期、有无对比的 headline、delta 正负与 null、亮点数量与优先级、
 * 三类风险触发、plan 与兜底行动、下周计划具体性、数据质量三种 warning、
 * 引用 Top5、竞品排序、Markdown 各节、HTML 自包含与转义、空输入、确定性。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWeeklyReport, renderWeeklyMarkdown, renderWeeklyHtml } from '../lib/weekly.js';

const FIXED_TIME = '2026-10-26T13:00:00.000Z';
const PERIOD = { from: '2026-10-20', to: '2026-10-26', generatedAt: FIXED_TIME };

const brand = {
  name: '恒野',
  legalName: '芜湖恒野文化传媒有限公司',
  city: '芜湖',
  industry: '内容代运营',
  urls: ['https://hengye.example'],
  competitors: ['宇典科技', '力行文化', '皖美文化'],
  sameNameDomainHints: ['hengye-cangchu.com'],
};

/** 运行列表：默认两轮（本周 55 分、上周 42 分） */
function makeRuns({
  count = 2,
  latestKind = 'live',
  latestSamples = 50,
  latestTotal = 55,
  prevTotal = 42,
} = {}) {
  const runs = [
    {
      runId: 12,
      kind: latestKind,
      status: 'done',
      samples: latestSamples,
      total: latestTotal,
      level: '中等',
      startedAt: '2026-10-26T02:00:00.000Z',
    },
  ];
  if (count >= 2) {
    runs.push({
      runId: 11,
      kind: 'live',
      status: 'done',
      samples: 48,
      total: prevTotal,
      level: '偏弱',
      startedAt: '2026-10-19T02:00:00.000Z',
    });
  }
  return runs;
}

/** 最新一轮分析结果（结构对齐 lib/analytics.js analyzeRun） */
function makeInsights({
  mentionRate = 0.42,
  mentionOk = 50,
  mentionTotal = 50,
  ownShare = 0,
  citationsTotal = 20,
  uniqueDomains = 6,
  threats = true,
  brandShare = 0.18,
  threatMessage = '同名实体站点被 AI 引用 1 次（占 5.0%）：AI 在讲「恒野」时可能引的是别家。',
} = {}) {
  return {
    sample: {
      total: mentionTotal,
      ok: mentionOk,
      mentioned: Math.round(mentionTotal * mentionRate),
      recommended: 8,
      mentionRate,
      recommendationRate: 0.16,
    },
    exposure: { avgWordShare: 0.08, avgPositionWeight: 0.2, firstSentenceRate: 0.1 },
    citations: {
      total: citationsTotal,
      uniqueDomains,
      ownShare,
      byDomain: [
        { domain: 'zhihu.com', count: 7, share: 0.35, type: 'social', typeLabel: '社媒/问答' },
        { domain: 'qcc.com', count: 4, share: 0.2, type: 'registry', typeLabel: '工商/企查' },
        { domain: 'sohu.com', count: 3, share: 0.15, type: 'media', typeLabel: '媒体/门户' },
        { domain: 'baike.baidu.com', count: 2, share: 0.1, type: 'encyclopedia', typeLabel: '百科/知识库' },
        { domain: 'xiaohongshu.com', count: 2, share: 0.08, type: 'social', typeLabel: '社媒/问答' },
        { domain: 'douban.com', count: 1, share: 0.07, type: 'social', typeLabel: '社媒/问答' },
        {
          domain: 'hengye-cangchu.com',
          count: 1,
          share: 0.05,
          type: 'other',
          typeLabel: '同名实体站点（不可用）',
          sameName: true,
        },
      ],
    },
    sov: {
      brandMentions: 9,
      brandShare,
      competitors: [
        { name: '宇典科技', mentions: 22, share: 0.44, rate: 0.44, engines: ['deepseek'] },
        { name: '力行文化', mentions: 12, share: 0.24, rate: 0.24, engines: ['deepseek'] },
        { name: '皖美文化', mentions: 7, share: 0.14, rate: 0.14, engines: ['mock'] },
        { name: '江城传媒', mentions: 4, share: 0.08, rate: 0.08, engines: ['doubao'] },
        { name: '皖江网络', mentions: 2, share: 0.05, rate: 0.05, engines: ['doubao'] },
      ],
    },
    sentiment: { positive: 8, neutral: 11, negative: 2, score: 0.29 },
    engines: [
      { engine: 'deepseek', answers: 20, ok: 20, mentioned: 10, mentionRate: 0.5 },
      { engine: 'doubao', answers: 18, ok: 18, mentioned: 8, mentionRate: 0.44 },
      { engine: 'mock', answers: 12, ok: 12, mentioned: 3, mentionRate: 0.25 },
    ],
    verdictCounts: { recommended: 8, mentioned: 13, not_mentioned: 29 },
    fanout: {
      total: 22,
      unique: 14,
      brandInQueries: 2,
      top: [
        { query: '内容代运营多少钱', count: 4, engines: ['deepseek'] },
        { query: '芜湖内容代运营推荐', count: 3, engines: ['doubao'] },
      ],
    },
    sameNameThreats: threats
      ? [{ domain: 'hengye-cangchu.com', count: 1, share: 0.05, message: threatMessage }]
      : [],
  };
}

/** 上一轮分析结果：提及率 25%、综合分 42 */
function makePrevious({
  mentionRate = 0.25,
  ownShare = 0,
  citationsTotal = 15,
  brandShare = 0.2,
} = {}) {
  return {
    sample: { total: 48, ok: 48, mentioned: 12, mentionRate, recommendationRate: 0.1 },
    citations: { total: citationsTotal, uniqueDomains: 5, ownShare, byDomain: [] },
    sov: { brandShare, competitors: [] },
    sentiment: { positive: 3, neutral: 7, negative: 1, score: 0.15 },
    engines: [
      { engine: 'deepseek', answers: 20, mentionRate: 0.3 },
      { engine: 'doubao', answers: 14, mentionRate: 0.2 },
    ],
    sameNameThreats: [],
    fanout: { total: 10, unique: 8, top: [] },
  };
}

/** 组装一份完整周报，个别用例用 overrides 覆盖 */
function build(overrides = {}) {
  return buildWeeklyReport({
    brand,
    runs: makeRuns(),
    insights: makeInsights(),
    previous: makePrevious(),
    period: { ...PERIOD },
    ...overrides,
  });
}

test('标题、周期与生成时间符合契约', () => {
  const report = build();
  assert.equal(report.title, '恒野 · GEO 周报（2026-10-20 ~ 2026-10-26）');
  assert.deepEqual(report.period, { from: '2026-10-20', to: '2026-10-26' });
  assert.equal(report.generatedAt, FIXED_TIME);
});

test('有对比时 headline 由真实 delta 生成', () => {
  const report = build();
  assert.match(report.summary.headline, /AI 提及率 25% → 42%/);
  assert.match(report.summary.headline, /上升 17pt/);
  assert.match(report.summary.headline, /自有站点引用仍是 0/);
  assert.doesNotMatch(report.summary.headline, /首轮基线/);
});

test('无对比数据时 headline 写「首轮基线，暂无对比」', () => {
  const report = build({ runs: makeRuns({ count: 1 }), previous: null });
  assert.equal(report.summary.headline, '首轮基线，暂无对比');
  assert.equal(report.summary.scorePrev, null);
  assert.equal(report.summary.mentionPrev, null);
});

test('上期为 0 时 delta 为 null 且 headline 不夸大', () => {
  const report = build({ previous: makePrevious({ mentionRate: 0 }) });
  assert.equal(report.summary.mentionDelta, null);
  assert.match(report.summary.headline, /从 0% 升至 42%/);
  assert.doesNotMatch(report.summary.headline, /上升/);
});

test('delta 支持负数：提及率与综合分同时下降', () => {
  const report = build({
    runs: makeRuns({ latestTotal: 38 }),
    insights: makeInsights({ mentionRate: 0.12, mentionOk: 50 }),
  });
  assert.equal(report.summary.mentionDelta, -13);
  assert.equal(report.summary.scoreDelta, -4);
  assert.match(report.summary.headline, /下降 13pt/);
  assert.equal(report.highlights[0].type, 'down');
});

test('双方都为 0 时 headline 不写「升至」', () => {
  const report = build({
    runs: makeRuns({ latestTotal: 0 }),
    insights: makeInsights({ mentionRate: 0, mentionOk: 50 }),
    previous: { ...makePrevious({ mentionRate: 0 }), score: { total: 0 } },
  });
  assert.equal(report.summary.mentionDelta, null);
  assert.equal(report.summary.scoreDelta, null);
  assert.match(report.summary.headline, /仍为 0%/);
  assert.doesNotMatch(report.summary.headline, /升至/);
});

test('summary 指标字段完整且口径正确', () => {
  const report = build();
  assert.deepEqual(report.summary, {
    headline: report.summary.headline,
    scoreNow: 55,
    scorePrev: 42,
    scoreDelta: 13,
    mentionNow: 0.42,
    mentionPrev: 0.25,
    mentionDelta: 17,
    ownShareNow: 0,
    ownSharePrev: 0,
    citationNow: 20,
    citationPrev: 15,
  });
});

test('highlights 为 3~6 条，且优先分数、提及率', () => {
  const report = build();
  assert.ok(report.highlights.length >= 3 && report.highlights.length <= 6);
  assert.match(report.highlights[0].title, /综合分/);
  assert.match(report.highlights[1].title, /AI 提及率/);
  const titles = report.highlights.map((item) => item.title);
  assert.equal(new Set(titles).size, titles.length);
  for (const item of report.highlights) {
    assert.ok(['up', 'down', 'flat', 'risk'].includes(item.type));
    assert.ok(item.title && item.detail);
  }
});

test('无对比时不伪造下降，亮点仍不少于 3 条', () => {
  const report = build({ runs: makeRuns({ count: 1 }), previous: null });
  assert.ok(report.highlights.length >= 3);
  assert.equal(report.highlights.some((item) => item.type === 'down'), false);
});

test('highlights 覆盖自有引用为 0 的风险', () => {
  const report = build();
  const item = report.highlights.find((row) => row.title.includes('自有站点引用为 0'));
  assert.ok(item);
  assert.equal(item.type, 'risk');
});

test('风险三类同时触发：同名实体、自有引用为 0、竞品反超', () => {
  const report = build();
  assert.equal(report.risks.length, 3);
  assert.match(report.risks[0].title, /同名实体/);
  assert.match(report.risks[0].detail, /同名实体站点/);
  assert.match(report.risks[1].title, /自有站点引用为 0/);
  assert.match(report.risks[2].title, /宇典科技/);
  for (const item of report.risks) assert.ok(item.action.length > 0);
});

test('没有同名威胁时仍保留自有引用风险', () => {
  const report = build({ insights: makeInsights({ threats: false }) });
  assert.equal(report.risks.some((item) => item.title.includes('同名实体')), false);
  assert.ok(report.risks.some((item) => item.title.includes('自有站点引用为 0')));
});

test('竞品份额高于本品牌时生成一条风险', () => {
  const report = build({ insights: makeInsights({ threats: false }) });
  const item = report.risks.find((row) => row.title.includes('宇典科技'));
  assert.ok(item);
  assert.match(item.detail, /44%/);
  assert.match(item.detail, /18%/);
});

test('actions 优先取 plan.top10 前 5 条并保留契约字段', () => {
  const plan = {
    top10: Array.from({ length: 7 }, (_, index) => ({
      rank: index + 1,
      action: `计划动作 ${index + 1}`,
      why: `计划原因 ${index + 1}`,
      evidence: '某条证据',
      owner: '王五',
      deadline: '2026-10-30',
    })),
  };
  const report = build({ plan });
  assert.equal(report.actions.length, 5);
  assert.deepEqual(report.actions[0], {
    rank: 1,
    action: '计划动作 1',
    why: '计划原因 1',
    owner: '王五',
    deadline: '2026-10-30',
  });
  assert.equal('evidence' in report.actions[0], false);
  assert.deepEqual(report.actions.map((item) => item.rank), [1, 2, 3, 4, 5]);
});

test('没有 plan 时兜底 3 条行动（实体信息 / llms.txt / 知乎公众号）', () => {
  const report = build({ plan: null });
  assert.equal(report.actions.length, 3);
  assert.match(report.actions[0].action, /实体/);
  assert.match(report.actions[1].action, /llms\.txt/);
  assert.match(report.actions[2].action, /知乎/);
  for (const item of report.actions) {
    assert.match(item.deadline, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('plan.top10 为空数组时同样兜底 3 条', () => {
  const report = build({ plan: { top10: [] } });
  assert.equal(report.actions.length, 3);
  assert.deepEqual(report.actions.map((item) => item.rank), [1, 2, 3]);
});

test('nextWeek 为 3~4 条，每条都含数字或时限', () => {
  const report = build();
  assert.ok(report.nextWeek.length >= 3 && report.nextWeek.length <= 4);
  for (const item of report.nextWeek) {
    assert.match(item, /\d/);
    assert.equal(item.trim(), item);
  }
  assert.ok(report.nextWeek.some((item) => /8 条样本/.test(item)));
  assert.ok(report.nextWeek.some((item) => /\d{2}-\d{2} 前/.test(item)));
});

test('dataQuality：只有 1 轮数据', () => {
  const report = build({ runs: makeRuns({ count: 1 }) });
  assert.equal(report.dataQuality.runsAvailable, 1);
  assert.equal(report.dataQuality.warning, '只有 1 轮数据，看不出趋势');
});

test('dataQuality：本轮是演示数据', () => {
  const report = build({ runs: makeRuns({ latestKind: 'mock' }) });
  assert.equal(report.dataQuality.latestKind, 'mock');
  assert.equal(report.dataQuality.warning, '本轮是演示数据，不能对外');
});

test('dataQuality：样本偏少', () => {
  const report = build({
    runs: makeRuns({ latestSamples: 5 }),
    insights: makeInsights({ mentionOk: 5, mentionTotal: 5 }),
  });
  assert.equal(report.dataQuality.warning, '样本偏少，结论仅供方向参考');
});

test('dataQuality：数据健康时 warning 为 null', () => {
  const report = build();
  assert.equal(report.dataQuality.warning, null);
  assert.equal(report.dataQuality.runsAvailable, 2);
  assert.equal(report.dataQuality.latestKind, 'live');
});

test('citations.top 取 5 条并按份额降序', () => {
  const report = build();
  assert.equal(report.citations.total, 20);
  assert.equal(report.citations.uniqueDomains, 6);
  assert.equal(report.citations.ownShare, 0);
  assert.equal(report.citations.top.length, 5);
  assert.equal(report.citations.top[0].domain, 'zhihu.com');
  const shares = report.citations.top.map((item) => item.share);
  assert.deepEqual(shares, [...shares].sort((a, b) => b - a));
  for (const item of report.citations.top) {
    assert.ok(item.typeLabel);
    assert.equal(typeof item.share, 'number');
  }
});

test('competitorShare 含本品牌、按份额降序并截断到 5 条', () => {
  const report = build();
  assert.equal(report.competitorShare.length, 5);
  assert.ok(report.competitorShare.some((item) => item.name === '恒野'));
  const shares = report.competitorShare.map((item) => item.share);
  assert.deepEqual(shares, [...shares].sort((a, b) => b - a));
  assert.equal(report.competitorShare[0].name, '宇典科技');
});

test('本品牌份额很低时仍保留在 competitorShare 中', () => {
  const report = build({ insights: makeInsights({ brandShare: 0.01 }) });
  assert.equal(report.competitorShare.length, 5);
  assert.ok(report.competitorShare.some((item) => item.name === '恒野'));
  const shares = report.competitorShare.map((item) => item.share);
  assert.deepEqual(shares, [...shares].sort((a, b) => b - a));
});

test('channels 映射多引擎覆盖', () => {
  const report = build();
  assert.equal(report.channels.length, 3);
  assert.deepEqual(report.channels[0], { engine: 'deepseek', answers: 20, mentionRate: 0.5 });
  assert.deepEqual(report.channels.map((item) => item.engine), ['deepseek', 'doubao', 'mock']);
});

test('Markdown 九个章节齐全且含指标表', () => {
  const markdown = renderWeeklyMarkdown(build());
  for (const heading of [
    '## 一、关键指标',
    '## 二、本周亮点',
    '## 三、风险与处置',
    '## 四、本周行动',
    '## 五、多引擎覆盖',
    '## 六、引用源',
    '## 七、竞品声量份额',
    '## 八、下周计划',
    '## 九、数据说明',
  ]) {
    assert.ok(markdown.includes(heading), `缺少章节：${heading}`);
  }
  assert.match(markdown, /^\| 指标 \| 本期 \| 上期 \| 变化 \|$/m);
  assert.match(markdown, /\| 综合评分 \| 55 分 \| 42 分 \| \+13 分 \|/);
  assert.match(markdown, /\| AI 提及率 \| 42% \| 25% \| \+17pt \|/);
  assert.match(markdown, /\| 引用总数 \| 20 条 \| 15 条 \| \+5 条 \|/);
  assert.match(markdown, /AI 提及率 25% → 42%/);
});

test('HTML 自包含：完整文档、内联样式、无外链、无脚本', () => {
  const html = renderWeeklyHtml(build());
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<html lang="zh-CN">'));
  assert.ok(html.includes('<body'));
  assert.ok(html.includes('<style>'));
  assert.ok(html.includes('AI 提及率'));
  assert.ok(html.includes('本周亮点'));
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /\bsrc=/i);
  assert.doesNotMatch(html, /https?:\/\//i);
});

test('HTML 对 & < > " 做转义，注入的 script 不会落地', () => {
  const evil = '<script>alert("x")</script>';
  const report = build({
    brand: { ...brand, name: evil },
    insights: makeInsights({ threatMessage: `<img src=x onerror="${evil}">` }),
  });
  const html = renderWeeklyHtml(report);
  assert.equal(html.includes('<script>alert'), false);
  assert.equal(html.includes('<img src=x'), false);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&quot;'));
});

test('空输入不崩，结构完整且可直接渲染', () => {
  const report = buildWeeklyReport({ generatedAt: FIXED_TIME });
  assert.equal(report.summary.headline, '首轮基线，暂无对比');
  assert.deepEqual(report.risks, []);
  assert.ok(report.highlights.length >= 3);
  assert.equal(report.actions.length, 3);
  assert.ok(report.nextWeek.length >= 3);
  assert.deepEqual(report.channels, []);
  assert.deepEqual(report.citations.top, []);
  assert.deepEqual(report.competitorShare, []);
  assert.equal(report.dataQuality.runsAvailable, 0);
  assert.equal(report.generatedAt, FIXED_TIME);
  assert.ok(renderWeeklyMarkdown(report).length > 200);
  assert.ok(renderWeeklyHtml(report).includes('<style>'));
});

test('确定性：同输入两次 JSON.stringify 完全一致', () => {
  const args = {
    brand: { ...brand },
    runs: makeRuns(),
    insights: makeInsights(),
    previous: makePrevious(),
    plan: null,
    period: { ...PERIOD },
  };
  const first = buildWeeklyReport(args);
  const second = buildWeeklyReport(args);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.match(first.generatedAt, /^2026-10-26T13:00:00\.000Z$/);
});

test('period 缺省时取最近一轮往前一周', () => {
  const report = build({ period: null });
  assert.deepEqual(report.period, { from: '2026-10-20', to: '2026-10-26' });
  assert.match(report.title, /2026-10-20 ~ 2026-10-26/);
});

test('构建过程不修改传入的 runs 数组', () => {
  const runs = makeRuns();
  const snapshot = JSON.stringify(runs);
  buildWeeklyReport({ brand, runs, insights: makeInsights(), previous: makePrevious(), period: PERIOD });
  assert.equal(JSON.stringify(runs), snapshot);
});
