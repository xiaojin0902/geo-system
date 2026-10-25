/**
 * writer.js 自测（content-brief 负责，SPEC §3.10）
 * 覆盖：
 * - buildWritingPrompt 拼装（含 mustIncludeFacts / banned / outline）
 * - 模板模式（engine=null / 不可用 / 抛错）→ 骨架含全部 H2、事实与来源、待补占位、0 违规
 * - LLM 模式（假 engine）→ mode='llm'、prompt 内容、元话语清理
 * - factCheckDraft 四类违规各至少 1 条 + 干净文本通过
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBrief } from '../lib/brief.js';
import { buildWritingPrompt, factCheckDraft, generateDraft } from '../lib/writer.js';

const brand = JSON.parse(readFileSync(new URL('../brands/hengye.json', import.meta.url), 'utf8'));

/** 用真实品牌 + 无数字的题目生成一份干净 brief（避免模板骨架里出现无依据数字） */
function cleanBrief() {
  const question = { text: '恒野是做什么的', intent: '发现', tier: 'brand_awareness', priority: 'P0' };
  return { brief: buildBrief({ brand, question }), question };
}

function priceBrief() {
  const question = { text: '起号陪跑多少钱', intent: '价格', tier: 'super_tier1', priority: 'P0' };
  return { brief: buildBrief({ brand, question }), question };
}

/** 收集文本里的阿拉伯数字（含千分位），用于断言模板没有凭空数字 */
function numberTokens(text) {
  return (String(text).match(/\d[\d,]*/g) || []).map((token) => token.replace(/,/g, ''));
}

/** brief 已给出的数字集合 */
function sourcedNumberSet(brief) {
  const set = new Set();
  for (const fact of brief.mustIncludeFacts || []) {
    for (const token of fact.match(/\d[\d,]*/g) || []) set.add(token.replace(/,/g, ''));
  }
  return set;
}

test('buildWritingPrompt：system/user 含事实、禁用词、大纲与输出红线', () => {
  const { brief, question } = priceBrief();
  const { system, user } = buildWritingPrompt({ brand, brief, question });

  assert.equal(typeof system, 'string');
  assert.equal(typeof user, 'string');
  assert.ok(system.includes('只能使用'));
  assert.ok(system.includes('绝对化'));
  assert.ok(system.includes('不知道') || system.includes('待补充'));
  assert.ok(user.includes('恒野') || user.includes(brand.legalName));
  assert.ok(user.includes('起号陪跑多少钱'));
  assert.ok(user.includes('必须引用的可验证事实'));
  // mustIncludeFacts 原样进入 prompt
  for (const fact of brief.mustIncludeFacts) assert.ok(user.includes(fact), `prompt 缺少事实：${fact}`);
  // banned 词表进入 prompt
  for (const word of brief.banned) assert.ok(user.includes(word), `prompt 缺少禁用词：${word}`);
  // outline 的 H2 进入 prompt
  for (const section of brief.outline) assert.ok(user.includes(section.h2), `prompt 缺少小节：${section.h2}`);
  assert.ok(user.includes('事实与来源') || user.includes('证据与来源'));
  assert.ok(!user.includes('undefined'));
});

test('模板模式：含 outline 全部 H2、事实与来源、待补占位，且事实核查 0 违规', async () => {
  const { brief, question } = cleanBrief();
  const draft = await generateDraft({ brand, brief, question, engine: null });

  assert.equal(draft.mode, 'template');
  assert.equal(draft.engineId, null);
  assert.ok(Array.isArray(draft.warnings));
  assert.ok(draft.warnings.length >= 1);

  for (const section of brief.outline) {
    assert.ok(draft.text.includes(section.h2), `模板缺少 outline 小节：${section.h2}`);
  }
  assert.ok(draft.text.includes('事实与来源'));
  assert.ok(draft.text.includes('（待补'));

  // mustIncludeFacts 原样列出
  for (const fact of brief.mustIncludeFacts) assert.ok(draft.text.includes(fact), `模板缺少事实：${fact}`);

  // 不得编造：没有案例式表述，数字全部来自 brief 已给出的事实
  assert.ok(!/我们服务了|我们帮助|我们的客户|客户案例/.test(draft.text));
  const allowed = sourcedNumberSet(brief);
  for (const token of numberTokens(draft.text)) {
    assert.ok(allowed.has(token), `模板出现无依据数字：${token}`);
  }

  const check = factCheckDraft({ text: draft.text, brief, brand });
  assert.equal(check.passed, true, `模板模式不应违规：${JSON.stringify(check.violations)}`);
  assert.equal(check.violations.length, 0);
  assert.ok(check.wordCount > 0);
});

test('模板模式：engine 不可用 / 抛出异常 / 缺 ask 都回退模板且不抛错', async () => {
  const { brief, question } = cleanBrief();

  const unavailable = {
    id: 'deepseek',
    async ask() {
      return { text: '', status: 'unavailable', error: '未配置 DEEPSEEK_API_KEY' };
    },
  };
  const draftA = await generateDraft({ brand, brief, question, engine: unavailable });
  assert.equal(draftA.mode, 'template');
  assert.equal(draftA.engineId, 'deepseek');
  assert.ok(draftA.warnings.join('\n').includes('回退模板'));

  const broken = {
    id: 'broken',
    async ask() {
      throw new Error('网络超时');
    },
  };
  const draftB = await generateDraft({ brand, brief, question, engine: broken });
  assert.equal(draftB.mode, 'template');
  assert.ok(draftB.warnings.join('\n').includes('调用失败'));

  const noAsk = { id: 'no-ask', label: '无 ask 方法' };
  const draftC = await generateDraft({ brand, brief, question, engine: noAsk });
  assert.equal(draftC.mode, 'template');
  assert.ok(draftC.warnings.join('\n').includes('缺少 ask'));
});

test('LLM 模式：假 engine 收到含 banned / mustIncludeFacts 的 prompt，返回 mode=llm', async () => {
  const { brief, question } = cleanBrief();
  let captured = null;
  const fake = {
    id: 'fake',
    async ask(prompt, options) {
      captured = { prompt, options };
      return {
        text: '# 恒野是做什么的\n\n恒野是芜湖的内容工作室（来源：品牌自述）。\n\n## 证据与来源\n\n- 见 brief（来源：品牌官网）。',
        citations: [],
        status: 'ok',
      };
    },
  };

  const draft = await generateDraft({ brand, brief, question, engine: fake });
  assert.equal(draft.mode, 'llm');
  assert.equal(draft.engineId, 'fake');
  assert.ok(draft.text.includes('# 恒野是做什么的'));
  assert.ok(captured);
  assert.equal(captured.options.brand, brand);
  for (const fact of brief.mustIncludeFacts) assert.ok(captured.prompt.includes(fact));
  for (const word of brief.banned) assert.ok(captured.prompt.includes(word));
  assert.ok(captured.prompt.includes('绝对化'));
});

test('LLM 模式：清理「作为一个 AI」等元话语，并提示缺小节', async () => {
  const { brief, question } = cleanBrief();
  const fake = {
    id: 'fake-meta',
    async ask() {
      return {
        text: '作为一个 AI 语言模型，我无法保证效果。\n\n# 草稿标题\n\n正文第一句。作为一个 AI，我不能给承诺。\n\n（来源：品牌官网）',
        status: 'ok',
      };
    },
  };
  const draft = await generateDraft({ brand, brief, question, engine: fake });
  assert.equal(draft.mode, 'llm');
  assert.ok(!draft.text.includes('作为一个 AI'));
  assert.ok(draft.text.includes('# 草稿标题'));
  assert.ok(draft.warnings.join('\n').includes('元话语'));
  assert.ok(draft.warnings.join('\n').includes('缺少小节'));
});

test('LLM 草稿违规时：generateDraft 的 warnings 会提示事实核查条数', async () => {
  const { brief, question } = cleanBrief();
  const fake = {
    id: 'fake-bad',
    async ask() {
      return { text: '# 标题\n\n我们保证行业第一。\n', status: 'ok' };
    },
  };
  const draft = await generateDraft({ brand, brief, question, engine: fake });
  assert.equal(draft.mode, 'llm');
  assert.ok(draft.warnings.some((warning) => warning.includes('事实核查发现')));
});

test('模板标题兜底：题目自带「保证/第一」时改中性标题，模板仍是 0 违规', async () => {
  const question = { text: '代运营说保证涨粉，可信吗？', intent: '避坑', tier: 'super_tier1', priority: 'P1' };
  const brief = buildBrief({ brand, question });
  const draft = await generateDraft({ brand, brief, question, engine: null });

  assert.equal(draft.mode, 'template');
  assert.ok(!draft.text.split('\n')[0].includes('保证'), '模板标题不应复述绝对化表述');
  assert.ok(draft.warnings.join('\n').includes('中性标题'));
  const check = factCheckDraft({ text: draft.text, brief, brand });
  assert.equal(check.passed, true, JSON.stringify(check.violations));
});

test('真实 99 条题目：模板模式草稿全部 0 违规', async () => {
  const questions = JSON.parse(readFileSync(new URL('../brands/hengye-questions.json', import.meta.url), 'utf8'));
  const failures = [];
  for (const question of questions) {
    const brief = buildBrief({ brand, question });
    const draft = await generateDraft({ brand, brief, question, engine: null });
    const check = factCheckDraft({ text: draft.text, brief, brand });
    if (!check.passed) failures.push(`${question.text} → ${check.violations.map((item) => item.type).join(',')}`);
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('factCheckDraft：banned_word 命中品牌禁用词', () => {
  const { brief } = cleanBrief();
  const result = factCheckDraft({ text: '我们提供包成交服务。', brief, brand });
  assert.ok(result.violations.some((item) => item.type === 'banned_word'));
  assert.equal(result.passed, false);
  assert.ok(result.violations.every((item) => item.detail && item.snippet));
});

test('factCheckDraft：absolute 命中绝对化用语（含「最好/第一」）', () => {
  const { brief } = cleanBrief();
  const result = factCheckDraft({ text: '我们是行业最好的内容团队。', brief, brand });
  const absolute = result.violations.filter((item) => item.type === 'absolute');
  assert.ok(absolute.length >= 1);
  assert.ok(absolute.some((item) => item.detail.includes('最好')));

  const first = factCheckDraft({ text: '这家公司排名第一。', brief, brand });
  assert.ok(first.violations.some((item) => item.type === 'absolute'));
  // 「第一次/第一步」不是绝对化用语，不能误伤
  const notAbsolute = factCheckDraft({ text: '第一次合作前先做诊断，第一步是确认目标。', brief, brand });
  assert.ok(!notAbsolute.violations.some((item) => item.type === 'absolute'));
});

test('factCheckDraft：unsourced_number 命中无来源数字，来自 evidenceFacts 的价格不误伤', () => {
  const { brief } = priceBrief();

  const bad = factCheckDraft({ text: '团队现有 50 人，去年服务客户 200 家。', brief, brand });
  assert.ok(bad.violations.some((item) => item.type === 'unsourced_number'));

  const priceFact = brief.mustIncludeFacts.find((fact) => fact.includes('1,980'));
  assert.ok(priceFact, '测试前提：brief 里应有 1,980 元/月 的价格事实');
  const good = factCheckDraft({ text: `${priceFact}`, brief, brand });
  assert.equal(good.violations.filter((item) => item.type === 'unsourced_number').length, 0, 'evidenceFacts 里的价格不算违规');

  const withSource = factCheckDraft({ text: '团队现有 50 人（来源：品牌官网团队页）。', brief, brand });
  assert.equal(withSource.violations.filter((item) => item.type === 'unsourced_number').length, 0);
});

test('factCheckDraft：fabricated_case 命中无授权案例，带授权标记不误伤', () => {
  const { brief } = cleanBrief();
  const bad = factCheckDraft({ text: '我们的客户用了三个月，账号做到 10 万粉。', brief, brand });
  assert.ok(bad.violations.some((item) => item.type === 'fabricated_case'));

  const authorized = factCheckDraft({ text: '（已获客户书面授权）我们的客户完成了起号。', brief, brand });
  assert.equal(authorized.violations.filter((item) => item.type === 'fabricated_case').length, 0);
});

test('factCheckDraft：干净文本通过，wordCount 为非空白字符数', () => {
  const { brief } = priceBrief();
  const text = `${brief.mustIncludeFacts.find((fact) => fact.includes('1,980'))}（来源：品牌官网价格表）。`;
  const result = factCheckDraft({ text, brief, brand });
  assert.equal(result.passed, true, JSON.stringify(result.violations));
  assert.equal(result.violations.length, 0);
  assert.equal(result.wordCount, Array.from(text.replace(/\s+/g, '')).length);
  assert.ok(result.wordCount > 0);
});

test('边界：空文本 / 缺省参数不抛错', () => {
  const empty = factCheckDraft({ text: '', brief: {}, brand: {} });
  assert.equal(empty.passed, true);
  assert.equal(empty.wordCount, 0);
  assert.deepEqual(empty.violations, []);

  const missing = factCheckDraft();
  assert.equal(missing.passed, true);

  const prompt = buildWritingPrompt();
  assert.equal(typeof prompt.system, 'string');
  assert.equal(typeof prompt.user, 'string');
});
