/**
 * lib/engines/yuanbao.js
 * 元宝采集引擎（走 OpenAI 兼容中转）。
 *
 * 为什么不是写死的官方端点：腾讯元宝目前**没有公开的对话 API**，
 * 市面上的做法是走第三方中转（OpenAI 兼容协议）。
 * 因此这里不做假设，端点/模型/密钥全部由 .env 提供，缺任何一项就 unavailable，
 * 并在错误信息里说清「这不是 bug，是元宝没有官方 API」。
 */

import { createOpenAICompatibleEngine } from './openai-compatible.js';
import { pickKey } from './http.js';

export const YUANBAO_META = Object.freeze({
  id: 'yuanbao',
  label: '元宝 · 中转（OpenAI 兼容）',
  requiresKey: true,
});

/** 把 YUANBAO_BASE_URL 规范成 chat/completions 端点 */
export function yuanbaoEndpoint(env = {}) {
  const base = pickKey(env, 'YUANBAO_BASE_URL');
  if (!base) return '';
  const trimmed = base.replace(/\/+$/u, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
}

export function createYuanbaoEngine({ env = {}, fetchImpl, retries, retryBaseMs } = {}) {
  const apiKey = pickKey(env, 'YUANBAO_API_KEY');
  const model = pickKey(env, 'YUANBAO_MODEL') || 'yuanbao';
  const endpoint = yuanbaoEndpoint(env);

  return createOpenAICompatibleEngine({
    meta: YUANBAO_META,
    endpoint,
    apiKey: endpoint ? apiKey : '',
    model,
    provider: 'yuanbao',
    fetchImpl,
    retries,
    retryBaseMs,
  });
}

export function yuanbaoReadiness(env = {}) {
  if (!pickKey(env, 'YUANBAO_BASE_URL')) {
    return {
      ready: false,
      reason:
        '未配置 YUANBAO_BASE_URL：元宝没有官方对话 API，需填一个 OpenAI 兼容中转的根地址（如 https://xxx/v1）',
    };
  }
  if (!pickKey(env, 'YUANBAO_API_KEY')) return { ready: false, reason: '未配置 YUANBAO_API_KEY' };
  return { ready: true, reason: '' };
}
