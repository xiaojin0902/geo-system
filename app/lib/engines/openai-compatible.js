/**
 * lib/engines/openai-compatible.js
 * 通用 OpenAI 兼容引擎工厂：一次实现，接出豆包/Kimi/元宝(中转)/任何兼容端点。
 *
 * 为什么做成工厂而不是三个复制粘贴的 adapter：
 *   各家差异只有「端点 + 模型 + 联网工具怎么声明」，采集与解析逻辑完全一样。
 *   复制三份的后果是——改一处漏两处，最后三家行为不一致（OmniRank 就踩过
 *   「前端按一份引擎清单计价、管线按另一份执行」的事故）。
 *
 * 联网检索的三种现实情况（必须如实标注，不能把记忆当搜索）：
 *   · builtin 工具：请求里声明厂商内置搜索工具（如 Kimi 的 $web_search）；
 *   · 服务端自动带引用：不声明工具，但响应里直接有 citations/search_info；
 *   · 纯对话：什么都没拿到，mode = 'memory'。
 */

import {
  chatCompletionText,
  extractCitations,
  looksLikeRefusal,
  mergeCitations,
  postJson,
  questionText,
} from './http.js';
import { apiErrorMessage, collectCitations, collectSearchQueries } from './parse.js';

/**
 * 部分厂商（Perplexity）把引用放在 `citations: ["https://…"]` 这种纯字符串数组里，
 * 而不是带 url 字段的对象。这个函数把它们补进统一的引用结构。
 */
function stringCitations(data) {
  const out = [];
  const push = (value) => {
    if (typeof value === 'string' && /^https?:\/\//iu.test(value.trim())) {
      const url = value.trim();
      out.push({ title: url, url });
    }
  };
  if (Array.isArray(data?.citations)) data.citations.forEach(push);
  if (Array.isArray(data?.search_results)) {
    for (const item of data.search_results) {
      if (item && typeof item === 'object' && typeof item.url === 'string') out.push({ title: item.title ?? item.url, url: item.url });
    }
  }
  return out;
}

/**
 * @param {object} options
 * @param {{id:string,label:string}} options.meta
 * @param {string} options.endpoint 完整 chat/completions URL
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {Array<any>} [options.tools] 内置搜索工具声明（可选）
 * @param {object} [options.extraBody] 额外请求字段（可选）
 * @param {string} [options.provider] 供应商名，用于 mode 标注
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.retries]
 * @param {number} [options.retryBaseMs]
 */
export function createOpenAICompatibleEngine({
  meta,
  endpoint,
  apiKey,
  model,
  tools,
  extraBody,
  provider,
  fetchImpl,
  retries,
  retryBaseMs,
} = {}) {
  const engineId = meta?.id ?? 'openai-compatible';
  const vendor = provider ?? engineId;

  /** 统一构造一次采集结果 */
  function buildResult({ text, citations, queries, raw, usedTools, startedAt }) {
    return {
      text,
      citations: mergeCitations(citations, extractCitations(text, 10), 10),
      raw,
      status: 'ok',
      error: null,
      latencyMs: Math.max(0, Date.now() - startedAt),
      mode: citations.length || (queries && queries.length) ? `retrieval:${vendor}` : 'memory',
      searchCalls: queries && queries.length ? queries.length : citations.length ? 1 : 0,
      searchQueries: queries ?? [],
      usedTools: Boolean(usedTools),
    };
  }

  return {
    id: engineId,
    label: meta?.label ?? engineId,
    /** 便于 doctor / 控制台展示：这个引擎用的哪个模型、走不走内置搜索 */
    describe() {
      return { endpoint, model, builtinSearch: Boolean(tools && tools.length) };
    },

    async ask(question, options = {}) {
      const startedAt = Date.now();
      const text = questionText(question).trim();
      const timeoutMs =
        options && Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 60_000;

      if (!apiKey) {
        return {
          text: '',
          citations: [],
          searchQueries: [],
          raw: null,
          status: 'unavailable',
          error: `未配置该引擎的 API Key（引擎：${engineId}）`,
          latencyMs: 0,
          mode: 'unavailable',
          searchCalls: 0,
        };
      }
      if (!endpoint || !model) {
        return {
          text: '',
          citations: [],
          searchQueries: [],
          raw: null,
          status: 'unavailable',
          error: `引擎「${engineId}」缺少必要配置（endpoint / model），请在 .env 里补齐`,
          latencyMs: 0,
          mode: 'unavailable',
          searchCalls: 0,
        };
      }

      const baseBody = {
        model,
        temperature: 0.3,
        max_tokens: 1500,
        stream: false,
        messages: [
          {
            role: 'system',
            content:
              '你是一个中文 AI 搜索助手。直接回答问题，先给结论再给要点；涉及具体公司只写能公开核实的名称，不编造案例、数据、资质；不确定就说明不确定。',
          },
          { role: 'user', content: text },
        ],
        ...(extraBody ?? {}),
      };

      // 第一次带搜索工具；若厂商不支持该工具字段，退化为不带工具再试一次
      const attempts = tools && tools.length ? [{ tools }, {}] : [{}];
      const failures = [];

      for (const attempt of attempts) {
        try {
          const data = await postJson(endpoint, {
            headers: { authorization: `Bearer ${apiKey}` },
            body: { ...baseBody, ...attempt },
            timeoutMs,
            fetchImpl,
            ...(retries === undefined ? {} : { retries }),
            ...(retryBaseMs === undefined ? {} : { retryBaseMs }),
          });

          const answer = chatCompletionText(data).trim();
          if (!answer) {
            const reason = apiErrorMessage(data) || '返回正文为空';
            throw new Error(reason);
          }
          if (looksLikeRefusal(answer)) {
            return {
              text: answer,
              citations: mergeCitations(collectCitations(data, { limit: 10 }), stringCitations(data), extractCitations(answer, 10), 10),
              searchQueries: collectSearchQueries(data),
              raw: data,
              status: 'refused',
              error: '模型声明无法回答该问题',
              latencyMs: Math.max(0, Date.now() - startedAt),
              mode: `retrieval:${vendor}`,
              searchCalls: 1,
            };
          }
          return buildResult({
            text: answer,
            citations: [...collectCitations(data, { limit: 10 }), ...stringCitations(data)],
            queries: collectSearchQueries(data),
            raw: data,
            usedTools: Boolean(attempt.tools),
            startedAt,
          });
        } catch (error) {
          failures.push(`${attempt.tools ? 'with-tools' : 'no-tools'}: ${error?.message ?? error}`);
        }
      }

      return {
        text: '',
        citations: [],
        searchQueries: [],
        raw: null,
        status: 'engine_error',
        error: `${engineId} 调用失败：${failures.join(' / ')}`,
        latencyMs: Math.max(0, Date.now() - startedAt),
        mode: 'engine_error',
        searchCalls: 0,
      };
    },
  };
}
