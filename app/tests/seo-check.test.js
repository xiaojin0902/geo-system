/**
 * tests/seo-check.test.js
 * 覆盖：健康页满分、title 缺失/过短/无关键词、description 缺失、H1 多个、
 * canonical 缺失、viewport 缺失、OG 不足、JSON-LD 缺失、图片 alt 覆盖率低、
 * 内链不足、正文过短、robots 全站 Disallow、sitemap 有条目/无、
 * fetchAndAnalyzeSeo 网络失败不抛异常、抓取成功、Markdown 各节齐全、纯函数确定性。
 *
 * 所有网络相关用例都通过 fetchImpl 注入伪造响应，不发真实网络请求。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SEO_CHECKS, analyzeSeo, fetchAndAnalyzeSeo, renderSeoMarkdown } from '../lib/seo-check.js';

const ORIGIN = 'https://healthy.test/';
const KEYWORD = 'GEO 诊断';

/* ------------------------------------------------------------------ *
 * 伪造站点素材
 * ------------------------------------------------------------------ */

const HEALTHY_ROBOTS = [
  'User-agent: *',
  'Allow: /',
  '',
  'Sitemap: https://healthy.test/sitemap.xml',
  '',
].join('\n');

const HEALTHY_SITEMAP = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  '  <url><loc>https://healthy.test/</loc></url>',
  '  <url><loc>https://healthy.test/service</loc></url>',
  '  <url><loc>https://healthy.test/case</loc></url>',
  '</urlset>',
].join('\n');

const HEALTHY_SITEMAP_URLS = [
  'https://healthy.test/',
  'https://healthy.test/service',
  'https://healthy.test/case',
];

/** 正文段落：重复三遍可稳定超过 300 字，同时覆盖诊断流程里的关键信息。 */
const PARAGRAPH =
  'GEO 诊断先从抓取链路开始：检查 robots.txt 是否放行主流搜索引擎，页面是否有唯一标题和描述，正文能否在不执行脚本的情况下读到。第二步看内容结构，确认 H1 与 H2 层级清楚，图片有 alt，内链能把用户带到服务页和案例页。第三步看外部信号，包括 sitemap、canonical、结构化数据和权威外链。每一步都给出可执行的修改清单，改完再复测一次，避免只写报告不落地。';

const DEFAULT_LINKS = [
  '<a href="/service">GEO 诊断服务</a>',
  '<a href="/case">客户案例</a>',
  '<a href="/contact">联系我们</a>',
  '<a href="https://developers.google.com/search/docs">Google 搜索文档</a>',
].join('');

const DEFAULT_IMAGES = [
  '<img src="/flow.jpg" alt="GEO 诊断流程图">',
  '<img src="/compare.jpg" alt="AI 引用对比图">',
].join('');

/**
 * 生成一份「该有的都有」的页面。
 * 通过覆盖参数可以只破坏一个检查项，方便断言单项扣分。
 * @param {object} [overrides]
 * @returns {string}
 */
function healthyHtml(overrides = {}) {
  const {
    title = '杭州GEO诊断｜3步提升AI引用率',
    description = '杭州恒野为本地企业提供 GEO 诊断：检查网站能否被 AI 引擎抓取与引用，给出可落地的优化清单，并跟踪引用变化，帮助企业用真实内容提升 AI 搜索可见性与获客效率。',
    h1 = '<h1>杭州GEO诊断：3步提升AI引用率</h1>',
    headings = '<h2>GEO 诊断是什么</h2><h2>3 步怎么做</h2>',
    canonical = '<link rel="canonical" href="https://healthy.test/">',
    viewport = '<meta name="viewport" content="width=device-width, initial-scale=1">',
    og = true,
    jsonLd = true,
    images = DEFAULT_IMAGES,
    links = DEFAULT_LINKS,
    body = `<p>${PARAGRAPH}</p><p>${PARAGRAPH}</p><p>${PARAGRAPH}</p>`,
  } = overrides;

  const head = [
    '<meta charset="utf-8">',
    title ? `<title>${title}</title>` : '',
    description ? `<meta name="description" content="${description}">` : '',
    canonical,
    viewport,
    og
      ? [
          '<meta property="og:title" content="杭州GEO诊断">',
          '<meta property="og:description" content="3步提升AI引用率">',
          '<meta property="og:image" content="https://healthy.test/og.jpg">',
        ].join('')
      : '',
    jsonLd
      ? '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"恒野","url":"https://healthy.test/"}</script>'
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
${head}
</head>
<body>
<main>
${h1}
${headings}
${body}
<nav>${links}</nav>
<figure>${images}</figure>
</main>
</body>
</html>`;
}

/**
 * 跑一次 analyzeSeo，默认输入健康站点，再按需覆盖。
 * @param {object} [overrides] healthyHtml 的覆盖参数
 * @param {object} [input] analyzeSeo 的额外覆盖参数
 * @returns {object}
 */
function run(overrides = {}, input = {}) {
  return analyzeSeo({
    url: ORIGIN,
    html: healthyHtml(overrides),
    headers: {},
    robots: HEALTHY_ROBOTS,
    sitemapUrls: HEALTHY_SITEMAP_URLS,
    keyword: KEYWORD,
    ...input,
  });
}

/** 按 id 取一条检查结果。 */
function checkOf(result, id) {
  const found = result.checks.find((check) => check.id === id);
  assert.ok(found, `缺少检查项：${id}`);
  return found;
}

/* ------------------------------------------------------------------ *
 * 伪造 fetch
 * ------------------------------------------------------------------ */

/** 伪造 Response：本模块只用到 status / headers / text()。 */
function fakeResponse(status, body, contentType = 'text/html; charset=utf-8') {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map([['content-type', contentType]]),
    text: async () => body,
  };
}

/** 记录调用地址的 fetch 桩。 */
function makeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  impl.calls = calls;
  return impl;
}

/* ------------------------------------------------------------------ *
 * 元数据与健康页面
 * ------------------------------------------------------------------ */

test('检查项元数据：12 项、id 唯一、权重与级别合法', () => {
  assert.equal(SEO_CHECKS.length, 12);
  assert.equal(new Set(SEO_CHECKS.map((check) => check.id)).size, 12);
  assert.deepEqual(
    SEO_CHECKS.map((check) => check.id),
    [
      'title',
      'description',
      'heading',
      'canonical',
      'viewport',
      'open-graph',
      'json-ld',
      'image-alt',
      'links',
      'content-length',
      'robots',
      'sitemap',
    ],
  );
  for (const check of SEO_CHECKS) {
    assert.ok(['blocker', 'warn', 'info'].includes(check.level));
    assert.ok([25, 8, 3].includes(check.weight));
  }
});

test('健康页面：12 项全过、满分 100、等级好、无行动建议', () => {
  const result = run();

  assert.equal(result.url, ORIGIN);
  assert.equal(result.score, 100);
  assert.equal(result.level, '好');
  assert.equal(result.checks.length, 12);
  assert.equal(
    result.checks.every((check) => check.ok === true),
    true,
  );
  assert.deepEqual(result.recommendations, []);

  assert.equal(result.metrics.titleLen, 17);
  assert.equal(result.metrics.h1Count, 1);
  assert.equal(result.metrics.h2Count, 2);
  assert.equal(result.metrics.imgCount, 2);
  assert.equal(result.metrics.imgNoAlt, 0);
  assert.ok(result.metrics.internalLinks >= 3);
  assert.equal(result.metrics.externalLinks, 1);
  assert.ok(result.metrics.wordCount >= 300);
  assert.equal(result.metrics.canonical, 'https://healthy.test/');
  assert.equal(result.metrics.ogTags, 3);
  assert.equal(result.metrics.jsonLdCount, 1);
  assert.equal(result.metrics.hasViewport, true);
  assert.equal(result.metrics.hasSitemap, true);
  assert.equal(result.metrics.robotsBlocking, false);
});

/* ------------------------------------------------------------------ *
 * title / description
 * ------------------------------------------------------------------ */

test('title 缺失：blocker 扣 25 分，修复建议给出可抄的标题模板', () => {
  const result = run({ title: '' });
  const check = checkOf(result, 'title');

  assert.equal(check.ok, false);
  assert.equal(check.level, 'blocker');
  assert.match(check.detail, /未找到 <title>/);
  assert.match(check.fix, /<title>/);
  assert.equal(result.score, 75);
  assert.equal(result.level, '一般');
});

test('title 过短：warn 扣 8 分，提示扩到 10-30 字', () => {
  const result = run({ title: 'GEO诊断' });
  const check = checkOf(result, 'title');

  assert.equal(check.ok, false);
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /只有 5 字/);
  assert.match(check.fix, /10-30 字/);
  assert.equal(result.score, 92);
  assert.equal(result.level, '好');
});

test('title 无关键词：info 扣 3 分，提示把关键词放进前半段', () => {
  const result = run({ title: '杭州AI搜索可见性提升指南' });
  const check = checkOf(result, 'title');

  assert.equal(check.ok, false);
  assert.equal(check.level, 'info');
  assert.match(check.detail, /没有出现关键词/);
  assert.match(check.fix, /前半段/);
  assert.equal(result.score, 97);
});

test('meta description 缺失：warn 扣 8 分，给出 50-160 字写作结构', () => {
  const result = run({ description: '' });
  const check = checkOf(result, 'description');

  assert.equal(check.ok, false);
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /未找到 <meta name="description">/);
  assert.match(check.fix, /50-160 字/);
  assert.equal(result.metrics.descLen, 0);
  assert.equal(result.score, 92);
});

/* ------------------------------------------------------------------ *
 * 标题层级 / canonical / viewport
 * ------------------------------------------------------------------ */

test('H1 多个：warn 扣 8 分，只保留一个 H1 其余改 H2', () => {
  const result = run({
    h1: '<h1>杭州GEO诊断</h1><h1>3步提升AI引用率</h1>',
  });
  const check = checkOf(result, 'heading');

  assert.equal(check.ok, false);
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /H1 有 2 个/);
  assert.match(check.fix, /只保留 1 个/);
  assert.equal(result.metrics.h1Count, 2);
  assert.equal(result.score, 92);
});

test('canonical 缺失：warn 扣 8 分，修复给出绝对地址示例', () => {
  const result = run({ canonical: '' });
  const check = checkOf(result, 'canonical');

  assert.equal(check.ok, false);
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /rel="canonical"/);
  assert.match(check.fix, /https:\/\/healthy\.test\//);
  assert.equal(result.metrics.canonical, '');
  assert.equal(result.score, 92);
});

test('viewport 缺失：warn 扣 8 分，修复给出移动端标准写法', () => {
  const result = run({ viewport: '' });
  const check = checkOf(result, 'viewport');

  assert.equal(check.ok, false);
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /未找到 viewport/);
  assert.match(check.fix, /width=device-width, initial-scale=1/);
  assert.equal(result.score, 92);
});

/* ------------------------------------------------------------------ *
 * OG / JSON-LD / 图片 / 链接 / 正文
 * ------------------------------------------------------------------ */

test('OG 标签不足（0/3）：warn 扣 8 分，补 og:title/description/image', () => {
  const result = run({ og: false });
  const check = checkOf(result, 'open-graph');

  assert.equal(check.ok, false);
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /0\/3/);
  assert.match(check.fix, /og:image/);
  assert.equal(result.metrics.ogTags, 0);
  assert.equal(result.score, 92);
});

test('JSON-LD 缺失：warn 扣 8 分，给出 Organization 可直接粘贴示例', () => {
  const result = run({ jsonLd: false });
  const check = checkOf(result, 'json-ld');

  assert.equal(check.ok, false);
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /未检测到 JSON-LD/);
  assert.match(check.fix, /application\/ld\+json/);
  assert.equal(result.metrics.jsonLdCount, 0);
  assert.equal(result.score, 92);
});

test('图片 alt 覆盖率低（2/3 缺失）：warn 扣 8 分，阈值 30%', () => {
  const result = run({
    images:
      '<img src="/a.jpg"><img src="/b.jpg" alt="AI 引用对比图"><img src="/c.jpg">',
  });
  const check = checkOf(result, 'image-alt');

  assert.equal(check.ok, false);
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /2\/3 张图片缺 alt/);
  assert.match(check.detail, /67%/);
  assert.match(check.fix, /alt="杭州GEO诊断报告示例"/);
  assert.equal(result.metrics.imgCount, 3);
  assert.equal(result.metrics.imgNoAlt, 2);
  assert.equal(result.score, 92);
});

test('内链不足（1 条）：warn 扣 8 分，提示补站内描述性锚文本', () => {
  const result = run({
    links:
      '<a href="/service">GEO 诊断服务</a><a href="https://developers.google.com/search/docs">Google 搜索文档</a>',
  });
  const check = checkOf(result, 'links');

  assert.equal(check.ok, false);
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /内链 1 条/);
  assert.match(check.fix, /补 \d+ 条以上站内链接/);
  assert.equal(result.metrics.internalLinks, 1);
  assert.equal(result.metrics.externalLinks, 1);
  assert.equal(result.score, 92);
});

test('正文过短：warn 扣 8 分，给出还需补多少字', () => {
  const result = run({ body: '<p>太短了。</p>' });
  const check = checkOf(result, 'content-length');

  assert.equal(check.ok, false);
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /低于 300 字/);
  assert.match(check.fix, /补 \d+ 字/);
  assert.ok(result.metrics.wordCount < 300);
  assert.equal(result.score, 92);
});

/* ------------------------------------------------------------------ *
 * robots / sitemap
 * ------------------------------------------------------------------ */

test('robots 全站 Disallow：blocker 扣 25 分、分数 75、排在进行建议第一位', () => {
  const result = run(
    {},
    {
      robots: ['User-agent: *', 'Disallow: /', ''].join('\n'),
    },
  );
  const check = checkOf(result, 'robots');

  assert.equal(check.ok, false);
  assert.equal(check.level, 'blocker');
  assert.match(check.detail, /Disallow: \//);
  assert.match(check.fix, /Allow: \//);
  assert.equal(result.metrics.robotsBlocking, true);
  assert.equal(result.score, 75);
  assert.equal(result.level, '一般');
  assert.match(result.recommendations[0], /Disallow: \//);
});

test('sitemap 有条目：检查通过；没有条目：warn 扣 8 分', () => {
  const good = run();
  assert.equal(checkOf(good, 'sitemap').ok, true);
  assert.equal(good.metrics.hasSitemap, true);

  const bad = run({}, { sitemapUrls: [] });
  const check = checkOf(bad, 'sitemap');
  assert.equal(check.ok, false);
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /未拿到可用的 sitemap/);
  assert.match(check.fix, /\/sitemap\.xml/);
  assert.equal(bad.metrics.hasSitemap, false);
  assert.equal(bad.score, 92);
});

/* ------------------------------------------------------------------ *
 * 抓取
 * ------------------------------------------------------------------ */

test('fetchAndAnalyzeSeo 网络失败：返回 ok:false + error，不抛异常', async () => {
  const fetchImpl = makeFetch(() => {
    throw new Error('ENOTFOUND healthy.test');
  });

  let result;
  await assert.doesNotReject(async () => {
    result = await fetchAndAnalyzeSeo(ORIGIN, { fetchImpl, keyword: KEYWORD, timeoutMs: 100 });
  });

  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  assert.match(result.error, /ENOTFOUND/);
  assert.equal(result.url, ORIGIN);
});

test('fetchAndAnalyzeSeo 成功：抓主页 + robots + sitemap，返回完整体检结果', async () => {
  const fetchImpl = makeFetch((url) => {
    if (url.endsWith('/robots.txt')) return fakeResponse(200, HEALTHY_ROBOTS, 'text/plain');
    if (url.endsWith('/sitemap.xml')) return fakeResponse(200, HEALTHY_SITEMAP, 'application/xml');
    return fakeResponse(200, healthyHtml());
  });

  const result = await fetchAndAnalyzeSeo(ORIGIN, { fetchImpl, keyword: KEYWORD });

  assert.equal(result.ok, true);
  assert.equal(result.score, 100);
  assert.equal(result.level, '好');
  assert.equal(result.metrics.hasSitemap, true);
  assert.equal(result.metrics.robotsBlocking, false);
  assert.deepEqual(
    fetchImpl.calls.map((call) => call.url).sort(),
    [
      'https://healthy.test/',
      'https://healthy.test/robots.txt',
      'https://healthy.test/sitemap.xml',
    ],
  );
  assert.equal(fetchImpl.calls.every((call) => call.init && call.init.signal), true);
});

/* ------------------------------------------------------------------ *
 * 短视频 SEO / 渲染 / 确定性
 * ------------------------------------------------------------------ */

test('短视频 SEO：标题 ≤18 字、标签 5-8 个、封面 ≤12 字、三条建议', () => {
  const result = run();
  const video = result.videoSeo;

  assert.ok(video.titleLen > 0 && video.titleLen <= 18);
  assert.ok(video.hashtagCount >= 5 && video.hashtagCount <= 8);
  assert.ok(Array.from(video.coverHint).length > 0);
  assert.ok(Array.from(video.coverHint).length <= 12);
  assert.equal(video.tips.length, 3);
  assert.match(video.tips[0], /标题模板/);
  assert.match(video.tips[1], /话题标签/);
  assert.match(video.tips[2], /封面文案/);
});

test('renderSeoMarkdown：五个章节、明细表头、指标与建议齐全', () => {
  const markdown = renderSeoMarkdown(run());

  for (const heading of ['## SEO 评分', '## 检查明细', '## 指标', '## 短视频 SEO', '## 行动建议']) {
    assert.ok(markdown.includes(heading), `缺少章节：${heading}`);
  }
  assert.match(markdown, /\| 项 \| 结果 \| 说明 \| 修复 \|/);
  assert.match(markdown, /100 \/ 100/);
  assert.match(markdown, /标题长度：\d+ 字/);
  assert.match(markdown, /话题标签：\d+ 个/);
  assert.match(markdown, /封面文案：/);
  assert.match(markdown, /12 项检查全部通过/);
});

test('renderSeoMarkdown：检查明细会把 blocker/warn 展示为阻断/提醒', () => {
  const markdown = renderSeoMarkdown(
    run({ title: 'GEO诊断' }, { robots: 'User-agent: *\nDisallow: /\n' }),
  );

  assert.match(markdown, /\| title 标题 \| 提醒 \|/);
  assert.match(markdown, /\| robots\.txt \| 阻断 \|/);
  assert.match(markdown, /67 \/ 100/);
});

test('renderSeoMarkdown：抓取失败输入也输出评分节，不抛异常', () => {
  const markdown = renderSeoMarkdown({
    ok: false,
    url: ORIGIN,
    error: '网络请求失败：ENOTFOUND',
  });

  assert.ok(markdown.includes('## SEO 评分'));
  assert.match(markdown, /抓取页面失败/);
  assert.match(markdown, /ENOTFOUND/);
});

test('纯函数确定性：同一输入连续两次结果完全一致，且不修改输入', () => {
  const input = {
    url: ORIGIN,
    html: healthyHtml({ title: 'GEO诊断', og: false }),
    headers: { 'x-robots-tag': 'noindex' },
    robots: 'User-agent: *\nDisallow: /\n',
    sitemapUrls: [],
    keyword: KEYWORD,
  };
  const snapshot = JSON.stringify(input);

  const first = analyzeSeo(input);
  const second = analyzeSeo(input);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(first.metrics.robotsBlocking, true);
});

/* ------------------------------------------------------------------ *
 * 组合场景（给 lead 的样例口径）
 * ------------------------------------------------------------------ */

test('组合问题：title 过长 + 无 description + H1 缺失 + robots Disallow', () => {
  const result = run(
    {
      title: '杭州GEO诊断｜3步提升AI引用率，附本地企业可执行的完整清单与复测模板',
      description: '',
      h1: '',
    },
    {
      robots: 'User-agent: *\nDisallow: /\n',
    },
  );

  assert.equal(result.score, 51);
  assert.equal(result.level, '一般');
  assert.equal(result.checks.filter((check) => !check.ok).length, 4);
  assert.equal(checkOf(result, 'title').level, 'warn');
  assert.equal(checkOf(result, 'description').level, 'warn');
  assert.equal(checkOf(result, 'heading').level, 'warn');
  assert.equal(checkOf(result, 'robots').level, 'blocker');
  assert.equal(result.checks.filter((check) => check.level === 'blocker' && !check.ok).length, 1);

  // 建议按 blocker → warn 排序：robots 第一，title 第二，description 第三。
  assert.match(result.recommendations[0], /Disallow: \//);
  assert.match(result.recommendations[1], /压到 30 字内/);
  assert.match(result.recommendations[2], /meta name="description"/);
});
