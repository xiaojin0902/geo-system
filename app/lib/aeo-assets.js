/**
 * lib/aeo-assets.js
 * AEO 技术层：为站点生成「给 AI 引擎看的资产」。
 *
 * 为什么需要它：AI 引擎（ChatGPT / Claude / Perplexity / 豆包 / 文心）了解一个站点，
 * 主要靠三样东西——llms.txt（站点说明书）、robots.txt（准不准抓）、JSON-LD（你到底是谁、卖什么）。
 * 这三样是 dualmark、aeo.js 这类开源项目的核心卖点，也是 GEO 交付物的标配。
 *
 * 约束（刻意保持简单）：
 * - 纯函数：不读文件、不写文件、不发网络请求；落盘与目录由 CLI（bin/geo.js）负责。
 * - 零依赖：只用语言自带的 JSON / 字符串处理。
 * - 不编造字段：品牌没给的联系方式（telephone / email / vatID）一律不输出，
 *   编造出来的结构化数据会被 AI 引擎当成事实转述，属于自伤。
 */

/** schema.org 官方上下文；带 http 或尾斜杠的写法会被校验判错 */
const SCHEMA_CONTEXT = 'https://schema.org';

/** baseUrl 缺省时的占位域名（同时会写一条 warning 提醒替换） */
const DEFAULT_BASE_URL = 'https://example.com';

/**
 * robots.txt 里统一放行的 9 个 AI 爬虫。
 * 与 lib/audit-site.js 的 AI_CRAWLERS 保持同一份名单：那边负责「体检」，这边负责「授权」。
 */
export const AI_CRAWLER_UA = Object.freeze([
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'anthropic-ai',
  'PerplexityBot',
  'Google-Extended',
  'Bytespider',
  'Baiduspider',
]);

/** robots.txt 头部声明：告诉后来接手的人，这段删了 AI 引擎可能就进不来 */
const ROBOTS_HEADER =
  '# 由恒野 GEO 生成 · 放行 AI 爬虫（不要删除本段，否则 AI 引擎可能拿不到授权）';

// ---------------------------------------------------------------- 内部工具

/** 取一段干净文本：非字符串一律当空串，首尾空白裁掉 */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 从数组里取第一个非空字符串（用于 brand.urls 这类来源） */
function firstNonEmpty(values) {
  if (!Array.isArray(values)) return '';
  for (const value of values) {
    const item = text(value);
    if (item) return item;
  }
  return '';
}

/**
 * 规范化站点根地址：补协议、去掉结尾斜杠。
 * 允许传 `sanrenxing.cn` 这种省略协议的值，否则拼出来的链接在浏览器里点不开。
 */
function normalizeBaseUrl(value) {
  const raw = text(value);
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw)
    ? raw
    : `https://${raw.replace(/^\/+/, '')}`;
  return withScheme.replace(/\/+$/, '');
}

/**
 * 把链接补成可访问地址：绝对 http(s) 原样保留，相对路径拼到 baseUrl 上。
 * @param {string} url
 * @param {string} baseUrl 已规范化的站点根地址
 */
function resolveUrl(url, baseUrl) {
  const raw = text(url);
  if (!raw) return '';
  // 绝对地址与协议相对地址（//cdn.example.com）不碰
  if (/^https?:\/\//i.test(raw) || raw.startsWith('//')) return raw;
  const origin = normalizeBaseUrl(baseUrl);
  if (!origin) return raw;
  return raw.startsWith('/') ? `${origin}${raw}` : `${origin}/${raw}`;
}

/**
 * 从品牌信息里提炼一句兜底简介。
 * city / industry 缺省时也必须给出一句通顺的话，否则 llms.txt 的 `> ` 行会空着。
 */
function describeBrand(brand = {}) {
  const city = text(brand.city);
  const industry = text(brand.industry);
  // 行业名本身以「服务」结尾时只补一个「商」，避免出现「服务服务商」这种别扭写法
  const suffix = industry.endsWith('服务') ? '商' : '服务商';
  if (city && industry) return `${city}${industry}${suffix}`;
  if (city) return `${city}本地服务商`;
  if (industry) return `${industry}${suffix}`;
  return '一家专注内容与 AI 搜索可见性的服务商';
}

/** 品牌的服务范围：优先显式 areaServed，其次 scope，最后退回所在城市 */
function brandAreaServed(brand = {}) {
  return text(brand.areaServed) || text(brand.scope) || text(brand.city);
}

/** 品牌官网地址：brand.url → brand.urls[0] → baseUrl */
function brandUrl(brand = {}, origin = '') {
  const explicit = text(brand.url);
  if (explicit) return resolveUrl(explicit, origin) || explicit;
  const fromList = firstNonEmpty(brand.urls);
  if (fromList) return resolveUrl(fromList, origin) || fromList;
  return origin;
}

/** 格式化 JSON 文件内容：2 空格缩进 + 末尾换行 */
function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ---------------------------------------------------------------- llms.txt

/**
 * 生成 llms.txt。
 *
 * 格式遵循 llms.txt 社区约定：H1 品牌名 → `> 一句话简介` → 若干 `## 分组` + 链接列表。
 * 注意：llms.txt 是纯文本不是 HTML，品牌名/标题里的 `[` `]` `(` `)` **原样保留、不转义**，
 * 这也是一条硬性要求（客户品牌名里带括号时不能被搞坏）。
 *
 * @param {object} options
 * @param {{name?: string, city?: string, industry?: string, services?: string[]}} options.brand
 * @param {string} [options.baseUrl] 站点根地址，用于拼接相对链接
 * @param {string} [options.summary] 一句话简介，缺省时用「城市 + 行业」兜底
 * @param {Array<{title: string, links: Array<{title: string, url: string, desc?: string}>}>} [options.sections]
 * @returns {string} llms.txt 全文（`\n` 换行，单个结尾换行，无多余空行）
 */
export function buildLlmsTxt({ brand = {}, baseUrl, summary, sections } = {}) {
  const name = text(brand.name) || '品牌';
  const intro = text(summary) || describeBrand(brand);
  const origin = normalizeBaseUrl(baseUrl);
  const lines = [`# ${name}`, '', `> ${intro}`];

  for (const section of Array.isArray(sections) ? sections : []) {
    const title = text(section?.title);
    if (!title) continue;

    const linkLines = [];
    for (const link of Array.isArray(section?.links) ? section.links : []) {
      if (!link) continue;
      const linkTitle = text(link.title) || text(link.url);
      if (!linkTitle) continue;
      const desc = text(link.desc);
      const url = resolveUrl(link.url, origin);
      // 没有落地页时输出纯说明行，而不是把一堆服务硬指到首页（那会让 llms.txt 全是重复链接）
      if (!url) {
        linkLines.push(`- ${linkTitle}${desc ? `：${desc}` : ''}`);
        continue;
      }
      linkLines.push(`- [${linkTitle}](${url})${desc ? `：${desc}` : ''}`);
    }
    if (!linkLines.length) continue;
    lines.push('', `## ${title}`, ...linkLines);
  }

  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- robots.txt

/**
 * robots.txt 里的路径规范：去空白、补前导斜杠；传完整 URL 时只取 pathname。
 * @param {string} value
 */
function normalizeRobotsPath(value) {
  const raw = text(value);
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).pathname || '/';
    } catch {
      return '/';
    }
  }
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/**
 * 生成 robots.txt：
 * - 默认放行 9 个 AI 爬虫（GPTBot / ClaudeBot / PerplexityBot / 豆包 / 文心等），
 *   否则 AI 引擎拿不到授权，等于主动放弃 AI 搜索流量；
 * - `User-agent: *` 走通用规则，disallowPaths 逐条写入；
 * - 末尾给出 Sitemap。
 *
 * @param {object} options
 * @param {string} [options.baseUrl] 站点根地址
 * @param {string} [options.sitemapPath] sitemap 路径，缺省 `/sitemap.xml`
 * @param {boolean} [options.allowAICrawlers] 是否输出 AI 爬虫放行段，缺省 true
 * @param {string[]} [options.disallowPaths] 需要屏蔽的路径（会自动去重、补前导斜杠）
 * @returns {string} robots.txt 全文
 */
export function buildRobotsTxt({
  baseUrl,
  sitemapPath = '/sitemap.xml',
  allowAICrawlers = true,
  disallowPaths = [],
} = {}) {
  const origin = normalizeBaseUrl(baseUrl) || DEFAULT_BASE_URL;
  const blocks = [];

  if (allowAICrawlers) {
    blocks.push(ROBOTS_HEADER);
    for (const agent of AI_CRAWLER_UA) {
      blocks.push(`User-agent: ${agent}\nAllow: /`);
    }
  }

  const rules = ['User-agent: *', 'Allow: /'];
  const seen = new Set();
  for (const rawPath of Array.isArray(disallowPaths) ? disallowPaths : []) {
    const path = normalizeRobotsPath(rawPath);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    rules.push(`Disallow: ${path}`);
  }
  blocks.push(rules.join('\n'));

  const sitemapUrl = resolveUrl(sitemapPath, origin) || `${origin}/sitemap.xml`;
  blocks.push(`Sitemap: ${sitemapUrl}`);

  return `${blocks.join('\n\n')}\n`;
}

// ---------------------------------------------------------------- JSON-LD

/**
 * Organization 结构化数据。
 * 字段严格按「有才输出」的原则：legalName / address / areaServed / sameAs 缺就整个键不出现，
 * telephone / email / vatID 这类联系方式本项目不生成（不编造）。
 * @param {{brand?: object, baseUrl?: string}} input
 */
function buildOrganizationJsonLd({ brand = {}, baseUrl } = {}) {
  const origin = normalizeBaseUrl(baseUrl);
  const doc = {
    '@context': SCHEMA_CONTEXT,
    '@type': 'Organization',
  };

  const name = text(brand.name);
  if (name) doc.name = name;

  const legalName = text(brand.legalName);
  if (legalName) doc.legalName = legalName;

  doc.description = text(brand.description) || describeBrand(brand);

  const url = brandUrl(brand, origin);
  if (url) doc.url = url;

  const city = text(brand.city);
  if (city) {
    doc.address = {
      '@type': 'PostalAddress',
      addressLocality: city,
      addressCountry: 'CN',
    };
  }

  const areaServed = brandAreaServed(brand);
  if (areaServed) doc.areaServed = areaServed;

  const sameAs = Array.isArray(brand.urls) ? brand.urls.map(text).filter(Boolean) : [];
  if (sameAs.length) doc.sameAs = sameAs;

  return doc;
}

/**
 * Service 结构化数据：一项服务一条，provider 指回品牌。
 * @param {{brand?: object, baseUrl?: string, service?: object}} input
 */
function buildServiceJsonLd({ brand = {}, baseUrl, service = {} } = {}) {
  const origin = normalizeBaseUrl(baseUrl);
  const doc = {
    '@context': SCHEMA_CONTEXT,
    '@type': 'Service',
  };

  const name = text(service.name) || text(brand.industry);
  if (name) doc.name = name;

  const description = text(service.description);
  if (description) doc.description = description;

  // service.url 是「这项服务的独立页面」，没给就不编，绝不拿 baseUrl 冒充
  const url = resolveUrl(service.url, origin);
  if (url) doc.url = url;

  doc.serviceType = text(service.serviceType) || name || '服务';

  doc.provider = { '@type': 'Organization' };
  const providerName = text(brand.name);
  if (providerName) doc.provider.name = providerName;
  const providerUrl = brandUrl(brand, origin);
  if (providerUrl) doc.provider.url = providerUrl;

  // 没有城市/服务范围时不硬编「全国」，交给上层补品牌信息
  const areaServed = brandAreaServed(brand);
  if (areaServed) doc.areaServed = areaServed;

  return doc;
}

/**
 * FAQPage 结构化数据：questions[i].q / .a 直接映射到 Question.name / Answer.text。
 * @param {{faqs?: Array<{q?: string, a?: string}>}} input
 */
function buildFaqJsonLd({ faqs } = {}) {
  const list = Array.isArray(faqs) ? faqs : [];
  return {
    '@context': SCHEMA_CONTEXT,
    '@type': 'FAQPage',
    mainEntity: list.map((item) => ({
      '@type': 'Question',
      name: item?.q,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item?.a,
      },
    })),
  };
}

/**
 * 生成 JSON-LD 结构化数据对象。
 * @param {'organization'|'service'|'faq'} kind
 * @param {object} input 见各 build*JsonLd 的入参说明
 * @returns {object} 可直接 `JSON.stringify` 的 JSON-LD 对象
 * @throws {Error} kind 不认识时抛出中文错误
 */
export function buildJsonLd(kind, input = {}) {
  const payload = input ?? {};
  if (kind === 'organization') return buildOrganizationJsonLd(payload);
  if (kind === 'service') return buildServiceJsonLd(payload);
  if (kind === 'faq') return buildFaqJsonLd(payload);
  throw new Error(
    `未知的 JSON-LD 类型：${String(kind)}，仅支持 organization / service / faq`,
  );
}

// ---------------------------------------------------------------- 校验

/**
 * 递归收集「空字符串值」与「undefined 值」的问题，路径用 `a.b[0].c` 表达。
 * 根节点的 @context / @type 由调用方单独校验，这里跳过避免重复报错。
 */
function collectValueErrors(node, path, errors) {
  if (node === undefined) {
    errors.push(`${path || '顶层值'} 为 undefined`);
    return;
  }
  if (typeof node === 'string') {
    if (node.trim() === '') errors.push(`${path || '顶层值'} 为空字符串`);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectValueErrors(item, `${path}[${index}]`, errors));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, child] of Object.entries(node)) {
      if (path === '' && (key === '@context' || key === '@type')) continue;
      collectValueErrors(child, path ? `${path}.${key}` : key, errors);
    }
  }
}

/** 校验单个 JSON-LD 对象，返回中文错误清单 */
function validateSingleJsonLd(value) {
  const errors = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return ['不是有效的 JSON-LD 对象（应为普通对象）'];
  }

  const context = value['@context'];
  if (context === undefined) {
    errors.push('缺少 @context');
  } else if (context !== SCHEMA_CONTEXT) {
    errors.push(`@context 必须是 ${SCHEMA_CONTEXT}（当前：${String(context)}）`);
  }

  const type = value['@type'];
  if (type === undefined || type === null) {
    errors.push('缺少 @type');
  } else if (typeof type !== 'string') {
    errors.push(`@type 必须是非空字符串（当前：${JSON.stringify(type)}）`);
  } else if (type.trim() === '') {
    errors.push('@type 不能为空字符串');
  }

  collectValueErrors(value, '', errors);
  return errors;
}

/**
 * 校验 JSON-LD 值（对象或对象数组）。
 * 检查项：是否对象、@context 是否为 https://schema.org、是否有 @type、
 * 是否存在空字符串值、是否存在 undefined 值。
 *
 * @param {unknown} value
 * @returns {{ok: boolean, errors: string[]}} errors 每条都是中文描述；数组按「第 N 项：」前缀定位
 */
export function validateJsonLd(value) {
  if (Array.isArray(value)) {
    const errors = [];
    value.forEach((item, index) => {
      for (const error of validateSingleJsonLd(item)) {
        errors.push(`第 ${index + 1} 项：${error}`);
      }
    });
    return { ok: errors.length === 0, errors };
  }
  const errors = validateSingleJsonLd(value);
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------- 打包

/**
 * 组装 llms.txt 的分组：服务、页面（按 page.section 归类），都没有时至少给出首页入口。
 * @param {{brand?: object, services?: object[], pages?: object[]}} input
 */
function buildSections({ brand = {}, services = [], pages = [] } = {}) {
  const groups = new Map();
  const pushLink = (groupTitle, link) => {
    if (!groups.has(groupTitle)) groups.set(groupTitle, []);
    groups.get(groupTitle).push(link);
  };

  // 有独立落地页的服务 → 逐条成链接；没有落地页的 → 合并成一行「服务范围」，
  // 绝不把 5 个服务全指到首页（那是 llms.txt 最常见的垃圾内容）
  const linkedServices = [];
  const unlinkedServiceNames = [];
  for (const service of services) {
    const name = text(service.name) || text(service.serviceType);
    if (!name) continue;
    if (text(service.url)) {
      linkedServices.push({ title: name, url: service.url, desc: text(service.description) });
    } else {
      unlinkedServiceNames.push(name);
    }
  }
  for (const link of linkedServices) pushLink('服务', link);
  if (unlinkedServiceNames.length) {
    pushLink('服务', {
      title: `服务范围：${unlinkedServiceNames.join('、')}`,
      desc: '具体交付与报价以官网说明为准',
    });
  }

  for (const page of pages) {
    pushLink(text(page.section) || '核心页面', {
      title: text(page.title) || text(page.url) || '页面',
      url: page.url ?? '/',
      desc: text(page.desc),
    });
  }

  if (!groups.size) {
    pushLink('核心页面', { title: '官网首页', url: '/' });
  }

  return [...groups.entries()].map(([title, links]) => ({ title, links }));
}

/** 把校验结果写成一条 warning（不通过也要留文件，方便用户直接看到问题） */
function addValidationWarning(warnings, fileName, value) {
  const { ok, errors } = validateJsonLd(value);
  if (!ok) warnings.push(`${fileName} 校验未通过：${errors.join('；')}`);
}

/**
 * 一次性生成整套 AEO 资产（CLI `geo aeo` 的出口）。
 *
 * @param {object} options
 * @param {{name?: string, city?: string, industry?: string, legalName?: string, urls?: string[], scope?: string}} [options.brand]
 * @param {string} [options.baseUrl] 站点根地址，缺省回退 https://example.com 并写 warning
 * @param {Array<{name: string, description?: string, url?: string}>} [options.services]
 * @param {Array<{q: string, a: string}>} [options.faqs]
 * @param {Array<{title: string, url: string, desc?: string, section?: string}>} [options.pages]
 * @returns {{files: Record<string,string>, jsonLd: {organization: object, services: object[], faq: object|null}, warnings: string[]}}
 */
export function buildAeoBundle({
  brand = {},
  baseUrl,
  services = [],
  faqs = [],
  pages = [],
} = {}) {
  const warnings = [];

  let origin = normalizeBaseUrl(baseUrl);
  if (!origin) {
    origin = DEFAULT_BASE_URL;
    warnings.push(`没有提供 baseUrl，已回退到 ${DEFAULT_BASE_URL}，请替换成站点真实域名`);
  }

  const serviceList = Array.isArray(services) ? services.filter(Boolean) : [];
  const faqList = Array.isArray(faqs) ? faqs.filter(Boolean) : [];
  const pageList = Array.isArray(pages) ? pages.filter(Boolean) : [];

  const llmsTxt = buildLlmsTxt({
    brand,
    baseUrl: origin,
    sections: buildSections({ brand, services: serviceList, pages: pageList }),
  });
  const robotsTxt = buildRobotsTxt({ baseUrl: origin });

  const organization = buildJsonLd('organization', { brand, baseUrl: origin });
  const serviceDocs = serviceList.map((service) =>
    buildJsonLd('service', { brand, baseUrl: origin, service }),
  );
  const faqDoc = faqList.length ? buildJsonLd('faq', { faqs: faqList }) : null;

  const files = {
    'llms.txt': llmsTxt,
    'robots.txt': robotsTxt,
    'schema-organization.json': prettyJson(organization),
  };
  addValidationWarning(warnings, 'schema-organization.json', organization);

  if (serviceDocs.length) {
    // 只有一项服务时输出对象，多项时输出数组（JSON-LD 两种都合法）
    const serviceJson = serviceDocs.length === 1 ? serviceDocs[0] : serviceDocs;
    files['schema-service.json'] = prettyJson(serviceJson);
    addValidationWarning(warnings, 'schema-service.json', serviceJson);
  } else {
    warnings.push('没有 services，未生成 schema-service.json');
  }

  if (faqDoc) {
    files['schema-faq.json'] = prettyJson(faqDoc);
    addValidationWarning(warnings, 'schema-faq.json', faqDoc);
  } else {
    warnings.push('没有 faqs，未生成 schema-faq.json');
  }

  return {
    files,
    jsonLd: { organization, services: serviceDocs, faq: faqDoc },
    warnings,
  };
}
