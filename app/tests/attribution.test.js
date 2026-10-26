// 测试：内容 → 引用归因（精确/前缀/自有域名/不误认）
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAttribution, renderAttributionMarkdown } from '../lib/attribution.js';

const rowsWith = (citations) => [
  { question: { id: 1, text: 'q1' }, answer: { engine: 'deepseek', citations }, judgment: { verdict: 'mentioned' } },
];

test('精确 URL 匹配：内容被引用一次', () => {
  const report = buildAttribution({
    brand: { name: 'X', urls: ['https://x.cn'] },
    rows: rowsWith([{ url: 'https://x.cn/blog/a' }, { url: 'https://zhihu.com/p/1' }]),
    contents: [{ id: 3, title: 'A 文章' }],
    publications: [{ contentId: 3, channel: '公众号', url: 'https://x.cn/blog/a' }],
  });
  assert.equal(report.byContent[0].citations, 1);
  assert.equal(report.totals.ownCitations, 1);
  assert.equal(report.totals.ownCitationsMatched, 1);
});

test('末尾斜杠 / http vs https 归一化后仍能匹配', () => {
  const report = buildAttribution({
    brand: { name: 'X', urls: ['https://x.cn'] },
    rows: rowsWith([{ url: 'https://x.cn/blog/a/' }]),
    publications: [{ contentId: 1, channel: '知乎', url: 'http://x.cn/blog/a' }],
  });
  assert.equal(report.byContent[0].citations, 1);
});

test('自有域名被引但没绑定内容 → 计入自有、不计内容', () => {
  const report = buildAttribution({
    brand: { name: 'X', urls: ['https://x.cn'] },
    rows: rowsWith([{ url: 'https://x.cn/other-page' }]),
    publications: [],
  });
  assert.equal(report.totals.ownCitations, 1);
  assert.equal(report.totals.ownCitationsMatched, 0);
  assert.equal(report.ownCitationsUnmatched[0].url, 'https://x.cn/other-page');
});

test('不按标题模糊匹配：同域名不同路径不算命中', () => {
  const report = buildAttribution({
    brand: { name: 'X', urls: ['https://x.cn'] },
    rows: rowsWith([{ url: 'https://x.cn/blog/b' }]),
    contents: [{ id: 3, title: 'A 文章' }],
    publications: [{ contentId: 3, channel: '公众号', url: 'https://x.cn/blog/a' }],
  });
  // 内容仍然登记（能看出「发了但没被引」），但命中数必须是 0
  assert.equal(report.totals.contents, 1);
  assert.equal(report.byContent[0].citations, 0);
});

test('多引擎命中会合并到同一内容', () => {
  const rows = [
    { question: { id: 1 }, answer: { engine: 'deepseek', citations: [{ url: 'https://x.cn/a' }] } },
    { question: { id: 2 }, answer: { engine: 'claude', citations: [{ url: 'https://x.cn/a' }] } },
  ];
  const report = buildAttribution({
    brand: { name: 'X', urls: ['https://x.cn'] },
    rows,
    publications: [{ contentId: 1, channel: '公众号', url: 'https://x.cn/a' }],
  });
  assert.equal(report.byContent[0].citations, 2);
  assert.deepEqual(report.byContent[0].engines.sort(), ['claude', 'deepseek']);
});

test('引用源 Top 按次数排序', () => {
  const report = buildAttribution({
    brand: { name: 'X', urls: [] },
    rows: rowsWith([{ url: 'https://a.com/1' }, { url: 'https://a.com/2' }, { url: 'https://b.com/1' }]),
  });
  assert.equal(report.topDomains[0].domain, 'a.com');
  assert.equal(report.topDomains[0].count, 2);
});

test('渲染：无命中时给明确下一步', () => {
  const md = renderAttributionMarkdown(buildAttribution({ brand: { name: 'X' }, rows: [], publications: [] }));
  assert.match(md, /没有任何「已发布 URL」被 AI 引用/);
});

test('空输入不崩', () => {
  const report = buildAttribution({});
  assert.equal(report.totals.citations, 0);
  assert.deepEqual(report.byContent, []);
});
