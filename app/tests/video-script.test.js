/**
 * tests/video-script.test.js
 * 短视频口播脚本模块验收：钩子、时长、口播、分镜、标题、话题、合规、品牌、确定性、渲染。
 *
 * 守的是一条产品红线：脚本阶段就要把「绝对化用语、效果承诺、无来源数字」拦下来，
 * 不能等到发布后才发现。所有用例只喂纯数据，不读文件、不联网、不依赖当前时间。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCRIPT_STYLES,
  buildVideoScript,
  renderVideoScriptMarkdown,
} from '../lib/video-script.js';

/** 按 Unicode 码点数字数，和后端口径保持一致。 */
function charLen(text) {
  return Array.from(String(text)).length;
}

/** 绝对化 / 承诺类词表，用于断言生成物「干净」。 */
const BANNED_WORDS = ['最好', '第一', '唯一', '顶级', '保证', '100%', '稳赚', '绝对', '永久'];

/** 一篇真实感的 GEO 文章：带 Markdown、数字、链接与问答句。 */
const SAMPLE_TITLE = '芜湖做内容代运营，为什么客户搜不到你';

const SAMPLE_BODY = [
  '# 芜湖做内容代运营，为什么客户搜不到你',
  '',
  '很多老板投了钱做短视频，播放量看着不错，**私信却寥寥无几**。问题往往不在拍摄，而在内容没有回答客户真正搜索的问题。',
  '',
  '## 一、先搞清楚客户在搜什么',
  '',
  '按我们的经验，本地商家高频被问的三类问题：多少钱、要多久、靠不靠谱。把这三类问题写成口播，比讲品牌故事有效得多。',
  '',
  '## 二、发布频率与时长',
  '',
  '起号阶段建议每周更新 3 条，连续 4 周，先跑出可复用的选题。单条视频控制在 45 到 60 秒，前三秒必须给出钩子。',
  '',
  '## 三、为什么要做 AI 搜索优化',
  '',
  '现在不少客户直接问 AI「芜湖哪家代运营靠谱」。如果官网和账号没有可被引用的内容，AI 就答不出你的名字。',
  '',
  '据公开报告，2024 年有 62% 的用户会在下单前先做搜索。来源：https://example.com/report',
  '',
  '## 四、怎么判断脚本能不能拍',
  '',
  '一条脚本至少要有钩子、证据、行动三部分。拍完自己读一遍，读不顺的地方就是观众会划走的地方。',
].join('\n');

const SAMPLE_BRAND = { name: '恒野', city: '芜湖', industry: '内容代运营' };
const SAMPLE_BRIEF = { term: '内容代运营' };

/** 按 SAMPLE 生成一份稳定脚本。 */
function sample(extra = {}) {
  return buildVideoScript({
    title: SAMPLE_TITLE,
    body: SAMPLE_BODY,
    brief: SAMPLE_BRIEF,
    brand: SAMPLE_BRAND,
    ...extra,
  });
}

/** 把 Markdown 里某一节的内容切出来（遇到下一个 ## 停）。 */
function sectionLines(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  assert.notEqual(start, -1, `缺少章节 ${heading}`);
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) break;
    body.push(lines[i]);
  }
  return body;
}

test('导出契约：五种风格顺序固定', () => {
  assert.deepEqual(SCRIPT_STYLES, ['口播科普', '避坑清单', '对比测评', '案例复盘', '快问快答']);
  assert.ok(Object.isFrozen(SCRIPT_STYLES));
});

test('五种 style 的钩子不同，且都不超过 20 字', () => {
  const hooks = SCRIPT_STYLES.map((style) => sample({ style }).hook);
  assert.equal(new Set(hooks).size, SCRIPT_STYLES.length);
  for (const hook of hooks) {
    assert.ok(charLen(hook) <= 20, `钩子超过 20 字：${hook}`);
  }
  // 钩子模板要能一眼认出风格
  assert.match(hooks[0], /90%/);
  assert.match(hooks[1], /这3个坑/);
  assert.match(hooks[2], /选哪个|还是/);
  assert.match(hooks[3], /一个客户/);
  assert.match(hooks[4], /？/);
});

test('时间轴从 0s 开始、段段相连、最后一段收在 durationSec', () => {
  for (const durationSec of [30, 45, 60, 90, 120]) {
    const script = sample({ durationSec });
    const spans = script.narration.map((item) => {
      const match = /^(\d+)-(\d+)s$/.exec(item.t);
      assert.ok(match, `时间段格式不对：${item.t}`);
      return [Number(match[1]), Number(match[2])];
    });
    assert.equal(spans[0][0], 0);
    for (let i = 1; i < spans.length; i += 1) {
      assert.equal(spans[i][0], spans[i - 1][1], `第 ${i} 段没有接上`);
      assert.ok(spans[i][1] > spans[i][0], '每段至少 1 秒');
    }
    assert.equal(spans.at(-1)[1], durationSec);
    assert.equal(script.durationSec, durationSec);
  }
});

test('narration 首段是钩子，且前三秒单独占一段', () => {
  const script = sample({ durationSec: 60 });
  assert.equal(script.narration[0].text, script.hook);
  assert.equal(script.narration[0].t, '0-3s');
});

test('正文口播段每段 25–60 字（钩子不参与，允许 ≤20 字）', () => {
  for (const style of SCRIPT_STYLES) {
    const script = sample({ style, durationSec: 90 });
    for (const item of script.narration.slice(1)) {
      const length = charLen(item.text);
      assert.ok(length >= 25 && length <= 60, `${style} 口播段 ${length} 字：${item.text}`);
    }
  }
});

test('分镜与口播段一一对应，时间轴完全相同', () => {
  const script = sample();
  assert.equal(script.shots.length, script.narration.length);
  script.shots.forEach((shot, index) => {
    assert.equal(shot.t, script.narration[index].t);
  });
});

test('分镜字段：shot 含景别与动作、caption ≤18 字、broll 有素材建议', () => {
  for (const style of SCRIPT_STYLES) {
    const script = sample({ style });
    for (const shot of script.shots) {
      assert.match(shot.shot, /近景|中景|特写|全景|远景/, `缺少景别：${shot.shot}`);
      assert.ok(shot.shot.length > 4, 'shot 需要描述动作');
      assert.ok(charLen(shot.caption) <= 18, `字幕超长：${shot.caption}`);
      assert.ok(shot.caption.length > 0);
      assert.ok(shot.broll.length > 0, '缺少素材建议');
    }
  }
});

test('标题备选 3–5 条：≤18 字、含关键词、无绝对化用语', () => {
  const script = sample();
  assert.ok(script.titleOptions.length >= 3 && script.titleOptions.length <= 5);
  for (const option of script.titleOptions) {
    assert.ok(charLen(option) <= 18, `标题超长：${option}`);
    assert.ok(option.includes('内容代运营'), `标题缺关键词：${option}`);
    for (const word of BANNED_WORDS) {
      assert.ok(!option.includes(word), `标题含绝对化用语「${word}」：${option}`);
    }
  }
});

test('话题标签 5–8 个、都带 #、无空格且不重复', () => {
  const script = sample();
  assert.ok(script.hashtags.length >= 5 && script.hashtags.length <= 8);
  assert.equal(new Set(script.hashtags).size, script.hashtags.length);
  for (const tag of script.hashtags) {
    assert.match(tag, /^#[^\s#]+$/, `标签格式不对：${tag}`);
  }
});

test('封面文案不超过 12 字', () => {
  const long = buildVideoScript({
    title: '一个特别特别特别长标题的内容代运营指南',
    body: SAMPLE_BODY,
    brand: SAMPLE_BRAND,
  });
  assert.ok(charLen(long.coverText) <= 12, `封面超长：${long.coverText}`);
  assert.ok(long.coverText.length > 0);
});

test('合规：绝对化用语逐类命中（最/第一/唯一/顶级/永久）', () => {
  const script = buildVideoScript({
    title: '芜湖内容代运营',
    body: '我们是芜湖最好的团队，也是行业第一、唯一选择，顶级服务，永久有效。',
  });
  assert.equal(script.compliance.passed, false);
  const labels = script.compliance.issues.map((issue) => issue.word);
  for (const word of ['最', '第一', '唯一', '顶级', '永久']) {
    assert.ok(labels.includes(word), `没有命中「${word}」`);
  }
  for (const issue of script.compliance.issues) {
    assert.equal(issue.type, 'absolute');
    assert.ok(issue.detail.length > 0);
  }
});

test('合规：效果承诺（保证涨粉 / 一定有效）单独成条', () => {
  const script = buildVideoScript({
    title: '内容代运营',
    body: '跟我们做，保证涨粉，一定有效，三个月回本。',
  });
  assert.equal(script.compliance.passed, false);
  const promiseIssues = script.compliance.issues.filter((issue) => issue.type === 'promise');
  assert.ok(promiseIssues.length >= 1, '应命中效果承诺');
  assert.ok(promiseIssues.some((issue) => issue.word === '保证涨粉'));
  assert.ok(promiseIssues.some((issue) => issue.word === '一定有效'));
});

test('合规：百分比没有来源会被拦下，补了来源就放行', () => {
  const risky = buildVideoScript({ title: '内容代运营', body: '这套打法能提升 70% 的到店率。' });
  assert.equal(risky.compliance.passed, false);
  assert.ok(risky.compliance.issues.some((issue) => issue.type === 'unsourced_number' && issue.word === '70%'));

  const sourced = buildVideoScript({
    title: '内容代运营',
    body: '据公开报告，70% 的客户下单前会先搜索。来源：https://example.com/report',
  });
  assert.equal(sourced.compliance.issues.some((issue) => issue.type === 'unsourced_number'), false);
});

test('健康稿合规通过：正文里 62% 带来源、没有违禁词', () => {
  const script = sample();
  assert.deepEqual(script.compliance.issues, []);
  assert.equal(script.compliance.passed, true);
});

test('品牌植入：口播稿至少一处同时提到 brand.name 与 brand.city', () => {
  const script = sample();
  const hit = script.narration.some(
    (item) => item.text.includes('恒野') && item.text.includes('芜湖'),
  );
  assert.ok(hit, '口播稿没有自然植入品牌名与城市');

  // 没有品牌信息时不强制，也不能出现 undefined
  const bare = buildVideoScript({ title: '内容代运营', body: SAMPLE_BODY });
  const text = bare.narration.map((item) => item.text).join(' ');
  assert.ok(!/undefined|null/.test(text));
});

test('数字句与疑问句优先入选口播', () => {
  const body = [
    '我们先聊聊品牌故事和创业经历，这段内容比较长但是信息密度不高。',
    '门店装修花了不少心思，灯光和动线都请人重新设计过。',
    '很多客户第一次来都会问价格，所以我们把报价做成了公开表格。',
    '拍摄前要准备脚本，脚本里每一段都要有明确的信息点。',
    '为什么客户搜不到你？因为官网三年没有更新过任何案例。',
    '起号阶段建议每周更新 3 条，连续 4 周再复盘数据。',
  ].join('\n');
  const script = buildVideoScript({ title: '内容代运营', body, durationSec: 30 });
  assert.equal(script.narration.length, 3);
  assert.ok(script.narration[1].text.includes('每周更新 3 条'), `首选段不对：${script.narration[1].text}`);
});

test('Markdown 标记不会流进口播与字幕', () => {
  const body = [
    '# 一、先说结论',
    '',
    '**核心观点**：客户搜不到你，往往不是内容不够多，而是每条内容都没有回答一个具体问题。',
    '',
    '- 把客户高频问题列成清单，一个问题拍一条口播。',
    '- 每条口播只留一个行动指令，别让观众猜下一步做什么。',
    '',
    '参考：[公开报告](https://example.com/report) 显示搜索行为在变化。',
  ].join('\n');
  const script = buildVideoScript({ title: '内容代运营', body });
  const spoken = script.narration.map((item) => item.text).join('\n');
  assert.ok(!/[*#`~]|]\(|https?:\/\//.test(spoken), `口播残留 Markdown：${spoken}`);
  for (const shot of script.shots) {
    assert.ok(!/[*#`~]|]\(|https?:\/\//.test(shot.caption), `字幕残留 Markdown：${shot.caption}`);
  }
  assert.ok(script.narration.some((item) => item.text.includes('客户搜不到你')), '正文内容没有被抽取');
});

test('确定性：同输入两次 deepEqual，且不依赖时间与随机数', () => {
  const first = sample({ style: '案例复盘', durationSec: 90 });
  const second = sample({ style: '案例复盘', durationSec: 90 });
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('空 body 与默认参数不崩，结构完整', () => {
  const script = buildVideoScript();
  assert.equal(script.style, '口播科普');
  assert.equal(script.durationSec, 60);
  assert.ok(script.hook.length > 0 && charLen(script.hook) <= 20);
  assert.ok(script.narration.length >= 2);
  assert.equal(script.shots.length, script.narration.length);
  assert.ok(script.titleOptions.length >= 3);
  assert.ok(script.hashtags.length >= 5 && script.hashtags.length <= 8);
  assert.ok(script.coverText.length > 0);
  assert.equal(script.compliance.passed, true);
  assert.equal(typeof script.platformNotes.douyin, 'string');
});

test('非法参数兜底：未知风格回退、极端时长夹紧', () => {
  const unknown = buildVideoScript({ style: '数字人播报', durationSec: 'abc' });
  assert.equal(unknown.style, '口播科普');
  assert.equal(unknown.durationSec, 60);

  const tooShort = buildVideoScript({ durationSec: 0 });
  assert.ok(tooShort.durationSec >= 10);

  const tooLong = buildVideoScript({ durationSec: 9999 });
  assert.ok(tooLong.durationSec <= 300);
});

test('renderVideoScriptMarkdown：九个章节齐全，表格行数与数据一致', () => {
  const script = sample();
  const markdown = renderVideoScriptMarkdown(script);
  const headings = [
    '## 标题',
    '## 3秒钩子',
    '## 口播稿',
    '## 分镜',
    '## 标题备选',
    '## 话题标签',
    '## 封面文案',
    '## 合规检查',
    '## 平台注意',
  ];
  for (const heading of headings) assert.ok(markdown.includes(heading), `缺少章节：${heading}`);

  const narrationRows = sectionLines(markdown, '## 口播稿').filter((line) => line.startsWith('|')).length - 2;
  assert.equal(narrationRows, script.narration.length);

  const shotRows = sectionLines(markdown, '## 分镜').filter((line) => line.startsWith('|')).length - 2;
  assert.equal(shotRows, script.shots.length);

  assert.ok(markdown.includes(script.hook));
  assert.ok(markdown.includes(script.titleOptions[0]));
  assert.ok(markdown.includes(script.hashtags[0]));
  assert.ok(markdown.includes(script.coverText));
  assert.ok(markdown.includes('通过'));
  assert.ok(markdown.includes('抖音'));
  assert.ok(markdown.includes('小红书'));
  assert.ok(markdown.includes('视频号'));

  // 空输入也能渲染，不抛异常
  const empty = renderVideoScriptMarkdown(buildVideoScript({}));
  assert.ok(empty.includes('## 口播稿'));
  assert.ok(renderVideoScriptMarkdown(null).includes('## 标题'));
});

test('renderVideoScriptMarkdown：合规不通过时列出具体问题', () => {
  const risky = buildVideoScript({
    title: '内容代运营',
    body: '保证涨粉，曝光提升 300%。',
  });
  const markdown = renderVideoScriptMarkdown(risky);
  assert.ok(markdown.includes('未通过'));
  assert.ok(markdown.includes('效果承诺') || markdown.includes('绝对化用语'));
  assert.ok(markdown.includes('无来源数字'));
});
