/**
 * tests/video-script.test.js
 * 短视频脚本模块验收：钩子/时长/分镜/标题/话题/合规/确定性。
 * 守的是一条产品红线：脚本阶段就要把「绝对化用语、效果承诺、无来源数字」拦下来，
 * 不能等到发布后才发现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCRIPT_STYLES, buildVideoScript, renderVideoScriptMarkdown } from '../lib/video-script.js';

const brand = { name: '恒野', city: '芜湖' };
const brief = { term: '内容代运营' };
const body = '很多老板做内容代运营，第一步就错了：先拍视频，再想定位。正确的顺序是：先明确目标人群，再定内容形式。我们服务过 30 家本地商家，平均 3 周看到搜索曝光变化。判断标准有三条：交付清单是否书面、数据是否可查、报价是否透明。';

test('五种 style 都能生成，且钩子不同', () => {
  const hooks = SCRIPT_STYLES.map((style) => buildVideoScript({ title: '内容代运营', body, brand, brief, style }).hook);
  assert.equal(hooks.length, 5);
  assert.equal(new Set(hooks).size, 5, '不同 style 的钩子应该不同');
});

test('narration 首段必须是钩子，且时间轴覆盖总时长', () => {
  const script = buildVideoScript({ title: '内容代运营', body, brand, brief, durationSec: 60 });
  assert.equal(script.narration[0].text, script.hook);
  assert.ok(script.narration.length >= 3);
  const last = script.narration.at(-1).t;
  const end = Number(String(last).split('-')[1].replace('s', ''));
  assert.ok(end === 60, `时间轴应到 60s，实际到 ${end}s`);
});

test('时长越短段落越少（15s / 60s / 120s）', () => {
  const short = buildVideoScript({ title: '内容代运营', body, brand, brief, durationSec: 15 });
  const long = buildVideoScript({ title: '内容代运营', body, brand, brief, durationSec: 120 });
  assert.ok(short.narration.length <= long.narration.length);
  assert.ok(long.durationSec === 120);
});

test('分镜数量与口播段一一对应', () => {
  const script = buildVideoScript({ title: '内容代运营', body, brand, brief, durationSec: 60 });
  assert.equal(script.shots.length, script.narration.length);
  for (const shot of script.shots) {
    assert.ok(shot.shot.length > 0);
    assert.ok(shot.caption.length <= 18);
    assert.ok(shot.broll.length > 0);
  }
});

test('标题备选不超过 18 字，且不含绝对化用语', () => {
  const script = buildVideoScript({ title: '内容代运营', body, brand, brief });
  assert.ok(script.titleOptions.length >= 3);
  for (const t of script.titleOptions) {
    assert.ok(t.length <= 18, `标题超长：${t}`);
    assert.ok(!/最好|第一|唯一|保证|100%/.test(t), `标题含绝对化用语：${t}`);
  }
});

test('话题标签 5-8 个且都带 #', () => {
  const script = buildVideoScript({ title: '内容代运营', body, brand, brief });
  assert.ok(script.hashtags.length >= 5 && script.hashtags.length <= 8);
  for (const tag of script.hashtags) assert.ok(tag.startsWith('#'));
});

test('封面文案不超过 12 字', () => {
  const script = buildVideoScript({ title: '一个特别特别特别长标题的内容代运营指南', body, brand, brief });
  assert.ok(script.coverText.length <= 12);
});

test('合规：绝对化用语会被拦下', () => {
  const script = buildVideoScript({ title: '最好', body: '我们是最好的代运营，第一名。', brand, brief });
  assert.equal(script.compliance.passed, false);
  assert.ok(script.compliance.issues.some((i) => i.includes('绝对化')));
});

test('合规：效果承诺会被拦下', () => {
  const script = buildVideoScript({ title: '内容代运营', body: '保证涨粉，一定有效。', brand, brief });
  assert.equal(script.compliance.passed, false);
  assert.ok(script.compliance.issues.some((i) => i.includes('承诺')));
});

test('合规：百分比无来源会被拦下', () => {
  const script = buildVideoScript({ title: '内容代运营', body: '曝光提升 300%。', brand, brief });
  assert.equal(script.compliance.passed, false);
  assert.ok(script.compliance.issues.some((i) => i.includes('来源')));
});

test('合规：正文带链接时百分比放行', () => {
  const script = buildVideoScript({ title: '内容代运营', body: '曝光提升 300%，来源：https://example.com/report', brand, brief });
  assert.equal(script.compliance.issues.some((i) => i.includes('来源')), false);
});

test('品牌信息会自然植入口播稿', () => {
  const script = buildVideoScript({ title: '内容代运营', body, brand, brief });
  const text = script.narration.map((n) => n.text).join(' ');
  assert.ok(text.includes('恒野') || text.includes('芜湖'), '应提到品牌或城市');
});

test('确定性：同输入两次结果完全一致', () => {
  const a = buildVideoScript({ title: '内容代运营', body, brand, brief });
  const b = buildVideoScript({ title: '内容代运营', body, brand, brief });
  assert.deepEqual(a, b);
});

test('renderVideoScriptMarkdown：九个章节齐全，空输入不崩', () => {
  const md = renderVideoScriptMarkdown(buildVideoScript({ title: '内容代运营', body, brand, brief }));
  for (const section of ['## 标题', '## 3 秒钩子', '## 口播稿', '## 分镜', '## 标题备选', '## 话题标签', '## 封面文案', '## 合规检查', '## 平台注意']) {
    assert.ok(md.includes(section), `缺少章节：${section}`);
  }
  const empty = renderVideoScriptMarkdown(buildVideoScript({}));
  assert.ok(empty.includes('## 口播稿'));
});
