// 测试：每天一个 GEO 案例（行业画像、内容包、合规、30 天日历）
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASE_INDUSTRIES, buildCaseStudy, buildCasePlan, renderCaseMarkdown, profileOf } from '../lib/case-series.js';

test('行业清单：30 个、不重复、含家政', () => {
  assert.equal(CASE_INDUSTRIES.length, 30);
  assert.equal(new Set(CASE_INDUSTRIES).size, 30);
  assert.ok(CASE_INDUSTRIES.includes('家政'));
});

test('行业画像：已登记行业用专属问题，未登记用通用模板', () => {
  assert.ok(profileOf('家政').questions.some((q) => q.includes('家政')));
  assert.ok(profileOf('洗衣店').questions[0].includes('洗衣店'));
  assert.equal(profileOf('').industry, '家政');
});

test('内容包：六段口播 + 六条分镜 + 三件事', () => {
  const c = buildCaseStudy({ industry: '家政' });
  assert.equal(c.narration.length, 6);
  assert.equal(c.shots.length, 6);
  assert.equal(c.actions.length, 3);
  assert.equal(c.durationSec, 45);
});

test('口播时间轴从 0 开始、到 45s 结束，且首段是钩子', () => {
  const c = buildCaseStudy({ industry: '家政' });
  assert.match(c.narration[0].t, /^0-/);
  assert.equal(c.narration[0].text, c.hook);
  assert.match(c.narration.at(-1).t, /-45s$/);
});

test('合规：默认示例口径必须明说「示例」，不冒充真实客户', () => {
  const c = buildCaseStudy({ industry: '家政' });
  assert.equal(c.mode, 'demo');
  assert.match(c.resultLine, /示例口径/);
  assert.match(c.compliance.note, /示例/);
});

test('合规：真实数据模式生成真实口径文案', () => {
  const c = buildCaseStudy({
    industry: '家政',
    mode: 'real',
    metrics: { mentionRateBefore: 0, mentionRateAfter: 40, ownCitationsBefore: 0, ownCitationsAfter: 3, days: 60 },
  });
  assert.equal(c.mode, 'real');
  assert.match(c.resultLine, /真实口径/);
  assert.match(c.resultLine, /40%/);
  assert.match(c.resultLine, /60 天/);
});

test('合规：文案不用绝对化用语（最好/第一/保证/100%）', () => {
  const c = buildCaseStudy({ industry: '家政' });
  const text = JSON.stringify(c);
  for (const word of ['最好', '第一名', '保证', '100%']) assert.equal(text.includes(word), false, `出现了 ${word}`);
});

test('平台文案：抖音/小红书/视频号三段都在，且小红书带诊断引导', () => {
  const c = buildCaseStudy({ industry: '家政' });
  assert.ok(c.platforms.douyin && c.platforms.xiaohongshu && c.platforms.video_account);
  assert.match(c.platforms.xiaohongshu, /诊断/);
});

test('30 天日历：日期连续、行业不重复', () => {
  const plan = buildCasePlan({ days: 30, startDate: new Date('2026-10-27T00:00:00Z') });
  assert.equal(plan.length, 30);
  assert.equal(plan[0].date, '2026-10-27');
  assert.equal(plan[1].date, '2026-10-28');
  assert.equal(new Set(plan.map((p) => p.industry)).size, 30);
});

test('日历边界：请求超过行业数时截断，最小 1 天', () => {
  assert.equal(buildCasePlan({ days: 999 }).length, 30);
  assert.equal(buildCasePlan({ days: 0 }).length, 1);
});

test('渲染 Markdown：九个部分齐全', () => {
  const md = renderCaseMarkdown(buildCaseStudy({ industry: '家政' }));
  for (const section of ['# ', '3 秒钩子', '问题', '做了哪三件事', '结果', '口播稿', '分镜', '封面与话题', '平台注意', '合规提醒']) {
    assert.ok(md.includes(section), `缺少 ${section}`);
  }
});

test('确定性：同输入内容一致（除 generatedAt）', () => {
  const a = buildCaseStudy({ industry: '装修' });
  const b = buildCaseStudy({ industry: '装修' });
  const strip = (c) => ({ ...c, generatedAt: '' });
  assert.deepEqual(strip(a), strip(b));
});
