/**
 * lib/engines/doubao.js
 * 豆包（火山方舟 Ark）采集引擎。
 *
 * 端点是 OpenAI 兼容格式；与 OpenAI 的差异主要在「联网怎么开」：
 * 方舟用服务端工具声明，模型名必须是控制台里的**推理接入点 ID 或模型 ID**，
 * 每个账号不同，因此不写死默认值——缺少配置时直接报 unavailable 并说清怎么补，
 * 好过用一个猜的模型名去撞 400。
 */

import { createOpenAICompatibleEngine } from './openai-compatible.js';
import { pickKey } from './http.js';

export const DOUBAO_META = Object.freeze({
  id: 'doubao',
  label: '豆包 · 火山方舟（联网）',
  requiresKey: true,
});

export const DOUBAO_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';

/**
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {Function} [options.fetchImpl]
 */
export function createDoubaoEngine({ env = {}, fetchImpl, retries, retryBaseMs } = {}) {
  const apiKey = pickKey(env, 'DOUBAO_API_KEY') || pickKey(env, 'ARK_API_KEY');
  const model = pickKey(env, 'DOUBAO_MODEL');
  const searchDisabled = String(env.DOUBAO_SEARCH ?? '').trim() === '0';

  return createOpenAICompatibleEngine({
    meta: DOUBAO_META,
    endpoint: DOUBAO_ENDPOINT,
    apiKey: apiKey && model
      ? apiKey
      : '',
    model: model || 'unset',
    provider: 'doubao',
    // 方舟的联网能力通过服务端工具声明；DOUBAO_SEARCH=0 可关掉对照
    tools: searchDisabled ? undefined : [{ type: 'web_search' }],
    fetchImpl,
    retries,
    retryBaseMs,
  });
}

/** 给 doctor / 控制台用：这个引擎缺什么配置 */
export function doubaoReadiness(env = {}) {
  const apiKey = pickKey(env, 'DOUBAO_API_KEY') || pickKey(env, 'ARK_API_KEY');
  const model = pickKey(env, 'DOUBAO_MODEL');
  if (!apiKey) return { ready: false, reason: '未配置 DOUBAO_API_KEY（或 ARK_API_KEY）' };
  if (!model) {
    return {
      ready: false,
      reason:
        '未配置 DOUBAO_MODEL：请填火山方舟控制台的推理接入点 ID（形如 ep-2024xxxx）或模型 ID（形如 doubao-seed-1-6-250615）',
    };
  }
  return { ready: true, reason: '' };
}
