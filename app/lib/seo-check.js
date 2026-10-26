/**
 * lib/seo-check.js
 * 传统 SEO + 短视频 SEO 体检，补足 audit-site.js 只查「AI 可抓取性」的空白。
 *
 * 定位：
 *  - audit-site.js 回答「AI 引擎能不能抓到、敢不敢引用」；
 *  - 本模块回答「搜索引擎和短视频平台能不能看懂、愿不愿意给流量」；
 *  - 两者可以独立跑，也可以把结果并排写进同一份诊断报告。
 *
 * 设计约束：
 *  - 零 npm 依赖，HTTP 只走 Node ≥ 22 自带的全局 fetch；
 *  - analyzeSeo 是纯函数：输入 html/robots/sitemapUrls，输出完全确定，方便测试与复算；
 *  - fetchAndAnalyzeSeo 允许注入 fetchImpl，测试不发真实网络请求；
 *  - 所有失败都折成结构化结果，不向上抛异常，避免一次网络抖动打断整份报告。
 *
 * 检查口径（12 项）：
 *  1. title：存在、10-30 字、含关键词；
 *  2. meta description：存在、50-160 字；
 *  3. H1 恰好 1 个、H2 至少 2 个；
 *  4. canonical 存在；
 *  5. viewport 存在（移动端）；
 *  6. OG 标签至少 2 个；
 *  7. JSON-LD 至少 1 段；
 *  8. 图片 alt 覆盖率（缺失占比 > 30% 提醒）；
 *  9. 内链至少 3 条、外链至少 1 条；
 * 10. 正文至少 300 字（中文按字符、英文按词）；
 * 11. robots.txt 是否 Disallow: /（全站封禁为阻断）；
 * 12. sitemap 是否有可访问的 URL 条目。
 *
 * 评分：100 分起扣，blocker 25 / warn 8 / info 3，最低 0 分。
 * level：>= 80 好 / >= 50 一般 / < 50 差。
 */

/** 失败级别 → 扣分权重（与任务书的权重表一致）。 */
const LEVEL_WEIGHTS = Object.freeze({
  blocker: 25,
  warn: 8,
  info: 3,
});

/** 短视频 SEO 的硬约束：标题 18 字、标签 5-8 个、封面 12 字。 */
const VIDEO_LIMITS = Object.freeze({
  titleMax: 18,
  hashtagMin: 5,
  hashtagMax: 8,
  coverMax: 12,
});

/** 抓取时主动表明身份，方便站长在日志里识别。 */
const DEFAULT_USER_AGENT = 'hengye-geo-seo-check/0.1 (+https://hengye.geo/seo)';

/** 单个请求默认超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 15000;

/** sitemap 最多保留的 URL 数，避免超大站点把报告撑爆。 */
const MAX_SITEMAP_URLS = 5000;

/**
 * 检查项元数据：id / 展示名 / 默认严重级别 / 扣分权重。
 * 返回结果里的 checks 按这个数组的顺序生成，渲染表格时不会跳行。
 */
export const SEO_CHECKS = Object.freeze([
  Object.freeze({ id: 'title', label: 'title 标题', level: 'blocker', weight: 25 }),
  Object.freeze({ id: 'description', label: 'meta description', level: 'warn', weight: 8 }),
  Object.freeze({ id: 'heading', label: 'H1 / H2 层级', level: 'warn', weight: 8 }),
  Object.freeze({ id: 'canonical', label: 'canonical', level: 'warn', weight: 8 }),
  Object.freeze({ id: 'viewport', label: 'viewport', level: 'warn', weight: 8 }),
  Object.freeze({ id: 'open-graph', label: 'Open Graph', level: 'warn', weight: 8 }),
  Object.freeze({ id: 'json-ld', label: 'JSON-LD 结构化数据', level: 'warn', weight: 8 }),
  Object.freeze({ id: 'image-alt', label: '图片 alt', level: 'warn', weight: 8 }),
  Object.freeze({ id: 'links', label: '内链 / 外链', level: 'warn', weight: 8 }),
  Object.freeze({ id: 'content-length', label: '正文字数', level: 'warn', weight: 8 }),
  Object.freeze({ id: 'robots', label: 'robots.txt', level: 'blocker', weight: 25 }),
  Object.freeze({ id: 'sitemap', label: 'sitemap', level: 'warn', weight: 8 }),
]);

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

/** 任意输入安全转字符串（null / undefined → ''）。 */
function asText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

/** 压缩空白，用于标题、meta 等单行文本。 */
function collapse(value) {
  return asText(value).replace(/\s+/g, ' ').trim();
}

/** 按「字」计数：去掉空白后按码点算，一个汉字算 1 字（英文按字符）。 */
function countChars(value) {
  return Array.from(asText(value).replace(/\s+/g, '')).length;
}

/** 关键词匹配前归一化：忽略大小写与空格，避免「GEO 诊断」匹配不到「GEO诊断」。 */
function normalizeMatch(value) {
  return asText(value).toLowerCase().replace(/\s+/g, '');
}

/** 按码点截断，避免把 emoji 或生僻字截成半个字符。 */
function clipText(value, max) {
  const chars = Array.from(asText(value));
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, max).join('');
}

/** 常见 HTML 实体表（够覆盖标题、meta、alt 里的常规写法）。 */
const ENTITY_MAP = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
});

/** 安全地把码点转字符；非法码点返回空串而不是抛异常。 */
function fromCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** 解码 HTML 实体：命名实体 + 十进制 + 十六进制。 */
function decodeEntities(value) {
  return asText(value).replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]+));/gi, (raw, dec, hex, name) => {
    if (dec) return fromCodePoint(Number(dec));
    if (hex) return fromCodePoint(Number.parseInt(hex, 16));
    const mapped = ENTITY_MAP[String(name).toLowerCase()];
    return mapped == null ? raw : mapped;
  });
}

/**
 * 解析标签属性（只覆盖 name="value" / name='value' / name=value 三种写法）。
 * 自己写而不上解析器，是因为本模块承诺零依赖，且体检只需要读取几个固定属性。
 * @param {string} tag 完整标签文本，例如 <meta name="description" content="...">
 * @returns {Record<string, string>} 属性名统一小写，值已解码实体
 */
function parseAttributes(tag) {
  const attrs = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match = pattern.exec(asText(tag));
  while (match !== null) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
    match = pattern.exec(asText(tag));
  }
  return attrs;
}

/** 去掉注释、脚本、样式、SVG 等不参与「正文/结构」判断的内容。 */
function stripNonContent(html) {
  return asText(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
}

/** 把 HTML 压成纯文本：块级标签补空格，避免中英文粘连。 */
function stripToText(html) {
  const spaced = stripNonContent(html)
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(spaced).replace(/\s+/g, ' ').trim();
}

/** 读取响应头：兼容 Headers、Map、普通对象，名称大小写不敏感。 */
function readHeader(headers, name) {
  if (!headers) return '';
  const wanted = asText(name).toLowerCase();
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    return value == null ? '' : asText(value);
  }
  if (typeof headers === 'object') {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === wanted) return asText(headers[key]);
    }
  }
  return '';
}

/** 把响应头折成普通对象，传给 analyzeSeo 时保持纯数据。 */
function toPlainHeaders(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      out[asText(key).toLowerCase()] = asText(value);
    });
    return out;
  }
  if (typeof headers === 'object') {
    for (const key of Object.keys(headers)) out[key.toLowerCase()] = asText(headers[key]);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * HTML 解析
 * ------------------------------------------------------------------ */

/** 从 meta 列表里读指定 name/property 的 content。 */
function readMeta(metaTags, key) {
  const wanted = asText(key).toLowerCase();
  for (const attrs of metaTags) {
    const name = asText(attrs.name || attrs.property || '').toLowerCase();
    if (name === wanted && collapse(attrs.content)) return collapse(attrs.content);
  }
  return '';
}

/**
 * 解析页面里与 SEO 有关的结构。
 * 注意：脚本先被剥掉再做结构统计，避免代码示例里的 <h1> 被误算。
 * @param {string} html
 * @returns {object}
 */
function analyseHtml(html) {
  const source = asText(html);
  const markup = stripNonContent(source);
  const metaTags = [...markup.matchAll(/<meta\b[^>]*>/gi)].map((match) => parseAttributes(match[0]));
  const linkTags = [...markup.matchAll(/<link\b[^>]*>/gi)].map((match) => parseAttributes(match[0]));

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(markup);
  const title = collapse(decodeEntities(titleMatch ? titleMatch[1] : ''));
  const description = readMeta(metaTags, 'description');

  const og = {};
  for (const attrs of metaTags) {
    const key = asText(attrs.property || attrs.name || '').toLowerCase();
    if (key.startsWith('og:') && collapse(attrs.content)) og[key] = collapse(attrs.content);
  }
  const ogTags = ['og:title', 'og:description', 'og:image'].filter((key) => og[key]).length;

  let canonical = '';
  for (const attrs of linkTags) {
    const rel = asText(attrs.rel).toLowerCase().split(/\s+/);
    if (rel.includes('canonical') && collapse(attrs.href)) {
      canonical = collapse(attrs.href);
      break;
    }
  }

  const hasViewport = metaTags.some(
    (attrs) =>
      asText(attrs.name).toLowerCase() === 'viewport' && collapse(attrs.content).length > 0,
  );

  const h1Count = (markup.match(/<h1\b[^>]*>/gi) || []).length;
  const h2Count = (markup.match(/<h2\b[^>]*>/gi) || []).length;

  const images = [...markup.matchAll(/<img\b[^>]*>/gi)].map((match) => parseAttributes(match[0]));
  const imgCount = images.length;
  // alt="" 视为「已声明为装饰图」，只有完全没写 alt 属性才算缺失。
  const imgNoAlt = images.filter((attrs) => !Object.prototype.hasOwnProperty.call(attrs, 'alt')).length;

  const jsonLdCount = [
    ...source.matchAll(
      /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ].filter((match) => asText(match[1]).trim().length > 0).length;

  return {
    title,
    description,
    og,
    ogTags,
    canonical,
    hasViewport,
    h1Count,
    h2Count,
    imgCount,
    imgNoAlt,
    jsonLdCount,
    text: stripToText(source),
  };
}

/** 统计中英文正文词数：中文按字符，英文/数字按词。 */
function countWords(text) {
  const source = asText(text);
  const cjk = (source.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const latin = (source.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
  return cjk + latin;
}

/** 统计去重后的内链 / 外链数量；跳过锚点、mailto、tel、javascript。 */
function analyseLinks(markup, pageUrl) {
  let base = null;
  try {
    base = new URL(asText(pageUrl));
  } catch {
    base = null;
  }

  const internal = new Set();
  const external = new Set();
  for (const match of markup.matchAll(/<a\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    const href = asText(attrs.href).trim();
    if (!href || href.startsWith('#') || /^(?:javascript|mailto|tel|data):/i.test(href)) continue;

    let resolved;
    try {
      resolved = base ? new URL(href, base) : new URL(href, 'https://placeholder.invalid/');
    } catch {
      continue;
    }

    if (!base) {
      if (/^(?:https?:)?\/\//i.test(href)) external.add(resolved.toString());
      else internal.add(resolved.toString());
      continue;
    }

    if (resolved.origin === base.origin) internal.add(resolved.toString());
    else external.add(resolved.toString());
  }

  return { internalLinks: internal.size, externalLinks: external.size };
}

/**
 * 解析 robots.txt 的封禁状态。
 * 只看主流搜索爬虫（* / Googlebot / Baiduspider / Bingbot 等）是否被 Disallow: /；
 * 只屏蔽 BadBot 的规则不算全站封禁，避免误报。
 * @param {string} robots
 * @returns {{ blocking: boolean, agents: string[] }}
 */
function inspectRobots(robots) {
  const text = asText(robots);
  const groups = [];
  let current = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) {
      // 空行是 robots 组的分隔符：下一行 User-agent 应开启新组，避免把 BadBot 的规则算到 * 头上。
      lastWasAgent = false;
      continue;
    }

    const agentMatch = /^user-agent\s*:\s*(.*)$/i.exec(line);
    if (agentMatch) {
      if (!current || !lastWasAgent) {
        current = { agents: [], disallowAll: false, allowRoot: false };
        groups.push(current);
      }
      current.agents.push(asText(agentMatch[1]).trim().toLowerCase());
      lastWasAgent = true;
      continue;
    }

    const disallowMatch = /^disallow\s*:\s*(.*)$/i.exec(line);
    if (disallowMatch) {
      if (!current) {
        current = { agents: ['*'], disallowAll: false, allowRoot: false };
        groups.push(current);
      }
      if (/^\/(?:\*)?$/.test(asText(disallowMatch[1]).trim())) current.disallowAll = true;
      lastWasAgent = false;
      continue;
    }

    const allowMatch = /^allow\s*:\s*(.*)$/i.exec(line);
    if (allowMatch) {
      if (!current) {
        current = { agents: ['*'], disallowAll: false, allowRoot: false };
        groups.push(current);
      }
      if (/^\/(?:\*)?$/.test(asText(allowMatch[1]).trim())) current.allowRoot = true;
      lastWasAgent = false;
      continue;
    }

    if (/^(?:crawl-delay|sitemap|host|clean-param)\s*:/i.test(line)) lastWasAgent = false;
  }

  // 主流搜索爬虫：被这些 UA 全站屏蔽，才会同时损失传统搜索与短视频搜索流量。
  const coreBots = new Set([
    '*',
    'googlebot',
    'baiduspider',
    'bingbot',
    'bytespider',
    'sogou web spider',
    '360spider',
    'yisouspider',
    'perplexitybot',
    'gptbot',
  ]);
  const blocked = groups.filter(
    (group) =>
      group.disallowAll &&
      !group.allowRoot &&
      group.agents.some((agent) => coreBots.has(agent.split('/')[0].trim())),
  );

  const agents = [...new Set(blocked.flatMap((group) => group.agents))];
  return { blocking: blocked.length > 0, agents };
}

/** 生成 canonical 修复示例：优先用当前页地址，解析失败再退回占位域名。 */
function canonicalExample(url) {
  try {
    const parsed = new URL(asText(url));
    return `${parsed.origin}${parsed.pathname || '/'}`;
  } catch {
    return 'https://example.com/current-page';
  }
}

/** 取域名，用于把修复建议写具体。 */
function hostExample(url) {
  try {
    return new URL(asText(url)).host;
  } catch {
    return 'example.com';
  }
}

/* ------------------------------------------------------------------ *
 * 评分
 * ------------------------------------------------------------------ */

/** 分数 → 中文等级：>= 80 好 / >= 50 一般 / 其余差。 */
function levelOf(score) {
  if (score >= 80) return '好';
  if (score >= 50) return '一般';
  return '差';
}

/** 按失败级别扣分，最低 0 分；返回整数。 */
function computeScore(checks) {
  let score = 100;
  for (const check of checks) {
    if (check.ok) continue;
    score -= LEVEL_WEIGHTS[check.level] ?? 0;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** 生成一条检查结果，保证字段齐全（渲染和下游都不用判空）。 */
function makeCheck(meta, ok, level, detail, fix) {
  return {
    id: meta.id,
    label: meta.label,
    level: ok ? meta.level : level,
    ok,
    detail,
    fix,
  };
}

/* ------------------------------------------------------------------ *
 * 短视频 SEO
 * ------------------------------------------------------------------ */

/** 话题标签去重（大小写不敏感），并保证 5-8 个。 */
function buildHashtags(keywordText) {
  const base = keywordText || '短视频SEO';
  const pool = [
    base,
    `${base}技巧`,
    `${base}案例`,
    `${base}获客`,
    '短视频SEO',
    'GEO优化',
    '本地获客',
    '内容营销',
  ];
  const seen = new Set();
  const tags = [];
  for (const item of pool) {
    const tag = `#${asText(item).replace(/\s+/g, '')}`;
    if (tag === '#' || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
    if (tags.length >= 6) break;
  }
  // 极端情况下（关键词与所有候选都重复）补足下限，保证 5-8 个的检查口径成立。
  const fillers = ['#SEO', '#搜索优化', '#内容运营', '#流量增长'];
  for (const tag of fillers) {
    if (tags.length >= VIDEO_LIMITS.hashtagMin) break;
    if (seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  return tags.slice(0, VIDEO_LIMITS.hashtagMax);
}

/**
 * 基于关键词生成短视频 SEO 建议。
 * 目标平台：抖音 / 视频号 / 小红书这类「标题 + 话题 + 封面」三件套决定点击率的场景。
 * @param {string} keyword
 * @returns {{ titleLen: number, hashtagCount: number, coverHint: string, tips: string[] }}
 */
function buildVideoSeo(keyword) {
  const keywordText = collapse(keyword) || '短视频SEO';
  const compact = keywordText.replace(/\s+/g, '');

  // 标题模板：核心词最多 10 字 + 7 字卖点，整体不超过 18 字。
  const title = `${clipText(compact, 10)}｜3个落地方法`;
  const titleLen = countChars(title);

  // 封面文案：4 字引导 + 关键词最多 6 字，整体不超过 12 字。
  const coverHint = `3步搞定${clipText(compact, 6)}`;
  const coverLen = countChars(coverHint);

  const hashtags = buildHashtags(compact);
  const hashtagCount = hashtags.length;

  const titleStatus =
    titleLen <= VIDEO_LIMITS.titleMax
      ? `≤ ${VIDEO_LIMITS.titleMax} 字，通过`
      : `超过 ${VIDEO_LIMITS.titleMax} 字，需要压缩`;
  const hashtagStatus =
    hashtagCount >= VIDEO_LIMITS.hashtagMin && hashtagCount <= VIDEO_LIMITS.hashtagMax
      ? '在 5-8 个区间内'
      : `不在 5-8 个区间，需要调整`;
  const coverStatus =
    coverLen <= VIDEO_LIMITS.coverMax
      ? `≤ ${VIDEO_LIMITS.coverMax} 字，通过`
      : `超过 ${VIDEO_LIMITS.coverMax} 字，需要压缩`;

  const tips = [
    `标题模板：用「${title}」（${titleLen} 字，${titleStatus}）。前 3 秒口播要重复关键词「${keywordText}」并给出一个具体结果，标题与实际内容必须一致。`,
    `话题标签：建议 5-8 个，当前 ${hashtagCount} 个（${hashtagStatus}）：${hashtags.join(' ')}。优先「核心词 + 场景词 + 人群词」，不要堆无关热词。`,
    `封面文案：主文案「${coverHint}」（${coverLen} 字，${coverStatus}）。大字占画面 1/3 以上，背景高对比，封面标题不要和视频标题完全重复。`,
  ];

  return { titleLen, hashtagCount, coverHint, tips };
}

/* ------------------------------------------------------------------ *
 * 主分析入口
 * ------------------------------------------------------------------ */

/**
 * 对已抓好的页面做传统 SEO + 短视频 SEO 体检（纯函数，不发网络请求）。
 *
 * @param {object} [input]
 * @param {string} [input.url] 页面地址，用于内外链判断和 canonical 示例
 * @param {string} [input.html] 页面 HTML
 * @param {object|Headers|Map} [input.headers] 响应头（用于识别 X-Robots-Tag: noindex）
 * @param {string} [input.robots] robots.txt 内容
 * @param {string[]} [input.sitemapUrls] sitemap 中的 URL 列表
 * @param {string} [input.keyword] 目标关键词，用于标题与短视频建议
 * @returns {{
 *   url: string,
 *   score: number,
 *   level: '好'|'一般'|'差',
 *   checks: Array<{id:string,label:string,level:'blocker'|'warn'|'info',ok:boolean,detail:string,fix:string}>,
 *   metrics: object,
 *   videoSeo: {titleLen:number,hashtagCount:number,coverHint:string,tips:string[]},
 *   recommendations: string[]
 * }}
 */
export function analyzeSeo({
  url = '',
  html = '',
  headers = {},
  robots = '',
  sitemapUrls = [],
  keyword = '',
} = {}) {
  const pageUrl = asText(url).trim();
  const keywordText = collapse(keyword);
  const htmlInfo = analyseHtml(html);
  const links = analyseLinks(stripNonContent(html), pageUrl);
  const wordCount = countWords(htmlInfo.text);
  const robotsInfo = inspectRobots(robots);
  const headerNoindex = /\b(?:noindex|none)\b/i.test(readHeader(headers, 'x-robots-tag'));
  const robotsBlocking = robotsInfo.blocking || headerNoindex;

  const urls = Array.isArray(sitemapUrls)
    ? sitemapUrls.map((item) => asText(item).trim()).filter(Boolean)
    : [];
  const hasSitemap = urls.length > 0;

  const titleLen = countChars(htmlInfo.title);
  const descLen = countChars(htmlInfo.description);
  const metrics = {
    title: htmlInfo.title,
    titleLen,
    description: htmlInfo.description,
    descLen,
    h1Count: htmlInfo.h1Count,
    h2Count: htmlInfo.h2Count,
    imgCount: htmlInfo.imgCount,
    imgNoAlt: htmlInfo.imgNoAlt,
    internalLinks: links.internalLinks,
    externalLinks: links.externalLinks,
    wordCount,
    canonical: htmlInfo.canonical,
    ogTags: htmlInfo.ogTags,
    jsonLdCount: htmlInfo.jsonLdCount,
    hasViewport: htmlInfo.hasViewport,
    hasSitemap,
    robotsBlocking,
  };

  const checks = [];

  // 1) title：存在 → 长度 → 关键词，按严重程度只取最高一档，避免一个根因扣三次分。
  {
    const meta = SEO_CHECKS[0];
    const keywordPart = keywordText ? `「${keywordText}」` : '核心词';
    if (!htmlInfo.title) {
      checks.push(
        makeCheck(
          meta,
          false,
          'blocker',
          '未找到 <title>，页面在搜索结果里没有可展示的标题。',
          `在 <head> 里补一个唯一的 <title>：${keywordPart} + 地域/场景 + 一个卖点，控制在 10-30 字，例如「${keywordText || '杭州GEO诊断'}｜3步提升AI引用率」。不要用「首页」「欢迎」这类无信息占位。`,
        ),
      );
    } else if (titleLen < 10) {
      checks.push(
        makeCheck(
          meta,
          false,
          'warn',
          `title 只有 ${titleLen} 字（要求 10-30 字）：「${htmlInfo.title}」。`,
          `把 title 从 ${titleLen} 字扩到 10-30 字：用 ${keywordPart} + 场景词 + 数字卖点，例如「${keywordText || '杭州GEO诊断'}｜3步提升AI引用率」，不要在标题里堆品牌名。`,
        ),
      );
    } else if (titleLen > 30) {
      checks.push(
        makeCheck(
          meta,
          false,
          'warn',
          `title 有 ${titleLen} 字，超过 30 字上限：「${clipText(htmlInfo.title, 40)}」。`,
          `把 title 从 ${titleLen} 字压到 30 字内：删掉重复品牌词、形容词和副标题，只保留 ${keywordPart} + 一个卖点，例如「${keywordText || '杭州GEO诊断'}｜3步落地」。`,
        ),
      );
    } else if (keywordText && !normalizeMatch(htmlInfo.title).includes(normalizeMatch(keywordText))) {
      checks.push(
        makeCheck(
          meta,
          false,
          'info',
          `title 共 ${titleLen} 字，但没有出现关键词「${keywordText}」。`,
          `把关键词「${keywordText}」原样放进 title 前半段（如「${keywordText}｜…」），不要只放拼音或同义词；若加上后会超 30 字，替换一个修饰词而不是继续追加。`,
        ),
      );
    } else {
      checks.push(
        makeCheck(
          meta,
          true,
          'blocker',
          `title 共 ${titleLen} 字${keywordText ? `，含关键词「${keywordText}」` : '，长度在 10-30 字区间'}`,
          `保持当前 title（${titleLen} 字）；改版时继续保留「${keywordText || '核心词'}」并控制在 10-30 字。`,
        ),
      );
    }
  }

  // 2) meta description：存在 → 50-160 字。
  {
    const meta = SEO_CHECKS[1];
    if (!htmlInfo.description) {
      checks.push(
        makeCheck(
          meta,
          false,
          'warn',
          '未找到 <meta name="description">，搜索结果摘要会被搜索引擎随机截取。',
          `在 <head> 补 <meta name="description" content="...">，写 50-160 字：服务对象 + 解决的问题 + 差异化 + 行动指令，并自然包含「${keywordText || '核心词'}」。每个页面单独写，不要全站复用同一段。`,
        ),
      );
    } else if (descLen < 50 || descLen > 160) {
      checks.push(
        makeCheck(
          meta,
          false,
          'info',
          `description 有 ${descLen} 字，超出 50-160 字区间。`,
          descLen < 50
            ? `把 description 从 ${descLen} 字补到 50 字以上：补「服务对象 + 具体结果 + 行动指令」，并自然带上「${keywordText || '核心词'}」，不要堆关键词。`
            : `把 description 从 ${descLen} 字压到 160 字内：删掉重复卖点和形容词，保留「对象 + 问题 + 结果 + 行动」四段，关键词只出现一次。`,
        ),
      );
    } else {
      checks.push(
        makeCheck(
          meta,
          true,
          'warn',
          `description 共 ${descLen} 字，在 50-160 字区间。`,
          '保持当前 description；新页面按同一结构单独撰写，避免全站复制。',
        ),
      );
    }
  }

  // 3) H1 恰好 1 个，H2 至少 2 个。
  {
    const meta = SEO_CHECKS[2];
    const problems = [];
    const fixes = [];
    if (htmlInfo.h1Count !== 1) {
      problems.push(`H1 有 ${htmlInfo.h1Count} 个（应为 1 个）`);
      if (htmlInfo.h1Count === 0) {
        fixes.push(
          `在正文开头补 1 个唯一 <h1>，直接写页面主题并含「${keywordText || '核心词'}」，例如 <h1>${keywordText || '杭州GEO诊断'}：3步提升AI引用率</h1>；不要用 logo 或导航文字代替 H1。`,
        );
      } else {
        fixes.push(
          '只保留 1 个最贴合页面主题的 <h1>，其余改成 <h2>；H1 不要和 title 完全重复，可以补一个场景词。',
        );
      }
    }
    if (htmlInfo.h2Count < 2) {
      problems.push(`H2 有 ${htmlInfo.h2Count} 个（应至少 2 个）`);
      fixes.push(
        '把正文拆成至少 2 个 <h2> 小标题（如「GEO 是什么」「3 步怎么做」），每个小标题自然带一个长尾词；不要用加粗段落冒充标题。',
      );
    }
    checks.push(
      makeCheck(
        meta,
        problems.length === 0,
        'warn',
        problems.length === 0
          ? `H1 ${htmlInfo.h1Count} 个、H2 ${htmlInfo.h2Count} 个，层级符合要求。`
          : `${problems.join('；')}。`,
        problems.length === 0
          ? '保持当前 H1/H2 结构；新增内容继续用 H2/H3 分层，不要跳级。'
          : fixes.join(' '),
      ),
    );
  }

  // 4) canonical。
  {
    const meta = SEO_CHECKS[3];
    checks.push(
      htmlInfo.canonical
        ? makeCheck(
            meta,
            true,
            'warn',
            `canonical 指向 ${htmlInfo.canonical}。`,
            '保持 canonical 为当前页的绝对地址；改版或换域名时同步更新，不要带 utm 等跟踪参数。',
          )
        : makeCheck(
            meta,
            false,
            'warn',
            '未找到 rel="canonical"，重复内容可能分散权重。',
            `在 <head> 加 <link rel="canonical" href="${canonicalExample(pageUrl)}">，用绝对地址指向当前页规范版本，不带跟踪参数；分页列表页各自 canonical 到自己。`,
          ),
    );
  }

  // 5) viewport（移动端）。
  {
    const meta = SEO_CHECKS[4];
    checks.push(
      htmlInfo.hasViewport
        ? makeCheck(
            meta,
            true,
            'warn',
            '已声明 viewport，移动端可按屏幕宽度渲染。',
            '保持 viewport 声明；不要用固定宽度或 user-scalable=no 限制缩放。',
          )
        : makeCheck(
            meta,
            false,
            'warn',
            '未找到 viewport meta，移动端会按桌面宽度缩放。',
            '在 <head> 加 <meta name="viewport" content="width=device-width, initial-scale=1">，然后用真机检查字号和按钮点击区域，不要禁用用户缩放。',
          ),
    );
  }

  // 6) Open Graph：og:title / og:description / og:image 至少 2 个。
  {
    const meta = SEO_CHECKS[5];
    const missing = ['og:title', 'og:description', 'og:image'].filter((key) => !htmlInfo.og[key]);
    checks.push(
      htmlInfo.ogTags >= 2
        ? makeCheck(
            meta,
            true,
            'warn',
            `已配置 ${htmlInfo.ogTags}/3 个核心 OG 标签。`,
            missing.length
              ? `补上缺失的 ${missing.join('、')}；分享卡片会用到，图片建议 1200×630。`
              : '保持 OG 三件套；换标题或主图时同步更新 og:title / og:image。',
          )
        : makeCheck(
            meta,
            false,
            'warn',
            `核心 OG 标签只有 ${htmlInfo.ogTags}/3 个（至少需要 2 个），分享到微信/飞书/抖音时没有卡片。`,
            '在 <head> 补 <meta property="og:title" content="页面标题">、<meta property="og:description" content="一句话卖点">、<meta property="og:image" content="https://域名/og-1200x630.jpg">；图片用 1200×630 绝对地址，确保无需登录即可访问。',
          ),
    );
  }

  // 7) JSON-LD 结构化数据。
  {
    const meta = SEO_CHECKS[6];
    checks.push(
      htmlInfo.jsonLdCount > 0
        ? makeCheck(
            meta,
            true,
            'warn',
            `检测到 ${htmlInfo.jsonLdCount} 段 JSON-LD。`,
            '保持 JSON-LD 与页面可见内容一致；改价格、评分、FAQ 时同步更新，并用富媒体测试工具复查。',
          )
        : makeCheck(
            meta,
            false,
            'warn',
            '未检测到 JSON-LD 结构化数据，搜索引擎只能靠正文猜内容。',
            '在 <head> 加 <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"品牌名","url":"https://域名/"}</script>；文章页再加 Article（headline/datePublished/author），FAQ 页加 FAQPage，字段必须与页面可见内容一致。',
          ),
    );
  }

  // 8) 图片 alt 覆盖率：缺失占比 > 30% 才提醒。
  {
    const meta = SEO_CHECKS[7];
    const ratio = htmlInfo.imgCount > 0 ? htmlInfo.imgNoAlt / htmlInfo.imgCount : 0;
    if (htmlInfo.imgCount === 0) {
      checks.push(
        makeCheck(
          meta,
          true,
          'warn',
          '页面没有 <img>，跳过 alt 覆盖率检查。',
          '如果后续加图，记得给内容图写描述性 alt；纯装饰图写 alt="" 并保留 width/height。',
        ),
      );
    } else if (ratio > 0.3) {
      checks.push(
        makeCheck(
          meta,
          false,
          'warn',
          `${htmlInfo.imgNoAlt}/${htmlInfo.imgCount} 张图片缺 alt（${Math.round(ratio * 100)}%，阈值 30%）。`,
          `给 ${htmlInfo.imgNoAlt} 张缺 alt 的图片补描述：写「对象 + 场景/用途」，例如 alt="杭州GEO诊断报告示例"；纯装饰图用 alt=""，不要堆关键词。`,
        ),
      );
    } else {
      checks.push(
        makeCheck(
          meta,
          true,
          'warn',
          `${htmlInfo.imgNoAlt}/${htmlInfo.imgCount} 张图片缺 alt（${Math.round(ratio * 100)}%，未超过 30%）。`,
          '保持 alt 覆盖率；新增内容图继续写描述性 alt，装饰图用空 alt。',
        ),
      );
    }
  }

  // 9) 内链至少 3 条、外链至少 1 条。
  {
    const meta = SEO_CHECKS[8];
    const internalOk = links.internalLinks >= 3;
    const externalOk = links.externalLinks >= 1;
    const fixes = [];
    if (!internalOk) {
      fixes.push(
        `正文里补 ${3 - links.internalLinks} 条以上站内链接，锚文本写目标页主题（如「GEO 诊断流程」→ /service），优先链向核心服务页和案例页，不要用「点击这里」。`,
      );
    }
    if (!externalOk) {
      fixes.push(
        '补 1 条行业权威外链（如 Google Search Central、百度搜索资源平台的相关文档），并加 rel="noopener"；外链要能正常打开。',
      );
    }
    checks.push(
      makeCheck(
        meta,
        internalOk && externalOk,
        'warn',
        `内链 ${links.internalLinks} 条（应 ≥3），外链 ${links.externalLinks} 条（应 ≥1）。`,
        internalOk && externalOk
          ? '保持当前链接密度；新增页面时继续补 3 条以上相关内链。'
          : fixes.join(' '),
      ),
    );
  }

  // 10) 正文至少 300 字（中文按字符、英文按词）。
  {
    const meta = SEO_CHECKS[9];
    checks.push(
      wordCount >= 300
        ? makeCheck(
            meta,
            true,
            'warn',
            `正文约 ${wordCount} 字，达到 300 字门槛。`,
            '保持正文信息密度；更新时优先补案例、步骤和可核验数据，不要为凑字数重复。',
          )
        : makeCheck(
            meta,
            false,
            'warn',
            `正文约 ${wordCount} 字，低于 300 字门槛。`,
            `把正文从 ${wordCount} 字补到 300 字以上：按「问题—原因—步骤—案例」展开，每段 80-150 字，至少补 ${300 - wordCount} 字；补真实细节，不要堆关键词。`,
          ),
    );
  }

  // 11) robots.txt：全站 Disallow: / 为阻断。
  {
    const meta = SEO_CHECKS[10];
    const detailParts = [];
    if (robotsInfo.blocking) {
      const agents = robotsInfo.agents
        .map((agent) => (agent === '*' ? 'User-agent: *' : agent))
        .join('、');
      detailParts.push(`robots.txt 对 ${agents || '主流搜索爬虫'} 设置了 Disallow: /`);
    }
    if (headerNoindex) detailParts.push('响应头 X-Robots-Tag 含 noindex');
    checks.push(
      robotsBlocking
        ? makeCheck(
            meta,
            false,
            'blocker',
            `${detailParts.join('；')}，搜索引擎不会收录整站。`,
            `删掉 robots.txt 中 User-agent: * 下的 Disallow: /（改成 Allow: /），只屏蔽 /admin、/cart 等后台路径；同时移除响应头 X-Robots-Tag: noindex，并保留 Sitemap: https://${hostExample(pageUrl)}/sitemap.xml。`,
          )
        : makeCheck(
            meta,
            true,
            'blocker',
            'robots.txt 未全站封禁，主流搜索爬虫可以抓取。',
            '保持 Allow: /；新增后台路径时用 Disallow 精确屏蔽，发布前用「网址检查」确认可抓取。',
          ),
    );
  }

  // 12) sitemap 是否有可访问的 URL 条目。
  {
    const meta = SEO_CHECKS[11];
    checks.push(
      hasSitemap
        ? makeCheck(
            meta,
            true,
            'warn',
            `sitemap 提供了 ${urls.length} 条 URL。`,
            '保持 sitemap 自动更新；新增页面 24 小时内进 sitemap，删除页面及时移除，并定期检查是否为 200。',
          )
        : makeCheck(
            meta,
            false,
            'warn',
            '未拿到可用的 sitemap URL 列表（/sitemap.xml 无 <loc> 或不可访问）。',
            `生成 /sitemap.xml 并在 robots.txt 里加 Sitemap: https://${hostExample(pageUrl)}/sitemap.xml，至少包含首页 + 核心服务页 + 文章页；<loc> 用绝对地址，提交到 Google Search Console 和百度搜索资源平台，确认返回 200。`,
          ),
    );
  }

  // 评分与建议：建议按 blocker → warn → info 排序，同级保持检查表顺序。
  const score = computeScore(checks);
  const priority = { blocker: 0, warn: 1, info: 2 };
  const recommendations = checks
    .map((check, index) => ({ check, index }))
    .filter((item) => !item.check.ok)
    .sort(
      (left, right) =>
        (priority[left.check.level] ?? 9) - (priority[right.check.level] ?? 9) ||
        left.index - right.index,
    )
    .map((item) => item.check.fix);

  return {
    url: pageUrl,
    score,
    level: levelOf(score),
    checks,
    metrics,
    videoSeo: buildVideoSeo(keywordText),
    recommendations,
  };
}

/* ------------------------------------------------------------------ *
 * 抓取
 * ------------------------------------------------------------------ */

/** 给没有协议前缀的域名补 https，并拒绝非 http/https 地址。 */
function normalizeTarget(input) {
  let raw = asText(input).trim();
  if (!raw) throw new TypeError('fetchAndAnalyzeSeo(url)：url 不能为空');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError(`fetchAndAnalyzeSeo(url)：不是合法的 URL —— ${input}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`fetchAndAnalyzeSeo(url)：只支持 http/https，收到 ${parsed.protocol}`);
  }
  parsed.hash = '';
  return parsed.toString();
}

/** 把 fetch 异常翻成中文可读文案，保留原始 message 方便排查。 */
function describeFetchError(error, url) {
  if (error && error.name === 'AbortError') return `请求超时：${url}`;
  const message = error instanceof Error ? error.message : asText(error);
  return `网络请求失败：${message || `无法访问 ${url}`}`;
}

/**
 * 单次请求，永远不抛异常：成功返回文本与响应头，失败折成 ok:false。
 * @param {string} url
 * @param {Function} fetchImpl
 * @param {number} timeoutMs
 * @returns {Promise<{ok:boolean,status:number|null,text:string,headers:object,error?:string}>}
 */
async function requestText(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timeout = Number(timeoutMs);
  let timer = null;

  if (Number.isFinite(timeout) && timeout > 0) {
    timer = setTimeout(() => controller.abort(), timeout);
    // 测试或 CLI 里不要因为一个定时器把进程吊住。
    if (typeof timer.unref === 'function') timer.unref();
  }

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': DEFAULT_USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });

    const status = Number(response && response.status);
    const text = response && typeof response.text === 'function' ? await response.text() : '';
    const headers = toPlainHeaders(response && response.headers);

    if (!Number.isFinite(status) || status < 200 || status >= 300) {
      return {
        ok: false,
        status: Number.isFinite(status) ? status : null,
        text: '',
        headers,
        error: `HTTP ${Number.isFinite(status) && status > 0 ? status : '无响应'}`,
      };
    }

    return { ok: true, status, text: asText(text), headers };
  } catch (error) {
    return {
      ok: false,
      status: null,
      text: '',
      headers: {},
      error: describeFetchError(error, url),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 从 sitemap XML 里提取 <loc> 列表，去重并限制数量。 */
function parseSitemapUrls(xml) {
  const source = asText(xml);
  const seen = new Set();
  const urls = [];

  for (const match of source.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)) {
    const loc = decodeEntities(asText(match[1]))
      .replace(/<!\[CDATA\[|\]\]>/g, '')
      .trim();
    if (!loc || seen.has(loc)) continue;
    seen.add(loc);
    urls.push(loc);
    if (urls.length >= MAX_SITEMAP_URLS) break;
  }

  return urls;
}

/**
 * 抓取页面 + robots.txt + sitemap.xml，然后调用 analyzeSeo。
 * 只有主页面失败才返回 ok:false；robots/sitemap 失败按「缺失」处理，不影响主体检。
 *
 * @param {string} url 页面地址（没有协议时默认补 https）
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] 可注入的 fetch（测试用，不发真实网络）
 * @param {number} [options.timeoutMs=15000] 单个请求超时
 * @param {string} [options.keyword] 目标关键词
 * @returns {Promise<object>} 成功：{ok:true, ...analyzeSeo 结果}；失败：{ok:false, url, error}
 */
export async function fetchAndAnalyzeSeo(url, { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, keyword = '' } = {}) {
  const impl = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  let target = asText(url).trim();

  try {
    target = normalizeTarget(url);
    if (typeof impl !== 'function') {
      return { ok: false, url: target, error: '当前运行环境没有可用的 fetch，请传入 fetchImpl。' };
    }

    const page = await requestText(target, impl, timeoutMs);
    if (!page.ok) {
      return { ok: false, url: target, error: page.error || '页面抓取失败。' };
    }

    // robots 与 sitemap 并行抓，任一失败都只当作缺失，不打断主流程。
    const [robotsResult, sitemapResult] = await Promise.all([
      requestText(new URL('/robots.txt', target).toString(), impl, timeoutMs),
      requestText(new URL('/sitemap.xml', target).toString(), impl, timeoutMs),
    ]);

    const analysis = analyzeSeo({
      url: target,
      html: page.text,
      headers: page.headers,
      robots: robotsResult.ok ? robotsResult.text : '',
      sitemapUrls: sitemapResult.ok ? parseSitemapUrls(sitemapResult.text) : [],
      keyword,
    });

    return { ok: true, ...analysis };
  } catch (error) {
    return {
      ok: false,
      url: target,
      error: error instanceof Error ? error.message : asText(error),
    };
  }
}

/* ------------------------------------------------------------------ *
 * Markdown 渲染
 * ------------------------------------------------------------------ */

/** 转义 Markdown 表格单元格，防止说明里的 | 或换行破坏表格。 */
function escapeCell(value) {
  return asText(value)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/** 失败级别 → 表格里的结果文案。 */
function verdictOf(check) {
  if (check.ok) return '通过';
  if (check.level === 'blocker') return '阻断';
  if (check.level === 'warn') return '提醒';
  if (check.level === 'info') return '建议';
  return '待修';
}

/**
 * 把体检结果渲染成 Markdown，固定五节：
 * 「## SEO 评分」「## 检查明细」「## 指标」「## 短视频 SEO」「## 行动建议」。
 *
 * @param {object} result analyzeSeo / fetchAndAnalyzeSeo 的返回值
 * @returns {string}
 */
export function renderSeoMarkdown(result) {
  const source = result && typeof result === 'object' ? result : {};
  const lines = [];

  // 抓取失败也给出可读结果，而不是抛异常或返回空字符串。
  if (source.ok === false) {
    lines.push('## SEO 评分');
    lines.push('');
    lines.push('- 未完成体检：抓取页面失败。');
    lines.push(`- 原因：${asText(source.error) || '未知错误'}`);
    lines.push(`- 页面：${asText(source.url) || '未提供'}`);
    lines.push('');
    return lines.join('\n');
  }

  const checks = Array.isArray(source.checks) ? source.checks : [];
  const metrics = source.metrics && typeof source.metrics === 'object' ? source.metrics : {};
  const video = source.videoSeo && typeof source.videoSeo === 'object' ? source.videoSeo : {};
  const recommendations = Array.isArray(source.recommendations) ? source.recommendations : [];
  const score = Number.isFinite(Number(source.score)) ? Math.round(Number(source.score)) : 0;
  const level = asText(source.level) || levelOf(score);

  const failed = checks.filter((check) => !check.ok);
  const blocked = failed.filter((check) => check.level === 'blocker').length;
  const warned = failed.filter((check) => check.level === 'warn').length;
  const suggested = failed.filter((check) => check.level === 'info').length;

  lines.push('## SEO 评分');
  lines.push('');
  lines.push(`- 评分：**${score} / 100**（${level}）`);
  lines.push(`- 通过 ${checks.length - failed.length} 项 / 待修 ${failed.length} 项（阻断 ${blocked} / 提醒 ${warned} / 建议 ${suggested}）`);
  lines.push(`- 页面：${asText(source.url) || '未提供'}`);
  lines.push('');

  lines.push('## 检查明细');
  lines.push('');
  lines.push('| 项 | 结果 | 说明 | 修复 |');
  lines.push('| --- | --- | --- | --- |');
  if (checks.length === 0) {
    lines.push('| 无 | 待修 | 没有可用的检查结果 | 先运行 analyzeSeo 或 fetchAndAnalyzeSeo |');
  } else {
    for (const check of checks) {
      lines.push(
        `| ${escapeCell(check.label || check.id)} | ${verdictOf(check)} | ${escapeCell(check.detail)} | ${escapeCell(check.fix || '—')} |`,
      );
    }
  }
  lines.push('');

  lines.push('## 指标');
  lines.push('');
  lines.push(`- title：${metrics.title ? `「${metrics.title}」` : '缺失'}（${Number(metrics.titleLen) || 0} 字）`);
  lines.push(`- meta description：${metrics.description ? `「${metrics.description}」` : '缺失'}（${Number(metrics.descLen) || 0} 字）`);
  lines.push(`- 标题层级：H1 ${Number(metrics.h1Count) || 0} 个 / H2 ${Number(metrics.h2Count) || 0} 个`);
  lines.push(`- 图片：${Number(metrics.imgCount) || 0} 张，缺 alt ${Number(metrics.imgNoAlt) || 0} 张`);
  lines.push(`- 链接：内链 ${Number(metrics.internalLinks) || 0} 条 / 外链 ${Number(metrics.externalLinks) || 0} 条`);
  lines.push(`- 正文：${Number(metrics.wordCount) || 0} 字（中文按字符、英文按词）`);
  lines.push(`- canonical：${metrics.canonical || '缺失'}`);
  lines.push(`- OG 标签：${Number(metrics.ogTags) || 0}/3 个`);
  lines.push(`- JSON-LD：${Number(metrics.jsonLdCount) || 0} 段`);
  lines.push(`- viewport：${metrics.hasViewport ? '有' : '无'}`);
  lines.push(`- sitemap：${metrics.hasSitemap ? '有条目' : '无 / 不可访问'}`);
  lines.push(`- robots：${metrics.robotsBlocking ? '全站封禁' : '未全站封禁'}`);
  lines.push('');

  lines.push('## 短视频 SEO');
  lines.push('');
  lines.push(`- 标题长度：${Number(video.titleLen) || 0} 字（上限 ${VIDEO_LIMITS.titleMax} 字）`);
  lines.push(`- 话题标签：${Number(video.hashtagCount) || 0} 个（建议 ${VIDEO_LIMITS.hashtagMin}-${VIDEO_LIMITS.hashtagMax} 个）`);
  lines.push(`- 封面文案：${video.coverHint ? `「${video.coverHint}」` : '未生成'}`);
  lines.push('');
  const tips = Array.isArray(video.tips) ? video.tips : [];
  if (tips.length === 0) {
    lines.push('- 无：未提供关键词，暂不生成短视频建议。');
  } else {
    lines.push('- 三条建议：');
    for (const tip of tips) lines.push(`  - ${tip}`);
  }
  lines.push('');

  lines.push('## 行动建议');
  lines.push('');
  if (recommendations.length === 0) {
    lines.push('- 无：12 项检查全部通过，保持现有结构并每月复查一次。');
  } else {
    recommendations.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  }
  lines.push('');

  return lines.join('\n');
}
