/**
 * tests/analytics.test.js
 * 可见度分析的验收测试。
 *
 * 这些断言守的是「报告里的数字能不能被客户复算」：
 * 份额、占比、位置权重都必须是可推导的确定值，不能是感觉。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeRun,
  gradeEvidence,
  brandNames,
  classifyDomain,
  domainOf,
  matchBrand,
  renderInsightsMarkdown,
  splitSentences,
} from '../lib/analytics.js';

const brand = {
  name: '恒野',
  legalName: '芜湖恒野数字科技有限公司',
  aliases: ['恒野数字'],
  competitors: ['宇典科技', '力行文化'],
  urls: ['https://hengye.example.com'],
};

function row({ engine = 'deepseek', verdict = 'mentioned', text = '', citations = [], status = 'ok' } = {}) {
  return {
    question: { id: 1, text: '芜湖有哪些内容代运营公司？' },
    answer: { engine, text, citations, status },
    judgment: status === 'ok' ? { verdict } : null,
  };
}

test('splitSentences：按中英文标点切句并过滤空串', () => {
  assert.deepEqual(splitSentences('第一句。第二句！第三句？'), ['第一句', '第二句', '第三句']);
  assert.deepEqual(splitSentences(''), []);
});

test('domainOf：去 www、小写、非法 URL 返回空串', () => {
  assert.equal(domainOf('https://WWW.Zhihu.com/a'), 'zhihu.com');
  assert.equal(domainOf('not a url'), '');
  assert.equal(domainOf(null), '');
});

test('classifyDomain：社媒/媒体/百科/搜索/其他 五类分对', () => {
  assert.equal(classifyDomain('zhihu.com').type, 'social');
  assert.equal(classifyDomain('mp.weixin.qq.com').type, 'social');
  assert.equal(classifyDomain('sohu.com').type, 'media');
  assert.equal(classifyDomain('baike.baidu.com').type, 'encyclopedia');
  assert.equal(classifyDomain('baidu.com').type, 'search');
  assert.equal(classifyDomain('some-company.cn').type, 'other');
  // 子域名 / 演示域名靠首段标签识别
  assert.equal(classifyDomain('zhuanlan.zhihu.com').type, 'social');
  assert.equal(classifyDomain('douyin.example.com').type, 'social');
  assert.equal(classifyDomain('baike.example.com').type, 'encyclopedia');
  assert.equal(classifyDomain('news.example.com').type, 'media');
});

test('matchBrand / brandNames：正式名、全称、别名都能命中', () => {
  assert.deepEqual(brandNames(brand), ['恒野', '芜湖恒野数字科技有限公司', '恒野数字']);
  assert.equal(matchBrand('推荐恒野数字科技', brand), '恒野');
  assert.equal(matchBrand('完全无关的一段话', brand), null);
});

test('analyzeRun：空输入不崩，返回全零结构', () => {
  const insights = analyzeRun({ brand, rows: [] });
  assert.equal(insights.sample.total, 0);
  assert.equal(insights.sample.mentionRate, 0);
  assert.equal(insights.citations.total, 0);
  assert.deepEqual(insights.opportunities, []);
});

test('analyzeRun：提及率只按有效回答算（拒答/引擎错误不进分母）', () => {
  const rows = [
    row({ text: '推荐恒野，专业靠谱。', verdict: 'mentioned' }),
    row({ text: '未提及品牌的一段话。', verdict: 'not_mentioned' }),
    row({ status: 'refused', text: '抱歉无法回答。', verdict: null }),
    row({ status: 'engine_error', text: '', verdict: null }),
  ];
  const insights = analyzeRun({ brand, rows });
  assert.equal(insights.sample.total, 4);
  assert.equal(insights.sample.ok, 2, '只有 2 条 ok 进分母');
  assert.equal(insights.sample.mentioned, 1);
  assert.equal(insights.sample.mentionRate, 0.5);
});

test('analyzeRun：篇幅占比 = 品牌句子字数 / 回答总字数', () => {
  // 两句：第一句含品牌 6 字，第二句 5 字 → 6/11
  const insights = analyzeRun({
    brand,
    rows: [row({ text: '恒野这家不错。其他都不行。' })],
  });
  assert.equal(insights.exposure.avgWordShare, Math.round((6 / 11) * 10000) / 10000);
});

test('analyzeRun：位置权重越靠前越高（首句命中为 1，末句衰减）', () => {
  const first = analyzeRun({ brand, rows: [row({ text: '恒野很好。其他一般。' })] });
  const last = analyzeRun({ brand, rows: [row({ text: '其他一般。恒野很好。' })] });
  assert.ok(first.exposure.avgPositionWeight > last.exposure.avgPositionWeight);
  assert.equal(first.exposure.firstSentenceRate, 1);
  assert.equal(last.exposure.firstSentenceRate, 0);
});

test('analyzeRun：引用源按域名聚合、识别自有站点、给出机会缺口', () => {
  const rows = [
    row({
      text: '推荐恒野。',
      citations: [
        { title: '知乎讨论', url: 'https://zhihu.com/p/1' },
        { title: '知乎另一篇', url: 'https://www.zhihu.com/p/2' },
        { title: '恒野官网', url: 'https://hengye.example.com/service' },
        { title: '小红书笔记', url: 'https://xiaohongshu.com/note/1' },
      ],
    }),
  ];
  const insights = analyzeRun({ brand, rows });
  assert.equal(insights.citations.total, 4);
  assert.equal(insights.citations.uniqueDomains, 3);

  const zhihu = insights.citations.byDomain.find((item) => item.domain === 'zhihu.com');
  assert.equal(zhihu.count, 2);
  assert.equal(zhihu.type, 'social');
  assert.equal(zhihu.share, 0.5);

  const own = insights.citations.byDomain.find((item) => item.type === 'own');
  assert.equal(own.domain, 'hengye.example.com');
  assert.equal(insights.citations.ownShare, 0.25);

  // 机会缺口只列非自有域名，且按次数排序
  assert.deepEqual(
    insights.opportunities.map((item) => item.domain),
    ['zhihu.com', 'xiaohongshu.com'],
  );
  assert.match(insights.opportunities[0].reason, /被 AI 引用 2 次/);
});

test('analyzeRun：竞品 SoV 份额加总为 1（本品牌 + 竞品）', () => {
  const rows = [
    row({ text: '推荐恒野，另外宇典科技也可以。' }),
    row({ text: '宇典科技和力行文化都做这个。', verdict: 'not_mentioned' }),
    row({ text: '未提及任何品牌。', verdict: 'not_mentioned' }),
  ];
  const insights = analyzeRun({ brand, rows });
  assert.equal(insights.sov.brandMentions, 1);
  assert.equal(insights.sov.competitors.length, 2);
  const total = insights.sov.brandShare
    + insights.sov.competitors.reduce((sum, item) => sum + item.share, 0);
  assert.ok(Math.abs(total - 1) < 1e-6, `份额应加总为 1，实际 ${total}`);
  assert.equal(insights.sov.competitors.find((c) => c.name === '宇典科技').mentions, 2);
});

test('analyzeRun：情感只统计提到品牌的句子，判定为正/中/负', () => {
  const rows = [
    row({ text: '恒野很专业，口碑不错，值得推荐。' }),
    row({ text: '恒野是一家内容工作室。' }),
    row({ text: '恒野响应慢，交付慢，不太推荐。' }),
  ];
  const insights = analyzeRun({ brand, rows });
  assert.equal(insights.sentiment.positive, 1);
  assert.equal(insights.sentiment.neutral, 1);
  assert.equal(insights.sentiment.negative, 1);
  assert.equal(insights.sentiment.score, 0);
});

test('analyzeRun：引擎维度统计提及率（多引擎对比）', () => {
  const rows = [
    row({ engine: 'deepseek', text: '推荐恒野。' }),
    row({ engine: 'deepseek', text: '未提及。', verdict: 'not_mentioned' }),
    row({ engine: 'dashscope', text: '恒野不错。' }),
  ];
  const insights = analyzeRun({ brand, rows });
  const deepseek = insights.engines.find((item) => item.engine === 'deepseek');
  const dashscope = insights.engines.find((item) => item.engine === 'dashscope');
  assert.equal(deepseek.mentionRate, 0.5);
  assert.equal(dashscope.mentionRate, 1);
});

test('renderInsightsMarkdown：包含四个核心表格/段落，空样本时给明确说明', () => {
  const insights = analyzeRun({
    brand,
    rows: [
      row({
        text: '推荐恒野，专业。宇典科技也在做。',
        citations: [{ title: '知乎', url: 'https://zhihu.com/p/1' }],
      }),
    ],
  });
  const lines = renderInsightsMarkdown(insights).join('\n');
  assert.match(lines, /曝光质量/);
  assert.match(lines, /竞品份额/);
  assert.match(lines, /引用源分析/);
  assert.match(lines, /情感倾向/);
  assert.match(lines, /机会缺口/);
  assert.match(lines, /zhihu\.com/);

  const empty = renderInsightsMarkdown(analyzeRun({ brand, rows: [] })).join('\n');
  assert.match(empty, /没有可分析的样本/);
});

test('gradeEvidence：A=原话+引用 / B=原话无引用 / C=拒答或错误', () => {
  assert.equal(gradeEvidence({ answer: { status: 'ok', text: '原话', citations: [{ url: 'https://a.cn' }] } }), 'A');
  assert.equal(gradeEvidence({ answer: { status: 'ok', text: '原话', citations: [] } }), 'B');
  assert.equal(gradeEvidence({ answer: { status: 'refused', text: '抱歉', citations: [] } }), 'C');
  assert.equal(gradeEvidence({ answer: { status: 'engine_error', text: '', citations: [] } }), 'C');
  assert.equal(gradeEvidence({}), 'C');
});

test('analyzeRun：输出证据等级计数，且 A+B+C 等于总样本', () => {
  const rows = [
    row({ text: '推荐恒野。', citations: [{ title: '知乎', url: 'https://zhihu.com/p/1' }] }),
    row({ text: '恒野不错。', citations: [] }),
    row({ status: 'refused', text: '抱歉无法回答。', verdict: null }),
  ];
  const insights = analyzeRun({ brand, rows });
  assert.equal(insights.evidence.A, 1);
  assert.equal(insights.evidence.B, 1);
  assert.equal(insights.evidence.C, 1);
  assert.equal(insights.evidence.A + insights.evidence.B + insights.evidence.C, insights.sample.total);
});
