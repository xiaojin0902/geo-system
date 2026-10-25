/**
 * lib/engines/parse.js
 * 各家「检索型」响应的统一解析。
 *
 * 为什么单独成文件：DeepSeek 的 Responses API、Anthropic 兼容口、以及自建 RAG
 * 三种返回结构完全不同，但「正文」和「引用」的提取逻辑是同一件事，集中在一处
 * 才能保证判定层拿到的引用格式永远一致（SPEC §0.1 单一来源思想的延伸）。
 *
 * 设计取舍：结构化字段随厂商版本漂移，因此引用提取采用**递归扫描**——
 * 只认「带 http(s) url 的对象」这一条铁律，不硬编码某一层路径。
 * 宁可多摘一条，也不因为字段改名而静默丢引用（丢引用会让报告低估可见度）。
 */

const URL_RE = /^https?:\/\//iu;

/**
 * 从任意嵌套结构中递归收集 {title,url}。
 * @param {unknown} node
 * @param {{out?: {title:string,url:string}[], seen?: Set<string>, limit?: number}} [state]
 * @param {number} [depth] 防御性深度上限，避免异常载荷导致栈溢出
 * @returns {{title:string,url:string}[]}
 */
export function collectCitations(node, state = {}, depth = 0) {
  const out = state.out ?? [];
  const seen = state.seen ?? new Set();
  const limit = state.limit ?? 20;
  state.out = out;
  state.seen = seen;

  if (out.length >= limit || depth > 8 || node === null || node === undefined) return out;

  if (Array.isArray(node)) {
    for (const item of node) {
      if (out.length >= limit) break;
      collectCitations(item, state, depth + 1);
    }
    return out;
  }

  if (typeof node !== 'object') return out;

  const obj = /** @type {Record<string, unknown>} */ (node);
  const rawUrl = obj.url ?? obj.uri ?? obj.link ?? obj.source_url;
  if (typeof rawUrl === 'string' && URL_RE.test(rawUrl.trim())) {
    // DeepSeek 的 web_search 结果会在 URL 末尾挂一个 #ws_call_id=call_xxx 的内部片段，
    // 它既不是页面锚点也不是来源信息，留着会污染引用列表与标题展示，这里直接剥掉。
    const url = rawUrl.trim().replace(/#ws_call_id=.*$/iu, '');
    if (!seen.has(url)) {
      seen.add(url);
      const rawTitle = obj.title ?? obj.name ?? obj.site_name ?? obj.domain ?? '';
      const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
      out.push({ title: title || url, url });
    }
  }

  for (const value of Object.values(obj)) {
    if (out.length >= limit) break;
    if (value && typeof value === 'object') collectCitations(value, state, depth + 1);
  }
  return out;
}

/**
 * 抽取 Responses API 形状的正文。
 * 优先 output_text 便捷字段，其次遍历 output[].content[] 的文本块。
 * @param {any} data
 * @returns {string}
 */
export function responsesText(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text;
  const chunks = [];
  const output = Array.isArray(data.output) ? data.output : [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    if (item.type !== 'message') continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const type = String(part.type ?? '');
      if (type === 'output_text' || type === 'text') {
        if (typeof part.text === 'string') chunks.push(part.text);
      }
    }
  }
  return chunks.join('').trim();
}

/**
 * 抽取 Anthropic 兼容口的正文（content[] 里 type==='text' 的块）。
 * @param {any} data
 * @returns {string}
 */
export function anthropicText(data) {
  if (!data || typeof data !== 'object') return '';
  const content = Array.isArray(data.content) ? data.content : [];
  return content
    .filter((part) => part && typeof part === 'object' && (part.type === 'text' || part.type === undefined))
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

/**
 * 统计服务端联网检索次数（用于成本核算与「到底检索了没有」的事实判断）。
 * - OpenAI/DeepSeek Responses：usage.server_tool_use.web_search_requests
 * - Anthropic 兼容口：content 里 server_tool_use 块的数量
 * @param {any} data
 * @param {'responses'|'anthropic'} kind
 * @returns {number}
 */
export function searchCallCount(data, kind) {
  if (!data || typeof data !== 'object') return 0;
  const usage = data.usage ?? {};
  const serverToolUse = usage.server_tool_use ?? {};
  const fromUsage = Number(serverToolUse.web_search_requests);
  if (Number.isFinite(fromUsage) && fromUsage > 0) return fromUsage;
  if (kind === 'anthropic') {
    const content = Array.isArray(data.content) ? data.content : [];
    return content.filter((part) => part && part.type === 'server_tool_use').length;
  }
  const output = Array.isArray(data.output) ? data.output : [];
  return output.filter((item) => item && item.type === 'web_search_call').length;
}

/**
 * 取响应里第一条可读的错误信息（用于 doctor / 失败诊断）。
 * @param {any} data
 * @returns {string}
 */
export function apiErrorMessage(data) {
  if (!data || typeof data !== 'object') return '';
  const err = data.error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const message = err.message ?? err.msg ?? err.code ?? err.type;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  if (typeof data.message === 'string' && data.message.trim()) return data.message.trim();
  return '';
}

/**
 * 采集「引擎把你的问题改写成了哪些搜索词」（query fan-out）。
 *
 * 为什么这个值钱：用户在 AI 里问一句话，引擎内部会拆成多个检索式。
 * 知道它拆成什么，才能知道「内容该覆盖哪些真实检索词」——这是 elmo 等商业产品的
 * 差异化功能之一，也是判断「模型到底检索了没」的硬证据。
 *
 * 实现策略：递归扫描字段名白名单（query / queries / search_query / rewritten_query …），
 * 只认字符串或字符串数组。宁多勿漏，调用方负责与原始问题去重。
 *
 * @param {unknown} node
 * @param {{out?: string[], seen?: Set<string>, limit?: number}} [state]
 * @param {number} [depth]
 * @returns {string[]}
 */
export function collectSearchQueries(node, state = {}, depth = 0) {
  const out = state.out ?? [];
  const seen = state.seen ?? new Set();
  const limit = state.limit ?? 20;
  state.out = out;
  state.seen = seen;

  if (out.length >= limit || depth > 8 || node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (out.length >= limit) break;
      collectSearchQueries(item, state, depth + 1);
    }
    return out;
  }
  if (typeof node !== 'object') return out;

  const KEY_RE = /^(query|queries|search_query|search_queries|rewritten_query|sub_queries|q)$/iu;
  // 真实返回里会混入工具调用的内部回显（ws_call_id=call_xxx），它不是检索词，必须剔掉，
  // 否则 fan-out 分析里会出现一串内部 ID，污染「内容该覆盖哪些词」的结论。
  const JUNK_RE = /^(?:ws_call_id|call_|tool_call|id=)/iu;
  const push = (value) => {
    const text = String(value ?? '').trim();
    if (!text || seen.has(text) || out.length >= limit) return;
    if (JUNK_RE.test(text) || /ws_call_id/iu.test(text)) return;
    seen.add(text);
    out.push(text);
  };

  for (const [key, value] of Object.entries(node)) {
    if (KEY_RE.test(key)) {
      if (typeof value === 'string') push(value);
      else if (Array.isArray(value)) value.forEach((item) => typeof item === 'string' && push(item));
    }
    if (value && typeof value === 'object') collectSearchQueries(value, state, depth + 1);
    if (out.length >= limit) break;
  }
  return out;
}
