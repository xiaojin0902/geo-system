/**
 * lib/engines/deepseek.js
 * DeepSeek 采集引擎（带回退链，三条路径按「证据强度」降序）。
 *
 * 为什么要有三条路径：GEO 诊断问的是「AI 搜索**实际**怎么回答」，
 * 而模型「记得什么」（无检索）和「检索到了什么」（有检索）是两个数量级不同的事。
 * 旧实现只走 /chat/completions，拿到的是模型记忆，报告会系统性低估可见度。
 *
 *   路径 1 retrieval:responses —— Responses API + 服务端 web_search 工具
 *                                 （官方文档：web_search 仅 deepseek-v4-pro 生效），
 *                                 最接近「AI 搜索产品面」的真实回答。
 *   路径 2 retrieval:rag       —— 官方 /v1/tools/search 检索 → 注入上下文 → 生成。
 *                                 RAG 近似：检索结果确定、可溯源，但答案不是产品面原文。
 *   路径 3 memory              —— 纯 chat（无检索）。仅在两条检索路径都失败时兜底，
 *                                 报告必须能看出这一轮是「记忆」而非「搜索」。
 *
 * 关键纪律：mode 字段必须如实上报，绝不允许把 memory 的结果标成 retrieval。
 * 提示词为本项目自写，不复制任何第三方提示词原文。
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
import {
  apiErrorMessage,
  collectCitations,
  collectSearchQueries,
  responsesText,
  searchCallCount,
} from './parse.js';

export const DEEPSEEK_META = Object.freeze({
  id: 'deepseek',
  label: 'DeepSeek · 联网检索',
  requiresKey: true,
});

export const DEEPSEEK_CHAT_ENDPOINT = 'https://api.deepseek.com/chat/completions';
export const DEEPSEEK_RESPONSES_ENDPOINT = 'https://api.deepseek.com/responses';
export const DEEPSEEK_SEARCH_ENDPOINT = 'https://api.deepseek.com/v1/tools/search';

/** 纯对话模型（无检索，成本最低） */
export const DEEPSEEK_MODEL = 'deepseek-chat';
/** 支持服务端 web_search 工具的模型（官方文档明确只有 v4-pro 生效） */
export const DEEPSEEK_SEARCH_MODEL = 'deepseek-v4-pro';
/** 兼容旧引用：旧版把 chat 端点当唯一入口 */
export const DEEPSEEK_ENDPOINT = DEEPSEEK_CHAT_ENDPOINT;

const SYSTEM_PROMPT = [
  '你是一个中文 AI 搜索助手，正在回答用户关于本地服务商、服务选择与行业做法的问题。',
  '要求：',
  '1. 直接回答问题，先给结论，再给 2-4 条理由或要点；',
  '2. 如果涉及具体公司/服务商，只写你确实知道或能公开核实的名称，不要编造案例、数据、资质；',
  '3. 不确定时明确说明不确定，并给出用户可自行核实的方向；',
  '4. 使用简体中文，避免绝对化承诺。',
].join('\n');

const RAG_SYSTEM_PROMPT = [
  '你是一个中文 AI 搜索助手。下面会给你一组检索到的网页资料。',
  '要求：',
  '1. 只依据这些资料回答，不要引入资料之外的公司、案例或数据；',
  '2. 先给结论，再给 2-4 条要点，涉及具体公司时写清它是哪一家；',
  '3. 引用资料时保留来源链接（Markdown 形式）；',
  '4. 资料不足以回答时，明确说「资料不足」，不要猜测；',
  '5. 使用简体中文，避免绝对化承诺。',
].join('\n');

function elapsed(startedAt) {
  return Math.max(0, Date.now() - startedAt);
}

/**
 * 创建 DeepSeek 引擎实例。
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env] key 来源（缺省回落到 process.env）
 * @param {Function} [options.fetchImpl] 测试注入
 * @param {boolean} [options.retrieval] 是否启用联网检索（默认 true；false 走旧版纯 chat）
 * @param {number} [options.retries]
 * @param {number} [options.retryBaseMs]
 */
export function createDeepseekEngine({
  env = {},
  fetchImpl,
  retrieval = true,
  retries,
  retryBaseMs,
} = {}) {
  const apiKey = pickKey(env, 'DEEPSEEK_API_KEY');
  const transport = {
    headers: { authorization: `Bearer ${apiKey}` },
    fetchImpl,
    ...(retries === undefined ? {} : { retries }),
    ...(retryBaseMs === undefined ? {} : { retryBaseMs }),
  };

  /** 路径 1：Responses API + 服务端 web_search */
  async function viaResponses(text, timeoutMs) {
    const data = await postJson(DEEPSEEK_RESPONSES_ENDPOINT, {
      ...transport,
      timeoutMs,
      body: {
        model: DEEPSEEK_SEARCH_MODEL,
        instructions: SYSTEM_PROMPT,
        input: text,
        // 官方文档：web_search 类型在 deepseek-v4-pro 上生效，其他模型被忽略
        tools: [{ type: 'web_search' }],
        tool_choice: 'auto',
      },
    });
    const answer = responsesText(data);
    if (!answer) throw new Error(apiErrorMessage(data) || 'Responses API 未返回正文');
    return {
      text: answer,
      citations: collectCitations(data, { limit: 10 }),
      searchQueries: collectSearchQueries(data),
      raw: data,
      mode: 'retrieval:responses',
      searchCalls: searchCallCount(data, 'responses'),
    };
  }

  /** 路径 2：官方检索接口 → 注入上下文 → 对话生成（RAG 近似） */
  async function viaRag(text, timeoutMs) {
    const search = await postJson(DEEPSEEK_SEARCH_ENDPOINT, {
      ...transport,
      timeoutMs,
      body: { query: text.slice(0, 128), count: 8, need_content: false },
    });
    const results = Array.isArray(search?.results) ? search.results : [];
    if (!results.length) throw new Error('检索接口未返回任何结果');

    const context = results
      .slice(0, 8)
      .map((item, index) => {
        const title = String(item.title ?? '').trim() || item.url || `资料${index + 1}`;
        const summary = String(item.summary ?? item.snippet ?? '').trim();
        return `[${index + 1}] ${title}\nURL: ${item.url}\n摘要: ${summary.slice(0, 600)}`;
      })
      .join('\n\n');

    const chat = await postJson(DEEPSEEK_CHAT_ENDPOINT, {
      ...transport,
      timeoutMs,
      body: {
        model: DEEPSEEK_MODEL,
        temperature: 0.3,
        max_tokens: 1500,
        stream: false,
        messages: [
          { role: 'system', content: RAG_SYSTEM_PROMPT },
          { role: 'user', content: `用户问题：${text}\n\n检索资料：\n${context}` },
        ],
      },
    });
    const answer = chatCompletionText(chat).trim();
    if (!answer) throw new Error('RAG 生成阶段未返回正文');

    return {
      text: answer,
      citations: mergeCitations(
        results.map((item) => ({ title: item.title ?? '', url: item.url })),
        extractCitations(answer, 10),
        10,
      ),
      raw: { search, chat },
      // RAG 路径的检索词是我们自己发的，不是引擎改写的；如实记录一条，供分析区分
      searchQueries: [String(text).slice(0, 128)],
      mode: 'retrieval:rag',
      searchCalls: 1,
    };
  }

  /** 路径 3：纯 chat（无检索）——兜底，必须如实标注 memory */
  async function viaMemory(text, timeoutMs) {
    const data = await postJson(DEEPSEEK_CHAT_ENDPOINT, {
      ...transport,
      timeoutMs,
      body: {
        model: DEEPSEEK_MODEL,
        temperature: 0.3,
        max_tokens: 1500,
        stream: false,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      },
    });
    return { text: chatCompletionText(data).trim(), raw: data, mode: 'memory', searchCalls: 0 };
  }

  return {
    id: DEEPSEEK_META.id,
    label: DEEPSEEK_META.label,

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
          error:
            '未配置 DEEPSEEK_API_KEY，无法调用 DeepSeek。请在 app/.env 填写密钥，或改用 --engines mock 先跑通流程。',
          latencyMs: 0,
          mode: 'unavailable',
          searchCalls: 0,
        };
      }

      // 逐级降级：每一步失败都记录原因，最终错误里带上完整链路，方便 doctor 定位
      const failures = [];
      if (retrieval) {
        for (const [label, runner] of [
          ['responses', viaResponses],
          ['rag', viaRag],
        ]) {
          try {
            const result = await runner(text, timeoutMs);
            if (!result.text) throw new Error('返回正文为空');
            if (looksLikeRefusal(result.text)) {
              return {
                text: result.text,
                citations: mergeCitations(result.citations, [], 10),
                searchQueries: Array.isArray(result.searchQueries) ? result.searchQueries : [],
                raw: result.raw,
                status: 'refused',
                error: null,
                latencyMs: elapsed(startedAt),
                mode: result.mode,
                searchCalls: result.searchCalls,
              };
            }
            return {
              text: result.text,
              citations: mergeCitations(result.citations, extractCitations(result.text, 10), 10),
              searchQueries: Array.isArray(result.searchQueries) ? result.searchQueries : [],
              raw: result.raw,
              status: 'ok',
              error: null,
              latencyMs: elapsed(startedAt),
              mode: result.mode,
              searchCalls: result.searchCalls,
            };
          } catch (error) {
            failures.push(`${label}: ${error?.message ?? error}`);
          }
        }
      }

      try {
        const result = await viaMemory(text, timeoutMs);
        if (!result.text) throw new Error('返回正文为空');
        const refused = looksLikeRefusal(result.text);
        return {
          text: result.text,
          citations: extractCitations(result.text),
          searchQueries: [],
          raw: result.raw,
          status: refused ? 'refused' : 'ok',
          error: refused ? '模型声明无法回答该问题' : null,
          latencyMs: elapsed(startedAt),
          mode: result.mode,
          searchCalls: 0,
        };
      } catch (error) {
        const chain = failures.length ? `；检索链路失败：${failures.join(' / ')}` : '';
        return {
          text: '',
          citations: [],
          raw: null,
          status: 'engine_error',
          error: `DeepSeek 调用失败：${error?.message ?? error}${chain}`,
          latencyMs: elapsed(startedAt),
          mode: 'engine_error',
          searchCalls: 0,
        };
      }
    },
  };
}
