// 测试：客户周报的输入映射与渲染（与 lib/weekly.js 的契约）。
// 用构造数据，不读数据库、不发网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWeeklyReport, renderWeeklyMarkdown, renderWeeklyHtml } from '../lib/weekly.js';

const brand = { name: '演示品牌', city: '芜湖' };
const runs = [
  { runId: 3, kind: 'live', status: 'done', samples: 12, total: 5.0, level: '隐形', startedAt: '2026-10-26T00:00:00Z' },
  { runId: 2, kind: 'live', status: 'done', samples: 12, total: 4.8, level: '隐形', startedAt: '2026-10-19T00:00:00Z' },
];
const insights = {
  score: { total: 5.0, level: '隐形' },
  sample: { ok: 12, total: 12, mentionRate: 0.42 },
  citations: { total: 9, uniqueDomains: 5, ownShare: 0, byDomain: [{ domain: 'zhihu.com', typeLabel: '社媒', share: 0.33, count: 3 }] },
  sov: { brandShare: 0.3, brandMentions: 5, competitors: [{ name: '竞品A', share: 0.5, mentions: 6 }] },
  sentiment: { positive: 2, neutral: 8, negative: 0, score: 0.2 },
  engines: [{ engine: 'deepseek', answers: 12, ok: 12, mentioned: 5, mentionRate: 0.42 }],
  verdictCounts: { mentioned: 5, not_mentioned: 7 },
  fanout: { unique: 20, top: [] },
  sameNameThreats: [{ message: '同名实体被引用 1 次' }],
};
const previous = {
  score: { total: 4.8, level: '隐形' },
  sample: { ok: 12, total: 12, mentionRate: 0.25 },
  citations: { total: 2, uniqueDomains: 2, ownShare: 0, byDomain: [] },
  sov: { brandShare: 0.2, brandMentions: 2, competitors: [] },
  sentiment: { positive: 0, neutral: 10, negative: 0, score: 0 },
  engines: [],
  verdictCounts: {},
  fanout: { unique: 0, top: [] },
  sameNameThreats: [],
};

test('周报：标题含品牌与周期', () => {
  const report = buildWeeklyReport({ brand, runs, insights, previous, generatedAt: '2026-10-26T00:00:00Z' });
  assert.match(report.title, /演示品牌/);
  assert.match(report.title, /\d{4}-\d{2}-\d{2}/);
});

test('周报：有对比时 headline 报出变化，不再是「首轮基线」', () => {
  const report = buildWeeklyReport({ brand, runs, insights, previous, generatedAt: '2026-10-26T00:00:00Z' });
  assert.doesNotMatch(report.summary.headline, /首轮基线/);
  assert.ok(report.summary.mentionDelta >= 16 && report.summary.mentionDelta <= 18, `delta 应在 17 附近，实际 ${report.summary.mentionDelta}`);
  assert.match(report.summary.headline, /17|上升/);
});

test('周报：提及率上升被识别为 up 类亮点', () => {
  const report = buildWeeklyReport({ brand, runs, insights, previous, generatedAt: '2026-10-26T00:00:00Z' });
  assert.ok(report.highlights.some((h) => h.type === 'up'), '应有一条上升亮点');
  assert.ok(report.highlights.length >= 3);
});

test('周报：自有引用为 0 与同名威胁进入风险', () => {
  const report = buildWeeklyReport({ brand, runs, insights, previous, generatedAt: '2026-10-26T00:00:00Z' });
  assert.ok(report.risks.some((r) => r.title.includes('引用') || r.detail.includes('引用')));
  assert.ok(report.risks.some((r) => r.title.includes('同名') || r.detail.includes('同名')));
});

test('周报：行动来自 plan.top10，不足则兜底', () => {
  const withPlan = buildWeeklyReport({
    brand, runs, insights, previous,
    plan: { top10: [{ rank: 1, action: 'A', why: 'B', owner: 'C', deadline: 'D' }] },
    generatedAt: '2026-10-26T00:00:00Z',
  });
  assert.equal(withPlan.actions[0].action, 'A');
  const noPlan = buildWeeklyReport({ brand, runs, insights, previous, generatedAt: '2026-10-26T00:00:00Z' });
  assert.ok(noPlan.actions.length >= 3, '没 plan 时应有兜底行动');
});

test('周报：数据质量警告区分 mock / 样本少 / 无对比', () => {
  const oneRun = buildWeeklyReport({ brand, runs: [runs[0]], insights, previous: null, generatedAt: '2026-10-26T00:00:00Z' });
  assert.match(oneRun.dataQuality.warning, /1 轮|只有/);
  const mockRun = { ...runs[0], kind: 'mock' };
  const mockReport = buildWeeklyReport({ brand, runs: [mockRun, runs[1]], insights, previous, generatedAt: '2026-10-26T00:00:00Z' });
  assert.match(mockReport.dataQuality.warning, /演示/);
});

test('周报：Markdown 含关键小节，且不出现 undefined', () => {
  const md = renderWeeklyMarkdown(buildWeeklyReport({ brand, runs, insights, previous, generatedAt: '2026-10-26T00:00:00Z' }));
  for (const section of ['# ', '关键指标', '本周亮点', '风险与处置', '本周行动', '下周计划']) {
    assert.ok(md.includes(section), `缺少 ${section}`);
  }
  assert.equal(md.includes('undefined'), false);
});

test('周报：HTML 自包含且转义注入', () => {
  const html = renderWeeklyHtml(
    buildWeeklyReport({
      brand: { name: '<script>alert(1)</script>' },
      runs, insights, previous,
      generatedAt: '2026-10-26T00:00:00Z',
    }),
  );
  assert.ok(html.includes('<style') && html.includes('wk-wrap'), '应是自包含片段（内联样式 + 容器）');
  assert.equal(html.includes('<script>alert(1)</script>'), false, '不得原样输出注入脚本');
  assert.ok(!html.includes('<script>alert'), '不得包含未转义脚本');
});

test('周报：确定性（同输入同输出）', () => {
  const a = buildWeeklyReport({ brand, runs, insights, previous, generatedAt: '2026-10-26T00:00:00Z' });
  const b = buildWeeklyReport({ brand, runs, insights, previous, generatedAt: '2026-10-26T00:00:00Z' });
  assert.deepEqual(a, b);
});

test('周报：空输入不崩', () => {
  const report = buildWeeklyReport({});
  assert.ok(report.title.includes('周报'));
  assert.ok(Array.isArray(report.highlights));
  assert.ok(Array.isArray(report.actions));
});
