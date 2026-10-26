/**
 * lib/auth.js
 * 登录与会话：让系统从「一个人用」变成「给客户用」。
 *
 * 设计取舍：
 *   - 密码用 Node 内置 scrypt（零依赖），格式 `scrypt$<salt>$<hash>`，不可逆；
 *   - 会话是随机 token 存 SQLite，cookie 只放 token，服务端可即时吊销；
 *   - 角色只有两种：admin（管全部客户）与 client（只看自己品牌）；
 *   - 保留 Basic Auth 作为兜底（本机/运维），但客户走登录页。
 *
 * 安全边界：
 *   - cookie 用 HttpOnly + SameSite=Lax；HTTPS 部署时由反代加 Secure；
 *   - 登录失败不区分「用户不存在」与「密码错误」，避免枚举；
 *   - 会话 7 天过期，登出与过期会话会被清理。
 */
import crypto from 'node:crypto';

export const COOKIE_NAME = 'geo_session';
const SCRYPT_KEYLEN = 32;

/** 生成密码哈希（scrypt，零依赖） */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

/** 校验密码（常量时间比较，避免时序侧信道） */
export function verifyPassword(password, stored) {
  const value = String(stored ?? '');
  const parts = value.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expected] = parts;
  try {
    const actual = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
    const a = Buffer.from(actual, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** 会话 token：32 字节随机十六进制 */
export function newSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** 解析 Cookie 头 */
export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

/** 生成 Set-Cookie（maxAgeDays=0 表示清除） */
export function buildCookie(token, maxAgeDays = 7) {
  if (!token) {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeDays * 86400)}`;
}

/** 首次启动：没有管理员就创建一个，返回初始密码（只打印一次） */
export function ensureAdmin(store, { username = 'admin', password = '' } = {}) {
  const existing = store.getUser(username);
  if (existing) return { created: false, username, password: '' };
  const initial = password || crypto.randomBytes(9).toString('base64url');
  store.createUser({ username, passHash: hashPassword(initial), role: 'admin', brandSlug: null });
  return { created: true, username, password: initial };
}

/** 从请求里解析当前登录者；没有就返回 null */
export function actorOf(store, req) {
  const cookies = parseCookies(req.headers?.cookie ?? '');
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const session = store.getSession(token);
  if (!session) return null;
  const user = store.getUser(session.username);
  if (!user || !user.active) return null;
  return { username: user.username, role: user.role, brandSlug: user.brandSlug, token };
}

/** 客户端能访问的页面白名单（其余一律 403） */
export const CLIENT_ALLOWED_PATHS = Object.freeze([
  '/',
  '/cockpit',
  '/insights',
  '/questions',
  '/audit',
  '/seo',
  '/video',
  '/distribution',
  '/pipeline',
  '/run-diagnose',
  '/reports',
  '/run',
  '/weekly',
  '/logout',
]);

/** 客户能否访问该路径（前缀匹配） */
export function clientCanAccess(pathname) {
  return CLIENT_ALLOWED_PATHS.some((allowed) => pathname === allowed || pathname.startsWith(`${allowed}/`));
}
