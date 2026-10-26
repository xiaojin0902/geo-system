// 测试：托管按效果计费（口径、基线、保底、封顶、渲染）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureRows, computeSettlement, renderSettlementMarkdown, unitOf, BILLING_UNITS } from '../lib/billing.js';

const row = (verdict, citations = 0) => ({ judgment: { verdict }, answer: { citations: Array.from({ length: citations }, (_, i) => ({ url: `https://x/${i}` })) } });

test('口径统计：无效样本不计入分母', () => {
  const m = measureRows([
    row('mentioned'), row('not_mentioned'), row('recommended'),
    row('unknown'), row('engine_error'), row('refused'), row('ambiguous'),
  ]);
  assert.equal(m.answers, 3);
  assert.equal(m.mentioned, 2);
  assert.equal(m.recommended, 1);
  assert.ok(Math.abs(m.mentionRate - 2 / 3) < 1e-9);
});

test('口径统计：引用条数按回答累加', () => {
  const m = measureRows([row('mentioned', 2), row('recommended', 3)]);
  assert.equal(m.citations, 5);
});

test('新增提及：本期 6 - 基线 2 = 4 条 × ¥80 = ¥320', () => {
  const s = computeSettlement({
    current: { answers: 12, mentioned: 6, mentionRate: 0.5, citations: 4, recommended: 1 },
    baseline: { answers: 12, mentioned: 2, mentionRate: 2 / 12, citations: 3 },
    settings: { billing_unit: 'mention_gain', billing_price: 80 },
    month: '2026-10',
  });
  assert.equal(s.quantity, 4);
  assert.equal(s.total, 320);
});

test('效果为负时按 0 计，不倒收费', () => {
  const s = computeSettlement({
    current: { answers: 10, mentioned: 1, mentionRate: 0.1 },
    baseline: { answers: 10, mentioned: 5, mentionRate: 0.5 },
    settings: { billing_unit: 'mention_gain' },
  });
  assert.equal(s.quantity, 0);
  assert.equal(s.total, 0);
});

test('提及率口径按百分点，保留 1 位小数', () => {
  const s = computeSettlement({
    current: { answers: 20, mentioned: 9, mentionRate: 0.45 },
    baseline: { answers: 20, mentioned: 5, mentionRate: 0.25 },
    settings: { billing_unit: 'mention_rate_pt', billing_price: 200 },
  });
  assert.equal(s.quantity, 20);
  assert.equal(s.total, 4000);
});

test('保底生效：应收不低于保底', () => {
  const s = computeSettlement({
    current: { answers: 5, mentioned: 1, mentionRate: 0.2 },
    baseline: { answers: 5, mentioned: 1, mentionRate: 0.2 },
    settings: { billing_unit: 'mention_gain', billing_min: 500 },
  });
  assert.equal(s.subtotal, 0);
  assert.equal(s.total, 500);
  assert.equal(s.floored, true);
});

test('封顶生效：应收不超过封顶', () => {
  const s = computeSettlement({
    current: { answers: 100, mentioned: 80, mentionRate: 0.8 },
    baseline: { answers: 100, mentioned: 10, mentionRate: 0.1 },
    settings: { billing_unit: 'mention_gain', billing_price: 100, billing_cap: 3000 },
  });
  assert.equal(s.subtotal, 7000);
  assert.equal(s.total, 3000);
  assert.equal(s.capped, true);
});

test('固定月费模式：不看效果，按固定金额', () => {
  const s = computeSettlement({
    current: { answers: 10, mentioned: 10, mentionRate: 1 },
    baseline: { answers: 10, mentioned: 0, mentionRate: 0 },
    settings: { billing_mode: 'fixed', billing_fixed_fee: 1999 },
  });
  assert.equal(s.mode, 'fixed');
  assert.equal(s.total, 1999);
});

test('推荐次数口径：按绝对值计费', () => {
  const s = computeSettlement({
    current: { answers: 20, mentioned: 6, mentionRate: 0.3, recommended: 4 },
    settings: { billing_unit: 'recommended_count', billing_price: 150 },
  });
  assert.equal(s.quantity, 4);
  assert.equal(s.total, 600);
});

test('四种计费单位都在册，未知单位回落默认', () => {
  assert.deepEqual(BILLING_UNITS.map((u) => u.id), ['mention_gain', 'citation_gain', 'mention_rate_pt', 'recommended_count']);
  assert.equal(unitOf('nope').id, 'mention_gain');
});

test('结算单渲染：含口径、基线、金额与数据依据', () => {
  const s = computeSettlement({
    brand: { name: '演示' },
    current: { answers: 12, mentioned: 6, mentionRate: 0.5, citations: 4 },
    baseline: { answers: 12, mentioned: 2, mentionRate: 2 / 12, citations: 1 },
    settings: { billing_unit: 'mention_gain' },
    month: '2026-10',
    baselineLabel: '上期（2026-09）同口径',
  });
  const md = renderSettlementMarkdown(s);
  for (const token of ['托管结算单', '按效果计费', '计量口径', '上期（2026-09）同口径', '应收合计', '数据依据']) {
    assert.ok(md.includes(token), `缺少 ${token}`);
  }
  assert.ok(md.includes('¥320'));
});
