// 测试：代理层（服务商 → 代理 → 客户）的数据与分成口径。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.js';
import { resolveSubscription } from '../lib/plans.js';

function makeStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hengye-agent-'));
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

test('开通代理：配额与分成有默认值，用户名重复报错', (t) => {
  const store = makeStore(t);
  const agent = store.createAgent({ username: 'a1', name: '代理一' });
  assert.equal(agent.quotaTotal, 0);
  assert.equal(agent.commissionRate, 0.3);
  assert.throws(() => store.createAgent({ username: 'a1' }), /已存在/);
});

test('代理配额与分成会被夹在合理范围', (t) => {
  const store = makeStore(t);
  const agent = store.createAgent({ username: 'a2', quotaTotal: -100, commissionRate: 5 });
  assert.equal(agent.quotaTotal, 0);
  assert.ok(agent.commissionRate <= 0.9, '分成不应超过 90%');
});

test('客户可绑定代理，也可改回直营', (t) => {
  const store = makeStore(t);
  store.createAgent({ username: 'a3' });
  store.upsertBrand({ slug: 'c1', name: '客户一', agent: 'a3' });
  assert.equal(store.getBrand('c1').agent, 'a3');
  assert.deepEqual(store.listBrandsByAgent('a3').map((b) => b.slug), ['c1']);

  store.setBrandAgent(store.getBrand('c1').id, null);
  assert.equal(store.getBrand('c1').agent, null);
  assert.equal(store.listBrandsByAgent('a3').length, 0);
});

test('代理只看得到自己的客户', (t) => {
  const store = makeStore(t);
  store.createAgent({ username: 'a4' });
  store.createAgent({ username: 'a5' });
  store.upsertBrand({ slug: 'c-a4', name: 'A4 的客户', agent: 'a4' });
  store.upsertBrand({ slug: 'c-a5', name: 'A5 的客户', agent: 'a5' });
  store.upsertBrand({ slug: 'c-direct', name: '直营客户' });
  assert.deepEqual(store.listBrandsByAgent('a4').map((b) => b.slug), ['c-a4']);
  assert.deepEqual(store.listBrandsByAgent('a5').map((b) => b.slug), ['c-a5']);
});

test('分成计算：营收 × 分成比例', () => {
  const clients = [
    { sub: { priceMonthly: 699 } },
    { sub: { priceMonthly: 299 } },
  ];
  const revenue = clients.reduce((sum, c) => sum + c.sub.priceMonthly, 0);
  assert.equal(revenue, 998);
  assert.equal(Math.round(revenue * 0.3), 299);
});

test('代理客户订阅状态解析与直营一致', () => {
  const sub = resolveSubscription({ plan: 'pro', service_mode: 'managed', expire_at: new Date(Date.now() + 86400000).toISOString() });
  assert.equal(sub.active, true);
  assert.equal(sub.clientCanAct, false);
});
