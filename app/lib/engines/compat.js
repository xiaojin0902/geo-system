/**
 * lib/engines/compat.js
 * 由 providers.js 注册表驱动的通用引擎实例工厂。
 * 除 deepseek / dashscope / doubao / kimi / yuanbao 这五家专用适配器外，
 * 其余「OpenAI 兼容」供应商统一走这里，避免为每家复制一套采集代码。
 */
import { createOpenAICompatibleEngine } from './openai-compatible.js';
import { providerOf, providerReadiness } from './providers.js';
import { pickKey } from './http.js';

export function createCompatEngine(id, { env = {}, fetchImpl, retries, retryBaseMs } = {}) {
  const meta = providerOf(id);
  if (!meta) throw new Error(`未知引擎「${id}」`);
  const key = pickKey(env, meta.keyEnv) || (meta.altKeyEnv ? pickKey(env, meta.altKeyEnv) : '');
  const base = meta.baseUrlEnv ? pickKey(env, meta.baseUrlEnv).replace(/\/+$/u, '') : '';
  const endpoint = meta.baseUrlEnv
    ? base
      ? base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
      : ''
    : meta.endpoint;
  const model = (meta.modelEnv ? pickKey(env, meta.modelEnv) : '') || meta.defaultModel || '';
  const readiness = providerReadiness(meta, env);

  return createOpenAICompatibleEngine({
    meta: { id: meta.id, label: strengthLabel(meta) },
    endpoint,
    apiKey: readiness.ready ? key : '',
    model,
    provider: meta.provider,
    tools: meta.tools,
    fetchImpl,
    retries,
    retryBaseMs,
  });
}

/** 标签里标注是否支持服务端联网，避免用户误以为「对话=搜索可见度」 */
function strengthLabel(meta) {
  const hasTools = Array.isArray(meta.tools) && meta.tools.length > 0;
  return `${meta.label}${hasTools ? ' · 联网' : ' · 对话'}`;
}
