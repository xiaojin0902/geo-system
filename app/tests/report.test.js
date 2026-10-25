/**
 * report.js 自测（content-brief 负责）
 * 覆盖：demo 横幅、三层评分表、覆盖与排除说明、160 字截断、竞品统计、机会缺口、
 * 7 天动作、页脚、自包含 HTML（无外部资源/无 JS）、无 OmniRank、索引页。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderReportMarkdown, renderReportHtml, renderIndexHtml, formatLocal, REPORT_TIME_ZONE } from '../lib/report.js';

const brand = JSON.parse(readFileSync(new URL('../brands/hengye.json', import.meta.url), 'utf8'));
const LONG_ANSWER = `${'甲'.repeat(200)}TAIL_ONLY_AFTER_TRUNCATION`;

const QUESTIONS = [
  { text: '恒野是做什么的？', intent: '发现', tier: 'brand_awareness', priority: 'P0' },
  { text: '芜湖内容代运营推荐哪家好？', intent: '推荐', tier: 'regional_industry', priority: 'P0' },
  { text: '内容代运营多少钱一个月？', intent: '价格', tier: 'super_tier1', priority: 'P1' },
  { text: '内容代运营合作流程是怎样的？', intent: '流程', tier: 'super_tier1', priority: 'P1' },
  { text: '恒野靠谱吗？', intent: '避坑', tier: 'brand_awareness', priority: 'P0' },
];

function makeData({ kind = 'demo' } = {}) {
  const rows = [
    {
      question: QUESTIONS[0],
      answer: {
        engine: 'mock',
        status: 'ok',
        answer_text: '[DEMO] 恒野是一家芜湖的内容工作室，值得推荐。',
        citations: [{ title: '演示来源', url: 'https://example.com/demo/1' }],
      },
      judgment: { verdict: 'recommended', matched_text: '恒野', method: 'exact', confidence: 0.9, reasons: ['命中正式名', '上下文含推荐词'] },
    },
    {
      question: QUESTIONS[0],
      answer: { engine: 'deepseek', status: 'ok', answer_text: '恒野提供内容代运营等服务。', citations: [] },
      judgment: { verdict: 'mentioned', matched_text: '恒野', method: 'exact', confidence: 0.8, reasons: ['仅命中品牌名'] },
    },
    {
      question: QUESTIONS[1],
      answer: {
        engine: 'mock',
        status: 'ok',
        answer_text: `${LONG_ANSWER} 回答里还提到宇典科技与力行文化。`,
        citations: [{ title: '示例页面', url: 'https://example.com/demo/2' }],
      },
      judgment: { verdict: 'not_mentioned', matched_text: '', method: 'fallback', confidence: 0.5, reasons: ['未命中品牌名或别名'] },
    },
    {
      question: QUESTIONS[1],
      answer: { engine: 'deepseek', status: 'ok', answer_text: '回答里出现了宇典科技，但无法确定是否指恒野。', citations: [] },
      judgment: { verdict: 'unknown', matched_text: '', method: 'fallback', confidence: 0.2, reasons: ['别名是常见词，上下文不足'] },
    },
    {
      question: QUESTIONS[2],
      answer: { engine: 'mock', status: 'ok', answer_text: '[DEMO] 价格从 299 元起，不同档位不同，恒野在列。', citations: [] },
      judgment: { verdict: 'listed', matched_text: '恒野', method: 'exact', confidence: 0.7, reasons: ['枚举语境'] },
    },
    {
      question: QUESTIONS[3],
      answer: { engine: 'mock', status: 'engine_error', answer_text: '', citations: [] },
      judgment: { verdict: 'engine_error', matched_text: '', method: 'fallback', confidence: 0, reasons: ['请求超时'] },
    },
    {
      question: QUESTIONS[4],
      answer: { engine: 'deepseek', status: 'refused', answer_text: '', citations: [] },
      judgment: { verdict: 'refused', matched_text: '', method: 'fallback', confidence: 0, reasons: ['模型拒答'] },
    },
  ];

  const score = {
    layers: {
      awareness: { ok: 2, hits: 1.4, weighted: 14, score: 14 },
      decision: { ok: 1, hits: 0.7, weighted: 28, score: 28 },
      scenario: { ok: 0, hits: 0, weighted: 0, score: null },
    },
    total: 42,
    level: '偏弱',
    coverage: { planned: 5, ok: 3, ratio: 0.6, excluded: 2 },
  };

  return {
    brand,
    run: {
      id: 7,
      kind,
      engine_set: 'mock,deepseek',
      planned_n: 5,
      ok_n: 3,
      started_at: '2026-10-26T01:00:00.000Z',
      finished_at: '2026-10-26T01:02:00.000Z',
      status: 'finished',
    },
    detail: { rows },
    score,
  };
}

/** HTML 不得引用外部资源，也不得有 JS 依赖 */
function assertSelfContained(html) {
  assert.ok(!/<script[\s>]/i.test(html), 'HTML 不应包含 script 标签');
  assert.ok(!/<link\b/i.test(html), 'HTML 不应包含 link 标签');
  assert.ok(!/@import/i.test(html), 'CSS 不应包含 @import');
  assert.ok(!/(?:src|href)\s*=\s*["']?https?:/i.test(html), 'HTML 属性不应引用外部 http(s) 资源');
  assert.ok(!/url\(\s*["']?https?:/i.test(html), 'CSS 不应引用外部 URL');
  assert.ok(!/OmniRank/.test(html), '页面不得出现 OmniRank');
  assert.ok(html.includes('<style>'), '应内联 CSS');
  assert.ok(/viewport/.test(html), '应有 viewport，保证手机可读');
}

test('demo 报告：顶部横幅、三层评分表、覆盖与排除说明、页脚一应俱全', () => {
  const markdown = renderReportMarkdown(makeData({ kind: 'demo' }));

  assert.ok(markdown.includes('DEMO 演示数据，非真实 AI 回答'), 'demo 报告必须有横幅文案');
  assert.ok(markdown.includes('demo（演示数据'));

  // 三层评分表
  assert.ok(markdown.includes('品牌认知层') && markdown.includes('区域决策层') && markdown.includes('场景拓展层'));
  assert.ok(markdown.includes('| 层级 | 权重 | 有效题数 | 命中权重和 | 层得分 |'));
  assert.ok(markdown.includes('| **合计** | 100 |'));

  // 覆盖与排除
  assert.ok(markdown.includes('没测成 ≠ 0 分'));
  assert.ok(markdown.includes('覆盖率'));
  assert.ok(markdown.includes('unknown / ambiguous / refused / engine_error'));

  // 八段结构
  for (const heading of ['一句话结论', '三层评分与覆盖说明', '原话证据', '竞品 / 他者提及统计', '引用源 · 竞品份额 · 曝光质量', '机会缺口', '行动清单（Top10）与 30 天计划', '数据说明与免责声明']) {
    assert.ok(markdown.includes(heading), `缺少章节：${heading}`);
  }
  assert.ok(markdown.includes('恒野 GEO 自研版'));
  assert.ok(!markdown.includes('OmniRank'));
  assert.ok(!markdown.includes('undefined'));
});

test('证据：原话按题列出、超过 160 字截断、保留引用信息', () => {
  const markdown = renderReportMarkdown(makeData({ kind: 'demo' }));
  assert.ok(markdown.includes('### 恒野是做什么的'));
  assert.ok(markdown.includes('### 芜湖内容代运营推荐哪家好'));
  assert.ok(markdown.includes('被推荐') && markdown.includes('未提及') && markdown.includes('判定不确定'));
  assert.ok(markdown.includes('原话节选'));
  assert.ok(markdown.includes('命中片段'));
  assert.ok(markdown.includes('演示来源'));
  assert.ok(markdown.includes('https://example.com/demo/1'));

  // 截断：160 个「甲」在，161 之后的内容不在
  assert.ok(markdown.includes('甲'.repeat(160)));
  assert.ok(!markdown.includes('甲'.repeat(161)));
  assert.ok(!markdown.includes('TAIL_ONLY_AFTER_TRUNCATION'));
});

test('竞品提及统计与机会缺口', () => {
  const markdown = renderReportMarkdown(makeData({ kind: 'demo' }));
  assert.ok(markdown.includes('| 竞品 / 他者 | 被提及题数 | 出现次数 |'));
  assert.ok(markdown.includes('宇典科技'));
  assert.ok(markdown.includes('力行文化'));
  assert.ok(markdown.includes('| 宇典科技 | 2 | 2 |'));

  assert.ok(markdown.includes('机会缺口'));
  assert.ok(markdown.includes('未提及题目'));
  assert.ok(markdown.includes('芜湖内容代运营推荐哪家好'));
  assert.ok(markdown.includes('区域决策层'));
});

test('分数为 null：明确「样本不足，暂不出总分」', () => {
  const data = makeData({ kind: 'live' });
  data.score = {
    layers: data.score.layers,
    total: null,
    level: '样本不足',
    coverage: { planned: 10, ok: 2, ratio: 0.2 },
  };
  const markdown = renderReportMarkdown(data);
  assert.ok(markdown.includes('样本不足，暂不出总分'));
  assert.ok(markdown.includes('有效回答 2/10'));
  assert.ok(markdown.includes('50%'));
  // live 报告不出现 demo 横幅
  assert.ok(!markdown.includes('DEMO 演示数据'));
});

test('live 报告：不出现 demo 横幅，数据说明写 live', () => {
  const markdown = renderReportMarkdown(makeData({ kind: 'live' }));
  assert.ok(!markdown.includes('DEMO 演示数据，非真实 AI 回答'));
  assert.ok(markdown.includes('LIVE 声明'));
  assert.ok(markdown.includes('live（真实引擎采集）'));
  assert.ok(markdown.includes('恒野 GEO 自研版'));
});

test('行动清单：输出 Top10 行动与 30 天计划（或样本不足时回退 7 天动作）', () => {
  const markdown = renderReportMarkdown(makeData({ kind: 'demo' }));
  const section = markdown.split('## 七、行动清单（Top10）与 30 天计划')[1].split('## 八、')[0];

  if (section.includes('Top10 行动')) {
    // 正常路径：规则模板生成的行动清单
    assert.ok(section.includes('## Top10 行动'));
    assert.ok(section.includes('## 30 天计划'));
    assert.ok(section.includes('## 风险提示'));
    const items = section.split('\n').filter((line) => /^\d+\.\s/.test(line.trim()));
    assert.ok(items.length >= 1 && items.length <= 10, `Top10 条数应为 1-10，实际 ${items.length}`);
  } else {
    // 兜底路径：样本不足时回退旧版 7 天动作
    const actions = section.split('\n').filter((line) => /^\d+\.\s/.test(line.trim()));
    assert.ok(actions.length >= 3 && actions.length <= 5, `动作条数应为 3-5，实际 ${actions.length}`);
    assert.ok(section.includes('--engines live'));
    assert.ok(section.includes('7 天后'));
  }
});

test('renderReportHtml：自包含、demo 红横幅、表格渲染、无 OmniRank', () => {
  const markdown = renderReportMarkdown(makeData({ kind: 'demo' }));
  const html = renderReportHtml(markdown, { title: '恒野诊断报告', demo: true });

  assert.ok(/^<!doctype html>/i.test(html.trim()));
  assert.ok(html.includes('lang="zh-CN"'));
  assert.ok(html.includes('class="demo-banner"'));
  assert.ok(html.includes('DEMO 演示数据，非真实 AI 回答'));
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<th>层得分</th>'));
  assert.ok(html.includes('<h1>'));
  assert.ok(html.includes('恒野 GEO 自研版'));
  assert.ok(html.includes('<style>'));
  assertSelfContained(html);
});

test('renderReportHtml：即使不传 demo=true，也能从 Markdown 自动识别 demo 横幅', () => {
  const html = renderReportHtml(renderReportMarkdown(makeData({ kind: 'demo' })), { title: 'demo' });
  assert.ok(html.includes('class="demo-banner"'));
});

test('renderReportHtml：live 报告不加 demo 横幅', () => {
  const html = renderReportHtml(renderReportMarkdown(makeData({ kind: 'live' })), { title: 'live' });
  assert.ok(!html.includes('class="demo-banner"'));
  assert.ok(!html.includes('DEMO 演示数据，非真实 AI 回答'));
  assertSelfContained(html);
});

test('renderReportHtml：HTML 转义，防止注入', () => {
  const html = renderReportHtml('# 标题\n\n<script>alert(1)</script>\n\n| a | b |\n| --- | --- |\n| <x> | 1 |', { title: '<title>' });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;x&gt;'));
  assert.ok(!/<title>\s*<title>/.test(html));
});

test('formatLocal：UTC 时间统一按北京时间（Asia/Shanghai）展示', () => {
  assert.equal(REPORT_TIME_ZONE, 'Asia/Shanghai');
  // 北京时间 2026-10-26 02:51:37 = UTC 2026-10-25 18:51:37
  assert.equal(formatLocal('2026-10-25T18:51:37.111Z'), '2026-10-26 02:51:37');
  assert.equal(formatLocal('2026-10-25T18:51:37.111Z', { dateOnly: true }), '2026-10-26');
  assert.equal(formatLocal('2026-10-26T02:30:00.000+08:00'), '2026-10-26 02:30:00');
  assert.equal(formatLocal('2026-10-26 02:51:37'), '2026-10-26 02:51:37'); // 已是本地格式不二次转换
  assert.equal(formatLocal(''), '—');
  assert.equal(formatLocal(null), '—');
  assert.equal(formatLocal('not-a-date'), 'not-a-date');
});

test('报告时间：UTC 18:51 的 run 显示为北京时间次日 02:51，不显示 UTC 日期', () => {
  const data = makeData({ kind: 'demo' });
  data.run.started_at = '2026-10-25T18:51:37.111Z';
  data.run.finished_at = '2026-10-25T18:51:37.119Z';
  const markdown = renderReportMarkdown(data);

  assert.ok(markdown.includes('采集时间：2026-10-26 02:51:37'));
  assert.ok(!markdown.includes('2026-10-25T18:51'));
  assert.ok(!markdown.includes('采集时间：2026-10-25'));

  // CLI 的 subtitle 用 ISO.slice(0,10) 会是 UTC 日期 2026-10-25，渲染层按本地日期校正
  const html = renderReportHtml(markdown, {
    title: 'run-1',
    subtitle: '芜湖恒野数字科技有限公司 · DEMO 演示数据 · 2026-10-25',
    demo: true,
  });
  assert.ok(html.includes('DEMO 演示数据 · 2026-10-26'));
  assert.ok(!html.includes('DEMO 演示数据 · 2026-10-25'));
  assert.ok(!html.includes('2026-10-25T18:51'));

  // 与采集日期无关的日期不能被误改
  const htmlOtherDate = renderReportHtml(markdown, { title: 't', subtitle: '数据截止 2026-10-20', demo: true });
  assert.ok(htmlOtherDate.includes('数据截止 2026-10-20'));
});

test('index.html：运行时间同样按北京时间展示', () => {
  const html = renderIndexHtml({
    brand,
    runs: [
      { id: 9, kind: 'demo', engine_set: 'mock', planned_n: 12, ok_n: 8, status: 'done', started_at: '2026-10-25T18:51:37.111Z' },
    ],
  });
  assert.ok(html.includes('2026-10-26 02:51:37'));
  assert.ok(!html.includes('2026-10-25T18:51'));
  assertSelfContained(html);
});

test('renderIndexHtml：运行列表、demo 标记、报告链接、页脚', () => {
  const html = renderIndexHtml({
    brand,
    runs: [
      { id: 7, kind: 'demo', engine_set: 'mock', planned_n: 12, ok_n: 9, status: 'finished', started_at: '2026-10-26T01:00:00.000Z' },
      { id: 8, kind: 'live', engine_set: 'deepseek', planned_n: 20, ok_n: 18, status: 'finished', started_at: '2026-10-26T02:00:00.000Z' },
    ],
  });
  assert.ok(/^<!doctype html>/i.test(html.trim()));
  assert.ok(html.includes('run-7') && html.includes('run-8'));
  assert.ok(html.includes('href="run-7.html"'));
  assert.ok(html.includes('DEMO'));
  assert.ok(html.includes('存在 DEMO 演示数据，非真实 AI 回答'));
  assert.ok(html.includes('恒野 GEO 自研版'));
  assertSelfContained(html);
});

test('renderIndexHtml：空运行列表给出可执行提示', () => {
  const html = renderIndexHtml({ brand, runs: [] });
  assert.ok(html.includes('还没有诊断运行记录'));
  assert.ok(html.includes('node bin/geo.js diagnose'));
  assert.ok(html.includes('恒野 GEO 自研版'));
  assertSelfContained(html);
});
