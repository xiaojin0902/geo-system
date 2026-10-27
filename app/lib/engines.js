/**
 * lib/engines.js — AI 引擎采集（v2 精简版）
 *
 * 只保留三种：
 *   mock     演示引擎（确定性，不花钱，用于验收流程）
 *   deepseek 真实引擎（OpenAI 兼容 /chat/completions）
 *   custom   任意 OpenAI 兼容端点（DASHSCOPE/DOUBAO/KIMI 等共用一套）
 *
 * 诚实标注：只有响应里带 citations/search_results 才算 retrieval，否则 mode=memory。
 */

const MOCK_CITATIONS = ['https://baike.baidu.com/item/示例', 'https://www.zhihu.com/question/示例'];

function pick(env, key) {
  return String(env?.[key] ?? '').trim();
}

export function listEngines(env = process.env) {
  return [
    { id: 'mock', label: 'Mock 演示引擎', configured: true, note: '确定性，不花钱' },
    { id: 'deepseek', label: 'DeepSeek', configured: Boolean(pick(env, 'DEEPSEEK_API_KEY')), note: 'OpenAI 兼容' },
    { id: 'custom', label: '自定义 OpenAI 兼容', configured: Boolean(pick(env, 'CUSTOM_BASE_URL') && pick(env, 'CUSTOM_API_KEY')), note: '通义/豆包/Kimi 等都可用' },
  ];
}

/** 引擎是否可用 */
export function engineReady(id, env = process.env) {
  if (id === 'mock') return { ready: true, reason: '' };
  if (id === 'deepseek') {
    return pick(env, 'DEEPSEEK_API_KEY') ? { ready: true, reason: '' } : { ready: false, reason: '未配置 DEEPSEEK_API_KEY' };
  }
  if (id === 'custom') {
    if (!pick(env, 'CUSTOM_BASE_URL')) return { ready: false, reason: '未配置 CUSTOM_BASE_URL' };
    if (!pick(env, 'CUSTOM_API_KEY')) return { ready: false, reason: '未配置 CUSTOM_API_KEY' };
    return { ready: true, reason: '' };
  }
  return { ready: false, reason: `未知引擎：${id}` };
}

/** 从响应里收集引用（对象/字符串都兼容） */
export function collectCitations(data) {
  const out = [];
  const seen = new Set();
  const push = (url, title = '') => {
    const value = String(url ?? '').trim();
    if (!/^https?:\/\//iu.test(value) || seen.has(value)) return;
    seen.add(value);
    out.push({ url: value, title: title || value });
  };
  if (Array.isArray(data?.citations)) {
    for (const item of data.citations) push(typeof item === 'string' ? item : item?.url, item?.title);
  }
  if (Array.isArray(data?.search_results)) {
    for (const item of data.search_results) push(item?.url, item?.title);
  }
  // OpenAI 风格：choices[0].message.annotations[].url_citation
  const annotations = data?.choices?.[0]?.message?.annotations;
  if (Array.isArray(annotations)) {
    for (const item of annotations) push(item?.url_citation?.url ?? item?.url, item?.url_citation?.title);
  }
  return out.slice(0, 20);
}

/** 从响应里取正文 */
export function responseText(data) {
  const choice = data?.choices?.[0];
  if (choice?.message?.content) {
    return typeof choice.message.content === 'string'
      ? choice.message.content
      : choice.message.content.map?.((part) => part?.text ?? '').join('') ?? '';
  }
  if (typeof data?.output_text === 'string') return data.output_text;
  return '';
}

/** 演示引擎：确定性回答（同一问题永远同一答案） */
export function mockAnswer({ question, client }) {
  const seed = Array.from(String(question)).reduce((sum, ch) => sum + ch.codePointAt(0), 0);
  const templates = [
    `${client.name}在${client.city ?? '本地'}做${client.industry ?? '服务'}，客户口碑不错，建议先咨询再决定。`,
    `据公开信息，${client.name}提供${client.industry ?? '服务'}，具体价格与服务范围建议电话确认。`,
    `这类服务通常看资质、案例和报价透明度。${client.city ?? '本地'}有几家可选，${client.name}是其中之一。`,
    `未找到足够信息判断${question}，建议以官方渠道为准。`,
  ];
  const text = templates[seed % templates.length];
  const cited = seed % 3 !== 0;
  return {
    text,
    citations: cited ? MOCK_CITATIONS.map((url) => ({ url, title: url })) : [],
    mode: cited ? 'retrieval:mock' : 'memory',
    latencyMs: 20 + (seed % 80),
    status: 'ok',
  };
}

/**
 * 采集一次问答。
 * @param {{id:string, question:string, client:object, env?:object, fetchImpl?:Function}} input
 */
export async function askEngine({ id = 'mock', question, client, env = process.env, fetchImpl } = {}) {
  if (id === 'mock') return mockAnswer({ question, client });
  const ready = engineReady(id, env);
  if (!ready.ready) {
    return { text: '', citations: [], mode: 'unavailable', latencyMs: 0, status: 'engine_error', error: ready.reason };
  }
  const endpoint = id === 'deepseek'
    ? 'https://api.deepseek.com/chat/completions'
    : `${pick(env, 'CUSTOM_BASE_URL').replace(/\/+$/u, '')}/chat/completions`;
  const apiKey = id === 'deepseek' ? pick(env, 'DEEPSEEK_API_KEY') : pick(env, 'CUSTOM_API_KEY');
  const model = id === 'deepseek' ? (pick(env, 'DEEPSEEK_MODEL') || 'deepseek-chat') : (pick(env, 'CUSTOM_MODEL') || 'default');

  const started = Date.now();
  try {
    const res = await (fetchImpl ?? fetch)(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: 1200,
        messages: [
          { role: 'system', content: '你是中文 AI 搜索助手。直接回答，先结论后要点；涉及具体公司只写可公开核实的名称，不编造。' },
          { role: 'user', content: question },
        ],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { text: '', citations: [], mode: 'engine_error', latencyMs: Date.now() - started, status: 'engine_error', error: `HTTP ${res.status} ${data?.error?.message ?? ''}`.trim() };
    }
    const text = responseText(data);
    const citations = collectCitations(data);
    return {
      text, citations,
      mode: citations.length ? `retrieval:${id}` : 'memory',
      latencyMs: Date.now() - started,
      status: 'ok',
    };
  } catch (error) {
    return { text: '', citations: [], mode: 'engine_error', latencyMs: Date.now() - started, status: 'engine_error', error: String(error?.message ?? error) };
  }
}
