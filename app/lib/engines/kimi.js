/**
 * lib/engines/kimi.js
 * Kimi（Moonshot）采集引擎。
 *
 * 联网方式：在 tools 里声明内置函数 `$web_search`（Moonshot 的服务端搜索工具），
 * 由服务端执行检索并把结果注入上下文；响应里会带引用与改写后的检索词。
 * KIMI_SEARCH=0 可关掉搜索引擎做对照。
 */

import { createOpenAICompatibleEngine } from './openai-compatible.js';
import { pickKey } from './http.js';

export const KIMI_META = Object.freeze({
  id: 'kimi',
  label: 'Kimi · 月之暗面（联网）',
  requiresKey: true,
});

export const KIMI_ENDPOINT = 'https://api.moonshot.cn/v1/chat/completions';

/**
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {Function} [options.fetchImpl]
 */
export function createKimiEngine({ env = {}, fetchImpl, retries, retryBaseMs } = {}) {
  const apiKey = pickKey(env, 'KIMI_API_KEY') || pickKey(env, 'MOONSHOT_API_KEY');
  const model = pickKey(env, 'KIMI_MODEL') || 'kimi-k2-0905-preview';
  const searchDisabled = String(env.KIMI_SEARCH ?? '').trim() === '0';

  return createOpenAICompatibleEngine({
    meta: KIMI_META,
    endpoint: KIMI_ENDPOINT,
    apiKey,
    model,
    provider: 'kimi',
    // Moonshot 的内置联网搜索工具
    tools: searchDisabled ? undefined : [{ type: 'builtin_function', function: { name: '$web_search' } }],
    fetchImpl,
    retries,
    retryBaseMs,
  });
}

export function kimiReadiness(env = {}) {
  const apiKey = pickKey(env, 'KIMI_API_KEY') || pickKey(env, 'MOONSHOT_API_KEY');
  return apiKey
    ? { ready: true, reason: '' }
    : { ready: false, reason: '未配置 KIMI_API_KEY（或 MOONSHOT_API_KEY）' };
}
