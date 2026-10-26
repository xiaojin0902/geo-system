// 测试：事实主数据（抗幻觉）——可用性、健康度、内容门槛、提示词渲染
import test from 'node:test';
import assert from 'node:assert/strict';
import { FACT_KEYS, factHealth, isUsable, contentGate, renderFactsForPrompt, renderFactsMarkdown, keyMeta } from '../lib/facts.js';

const DAY = 86400000;
const future = new Date(Date.now() + 365 * DAY).toISOString();
const past = new Date(Date.now() - DAY).toISOString();
const fact = (key, extra = {}) => ({ key, value: 'v', status: 'verified', sourceUrl: 'https://x', validUntil: future, ...extra });

test('字段目录：关键字段包含全称/城市/地址/电话/价格', () => {
  const keys = FACT_KEYS.map((item) => item.key);
  for (const key of ['legal_name', 'city', 'address', 'phone', 'price_range']) assert.ok(keys.includes(key));
  assert.equal(keyMeta('legal_name').critical, true);
  assert.equal(keyMeta('unknown'), null);
});

test('可用性：缺来源不可用', () => {
  assert.equal(isUsable(fact('city', { sourceUrl: '' })).usable, false);
  assert.match(isUsable(fact('city', { sourceUrl: '' })).reason, /来源/);
});

test('可用性：过期不可用、未核验不可用', () => {
  assert.equal(isUsable(fact('city', { validUntil: past })).usable, false);
  assert.equal(isUsable(fact('city', { status: 'pending' })).usable, false);
  assert.equal(isUsable(null).usable, false);
});

test('健康度：缺关键事实、不可用事实都统计', () => {
  const health = factHealth([fact('legal_name'), fact('price_range', { sourceUrl: '' })]);
  assert.ok(health.missing.includes('city'));
  assert.equal(health.unusable.length, 1);
  assert.equal(health.ready, false);
});

test('健康度：关键事实齐全且可用 → ready', () => {
  const facts = ['legal_name', 'city', 'address', 'phone', 'price_range'].map((key) => fact(key));
  const health = factHealth(facts);
  assert.equal(health.ready, true);
  assert.deepEqual(health.missing, []);
});

test('内容门槛：缺事实给出可执行动作', () => {
  const gate = contentGate([fact('legal_name')]);
  assert.equal(gate.ok, false);
  assert.ok(gate.blockers.length >= 3);
  assert.match(gate.blockers[0].action, /facts --add/);
});

test('内容门槛：齐全时放行', () => {
  const facts = ['legal_name', 'city', 'address', 'phone', 'price_range'].map((key) => fact(key));
  assert.equal(contentGate(facts).ok, true);
});

test('提示词渲染：只包含可用事实，并声明不得编造', () => {
  const text = renderFactsForPrompt([fact('legal_name', { value: '芜湖恒野数字科技有限公司' }), fact('price_range', { sourceUrl: '' })]);
  assert.match(text, /已核验事实/);
  assert.match(text, /芜湖恒野数字科技有限公司/);
  assert.equal(text.includes('price_range'), false, '不可用事实不应进入提示词');
});

test('空事实时提示词明确禁止编造', () => {
  assert.match(renderFactsForPrompt([]), /禁止编造/);
});

test('Markdown 渲染含清单与缺失项', () => {
  const md = renderFactsMarkdown([fact('legal_name')]);
  assert.match(md, /事实主数据/);
  assert.match(md, /缺关键事实/);
  assert.match(md, /legal_name|公司全称/);
});
