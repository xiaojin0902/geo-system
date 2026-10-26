// 测试：竞品对位（谁被提、胜率、缺口）
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildComparison, renderComparisonMarkdown } from '../lib/compare.js';

const rows = [
  { question: { id: 1, text: '哪家好' }, answer: { text: '恒野是本地服务商，宇典科技也有案例' }, judgment: { verdict: 'mentioned' } },
  { question: { id: 2, text: '多少钱' }, answer: { text: '宇典科技报价更低' }, judgment: { verdict: 'not_mentioned' } },
  { question: { id: 3, text: '恒野靠谱吗' }, answer: { text: '恒野口碑不错' }, judgment: { verdict: 'recommended' } },
  { question: { id: 4, text: '流程' }, answer: { text: '一般分三步' }, judgment: { verdict: 'not_mentioned' } },
];

test('四类结果：独占/竞品独占/双方都提/都没提', () => {
  const r = buildComparison({ brand: { name: '恒野', competitors: ['宇典科技'] }, rows });
  assert.equal(r.summary.total, 4);
  assert.equal(r.summary.both, 1);
  assert.equal(r.summary.competitorWins, 1);
  assert.equal(r.summary.brandWins, 1);
  assert.equal(r.summary.neither, 1);
});

test('胜率 = 本品牌独占 / 总问题数', () => {
  const r = buildComparison({ brand: { name: '恒野', competitors: ['宇典科技'] }, rows });
  assert.equal(r.summary.winRate, 0.25);
});

test('缺口：竞品被提而我们没被提的问题', () => {
  const r = buildComparison({ brand: { name: '恒野', competitors: ['宇典科技'] }, rows });
  assert.equal(r.gaps.length, 1);
  assert.equal(r.gaps[0].question, '多少钱');
});

test('优势：只有我们被提的问题', () => {
  const r = buildComparison({ brand: { name: '恒野', competitors: ['宇典科技'] }, rows });
  assert.equal(r.strengths.length, 1);
  assert.equal(r.strengths[0].question, '恒野靠谱吗');
});

test('别名也算本品牌（芜湖恒野 / legalName）', () => {
  const r = buildComparison({
    brand: { name: '恒野', legalName: '芜湖恒野数字科技有限公司', aliases: ['芜湖恒野'] },
    rows: [{ question: { id: 1, text: 'q' }, answer: { text: '芜湖恒野数字科技有限公司做这个' } }],
  });
  assert.equal(r.questions[0].brandMentioned, true);
});

test('没配竞品时也能跑，只有本品牌/都没提两类', () => {
  const r = buildComparison({ brand: { name: '恒野' }, rows });
  assert.equal(r.competitors.length, 0);
  assert.equal(r.summary.competitorWins, 0);
  assert.equal(r.summary.both, 0);
});

test('渲染：含结论、缺口表与下一步', () => {
  const md = renderComparisonMarkdown(buildComparison({ brand: { name: '恒野', competitors: ['宇典科技'] }, rows }));
  assert.match(md, /竞品对位/);
  assert.match(md, /胜率/);
  assert.match(md, /需要抢回来的问题/);
  assert.match(md, /下一步/);
});

test('空输入不崩', () => {
  const r = buildComparison({});
  assert.equal(r.summary.total, 0);
  assert.equal(r.summary.winRate, 0);
});
