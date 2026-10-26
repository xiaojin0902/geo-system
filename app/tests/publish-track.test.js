// 测试：发布追踪与撤回（可追溯、风险识别）
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrackReport, trackRisks, renderTrackMarkdown } from '../lib/publish-track.js';

const DAY = 86400000;
const pub = (extra = {}) => ({ id: 1, contentId: 3, title: 'A', channel: '公众号', status: 'published', url: 'https://x/a', account: 'ops', factKeys: ['price_range'], createdAt: new Date().toISOString(), ...extra });

test('完整记录：无风险', () => {
  const risks = trackRisks(pub(), { now: Date.now(), factsByKey: new Map([['price_range', { key: 'price_range', validUntil: new Date(Date.now() + DAY).toISOString() }]]) });
  assert.equal(risks.length, 0);
});

test('已发布但缺 URL → warning', () => {
  const risks = trackRisks(pub({ url: null }), { factsByKey: new Map() });
  assert.ok(risks.some((r) => r.type === 'missing_url'));
});

test('已发布但缺账号 → warning', () => {
  const risks = trackRisks(pub({ account: null }), { factsByKey: new Map() });
  assert.ok(risks.some((r) => r.type === 'missing_account'));
});

test('引用未登记事实 → critical', () => {
  const risks = trackRisks(pub({ factKeys: ['nope'] }), { factsByKey: new Map() });
  assert.ok(risks.some((r) => r.type === 'fact_missing' && r.level === 'critical'));
});

test('引用过期事实 → critical', () => {
  const factsByKey = new Map([['price_range', { key: 'price_range', validUntil: new Date(Date.now() - DAY).toISOString() }]]);
  const risks = trackRisks(pub(), { factsByKey });
  assert.ok(risks.some((r) => r.type === 'fact_expired' && r.level === 'critical'));
});

test('已撤回：不再报其它风险，只提示撤回原因', () => {
  const risks = trackRisks(pub({ withdrawnAt: new Date().toISOString(), withdrawReason: '价格变更' }), { factsByKey: new Map() });
  assert.equal(risks.length, 1);
  assert.match(risks[0].detail, /价格变更/);
});

test('发布超过 90 天 → 提示复核', () => {
  const old = new Date(Date.now() - 120 * DAY).toISOString();
  const factsByKey = new Map([['price_range', { key: 'price_range', validUntil: new Date(Date.now() + DAY).toISOString() }]]);
  const risks = trackRisks(pub({ createdAt: old }), { factsByKey });
  assert.ok(risks.some((r) => r.type === 'stale_review'));
});

test('汇总：发布/撤回/可追溯/风险计数', () => {
  const facts = [{ key: 'price_range', validUntil: new Date(Date.now() + DAY).toISOString(), value: 'x' }];
  const report = buildTrackReport({
    publications: [pub({ id: 1 }), pub({ id: 2, withdrawnAt: new Date().toISOString(), withdrawReason: 'r' }), pub({ id: 3, url: null })],
    facts,
  });
  assert.equal(report.summary.total, 3);
  assert.equal(report.summary.withdrawn, 1);
  assert.equal(report.summary.traceable, 1);
  assert.equal(report.summary.withWarning, 1);
});

test('Markdown：空记录给明确提示', () => {
  assert.match(renderTrackMarkdown({ summary: {}, rows: [] }), /还没有发布记录/);
});
