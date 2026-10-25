/**
 * tests/audit-site.test.js
 * 覆盖：健康站点满分、robots 屏蔽 GPTBot、User-agent: * + Disallow: / 全站封禁、
 * noindex、AI 爬虫 UA 被 403、JS-only 页面、llms.txt 存在/缺失、sitemap 解析/缺失、
 * robots.txt 被 WAF 403、URL 不带协议补 https、https 回落 http、完全不可达、红线合并只扣一次。
 *
 * 所有用例通过 options.fetchImpl 注入伪造响应，不发真实网络请求。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { AI_CRAWLERS, DEDUCTIONS, auditSite, normalizeUrl } from '../lib/audit-site.js';

const ORIGIN = 'https://healthy.test';

/* ------------------------------------------------------------------ *
 * 伪造站点素材
 * ------------------------------------------------------------------ */

const HEALTHY_ROBOTS = [
  'User-agent: *',
  'Allow: /',
  '',
  'User-agent: GPTBot',
  'Allow: /',
  '',
  'Sitemap: https://healthy.test/sitemap.xml',
  '',
].join('\n');

const HEALTHY_LLMS = [
  '# 恒野 GEO',
  '',
  '- [AI 可见性诊断](https://healthy.test/service)：面向杭州本地企业的 GEO 体检',
  '- [案例](https://healthy.test/case)：本地服务商的 AI 引用对比',
  '- [联系我们](https://healthy.test/contact)：预约一次免费站点体检',
  '',
].join('\n');

const HEALTHY_SITEMAP = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  '  <url><loc>https://healthy.test/</loc></url>',
  '  <url><loc>https://healthy.test/service</loc></url>',
  '</urlset>',
].join('\n');

/** 一套"该有的都有"的页面：正文 > 200 字、2 个 JSON-LD、description + canonical。 */
function healthyHtml(extraHead = '') {
  const paragraph =
    '我们要检查网站的 robots.txt、llms.txt、sitemap.xml、结构化数据与渲染方式，判断 ChatGPT、Perplexity、豆包这些 AI 引擎能否抓到正文并正确引用。';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>恒野 GEO｜杭州 AI 可见性诊断</title>
<meta name="description" content="杭州恒野提供面向本地企业的 GEO 诊断：检查网站能否被 ChatGPT、Perplexity、豆包等 AI 引擎抓取与引用。">
<link rel="canonical" href="https://healthy.test/">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"恒野","url":"https://healthy.test/"}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Service","name":"GEO 诊断"}]}</script>
${extraHead}
</head>
<body>
<h1>恒野 GEO 诊断</h1>
<p>${paragraph.repeat(4)}</p>
</body>
</html>`;
}

/** 纯前端渲染的页面：6 个 script、正文只有一个空容器。 */
const JS_ONLY_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>后台应用</title>
<meta name="description" content="这是一个需要 JavaScript 才能渲染的前端应用。">
<link rel="canonical" href="https://healthy.test/">
<script src="/runtime.js"></script>
<script src="/vendor.js"></script>
<script src="/main.js"></script>
<script src="/chunk-1.js"></script>
<script src="/chunk-2.js"></script>
<script src="/analytics.js"></script>
</head>
<body><div id="root"></div></body>
</html>`;

/* ------------------------------------------------------------------ *
 * 伪造 fetch
 * ------------------------------------------------------------------ */

/** 伪造 Response：audit-site 只用到 status / text()。 */
function fakeResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map(),
    text: async () => body,
  };
}

/**
 * 把 handler 包成 fetchImpl，同时记录每次调用，便于断言"用了哪个 URL / 哪个 UA"。
 * handler 返回 { status, body }；返回字符串 'throw' 表示模拟网络失败。
 */
function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = init.headers || {};
    const userAgent = String(headers['user-agent'] ?? headers['User-Agent'] ?? '');
    const call = { url: url.toString(), pathname: url.pathname, protocol: url.protocol, userAgent };
    calls.push(call);

    const outcome = handler({ url, pathname: url.pathname, protocol: url.protocol, userAgent });
    if (outcome === 'throw') throw new Error('模拟网络错误：ECONNREFUSED');

    const { status = 200, body = '' } = outcome ?? {};
    return fakeResponse(status, body);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** 健康站点的默认路由，可按项覆盖（robots/llms/sitemap/html 或 httpsFails / blockUa）。 */
function healthyHandler(overrides = {}) {
  const routes = {
    robots: { status: 200, body: HEALTHY_ROBOTS },
    llms: { status: 200, body: HEALTHY_LLMS },
    sitemap: { status: 200, body: HEALTHY_SITEMAP },
    html: { status: 200, body: healthyHtml() },
    httpsFails: false,
    blockUa: null,
    ...overrides,
  };

  return ({ pathname, protocol, userAgent }) => {
    if (routes.httpsFails && protocol === 'https:') return 'throw';
    if (routes.blockUa && routes.blockUa(userAgent)) return { status: 403, body: 'Forbidden' };
    if (pathname === '/robots.txt') return routes.robots;
    if (pathname === '/llms.txt') return routes.llms;
    if (pathname === '/sitemap.xml') return routes.sitemap;
    return routes.html;
  };
}

function findingIds(result) {
  return result.findings.map((finding) => finding.id);
}

function findingOf(result, id) {
  return result.findings.find((finding) => finding.id === id);
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

test('完全健康的站点：满分、无 blocker、各字段结构正确', async () => {
  const fetchImpl = makeFetch(healthyHandler());
  const result = await auditSite(ORIGIN, { fetchImpl });

  assert.equal(result.url, 'https://healthy.test');
  assert.equal(result.reachable, true);
  assert.deepEqual(result.https, { ok: true, status: 200, error: null });

  // robots：明确放行，没有任何 AI 爬虫被列进 blocked
  assert.equal(result.robots.status, 200);
  assert.equal(result.robots.found, true);
  assert.equal(result.robots.disallowsAllAI, false);
  assert.deepEqual(result.robots.blocked, []);
  assert.match(result.robots.raw, /Sitemap: https:\/\/healthy\.test\/sitemap\.xml/);

  // 9 个 AI 爬虫 UA 全部 200、全部未封禁
  assert.equal(result.aiCrawlers.length, AI_CRAWLERS.length);
  assert.deepEqual(
    result.aiCrawlers.map((row) => row.status),
    AI_CRAWLERS.map(() => 200),
  );
  assert.equal(result.aiCrawlers.every((row) => row.blocked === false), true);

  // 供给：llms.txt 3 条链接、sitemap 2 个 loc
  assert.deepEqual(result.llmsTxt, { status: 200, found: true, bytes: Buffer.byteLength(HEALTHY_LLMS), urls: 3 });
  assert.deepEqual(result.sitemap, { status: 200, found: true, urls: 2 });

  // 语义：2 个 JSON-LD，类型能解析出来
  assert.equal(result.schema.jsonLdCount, 2);
  assert.deepEqual(result.schema.types.sort(), ['Organization', 'Service']);

  // meta
  assert.equal(result.meta.title, '恒野 GEO｜杭州 AI 可见性诊断');
  assert.equal(result.meta.description.length > 0, true);
  assert.equal(result.meta.canonical, 'https://healthy.test/');
  assert.equal(result.meta.noindex, false);
  assert.equal(result.meta.lang, 'zh-CN');

  // 渲染：正文够长，不是 JS-only
  assert.equal(result.render.likelyJsOnly, false);
  assert.ok(result.render.textChars > 200);
  assert.ok(result.render.scriptTags >= 2);

  assert.equal(result.score, 100);
  assert.equal(result.level, '好');
  assert.deepEqual(result.findings, []);
});

test('robots.txt 只屏蔽 GPTBot：命中 blocked 清单、扣 35 分、其余爬虫不受影响', async () => {
  const fetchImpl = makeFetch(
    healthyHandler({
      robots: {
        status: 200,
        body: 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n',
      },
    }),
  );
  const result = await auditSite(ORIGIN, { fetchImpl });

  assert.equal(result.robots.disallowsAllAI, false);
  assert.deepEqual(result.robots.blocked, [
    { crawler: 'GPTBot', rule: 'User-agent: GPTBot / Disallow: /' },
  ]);

  const gptBot = result.aiCrawlers.find((row) => row.id === 'GPTBot');
  assert.equal(gptBot.blocked, false); // robots 屏蔽不影响 UA 实测的 HTTP 状态

  assert.equal(result.score, 100 - DEDUCTIONS.aiBlocked);
  assert.equal(result.level, '一般');
  const finding = findingOf(result, 'robots-blocks-ai');
  assert.equal(finding.level, 'blocker');
  assert.match(finding.detail, /GPTBot/);
  assert.match(finding.fix, /robots\.txt/);
});

test('robots.txt 用 User-agent: * + Disallow: /：disallowsAllAI 为 true 且全部爬虫被列', async () => {
  const fetchImpl = makeFetch(
    healthyHandler({ robots: { status: 200, body: 'User-agent: *\nDisallow: /\n' } }),
  );
  const result = await auditSite(ORIGIN, { fetchImpl });

  assert.equal(result.robots.disallowsAllAI, true);
  assert.equal(result.robots.blocked.length, AI_CRAWLERS.length);
  assert.equal(result.robots.blocked.every((item) => item.rule === 'User-agent: * / Disallow: /'), true);

  assert.equal(result.score, 100 - DEDUCTIONS.aiBlocked);
  const finding = findingOf(result, 'robots-blocks-ai');
  assert.equal(finding.level, 'blocker');
  assert.match(finding.detail, /Disallow: \//);
});

test('noindex：blocker 扣 35 分，并给出可执行的 meta 修复方案', async () => {
  const fetchImpl = makeFetch(
    healthyHandler({ html: { status: 200, body: healthyHtml('<meta name="robots" content="noindex, nofollow">') } }),
  );
  const result = await auditSite(ORIGIN, { fetchImpl });

  assert.equal(result.meta.noindex, true);
  assert.equal(result.score, 100 - DEDUCTIONS.aiBlocked);
  assert.equal(result.level, '一般');

  const finding = findingOf(result, 'noindex');
  assert.equal(finding.level, 'blocker');
  assert.match(finding.fix, /index,follow/);
});

test('AI 爬虫 UA 被 403：blocked 清单与扣分都对，普通 UA 仍 200', async () => {
  const fetchImpl = makeFetch(
    healthyHandler({ blockUa: (userAgent) => /GPTBot|OAI-SearchBot/.test(userAgent) }),
  );
  const result = await auditSite(ORIGIN, { fetchImpl });

  assert.deepEqual(
    result.aiCrawlers.filter((row) => row.blocked).map((row) => row.id),
    ['GPTBot', 'OAI-SearchBot'],
  );
  assert.equal(
    result.aiCrawlers.filter((row) => row.blocked).every((row) => row.status === 403),
    true,
  );

  assert.equal(result.score, 100 - DEDUCTIONS.uaBlocked);
  const finding = findingOf(result, 'ai-ua-blocked');
  assert.equal(finding.level, 'blocker');
  assert.match(finding.fix, /map \$http_user_agent/);
});

test('JS-only 页面：likelyJsOnly 为 true，扣 20 分并列 blocker', async () => {
  const fetchImpl = makeFetch(healthyHandler({ html: { status: 200, body: JS_ONLY_HTML } }));
  const result = await auditSite(ORIGIN, { fetchImpl });

  assert.equal(result.render.scriptTags, 6);
  assert.ok(result.render.textChars < 200);
  assert.equal(result.render.likelyJsOnly, true);
  assert.equal(result.schema.jsonLdCount, 0);

  // 100 - 20（JS-only）- 5（无 JSON-LD）= 75
  assert.equal(result.score, 100 - DEDUCTIONS.jsOnly - DEDUCTIONS.noJsonLd);

  const finding = findingOf(result, 'js-only');
  assert.equal(finding.level, 'blocker');
  assert.match(finding.fix, /SSR|预渲染/);
});

test('llms.txt 存在时统计字节与链接数；缺失时扣 5 分并给 warn', async () => {
  const present = await auditSite(ORIGIN, { fetchImpl: makeFetch(healthyHandler()) });
  assert.equal(present.llmsTxt.found, true);
  assert.equal(present.llmsTxt.urls, 3);
  assert.ok(present.llmsTxt.bytes > 0);
  assert.equal(findingOf(present, 'no-llms-txt'), undefined);

  const missing = await auditSite(ORIGIN, {
    fetchImpl: makeFetch(healthyHandler({ llms: { status: 404, body: 'Not Found' } })),
  });
  assert.deepEqual(missing.llmsTxt, { status: 404, found: false, bytes: 0, urls: 0 });
  assert.equal(missing.score, 100 - DEDUCTIONS.noLlmsTxt);

  const finding = findingOf(missing, 'no-llms-txt');
  assert.equal(finding.level, 'warn');
  assert.match(finding.fix, /llms\.txt/);
});

test('sitemap.xml：解析 <loc> 数量；缺失时扣 5 分并给 warn', async () => {
  const present = await auditSite(ORIGIN, { fetchImpl: makeFetch(healthyHandler()) });
  assert.deepEqual(present.sitemap, { status: 200, found: true, urls: 2 });

  // 200 的 HTML 错误页不能被误判为 sitemap
  const htmlError = await auditSite(ORIGIN, {
    fetchImpl: makeFetch(healthyHandler({ sitemap: { status: 200, body: '<html><body>404</body></html>' } })),
  });
  assert.equal(htmlError.sitemap.found, false);
  assert.equal(htmlError.sitemap.urls, 0);
  assert.equal(htmlError.score, 100 - DEDUCTIONS.noSitemap);
});

test('URL 不带协议时自动补 https://，并规范化返回值', async () => {
  const fetchImpl = makeFetch(healthyHandler());
  const result = await auditSite('healthy.test', { fetchImpl });

  assert.equal(result.url, 'https://healthy.test');
  assert.equal(fetchImpl.calls[0].url.startsWith('https://'), true);

  assert.equal(normalizeUrl('healthy.test'), 'https://healthy.test');
  assert.equal(normalizeUrl(' HTTPS://A.com/ '), 'https://a.com');
  assert.equal(normalizeUrl('http://a.com/blog/'), 'http://a.com/blog/');
  assert.throws(() => normalizeUrl('   '), /url 不能为空/);
  assert.throws(() => normalizeUrl('ftp://a.com'), /只支持 http\/https/);
});

test('robots.txt 被 WAF 403：按 blocker 处理，扣 35 分', async () => {
  const fetchImpl = makeFetch(healthyHandler({ robots: { status: 403, body: 'Forbidden' } }));
  const result = await auditSite(ORIGIN, { fetchImpl });

  assert.deepEqual(result.robots, {
    status: 403,
    found: false,
    raw: 'Forbidden',
    disallowsAllAI: false,
    blocked: [],
  });
  assert.equal(result.score, 100 - DEDUCTIONS.aiBlocked);

  const finding = findingOf(result, 'robots-waf');
  assert.equal(finding.level, 'blocker');
  assert.match(finding.fix, /robots\.txt/);
});

test('https 打不开、回落 http：可达但总分封顶 20，列 https blocker', async () => {
  const fetchImpl = makeFetch(healthyHandler({ httpsFails: true }));
  const result = await auditSite(ORIGIN, { fetchImpl });

  assert.equal(result.reachable, true);
  assert.equal(result.https.ok, false);
  assert.equal(result.https.status, null);
  assert.match(result.https.error, /网络错误/);
  assert.equal(result.url, 'http://healthy.test');

  assert.ok(result.score <= 20);
  assert.equal(result.score, 20);
  assert.equal(result.level, '严重');
  assert.equal(findingOf(result, 'https-unavailable').level, 'blocker');

  // 资源探测也应跟着回落到 http
  assert.equal(
    fetchImpl.calls.some((call) => call.url === 'http://healthy.test/robots.txt'),
    true,
  );
});

test('完全不可达：reachable 为 false、评分落进 0-20 区间、只有 unreachable blocker', async () => {
  const fetchImpl = makeFetch(() => 'throw');
  const result = await auditSite('https://unreachable.test', { fetchImpl });

  assert.equal(result.reachable, false);
  assert.equal(result.url, 'https://unreachable.test');
  assert.equal(result.https.ok, false);
  assert.equal(result.robots.status, null);
  assert.equal(result.robots.found, false);
  assert.equal(result.aiCrawlers.every((row) => row.blocked === false), true);

  assert.equal(result.score, 0);
  assert.equal(result.level, '严重');
  assert.deepEqual(findingIds(result), ['unreachable']);
  assert.equal(result.findings[0].level, 'blocker');
});

test('noindex 与 robots 全站封禁同时出现：同一条红线只扣一次 35 分', async () => {
  const fetchImpl = makeFetch(
    healthyHandler({
      robots: { status: 200, body: 'User-agent: *\nDisallow: /\n' },
      html: { status: 200, body: healthyHtml('<meta name="robots" content="noindex">') },
    }),
  );
  const result = await auditSite(ORIGIN, { fetchImpl });

  assert.equal(result.score, 100 - DEDUCTIONS.aiBlocked);
  assert.deepEqual(findingIds(result), ['robots-blocks-ai', 'noindex']);
});
