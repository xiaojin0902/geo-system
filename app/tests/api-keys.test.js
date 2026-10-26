// 测试：开放 API 密钥（生成、哈希、作用域、存储）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateApiKey, hashKey, bearerOf, hasScope, API_SCOPES } from '../lib/api-keys.js';
import { openStore } from '../lib/store.js';

function makeStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hengye-api-'));
  const store = openStore(path.join(dir, 'test.db'));
  t.after(() => {
    try { store.close(); } catch { /* 已关闭 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

test('生成密钥：geo_ 前缀、40 位十六进制、哈希可校验', () => {
  const { key, prefix, hash } = generateApiKey();
  assert.match(key, /^geo_[0-9a-f]{40}$/);
  assert.equal(prefix, key.slice(0, 12));
  assert.equal(hash, hashKey(key));
  assert.notEqual(hash, key);
});

test('哈希稳定且不同密钥不同哈希', () => {
  assert.equal(hashKey('geo_aaa'), hashKey('geo_aaa'));
  assert.notEqual(hashKey('geo_aaa'), hashKey('geo_bbb'));
});

test('Bearer 解析：大小写容错，非法头返回空串', () => {
  assert.equal(bearerOf('Bearer geo_abc'), 'geo_abc');
  assert.equal(bearerOf('bearer geo_abc'), 'geo_abc');
  assert.equal(bearerOf('Basic xxx'), '');
  assert.equal(bearerOf(''), '');
});

test('作用域：默认只读；含 write 视为全权', () => {
  assert.equal(hasScope({ scopes: ['read'] }, 'read'), true);
  assert.equal(hasScope({ scopes: ['read'] }, 'share'), false);
  assert.equal(hasScope({ scopes: ['write'] }, 'share'), true);
  assert.equal(hasScope(null, 'read'), false);
  assert.deepEqual(API_SCOPES, ['read', 'share', 'write']);
});

test('存储：创建后可校验，吊销后失效', (t) => {
  const store = makeStore(t);
  const { key, prefix, hash } = generateApiKey();
  const id = store.createApiKey({ name: 'k1', prefix, keyHash: hash, brandSlug: 'a', scopes: ['read'] });
  const found = store.getApiKeyByHash(hash);
  assert.equal(found.id, id);
  assert.equal(found.brandSlug, 'a');
  store.revokeApiKey(id);
  assert.equal(store.getApiKeyByHash(hash), null);
});

test('存储：列表按品牌过滤，记录最近使用', (t) => {
  const store = makeStore(t);
  const a = generateApiKey();
  const b = generateApiKey();
  store.createApiKey({ name: 'a', prefix: a.prefix, keyHash: a.hash, brandSlug: 'x' });
  store.createApiKey({ name: 'b', prefix: b.prefix, keyHash: b.hash, brandSlug: 'y' });
  assert.equal(store.listApiKeys('x').length, 1);
  const info = store.getApiKeyByHash(b.hash);
  store.touchApiKey(info.id);
  assert.ok(store.getApiKeyByHash(b.hash).lastUsedAt);
});
