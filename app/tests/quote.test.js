/**
 * tests/quote.test.js
 * 覆盖：成本 / 档位常量、难度归一化（数字 / 文本 / 非法值）、六个意图权重、
 * 建议篇数三档边界、档位最少篇数兜底、金额与税、成本与毛利、空报价 warning、
 * Markdown 渲染三节与百分比、纯函数确定性、未知档位回退。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PRICE_BANDS, UNIT_COST, scoreKeyword, buildQuote, renderQuoteMarkdown } from '../lib/quote.js';

/** 验收用的 3 个典型关键词（每次返回新对象，便于验证纯函数）。 */
function demoItems() {
  return [
    { term: '芜湖内容代运营多少钱', intent: 'price', difficulty: 7 },
    { term: '内容代运营怎么选', intent: 'compare', difficulty: 5 },
    { term: '本地起号陪跑', intent: 'city', difficulty: 3 },
  ];
}

test('UNIT_COST 是成本盘子：写作 / 发布 / 运营合计 60 元/篇', () => {
  assert.deepEqual({ ...UNIT_COST }, { writing: 20, publishing: 30, ops: 10 });
  assert.equal(UNIT_COST.writing + UNIT_COST.publishing + UNIT_COST.ops, 60);
  assert.ok(Object.isFrozen(UNIT_COST), '成本常量应冻结，避免运行时被改写');
});

test('PRICE_BANDS 三档标签、最少篇数与单篇价符合定价口径', () => {
  assert.deepEqual({ ...PRICE_BANDS.lite }, { label: '轻量', minArticles: 5, articlePrice: 120 });
  assert.deepEqual({ ...PRICE_BANDS.standard }, { label: '标准', minArticles: 7, articlePrice: 180 });
  assert.deepEqual({ ...PRICE_BANDS.deep }, { label: '深度', minArticles: 10, articlePrice: 260 });
  assert.ok(Object.isFrozen(PRICE_BANDS));
});

test('scoreKeyword 接受 0-10 数字难度，并按公式算价值分与建议篇数', () => {
  const score = scoreKeyword({ term: '芜湖内容代运营多少钱', intent: 'price', difficulty: 7 });

  assert.equal(score.term, '芜湖内容代运营多少钱');
  assert.equal(score.intent, 'price');
  assert.equal(score.difficulty, 7);
  assert.equal(score.difficultyLabel, '高');
  // 1.3 × (10 - 7) / 10 × 10 = 3.9
  assert.equal(score.valueScore, 3.9);
  assert.equal(score.recommendArticles, 8, '难度 > 6 要多铺');
  assert.ok(Array.isArray(score.reasons) && score.reasons.length >= 2, '至少 2 条中文理由');
  assert.ok(score.reasons.some((reason) => reason.includes('价格类意图')));
  assert.ok(score.reasons.some((reason) => reason.includes('难度 7')));
});

test('scoreKeyword 接受 low / medium / high 文本难度并映射 3 / 6 / 9', () => {
  const low = scoreKeyword({ term: '本地起号陪跑', intent: 'what', difficulty: 'low' });
  assert.equal(low.difficulty, 3);
  assert.equal(low.difficultyLabel, '低');
  assert.equal(low.recommendArticles, 3);
  assert.equal(low.valueScore, 7, '1.0 × (10 - 3) / 10 × 10 = 7');

  const medium = scoreKeyword({ term: '内容代运营怎么选', intent: 'what', difficulty: 'medium' });
  assert.equal(medium.difficulty, 6);
  assert.equal(medium.difficultyLabel, '中');
  assert.equal(medium.recommendArticles, 5);
  assert.equal(medium.valueScore, 4);

  const high = scoreKeyword({ term: '难词', intent: 'what', difficulty: 'HIGH' });
  assert.equal(high.difficulty, 9, '大小写不敏感');
  assert.equal(high.difficultyLabel, '高');
  assert.equal(high.recommendArticles, 8);
  assert.equal(high.valueScore, 1);

  const numericText = scoreKeyword({ term: 'CSV 数字串', intent: 'what', difficulty: '6' });
  assert.equal(numericText.difficulty, 6, '兼容 CSV 里常见的数字字符串');
});

test('scoreKeyword 非法难度回退 5 并写 warning', () => {
  for (const invalid of [11, -1, 'very hard', 'NaN', '', undefined, null]) {
    const score = scoreKeyword({ term: '非法难度词', intent: 'what', difficulty: invalid });
    assert.equal(score.difficulty, 5, `难度 ${String(invalid)} 应回退 5`);
    assert.equal(score.difficultyLabel, '中');
    assert.equal(score.recommendArticles, 5);
    assert.equal(score.valueScore, 5);
    assert.ok(score.reasons.some((reason) => reason.includes('警告')), 'warning 要出现在理由里');
    assert.ok(score.reasons.some((reason) => reason.includes('5')), '理由里说明回退值');
  }

  // 价格意图 + 回退难度 5 → 1.3 × 0.5 × 10 = 6.5
  assert.equal(scoreKeyword({ term: 'x', intent: 'price', difficulty: '很难' }).valueScore, 6.5);
});

test('六个意图权重生效：同难度下 price > compare > howto > city > what > risk', () => {
  // 难度 0 时价值分 = 意图权重 × 10
  const expected = { price: 13, compare: 12, howto: 11, city: 10.5, what: 10, risk: 9 };
  for (const [intent, valueScore] of Object.entries(expected)) {
    const score = scoreKeyword({ term: '同一个词', intent, difficulty: 0 });
    assert.equal(score.valueScore, valueScore, `${intent} 权重应为 ${valueScore / 10}`);
    assert.equal(score.intent, intent);
  }
  const price = scoreKeyword({ term: '同一个词', intent: 'price', difficulty: 5 });
  const risk = scoreKeyword({ term: '同一个词', intent: 'risk', difficulty: 5 });
  assert.ok(price.valueScore > risk.valueScore, '同难度下价格类应高于风险类');
});

test('未知意图按中性权重 1.0 计', () => {
  const score = scoreKeyword({ term: '未知意图词', intent: 'purchase', difficulty: 0 });
  assert.equal(score.intent, 'purchase');
  assert.equal(score.valueScore, 10);
  assert.ok(score.reasons.some((reason) => reason.includes('未登记')));
});

test('recommendArticles 按难度三档 3 / 5 / 8，边界 3 与 6 精确', () => {
  assert.equal(scoreKeyword({ term: 'a', intent: 'what', difficulty: 0 }).recommendArticles, 3);
  assert.equal(scoreKeyword({ term: 'a', intent: 'what', difficulty: 3 }).recommendArticles, 3);
  assert.equal(scoreKeyword({ term: 'a', intent: 'what', difficulty: 3.1 }).recommendArticles, 5);
  assert.equal(scoreKeyword({ term: 'a', intent: 'what', difficulty: 6 }).recommendArticles, 5);
  assert.equal(scoreKeyword({ term: 'a', intent: 'what', difficulty: 6.1 }).recommendArticles, 8);
  assert.equal(scoreKeyword({ term: 'a', intent: 'what', difficulty: 7 }).recommendArticles, 8);
  assert.equal(scoreKeyword({ term: 'a', intent: 'what', difficulty: 10 }).recommendArticles, 8);
});

test('standard 档篇数不足最少 7 篇时按 7 篇兜底计价', () => {
  const quote = buildQuote({ items: [{ term: '本地起号陪跑', intent: 'city', difficulty: 2 }] });

  assert.equal(quote.band, 'standard');
  assert.equal(quote.bandLabel, '标准');
  assert.equal(quote.lines.length, 1);
  assert.deepEqual(quote.lines[0], {
    term: '本地起号陪跑',
    intent: 'city',
    difficulty: 2,
    articles: 7,
    unitPrice: 180,
    subtotal: 1260,
  });
});

test('lite 档兜底 5 篇、deep 档兜底 10 篇', () => {
  const lite = buildQuote({ items: [{ term: '轻量词', intent: 'what', difficulty: 2 }], band: 'lite' });
  assert.equal(lite.bandLabel, '轻量');
  assert.equal(lite.lines[0].articles, 5);
  assert.equal(lite.lines[0].unitPrice, 120);
  assert.equal(lite.lines[0].subtotal, 600);

  const deepEasy = buildQuote({ items: [{ term: '深度档易词', intent: 'what', difficulty: 2 }], band: 'deep' });
  assert.equal(deepEasy.bandLabel, '深度');
  assert.equal(deepEasy.lines[0].articles, 10);
  assert.equal(deepEasy.lines[0].unitPrice, 260);
  assert.equal(deepEasy.lines[0].subtotal, 2600);

  const deepHard = buildQuote({ items: [{ term: '深度档难词', intent: 'what', difficulty: 9 }], band: 'deep' });
  assert.equal(deepHard.lines[0].articles, 10, '建议 8 篇仍不足 10 篇，按档位最少篇数');
});

test('金额计算：subtotal / tax / total 精确到分', () => {
  const quote = buildQuote({
    items: [
      { term: '词一', intent: 'what', difficulty: 2 },
      { term: '词二', intent: 'risk', difficulty: 2 },
    ],
    taxRate: 0.06,
  });

  // 两个词都建议 3 篇，standard 兜底到 7 篇 → 7 × 180 = 1260 / 条
  assert.equal(quote.lines[0].subtotal, 1260);
  assert.equal(quote.lines[1].subtotal, 1260);
  assert.equal(quote.subtotal, 2520);
  assert.equal(quote.tax, 151.2, '2520 × 0.06');
  assert.equal(quote.total, 2671.2, 'subtotal + tax');

  const noTax = buildQuote({ items: [{ term: '词一', intent: 'what', difficulty: 2 }], taxRate: 0 });
  assert.equal(noTax.tax, 0);
  assert.equal(noTax.total, noTax.subtotal);
});

test('成本按总篇数 × UNIT_COST 计算，毛利率按含税收入算', () => {
  const quote = buildQuote({
    items: [
      { term: '词一', intent: 'what', difficulty: 2 },
      { term: '词二', intent: 'risk', difficulty: 2 },
    ],
    taxRate: 0.06,
  });

  // 总篇数 14：14 × 20 / 30 / 10
  assert.deepEqual(quote.cost, { writing: 280, publishing: 420, ops: 140, total: 840 });
  // (2671.2 - 840) / 2671.2 = 0.68553…，保留 3 位
  assert.equal(quote.margin, 0.686);
});

test('空 items 返回零值结构并 warning「没有可报价的关键词」', () => {
  const quote = buildQuote({ items: [] });

  assert.deepEqual(quote, {
    band: 'standard',
    bandLabel: '标准',
    lines: [],
    subtotal: 0,
    tax: 0,
    total: 0,
    cost: { writing: 0, publishing: 0, ops: 0, total: 0 },
    margin: 0,
    warnings: ['没有可报价的关键词'],
  });
});

test('total <= 0 时毛利率记 0，不做除法（不出 NaN / Infinity）', () => {
  const quote = buildQuote({ items: [], taxRate: 0.06 });
  assert.equal(quote.total, 0);
  assert.equal(quote.tax, 0);
  assert.equal(quote.margin, 0);
  assert.ok(Number.isFinite(quote.margin));
  assert.ok(quote.warnings.includes('没有可报价的关键词'));
});

test('renderQuoteMarkdown 输出报价明细、成本构成、毛利三节与毛利率百分比', () => {
  const quote = buildQuote({ items: demoItems(), band: 'standard' });
  const markdown = renderQuoteMarkdown(quote);

  assert.ok(markdown.startsWith('# 恒野 GEO 内容报价'));
  assert.ok(markdown.includes('## 报价明细'));
  assert.ok(markdown.includes('| 关键词 | 意图 | 难度 | 篇数 | 单价（元） | 小计（元） |'));
  assert.ok(markdown.includes('| 芜湖内容代运营多少钱 | 价格 | 7 | 8 | 180 | 1440 |'));

  assert.ok(markdown.includes('## 成本构成'));
  assert.ok(markdown.includes('- 写作：22 篇 × 20 元 = 440 元'));
  assert.ok(markdown.includes('- 发布：22 篇 × 30 元 = 660 元'));
  assert.ok(markdown.includes('- 运营：22 篇 × 10 元 = 220 元'));
  assert.ok(markdown.includes('- 合计：1320 元'));

  assert.ok(markdown.includes('## 毛利'));
  assert.ok(markdown.includes('66.7%'), '毛利率按 2640 / 3960 渲染并保留 1 位小数');
  assert.ok(markdown.includes('3960'));
});

test('renderQuoteMarkdown 带税报价显示含税总计与税额', () => {
  const quote = buildQuote({ items: [{ term: '词一', intent: 'what', difficulty: 2 }], taxRate: 0.06 });
  const markdown = renderQuoteMarkdown(quote);

  // 7 篇 × 180 = 1260；1260 × 0.06 = 75.6；合计 1335.6
  assert.ok(markdown.includes('含税总计：1335.6 元'));
  assert.ok(markdown.includes('税额 75.6 元'));
  assert.ok(markdown.includes('毛利率：'));
});

test('renderQuoteMarkdown 空报价返回「暂无可报价项」', () => {
  assert.equal(renderQuoteMarkdown(buildQuote({ items: [] })), '暂无可报价项');
  assert.equal(renderQuoteMarkdown(null), '暂无可报价项');
  assert.equal(renderQuoteMarkdown({ lines: [] }), '暂无可报价项');
});

test('同一输入两次调用结果完全一致（纯函数）', () => {
  const scoreA = scoreKeyword({ term: '本地起号陪跑', intent: 'city', difficulty: 3 });
  const scoreB = scoreKeyword({ term: '本地起号陪跑', intent: 'city', difficulty: 3 });
  assert.deepEqual(scoreA, scoreB);
  assert.notEqual(scoreA.reasons, scoreB.reasons, '每次返回新的理由数组');

  const quoteA = buildQuote({ items: demoItems(), band: 'standard', taxRate: 0.06 });
  const quoteB = buildQuote({ items: demoItems(), band: 'standard', taxRate: 0.06 });
  assert.deepEqual(quoteA, quoteB);
  assert.notEqual(quoteA.lines, quoteB.lines);
  assert.deepEqual(renderQuoteMarkdown(quoteA), renderQuoteMarkdown(quoteB));

  // 修改一次结果不应污染下一次调用
  quoteA.lines[0].articles = 999;
  assert.equal(buildQuote({ items: demoItems(), band: 'standard', taxRate: 0.06 }).lines[0].articles, 8);
});

test('未知档位回退标准档并 warning', () => {
  const quote = buildQuote({ items: [{ term: '词一', intent: 'what', difficulty: 2 }], band: 'vip' });

  assert.equal(quote.band, 'standard');
  assert.equal(quote.bandLabel, '标准');
  assert.equal(quote.lines[0].unitPrice, 180);
  assert.ok(quote.warnings.some((warning) => warning.includes('未知档位')));
});

test('competitorsCovered 只写进理由，不改变价值分与篇数', () => {
  const base = scoreKeyword({ term: '芜湖内容代运营多少钱', intent: 'price', difficulty: 7 });
  const withCompetitors = scoreKeyword({
    term: '芜湖内容代运营多少钱',
    intent: 'price',
    difficulty: 7,
    competitorsCovered: 3,
  });

  assert.equal(withCompetitors.valueScore, base.valueScore);
  assert.equal(withCompetitors.recommendArticles, base.recommendArticles);
  assert.ok(withCompetitors.reasons.some((reason) => reason.includes('竞品已覆盖 3 个')));
  assert.ok(!base.reasons.some((reason) => reason.includes('竞品已覆盖')));
});

test('验收口径：3 个典型关键词在 standard 档的报价与毛利复算一致', () => {
  const quote = buildQuote({ items: demoItems(), band: 'standard' });

  assert.deepEqual(
    quote.lines.map((line) => [line.term, line.articles, line.subtotal]),
    [
      ['芜湖内容代运营多少钱', 8, 1440],
      ['内容代运营怎么选', 7, 1260],
      ['本地起号陪跑', 7, 1260],
    ],
  );
  assert.equal(quote.subtotal, 3960);
  assert.equal(quote.tax, 0);
  assert.equal(quote.total, 3960);
  assert.equal(quote.cost.total, 1320);
  assert.equal(quote.margin, 0.667);
  assert.deepEqual(quote.warnings, []);
});
