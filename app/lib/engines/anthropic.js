/**
 * lib/engines/anthropic.js
 * Claude（Anthropic Messages API）适配器。
 *
 * 与 OpenAI 兼容端点不同，Anthropic 用 `/v1/messages` + `x-api-key` 头，
 * 联网检索通过内置工具 `web_search_20250305` 完成，引用挂在文本块的 `citations` 上。
 *
 * 诚实标注：只有在真的用了 web_search（响应里出现 server_tool_use / citations）时才算 retrieval，
 * 否则 mode = memory——「Claude 说了」不等于「Claude 搜到了」。
 */
import { postJson } from './http.js';
import { anthropicText, collectCitations, searchCallCount } from './parse.js';

const DEFAULT_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export function createAnthropicEngine({
  meta = { id: 'claude', label: 'Claude' },
  apiKey = '',
  model = 'claude-sonnet-4-5',
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl,
} = {}) {
  const engineId = meta.id ?? 'claude';

  return {
    id: engineId,
    label: meta.label ?? engineId,
    describe() {
      return { endpoint, model, builtinSearch: true };
    },
    async ask(question, options = {}) {
      const startedAt = Date.now();
      const text = String(question?.text ?? question ?? '').trim();
      if (!apiKey) {
        return {
          text: '', citations: [], searchQueries: [], raw: null,
          status: 'unavailable', error: '未配置 CLAUDE_API_KEY',
          latencyMs: 0, mode: 'unavailable', searchCalls: 0,
        };
      }
      const timeoutMs = Number(options?.timeoutMs ?? 60000);
      try {
        const data = await postJson(endpoint, {
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            'content-type': 'application/json',
          },
          body: {
            model,
            max_tokens: 1500,
            system:
              '你是一个中文 AI 搜索助手。直接回答问题，先给结论再给要点；涉及具体公司只写能公开核实的名称，不编造案例、数据、资质；不确定就说明不确定。',
            messages: [{ role: 'user', content: text }],
            tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
          },
          timeoutMs,
          fetchImpl,
        });

        const answer = anthropicText(data);
        if (!answer) {
          return {
            text: '', citations: [], searchQueries: [], raw: data,
            status: 'engine_error', error: 'Claude 返回正文为空',
            latencyMs: Math.max(0, Date.now() - startedAt), mode: 'engine_error', searchCalls: 0,
          };
        }
        const citations = collectCitations(data, { limit: 10 });
        const searchCalls = searchCallCount(data) || (Array.isArray(data?.content) && data.content.some((part) => part?.type === 'server_tool_use') ? 1 : 0);
        return {
          text: answer,
          citations,
          searchQueries: [],
          raw: data,
          status: 'ok',
          error: null,
          latencyMs: Math.max(0, Date.now() - startedAt),
          mode: citations.length || searchCalls ? 'retrieval:anthropic' : 'memory',
          searchCalls: searchCalls || (citations.length ? 1 : 0),
        };
      } catch (error) {
        return {
          text: '', citations: [], searchQueries: [], raw: null,
          status: 'engine_error', error: `${engineId} 调用失败：${error?.message ?? error}`,
          latencyMs: Math.max(0, Date.now() - startedAt), mode: 'engine_error', searchCalls: 0,
        };
      }
    },
  };
}
