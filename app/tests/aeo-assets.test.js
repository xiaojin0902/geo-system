/**
 * tests/aeo-assets.test.js
 * AEO 资产生成的验收测试：llms.txt / robots.txt / JSON-LD。
 *
 * 守的是一条产品红线：**生成物必须是「能直接放到服务器上」的**，
 * 所以这里既测格式，也测「不许编造没有的事实」和「不许产生垃圾重复链接」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_CRAWLER_UA,
  buildAeoBundle,
  buildJsonLd,
  buildLlmsTxt,
  buildRobotsTxt,
  validateJsonLd,
} from '../lib/aeo-assets.js';

const brand = {
  name: '恒野',
  legalName: '芜湖恒野数字科技有限公司',
  city: '芜湖',
  industry: '内容代运营',
  scope: '全国线上交付',
  services: ['内容代运营', '起号陪跑'],
  urls: ['https://sanrenxing.cn'],
};

// ---------------------------------------------------------------- llms.txt

test('llms.txt：标准结构（H1 + 摘要 + 分组链接）', () => {
  const text = buildLlmsTxt({
    brand,
    baseUrl: 'https://sanrenxing.cn',
    summary: '芜湖内容代运营与 GEO 优化服务商',
    sections: [
      { title: '核心页面', links: [{ title: 'GEO 诊断', url: '/geo', desc: 'AI 可见性体检' }] },
    ],
  });
  assert.match(text, /^# 恒野/);
  assert.match(text, /> 芜湖内容代运营与 GEO 优化服务商/);
  assert.match(text, /## 核心页面/);
  assert.match(text, /- \[GEO 诊断\]\(https:\/\/sanrenxing\.cn\/geo\)：AI 可见性体检/);
  assert.ok(text.endsWith('\n'), '文件应以单个换行结尾');
});

test('llms.txt：相对路径自动拼 baseUrl，绝对 URL 原样保留', () => {
  const text = buildLlmsTxt({
    brand,
    baseUrl: 'https://a.cn',
    sections: [
      {
        title: '页面',
        links: [
          { title: '相对', url: '/x' },
          { title: '绝对', url: 'https://b.cn/y' },
        ],
      },
    ],
  });
  assert.match(text, /https:\/\/a\.cn\/x/);
  assert.match(text, /https:\/\/b\.cn\/y/);
});

test('llms.txt：没有 url 的条目输出纯说明行，不制造重复首页链接', () => {
  const text = buildLlmsTxt({
    brand,
    baseUrl: 'https://a.cn',
    sections: [{ title: '服务', links: [{ title: '服务范围：A、B', desc: '以官网为准' }] }],
  });
  assert.match(text, /- 服务范围：A、B：以官网为准/);
  assert.ok(!/\[服务范围：A、B\]\(https:\/\/a\.cn\/\)/.test(text), '不应退化成指向首页的链接');
});

test('llms.txt：品牌名里的方括号原样保留（不是 HTML 转义）', () => {
  const text = buildLlmsTxt({ brand: { name: '恒野[官方]' }, baseUrl: 'https://a.cn' });
  assert.match(text, /# 恒野\[官方\]/);
  assert.ok(!text.includes('&lt;'));
});

// ---------------------------------------------------------------- robots.txt

test('robots.txt：9 个 AI 爬虫全部显式放行 + sitemap', () => {
  const text = buildRobotsTxt({ baseUrl: 'https://a.cn' });
  for (const ua of AI_CRAWLER_UA) {
    assert.ok(text.includes(`User-agent: ${ua}`), `缺少 ${ua}`);
  }
  assert.equal((text.match(/Allow: \//g) ?? []).length >= AI_CRAWLER_UA.length, true);
  assert.match(text, /Sitemap: https:\/\/a\.cn\/sitemap\.xml/);
  assert.match(text, /^# 由.+生成 · 放行 AI 爬虫/);
});

test('robots.txt：disallowPaths 逐条写入且补前导斜杠', () => {
  const text = buildRobotsTxt({ baseUrl: 'https://a.cn', disallowPaths: ['admin', '/search'] });
  assert.match(text, /Disallow: \/admin/);
  assert.match(text, /Disallow: \/search/);
});

test('robots.txt：allowAICrawlers=false 时不出现 AI 爬虫段', () => {
  const text = buildRobotsTxt({ baseUrl: 'https://a.cn', allowAICrawlers: false });
  assert.ok(!text.includes('GPTBot'));
  assert.match(text, /User-agent: \*/);
});

// ---------------------------------------------------------------- JSON-LD

test('JSON-LD organization：结构正确，且不编造 telephone/email', () => {
  const node = buildJsonLd('organization', { brand, baseUrl: 'https://sanrenxing.cn' });
  assert.equal(node['@context'], 'https://schema.org');
  assert.equal(node['@type'], 'Organization');
  assert.equal(node.name, '恒野');
  assert.equal(node.legalName, '芜湖恒野数字科技有限公司');
  assert.equal(node.address.addressLocality, '芜湖');
  assert.equal(node.address.addressCountry, 'CN');
  assert.ok(!('telephone' in node), '没有电话就不能编');
  assert.ok(!('email' in node), '没有邮箱就不能编');
});

test('JSON-LD service：provider 指向组织，含 serviceType', () => {
  const node = buildJsonLd('service', {
    brand,
    baseUrl: 'https://sanrenxing.cn',
    service: { name: 'GEO 诊断', description: 'AI 可见性体检' },
  });
  assert.equal(node['@type'], 'Service');
  assert.equal(node.name, 'GEO 诊断');
  assert.equal(node.provider['@type'], 'Organization');
  assert.equal(node.provider.name, '恒野');
  // serviceType 描述「服务类型」，用服务名比用行业名更符合 schema.org 语义
  assert.equal(node.serviceType, 'GEO 诊断');
});

test('JSON-LD faq：Question/Answer 嵌套正确', () => {
  const node = buildJsonLd('faq', {
    faqs: [{ q: '恒野做什么？', a: '内容代运营与 GEO 优化。' }],
  });
  assert.equal(node['@type'], 'FAQPage');
  assert.equal(node.mainEntity.length, 1);
  assert.equal(node.mainEntity[0]['@type'], 'Question');
  assert.equal(node.mainEntity[0].name, '恒野做什么？');
  assert.equal(node.mainEntity[0].acceptedAnswer['@type'], 'Answer');
});

test('JSON-LD：未知类型抛中文错误', () => {
  assert.throws(() => buildJsonLd('unknown-kind', {}), /未知的 JSON-LD 类型/);
});

test('validateJsonLd：缺 @context / @type 与空字符串都能报出来', () => {
  assert.equal(validateJsonLd({ '@context': 'https://schema.org', '@type': 'Thing' }).ok, true);
  const bad = validateJsonLd({ '@type': 'Thing', name: '' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((item) => item.includes('@context')));
  assert.ok(bad.errors.some((item) => item.includes('name')));
  const badType = validateJsonLd({ '@context': 'https://schema.org' });
  assert.ok(badType.errors.some((item) => item.includes('@type')));
});

test('validateJsonLd：支持数组逐项校验', () => {
  const ok = validateJsonLd([
    { '@context': 'https://schema.org', '@type': 'Organization', name: 'A' },
    { '@context': 'https://schema.org', '@type': 'Service', name: 'B' },
  ]);
  assert.equal(ok.ok, true);
  const bad = validateJsonLd([{ '@context': 'https://schema.org', '@type': 'Organization', name: '' }]);
  assert.equal(bad.ok, false);
});

// ---------------------------------------------------------------- bundle

test('buildAeoBundle：文件齐全、JSON 可解析、@type 正确', () => {
  const bundle = buildAeoBundle({
    brand,
    baseUrl: 'https://sanrenxing.cn',
    services: [{ name: 'GEO 诊断' }, { name: '内容代运营', url: '/service' }],
    faqs: [{ q: '恒野在哪？', a: '芜湖。' }],
    pages: [{ title: '案例', url: '/case' }],
  });
  assert.deepEqual(
    Object.keys(bundle.files).sort(),
    ['llms.txt', 'robots.txt', 'schema-faq.json', 'schema-organization.json', 'schema-service.json'].sort(),
  );
  assert.equal(JSON.parse(bundle.files['schema-organization.json'])['@type'], 'Organization');
  assert.equal(JSON.parse(bundle.files['schema-faq.json'])['@type'], 'FAQPage');
  assert.equal(bundle.warnings.length, 0, `不应有警告，实际：${bundle.warnings.join('；')}`);
  // 有落地页的服务才成链接，其余合并成一行
  assert.match(bundle.files['llms.txt'], /\[内容代运营\]\(https:\/\/sanrenxing\.cn\/service\)/);
  assert.match(bundle.files['llms.txt'], /服务范围：GEO 诊断/);
});

test('buildAeoBundle：缺 baseUrl 时用占位域名并写 warning', () => {
  const bundle = buildAeoBundle({ brand });
  assert.match(bundle.files['llms.txt'], /example\.com/);
  assert.ok(bundle.warnings.some((item) => item.includes('baseUrl')));
});

test('buildAeoBundle：没有 services/faqs 时不生成对应文件并写 warning', () => {
  const bundle = buildAeoBundle({ brand, baseUrl: 'https://a.cn' });
  assert.ok(!('schema-service.json' in bundle.files));
  assert.ok(!('schema-faq.json' in bundle.files));
  assert.equal(bundle.warnings.filter((item) => item.includes('未生成')).length, 2);
});
