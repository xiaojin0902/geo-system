/**
 * questions-gen.js 自测
 * 覆盖：三层齐全、六意图覆盖、去品牌名硬规则、确定性、seed 差异、字段兜底、
 * 去重、优先级规则、count 上限、Markdown 渲染、特殊字符服务名。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  QUESTION_INTENTS,
  generateQuestions,
  renderQuestionsMarkdown,
} from '../lib/questions-gen.js';

const brand = JSON.parse(
  readFileSync(new URL('../brands/hengye.json', import.meta.url), 'utf8'),
);

/** 所有不能出现在题目里的名字：品牌名、工商全称、别名、歧义别名 */
const FORBIDDEN_NAMES = [
  brand.name,
  brand.legalName,
  ...(brand.aliases || []),
  ...(brand.ambiguousAliases || []),
].filter(Boolean);

/** 逐题检查品牌名泄漏 */
function assertNoBrandName(questions) {
  for (const question of questions) {
    for (const name of FORBIDDEN_NAMES) {
      assert.ok(
        !question.text.includes(name),
        `题目里出现品牌名「${name}」：${question.text}`,
      );
    }
  }
}

test('意图枚举与三层结构对齐', () => {
  assert.deepEqual(QUESTION_INTENTS, ['what', 'city', 'compare', 'price', 'howto', 'risk']);

  const { questions } = generateQuestions({ brand });
  const tierByIntent = {
    what: 'awareness',
    city: 'awareness',
    compare: 'decision',
    price: 'decision',
    howto: 'scenario',
    risk: 'scenario',
  };
  for (const question of questions) {
    assert.equal(question.tier, tierByIntent[question.intent], `意图 ${question.intent} 的层不对`);
  }
});

test('三层齐全：认知层 / 决策层 / 场景层各至少 6 题', () => {
  const { questions } = generateQuestions({ brand });
  const counts = { awareness: 0, decision: 0, scenario: 0 };
  for (const question of questions) counts[question.tier] += 1;

  for (const [tier, count] of Object.entries(counts)) {
    assert.ok(count >= 6, `${tier} 只有 ${count} 题，应至少 6 题`);
  }
});

test('六种意图全部覆盖', () => {
  const { questions } = generateQuestions({ brand });
  const intents = new Set(questions.map((question) => question.intent));
  for (const intent of QUESTION_INTENTS) {
    assert.ok(intents.has(intent), `缺少意图：${intent}`);
  }
  assert.equal(intents.size, QUESTION_INTENTS.length);
});

test('问题里绝不出现品牌名（硬规则）', () => {
  const { questions } = generateQuestions({ brand, count: 24, seed: 1 });
  assert.ok(questions.length > 0);
  assertNoBrandName(questions);
  // 渲染出来的 Markdown 同样不能泄漏
  const markdown = renderQuestionsMarkdown(questions);
  for (const name of FORBIDDEN_NAMES) {
    assert.ok(!markdown.includes(name), `Markdown 里出现品牌名「${name}」`);
  }
});

test('同一品牌同一 seed 两次生成完全一致', () => {
  const first = generateQuestions({ brand, count: 24, seed: 7 });
  const second = generateQuestions({ brand, count: 24, seed: 7 });
  assert.deepEqual(first, second);
});

test('不同 seed 产出不同（顺序或内容有差异）', () => {
  const first = generateQuestions({ brand, count: 24, seed: 1 });
  const second = generateQuestions({ brand, count: 24, seed: 2 });
  assert.notDeepEqual(first.questions, second.questions);
  assert.notEqual(JSON.stringify(first.questions), JSON.stringify(second.questions));
});

test('缺 city / scope / services 时不抛错，且有兜底与 warnings', () => {
  const bareBrand = { name: '恒野' };
  let result;
  assert.doesNotThrow(() => {
    result = generateQuestions({ brand: bareBrand });
  });

  assert.ok(result.questions.length > 0);
  assert.ok(
    result.questions.some((question) => question.text.includes('本地')),
    '缺 city 时应出现「本地」兜底',
  );
  assert.ok(
    result.questions.some((question) => question.text.includes('相关服务')),
    '缺 services 与 industry 时应出现「相关服务」兜底',
  );

  const warningText = result.warnings.join('\n');
  for (const field of ['city', 'scope', 'services']) {
    assert.ok(warningText.includes(field), `warnings 应记录字段 ${field} 的兜底`);
  }
  assertNoBrandName(result.questions);
});

test('去重生效：questions 里没有重复 text', () => {
  const { questions } = generateQuestions({ brand, count: 40, seed: 3 });
  const texts = questions.map((question) => question.text);
  assert.equal(new Set(texts).size, texts.length, '存在重复题目');
});

test('优先级规则：P0 至少 6 条，场景层不含 P0', () => {
  const { questions } = generateQuestions({ brand, count: 24, seed: 1 });
  const p0 = questions.filter((question) => question.priority === 'P0');
  assert.ok(p0.length >= 6, `P0 只有 ${p0.length} 条，应至少 6 条`);

  for (const question of questions) {
    assert.ok(['P0', 'P1', 'P2'].includes(question.priority), `非法优先级：${question.priority}`);
  }
  const scenarioP0 = questions.filter(
    (question) => question.tier === 'scenario' && question.priority === 'P0',
  );
  assert.equal(scenarioP0.length, 0, '场景层不应出现 P0');
});

test('count 是上限：count=8 时最多 8 条', () => {
  const { questions } = generateQuestions({ brand, count: 8, seed: 1 });
  assert.ok(questions.length <= 8);
  assert.equal(questions.length, 8, '候选充足时应填满 count');
});

test('每题字段形状合法且 source 恒为 generated', () => {
  const { questions } = generateQuestions({ brand, count: 24, seed: 9 });
  for (const question of questions) {
    assert.deepEqual(Object.keys(question).sort(), [
      'intent',
      'priority',
      'source',
      'text',
      'tier',
    ]);
    assert.equal(typeof question.text, 'string');
    assert.ok(question.text.trim().length > 0);
    assert.ok(QUESTION_INTENTS.includes(question.intent));
    assert.ok(['awareness', 'decision', 'scenario'].includes(question.tier));
    assert.ok(['P0', 'P1', 'P2'].includes(question.priority));
    assert.equal(question.source, 'generated');
  }
});

test('scope 含「全国」时同时生成全国与本地两种问法', () => {
  const { questions } = generateQuestions({ brand, count: 24, seed: 5 });
  const texts = questions.map((question) => question.text);
  assert.ok(texts.some((text) => text.includes('全国')), '应包含「全国」问法');
  assert.ok(texts.some((text) => text.includes('芜湖')), '应包含「芜湖」本地问法');
});

test('字段里的品牌名会被剔除，并写入 warnings', () => {
  const leakyBrand = {
    name: '恒野',
    legalName: '芜湖恒野数字科技有限公司',
    city: '芜湖',
    scope: '全国线上交付',
    industry: 'GEO 优化',
    services: ['恒野GEO'],
    targetCustomers: ['本地商家'],
    competitors: ['宇典科技'],
    ambiguousAliases: ['恒野'],
  };
  const { questions, warnings } = generateQuestions({ brand: leakyBrand, count: 24, seed: 1 });
  assert.ok(questions.length > 0);
  for (const question of questions) {
    assert.ok(!question.text.includes('恒野'), `题目仍含品牌名：${question.text}`);
  }
  assert.ok(
    warnings.some((warning) => warning.includes('恒野')),
    'warnings 应记录品牌名剔除',
  );
});

test('服务名含特殊字符（起号/陪跑）时不破坏输出', () => {
  const specialBrand = {
    name: '恒野',
    city: '芜湖',
    scope: '全国线上交付',
    industry: '内容代运营',
    services: ['起号/陪跑'],
    targetCustomers: ['个人创作者'],
    competitors: ['宇典科技'],
    ambiguousAliases: ['恒野'],
  };
  const { questions } = generateQuestions({ brand: specialBrand, count: 24, seed: 3 });
  assert.ok(questions.length > 0);
  assert.ok(
    questions.some((question) => question.text.includes('起号/陪跑')),
    '特殊字符服务名应原样出现在题里',
  );
  for (const question of questions) {
    assert.ok(!question.text.includes('undefined'), `题目出现 undefined：${question.text}`);
    assert.ok(!question.text.includes('null'), `题目出现 null：${question.text}`);
    assert.ok(!question.text.includes('[object'), `题目出现 [object：${question.text}`);
  }
  assert.ok(renderQuestionsMarkdown(questions).includes('起号/陪跑'));
});

test('renderQuestionsMarkdown 按层级分组并标注优先级与意图', () => {
  const { questions } = generateQuestions({ brand, count: 24, seed: 1 });
  const markdown = renderQuestionsMarkdown(questions);
  assert.equal(typeof markdown, 'string');
  assert.ok(markdown.includes('## 认知层'));
  assert.ok(markdown.includes('## 决策层'));
  assert.ok(markdown.includes('## 场景层'));
  assert.match(markdown, /- \[P0\] .+（(?:what|city|compare|price|howto|risk)）/);
  assert.equal(markdown.split('\n').filter((line) => line.startsWith('- [')).length, 24);
});

test('renderQuestionsMarkdown 空数组返回「暂无题目」', () => {
  assert.equal(renderQuestionsMarkdown([]), '暂无题目');
  assert.equal(renderQuestionsMarkdown(null), '暂无题目');
  assert.equal(renderQuestionsMarkdown(undefined), '暂无题目');
});

test('无 brand / 空对象也不抛错', () => {
  for (const options of [undefined, {}, { brand: null }, { brand: {} }]) {
    let result;
    assert.doesNotThrow(() => {
      result = generateQuestions(options);
    });
    assert.ok(Array.isArray(result.questions));
    assert.ok(Array.isArray(result.warnings));
  }
});

test('count=0 返回空题目，渲染显示「暂无题目」', () => {
  const { questions, warnings } = generateQuestions({ brand, count: 0 });
  assert.deepEqual(questions, []);
  assert.ok(Array.isArray(warnings));
  assert.equal(renderQuestionsMarkdown(questions), '暂无题目');
});
