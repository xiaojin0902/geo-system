// GEO 系统 · 运行配置
// 职责：定位 app 根目录、数据目录、数据库与品牌配置文件，并加载 app/.env。
// 契约见 SPEC.md §3.1；本文件不做任何业务判断。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

/** app 根目录（<工作区>/hengye-geo/app），绝对路径 */
export const APP_ROOT = path.resolve(LIB_DIR, '..');

/**
 * 数据目录，默认 app/data。
 * 说明（SPEC 之外的测试便利）：支持环境变量 HENGYE_GEO_DATA_DIR 覆盖，
 * 便于测试与冒烟在不污染真实 data/ 的前提下跑；未设置时行为与 SPEC 完全一致。
 */
export const DATA_DIR = process.env.HENGYE_GEO_DATA_DIR
  ? path.resolve(process.env.HENGYE_GEO_DATA_DIR)
  : path.join(APP_ROOT, 'data');

/** 需要从 .env 关注的密钥（只做透传，不打印） */
const API_KEYS = ['DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY'];

/** 极简 .env 解析：支持 KEY=VALUE、注释、export 前缀、成对引号。不覆盖已有 process.env。 */
function parseEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    // 只补空缺，已经存在的 env（含 CI 注入）优先
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * 读 app/.env 写入 process.env（不覆盖已有值），并返回关注的两个密钥。
 * @param {Record<string, string|undefined>} [extra] 额外默认值（同样不覆盖已有值）
 * @returns {{DEEPSEEK_API_KEY?: string, DASHSCOPE_API_KEY?: string}}
 */
export function loadEnv(extra = {}) {
  parseEnvFile(path.join(APP_ROOT, '.env'));
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && process.env[key] === undefined) {
      process.env[key] = String(value);
    }
  }
  const out = {};
  for (const key of API_KEYS) {
    if (process.env[key]) out[key] = process.env[key];
  }
  return out;
}

/** 数据库文件路径：DATA_DIR/geo.db */
export function dbPath() {
  return path.join(DATA_DIR, 'geo.db');
}

/** 品牌配置文件路径：APP_ROOT/brands/<slug>.json */
export function brandPath(slug) {
  const value = String(slug ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`品牌标识 "${slug}" 不合法：只允许字母、数字、下划线和短横线`);
  }
  return path.join(APP_ROOT, 'brands', `${value}.json`);
}
