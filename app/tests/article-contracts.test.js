/**
 * article-contracts.js 自测
 *
 * 覆盖三份合同，重点在「边界」与「联动」：
 * - 篇幅五档边界（1199 / 1200 / 1799 / 1800 / 3000 / 3001 / 4500 / 4501）；
 * - 客户存在感：提及次数、首段命中、标题命中、别名与全称不重复计数；
 * - 标题治理：长度 / 承诺词 / 绝对化 / 重复 / 意图 / 标题党 六类；
 * - applyContracts 联动，以及 fixes 是否可执行（每条都得带数字或具体词）；
 * - renderContractsMarkdown 的四节结构（通过时阻断项必须写「无」）；
 * - 纯函数：同输入两次调用 deepEqual、且不改入参。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LENGTH_CONTRACT,
  TITLE_RULES,
  checkLength,
  checkClientPresence,
  reviewTitle,
  applyContracts,
  renderContractsMarkdown,
} from '../lib/article-contracts.js';

const brand = JSON.parse(readFileSync(new URL('../brands/hengye.json', import.meta.url), 'utf8'));

/** 与实现同口径的「中文字符」：去掉全部空白 */
function countChars(text) {
  return Array.from(String(text).replace(/\s+/g, '')).length;
}

/** 无空白的填充句：保证 padExact 里 slice 之后的字数就是对外的 chars */
const FILLER = '选题要落到真实问题，交付要写清交付物与验收口径，报价要说明适用范围，不用效果承诺代替可核对的动作。';

/** 造一段精确 chars 字的正文（lead 不能含空白，且长度要小于 chars） */
function padExact(lead, chars) {
  let text = lead;
  while (text.length < chars) text += FILLER;
  return text.slice(0, chars);
}

/** 必须通过的稿件：首段点名品牌、正文 3 次提及、标题带品牌且关键词对齐 */
function compliantDraft() {
  const body = [
    '恒野先说结论：内容代运营值不值，看交付物与验收口径。',
    '恒野的交付物包括选题、脚本、拍摄、发布与复盘，排期写在合同里。',
    '恒野的服务范围是全国线上交付，芜湖与合肥可到店。',
    padExact('补充说明：', 2000),
  ].join('\n\n');
  return {
    title: '恒野内容代运营怎么选：5 个判断标准',
    body,
    brand,
    brief: { term: '内容代运营' },
    existingTitles: ['起号陪跑多少钱'],
  };
}

/** 样例稿：900 字、品牌只出现 1 次、标题含「保证」 */
function brokenDraft() {
  return {
    title: '恒野内容代运营：保证涨粉的稳妥选择',
    body: padExact('恒野是一家芜湖的内容工作室，先把选题与交付写清楚，再谈效果。', 900),
    brand,
    brief: { term: '内容代运营' },
    existingTitles: [],
  };
}

test('LENGTH_CONTRACT / TITLE_RULES：数值与合同一致且被冻结', () => {
  assert.deepEqual({ ...LENGTH_CONTRACT }, { min: 1200, max: 4500, idealMin: 1800, idealMax: 3000 });
  assert.ok(Object.isFrozen(LENGTH_CONTRACT), '篇幅合同应冻结，避免运行时被改');
  assert.ok(Object.isFrozen(TITLE_RULES), '标题规则应冻结');
  assert.ok(Object.isFrozen(TITLE_RULES.promiseWords));
  assert.equal(TITLE_RULES.maxLength, 30);
  assert.deepEqual([...TITLE_RULES.promiseWords], ['保证', '一定', '100%', '立刻', '马上', '永久', '绝无']);
  assert.deepEqual([...TITLE_RULES.blacklistWords], ['最好', '第一', '唯一', '顶级', '稳赚', '绝对']);
  assert.deepEqual([...TITLE_RULES.clickbaitWords], ['揭秘', '震惊', '必看']);
});

test('checkLength：五档边界逐字判定', () => {
  const cases = [
    [1199, '过短', false],
    [1200, '偏短', true],
    [1799, '偏短', true],
    [1800, '合规', true],
    [3000, '合规', true],
    [3001, '偏长', true],
    [4500, '偏长', true],
    [4501, '过长', false],
  ];
  for (const [chars, level, ok] of cases) {
    const result = checkLength({ body: padExact('篇幅边界：', chars) });
    assert.equal(result.chars, chars, `字数应为 ${chars}`);
    assert.equal(result.level, level, `${chars} 字应判「${level}」`);
    assert.equal(result.ok, ok, `${chars} 字的 ok 应为 ${ok}`);
    assert.ok(result.message.includes(String(chars)), '提示里要带当前字数');
  }
  // 边界值本身也要自洽：min 是「不再算过短」的第一档
  assert.equal(checkLength({ body: padExact('边界：', LENGTH_CONTRACT.min) }).level, '偏短');
  assert.equal(checkLength({ body: padExact('边界：', LENGTH_CONTRACT.max) }).level, '偏长');
  // 0 字与完全不传参数都不能崩
  assert.equal(checkLength().level, '过短');
  assert.equal(checkLength({}).chars, 0);
});

test('checkLength：只数非空白字符，空格换行不计', () => {
  const result = checkLength({ body: '内 容\n代 运 营  ' });
  assert.equal(result.chars, 5);
  assert.equal(result.level, '过短');
  assert.equal(result.ok, false);
  assert.equal(countChars('内 容\n代 运 营  '), 5);
});

test('checkClientPresence：提及不足 2 次不通过，建议写清还差几次', () => {
  const body = `${padExact('恒野是一家芜湖的内容工作室，先说结论。', 600)}\n\n${padExact('恒野的交付物写清服务范围与排期。', 900)}`;
  const result = checkClientPresence({ body, title: '内容代运营怎么选', brand });

  assert.equal(result.mentions, 2);
  assert.equal(result.firstParagraphHit, true);
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('2 次'));
  assert.ok(result.suggestions.some((item) => item.includes('再补 1 次')));
});

test('checkClientPresence：品牌只在后文出现时，首段命中为 false', () => {
  const head = padExact('先说结论：选服务商看交付物与验收口径。', 700);
  const tail = '恒野的服务范围是全国线上交付，恒野的交付物写清排期，恒野的联系方式在文末。';
  const body = `${head}\n\n${tail}`;
  const result = checkClientPresence({ body, title: '内容代运营怎么选', brand });

  assert.equal(result.firstParagraphHit, false);
  assert.equal(result.mentions, 3);
  assert.equal(result.ok, false);
  assert.ok(result.suggestions.some((item) => item.includes('第一段')));
});

test('checkClientPresence：提及足 + 首段命中才 ok；标题未命中不影响 ok', () => {
  const body = '恒野先说结论：内容代运营要按交付物验收。\n\n恒野的服务范围是全国线上交付。\n\n恒野的联系方式在文末。';
  const result = checkClientPresence({ body, title: '内容代运营怎么选：5 个判断标准', brand });

  assert.equal(result.mentions, 3);
  assert.equal(result.firstParagraphHit, true);
  assert.equal(result.ok, true);
  assert.equal(result.titleHit, false);
  assert.equal(result.brandMentionsInTitle, 0);
  assert.deepEqual(result.suggestions, [], '通过时不给建议');

  const titled = checkClientPresence({ body, title: '恒野内容代运营怎么选', brand });
  assert.equal(titled.titleHit, true);
  assert.equal(titled.brandMentionsInTitle, 1);
});

test('checkClientPresence：别名与全称都算提及，全称不被短名重复计数', () => {
  const fullNameOnly = checkClientPresence({
    body: '芜湖恒野数字科技有限公司对外提供内容代运营服务。',
    title: '',
    brand,
  });
  assert.equal(fullNameOnly.mentions, 1, '全称只应算 1 次，不能又被「恒野」重复计一次');

  const mixed = checkClientPresence({
    body: '恒野工作室先说结论。\n\n恒野数字科技负责交付。\n\n芜湖恒野数字科技有限公司在芜湖。',
    title: '恒野工作室',
    brand,
  });
  assert.equal(mixed.mentions, 3);
  assert.equal(mixed.titleHit, true);
  assert.equal(mixed.brandMentionsInTitle, 1);
  assert.equal(mixed.ok, true);
});

test('checkClientPresence：brand 全空时不崩，明确要求补品牌配置', () => {
  const result = checkClientPresence({ body: '正文里没有任何品牌。', title: '标题' });
  assert.equal(result.ok, false);
  assert.equal(result.mentions, 0);
  assert.equal(result.firstParagraphHit, false);
  assert.ok(result.message.includes('品牌名'));
  assert.ok(result.suggestions.length >= 1);
  assert.ok(result.suggestions.join('').includes('name'));
});

test('reviewTitle：超过 30 字是阻断，30 字刚好通过', () => {
  const boundary = reviewTitle({ title: '标'.repeat(30) });
  assert.equal(boundary.issues.filter((item) => item.code === 'title_too_long').length, 0);
  assert.equal(boundary.ok, true);

  const over = reviewTitle({ title: '标'.repeat(31) });
  const issue = over.issues.find((item) => item.code === 'title_too_long');
  assert.ok(issue);
  assert.equal(issue.level, 'blocker');
  assert.ok(issue.message.includes('31'));
  assert.equal(over.ok, false);
  assert.ok(over.suggestions.some((item) => item.includes('1 字')));

  // 真实标题：不带任何禁用词、不带 brief 时应该干净通过
  const natural = reviewTitle({ title: '芜湖内容代运营怎么选：5 个判断标准' });
  assert.equal(natural.ok, true);
  assert.deepEqual(natural.issues, []);
});

test('reviewTitle：承诺词逐个都判阻断', () => {
  for (const word of TITLE_RULES.promiseWords) {
    const result = reviewTitle({ title: `内容代运营${word}有效` });
    const issue = result.issues.find((item) => item.code === 'title_promise_word');
    assert.ok(issue, `「${word}」应判承诺词`);
    assert.equal(issue.level, 'blocker');
    assert.ok(issue.message.includes(word));
    assert.equal(result.ok, false);
    assert.ok(result.suggestions.length >= 1);
  }
});

test('reviewTitle：绝对化黑名单逐个都判阻断，两类同踩出两条', () => {
  for (const word of TITLE_RULES.blacklistWords) {
    const result = reviewTitle({ title: `芜湖内容代运营${word}吗` });
    const issue = result.issues.find((item) => item.code === 'title_blacklist_word');
    assert.ok(issue, `「${word}」应判绝对化`);
    assert.equal(issue.level, 'blocker');
    assert.ok(issue.message.includes(word));
    assert.equal(result.ok, false);
  }

  const both = reviewTitle({ title: '恒野代运营保证做到最好' });
  assert.equal(both.issues.filter((item) => item.level === 'blocker').length, 2);
  assert.ok(both.issues.some((item) => item.code === 'title_promise_word'));
  assert.ok(both.issues.some((item) => item.code === 'title_blacklist_word'));
});

test('reviewTitle：与已有标题重复（去空格/标点后一致）判阻断', () => {
  const result = reviewTitle({
    title: '恒野内容代运营怎么选？',
    existingTitles: ['恒野内容代运营怎么选', '起号陪跑多少钱'],
  });
  const issue = result.issues.find((item) => item.code === 'title_duplicate');
  assert.ok(issue);
  assert.equal(issue.level, 'blocker');
  assert.ok(issue.message.includes('恒野内容代运营怎么选'));
  assert.equal(result.ok, false);

  const different = reviewTitle({
    title: '芜湖内容代运营怎么选：5 个判断标准',
    existingTitles: ['恒野内容代运营怎么选'],
  });
  assert.equal(different.issues.some((item) => item.code === 'title_duplicate'), false);
});

test('reviewTitle：brief 核心词不对齐判提醒，对齐时不报', () => {
  const brief = { term: '芜湖内容代运营', keywords: ['起号陪跑'] };
  const misaligned = reviewTitle({ title: '短视频账号如何快速起量', brief });
  const issue = misaligned.issues.find((item) => item.code === 'title_intent_misaligned');
  assert.ok(issue);
  assert.equal(issue.level, 'warn');
  assert.equal(misaligned.ok, true, '意图不对齐只是提醒，不阻断');
  assert.ok(issue.message.includes('芜湖内容代运营'));
  assert.ok(misaligned.suggestions.some((item) => item.includes('芜湖内容代运营')));

  const aligned = reviewTitle({ title: '芜湖内容代运营怎么选：5 个判断标准', brief });
  assert.equal(aligned.issues.some((item) => item.code === 'title_intent_misaligned'), false);

  // 改写但仍是同一个生意对象：双字覆盖率兜住
  const shortened = reviewTitle({ title: '内容代运营怎么选：3 类交付物', brief });
  assert.equal(shortened.issues.some((item) => item.code === 'title_intent_misaligned'), false);

  // 关键词列表命中任意一个即可
  const keywordAligned = reviewTitle({ title: '起号陪跑多少钱：3 档报价与交付清单', brief });
  assert.equal(keywordAligned.issues.some((item) => item.code === 'title_intent_misaligned'), false);
});

test('reviewTitle：标题党用词判提醒', () => {
  for (const word of TITLE_RULES.clickbaitWords) {
    const result = reviewTitle({ title: `${word}内容代运营的真实报价` });
    const issue = result.issues.find((item) => item.code === 'title_clickbait');
    assert.ok(issue, `「${word}」应判标题党`);
    assert.equal(issue.level, 'warn');
    assert.equal(result.ok, true);
    assert.ok(result.suggestions.length >= 1);
  }
});

test('applyContracts：900 字 + 品牌 1 次 + 标题含「保证」→ 三条阻断与可执行 fixes', () => {
  const result = applyContracts(brokenDraft());

  assert.equal(result.checks.length.chars, 900);
  assert.equal(result.checks.length.level, '过短');
  assert.equal(result.checks.length.ok, false);
  assert.equal(result.checks.presence.mentions, 1);
  assert.equal(result.checks.presence.firstParagraphHit, true);
  assert.equal(result.checks.presence.ok, false);
  assert.equal(result.checks.title.ok, false);

  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((item) => item.startsWith('[length_too_short]')));
  assert.ok(result.blockers.some((item) => item.startsWith('[client_presence]')));
  assert.ok(result.blockers.some((item) => item.startsWith('[title_promise_word]')));
  assert.equal(result.blockers.length, 3);

  assert.ok(result.fixes.some((fix) => fix.includes('900') && fix.includes('1800')));
  assert.ok(result.fixes.some((fix) => fix.includes('1 次') && fix.includes('3 次')));
  assert.ok(result.fixes.some((fix) => fix.includes('保证')));
});

test('applyContracts：合规稿件通过，阻断与提醒均为空', () => {
  const result = applyContracts(compliantDraft());

  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.checks.length.level, '合规');
  assert.equal(result.checks.presence.ok, true);
  assert.equal(result.checks.presence.titleHit, true);
  assert.equal(result.checks.title.ok, true);
  assert.ok(result.fixes.length === 0);
});

test('applyContracts：fixes 每条都带具体数字或具体词', () => {
  const samples = [
    // 空标题 + 无品牌 + 3 字正文
    { title: '', body: '短正文', brand: {}, brief: {}, existingTitles: [] },
    // 同一标题同时踩承诺与绝对化
    { ...brokenDraft(), title: '恒野内容代运营：保证涨粉的第一选择' },
    // 过长正文 + 关键词不对齐
    { title: '账号起量观察', body: padExact('恒野先说结论。', 5000), brand, brief: { term: '内容代运营' } },
    // 标题重复
    { ...compliantDraft(), existingTitles: ['恒野内容代运营怎么选：5 个判断标准'] },
  ];

  for (const sample of samples) {
    const result = applyContracts(sample);
    assert.ok(result.fixes.length >= 1, '不通过的稿子必须给出改法');
    for (const fix of result.fixes) {
      assert.ok(/(\d|「[^」]+」)/.test(fix), `fix 必须带具体数字或具体词：${fix}`);
    }
  }
});

test('renderContractsMarkdown：四节齐全，通过时阻断项为「无」', () => {
  const result = applyContracts(compliantDraft());
  const markdown = renderContractsMarkdown(result);

  for (const heading of ['## 合同检查', '## 阻断项', '## 提醒', '## 怎么改']) {
    assert.ok(markdown.includes(heading), `缺少小节：${heading}`);
  }
  assert.ok(markdown.indexOf('## 合同检查') < markdown.indexOf('## 阻断项'));
  assert.ok(markdown.indexOf('## 阻断项') < markdown.indexOf('## 提醒'));
  assert.ok(markdown.indexOf('## 提醒') < markdown.indexOf('## 怎么改'));

  const blockSection = markdown.split('## 阻断项')[1].split('## 提醒')[0];
  assert.ok(blockSection.includes('无'), '通过时阻断项写「无」');
  const warnSection = markdown.split('## 提醒')[1].split('## 怎么改')[0];
  assert.ok(warnSection.includes('无'));
  assert.ok(markdown.includes('结论：通过'));
  assert.ok(!markdown.includes('undefined'));
  assert.ok(!markdown.includes('null'));
});

test('renderContractsMarkdown：不通过时原样列出阻断项与改法', () => {
  const result = applyContracts(brokenDraft());
  const markdown = renderContractsMarkdown(result);

  assert.ok(markdown.includes('结论：不通过'));
  for (const blocker of result.blockers) assert.ok(markdown.includes(blocker));

  const blockSection = markdown.split('## 阻断项')[1].split('## 提醒')[0];
  assert.ok(blockSection.includes('900'), '阻断项里要有具体字数');
  assert.ok(!blockSection.includes('- 无'));

  const fixSection = markdown.split('## 怎么改')[1];
  result.fixes.forEach((fix, index) => assert.ok(fixSection.includes(`${index + 1}. ${fix}`)));
  assert.ok(!markdown.includes('undefined'));
  assert.ok(!markdown.includes('null'));
});

test('纯函数：同输入两次调用结果 deepEqual，且不修改入参', () => {
  const input = brokenDraft();
  const snapshot = structuredClone(input);

  const first = applyContracts(input);
  const second = applyContracts(input);
  assert.deepEqual(first, second);
  assert.notEqual(first, second, '每次返回新对象，不共享引用');
  assert.deepEqual(input, snapshot, '不允许修改入参');

  assert.deepEqual(checkLength({ body: '恒野' }), checkLength({ body: '恒野' }));
  assert.deepEqual(
    checkClientPresence({ body: input.body, title: input.title, brand }),
    checkClientPresence({ body: input.body, title: input.title, brand }),
  );
  assert.deepEqual(reviewTitle({ title: input.title, brief: input.brief }), reviewTitle({ title: input.title, brief: input.brief }));
});

test('空输入：所有入口不抛错，渲染结果不含 undefined / null', () => {
  assert.equal(checkLength().ok, false);
  assert.equal(checkClientPresence().mentions, 0);
  assert.equal(reviewTitle().ok, false, '空标题本身就是阻断');

  const result = applyContracts();
  assert.equal(result.ok, false);
  assert.ok(result.blockers.length >= 1);

  const markdown = renderContractsMarkdown(result);
  for (const heading of ['## 合同检查', '## 阻断项', '## 提醒', '## 怎么改']) {
    assert.ok(markdown.includes(heading));
  }
  assert.ok(!markdown.includes('undefined'));
  assert.ok(!markdown.includes('null'));

  // 半成品 result 也不能崩（旧数据 / 手工构造的入参）
  const partial = renderContractsMarkdown({});
  assert.ok(partial.includes('## 合同检查'));
  assert.ok(!partial.includes('undefined'));
});
