// 测试：异动告警（阈值、好坏消息、样本不足、渲染）
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAlerts, renderAlertsMarkdown, shouldNotify, DEFAULT_THRESHOLDS } from '../lib/alerts.js';

const prev = {
  sample: { ok: 12, mentionRate: 0.4 },
  score: { total: 60 },
  citations: { ownShare: 0.2 },
  sov: { competitors: [{ name: '竞品A', share: 0.2 }] },
  sameNameThreats: [],
};
const cur = {
  sample: { ok: 12, mentionRate: 0.2 },
  score: { total: 40 },
  citations: { ownShare: 0 },
  sov: { competitors: [{ name: '竞品A', share: 0.45 }] },
  sameNameThreats: [{ message: '同名实体被引用' }],
};

test('提及率下降超过阈值 → critical', () => {
  const r = evaluateAlerts({ current: cur, previous: prev });
  const alert = r.alerts.find((a) => a.rule === 'mention_drop');
  assert.ok(alert);
  assert.equal(alert.level, 'critical');
  assert.match(alert.title, /20pt/);
});

test('总分下降超过阈值 → warning', () => {
  const r = evaluateAlerts({ current: cur, previous: prev });
  const alert = r.alerts.find((a) => a.rule === 'score_drop');
  assert.ok(alert);
  assert.equal(alert.level, 'warning');
});

test('自有引用从有到 0 → critical；从 0 到有 → 利好', () => {
  const lost = evaluateAlerts({ current: cur, previous: prev });
  assert.ok(lost.alerts.some((a) => a.rule === 'own_citation_lost'));

  const gained = evaluateAlerts({
    current: { ...cur, citations: { ownShare: 0.15 } },
    previous: { ...prev, citations: { ownShare: 0 } },
  });
  assert.ok(gained.alerts.some((a) => a.rule === 'own_citation_gained' && a.level === 'positive'));
});

test('竞品份额大涨 → warning，且在标题里点名', () => {
  const r = evaluateAlerts({ current: cur, previous: prev });
  const alert = r.alerts.find((a) => a.rule === 'competitor_surge');
  assert.ok(alert);
  assert.match(alert.title, /竞品A/);
});

test('同名实体威胁会被提醒', () => {
  const r = evaluateAlerts({ current: cur, previous: prev });
  assert.ok(r.alerts.some((a) => a.rule === 'same_name_threat'));
});

test('样本不足优先告警，且仍会报其他项', () => {
  const r = evaluateAlerts({ current: { ...cur, sample: { ok: 2, mentionRate: 0 } }, previous: prev });
  assert.equal(r.alerts[0].rule, 'low_samples');
  assert.equal(r.alerts[0].level, 'critical');
  assert.ok(r.alerts.length > 1);
});

test('首轮无对比：只给基线提示，不造假涨跌', () => {
  const r = evaluateAlerts({ current: prev, previous: null });
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].rule, 'baseline');
  assert.equal(shouldNotify(r), false, '纯提示不该触发推送');
});

test('阈值可配：调大后不再报警', () => {
  const r = evaluateAlerts({ current: cur, previous: prev, settings: { alert_mention_drop_pt: 50 } });
  assert.equal(r.alerts.some((a) => a.rule === 'mention_drop'), false);
});

test('渲染简报：含条数统计与处置动作', () => {
  const md = renderAlertsMarkdown(evaluateAlerts({ current: cur, previous: prev, runId: 9 }));
  assert.match(md, /可见度异动简报（run #9）/);
  assert.match(md, /→ /);
  assert.ok(md.includes('🔴'));
});

test('默认阈值常量存在且为正数', () => {
  for (const value of Object.values(DEFAULT_THRESHOLDS)) assert.ok(value > 0);
});
