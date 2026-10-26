// 测试：登录鉴权（scrypt 密码、会话、角色、客户可见性）。
// 全部用 mkdtemp 临时库，不碰真实数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.js';
import {
  CLIENT_ALLOWED_PATHS,
  buildCookie,
  clientCanAccess,
  ensureAdmin,
  hashPassword,
  newSessionToken,
  parseCookies,
  verifyPassword,
  actorOf,
} from '../lib/auth.js';

function makeStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hengye-auth-'));
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

test('密码哈希：可校验正确密码，拒绝错误密码', () => {
  const hash = hashPassword('s3cret-pass');
  assert.match(hash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(verifyPassword('s3cret-pass', hash), true);
  assert.equal(verifyPassword('wrong', hash), false);
  assert.equal(verifyPassword('', hash), false);
});

test('密码哈希：同一密码两次哈希不同（有随机盐）', () => {
  const a = hashPassword('same');
  const b = hashPassword('same');
  assert.notEqual(a, b);
  assert.equal(verifyPassword('same', a), true);
  assert.equal(verifyPassword('same', b), true);
});

test('密码哈希：异常输入不抛异常', () => {
  assert.equal(verifyPassword('x', ''), false);
  assert.equal(verifyPassword('x', 'plain-text'), false);
  assert.equal(verifyPassword('x', 'scrypt$only-two'), false);
});

test('ensureAdmin：首次创建并返回初始密码，第二次不再创建', (t) => {
  const store = makeStore(t);
  const first = ensureAdmin(store, { password: 'init-pass-123' });
  assert.equal(first.created, true);
  assert.equal(first.username, 'admin');
  assert.equal(first.password, 'init-pass-123');
  const admin = store.getUser('admin');
  assert.equal(admin.role, 'admin');
  assert.equal(admin.active, true);

  const second = ensureAdmin(store, { password: 'other' });
  assert.equal(second.created, false);
  assert.equal(verifyPassword('init-pass-123', store.getUser('admin').passHash), true);
});

test('ensureAdmin：不传密码时随机生成且长度足够', (t) => {
  const store = makeStore(t);
  const result = ensureAdmin(store, {});
  assert.equal(result.created, true);
  assert.ok(result.password.length >= 12);
  assert.equal(verifyPassword(result.password, store.getUser('admin').passHash), true);
});

test('会话：创建/回查/登出', (t) => {
  const store = makeStore(t);
  const token = newSessionToken();
  assert.equal(token.length, 64);
  store.createSession({ token, username: 'admin', role: 'admin', ttlDays: 7 });
  const session = store.getSession(token);
  assert.equal(session.username, 'admin');
  assert.equal(session.role, 'admin');
  assert.ok(store.deleteSession(token));
  assert.equal(store.getSession(token), null);
});

test('会话：过期自动失效并被清理', (t) => {
  const store = makeStore(t);
  const token = newSessionToken();
  store.createSession({ token, username: 'admin', role: 'admin', ttlDays: -1 });
  assert.equal(store.getSession(token), null);
  assert.equal(store.getSession('不存在的token'), null);
});

test('客户账号：创建后可登录，角色为 client 且绑定品牌', (t) => {
  const store = makeStore(t);
  store.upsertBrand({ slug: 'client-a', name: '客户 A' });
  store.createUser({ username: 'client-a-user', passHash: hashPassword('pass12345'), role: 'client', brandSlug: 'client-a' });
  const user = store.getUser('client-a-user');
  assert.equal(user.role, 'client');
  assert.equal(user.brandSlug, 'client-a');
  assert.equal(verifyPassword('pass12345', user.passHash), true);
});

test('用户名重复时给出中文错误', (t) => {
  const store = makeStore(t);
  store.createUser({ username: 'dup', passHash: hashPassword('x'), role: 'admin' });
  assert.throws(() => store.createUser({ username: 'dup', passHash: hashPassword('y'), role: 'admin' }), /已存在/);
});

test('停用账号后不能登录', (t) => {
  const store = makeStore(t);
  store.createUser({ username: 'temp', passHash: hashPassword('p'), role: 'client', brandSlug: 'x' });
  assert.equal(store.setUserActive('temp', false), true);
  assert.equal(store.getUser('temp').active, false);
});

test('actorOf：无 cookie 返回 null，有有效会话返回操作者', (t) => {
  const store = makeStore(t);
  assert.equal(actorOf(store, { headers: {} }), null);
  store.createUser({ username: 'op', passHash: hashPassword('p'), role: 'admin' });
  const token = newSessionToken();
  store.createSession({ token, username: 'op', role: 'admin' });
  const actor = actorOf(store, { headers: { cookie: `geo_session=${token}` } });
  assert.equal(actor.username, 'op');
  assert.equal(actor.role, 'admin');
});

test('Cookie：序列化与解析往返', () => {
  assert.match(buildCookie('abc123'), /^geo_session=abc123;/);
  assert.match(buildCookie('', 0), /Max-Age=0/);
  assert.deepEqual(parseCookies('a=1; geo_session=xyz; b=2'), { a: '1', geo_session: 'xyz', b: '2' });
});

test('客户可见性：白名单内可访问，管理页一律拒绝', () => {
  assert.ok(CLIENT_ALLOWED_PATHS.includes('/'));
  for (const allowed of ['/', '/cockpit', '/insights', '/questions', '/audit', '/seo', '/video', '/distribution', '/pipeline', '/run-diagnose', '/reports/run-1.html']) {
    assert.equal(clientCanAccess(allowed), true, `${allowed} 应可访问`);
  }
  for (const denied of ['/clients', '/settings', '/audit-log', '/api/clients', '/api/settings']) {
    assert.equal(clientCanAccess(denied), false, `${denied} 应被拒绝`);
  }
});

test('设置：按品牌隔离，全局与品牌互不覆盖', (t) => {
  const store = makeStore(t);
  store.upsertBrand({ slug: 'a', name: 'A' });
  const brandA = store.getBrand('a');
  store.setSetting('app_title', '全局标题', null);
  store.setSetting('app_title', '客户A标题', brandA.id);
  store.setSetting('quota_questions', '120', null);
  assert.equal(store.getSetting('app_title', null), '全局标题');
  assert.equal(store.getSetting('app_title', brandA.id), '客户A标题');
  assert.equal(store.getSetting('quota_questions', null), '120');
  assert.equal(store.listSettings(null).app_title, '全局标题');
});

test('审计日志：写入与按品牌过滤', (t) => {
  const store = makeStore(t);
  store.writeAudit({ actor: 'admin', brandSlug: 'a', action: 'login', detail: 'ok' });
  store.writeAudit({ actor: 'admin', brandSlug: 'b', action: 'diagnose_start', detail: 'x' });
  const all = store.listAudit({ limit: 10 });
  assert.equal(all.length, 2);
  assert.equal(all[0].action, 'diagnose_start', '应按时间倒序');
  const onlyA = store.listAudit({ brandSlug: 'a' });
  assert.equal(onlyA.length, 1);
  assert.equal(onlyA[0].action, 'login');
});
