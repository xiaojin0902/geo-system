/**
 * lib/api-keys.js
 * 开放 API 密钥：客户系统对接用。
 *
 * 安全设计：
 *   - 明文只显示一次（创建时），数据库只存 sha256 哈希；
 *   - 密钥带品牌作用域（brand_slug），只能读自己品牌的数据；
 *   - scopes 控制能力（read / share / write），默认只读；
 *   - 可吊销（revoked=1），吊销后立即失效。
 *
 * 零依赖（node:crypto）。
 */
import crypto from 'node:crypto';

export const API_SCOPES = Object.freeze(['read', 'share', 'write']);

/** 生成密钥：geo_ + 40 位随机十六进制 */
export function generateApiKey() {
  const raw = crypto.randomBytes(20).toString('hex');
  const key = `geo_${raw}`;
  return { key, prefix: key.slice(0, 12), hash: hashKey(key) };
}

export function hashKey(key) {
  return crypto.createHash('sha256').update(String(key ?? '')).digest('hex');
}

/** 从 Authorization 头取出 Bearer token */
export function bearerOf(header = '') {
  const match = String(header).match(/^Bearer\s+(.+)$/iu);
  return match ? match[1].trim() : '';
}

/** 权限判断 */
export function hasScope(keyInfo, scope) {
  if (!keyInfo) return false;
  const scopes = Array.isArray(keyInfo.scopes) ? keyInfo.scopes : [];
  return scopes.includes(scope) || scopes.includes('write');
}
