/**
 * lib/auth.js — 登录（scrypt 密码 + SQLite 会话），代运营系统只需管理员一种角色。
 */
import crypto from 'node:crypto';

const COOKIE = 'geo2_session';

export const cookieName = COOKIE;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const actual = crypto.scryptSync(String(password), parts[1], 32).toString('hex');
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(parts[2], 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export function cookieHeader(token, maxAgeDays = 7) {
  if (!token) return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeDays * 86400)}`;
}

/** 首次启动创建管理员，返回初始密码（只打印一次） */
export function ensureAdmin(store, { username = 'admin', password = '' } = {}) {
  if (store.getUser(username)) return { created: false, username, password: '' };
  const initial = password || crypto.randomBytes(9).toString('base64url');
  store.createUser({ username, passHash: hashPassword(initial), role: 'admin' });
  return { created: true, username, password: initial };
}

/** 当前登录者 */
export function actorOf(store, req) {
  const cookies = parseCookies(req.headers?.cookie ?? '');
  const token = cookies[COOKIE];
  if (!token) return null;
  const session = store.getSession(token);
  if (!session) return null;
  const user = store.getUser(session.username);
  if (!user || !user.active) return null;
  return { username: user.username, token };
}
