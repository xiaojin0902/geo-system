/**
 * keywords.js 自测（content-brief 负责）
 * 覆盖：8 簇齐全、字段形状、difficulty 启发式、优先级、确定性、去重、模板兜底、簇判定。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expandKeywords, classifyCluster, difficultyOf, CLUSTERS, templateKeywords } from '../lib/keywords.js';

const brand = JSON.parse(readFileSync(new URL('../brands/hengye.json', import.meta.url), 'utf8'));
const questions = JSON.parse(readFileSync(new URL('../brands/hengye-questions.json', import.meta.url), 'utf8'));

test('真实题目种子：8 类簇齐全、字段合法、term 不重复', () => {
  const result = expandKeywords({ brand, questions });
  assert.ok(Array.isArray(result));
  assert.ok(result.length > 0);

  const clusters = new Set(result.map((item) => item.cluster));
  for (const cluster of CLUSTERS) {
    assert.ok(clusters.has(cluster), `缺少簇：${cluster}`);
  }

  const terms = new Set();
  for (const item of result) {
    assert.equal(typeof item.term, 'string');
    assert.ok(item.term.trim().length > 0);
    assert.ok(CLUSTERS.includes(item.cluster), `未知簇：${item.cluster}`);
    assert.equal(typeof item.intent, 'string');
    assert.ok(item.intent.length > 0);
    assert.ok(Number.isInteger(item.difficulty));
    assert.ok(item.difficulty >= 1 && item.difficulty <= 5, `difficulty 越界：${item.difficulty}`);
    assert.ok(['P0', 'P1', 'P2'].includes(item.priority), `priority 非法：${item.priority}`);
    assert.equal(typeof item.note, 'string');
    assert.ok(item.note.length > 0);
    assert.ok(!terms.has(item.term), `term 重复：${item.term}`);
    terms.add(item.term);
  }
});

test('确定性：同一输入两次输出完全一致', () => {
  const first = expandKeywords({ brand, questions });
  const second = expandKeywords({ brand, questions });
  assert.deepEqual(first, second);
});

test('difficulty 启发式：基础 1，地名/推荐/价格/长句各 +1 并 clamp', () => {
  const target = '芜湖内容代运营推荐多少钱'; // 地名+推荐+价格，恰好 12 字不算长句
  const { difficulty, reasons } = difficultyOf(target, brand);
  assert.equal(difficulty, 4);
  assert.deepEqual(reasons.sort(), ['含价格词', '含推荐/排名词', '含本地地名'].sort());

  assert.equal(difficultyOf('恒野是做什么的', brand).difficulty, 1);
  assert.equal(difficultyOf('GEO 是什么', brand).difficulty, 1);

  // 超长 + 全部信号，clamp 到 5
  const extreme = difficultyOf('芜湖本地内容代运营公司推荐排名以及价格收费标准到底是多少钱一个月', brand);
  assert.equal(extreme.difficulty, 5);

  // 结果里所有 difficulty 都是整数且在 1-5
  for (const item of expandKeywords({ brand, questions })) {
    assert.ok(Number.isInteger(item.difficulty));
    assert.ok(item.difficulty >= 1 && item.difficulty <= 5);
  }
});

test('簇判定：典型问法落到正确簇', () => {
  const cases = [
    ['恒野和叁人行是什么关系', '竞品替代'],
    ['芜湖本地内容代运营推荐哪家好', '本地推荐'],
    ['内容代运营多少钱一个月', '价格费用'],
    ['内容代运营有哪些坑', '避坑风险'],
    ['内容代运营合作流程是怎样的', '流程交付'],
    ['内容代运营和起号陪跑有什么区别', '对比选择'],
    ['怎么让 AI 搜索推荐我的品牌', 'GEO认知'],
    ['恒野是做什么的', '品牌实体'],
    ['恒野的团队有多少人', '品牌实体'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(classifyCluster(text, brand), expected, `${text} 应属于 ${expected}`);
  }
});

test('没有题目种子时：用品牌配置生成模板，仍覆盖 8 簇', () => {
  const result = expandKeywords({ brand, questions: [] });
  assert.equal(result.length, 8);
  assert.deepEqual(new Set(result.map((item) => item.cluster)), new Set(CLUSTERS));
  for (const item of result) {
    assert.ok(item.term.includes(brand.name) || item.term.includes(brand.city) || item.term.length > 0);
    assert.ok(item.note.includes('模板生成'));
  }

  const templates = templateKeywords(brand);
  assert.equal(templates.length, 8);
  assert.ok(templates.every((item) => item.generated === true));
});

test('去重：同一题目（含标点差异）只产出一条 term', () => {
  const result = expandKeywords({
    brand,
    questions: [{ text: '恒野是做什么的' }, { text: '恒野是做什么的？' }, '恒野是做什么的'],
  });
  const terms = result.map((item) => item.term);
  assert.equal(new Set(terms).size, terms.length);
  assert.equal(terms.filter((term) => term === '恒野是做什么的').length, 1);
  // 其余簇由模板补齐
  assert.equal(new Set(result.map((item) => item.cluster)).size, 8);
});

test('空输入不抛错，输出为空数组', () => {
  assert.deepEqual(expandKeywords(), []);
  assert.deepEqual(expandKeywords({ brand: {}, questions: null }), []);
});
