/**
 * tests/action-plan.test.js
 * 行动章节（Top10 清单 + 30 天计划）的验收测试。
 *
 * 守的是三条产品红线：
 *   1. 规则优先级正确 —— 覆盖率不足时必须先修采集，不能被内容动作盖过去；
 *   2. 每条行动都带证据 —— evidence 必须能落到具体数字，否则客户无法核对；
 *   3. 30 天计划可执行 —— 恰好 4 周、每周 2-4 件事，第 1 周修采集、第 4 周复测同题。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeRun } from '../lib/analytics.js';
import { buildActionPlan, renderActionPlanMarkdown } from '../lib/action-plan.js';

const BRAND = {
  name: '恒野',
  city: '芜湖',
  scope: '全国线上交付',
  industry: '内容代运营 / GEO 优化服务',
  services: ['内容代运营', '起号陪跑', 'GEO 优化'],
  urls: ['https://hengye.example.com'],
};

/** 造一条 getRunDetail().rows 形态的记录；拒答/引擎错误时 judgment 为 null */
function makeRow({
  question = '恒野是做什么的？',
  tier = 'brand_awareness',
  verdict = 'mentioned',
  text = '推荐恒野。',
  citations = [],
  status = 'ok',
  engine = 'deepseek',
} = {}) {
  return {
    question: { id: 1, text: question, tier, priority: 'P0' },
    answer: { engine, text, citations, status },
    judgment: status === 'ok' ? { verdict } : null,
  };
}

/** 造一份 analyzeRun 形态的 insights；只覆盖本模块消费的字段 */
function makeInsights(overrides = {}) {
  const base = {
    sample: { total: 30, ok: 26, mentioned: 8, mentionRate: 0.3077 },
    exposure: { avgWordShare: 0.1, avgPositionWeight: 0.2, firstSentenceRate: 0.5 },
    citations: { total: 59, uniqueDomains: 6, ownShare: 0, byDomain: [], sourceMix: {} },
    sov: { brandMentions: 8, brandShare: 0.667, competitors: [] },
    sentiment: { positive: 4, neutral: 4, negative: 0, score: 0.5 },
    engines: [],
    opportunities: [],
  };
  return { ...base, ...overrides };
}

/** 造一份 score.js 形态的评分；layers 可按键覆盖 */
function makeScore({
  total = 22.7,
  level = '隐形',
  ratio = 0.867,
  ok = 26,
  planned = 30,
  layers = {},
} = {}) {
  return {
    total,
    level,
    coverage: { ratio, ok, planned },
    layers: {
      awareness: { score: 2.9, weight: 20, ok: 7, total: 7 },
      decision: { score: 10, weight: 40, ok: 5, total: 5 },
      scenario: { score: 10.7, weight: 40, ok: 18, total: 18 },
      ...layers,
    },
  };
}

/**
 * 「最坏情况」夹具：覆盖率 40%、隐形、5 个机会域名、竞品份额更高、有负面、三层都有分。
 * 规则能触发的都触发，正好用来测 Top10 截断与字段完整性。
 */
function makeCapFixture() {
  const opportunities = ['zhihu.com', 'xiaohongshu.com', 'douban.com', 'sohu.com', 'baike.baidu.com'].map(
    (domain, index) => ({
      domain,
      count: 11 - index,
      share: (11 - index) / 59,
      typeLabel: domain.includes('baike') ? '百科/知识库' : '社媒/问答',
      reason: '被 AI 引用但没有你的站点',
    }),
  );
  const rows = [
    makeRow({ question: '恒野是做什么的？', verdict: 'not_mentioned', text: '未提及。' }),
    makeRow({ question: '恒野是做什么的？', verdict: 'not_mentioned', text: '未提及。' }),
    makeRow({ question: '恒野收费多少？', verdict: 'not_mentioned', text: '未提及。' }),
    makeRow({ question: '恒野收费多少？', verdict: 'mentioned', text: '推荐恒野。' }),
  ];
  return {
    brand: BRAND,
    score: makeScore({
      total: 20,
      level: '隐形',
      ratio: 0.4,
      ok: 4,
      planned: 10,
      layers: {
        awareness: { score: 1, weight: 20, ok: 2 },
        decision: { score: 2, weight: 40, ok: 1 },
        scenario: { score: 3, weight: 40, ok: 1 },
      },
    }),
    insights: makeInsights({
      sample: { total: 10, ok: 4, mentioned: 1, mentionRate: 0.25 },
      opportunities,
      sov: {
        brandMentions: 1,
        brandShare: 0.1,
        competitors: [{ name: '宇典科技', mentions: 5, share: 0.5 }],
      },
      sentiment: { positive: 0, neutral: 1, negative: 2, score: -0.67 },
    }),
    rows,
    competitors: [{ name: '宇典科技', mentions: 5 }],
  };
}

test('buildActionPlan：覆盖率 30% 时第一条必须是「先修采集」', () => {
  const plan = buildActionPlan({
    brand: BRAND,
    score: makeScore({ total: 18, level: '隐形', ratio: 0.3, ok: 3, planned: 10 }),
    insights: makeInsights({ sample: { total: 10, ok: 3, mentioned: 0, mentionRate: 0 } }),
    rows: [],
    competitors: [],
  });
  assert.equal(plan.top10[0].rank, 1);
  assert.match(plan.top10[0].action, /先修采集/);
  assert.equal(plan.top10[0].effort, '低');
  assert.equal(plan.top10[0].owner, '恒野');
  assert.equal(plan.top10[0].deadline, '3 天内');
  assert.match(plan.top10[0].evidence, /30\.0%/);
});

test('buildActionPlan：隐形品牌的行动里含官网可抓取性（robots / HTTPS / AI UA）', () => {
  const plan = buildActionPlan({
    brand: BRAND,
    score: makeScore({ total: 22.7, level: '隐形', ratio: 0.867 }),
    insights: makeInsights(),
    rows: [],
    competitors: [],
  });
  const crawl = plan.top10.find((item) => /robots/.test(item.action));
  assert.ok(crawl, '应生成官网可抓取性行动');
  assert.match(crawl.action, /HTTPS/);
  assert.match(crawl.action, /AI/);
  assert.match(crawl.action, /audit-site/);
  assert.match(crawl.evidence, /隐形/);
});

test('buildActionPlan：有 opportunities 时按域名生成站点行动，并带被引次数', () => {
  const rows = [
    makeRow({
      text: '推荐恒野，专业靠谱。',
      citations: [
        { title: '知乎讨论', url: 'https://zhihu.example.com/p/1' },
        { title: '知乎另一篇', url: 'https://zhihu.example.com/p/2' },
      ],
    }),
    makeRow({
      text: '恒野这家还可以。',
      citations: [{ title: '小红书笔记', url: 'https://xiaohongshu.example.com/note/1' }],
    }),
  ];
  const insights = analyzeRun({ brand: BRAND, rows });
  const plan = buildActionPlan({
    brand: BRAND,
    score: makeScore({ total: 72, level: '良好', ratio: 1, ok: 2, planned: 2 }),
    insights,
    rows,
    competitors: [],
  });

  const zhihu = plan.top10.find((item) => item.action.includes('zhihu.example.com'));
  assert.ok(zhihu, '应生成 zhihu.example.com 的内容页行动');
  assert.match(zhihu.evidence, /被 AI 引用 2 次/);
  const xhs = plan.top10.find((item) => item.action.includes('xiaohongshu.example.com'));
  assert.ok(xhs, '应生成 xiaohongshu.example.com 的内容页行动');
  assert.equal(plan.generatedFrom.competitorCount, 0);
});

test('buildActionPlan：竞品份额高于本品牌时生成「差异说明」行动（份额相等不触发）', () => {
  const plan = buildActionPlan({
    brand: BRAND,
    score: makeScore({ total: 72, level: '良好', ratio: 1, ok: 10, planned: 10 }),
    insights: makeInsights({
      sample: { total: 10, ok: 10, mentioned: 1, mentionRate: 0.1 },
      sov: {
        brandMentions: 1,
        brandShare: 0.2,
        competitors: [
          { name: '宇典科技', mentions: 3, share: 0.6 },
          { name: '力行文化', mentions: 1, share: 0.2 },
        ],
      },
    }),
    rows: [],
    competitors: [{ name: '宇典科技', mentions: 3 }, { name: '力行文化', mentions: 1 }],
  });

  const diff = plan.top10.find((item) => item.action.includes('差异说明'));
  assert.ok(diff, '应生成差异说明行动');
  assert.match(diff.evidence, /宇典科技/);
  assert.match(diff.evidence, /60\.0%/);
  assert.ok(!diff.evidence.includes('力行文化'), '份额未超过本品牌（0.2 不 > 0.2）的竞品不应写进证据');
});

test('buildActionPlan：有负面情感时生成负面处理行动', () => {
  const plan = buildActionPlan({
    brand: BRAND,
    score: makeScore({ total: 60, level: '中等', ratio: 1, ok: 10, planned: 10 }),
    insights: makeInsights({
      sentiment: { positive: 0, neutral: 1, negative: 2, score: -0.67 },
    }),
    rows: [],
    competitors: [],
  });

  const negative = plan.top10.find((item) => item.action.includes('负面'));
  assert.ok(negative, '应生成负面表述处理行动');
  assert.match(negative.evidence, /负面 2 条/);
  assert.match(negative.action, /核实原话/);
});

test('buildActionPlan：三层分数不同时，点名得分最低的那一层', () => {
  const plan = buildActionPlan({
    brand: BRAND,
    score: {
      total: 66.5,
      level: '中等',
      coverage: { ratio: 1, ok: 5, planned: 5 },
      layers: {
        awareness: { score: 19.5, weight: 20, ok: 5, total: 5 },
        decision: { score: 8, weight: 40, ok: 5, total: 5 },
        scenario: { score: 39, weight: 40, ok: 5, total: 5 },
      },
    },
    insights: makeInsights({
      sample: { total: 5, ok: 5, mentioned: 5, mentionRate: 1 },
      sov: { brandMentions: 5, brandShare: 1, competitors: [] },
      sentiment: { positive: 3, neutral: 2, negative: 0, score: 0.6 },
      opportunities: [],
    }),
    rows: [],
    competitors: [],
  });

  assert.equal(plan.top10.length, 1, '只有最低层规则命中');
  assert.match(plan.top10[0].action, /区域决策层/);
  assert.match(plan.top10[0].evidence, /8\.0/);
  assert.match(plan.top10[0].evidence, /\/ 40/);
  assert.match(plan.top10[0].evidence, /三层中最低/);
});

test('buildActionPlan：规则全触发时 top10 不超过 10 条，rank 连续 1..n', () => {
  const plan = buildActionPlan(makeCapFixture());
  assert.equal(plan.top10.length, 10);
  assert.deepEqual(
    plan.top10.map((item) => item.rank),
    Array.from({ length: 10 }, (_, index) => index + 1),
  );
  assert.match(plan.top10[0].action, /先修采集/, '覆盖率不足永远排第一');
});

test('buildActionPlan：30 天计划恰好 4 周、每周 2-4 个任务，第 1 周修采集、第 4 周复测对比', () => {
  const plan = buildActionPlan(makeCapFixture());
  assert.equal(plan.days30.length, 4);
  assert.deepEqual(plan.days30.map((week) => week.week), ['第1周', '第2周', '第3周', '第4周']);

  for (const week of plan.days30) {
    assert.ok(Array.isArray(week.tasks));
    assert.ok(week.tasks.length >= 2 && week.tasks.length <= 4, `${week.week} 应有 2-4 个任务`);
    assert.ok(week.goal.length > 0, `${week.week} 应有周目标`);
  }

  const week1 = plan.days30[0];
  assert.match(week1.goal, /修复阻塞项/);
  assert.match(week1.goal, /采集复跑/);
  assert.match(week1.tasks.join('\n'), /复跑/);

  const week4 = plan.days30[3];
  const week4Text = week4.tasks.join('\n');
  assert.match(week4Text, /复测同题/);
  assert.match(week4Text, /基线/);

  assert.ok(plan.risks.length >= 2 && plan.risks.length <= 4, '风险提示应 2-4 条');
});

test('buildActionPlan：空输入不崩，返回空 plan；渲染给出「样本不足」提示', () => {
  for (const plan of [buildActionPlan(), buildActionPlan({}), buildActionPlan({ brand: BRAND })]) {
    assert.deepEqual(plan.top10, []);
    assert.deepEqual(plan.days30, []);
    assert.deepEqual(plan.risks, []);
    assert.deepEqual(plan.generatedFrom, {
      total: 0,
      coverage: 0,
      mentionedRate: 0,
      competitorCount: 0,
    });
  }
  assert.equal(renderActionPlanMarkdown(buildActionPlan()), '样本不足，暂不生成行动清单');
  assert.equal(renderActionPlanMarkdown(null), '样本不足，暂不生成行动清单');
});

test('buildActionPlan：每条行动的 evidence 非空且含数字，枚举字段合法', () => {
  const plan = buildActionPlan(makeCapFixture());
  for (const item of plan.top10) {
    assert.ok(item.action.length > 0);
    assert.ok(item.why.length > 0, 'why 不能为空');
    assert.ok(item.evidence.length > 0, 'evidence 不能为空');
    assert.match(item.evidence, /\d/, `evidence 必须含具体数字：${item.evidence}`);
    assert.ok(['低', '中', '高'].includes(item.effort), `effort 非法：${item.effort}`);
    assert.ok(['恒野', '客户', '双方'].includes(item.owner), `owner 非法：${item.owner}`);
    assert.match(item.deadline, /^\d+ (天|周)内$/, `deadline 格式不对：${item.deadline}`);
  }
});

test('buildActionPlan：纯函数，同输入两次 deepEqual，且不修改入参', () => {
  const args = makeCapFixture();
  const snapshot = JSON.stringify(args);
  const first = buildActionPlan(args);
  const second = buildActionPlan(args);
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.notEqual(first.top10, second.top10);
  assert.equal(JSON.stringify(args), snapshot, '构建过程不应修改入参');
});

test('renderActionPlanMarkdown：包含 Top10 / 30 天计划 / 风险提示三个小节且行格式正确', () => {
  const plan = buildActionPlan(makeCapFixture());
  const markdown = renderActionPlanMarkdown(plan);

  assert.match(markdown, /^## Top10 行动$/m);
  assert.match(markdown, /^## 30 天计划$/m);
  assert.match(markdown, /^## 风险提示$/m);
  assert.match(markdown, /^### 第1周 · /m);
  assert.match(markdown, /^### 第4周 · /m);

  const actionLines = markdown.split('\n').filter((line) => /^\d+\. \[P[012]\] /.test(line));
  assert.equal(actionLines.length, plan.top10.length);
  assert.match(
    actionLines[0],
    /^1\. \[P0\] .+ —— .+（.+） · (恒野|客户|双方) · \d+ (天|周)内$/,
    '每条应为「[优先级] 行动 —— 为什么（证据） · 谁做 · 多久」',
  );
  assert.ok(markdown.split('\n').filter((line) => line.startsWith('- ')).length >= 10);
});

test('buildActionPlan：generatedFrom 如实记录审计字段', () => {
  const plan = buildActionPlan({
    brand: BRAND,
    score: makeScore({ total: 20, level: '隐形', ratio: 0.4, ok: 4, planned: 10 }),
    insights: makeInsights({ sample: { total: 30, ok: 26, mentioned: 8, mentionRate: 0.3077 } }),
    rows: [],
    competitors: [{ name: '宇典科技', mentions: 5 }, { name: '力行文化', mentions: 2 }],
  });
  assert.deepEqual(plan.generatedFrom, {
    total: 30,
    coverage: 0.4,
    mentionedRate: 0.3077,
    competitorCount: 2,
  });
});

test('buildActionPlan：未提及占比最高的两道题各生成一条事实型内容行动', () => {
  const rows = [
    makeRow({ question: '恒野是做什么的？', verdict: 'not_mentioned', text: '未提及。' }),
    makeRow({ question: '恒野是做什么的？', verdict: 'not_mentioned', text: '未提及。' }),
    makeRow({ question: '恒野收费多少？', verdict: 'not_mentioned', text: '未提及。' }),
    makeRow({ question: '恒野收费多少？', verdict: 'mentioned', text: '推荐恒野。' }),
  ];
  const plan = buildActionPlan({
    brand: BRAND,
    score: {
      total: 50,
      level: '偏弱',
      coverage: { ratio: 1, ok: 4, planned: 4 },
      layers: {
        awareness: { score: null, weight: 20, ok: 0 },
        decision: { score: null, weight: 40, ok: 0 },
        scenario: { score: null, weight: 40, ok: 0 },
      },
    },
    insights: makeInsights({
      sample: { total: 4, ok: 4, mentioned: 1, mentionRate: 0.25 },
      sov: { brandMentions: 1, brandShare: 0.5, competitors: [] },
      sentiment: { positive: 0, neutral: 1, negative: 0, score: 0 },
      opportunities: [],
    }),
    rows,
    competitors: [],
  });

  assert.equal(plan.top10.length, 2);
  assert.match(plan.top10[0].action, /恒野是做什么的？/);
  assert.match(plan.top10[0].evidence, /100\.0%/);
  assert.match(plan.top10[1].action, /恒野收费多少？/);
  assert.match(plan.top10[1].evidence, /50\.0%/);
  assert.match(plan.top10[0].action, /事实型内容/);
});

test('buildActionPlan：所有规则都不命中时走 baseline（llms.txt + Organization JSON-LD）', () => {
  const plan = buildActionPlan({
    brand: BRAND,
    score: {
      total: null,
      level: '样本不足',
      coverage: { ratio: 1, ok: 5, planned: 5 },
      layers: {
        awareness: { score: null, weight: 20, ok: 0 },
        decision: { score: null, weight: 40, ok: 0 },
        scenario: { score: null, weight: 40, ok: 0 },
      },
    },
    insights: makeInsights({
      sample: { total: 5, ok: 5, mentioned: 5, mentionRate: 1 },
      sov: { brandMentions: 5, brandShare: 1, competitors: [] },
      sentiment: { positive: 5, neutral: 0, negative: 0, score: 1 },
      opportunities: [],
    }),
    rows: [],
    competitors: [],
  });

  assert.equal(plan.top10.length, 1);
  assert.match(plan.top10[0].action, /llms\.txt/);
  assert.match(plan.top10[0].action, /Organization JSON-LD/);
  assert.match(plan.top10[0].evidence, /\d/);
  assert.equal(plan.days30.length, 4);
});
