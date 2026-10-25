/**
 * lib/audit-site.js
 * 站点 AI 可抓取性体检（GEO 前置诊断）：判断一个网站能不能被 ChatGPT / Perplexity /
 * 豆包 / DeepSeek 这类 AI 引擎抓到并引用。
 *
 * 设计约束：
 *  - 零 npm 依赖，只用 Node ≥ 22 自带的全局 fetch + 内置 URL / Buffer；
 *  - 不需要任何 API Key：全部结论来自「公开 HTTP 表现」，任何第三方都能复核；
 *  - 所有请求可被 options.fetchImpl 替换，测试不发真实网络请求；
 *  - 单次体检最多约 13 个请求（主页 ×1-2 + robots/llms/sitemap ×3 + AI 爬虫 UA ×9）。
 *
 * 为什么是这几项（按 AI 抓取链路从下往上）：
 *  1. 传输层：AI 爬虫只能抓 http/https，站点必须可达；HTTPS 不通会被引擎降权甚至直接放弃；
 *  2. 授权层：robots.txt 是 AI 爬虫的「通行证」，OpenAI / Anthropic / Perplexity 都公开声明遵守；
 *  3. 准入层：大量站点用 CDN/WAF 按 UA 拦爬虫，普通浏览器能开、AI 爬虫 403 —— 最常见的隐形杀手；
 *  4. 供给层：llms.txt / sitemap.xml 决定引擎能否高效、完整地发现内容；
 *  5. 语义层：JSON-LD + meta 决定引擎能否正确理解「你是谁、做什么、在哪」；
 *  6. 渲染层：AI 爬虫不执行 JS，纯前端渲染的页面在它们眼里等于空白。
 *
 * 注意：本模块只做「可抓取性」判断，不评估内容质量；分数低不等于网站差，
 * 只说明 AI 引擎抓取/引用这条链路上有硬障碍。
 */

/** 默认 UA：主动表明身份，方便站长在访问日志里识别并放行。 */
const DEFAULT_USER_AGENT = 'hengye-geo-audit/0.1 (+https://hengye.geo/audit)';

/** 单个请求默认超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 12000;

/** 单个资源最多读取的字符数，避免超大 sitemap / 错误页把内存吃满。 */
const MAX_CHARS = Object.freeze({
  page: 1_000_000,
  robots: 200_000,
  llms: 200_000,
  sitemap: 800_000,
});

/**
 * 参与 UA 实测的 AI 爬虫清单。
 * id 同时是 robots.txt 里的 User-agent token，测试也按 id 断言，避免各处硬编码字符串。
 */
export const AI_CRAWLERS = Object.freeze([
  {
    id: 'GPTBot',
    name: 'OpenAI GPTBot（训练与索引）',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot',
  },
  {
    id: 'OAI-SearchBot',
    name: 'OpenAI OAI-SearchBot（搜索摘要）',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot',
  },
  {
    id: 'ChatGPT-User',
    name: 'ChatGPT-User（用户主动抓取）',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  },
  {
    id: 'ClaudeBot',
    name: 'Anthropic ClaudeBot',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ClaudeBot/1.0; +claudebot@anthropic.com',
  },
  {
    id: 'anthropic-ai',
    name: 'Anthropic anthropic-ai（训练）',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; anthropic-ai/1.0; +claudebot@anthropic.com',
  },
  {
    id: 'PerplexityBot',
    name: 'Perplexity PerplexityBot',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot',
  },
  {
    id: 'Google-Extended',
    name: 'Google Extended（Gemini / Vertex AI）',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Google-Extended; +https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers',
  },
  {
    id: 'Bytespider',
    name: '字节 Bytespider（豆包 / 抖音搜索）',
    ua: 'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 Bytespider; lawyer@bytedance.com',
  },
  {
    id: 'Baiduspider',
    name: '百度 Baiduspider（文心 / 百度搜索）',
    ua: 'Mozilla/5.0 (Linux;u;Android 4.2.2;zh-cn;) AppleWebKit/534.46 (KHTML, like Gecko) Version/5.1 Mobile Safari/10600.6.3 Baiduspider/2.0',
  },
]);

/**
 * 扣分权重（100 分起扣），与任务书的权重表一一对应。
 * 设计原则：**授权/准入类红线合并扣一次**（noindex 与 robots 屏蔽 AI 属同一类"不让你抓"），
 * 避免同一件事被重复计费；内容供给类只轻扣，因为缺了也能被抓到。
 */
export const DEDUCTIONS = Object.freeze({
  /** noindex 或 robots 屏蔽 AI 爬虫：授权层红线 */
  aiBlocked: 35,
  /** AI 爬虫 UA 实测被 403/503/验证页拦截：准入层红线 */
  uaBlocked: 30,
  /** 纯 JS 渲染，正文不在 HTML 里：渲染层红线 */
  jsOnly: 20,
  /** 无 llms.txt */
  noLlmsTxt: 5,
  /** 无 sitemap.xml */
  noSitemap: 5,
  /** 无 JSON-LD 结构化数据 */
  noJsonLd: 5,
  /** 无 meta description */
  noDescription: 3,
  /** 无 rel=canonical */
  noCanonical: 2,
});

/** level 阈值：>=80 好 / 60-79 一般 / 35-59 差 / <35 严重。 */
const LEVEL_THRESHOLDS = Object.freeze([
  { min: 80, level: '好' },
  { min: 60, level: '一般' },
  { min: 35, level: '差' },
  { min: 0, level: '严重' },
]);

/** WAF 把 robots.txt 挡掉时常见的状态码：AI 爬虫拿不到授权文件，等同于"无法确认允许"。 */
const ROBOTS_BLOCKED_STATUSES = Object.freeze([401, 403, 418, 429, 451]);

/** AI 爬虫 UA 被拦时常见的状态码（403/503 最典型）。 */
const UA_BLOCKED_STATUSES = Object.freeze([401, 403, 406, 418, 429, 451, 503]);

/**
 * 验证页 / 挑战页特征。命中即认为 AI 爬虫拿到的是"人机校验壳"而不是正文。
 * 只在响应体较小（< 2 万字符）时匹配，避免正文里恰好出现 "captcha" 一词的误伤。
 */
const CHALLENGE_SIGNATURES = Object.freeze([
  'cf-browser-verification',
  'challenge-platform',
  'just a moment',
  'attention required',
  'enable javascript and cookies to continue',
  'checking your browser',
  'access denied',
  'captcha',
  '人机验证',
  '安全验证',
  '滑动验证',
  '访问验证',
  '请求过于频繁',
]);

/** 空探测结果，用于「未执行该项检查」时保持返回结构一致。 */
const EMPTY_PROBE = Object.freeze({ status: null, body: '', error: null });

function isSuccess(status) {
  return Number.isFinite(status) && status >= 200 && status < 300;
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 解码常见 HTML 实体：schema / meta / title 里出现 &amp; 不处理会让文本比对失真。 */
function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity) => {
    const lower = entity.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower === 'nbsp') return ' ';
    let code = Number.NaN;
    if (lower.startsWith('#x')) code = Number.parseInt(lower.slice(2), 16);
    else if (lower.startsWith('#')) code = Number.parseInt(lower.slice(1), 10);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
    try {
      return String.fromCodePoint(code);
    } catch {
      return whole;
    }
  });
}

/**
 * 解析单个标签的属性。
 * 为什么不引 HTML 解析器：这里只读 head 里的 meta/linkScript，正则足够，且项目要求零依赖。
 * @param {string} tag 形如 `<meta name="description" content="...">`
 * @returns {Record<string,string>} 属性名小写 → 解码后的值
 */
function parseAttributes(tag) {
  const attrs = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match;
  while ((match = pattern.exec(String(tag))) !== null) {
    const key = match[1].toLowerCase();
    if (Object.hasOwn(attrs, key)) continue;
    attrs[key] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? '');
  }
  return attrs;
}

/**
 * 规范化 URL。
 * - 不带协议时补 https://（用户通常只输入域名）；
 * - 只允许 http / https，防止 file:、data: 之类被误当成站点；
 * - 根路径去掉尾斜杠，让返回值稳定（`https://a.com` 而不是 `https://a.com/`），
 *   带路径的输入保持原样。
 * @param {string} input
 * @returns {string}
 */
export function normalizeUrl(input) {
  let raw = String(input ?? '').trim();
  if (!raw) throw new TypeError('auditSite(url)：url 不能为空');
  // 没有协议前缀（例如 "sanrenxing.cn"）→ 默认按 https 处理。
  // 只认 "scheme://" 或 "http(s):"，避免把 "localhost:3000" 误判成协议名。
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^https?:/i.test(raw);
  if (!hasScheme) raw = `https://${raw}`;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError(`auditSite(url)：不是合法的 URL —— ${input}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`auditSite(url)：只支持 http/https，收到 ${parsed.protocol}`);
  }

  parsed.hash = '';
  if (parsed.pathname === '/' && !parsed.search) return parsed.origin;
  return parsed.toString();
}

/** 显示用：根路径去掉尾斜杠，非根路径原样返回。 */
function stripRootSlash(href) {
  try {
    const parsed = new URL(String(href));
    if (parsed.pathname === '/' && !parsed.search && !parsed.hash) return parsed.origin;
    return parsed.toString();
  } catch {
    return String(href);
  }
}

/**
 * 单次 HTTP 请求。永远不抛异常：网络错误 / 超时都折成 `{ status: null, error }`，
 * 因为体检要的是「拿不到也算结论」，而不是让整次体检失败。
 * @param {string} url
 * @param {object} options
 * @param {Function} [options.fetchImpl]
 * @param {string} [options.userAgent]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxChars] 响应体截断上限
 * @returns {Promise<{status: number|null, body: string, error: string|null}>}
 */
async function request(url, { fetchImpl, userAgent, timeoutMs, maxChars = MAX_CHARS.page }) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { status: null, body: '', error: '当前 Node 环境没有可用的 fetch（需要 Node ≥ 22）' };
  }

  const ms = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    const response = await doFetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'user-agent': userAgent || DEFAULT_USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: controller.signal,
    });

    const status = Number(response && response.status);
    let body = '';
    try {
      body = typeof response.text === 'function' ? await response.text() : '';
    } catch {
      body = '';
    }
    const text = typeof body === 'string' ? body : String(body ?? '');
    return {
      status: Number.isFinite(status) ? status : null,
      body: text.length > maxChars ? text.slice(0, maxChars) : text,
      error: null,
    };
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
    return {
      status: null,
      body: '',
      error: aborted
        ? `超时（${ms}ms 未响应）`
        : `网络错误：${describeNetworkError(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把 fetch 抛出的错误拼成可读文案。
 * Node 的 fetch 顶层 message 经常只有 "fetch failed"，真正原因在 error.cause 里
 * （如 UND_ERR_CONNECT_TIMEOUT / ENOTFOUND / CERT_HAS_EXPIRED），不展开就等于没说。
 * @param {unknown} error
 * @returns {string}
 */
function describeNetworkError(error) {
  const base = error && error.message ? error.message : String(error);
  const cause = error && error.cause;
  if (!cause) return base;
  const causeText = [cause.code, cause.message].filter(Boolean).join(' ');
  return causeText ? `${base}（${causeText}）` : base;
}

/**
 * 并发受限的 map：AI 爬虫 9 个 UA 一次全怼同一站点容易被 CDN 限流，
 * 分 4 个一批既可接受又能把最坏耗时压到 3 轮以内。
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} task
 * @returns {Promise<R[]>} 顺序与输入一致
 */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ------------------------------------------------------------------ *
 * robots.txt
 * ------------------------------------------------------------------ */

/**
 * 解析 robots.txt 为「UA 组 → 规则」结构。
 * 只关心抓取授权（User-agent / Allow / Disallow）；Sitemap 等指令跳过。
 * @param {string} raw
 * @returns {{agents: string[], rules: {allow: boolean, path: string}[]}[]}
 */
function parseRobots(raw) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;

  for (const rawLine of String(raw).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) {
      // 空行结束一个组：后面的 User-agent 一定开新组
      lastWasAgent = false;
      current = null;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) continue;

    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }

    lastWasAgent = false;
    if (!current) continue; // 没有归属组的规则行：忽略（Sitemap/Crawl-delay 等）
    // 空值 Disallow 表示"不限制"，不算规则
    if (key === 'disallow' && value !== '') current.rules.push({ allow: false, path: value });
    else if (key === 'allow' && value !== '') current.rules.push({ allow: true, path: value });
  }

  return groups;
}

function isRootPath(path) {
  const value = String(path ?? '').trim();
  return value === '/' || value === '/*';
}

/**
 * 该组是否封禁整站。
 * robots 语义：同长度下 Allow 优先，所以「Allow: / + Disallow: /」不算封禁。
 * @param {{rules: {allow: boolean, path: string}[]}} group
 */
function groupBlocksRoot(group) {
  const disallowRoot = group.rules.some((rule) => !rule.allow && isRootPath(rule.path));
  const allowRoot = group.rules.some((rule) => rule.allow && isRootPath(rule.path));
  return disallowRoot && !allowRoot;
}

/**
 * 某个爬虫在 robots 里是否被整站封禁；返回命中的规则文本，未封禁返回 null。
 * robots 语义：存在精确 UA 组时只用精确组，忽略 `*`（Google/OpenAI 都是这个口径）。
 * @param {ReturnType<typeof parseRobots>} groups
 * @param {string} crawlerId
 * @returns {string|null}
 */
function decideRobotsForCrawler(groups, crawlerId) {
  const token = String(crawlerId).toLowerCase();
  const exactGroups = groups.filter((group) => group.agents.includes(token));
  if (exactGroups.length > 0) {
    return exactGroups.some(groupBlocksRoot) ? `User-agent: ${crawlerId} / Disallow: /` : null;
  }
  const wildcardGroups = groups.filter((group) => group.agents.includes('*'));
  return wildcardGroups.some(groupBlocksRoot) ? 'User-agent: * / Disallow: /' : null;
}

/**
 * 汇总 robots 结论。
 * 403/401/418 也在这里标记出来：WAF 挡住 robots.txt 时 AI 爬虫拿不到授权文件，
 * 很多引擎会因此放弃抓取，必须按 blocker 处理（这是本模块最容易被忽略的一项）。
 * @param {{status: number|null, body: string, error: string|null}} probe
 * @returns {{status: number|null, found: boolean, raw: string, disallowsAllAI: boolean, blocked: {crawler: string, rule: string}[]}}
 */
function summariseRobots(probe) {
  const raw = probe.body || '';
  const found = isSuccess(probe.status) && raw.trim().length > 0;
  const groups = found ? parseRobots(raw) : [];
  const blocked = [];
  let disallowsAllAI = false;

  if (found) {
    const wildcardGroups = groups.filter((group) => group.agents.includes('*'));
    disallowsAllAI = wildcardGroups.some(groupBlocksRoot);
    for (const crawler of AI_CRAWLERS) {
      const rule = decideRobotsForCrawler(groups, crawler.id);
      if (rule) blocked.push({ crawler: crawler.id, rule });
    }
  }

  return { status: probe.status, found, raw, disallowsAllAI, blocked };
}

/** robots.txt 是否被 WAF / 权限拦截（拿不到授权文件）。 */
function robotsUnreadable(status) {
  return Number.isFinite(status) && ROBOTS_BLOCKED_STATUSES.includes(status);
}

/* ------------------------------------------------------------------ *
 * llms.txt / sitemap.xml
 * ------------------------------------------------------------------ */

/** 统计 llms.txt 里的链接数：Markdown 链接与裸 URL 都算，去重避免重复计数。 */
function countLlmsLinks(raw) {
  const urls = new Set();
  for (const match of String(raw).matchAll(/https?:\/\/[^\s)\]}>"']+/g)) {
    urls.add(match[0].replace(/[.,;:。，；]+$/, ''));
  }
  return urls.size;
}

function summariseLlms(probe) {
  const raw = probe.body || '';
  const found = isSuccess(probe.status) && raw.trim().length > 0;
  return {
    status: probe.status,
    found,
    bytes: found ? Buffer.byteLength(raw, 'utf8') : 0,
    urls: found ? countLlmsLinks(raw) : 0,
  };
}

function summariseSitemap(probe) {
  const raw = probe.body || '';
  // 有些站点 sitemap 404 时返回 200 的 HTML 错误页：必须校验根标签，否则会误判"存在"
  const looksLikeSitemap = /<(urlset|sitemapindex)\b/i.test(raw);
  const found = isSuccess(probe.status) && looksLikeSitemap;
  return {
    status: probe.status,
    found,
    urls: found ? (raw.match(/<loc\b/gi) || []).length : 0,
  };
}

/* ------------------------------------------------------------------ *
 * HTML：结构化数据 / meta / 渲染依赖度
 * ------------------------------------------------------------------ */

/** 递归收集 JSON-LD 里的 @type（含 @graph 与嵌套 mainEntity）。 */
function collectJsonLdTypes(value, types, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdTypes(item, types, depth + 1);
    return;
  }
  const rawType = value['@type'];
  if (typeof rawType === 'string') types.add(rawType);
  else if (Array.isArray(rawType)) {
    for (const item of rawType) if (typeof item === 'string') types.add(item);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === '@type') continue;
    if (child && typeof child === 'object') collectJsonLdTypes(child, types, depth + 1);
  }
}

/**
 * 统计 JSON-LD 块数与 @type。
 * 解析失败只跳过该块（AI 引擎同样会跳过），但仍计入 jsonLdCount —— 块存在但语法坏，
 * 是"有投入没效果"的典型，值得让人看到条数。
 */
function parseJsonLd(source) {
  const blocks = [...source.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)];
  const types = new Set();
  for (const block of blocks) {
    const raw = block[1].trim().replace(/^<!--/, '').replace(/-->$/, '').trim();
    if (!raw) continue;
    try {
      collectJsonLdTypes(JSON.parse(raw), types);
    } catch {
      // 语法错误：忽略该块的类型提取
    }
  }
  return { jsonLdCount: blocks.length, types: [...types] };
}

/**
 * 去掉标签得到"可见文字"。
 * - script / style / 注释不算文字；noscript 保留 —— AI 爬虫不执行 JS，但读得到 noscript 里的内容；
 * - 用 Array.from 计算字符数（CJK 按码点算，一个汉字算 1 个字符）。
 */
function stripToText(source) {
  return decodeEntities(
    String(source)
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' '),
  )
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析 head 区信息与渲染依赖度。
 * @param {string} html
 * @returns {{meta: {title: string, description: string, canonical: string, noindex: boolean, lang: string},
 *            schema: {jsonLdCount: number, types: string[]},
 *            render: {htmlBytes: number, textChars: number, scriptTags: number, likelyJsOnly: boolean}}}
 */
function analyseHtml(html) {
  const source = String(html ?? '');
  const metaTags = [...source.matchAll(/<meta\b[^>]*>/gi)].map((match) => parseAttributes(match[0]));
  const linkTags = [...source.matchAll(/<link\b[^>]*>/gi)].map((match) => parseAttributes(match[0]));

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(source);
  const title = cleanText(decodeEntities(titleMatch ? titleMatch[1] : ''));

  const readMeta = (keys) => {
    const wanted = keys.map((key) => key.toLowerCase());
    for (const attrs of metaTags) {
      const name = String(attrs.name ?? attrs.property ?? attrs.itemprop ?? '').toLowerCase();
      if (wanted.includes(name) && attrs.content) return cleanText(attrs.content);
    }
    return '';
  };

  // AI 引擎也会读 og:description；缺失时兜底，但仍优先 name=description
  const description = readMeta(['description']) || readMeta(['og:description']);

  // noindex 是"明确拒绝索引"：ChatGPT/Perplexity 的搜索索引同样遵守
  const robotsDirectives = metaTags
    .filter((attrs) => /^(robots|googlebot|bingbot|yandex)$/i.test(String(attrs.name ?? '')))
    .map((attrs) => String(attrs.content ?? '').toLowerCase());
  const noindex = robotsDirectives.some((value) => /\bnoindex\b/.test(value) || /\bnone\b/.test(value));

  let canonical = '';
  for (const attrs of linkTags) {
    const rel = String(attrs.rel ?? '').toLowerCase().split(/\s+/);
    if (rel.includes('canonical') && attrs.href) {
      canonical = cleanText(attrs.href);
      break;
    }
  }

  const htmlTagMatch = /<html\b[^>]*>/i.exec(source);
  const lang = htmlTagMatch ? String(parseAttributes(htmlTagMatch[0]).lang ?? '').trim() : '';

  const textChars = Array.from(stripToText(source)).length;
  const scriptTags = (source.match(/<script\b/gi) || []).length;

  return {
    meta: { title, description, canonical, noindex, lang },
    schema: parseJsonLd(source),
    render: {
      htmlBytes: Buffer.byteLength(source, 'utf8'),
      textChars,
      scriptTags,
      // 判定口径来自任务书：可见文字 < 200 字符且脚本 > 5 个 → 极可能是纯前端渲染。
      // AI 爬虫不执行 JS，这类页面在索引里等于空白。
      likelyJsOnly: textChars < 200 && scriptTags > 5,
    },
  };
}

/* ------------------------------------------------------------------ *
 * AI 爬虫 UA 实测
 * ------------------------------------------------------------------ */

/**
 * AI 爬虫拿到的响应是否等于"被挡"。
 * 状态码只是第一层；很多 WAF 会返回 200 的 JS 挑战页，所以还要看特征串。
 * @param {number|null} status
 * @param {string} body
 */
function crawlerLooksBlocked(status, body) {
  if (status === null) return true; // 连不上 = 抓不到
  if (UA_BLOCKED_STATUSES.includes(status)) return true;
  if (!isSuccess(status)) return true; // 5xx / 其它非 2xx 同样抓不到正文
  const text = String(body || '');
  if (!text) return true; // 200 但空响应体：抓到了个寂寞
  if (text.length <= 20000) {
    const lower = text.toLowerCase();
    if (CHALLENGE_SIGNATURES.some((signature) => lower.includes(signature))) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 评分
 * ------------------------------------------------------------------ */

/**
 * 扣分制评分（写清口径，方便报告里向客户解释）：
 *  1. 主页面拿不到 2xx：直接落进 0-20 区间 —— 连内容都没有，其它项无意义：
 *     - 两个协议都没响应（DNS/证书/超时）→ 0；
 *     - 至少有一个协议有 HTTP 响应（例如全站 403）→ 15。
 *  2. 只能走 http（HTTPS 不通）：不进 0 分，但封顶 20 分 —— AI 引擎会因非 HTTPS 降权/不抓。
 *  3. 正常可达：100 分起按 DEDUCTIONS 扣；授权/准入红线合并扣一次。
 * @param {object} state
 * @returns {number} 0-100 整数
 */
function computeScore(state) {
  if (!state.reachable) return state.responded ? 15 : 0;

  let score = 100;
  if (state.aiBlocked) score -= DEDUCTIONS.aiBlocked;
  if (state.uaBlocked) score -= DEDUCTIONS.uaBlocked;
  if (state.jsOnly) score -= DEDUCTIONS.jsOnly;
  if (!state.llmsFound) score -= DEDUCTIONS.noLlmsTxt;
  if (!state.sitemapFound) score -= DEDUCTIONS.noSitemap;
  if (state.jsonLdCount === 0) score -= DEDUCTIONS.noJsonLd;
  if (!state.hasDescription) score -= DEDUCTIONS.noDescription;
  if (!state.hasCanonical) score -= DEDUCTIONS.noCanonical;

  // HTTPS 不通：无论其它项多好都封顶 20 分（与"不可达"同一档）
  if (!state.httpsOk) score = Math.min(score, 20);

  return Math.max(0, Math.min(100, Math.round(score)));
}

function levelOf(score) {
  for (const threshold of LEVEL_THRESHOLDS) {
    if (score >= threshold.min) return threshold.level;
  }
  return '严重';
}

/* ------------------------------------------------------------------ *
 * findings
 * ------------------------------------------------------------------ */

const LEVEL_ORDER = Object.freeze({ blocker: 0, warn: 1, info: 2 });

function describeStatus(probe) {
  if (!probe) return '未执行';
  if (probe.status === null) return probe.error || '请求失败';
  return `HTTP ${probe.status}`;
}

/**
 * 生成可执行的问题清单。每条 fix 都要求"具体到能照着改"：
 * 给出配置片段、验证命令、控制台路径，而不是"优化网站"这种空话。
 * @param {object} ctx
 * @returns {{id: string, level: 'blocker'|'warn'|'info', title: string, detail: string, fix: string}[]}
 */
function buildFindings(ctx) {
  const { reachable, httpsResult, httpsProbe, httpProbe, robots, llmsTxt, sitemap, schema, meta, render, crawlerRows } = ctx;
  const findings = [];

  if (!reachable) {
    findings.push({
      id: 'unreachable',
      level: 'blocker',
      title: '主页面抓不到：AI 爬虫同样拿不到内容',
      detail: `HTTPS 探测：${describeStatus(httpsProbe)}；HTTP 回落：${describeStatus(httpProbe)}。站点对外不可达时，所有 GEO 优化都没有意义。`,
      fix:
        '先确认站点对「非浏览器 UA」也能打开：curl -I -A "GPTBot/1.2" https://域名/ 。常见原因与处理：' +
        '① DNS/证书问题 → openssl s_client -connect 域名:443 检查证书链，Let\'s Encrypt 用 certbot renew；' +
        '② CDN 开了 Under Attack Mode 或全站 JS 挑战 → 在 Cloudflare 关掉，或对首页与 AI 爬虫 UA 加 Skip 规则；' +
        '③ 源站只放行备案 IP/办公网 → 安全组放行 0.0.0.0/0 的 443；' +
        '④ 返回 5xx → 先看 nginx error.log 和应用日志把首页修好。',
    });
    return sortFindings(findings);
  }

  // —— HTTPS 层 ——
  if (!httpsResult.ok) {
    findings.push({
      id: 'https-unavailable',
      level: 'blocker',
      title: 'HTTPS 打不开，只能走 http',
      detail: `https:// 探测结果：${describeStatus(httpsProbe)}。已回落到 http:// 并成功取到内容；AI 引擎的抓取与引用链路默认走 HTTPS，非 HTTPS 会被降权甚至直接跳过。`,
      fix:
        '给域名上 HTTPS：nginx 执行 certbot --nginx -d 域名 -d www.域名 申请 Let\'s Encrypt 证书，' +
        '并把 80 端口 301 到 443；CDN 用户确认 SSL 模式是 Full (strict) 而不是 Flexible；' +
        '证书链不完整会让爬虫直接放弃（curl -v 看有没有 "unable to verify"）。',
    });
  }

  // —— 授权层：robots ——
  if (robots.disallowsAllAI || robots.blocked.length > 0) {
    const blockedText = robots.blocked.map((item) => `${item.crawler}（${item.rule}）`).join('、');
    findings.push({
      id: 'robots-blocks-ai',
      level: 'blocker',
      title: 'robots.txt 屏蔽了 AI 爬虫',
      detail: `robots.txt 命中：${blockedText}。${
        robots.disallowsAllAI ? '其中 User-agent: * 的 Disallow: / 等于对全部 AI 爬虫封站。' : ''
      }AI 引擎公开声明遵守 robots.txt，被禁的爬虫不会抓取，自然也不会引用这个站。`,
      fix:
        '编辑 /robots.txt，删掉针对 AI 爬虫的 Disallow: /，按爬虫逐个放行：\n' +
        'User-agent: GPTBot\nAllow: /\n\nUser-agent: OAI-SearchBot\nAllow: /\n\n' +
        'User-agent: ClaudeBot\nAllow: /\n\nUser-agent: PerplexityBot\nAllow: /\n\n' +
        'User-agent: Bytespider\nAllow: /\n' +
        'Cloudflare 用户：Security → Bots → 把 GPTBot / ClaudeBot / PerplexityBot / Bytespider 设为 Allow，不要开「Block AI bots」；' +
        'nginx 用户检查有没有 if ($http_user_agent ~* "(GPTBot|ClaudeBot|Bytespider)") { return 403; } 这类规则，有就删掉。',
    });
  }

  if (robotsUnreadable(robots.status)) {
    findings.push({
      id: 'robots-waf',
      level: 'blocker',
      title: `robots.txt 被 WAF 拦截（HTTP ${robots.status}）`,
      detail: `GET /robots.txt 返回 ${robots.status}，AI 爬虫拿不到授权文件就无法确认「站点允许抓取」，多数引擎会因此放弃整站。常见于把 /robots.txt 当可疑路径拦截的 CDN 规则。`,
      fix:
        '让 /robots.txt 对所有人返回 200 纯文本：Cloudflare → Security → WAF → 自定义规则，为 path equals /robots.txt 加 Skip（或 Bypass）动作，同时确认 Bot Fight Mode 不拦它；' +
        'nginx → location = /robots.txt { allow all; default_type text/plain; }；' +
        '并确认 robots.txt 不是 302 跳到验证页。验收：curl -s -o /dev/null -w "%{http_code}" https://域名/robots.txt 必须是 200。',
    });
  }

  if (!robots.found && !robotsUnreadable(robots.status)) {
    findings.push({
      id: 'robots-missing',
      level: 'info',
      title: '没有读到 robots.txt',
      detail: `GET /robots.txt → ${robots.status === null ? '请求失败' : `HTTP ${robots.status}`}。AI 爬虫通常把「取不到」按允许处理，风险不大，但也失去了主动声明的机会。`,
      fix:
        '补一份最小可用的 robots.txt，明确放行 AI 爬虫并声明 sitemap：\n' +
        'User-agent: *\nAllow: /\n\nSitemap: https://域名/sitemap.xml',
    });
  }

  // —— 授权层：noindex ——
  if (meta.noindex) {
    findings.push({
      id: 'noindex',
      level: 'blocker',
      title: '页面声明了 noindex',
      detail: 'head 里的 <meta name="robots" content="noindex"> 明确要求不要索引。ChatGPT / Perplexity 的搜索索引同样遵守它，页面即使被抓到也不会进入回答候选。',
      fix:
        '删除或改写这条 meta：<meta name="robots" content="index,follow">。' +
        '如果只是想屏蔽后台/搜索结果页，把 noindex 只加到那些路径（如 /admin、/search），首页与内容页必须 index,follow；' +
        '顺带检查 HTTP 头里有没有 X-Robots-Tag: noindex（curl -I 查看）。',
    });
  }

  // —— 准入层：AI 爬虫 UA 实测 ——
  const blockedRows = crawlerRows.filter((row) => row.blocked);
  if (blockedRows.length > 0) {
    findings.push({
      id: 'ai-ua-blocked',
      level: 'blocker',
      title: 'AI 爬虫的 UA 被拦截 / 返回验证页',
      detail: `用 AI 爬虫 UA 实测主页：${blockedRows
        .map((row) => `${row.id} → ${row.status === null ? '请求失败' : row.status}`)
        .join('、')}；而普通 UA 能拿到 200。说明 CDN / WAF / 源站按 UA 做了拦截 —— 这是最常见的「隐形封禁」：站长在浏览器里看一切正常，AI 那边一片空白。`,
      fix:
        '按 UA 拦爬虫时必须放行 AI 引擎。nginx 不要用 if ($http_user_agent ~* "bot") 一刀切，改成白名单：\n' +
        'map $http_user_agent $is_ai_bot {\n  default 0;\n  "~*(GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|PerplexityBot|Google-Extended|Bytespider|Baiduspider)" 1;\n}' +
        '\n同时在 WAF 的「恶意爬虫」规则组里把这些 UA 加白；Cloudflare：Security → Bots 把对应 Bot 设为 Allow，并关闭 Bot Fight Mode 对该路径的拦截。' +
        '验收：curl -s -o /dev/null -w "%{http_code}" -A "Mozilla/5.0 ... GPTBot/1.2" https://域名/ 要返回 200。',
    });
  }

  // —— 渲染层 ——
  if (render.likelyJsOnly) {
    findings.push({
      id: 'js-only',
      level: 'blocker',
      title: '正文靠 JS 渲染，AI 爬虫看到的是空页面',
      detail: `HTML 共 ${render.htmlBytes} 字节、${render.scriptTags} 个 <script>，去掉脚本后可见文字只有 ${render.textChars} 个字符。AI 爬虫不执行 JavaScript，抓到的就是这层空壳。`,
      fix:
        '把首屏正文改成服务端直出：Next.js 用 Server Component / ISR，别用 useEffect 拉首屏数据；Vue 用 Nuxt SSR 或 nuxt generate；' +
        '纯 SPA 至少做预渲染（vite-plugin-ssg / prerender-spa-plugin），并给关键页加 <noscript> 摘要 + 内联正文 HTML。' +
        '验收：curl -A "GPTBot/1.2" https://域名/ | grep 正文关键词 能命中，且去掉 <script> 后可见文字 > 200 字。',
    });
  }

  // —— 供给层 ——
  if (!llmsTxt.found) {
    findings.push({
      id: 'no-llms-txt',
      level: 'warn',
      title: '没有 llms.txt',
      detail: `GET /llms.txt → ${llmsTxt.status === null ? '请求失败' : `HTTP ${llmsTxt.status}`}。llms.txt 是给 AI 引擎的内容说明书，缺失不影响被抓，但会降低「被正确理解、优先引用」的概率。`,
      fix:
        '在站点根目录放 /llms.txt（Markdown 格式，一级标题写品牌，每条一个链接 + 一句话说明）：\n' +
        '# 恒野 GEO\n- [AI 可见性诊断](https://域名/service)：面向本地企业的 GEO 体检（写清你服务的城市与行业）\n- [案例](https://域名/case)：本地服务商的 AI 引用对比\n' +
        '用 nginx 静态托管即可，Content-Type 设为 text/plain; charset=utf-8。',
    });
  }

  if (!sitemap.found) {
    findings.push({
      id: 'no-sitemap',
      level: 'warn',
      title: '没有可用的 sitemap.xml',
      detail: `GET /sitemap.xml → ${sitemap.status === null ? '请求失败' : `HTTP ${sitemap.status}`}，没有解析到 <loc>。sitemap 帮引擎完整发现页面，深层内容尤其依赖它。`,
      fix:
        '生成 /sitemap.xml，确保只收录 200 状态、允许索引的 URL：Next.js 写 app/sitemap.ts，WordPress 用 Rank Math / Yoast 自动生成，静态站用 sitemap 生成器；' +
        '然后在 robots.txt 末尾加 Sitemap: https://域名/sitemap.xml。验收：curl https://域名/sitemap.xml | grep -c "<loc>" 输出大于 0。',
    });
  }

  // —— 语义层 ——
  if (schema.jsonLdCount === 0) {
    findings.push({
      id: 'no-jsonld',
      level: 'warn',
      title: '没有 JSON-LD 结构化数据',
      detail: '页面里没有 <script type="application/ld+json">。没有结构化数据，AI 只能从正文猜「你是谁、做什么、在哪个城市」，实体识别与引用概率都会下降。',
      fix:
        '给首页加 Organization（有实体门店再加 LocalBusiness），给服务页加 Service / FAQPage：\n' +
        '<script type="application/ld+json">\n{"@context":"https://schema.org","@type":"Organization","name":"品牌名","url":"https://域名","logo":"https://域名/logo.png","sameAs":["https://…"]}\n</script>\n' +
        '上线前用 https://validator.schema.org 校验通过。',
    });
  }

  if (!meta.description) {
    findings.push({
      id: 'no-description',
      level: 'warn',
      title: '缺少 meta description',
      detail: 'head 里没有 name="description"（也没有 og:description）。AI 摘要常直接取这句作为「一句话介绍」，缺失时只能拿页面首段凑，往往不是介绍性文字。',
      fix:
        '在 <head> 加 <meta name="description" content="一句话说清做什么、给谁做、在哪个城市，60-150 字">，' +
        '并补 <meta property="og:description" content="同一句">。写具体服务 + 地区，不要堆关键词。',
    });
  }

  if (!meta.canonical) {
    findings.push({
      id: 'no-canonical',
      level: 'info',
      title: '缺少 rel=canonical',
      detail: '页面没有 <link rel="canonical">。http/https、带 www、尾斜杠等变体会被当成多个页面，稀释信号，也让 AI 不确定该引用哪个版本。',
      fix:
        '在 <head> 加自引用 canonical：<link rel="canonical" href="https://域名/当前路径">，' +
        '并把带 www / 不带 www、http / https、带 / 不带尾斜杠统一 301 到同一个地址（nginx 用 return 301 或 Cloudflare 的 Redirect Rules）。',
    });
  }

  return sortFindings(findings);
}

function sortFindings(findings) {
  return findings.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/**
 * 体检一个站点对 AI 爬虫的可抓取性。
 *
 * 流程：https 主页 → （失败则 http 主页）→ 并行取 robots/llms/sitemap →
 * 9 个 AI 爬虫 UA 实测主页 → 解析 HTML → 扣分 → 生成 findings。
 * 本函数不抛网络异常：所有失败都折成返回对象里的 status/error/findings。
 *
 * @param {string} url 站点地址，允许不带协议（默认补 https://）
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] 测试注入的 fetch 实现（缺省用全局 fetch）
 * @param {number} [options.timeoutMs=12000] 单个请求超时（毫秒）
 * @param {string} [options.userAgent] 请求 robots/llms/sitemap 时使用的 UA
 * @returns {Promise<{
 *   url: string, reachable: boolean,
 *   https: {ok: boolean, status: number|null, error: string|null},
 *   robots: {status: number|null, found: boolean, raw: string, disallowsAllAI: boolean, blocked: {crawler: string, rule: string}[]},
 *   aiCrawlers: {id: string, name: string, ua: string, status: number|null, blocked: boolean}[],
 *   llmsTxt: {status: number|null, found: boolean, bytes: number, urls: number},
 *   sitemap: {status: number|null, found: boolean, urls: number},
 *   schema: {jsonLdCount: number, types: string[]},
 *   meta: {title: string, description: string, canonical: string, noindex: boolean, lang: string},
 *   render: {htmlBytes: number, textChars: number, scriptTags: number, likelyJsOnly: boolean},
 *   score: number, level: '好'|'一般'|'差'|'严重',
 *   findings: {id: string, level: 'blocker'|'warn'|'info', title: string, detail: string, fix: string}[]
 * }>}
 */
export async function auditSite(url, options = {}) {
  const {
    fetchImpl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    userAgent = DEFAULT_USER_AGENT,
  } = options || {};

  // 规范化：补协议、限协议、去根路径尾斜杠
  const normalized = normalizeUrl(url);
  const inputTarget = new URL(normalized);

  const httpsUrl = new URL(inputTarget.toString());
  httpsUrl.protocol = 'https:';
  const httpUrl = new URL(inputTarget.toString());
  httpUrl.protocol = 'http:';

  const common = { fetchImpl, timeoutMs, userAgent };

  // —— 1) 主页可达性：先 https，失败再回落 http（无论输入写没写协议） ——
  const httpsProbe = await request(httpsUrl.toString(), { ...common, maxChars: MAX_CHARS.page });
  const httpsResult = {
    ok: isSuccess(httpsProbe.status),
    status: httpsProbe.status,
    error: httpsProbe.error,
  };

  let httpProbe = null;
  let pageProbe = httpsProbe;
  let pageUrl = httpsUrl.toString();

  if (!httpsResult.ok) {
    httpProbe = await request(httpUrl.toString(), { ...common, maxChars: MAX_CHARS.page });
    if (isSuccess(httpProbe.status)) {
      pageProbe = httpProbe;
      pageUrl = httpUrl.toString();
    }
  }

  const reachable = isSuccess(pageProbe.status);
  const html = reachable ? pageProbe.body : '';

  // —— 2) 三个供给类资源并行取（主页不可达时跳过，省掉无意义的请求） ——
  let robotsProbe = EMPTY_PROBE;
  let llmsProbe = EMPTY_PROBE;
  let sitemapProbe = EMPTY_PROBE;

  if (reachable) {
    const resourceBase = new URL(pageUrl);
    const resolve = (path) => new URL(path, resourceBase).toString();
    [robotsProbe, llmsProbe, sitemapProbe] = await Promise.all([
      request(resolve('/robots.txt'), { ...common, maxChars: MAX_CHARS.robots }),
      request(resolve('/llms.txt'), { ...common, maxChars: MAX_CHARS.llms }),
      request(resolve('/sitemap.xml'), { ...common, maxChars: MAX_CHARS.sitemap }),
    ]);
  }

  // —— 3) 用每个 AI 爬虫的 UA 实测主页（每批 4 个，避免 CDN 限流） ——
  const crawlerRows = reachable
    ? await mapLimit(AI_CRAWLERS, 4, async (crawler) => {
        const probe = await request(pageUrl, {
          ...common,
          userAgent: crawler.ua,
          maxChars: MAX_CHARS.page,
        });
        return {
          id: crawler.id,
          name: crawler.name,
          ua: crawler.ua,
          status: probe.status,
          blocked: crawlerLooksBlocked(probe.status, probe.body),
        };
      })
    : AI_CRAWLERS.map((crawler) => ({
        id: crawler.id,
        name: crawler.name,
        ua: crawler.ua,
        status: null,
        // 主页整体不可达时有 unreachable blocker 兜底，这里不重复计"被挡"
        blocked: false,
      }));

  // —— 4) 解析 ——
  const robots = summariseRobots(robotsProbe);
  const llmsTxt = summariseLlms(llmsProbe);
  const sitemap = summariseSitemap(sitemapProbe);
  const { meta, schema, render } = analyseHtml(html);

  // —— 5) 评分：把「同一类红线只扣一次」的合并逻辑集中在这里 ——
  const robotsBlocksAI = robots.disallowsAllAI || robots.blocked.length > 0;
  const robotsIsUnreadable = robotsUnreadable(robots.status);
  const aiBlocked = robotsBlocksAI || robotsIsUnreadable || meta.noindex;
  const uaBlocked = crawlerRows.some((row) => row.blocked);
  const responded =
    httpsProbe.status !== null || (httpProbe !== null && httpProbe.status !== null);

  const score = computeScore({
    reachable,
    responded,
    httpsOk: httpsResult.ok,
    aiBlocked,
    uaBlocked,
    jsOnly: render.likelyJsOnly,
    llmsFound: llmsTxt.found,
    sitemapFound: sitemap.found,
    jsonLdCount: schema.jsonLdCount,
    hasDescription: Boolean(meta.description),
    hasCanonical: Boolean(meta.canonical),
  });

  const findings = buildFindings({
    reachable,
    httpsResult,
    httpsProbe,
    httpProbe,
    robots,
    llmsTxt,
    sitemap,
    schema,
    meta,
    render,
    crawlerRows,
  });

  return {
    url: stripRootSlash(pageUrl),
    reachable,
    https: httpsResult,
    robots,
    aiCrawlers: crawlerRows,
    llmsTxt,
    sitemap,
    schema,
    meta,
    render,
    score,
    level: levelOf(score),
    findings,
  };
}
