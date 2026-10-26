// 测试：30/60/90 天路线图（对标 GEOrank 的分阶段方案）
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPhases } from '../lib/action-plan.js';

const top10 = Array.from({ length: 10 }, (_, i) => ({
  rank: i + 1,
  action: `动作${i + 1}`,
  owner: '内容',
  deadline: `2026-11-0${(i % 9) + 1}`,
}));

test('三段窗口：0–30 / 31–60 / 61–90', () => {
  const phases = buildPhases({ top10 });
  assert.equal(phases.length, 3);
  assert.deepEqual(phases.map((p) => p.window), ['0–30 天', '31–60 天', '61–90 天']);
});

test('每段都有焦点、目标、验收标准', () => {
  for (const phase of buildPhases({ top10 })) {
    assert.ok(phase.focus.length > 0);
    assert.ok(phase.goals.length >= 3);
    assert.ok(phase.success.length > 0);
  }
});

test('动作按顺序切分：前 3 / 中 3 / 后 4', () => {
  const phases = buildPhases({ top10 });
  assert.deepEqual(phases[0].actions.map((a) => a.rank), [1, 2, 3]);
  assert.deepEqual(phases[1].actions.map((a) => a.rank), [4, 5, 6]);
  assert.deepEqual(phases[2].actions.map((a) => a.rank), [7, 8, 9, 10]);
});

test('无动作时不崩，且目标仍可读', () => {
  const phases = buildPhases({});
  assert.equal(phases.length, 3);
  assert.equal(phases[0].actions.length, 0);
  assert.ok(phases[0].goals.some((g) => g.includes('覆盖率') || g.includes('实体')));
});

test('覆盖率与自有引用影响目标文案', () => {
  const low = buildPhases({ top10, coverage: { ratio: 0.2 }, insights: { citations: { ownShare: 0 } } });
  assert.ok(low[0].goals.some((g) => g.includes('提到 50%')));
  const high = buildPhases({ top10, coverage: { ratio: 0.8 }, insights: { citations: { ownShare: 0.3 } } });
  assert.ok(high[0].goals.some((g) => g.includes('维持')));
  assert.ok(high[0].success.includes('> 0'));
});
