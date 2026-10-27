// 测试：v2 核心模块（数据/引擎/判定/评分/计划/内容/交付/流程）
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/db.js';
import { mockAnswer, engineReady, collectCitations, responseText } from '../lib/engines.js';
import { judgeAnswer, analyzeRows, scoreOf, buildActions } from '../lib/analyze.js';
import { buildDeliveryPlan, renderPlanMarkdown } from '../lib/plan.js';
import { buildBrief, buildDraft } from '../lib/content.js';
import { renderReportHtml, renderWeeklyMarkdown, createShareToken } from '../lib/deliver.js';
import { runDiagnose, ensurePlan, collectCycle, generateContent, generateDeliverables } from '../lib/pipeline.js';
import { hashPassword, verifyPassword, newToken } from '../lib/auth.js';

const client = { name: '演示家政', industry: '家政', city: '芜湖', competitors: ['同行A'], facts: { legalName: '演示家政有限公司', rejectedNames: ['芜湖同行A家政'] } };

const makeStore = () => new Store(':memory:');

// ---------------------------------------------------------------- db

test('db：客户/周期/运行/回答/任务/内容/发布 全链路可写读', () => {
  const s = makeStore();
  const c = s.upsertClient({ slug: 'demo', name: '演示', industry: '家政' });
  assert.equal(c.slug, 'demo');
  const cycle = s.currentCycle(c.id, '2026-10');
  assert.equal(cycle.period, '2026-10');
  const runId = s.createRun({ cycleId: cycle.id, engine: 'mock', questions: ['q1'] });
  s.saveAnswer({ runId, question: 'q1', engine: 'mock', text: '演示家政不错', verdict: 'mentioned', citations: [{ url: 'https://a.cn' }] });
  s.finishRun(runId);
  assert.equal(s.listRunRows(runId).length, 1);
  s.seedTasks(cycle.id, [{ step: 'plan', title: '出方案' }]);
  assert.equal(s.listTasks(cycle.id).length, 1);
  const contentId = s.createContent({ cycleId: cycle.id, title: 't', body: 'b' });
  s.addPublish({ contentId, channel: '公众号', url: 'https://x.cn/a' });
  assert.equal(s.listPublishes(cycle.id).length, 1);
  s.close();
});

test('db：同一客户同一周期不会重复创建', () => {
  const s = makeStore();
  const c = s.upsertClient({ slug: 'a', name: 'A' });
  const first = s.currentCycle(c.id, '2026-10');
  const second = s.currentCycle(c.id, '2026-10');
  assert.equal(first.id, second.id);
  s.close();
});

test('db：会话与设置', () => {
  const s = makeStore();
  s.setSetting('title', '测试系统');
  assert.equal(s.getSetting('title'), '测试系统');
  const token = newToken();
  s.createSession({ token, username: 'admin' });
  assert.equal(s.getSession(token).username, 'admin');
  s.deleteSession(token);
  assert.equal(s.getSession(token), null);
  s.close();
});

test('auth：密码哈希与校验', () => {
  const hash = hashPassword('pass1234');
  assert.ok(verifyPassword('pass1234', hash));
  assert.equal(verifyPassword('wrong', hash), false);
});

// ---------------------------------------------------------------- engines

test('engines：mock 回答确定性（同问题同答案）', () => {
  const a = mockAnswer({ question: '家政哪家好', client });
  const b = mockAnswer({ question: '家政哪家好', client });
  assert.deepEqual(a, b);
});

test('engines：未配置密钥时明确不可用', () => {
  assert.equal(engineReady('deepseek', {}).ready, false);
  assert.match(engineReady('deepseek', {}).reason, /DEEPSEEK_API_KEY/);
  assert.equal(engineReady('mock', {}).ready, true);
});

test('engines：引用解析三种格式', () => {
  const citations = collectCitations({
    citations: ['https://a.cn'],
    search_results: [{ url: 'https://b.cn', title: 'B' }],
    choices: [{ message: { annotations: [{ url_citation: { url: 'https://c.cn' } }] } }],
  });
  assert.equal(citations.length, 3);
  assert.equal(citations[0].url, 'https://a.cn');
});

test('engines：正文字段兼容', () => {
  assert.equal(responseText({ choices: [{ message: { content: 'hi' } }] }), 'hi');
  assert.equal(responseText({ output_text: 'yo' }), 'yo');
});

// ---------------------------------------------------------------- analyze

test('judge：未提及 / 提及 / 推荐 / 歧义', () => {
  assert.equal(judgeAnswer({ text: '不知道', client }).verdict, 'not_mentioned');
  assert.equal(judgeAnswer({ text: '演示家政是一家公司', client }).verdict, 'mentioned');
  assert.equal(judgeAnswer({ text: '推荐演示家政，服务不错', client }).verdict, 'recommended');
  assert.equal(judgeAnswer({ text: '芜湖同行A家政还行', client }).verdict, 'ambiguous');
});

test('judge：空回答判为采集失败', () => {
  assert.equal(judgeAnswer({ text: '', client }).verdict, 'engine_error');
});

test('analyzeRows：提及率与判定分布、引用域名', () => {
  const rows = [
    { text: '推荐演示家政', citations: [{ url: 'https://zhihu.com/a' }], verdict: 'recommended', engine: 'mock' },
    { text: '不知道', citations: [{ url: 'https://zhihu.com/b' }], verdict: 'not_mentioned', engine: 'mock' },
    { text: '芜湖同行A家政', citations: [], verdict: 'ambiguous', engine: 'mock' },
  ];
  const analysis = analyzeRows({ rows, client });
  assert.equal(analysis.sample.total, 2, '歧义不进分母');
  assert.equal(analysis.sample.mentionRate, 0.5);
  assert.equal(analysis.citations.domains[0].domain, 'zhihu.com');
});

test('scoreOf：无样本不出分', () => {
  const score = scoreOf(analyzeRows({ rows: [], client }));
  assert.equal(score.total, null);
  assert.equal(score.level, '样本不足');
});

test('scoreOf：全推荐拿高分', () => {
  const rows = Array.from({ length: 5 }, () => ({ text: '推荐演示家政', verdict: 'recommended', citations: [{ url: 'https://a.cn/x' }, { url: 'https://b.cn/x' }], engine: 'mock' }));
  const score = scoreOf(analyzeRows({ rows, client }));
  assert.ok(score.total >= 90, `实际 ${score.total}`);
  assert.equal(score.level, '好');
});

test('buildActions：提及率低时先补实体', () => {
  const actions = buildActions({ analysis: analyzeRows({ rows: [{ text: '不知道', verdict: 'not_mentioned', citations: [] }], client }), client });
  assert.ok(actions.some((action) => action.includes('全称')));
});

// ---------------------------------------------------------------- plan / content / deliver

test('plan：六步待办 + 渲染含验收口径', () => {
  const plan = buildDeliveryPlan({ client, analysis: { sample: { total: 5, mentionRate: 0.4 } }, actions: ['a', 'b', 'c'], period: '2026-10' });
  assert.ok(plan.tasks.length >= 6);
  assert.ok(['diagnose', 'plan', 'content', 'publish', 'remeasure', 'deliver'].every((step) => plan.steps.some((s) => s.id === step)));
  const md = renderPlanMarkdown({ client, analysis: { sample: { total: 5, mentionRate: 0.4 } }, actions: ['a'], period: '2026-10' });
  assert.match(md, /验收口径/);
});

test('content：brief 有结构，draft 含 FAQ 与实体块', () => {
  const brief = buildBrief({ client, question: '家政哪家好' });
  assert.ok(brief.outline.length >= 5);
  const draft = buildDraft({ brief, client });
  assert.match(draft.body, /常见问题/);
  assert.match(draft.body, /演示家政有限公司/);
  assert.ok(draft.body.length > 300);
});

test('deliver：报告自包含、周报含指标、token 32 位', () => {
  const analysis = analyzeRows({ rows: [{ text: '推荐演示家政', verdict: 'recommended', citations: [{ url: 'https://a.cn' }], engine: 'mock' }], client });
  const html = renderReportHtml({ client, cycle: { period: '2026-10' }, analysis, score: { total: 70, level: '好' }, actions: ['a'] });
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /演示家政/);
  const weekly = renderWeeklyMarkdown({ client, analysis, score: { total: 70, level: '好' }, actions: ['a'], period: '2026-10' });
  assert.match(weekly, /关键指标/);
  assert.equal(createShareToken().length, 32);
});

// ---------------------------------------------------------------- pipeline

test('pipeline：mock 诊断 → 分析 → 评分 → 待办', async () => {
  const s = makeStore();
  const c = s.upsertClient({ slug: 'demo', name: '演示家政', industry: '家政', city: '芜湖', competitors: ['同行A'], facts: { legalName: '演示家政有限公司' } });
  const cycle = s.currentCycle(c.id, '2026-10');
  const result = await runDiagnose({ store: s, cycleId: cycle.id, client: c, engine: 'mock', limit: 5, env: {} });
  assert.equal(result.analysis.sample.total, 5);
  assert.ok(Number.isFinite(result.score.total));
  const tasks = ensurePlan({ store: s, cycleId: cycle.id });
  assert.ok(tasks.length >= 6);
  assert.equal(tasks[0].status, 'done');
  s.close();
});

test('pipeline：生成内容与交付物（报告 + 分享 token）', async () => {
  const s = makeStore();
  const c = s.upsertClient({ slug: 'demo2', name: '演示2', industry: '家政', city: '芜湖' });
  const cycle = s.currentCycle(c.id, '2026-10');
  await runDiagnose({ store: s, cycleId: cycle.id, client: c, engine: 'mock', limit: 3, env: {} });
  const content = generateContent({ store: s, cycleId: cycle.id });
  assert.ok(content.id > 0);
  const out = generateDeliverables({ store: s, cycleId: cycle.id, dataDir: '/tmp/geo-v2-test', shareToken: createShareToken });
  assert.ok(out.file.endsWith('.html'));
  assert.equal(out.token.length, 32);
  const collected = collectCycle({ store: s, cycleId: cycle.id, client: c });
  assert.ok(collected.rows.length >= 3);
  s.close();
});

test('pipeline：不支持的引擎直接报错', async () => {
  const s = makeStore();
  const c = s.upsertClient({ slug: 'x', name: 'X' });
  const cycle = s.currentCycle(c.id, '2026-10');
  await assert.rejects(() => runDiagnose({ store: s, cycleId: cycle.id, client: c, engine: 'nope', env: {} }), /引擎不可用/);
  s.close();
});
