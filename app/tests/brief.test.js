/**
 * brief.js 自测（content-brief 负责）
 * 重点覆盖「证据优先」：mustIncludeFacts 只能来自品牌配置，
 * 没有证据时必须出现「待补充可验证事实」，禁止编造数字/案例/资质/排名。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBrief, renderBriefMarkdown, DEFAULT_BANNED, FORMATS } from '../lib/brief.js';

const brand = JSON.parse(readFileSync(new URL('../brands/hengye.json', import.meta.url), 'utf8'));
const questions = JSON.parse(readFileSync(new URL('../brands/hengye-questions.json', import.meta.url), 'utf8'));
const priceQuestion = questions.find((item) => /多少钱|价格/.test(item.text)) || questions[0];

/** mustIncludeFacts 里出现的数字，必须能在品牌配置原文里找到（禁止凭空生成） */
function assertNumbersComeFromBrand(facts, sourceBrand) {
  const brandJson = JSON.stringify(sourceBrand);
  for (const fact of facts) {
    if (String(fact).includes('待补充')) continue;
    for (const number of String(fact).match(/\d+/g) || []) {
      assert.ok(brandJson.includes(number), `事实里的数字 ${number} 不在品牌配置中：${fact}`);
    }
  }
}

test('buildBrief：基本字段齐全、证据来自品牌配置', () => {
  const brief = buildBrief({ brand, question: priceQuestion });

  assert.ok(brief.title.length > 0);
  assert.ok(FORMATS.includes(brief.format), `format 非法：${brief.format}`);
  assert.equal(brief.targetQuestion, priceQuestion.text);
  assert.ok(brief.searchIntent.includes('意图'));
  assert.ok(Array.isArray(brief.mustIncludeFacts));
  assert.ok(brief.mustIncludeFacts.length >= 3, '至少要有品牌基础事实');
  assert.ok(brief.mustIncludeFacts.some((fact) => String(fact).startsWith('[品牌基础字段]')));
  assert.ok(brief.mustIncludeFacts.some((fact) => String(fact).includes(brand.evidenceFacts[0]) || String(fact).startsWith('[evidenceFacts]')));
  assertNumbersComeFromBrand(brief.mustIncludeFacts, brand);

  for (const word of DEFAULT_BANNED) assert.ok(brief.banned.includes(word), `禁用词缺少：${word}`);
  for (const word of brand.contentRules.bannedWords) assert.ok(brief.banned.includes(word));
  assert.equal(new Set(brief.banned).size, brief.banned.length, '禁用词不应重复');
});

test('outline：3-6 个 H2、每节 2-4 个要点、必须含「证据与来源」', () => {
  for (const question of [priceQuestion, questions[0], questions.find((item) => item.intent === '避坑') || questions[2]]) {
    const brief = buildBrief({ brand, question });
    assert.ok(brief.outline.length >= 3 && brief.outline.length <= 6, `H2 数量越界：${brief.outline.length}`);
    for (const section of brief.outline) {
      assert.equal(typeof section.h2, 'string');
      assert.ok(section.h2.length > 0);
      assert.ok(Array.isArray(section.points));
      assert.ok(section.points.length >= 2 && section.points.length <= 4, `要点数量越界：${section.h2}`);
    }
    assert.ok(
      brief.outline.some((section) => section.h2.includes('证据') && section.h2.includes('来源')),
      '缺少「证据与来源」小节',
    );
  }
});

test('evidenceRequirements / factCheckList / distribution 符合硬要求', () => {
  const brief = buildBrief({ brand, question: priceQuestion });
  assert.ok(brief.evidenceRequirements.length >= 5);
  assert.ok(brief.evidenceRequirements.every((item) => typeof item === 'string' && item.trim().length > 0));
  assert.ok(brief.evidenceRequirements.some((item) => item.includes('待补充可验证事实')));
  assert.ok(brief.evidenceRequirements.some((item) => item.includes('来源')));
  assert.ok(brief.factCheckList.length >= 4);
  assert.ok(brief.factCheckList.some((item) => item.includes('禁用词')));

  assert.ok(brief.distribution.length >= 2 && brief.distribution.length <= 3);
  for (const item of brief.distribution) {
    assert.ok(item.channel);
    assert.ok(item.note.includes('回填 URL'), '分发建议必须要求回填 URL');
  }
});

test('lastRunStats：带上诊断基线，样本不足时明确说明', () => {
  const brief = buildBrief({
    brand,
    question: priceQuestion,
    lastRunStats: { total: null, level: '样本不足', coverage: { planned: 12, ok: 5, ratio: 5 / 12 } },
  });
  const joined = brief.evidenceRequirements.join('\n');
  assert.ok(joined.includes('5/12'));
  assert.ok(joined.includes('样本不足'));
  assert.ok(joined.includes('回填 URL'));

  const briefWithScore = buildBrief({
    brand,
    question: priceQuestion,
    lastRunStats: { total: 62.4, level: '中等', coverage: { planned: 20, ok: 16, ratio: 0.8 } },
  });
  assert.ok(briefWithScore.evidenceRequirements.join('\n').includes('62.4'));
});

test('证据不足：evidenceFacts 为空时必须写「待补充可验证事实」，且不编造数字', () => {
  const emptyEvidenceBrand = { ...brand, evidenceFacts: [] };
  const brief = buildBrief({ brand: emptyEvidenceBrand, question: priceQuestion });
  assert.ok(
    brief.mustIncludeFacts.some((fact) => String(fact).includes('待补充可验证事实')),
    '没有 evidenceFacts 时必须显式标「待补充可验证事实」',
  );
  assertNumbersComeFromBrand(brief.mustIncludeFacts, emptyEvidenceBrand);
  assert.ok(!brief.mustIncludeFacts.some((fact) => /服务过\s*\d+\s*(家|个)|客户案例[:：]\s*\d+|行业第一|排名第[一二三\d]/.test(fact)));
});

test('renderBriefMarkdown：结构完整、无 OmniRank、无 undefined', () => {
  const brief = buildBrief({ brand, question: priceQuestion });
  const markdown = renderBriefMarkdown(brief);

  assert.ok(markdown.includes(`# ${brief.title}`));
  assert.ok(markdown.includes(`目标问题：${priceQuestion.text}`));
  assert.ok(markdown.includes('必须引用的可验证事实'));
  assert.ok(markdown.includes('证据要求'));
  assert.ok(markdown.includes('文章结构'));
  assert.ok(markdown.includes('证据与来源'));
  assert.ok(markdown.includes('禁用词'));
  assert.ok(markdown.includes('事实核查清单'));
  assert.ok(markdown.includes('分发与归因'));
  assert.ok(markdown.includes('回填 URL'));
  assert.ok(markdown.includes('恒野 GEO 自研版'));
  assert.ok(markdown.includes('证据优先'));
  assert.ok(!markdown.includes('OmniRank'));
  assert.ok(!markdown.includes('undefined'));
  assert.ok(!markdown.includes('null'));
});

test('兼容字符串形式的 question / keyword，且 keyword.cluster 优先', () => {
  const brief = buildBrief({
    brand,
    question: '芜湖哪家内容代运营靠谱',
    keyword: { term: '芜湖内容代运营', cluster: '本地推荐' },
  });
  assert.equal(brief.format, '清单');
  assert.equal(brief.targetQuestion, '芜湖哪家内容代运营靠谱');
  assert.ok(brief.title.includes('内容代运营'));
  assert.ok(brief.outline.some((section) => section.h2.includes('清单') || section.h2.includes('证据')));
  const markdown = renderBriefMarkdown(brief);
  assert.ok(markdown.includes('本地推荐'));
});
