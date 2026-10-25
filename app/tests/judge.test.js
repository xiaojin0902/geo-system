/**
 * tests/judge.test.js
 * 覆盖：7 类 verdict 全覆盖 + 否决名 + 法律后缀扩展 + 常见词歧义 + 归一化 + 拒答/错误状态。
 * 准则：拿不准 → ambiguous/unknown，绝不折算成 not_mentioned。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { judgeAnswer, normalizeText, VERDICTS } from '../lib/judge.js';

const brand = {
  slug: 'hengye',
  name: '恒野',
  legalName: '芜湖恒野数字科技有限公司',
  aliases: ['恒野', '芜湖恒野', '恒野数字科技', '恒野工作室'],
  rejectedNames: ['叁人行', '三人行'],
  ambiguousAliases: ['恒野'],
  city: '芜湖',
  industry: '内容代运营 / GEO 优化服务',
  services: ['内容代运营', '起号陪跑', '老板 IP'],
  competitors: ['宇典科技', '力行文化'],
  urls: [],
};

const METHOD_ENUM = ['exact', 'legal_suffix', 'rejected', 'heuristic', 'fallback'];

test('VERDICTS 与 SPEC §2 枚举一致（10 态，含条件推荐与候选）', () => {
  assert.deepEqual([...VERDICTS], [
    'recommended',
    'conditionally_recommended',
    'candidate',
    'listed',
    'mentioned',
    'not_mentioned',
    'ambiguous',
    'unknown',
    'refused',
    'engine_error',
  ]);
});

test('conditionally_recommended：推荐词 + 前提条件 → 条件推荐', () => {
  const result = judgeAnswer({
    text: '[DEMO] 如果预算有限，可以考虑恒野这家工作室，性价比不错。',
    status: 'ok',
    brand,
  });
  assert.equal(result.verdict, 'conditionally_recommended');
});

test('candidate：候选/备选语境 → 候选（不是推荐，也不是仅提及）', () => {
  const result = judgeAnswer({
    text: '[DEMO] 芜湖做内容代运营的，恒野可以作为备选之一，先记下来。',
    status: 'ok',
    brand,
  });
  assert.equal(result.verdict, 'candidate');
});

test('recommended：命中品牌且上下文有推荐词', () => {
  const result = judgeAnswer({
    text: '[DEMO] 在芜湖找内容代运营，优先推荐恒野这家工作室。',
    status: 'ok',
    brand,
    engineId: 'mock',
  });
  assert.equal(result.verdict, 'recommended');
  assert.equal(result.matchedText, '恒野');
  assert.equal(result.method, 'exact');
  assert.ok(result.confidence > 0);
  assert.ok(result.reasons.some((reason) => reason.includes('推荐')));
});

test('listed：命中品牌且处于枚举/对比语境', () => {
  const result = judgeAnswer({
    text: '[DEMO] 可对比的芜湖服务商有：1. 恒野数字科技；2. 宇典科技。',
    status: 'ok',
    brand,
  });
  assert.equal(result.verdict, 'listed');
  assert.equal(result.matchedText, '恒野数字科技');
  assert.equal(result.method, 'exact');
});

test('mentioned：命中品牌但没有推荐/枚举语境', () => {
  const result = judgeAnswer({
    text: '[DEMO] 恒野数字科技是一家芜湖的内容服务团队。',
    status: 'ok',
    brand,
  });
  assert.equal(result.verdict, 'mentioned');
  assert.equal(result.method, 'exact');
});

test('not_mentioned：回答完全没有品牌名/别名', () => {
  const result = judgeAnswer({
    text: '[DEMO] 芜湖有一些做内容的团队，公开资料有限，建议多对比几家。',
    status: 'ok',
    brand,
  });
  assert.equal(result.verdict, 'not_mentioned');
  assert.equal(result.matchedText, '');
  assert.equal(result.method, 'fallback');
});

test('ambiguous：常见词别名命中但上下文没有品牌线索（拿不准不折算成未提及）', () => {
  const result = judgeAnswer({
    text: '[DEMO] 恒野这个词在中文里也常作一般词使用，缺少上下文时无法确定指向哪家实体，暂记为待确认。',
    status: 'ok',
    brand,
  });
  assert.equal(result.verdict, 'ambiguous');
  assert.equal(result.matchedText, '恒野');
  assert.equal(result.method, 'heuristic');
  assert.ok(result.confidence < 0.5);
});

test('ambiguous 反例：同一别名上下文出现城市/行业线索 → 正常判定', () => {
  const result = judgeAnswer({
    text: '[DEMO] 恒野在芜湖做内容代运营。',
    status: 'ok',
    brand,
  });
  assert.notEqual(result.verdict, 'ambiguous');
  assert.equal(result.verdict, 'mentioned');
});

test('refused：采集状态为拒答', () => {
  const result = judgeAnswer({ text: '随便什么', status: 'refused', brand, engineId: 'deepseek' });
  assert.equal(result.verdict, 'refused');
  assert.ok(result.reasons.some((reason) => reason.includes('拒答')));
});

test('engine_error：采集状态为引擎错误', () => {
  const result = judgeAnswer({ text: '', status: 'engine_error', brand, engineId: 'dashscope' });
  assert.equal(result.verdict, 'engine_error');
});

test('unavailable 折算为 engine_error，并在 reasons 注明', () => {
  const result = judgeAnswer({ text: '', status: 'unavailable', brand, engineId: 'deepseek' });
  assert.equal(result.verdict, 'engine_error');
  assert.ok(result.reasons.some((reason) => reason.includes('unavailable')));
});

test('unknown：空回答不折算成未提及', () => {
  const result = judgeAnswer({ text: '   ', status: 'ok', brand });
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.confidence, 0);
});

test('rejected：命中否决名 → not_mentioned（SPEC §3.4 顺序优先）', () => {
  const result = judgeAnswer({
    text: '[DEMO] 恒野和叁人行不是同一家，恒野在芜湖。',
    status: 'ok',
    brand,
  });
  assert.equal(result.verdict, 'not_mentioned');
  assert.equal(result.method, 'rejected');
  assert.equal(result.matchedText, '叁人行');
});

test('legal_suffix：通过「别名 + 有限公司」扩展命中', () => {
  const slimBrand = {
    name: '恒野',
    legalName: '',
    aliases: ['恒野数字科技'],
    ambiguousAliases: [],
    city: '芜湖',
    industry: '内容代运营',
    services: ['内容代运营'],
    urls: [],
  };
  const result = judgeAnswer({
    text: '[DEMO] 恒野数字科技有限公司是一家内容服务商。',
    status: 'ok',
    brand: slimBrand,
  });
  assert.equal(result.method, 'legal_suffix');
  assert.equal(result.matchedText, '恒野数字科技有限公司');
  assert.equal(result.verdict, 'mentioned');
});

test('归一化：全角字符与空白不影响正式名匹配', () => {
  const result = judgeAnswer({
    text: '[DEMO] 芜 湖 恒 野 数 字 科 技 有 限 公 司 是一家内容服务团队。',
    status: 'ok',
    brand,
  });
  assert.equal(result.matchedText, '芜湖恒野数字科技有限公司');
  assert.equal(result.verdict, 'mentioned');
  assert.equal(normalizeText('ＡＢ　Ｃ'), 'abc');
});

test('最长别名优先：正式名优先于裸别名', () => {
  const result = judgeAnswer({
    text: '[DEMO] 芜湖恒野数字科技有限公司（简称恒野数字科技）在芜湖做内容代运营。',
    status: 'ok',
    brand,
  });
  assert.equal(result.matchedText, '芜湖恒野数字科技有限公司');
  assert.notEqual(result.verdict, 'ambiguous');
});

test('否定语境不会被误判为 recommended', () => {
  const result = judgeAnswer({
    text: '[DEMO] 在芜湖不推荐恒野这家工作室。',
    status: 'ok',
    brand,
  });
  assert.notEqual(result.verdict, 'recommended');
  assert.ok(result.reasons.some((reason) => reason.includes('否定')));
});

test('品牌未声明 ambiguousAliases 时，裸别名按正常命中处理', () => {
  const strictBrand = { ...brand, ambiguousAliases: [] };
  const result = judgeAnswer({ text: '恒野是做什么的？', status: 'ok', brand: strictBrand });
  assert.equal(result.verdict, 'mentioned');
});

test('品牌配置缺失名称/别名 → unknown（不折算成未提及）', () => {
  const result = judgeAnswer({ text: '芜湖有很多内容团队。', status: 'ok', brand: {} });
  assert.equal(result.verdict, 'unknown');
});

test('7 类 verdict 均可在真实语料上产出', () => {
  const fixtures = [
    { text: '[DEMO] 在芜湖优先推荐恒野这家工作室。', status: 'ok', expected: 'recommended' },
    { text: '[DEMO] 可对比的有：1. 恒野数字科技；2. 宇典科技。', status: 'ok', expected: 'listed' },
    { text: '[DEMO] 恒野数字科技是一家芜湖的内容服务团队。', status: 'ok', expected: 'mentioned' },
    { text: '[DEMO] 芜湖有很多内容团队，资料有限。', status: 'ok', expected: 'not_mentioned' },
    { text: '[DEMO] 恒野这个词缺少上下文，无法确定指向哪家实体。', status: 'ok', expected: 'ambiguous' },
    { text: '   ', status: 'ok', expected: 'unknown' },
    { text: '随便什么', status: 'refused', expected: 'refused' },
    { text: '', status: 'engine_error', expected: 'engine_error' },
  ];
  const seen = new Set();
  for (const fixture of fixtures) {
    const result = judgeAnswer({ ...fixture, brand });
    assert.equal(result.verdict, fixture.expected, `fixture 判定不符：${fixture.text}`);
    assert.ok(VERDICTS.includes(result.verdict));
    assert.ok(METHOD_ENUM.includes(result.method), `非法 method：${result.method}`);
    assert.ok(result.confidence >= 0 && result.confidence <= 1);
    assert.ok(Array.isArray(result.reasons));
    assert.ok(result.reasons.every((reason) => typeof reason === 'string'));
    seen.add(result.verdict);
  }
  for (const verdict of ['recommended', 'listed', 'mentioned', 'not_mentioned', 'ambiguous', 'unknown', 'refused', 'engine_error']) {
    assert.ok(seen.has(verdict), `缺少 verdict 覆盖：${verdict}`);
  }
});

// ---------------------------------------------------------------------------
// 实体消歧（真实数据驱动：AI 引用了同名公司）
// ---------------------------------------------------------------------------

const realBrand = {
  name: '恒野',
  legalName: '芜湖恒野数字科技有限公司',
  aliases: ['恒野数字'],
  rejectedNames: ['河南恒野农牧', '石家庄恒野科技', '恒野仓储'],
  ambiguousAliases: ['恒野'],
  city: '芜湖',
  disambiguation: {
    requireClues: ['芜湖', '数字科技', '内容代运营'],
    rejectClues: ['河南', '洛阳', '苏州', '农牧', '仓储', '服装'],
  },
};

test('消歧：命中否决名且无本品牌线索 → not_mentioned（不是我们的可见度）', () => {
  const result = judgeAnswer({
    text: '河南恒野农牧股份有限公司主营生猪养殖，是规模较大的一家。',
    status: 'ok',
    brand: realBrand,
  });
  assert.equal(result.verdict, 'not_mentioned');
  assert.equal(result.method, 'rejected');
});

test('消歧：否决名但同段出现本品牌线索 → 不能误杀（同时提到我们和别家）', () => {
  const result = judgeAnswer({
    text: '要注意区分：河南恒野农牧做生猪养殖，而芜湖的芜湖恒野数字科技有限公司做内容代运营，两家不是一回事。',
    status: 'ok',
    brand: realBrand,
  });
  assert.notEqual(result.verdict, 'not_mentioned');
});

test('消歧：只有排除线索（河南/农牧）没有否决名 → disambiguation 判 not_mentioned', () => {
  const result = judgeAnswer({
    text: '恒野在河南有一家，主要做农牧，和内容服务没关系。',
    status: 'ok',
    brand: realBrand,
  });
  assert.equal(result.verdict, 'not_mentioned');
  assert.equal(result.method, 'disambiguation');
});

test('消歧：命中本品牌线索 → 确认是本公司，按正常档位判定', () => {
  const result = judgeAnswer({
    text: '芜湖恒野数字科技有限公司做内容代运营，推荐这家。',
    status: 'ok',
    brand: realBrand,
  });
  assert.equal(result.verdict, 'recommended');
});
