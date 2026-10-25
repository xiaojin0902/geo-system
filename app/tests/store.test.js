// 测试：lib/store.js（SQLite schema + DAO）。
// 全部使用 mkdtemp 临时库文件，绝不触碰 app/data/geo.db；每个用例独立建库，结束删除。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hengye-store-'));
  const store = openStore(path.join(dir, 'test.db'));
  t.after(() => {
    try {
      store.close();
    } catch {
      /* 已关闭 */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

const BRAND = {
  slug: 'hengye',
  name: '恒野',
  legalName: '芜湖恒野数字科技有限公司',
  aliases: ['恒野', '芜湖恒野'],
  rejectedNames: ['叁人行'],
  ambiguousAliases: ['恒野'],
  city: '芜湖',
  scope: '全国线上交付',
  industry: '内容代运营',
  services: ['内容代运营', 'GEO 优化'],
  targetCustomers: ['本地商家'],
  priceRange: '299-98000 元',
  competitors: ['宇典科技'],
  urls: ['http://sanrenxing.cn'],
  differentiators: ['先诊断再交付'],
  evidenceFacts: ['工作日 10:00-19:00 在线'],
  contentRules: { bannedWords: ['最好'] },
  contact: { email: 'hi@sanrenxing.cn' },
};

function seedBrand(store) {
  const brandId = store.upsertBrand(BRAND);
  const questionIds = ['A', 'B', 'C'].map(
    (text, index) => {
      const tier = ['brand_awareness', 'super_tier1', 'regional_industry'][index];
      const priority = index === 1 ? 'P2' : 'P0';
      return { text, tier, priority };
    },
  );
  store.seedQuestions(brandId, questionIds);
  return brandId;
}

test('initSchema 建出 SPEC 全部表，并开启 WAL / 外键', (t) => {
  const store = makeStore(t);
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC")
    .all()
    .map((row) => row.name);
  const expected = [
    'answers',
    'brands',
    'contents',
    'judgments',
    'keywords',
    'monitoring',
    'publications',
    'questions',
    'runs',
    'scores',
  ];
  for (const name of expected) assert.ok(tables.includes(name), `缺少表 ${name}`);
  assert.equal(Number(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys), 1);
  assert.match(String(store.db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), /wal/);
  // 外键真的生效：不存在的 run 不能写 answer
  assert.throws(
    () => store.saveAnswer({ runId: 999, questionId: 1, engine: 'mock', text: 'x', status: 'ok' }),
    /FOREIGN KEY/i,
  );
});

test('upsertBrand 幂等，getBrand 反序列化全部 JSON 字段', (t) => {
  const store = makeStore(t);
  const firstId = store.upsertBrand(BRAND);
  const secondId = store.upsertBrand({ ...BRAND, name: '恒野工作室' });
  assert.equal(firstId, secondId, 'slug 相同应复用同一行');

  const brand = store.getBrand('hengye');
  assert.equal(brand.id, firstId);
  assert.equal(brand.name, '恒野工作室');
  assert.equal(brand.legalName, '芜湖恒野数字科技有限公司');
  assert.deepEqual(brand.aliases, ['恒野', '芜湖恒野']);
  assert.deepEqual(brand.rejectedNames, ['叁人行']);
  assert.deepEqual(brand.ambiguousAliases, ['恒野']);
  assert.deepEqual(brand.competitors, ['宇典科技']);
  assert.deepEqual(brand.services, ['内容代运营', 'GEO 优化']);
  assert.deepEqual(brand.urls, ['http://sanrenxing.cn']);
  assert.deepEqual(brand.targetCustomers, ['本地商家']);
  assert.deepEqual(brand.differentiators, ['先诊断再交付']);
  assert.deepEqual(brand.evidenceFacts, ['工作日 10:00-19:00 在线']);
  assert.deepEqual(brand.contentRules, { bannedWords: ['最好'] });
  assert.deepEqual(brand.contact, { email: 'hi@sanrenxing.cn' });
  assert.equal(brand.priceRange, '299-98000 元');
  assert.match(brand.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(store.getBrand('不存在'), null);
  assert.equal(store.listBrands().length, 1);
});

test('seedQuestions 按 (brand_id,text) 去重，listQuestions 按 P0 优先', (t) => {
  const store = makeStore(t);
  const brandId = store.upsertBrand(BRAND);
  const questions = [
    { text: '恒野是做什么的？', intent: '发现', tier: 'brand_awareness', priority: 'P2', source: 'seed' },
    { text: '芜湖内容代运营推荐', intent: '推荐', tier: 'regional_industry', priority: 'P0', source: 'seed' },
    { text: '恒野和叁人行是什么关系？', intent: '发现', tier: 'brand_awareness', priority: 'P0', source: 'seed' },
    { text: '恒野是做什么的？', intent: '发现', tier: 'brand_awareness', priority: 'P2', source: 'seed' }, // 同批重复
  ];
  assert.equal(store.seedQuestions(brandId, questions), 3, '同批重复应被去重');
  assert.equal(store.seedQuestions(brandId, questions), 0, '重复 seed 不应新增');
  assert.equal(store.seedQuestions(brandId, [{ text: '新增题目', priority: 'P1' }]), 1);

  const all = store.listQuestions(brandId);
  assert.equal(all.length, 4);
  assert.deepEqual(
    all.slice(0, 2).map((question) => question.priority),
    ['P0', 'P0'],
  );
  const p0 = store.listQuestions(brandId, { priority: 'P0' });
  assert.equal(p0.length, 2);
  assert.equal(p0[0].text, '芜湖内容代运营推荐');
  assert.equal(p0[0].brandId, brandId);
});

test('run / answer / judgment / score 全链路落库可读', (t) => {
  const store = makeStore(t);
  const brandId = seedBrand(store);
  const questions = store.listQuestions(brandId);

  const runId = store.createRun({ brandId, kind: 'demo', engineSet: 'mock', plannedN: 3 });
  assert.ok(Number.isInteger(runId) && runId > 0);
  const running = store.getRun(runId);
  assert.equal(running.status, 'running');
  assert.equal(running.kind, 'demo');
  assert.equal(running.engineSet, 'mock');
  assert.equal(running.plannedN, 3);
  assert.equal(running.okN, 0);
  assert.match(running.startedAt, /^\d{4}-\d{2}-\d{2}T/);

  const answerId = store.saveAnswer({
    runId,
    questionId: questions[0].id,
    engine: 'mock',
    text: '推荐恒野，芜湖本地内容工作室。',
    citations: [{ title: '示例引用', url: 'https://example.com/demo/1' }],
    status: 'ok',
    latencyMs: 42,
  });
  assert.ok(Number.isInteger(answerId) && answerId > 0);

  // 同一 answer 的判定应覆盖（answer_id UNIQUE）
  store.saveJudgment(answerId, {
    verdict: 'mentioned',
    matchedText: '恒野',
    method: 'exact',
    confidence: 0.6,
    reasons: ['命中品牌名'],
  });
  store.saveJudgment(answerId, {
    verdict: 'recommended',
    matchedText: '推荐恒野',
    method: 'heuristic',
    confidence: 0.8,
    reasons: ['命中推荐语境', '命中品牌名'],
  });

  store.finishRun(runId, { status: 'done', okN: 1 });
  const finished = store.getRun(runId);
  assert.equal(finished.status, 'done');
  assert.equal(finished.okN, 1);
  assert.ok(finished.finishedAt);

  const detail = store.getRunDetail(runId);
  assert.equal(detail.run.id, runId);
  assert.equal(detail.brand.slug, 'hengye');
  assert.equal(detail.rows.length, 1);
  const [row] = detail.rows;
  assert.equal(row.question.text, questions[0].text);
  assert.equal(row.answer.engine, 'mock');
  assert.equal(row.answer.status, 'ok');
  assert.equal(row.answer.text, '推荐恒野，芜湖本地内容工作室。');
  assert.deepEqual(row.answer.citations, [{ title: '示例引用', url: 'https://example.com/demo/1' }]);
  assert.equal(row.judgment.verdict, 'recommended');
  assert.equal(row.judgment.matchedText, '推荐恒野');
  assert.deepEqual(row.judgment.reasons, ['命中推荐语境', '命中品牌名']);

  store.saveScore(runId, {
    layers: { awareness: { ok: 1, hits: 1, weighted: 20, score: 20 } },
    total: null,
    level: '样本不足',
    coverage: { planned: 3, ok: 1, ratio: 1 / 3 },
  });
  const score = store.getScore(runId);
  assert.equal(score.runId, runId);
  assert.equal(score.total, null);
  assert.equal(score.level, '样本不足');
  assert.equal(score.coverage.planned, 3);
  assert.deepEqual(score.layers, { awareness: { ok: 1, hits: 1, weighted: 20, score: 20 } });

  // 覆盖写评分
  store.saveScore(runId, { layers: {}, total: 66.6, level: '中等', coverage: { planned: 3, ok: 2, ratio: 2 / 3 } });
  assert.equal(store.getScore(runId).total, 66.6);

  assert.equal(store.listRuns(brandId).length, 1);
  assert.equal(store.listRuns(brandId)[0].id, runId);
  assert.equal(store.getRunDetail(9999), null);
  assert.equal(store.getRun(9999), null);
});

test('keywords 按 term 幂等 upsert，可按 priority 过滤', (t) => {
  const store = makeStore(t);
  const brandId = store.upsertBrand(BRAND);
  const firstId = store.upsertKeyword(brandId, {
    term: '芜湖内容代运营',
    cluster: '本地推荐',
    intent: '推荐',
    difficulty: 3,
    priority: 'P0',
    note: '首轮',
  });
  const secondId = store.upsertKeyword(brandId, {
    term: '芜湖内容代运营',
    cluster: '本地推荐',
    intent: '推荐',
    difficulty: 5,
    priority: 'P1',
    note: '更新',
  });
  assert.equal(firstId, secondId);
  store.upsertKeyword(brandId, { term: 'GEO 优化价格', cluster: '价格费用', intent: '价格', difficulty: 2, priority: 'P0' });

  const all = store.listKeywords(brandId);
  assert.equal(all.length, 2);
  const updated = all.find((keyword) => keyword.term === '芜湖内容代运营');
  assert.equal(updated.difficulty, 5);
  assert.equal(updated.priority, 'P1');
  assert.equal(updated.note, '更新');
  assert.equal(store.listKeywords(brandId, { priority: 'P0' }).length, 1);
});

test('contents / publications：状态更新与 dry_run 默认值', (t) => {
  const store = makeStore(t);
  const brandId = seedBrand(store);
  const [question] = store.listQuestions(brandId);
  const keywordId = store.upsertKeyword(brandId, { term: '芜湖 GEO 优化', priority: 'P0' });

  const contentId = store.createContent({
    brandId,
    keywordId,
    questionId: question.id,
    title: '芜湖 GEO 优化怎么做',
    format: '指南',
    status: 'draft',
    brief: { outline: [{ h2: '证据与来源', points: [] }] },
    bodyMd: '# 正文',
  });
  const contents = store.listContents(brandId);
  assert.equal(contents.length, 1);
  assert.equal(contents[0].id, contentId);
  assert.equal(contents[0].status, 'draft');
  assert.deepEqual(contents[0].brief, { outline: [{ h2: '证据与来源', points: [] }] });
  assert.equal(contents[0].bodyMd, '# 正文');

  store.updateContentStatus(contentId, 'published');
  assert.equal(store.listContents(brandId)[0].status, 'published');

  const publicationId = store.createPublication({ contentId, channel: '知乎专栏', url: null });
  const publication = store.db.prepare('SELECT * FROM publications WHERE id = ?').get(publicationId);
  assert.equal(publication.content_id, contentId);
  assert.equal(publication.channel, '知乎专栏');
  assert.equal(publication.status, 'dry_run');
  assert.equal(publication.url, null);
});

test('monitoringTrend 按题目+引擎聚合，days 过滤生效', (t) => {
  const store = makeStore(t);
  const brandId = seedBrand(store);
  const [questionA, questionB] = store.listQuestions(brandId);
  const iso = (offsetDays) => new Date(Date.now() - offsetDays * DAY_MS).toISOString();

  store.saveMonitoringCheck({ brandId, questionId: questionA.id, engine: 'mock', verdict: 'not_mentioned', checkedAt: iso(2) });
  store.saveMonitoringCheck({ brandId, questionId: questionA.id, engine: 'mock', verdict: 'recommended', checkedAt: iso(0) });
  store.saveMonitoringCheck({ brandId, questionId: questionA.id, engine: 'deepseek', verdict: 'mentioned', checkedAt: iso(1) });
  store.saveMonitoringCheck({ brandId, questionId: questionB.id, engine: 'mock', verdict: 'not_mentioned', checkedAt: iso(60) });

  const trend = store.monitoringTrend(brandId, 30);
  assert.equal(trend.length, 2, '60 天前的记录应被 days=30 过滤掉');
  assert.equal(trend[0].questionText, questionA.text);
  assert.equal(trend[0].engine, 'deepseek');
  assert.equal(trend[0].questionId, questionA.id);
  assert.equal(trend[1].engine, 'mock');
  assert.deepEqual(
    trend[1].checks.map((check) => check.verdict),
    ['not_mentioned', 'recommended'],
    '同组记录按时间升序',
  );

  assert.equal(store.monitoringTrend(brandId, 90).length, 3, 'days=90 应包含更早记录');
});
