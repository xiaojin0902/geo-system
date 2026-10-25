/**
 * lib/engines/dashscope.js
 * 阿里云百炼（DashScope）OpenAI 兼容模式采集引擎，可选联网搜索。
 *
 * - 端点：https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
 * - 模型：qwen-plus
 * - key ：DASHSCOPE_API_KEY（无 key → status:'unavailable'，不抛异常）
 * - 联网搜索：extra_body.enable_search = true；若响应带 search_info.search_results，
 *   一并转成 citations，便于报告做「来源引用」统计。
 * 提问保持中立、不向模型泄露品牌。提示词为本项目自写，不复制第三方提示词原文。
 */

import {
  chatCompletionText,
  extractCitations,
  looksLikeRefusal,
  mergeCitations,
  pickKey,
  postJson,
  questionText,
} from './http.js';

export const DASHSCOPE_META = Object.freeze({
  id: 'dashscope',
  label: '阿里百炼 Qwen · qwen-plus（联网搜索）',
  requiresKey: true,
});

export const DASHSCOPE_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
export const DASHSCOPE_MODEL = 'qwen-plus';

const SYSTEM_PROMPT = [
  '你是一个中文 AI 搜索助手，正在回答用户关于本地服务商、服务选择与行业做法的问题。',
  '要求：',
  '1. 直接回答，先结论后理由，必要时列出可对比的候选；',
  '2. 涉及具体公司/服务商时只写能公开核实的名称，不编造案例、数据、资质；',
  '3. 如果能联网检索，优先给出可核查的来源链接；',
  '4. 不确定就说明不确定；使用简体中文，避免绝对化承诺。',
].join('\n');

/** 把百炼联网搜索返回的 search_info 转成引用。 */
function searchInfoCitations(data, limit = 5) {
  const info = data && data.search_info;
  const results = info && Array.isArray(info.search_results) ? info.search_results : [];
  const citations = [];
  for (const item of results) {
    if (!item || typeof item !== 'object') continue;
    const url = typeof item.url === 'string' ? item.url : '';
    if (!/^https?:\/\//iu.test(url)) continue;
    const title = String(item.title || item.site_name || item.source || url).trim() || url;
    citations.push({ title, url });
    if (citations.length >= limit) break;
  }
  return citations;
}

/**
 * 创建百炼引擎实例。
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env] key 来源（缺省回落到 process.env）
 * @param {Function} [options.fetchImpl] 测试注入
 */
export function createDashscopeEngine({ env = {}, fetchImpl, retries, retryBaseMs } = {}) {
  const apiKey = pickKey(env, 'DASHSCOPE_API_KEY');

  return {
    id: DASHSCOPE_META.id,
    label: DASHSCOPE_META.label,

    async ask(question, options = {}) {
      const startedAt = Date.now();
      const text = questionText(question).trim();
      const timeoutMs =
        options && Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 60_000;

      if (!apiKey) {
        return {
          text: '',
          citations: [],
          raw: null,
          status: 'unavailable',
          error: '未配置 DASHSCOPE_API_KEY，无法调用百炼 Qwen。请在 app/.env 填写密钥，或改用 --engines mock 先跑通流程。',
          latencyMs: 0,
        };
      }

      const body = {
        model: DASHSCOPE_MODEL,
        temperature: 0.3,
        max_tokens: 1500,
        stream: false,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        // SPEC §3.3：可选联网搜索参数
        extra_body: { enable_search: true },
      };

      try {
        const data = await postJson(DASHSCOPE_ENDPOINT, {
          headers: { authorization: `Bearer ${apiKey}` },
          body,
          timeoutMs,
          fetchImpl,
          ...(retries === undefined ? {} : { retries }),
          ...(retryBaseMs === undefined ? {} : { retryBaseMs }),
        });
        const answer = chatCompletionText(data).trim();
        const latencyMs = Date.now() - startedAt;

        if (!answer) {
          return {
            text: '',
            citations: [],
            raw: data,
            status: 'engine_error',
            error: '百炼 Qwen 返回了空回答',
            latencyMs,
          };
        }

        const refused = looksLikeRefusal(answer);
        const citations = mergeCitations(searchInfoCitations(data), extractCitations(answer), 5);
        const result = {
          text: answer,
          citations,
          raw: data,
          status: refused ? 'refused' : 'ok',
          latencyMs,
        };
        if (refused) result.error = '模型声明无法回答该问题';
        return result;
      } catch (error) {
        return {
          text: '',
          citations: [],
          raw: null,
          status: 'engine_error',
          error: `百炼 Qwen 调用失败：${error && error.message ? error.message : String(error)}`,
          latencyMs: Date.now() - startedAt,
        };
      }
    },
  };
}
