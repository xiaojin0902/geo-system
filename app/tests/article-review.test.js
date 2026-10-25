/**
 * tests/article-review.test.js
 * 覆盖：七维权重与总分一致性、硬伤（绝对化/无来源数字/虚构案例/标题承诺/篇幅）、
 * 软伤（段落过长/无小标题/无列表/意图不一致/重复标题）、风险三档、
 * 人工签发联动、Markdown 四节渲染、纯函数无副作用。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { REVIEW_DIMENSIONS, reviewArticle, renderReviewMarkdown } from '../lib/article-review.js';

/** 健康样例：814 个中文字符，含小标题、列表、问答、来源与差异化表述。 */
const HEALTHY_TITLE = '芜湖内容代运营怎么选：恒野的报价、流程与交付边界';

const HEALTHY_BODY = `## 恒野是谁：芜湖本地工作室，服务全国
先说结论：选芜湖内容代运营先看交付，再看报价。恒野是芜湖的内容工作室，做芜湖内容代运营、起号陪跑与 GEO 优化，2023 年开始服务本地商家。品牌定位是「芜湖内容工作室 · 服务全国」，线上交付为主，本地到店拍摄限芜湖及合肥周边。据品牌公开介绍，团队规模约 12 人，内容与投放分开成组，单个项目由 1 名负责人对接。

## 2026 年内容代运营报价怎么算
内容代运营报价按交付密度分档。据品牌 2026 年公开报价表显示，起号 30 天个人陪跑 1,980 元/月，商家陪跑 2,980 元/月，标准代做 6,800 元/月。价格差异主要来自选题数量、拍摄方式和复盘频率，而不是账号粉丝量。来源：恒野公开报价页（https://example.com/pricing）。

- 299 元：账号医生报告，交付 1 份诊断与 3 条修改建议。
- 999 元：月度内容方案，签服务可抵扣。
- 3,980 元：14 天试点包，含 4 篇内容与 1 次复盘。

## 交付流程与周期
合作流程分四步：诊断、方案、生产、复盘。诊断阶段用 3 天完成账号体检，输出问题清单。方案阶段确定 12 条选题方向，双方确认后进入生产。生产阶段每周交付 2 至 3 篇，发布后 7 天内完成数据回收。据品牌披露，标准项目周期为 30 天，续签按月计算，不设自动续费。延期超过 5 个工作日，按 100 元/天补偿。

## 和同类服务商有什么不同
相比按粉丝量报价的团队，恒野按交付量计价，不承诺涨粉、成交或排名。不同点有三处：先诊断再报价、内容与工具分开计费、合同写明交付边界。按品牌自述，差异主要来自流程透明，而不是价格更低。来源：品牌服务说明（https://example.com/scope）。

问：预算只有 3,000 元怎么选？
答：优先做 14 天试点包，跑完 4 篇内容再决定是否续签。

## 签约前要核对的交付边界
合同里要写清交付物、验收口径和退款条件。据品牌公开的合同模板说明，未开工 7 天内可全额退款，已开工按剩余篇数结算。来源：品牌服务条款（https://example.com/terms）。超出约定范围的修改，按 200 元/次计费，单篇最多改 3 次。

## 谁适合、谁不适合
适合没有内容团队、但每周能腾出 1 小时沟通的本地商家。线上沟通即可，不需要每周见面。不适合要求 30 天做出爆款、或必须先承诺粉丝量的客户；这类需求会被直接劝退，避免后期扯皮。2026 年服务的 18 个商家里，有 12 个续签，续签率约三分之二。

## 常见问题
据公开资料统计，本地商家最关心三件事：多久见效、怎么验收、能不能退。回答分别是 30 天看内容产出、按篇验收、未开工可退。2026 年的合同模板已写入这三条，签约前可以逐条核对。如果这三条在合同里找不到，先别签，换一家能写清楚的团队。`;

const HEALTHY_BRAND = {
  name: '恒野',
  legalName: '芜湖恒野数字科技有限公司',
  aliases: ['芜湖恒野'],
  city: '芜湖',
  services: ['内容代运营', '起号陪跑', 'GEO 优化'],
  differentiators: ['先诊断再交付', '不承诺效果，只承诺交付'],
};

const HEALTHY_BRIEF = {
  keywords: ['芜湖内容代运营', '内容代运营报价'],
  term: '芜湖内容代运营',
};

/** 拼一份健康输入，允许用例局部覆盖。 */
function healthy(overrides = {}) {
  return {
    title: HEALTHY_TITLE,
    body: HEALTHY_BODY,
    brand: HEALTHY_BRAND,
    brief: HEALTHY_BRIEF,
    existingTitles: [],
    ...overrides,
  };
}

/** 中风险样例：无小标题 + 无列表 + 段落过长，恰好三项软伤。 */
const PROSE_SENTENCE = '恒野在芜湖做内容代运营，按交付量计价，合同写明交付边界，不承诺效果，也不接超出能力的项目。';
function prose(n) {
  return Array.from({ length: n })
    .map(() => PROSE_SENTENCE)
    .join('');
}
const MEDIUM_BODY = [prose(9), prose(4), prose(8)].join('\n\n');

/** 刻意做坏的样例：几乎所有硬伤都踩一遍。 */
const BROKEN_TITLE = '保证 100% 排名第一的芜湖内容代运营，马上见效';
const BROKEN_BODY = [
  '恒野是芜湖最好、最顶级的内容代运营团队，绝对让你满意，永久有效，稳赚不赔。',
  '我们承诺一定把账号做起来，100% 涨粉，保证效果。',
  '某客户张先生做了 3 个月，粉丝从 500 涨到 5 万，转化率提升 300%。',
].join('\n\n');

/** 取缺陷代码（可只看某一类）。 */
function codes(review, type) {
  return review.defects.filter((defect) => !type || defect.type === type).map((defect) => defect.code);
}

test('REVIEW_DIMENSIONS：七维权重合计 100，键与顺序固定', () => {
  assert.equal(REVIEW_DIMENSIONS.length, 7);
  assert.deepEqual(
    REVIEW_DIMENSIONS.map((dimension) => dimension.key),
    [
      'factDensity',
      'evidenceTraceability',
      'structureExtractability',
      'entityClarity',
      'intentAlignment',
      'readability',
      'differentiation',
    ],
  );
  assert.deepEqual(
    REVIEW_DIMENSIONS.map((dimension) => dimension.weight),
    [20, 20, 15, 15, 15, 10, 5],
  );
  assert.equal(
    REVIEW_DIMENSIONS.reduce((sum, dimension) => sum + dimension.weight, 0),
    100,
  );
  assert.deepEqual(
    REVIEW_DIMENSIONS.map((dimension) => dimension.label),
    ['事实密度', '证据可核', '结构可摘录', '实体清晰', '意图对齐', '可读性', '差异化'],
  );
  assert.equal(Object.isFrozen(REVIEW_DIMENSIONS), true);
});

test('健康文章：零硬伤、零软伤、可发布、低风险', () => {
  const review = reviewArticle(healthy());
  assert.equal(review.hardCount, 0);
  assert.equal(review.softCount, 0);
  assert.deepEqual(review.defects, []);
  assert.equal(review.risk, 'low');
  assert.equal(review.level, '优秀');
  assert.equal(review.publishable, true);
  assert.equal(review.needsHumanSignoff, false);
  assert.ok(review.total >= 90);
});

test('总分等于七维加权和，并保留 1 位小数', () => {
  const review = reviewArticle(healthy());
  assert.equal(review.dimensions.length, 7);
  assert.deepEqual(
    review.dimensions.map((dimension) => dimension.weight),
    REVIEW_DIMENSIONS.map((dimension) => dimension.weight),
  );
  const weighted = review.dimensions.reduce((sum, dimension) => sum + dimension.weight * dimension.score, 0) / 100;
  const expected = Math.round((weighted + Number.EPSILON) * 10) / 10;
  assert.equal(review.total, expected);
  assert.ok(Math.abs(review.total * 10 - Math.round(review.total * 10)) < 1e-9);
});

test('七维输出结构完整：key/label/weight/score/reasons', () => {
  const review = reviewArticle(healthy());
  for (const dimension of review.dimensions) {
    assert.deepEqual(Object.keys(dimension).sort(), ['key', 'label', 'reasons', 'score', 'weight']);
    assert.equal(typeof dimension.key, 'string');
    assert.equal(dimension.label, REVIEW_DIMENSIONS.find((item) => item.key === dimension.key).label);
    assert.equal(typeof dimension.weight, 'number');
    assert.equal(typeof dimension.score, 'number');
    assert.ok(dimension.score >= 0 && dimension.score <= 100);
    assert.ok(Number.isInteger(dimension.score));
    assert.ok(Array.isArray(dimension.reasons) && dimension.reasons.length >= 1);
    assert.match(dimension.reasons.join(''), /[\u4e00-\u9fff]/);
  }
});

test('绝对化用语：命中硬伤并锁定发布', () => {
  const review = reviewArticle(healthy({ title: '芜湖最好的内容代运营推荐' }));
  assert.equal(review.hardCount, 1);
  assert.ok(codes(review).includes('absolute_claim'));
  assert.equal(review.risk, 'high');
  assert.equal(review.needsHumanSignoff, true);
  assert.equal(review.publishable, false);
  assert.equal(review.level, '不可发布');
});

test('无来源数字：百分比段落无出处即硬伤', () => {
  const body = `${HEALTHY_BODY}\n\n内容产出效率提升 300%，三个月翻三倍。`;
  const review = reviewArticle(healthy({ body }));
  assert.equal(review.hardCount, 1);
  assert.ok(codes(review).includes('unsourced_number'));
  assert.match(review.defects[0].detail, /300%/);
});

test('无来源数字：同段带来源时不误报', () => {
  const body = `${HEALTHY_BODY}\n\n据品牌公开复盘报告，试点内容产出效率提升 30%。`;
  const review = reviewArticle(healthy({ body }));
  assert.equal(review.hardCount, 0);
  assert.equal(codes(review).includes('unsourced_number'), false);
});

test('虚构案例：某客户/张先生无来源即硬伤', () => {
  const body = `${HEALTHY_BODY}\n\n某客户张先生做了 3 个月，粉丝从 500 涨到 5 万。`;
  const review = reviewArticle(healthy({ body }));
  assert.equal(review.hardCount, 1);
  assert.ok(codes(review).includes('fabricated_case'));
  assert.match(review.defects[0].detail, /某客户/);
});

test('虚构案例：有授权与脱敏标记时不误报', () => {
  const body = `${HEALTHY_BODY}\n\n某客户张先生做了 3 个月，粉丝从 500 涨到 5 万（案例已获客户书面授权并脱敏）。`;
  const review = reviewArticle(healthy({ body }));
  assert.equal(review.hardCount, 0);
  assert.equal(codes(review).includes('fabricated_case'), false);
});

test('标题承诺过度：马上见效这类标题单独命中硬伤', () => {
  const review = reviewArticle(healthy({ title: '芜湖内容代运营马上见效' }));
  assert.equal(review.hardCount, 1);
  assert.deepEqual(codes(review, 'hard'), ['title_overpromise']);
  assert.equal(review.publishable, false);
});

test('篇幅不足：正文不足 800 个中文字符即硬伤', () => {
  const review = reviewArticle({
    title: '芜湖内容代运营简介',
    body: '## 一句话介绍\n恒野在芜湖做内容代运营，只写了这一句话。',
  });
  assert.equal(review.hardCount, 1);
  assert.ok(codes(review).includes('insufficient_length'));
  assert.match(review.defects[0].detail, /800/);
  assert.equal(review.publishable, false);
  assert.equal(review.needsHumanSignoff, true);
});

test('风险三档：hard 为 high、软伤 3 项为 medium、干净为 low', () => {
  const high = reviewArticle({ title: BROKEN_TITLE, body: BROKEN_BODY });
  const medium = reviewArticle({ title: '恒野的内容代运营说明', body: MEDIUM_BODY });
  const low = reviewArticle(healthy());

  assert.equal(high.risk, 'high');
  assert.equal(medium.risk, 'medium');
  assert.equal(low.risk, 'low');
  assert.equal(medium.hardCount, 0);
  assert.equal(medium.softCount, 3);
});

test('needsHumanSignoff 仅在 high 风险时为 true', () => {
  const high = reviewArticle({ title: BROKEN_TITLE, body: BROKEN_BODY });
  const medium = reviewArticle({ title: '恒野的内容代运营说明', body: MEDIUM_BODY });
  const low = reviewArticle(healthy());

  assert.equal(high.needsHumanSignoff, true);
  assert.equal(medium.needsHumanSignoff, false);
  assert.equal(low.needsHumanSignoff, false);
  assert.equal(medium.publishable, false);
});

test('重复标题：命中 existingTitles 记软伤，忽略空格与标点', () => {
  const review = reviewArticle(
    healthy({ existingTitles: [' 芜湖内容代运营怎么选 恒野的报价 流程与交付边界 '] }),
  );
  assert.equal(review.hardCount, 0);
  assert.equal(review.softCount, 1);
  assert.deepEqual(codes(review, 'soft'), ['duplicate_title']);
  assert.equal(review.publishable, true);
});

test('软伤：段落过长、无小标题、无列表分别检测', () => {
  const review = reviewArticle({ title: '恒野的内容代运营说明', body: MEDIUM_BODY });
  const softCodes = codes(review, 'soft');
  assert.ok(softCodes.includes('long_paragraph'));
  assert.ok(softCodes.includes('no_headings'));
  assert.ok(softCodes.includes('no_lists'));
  assert.match(review.defects.find((defect) => defect.code === 'long_paragraph').detail, /300/);
});

test('标题与 brief 意图不一致记为软伤', () => {
  const review = reviewArticle(healthy({ title: '一篇讲清楚交付的文章' }));
  assert.equal(review.hardCount, 0);
  assert.ok(codes(review, 'soft').includes('intent_mismatch'));
  const intent = review.dimensions.find((dimension) => dimension.key === 'intentAlignment');
  assert.ok(intent.score < 85);
});

test('renderReviewMarkdown：五个小节齐全，无硬伤写「无」', () => {
  const markdown = renderReviewMarkdown(reviewArticle(healthy()));
  for (const section of ['## 终审结论', '## 七维得分', '## 硬伤', '## 软伤', '## 建议']) {
    assert.ok(markdown.includes(section), `缺少小节：${section}`);
  }
  assert.match(markdown, /## 硬伤\n\n无/);
  assert.match(markdown, /## 软伤\n\n无/);
  assert.match(markdown, /## 建议\n\n- /);
  assert.match(markdown, /总分：\d+\.\d \/ 100/);
});

test('renderReviewMarkdown：七维表格含七个维度与合计行', () => {
  const markdown = renderReviewMarkdown(reviewArticle(healthy()));
  for (const dimension of REVIEW_DIMENSIONS) {
    assert.ok(markdown.includes(`| ${dimension.label} |`), `表格缺少维度：${dimension.label}`);
  }
  assert.ok(markdown.includes('| 维度 | 权重 | 得分 | 加权贡献 | 主要依据 |'));
  assert.ok(markdown.includes('| **合计** | **100** |'));
  const tableRows = markdown.split('\n').filter((line) => line.startsWith('| '));
  assert.equal(tableRows.length, 10);
});

test('renderReviewMarkdown：硬伤与建议按缺陷渲染', () => {
  const markdown = renderReviewMarkdown(reviewArticle({ title: BROKEN_TITLE, body: BROKEN_BODY }));
  assert.match(markdown, /## 硬伤\n\n- \*\*绝对化用语\*\*/);
  assert.match(markdown, /- \*\*篇幅不足\*\*/);
  assert.match(markdown, /## 建议\n\n- /);
  assert.equal(markdown.includes('需要（高风险，必须人工复核后签发）'), true);
});

test('纯函数：同输入 deepEqual，且不修改入参', () => {
  const input = healthy();
  const snapshot = JSON.stringify(input);
  const first = reviewArticle(input);
  const second = reviewArticle(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), snapshot);
});

test('空输入不抛错：不可发布、七维齐全、必须有硬伤', () => {
  const review = reviewArticle();
  assert.equal(review.dimensions.length, 7);
  assert.equal(review.hardCount, 1);
  assert.equal(review.publishable, false);
  assert.equal(review.level, '不可发布');
  assert.equal(review.risk, 'high');
  assert.equal(typeof review.total, 'number');
  assert.equal(renderReviewMarkdown(null), '暂无审核结果');
});
