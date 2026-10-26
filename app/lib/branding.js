/**
 * lib/branding.js
 * 系统品牌名集中定义：一处改名，全站生效。
 *
 * 为什么要变量化：
 *   品牌名原来散落在 20 多个模块的字符串里（报告页脚、周报、报价单、登录页、CLI 抬头…），
 *   改名要全仓库搜替换，漏一处就出现「半新半旧」的品牌，对客户很致命。
 *   现在只认一个来源：环境变量 GEO_SYSTEM_NAME（不设就用默认值），
 *   设置页里的白标（app_title/logo_text）优先级更高，用于给单个客户做白标。
 */

export const DEFAULT_SYSTEM_NAME = '恒野 GEO';

/** 当前系统名（环境变量优先） */
export function systemName(env = process.env) {
  const value = String(env?.GEO_SYSTEM_NAME ?? '').trim();
  return value || DEFAULT_SYSTEM_NAME;
}

/** 报告/内容里常用的组合名（如「恒见 GEO 自研版」） */
export function systemEdition(env = process.env) {
  return `${systemName(env)} 自研版`;
}

/** 系统对外的一句话（设置页可覆盖） */
export function systemTagline(env = process.env) {
  return String(env?.GEO_SYSTEM_TAGLINE ?? '').trim();
}
