// 测试：客户分享链接（shares 表 + 到期/吊销语义）。
// 用 mkdtemp 临时库，不碰真实数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.js';

function makeStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hengye-share-'));
  const store = openStore(path.join(dir, 'test.db'));
  t.after(() => {
    try {
      store.close();
    } catch {
      /* 已关闭 */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  store.upsertBrand({ slug: 'demo', name: '演示品牌' });
  const brand = store.getBrand('demo');
  return { store, brand };
}

test('创建分享链接：token 32 位十六进制，带到期时间', (t) => {
  const { store, brand } = makeStore(t);
  const share = store.createShare({ brandId: brand.id, runId: 7, days: 30 });
  assert.match(share.token, /^[0-9a-f]{32}$/);
  assert.ok(share.expiresAt);
  const days = (new Date(share.expiresAt).getTime() - Date.now()) / 86400000;
  assert.ok(days > 29 && days <= 30.01, `到期应约 30 天，实际 ${days}`);
});

test('回查分享：带上品牌名与 runId', (t) => {
  const { store, brand } = makeStore(t);
  const created = store.createShare({ brandId: brand.id, runId: 12, days: 7 });
  const found = store.getShare(created.token);
  assert.equal(found.brandSlug, 'demo');
  assert.equal(found.brandName, '演示品牌');
  assert.equal(found.runId, 12);
});

test('未知 token 返回 null（不抛异常）', (t) => {
  const { store } = makeStore(t);
  assert.equal(store.getShare('不存在的token'), null);
  assert.equal(store.getShare(''), null);
  assert.equal(store.getShare(undefined), null);
});

test('过期链接自动失效', (t) => {
  const { store, brand } = makeStore(t);
  const created = store.createShare({ brandId: brand.id, runId: null, days: -1 });
  assert.equal(store.getShare(created.token), null, '过期后应取不到');
});

test('吊销后立即失效', (t) => {
  const { store, brand } = makeStore(t);
  const created = store.createShare({ brandId: brand.id, runId: 3, days: 30 });
  assert.ok(store.getShare(created.token));
  assert.equal(store.revokeShare(created.token), true);
  assert.equal(store.getShare(created.token), null);
});

test('重复吊销返回 false', (t) => {
  const { store, brand } = makeStore(t);
  const created = store.createShare({ brandId: brand.id, runId: 3, days: 30 });
  assert.equal(store.revokeShare(created.token), true);
  assert.equal(store.revokeShare(created.token), false);
});

test('listShares 按品牌隔离，含吊销状态', (t) => {
  const { store, brand } = makeStore(t);
  store.upsertBrand({ slug: 'other', name: '另一个品牌' });
  const other = store.getBrand('other');
  const a = store.createShare({ brandId: brand.id, runId: 1, days: 30 });
  store.createShare({ brandId: other.id, runId: 2, days: 30 });
  store.revokeShare(a.token);

  const list = store.listShares(brand.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].token, a.token);
  assert.equal(list[0].revoked, true);
});

test('每次生成 token 都不同（不重复）', (t) => {
  const { store, brand } = makeStore(t);
  const tokens = new Set();
  for (let i = 0; i < 20; i += 1) tokens.add(store.createShare({ brandId: brand.id, runId: i, days: 1 }).token);
  assert.equal(tokens.size, 20);
});
