/**
 * lib/engines/http.js
 * 引擎通用 HTTP 工具：POST JSON + 超时 + 网络错误重试，外加少量纯文本工具。
 *
 * 设计参考：GEO 采集层必须区分「网络失败 / 超时 / 上游业务错误」，
 * 只有可恢复错误才重试；错误要带中文可操作提示，方便 CLI 与 run 记录。
 * 零 npm 依赖，使用 Node ≥ 22 自带 fetch。
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 2; // 网络错误额外重试 2 次（总计最多 3 次请求）
const DEFAULT_RETRY_BASE_MS = 300; // 指数退避基数：300ms → 600ms
const MAX_ERROR_BODY_CHARS = 400;

/**
 * 取环境变量里的 key。优先用调用方显式传入的 env（便于测试与 loadEnv 注入），
 * 其次回落到 process.env（CLI 直接跑 live 时用）。
 * @param {Record<string, string|undefined>} env
 * @param {string} name
 * @returns {string}
 */
export function pickKey(env, name) {
  if (env && typeof env[name] === 'string' && env[name].trim()) return env[name].trim();
  const fromProcess = process.env ? process.env[name] : '';
  return typeof fromProcess === 'string' ? fromProcess.trim() : '';
}

/**
 * 统一取问题文本：允许传入字符串，或 store.listQuestions() 返回的题目对象。
 * @param {string|{text?:string,question?:string,prompt?:string}|null|undefined} question
 * @returns {string}
 */
export function questionText(question) {
  if (typeof question === 'string') return question;
  if (!question || typeof question !== 'object') return '';
  const value = question.text ?? question.question ?? question.prompt ?? '';
  return typeof value === 'string' ? value : String(value ?? '');
}

/**
 * 从回答正文里抽取引用（markdown 链接 + 裸 URL），按出现顺序去重。
 * live 引擎的引用来自回答正文；dashscope 联网搜索的 search_info 另行处理。
 * @param {string} text
 * @param {number} limit
 * @returns {{title:string,url:string}[]}
 */
export function extractCitations(text, limit = 5) {
  const source = String(text ?? '');
  const found = [];
  const seen = new Set();

  const push = (title, url) => {
    let clean = String(url ?? '').trim();
    clean = clean.replace(/[.,;:!?，。；：！？）)】」』]+$/u, '');
    if (!/^https?:\/\//iu.test(clean)) return;
    if (seen.has(clean)) return;
    seen.add(clean);
    const label = String(title ?? '').trim();
    found.push({ title: label || clean, url: clean });
  };

  // 1) markdown 链接：[标题](https://...)
  const markdownLink = /\[([^\]\n]{1,120})\]\((https?:\/\/[^\s)]+)\)/giu;
  let match;
  while (found.length < limit && (match = markdownLink.exec(source)) !== null) {
    push(match[1], match[2]);
  }

  // 2) 裸 URL
  const bareUrl = /(https?:\/\/[^\s<>"'）)】\]，。；、]+)/giu;
  while (found.length < limit && (match = bareUrl.exec(source)) !== null) {
    push(match[1], match[1]);
  }

  return found.slice(0, limit);
}

/**
 * 保守判断模型回答是否为「拒答」。只在开头出现明确的无法回答时才判拒答，
 * 避免把正文里的“无法保证效果”误判成拒答。
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeRefusal(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  const head = value.slice(0, 160);
  if (/^(抱歉|对不起|很抱歉|不好意思)[^。！？\n]{0,40}(无法|不能|不便|没办法)/u.test(head)) return true;
  if (/^我(无法|不能)(回答|提供|帮助)/u.test(head)) return true;
  return false;
}

/**
 * 从 OpenAI 兼容的 chat/completions 响应里取回答正文。
 * @param {any} data
 * @returns {string}
 */
export function chatCompletionText(data) {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  if (!choice) return '';
  const message = choice.message ?? choice.delta ?? null;
  const content = message ? message.content : choice.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : String((part && part.text) ?? '')))
      .join('');
  }
  return '';
}

/**
 * 合并引用并去重（保留先出现的）。
 * @param {{title:string,url:string}[]} primary
 * @param {{title:string,url:string}[]} secondary
 * @param {number} limit
 */
export function mergeCitations(primary, secondary, limit = 5) {
  const seen = new Set();
  const merged = [];
  for (const item of [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])]) {
    if (!item || !item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    merged.push({ title: item.title || item.url, url: item.url });
    if (merged.length >= limit) break;
  }
  return merged;
}

function truncate(value, max) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function makeHttpError(message, { code, statusCode, retryable = false } = {}) {
  const error = new Error(message);
  error.code = code;
  if (statusCode !== undefined) error.statusCode = statusCode;
  error.retryable = Boolean(retryable);
  return error;
}

function delay(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 单次请求。语义：返回解析后的 JSON；网络错误 / 超时 / 429 / 5xx 标记为可重试，
 * 其它 4xx 与 JSON 解析失败直接抛错（不重试）。
 */
async function postJsonOnce(url, { headers, body, timeoutMs, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw makeHttpError('当前 Node 环境没有可用的 fetch，请升级到 Node ≥ 22 后重试', {
      code: 'NO_FETCH',
      retryable: false,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));

  try {
    let response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(headers || {}) },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw makeHttpError(`请求超时（${timeoutMs}ms）：${url}`, { code: 'TIMEOUT', retryable: true });
      }
      throw makeHttpError(`网络错误：${error && error.message ? error.message : String(error)}`, {
        code: 'NETWORK',
        retryable: true,
      });
    }

    const status = Number(response && response.status) || 0;

    let raw = '';
    try {
      raw = await response.text();
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw makeHttpError(`读取响应超时（${timeoutMs}ms）：${url}`, { code: 'TIMEOUT', retryable: true });
      }
      throw makeHttpError(`读取响应失败：${error && error.message ? error.message : String(error)}`, {
        code: 'NETWORK',
        retryable: true,
      });
    }

    if (!response || !response.ok) {
      const retryable = status === 429 || status >= 500;
      throw makeHttpError(`HTTP ${status}：${truncate(raw, MAX_ERROR_BODY_CHARS)}`, {
        code: 'HTTP',
        statusCode: status,
        retryable,
      });
    }

    try {
      return JSON.parse(raw);
    } catch {
      throw makeHttpError(`响应不是合法 JSON：${truncate(raw, MAX_ERROR_BODY_CHARS)}`, {
        code: 'PARSE',
        statusCode: status,
        retryable: false,
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST JSON，带超时与重试。
 * @param {string} url
 * @param {object} options
 * @param {Record<string,string>} [options.headers]
 * @param {unknown} [options.body]
 * @param {number} [options.timeoutMs=60000]
 * @param {number} [options.retries=2] 额外重试次数（只对网络/超时/429/5xx 生效）
 * @param {number} [options.retryBaseMs=300] 指数退避基数
 * @param {Function} [options.fetchImpl] 便于测试注入的 fetch 实现
 * @returns {Promise<any>} 解析后的 JSON
 */
export async function postJson(url, options = {}) {
  const {
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    fetchImpl,
  } = options;

  const extraRetries = Number.isFinite(Number(retries)) ? Math.max(0, Math.floor(Number(retries))) : DEFAULT_RETRIES;
  const attempts = extraRetries + 1;

  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await postJsonOnce(url, { headers, body, timeoutMs, fetchImpl });
    } catch (error) {
      lastError = error;
      if (!error || !error.retryable || attempt === attempts - 1) throw error;
      await delay(retryBaseMs * 2 ** attempt);
    }
  }
  throw lastError;
}

export const HTTP_DEFAULTS = Object.freeze({
  timeoutMs: DEFAULT_TIMEOUT_MS,
  retries: DEFAULT_RETRIES,
  retryBaseMs: DEFAULT_RETRY_BASE_MS,
});
