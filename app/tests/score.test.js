/**
 * tests/score.test.js
 * 覆盖：三层 20/40/40 计算、命中分折算、unknown/ambiguous/refused/engine_error 不进分母、
 * 覆盖率 < 50% 与有效层不足不出总分、6 档等级 + 样本不足、missing 兜底。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { LAYERS, scoreRun, tierToLayer, totalToLevel } from '../lib/score.js';

let nextQuestionId = 1;

function question(tier) {
  return { id: nextQuestionId++, text: `题目 ${nextQuestionId}`, intent: '发现', tier, priority: 'P0' };
}

function row(tier, verdict, status = 'ok') {
  return {
    question: question(tier),
    answer: { id: nextQuestionId, engine: 'mock', text: '', citations: [], status, latencyMs: 1 },
    judgment: verdict === null ? null : { verdict, matchedText: '', method: 'exact', confidence: 1, reasons: [] },
  };
}

test('LAYERS 权重为 20/40/40，tierToLayer 映射符合 SPEC', () => {
  assert.deepEqual({ ...LAYERS }, { awareness: 20, decision: 40, scenario: 40 });
  assert.equal(tierToLayer('brand_awareness'), 'awareness');
  assert.equal(tierToLayer('regional_industry'), 'decision');
  assert.equal(tierToLayer('super_tier1'), 'scenario');
  assert.equal(tierToLayer('其它层级'), 'decision');
  assert.equal(tierToLayer(undefined), 'decision');
});

test('三层得分 = 命中权重和 / 有效题数 × 层权重，总分按 100 分制归一', () => {
  const rows = [
    row('brand_awareness', 'recommended'),
    row('brand_awareness', 'not_mentioned'),
    row('regional_industry', 'listed'),
    row('super_tier1', 'mentioned'),
    row('super_tier1', 'not_mentioned'),
    row('super_tier1', 'recommended'),
  ];
  const result = scoreRun({ rows, plannedN: rows.length });

  assert.deepEqual(result.layers.awareness, { ok: 2, hits: 1, weighted: 1, score: 10.0 });
  assert.deepEqual(result.layers.decision, { ok: 1, hits: 1, weighted: 0.7, score: 28.0 });
  assert.deepEqual(result.layers.scenario, { ok: 3, hits: 2, weighted: 1.4, score: 18.7 });
  assert.equal(result.total, 56.7);
  assert.equal(result.level, '中等');
  assert.equal(result.coverage.planned, 6);
  assert.equal(result.coverage.ok, 6);
  assert.equal(result.coverage.ratio, 1);
  assert.equal(result.coverage.excluded.total, 0);
  assert.ok(Array.isArray(result.reasons) && result.reasons.length > 0);
});

test('unknown / ambiguous 不进分母，但计入 coverage.excluded', () => {
  const rows = [
    row('brand_awareness', 'recommended'),
    row('brand_awareness', 'unknown'),
    row('brand_awareness', 'ambiguous'),
    row('regional_industry', 'listed'),
    row('regional_industry', 'not_mentioned'),
    row('super_tier1', 'mentioned'),
  ];
  const result = scoreRun({ rows, plannedN: rows.length });

  // awareness 分母只有 1 条有效判定，而不是 3 条；拿不准的不按 0 分算
  assert.deepEqual(result.layers.awareness, { ok: 1, hits: 1, weighted: 1, score: 20.0 });
  assert.equal(result.coverage.ok, 6, 'coverage.ok 只看采集状态');
  assert.equal(result.coverage.excluded.unknown, 1);
  assert.equal(result.coverage.excluded.ambiguous, 1);
  assert.equal(result.coverage.excluded.total, 2);
  assert.equal(result.total, 50.0);
  assert.equal(result.level, '偏弱');
});

test('refused / engine_error / unavailable 不进分母，覆盖率按采集口径计算', () => {
  const rows = [
    row('brand_awareness', 'recommended'),
    row('brand_awareness', 'engine_error', 'engine_error'),
    row('brand_awareness', 'refused', 'refused'),
    row('brand_awareness', 'engine_error', 'unavailable'),
  ];
  const result = scoreRun({ rows, plannedN: 4 });

  assert.equal(result.coverage.ok, 1);
  assert.equal(result.coverage.ratio, 0.25);
  assert.equal(result.coverage.excluded.engine_error, 1);
  assert.equal(result.coverage.excluded.refused, 1);
  assert.equal(result.coverage.excluded.unavailable, 1);
  assert.equal(result.total, null, '覆盖率不足不出总分');
  assert.equal(result.level, '样本不足');
  assert.equal(result.layers.awareness.ok, 1, '失败样本不进分母');
  assert.equal(result.layers.awareness.score, 20.0);
  assert.ok(result.reasons.some((reason) => reason.includes('覆盖率')));
});

test('覆盖率 < 50% → total=null，等级样本不足', () => {
  const rows = [
    row('brand_awareness', 'recommended'),
    row('regional_industry', 'listed'),
    row('super_tier1', 'mentioned'),
    row('brand_awareness', 'not_mentioned'),
  ];
  const result = scoreRun({ rows, plannedN: 10 });
  assert.equal(result.coverage.ratio, 0.4);
  assert.equal(result.total, null);
  assert.equal(result.level, '样本不足');
  assert.ok(result.reasons.some((reason) => reason.includes('50%')));
});

test('有效层不足 2 层 → total=null，等级样本不足', () => {
  const rows = [
    row('brand_awareness', 'recommended'),
    row('brand_awareness', 'not_mentioned'),
    row('regional_industry', 'unknown'),
    row('super_tier1', 'engine_error'), // status ok 但判定引擎错误，同样排除
  ];
  const result = scoreRun({ rows, plannedN: rows.length });
  assert.equal(result.coverage.ratio, 1);
  assert.equal(result.layers.awareness.score, 10.0);
  assert.equal(result.layers.decision.score, null);
  assert.equal(result.layers.scenario.score, null);
  assert.equal(result.total, null);
  assert.equal(result.level, '样本不足');
  assert.ok(result.reasons.some((reason) => reason.includes('至少需 2 层')));
});

test('空 rows → 全部 null，等级样本不足', () => {
  const result = scoreRun({ rows: [], plannedN: 0 });
  assert.equal(result.coverage.planned, 0);
  assert.equal(result.coverage.ok, 0);
  assert.equal(result.coverage.ratio, 0);
  assert.equal(result.total, null);
  assert.equal(result.level, '样本不足');
  for (const layer of Object.values(result.layers)) {
    assert.equal(layer.ok, 0);
    assert.equal(layer.score, null);
  }
});

test('判定缺失按 missing 排除，不会静默记 0 分', () => {
  const rows = [
    { question: question('brand_awareness'), answer: { status: 'ok' }, judgment: null },
    row('regional_industry', 'listed'),
    row('super_tier1', 'mentioned'),
  ];
  const result = scoreRun({ rows, plannedN: rows.length });
  assert.equal(result.coverage.excluded.missing, 1);
  assert.equal(result.layers.awareness.ok, 0);
  assert.equal(result.layers.awareness.score, null);
  // 仅 decision(28) + scenario(16) 两层可算 → 按 80 分权重归一到 100
  assert.equal(result.total, 55.0);
  assert.equal(result.level, '中等');
});

test('plannedN 缺省用 rows.length；ratio 保留 3 位小数', () => {
  const rows = [row('brand_awareness', 'recommended'), row('regional_industry', 'listed'), row('super_tier1', 'engine_error', 'engine_error')];
  const result = scoreRun({ rows });
  assert.equal(result.coverage.planned, 3);
  assert.equal(result.coverage.ok, 2);
  assert.equal(result.coverage.ratio, 0.667);
});

test('6 档等级 + 样本不足按阈值映射', () => {
  const cases = [
    { rows: trio('recommended', 'recommended', 'recommended'), total: 100, level: '领先' },
    { rows: trio('recommended', 'recommended', 'listed'), total: 88, level: '领先' },
    { rows: trio('recommended', 'recommended', 'mentioned'), total: 76, level: '良好' },
    { rows: trio('recommended', 'recommended', 'not_mentioned'), total: 60, level: '中等' },
    { rows: trio('not_mentioned', 'listed', 'mentioned'), total: 44, level: '偏弱' },
    { rows: trio('not_mentioned', 'mentioned', 'mentioned'), total: 32, level: '落后' },
    { rows: trio('not_mentioned', 'not_mentioned', 'not_mentioned'), total: 0, level: '隐形' },
  ];
  for (const item of cases) {
    const result = scoreRun({ rows: item.rows, plannedN: item.rows.length });
    assert.equal(result.total, item.total);
    assert.equal(result.level, item.level);
  }
});

test('totalToLevel 阈值逐档精确', () => {
  assert.equal(totalToLevel(null), '样本不足');
  assert.equal(totalToLevel(undefined), '样本不足');
  assert.equal(totalToLevel(85), '领先');
  assert.equal(totalToLevel(84.9), '良好');
  assert.equal(totalToLevel(70), '良好');
  assert.equal(totalToLevel(69.9), '中等');
  assert.equal(totalToLevel(55), '中等');
  assert.equal(totalToLevel(54.9), '偏弱');
  assert.equal(totalToLevel(40), '偏弱');
  assert.equal(totalToLevel(39.9), '落后');
  assert.equal(totalToLevel(25), '落后');
  assert.equal(totalToLevel(24.9), '隐形');
});

/** 构造三层各一条的行，便于按层验证总分。 */
function trio(awarenessVerdict, decisionVerdict, scenarioVerdict) {
  return [
    row('brand_awareness', awarenessVerdict),
    row('regional_industry', decisionVerdict),
    row('super_tier1', scenarioVerdict),
  ];
}
