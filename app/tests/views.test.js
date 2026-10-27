/**
 * tests/views.test.js
 * 控制台视图的验收测试：转义、状态呈现、关键信息不丢失。
 *
 * 为什么单独测视图：页面上的「未配置密钥」「DEMO 数据」提示是防误判的最后一道闸，
 * 如果它们渲染失败，用户会拿着演示数据去跟客户汇报。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  auditPage,
  dashboardPage,
  diagnosePage,
  doctorPage,
  layout,
  notFoundPage,
  questionsPage,
} from '../lib/views.js';

const brand = { name: '恒野', city: '芜湖', scope: '全国线上交付', industry: '内容代运营' };

test('layout：包含标题、导航高亮与品牌名', () => {
  const html = layout({ title: '总览', active: '/', body: '<p>正文</p>', brandName: '恒野' });
  assert.match(html, /<title>总览 · 恒野 GEO<\/title>/);
  // 导航已按工作台重构：一级是分组（工作台/监测/内容/客户/合规/设置）
  assert.match(html, /class="on">工作台</);
  assert.match(html, />监测</);
  assert.match(html, />内容</);
  assert.match(html, /<p>正文<\/p>/);
  assert.match(html, /lang="zh-CN"/);
});

test('layout：标题里的 HTML 会被转义（防注入）', () => {
  const html = layout({ title: '<script>alert(1)</script>', body: '' });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('dashboardPage：没有密钥时必须有「现在跑的是演示数据」提示', () => {
  const html = dashboardPage({
    brand,
    runs: [],
    keys: [
      { name: 'DEEPSEEK_API_KEY', present: false },
      { name: 'DASHSCOPE_API_KEY', present: false },
    ],
    engines: [{ id: 'mock', label: 'Mock', configured: true }],
    counts: { questions: 99, runs: 0, keywords: 0, contents: 0 },
  });
  assert.match(html, /现在跑的是演示数据/);
  assert.match(html, /DEEPSEEK_API_KEY 未配置/);
  assert.match(html, /99/);
});

test('dashboardPage：有密钥时不再显示演示数据警告，并展示最近评分', () => {
  const html = dashboardPage({
    brand,
    runs: [{ runId: 7, kind: 'live', status: 'done', samples: 30, total: 62.5, level: '中等', startedAt: '2026-10-26T10:00:00Z' }],
    latest: { runId: 7, total: 62.5, level: '中等' },
    keys: [{ name: 'DEEPSEEK_API_KEY', present: true }],
    engines: [{ id: 'deepseek', label: 'DeepSeek · 联网检索', configured: true }],
    counts: { questions: 99, runs: 1, keywords: 0, contents: 0 },
  });
  assert.ok(!html.includes('现在跑的是演示数据'));
  assert.match(html, /62\.5/);
  assert.match(html, /中等/);
  assert.match(html, /\/run\/7/);
});

test('dashboardPage：run 列表为空时给出可操作的空态', () => {
  const html = dashboardPage({ brand, keys: [], engines: [], counts: {}, runs: [] });
  assert.match(html, /还没有运行记录/);
});

test('diagnosePage：无密钥时提示只能跑 demo，并把引擎写进下拉框', () => {
  const html = diagnosePage({
    brand,
    engines: [
      { id: 'mock', label: 'Mock', configured: true, requiresKey: false },
      { id: 'deepseek', label: 'DeepSeek', configured: false, requiresKey: true },
    ],
  });
  assert.match(html, /当前没有配置任何线上引擎密钥/);
  assert.match(html, /mock（演示数据/);
  assert.match(html, /value="live"/);
});

test('questionsPage：渲染题目行并统计数量', () => {
  const html = questionsPage({
    brand,
    questions: [{ id: 1, text: '芜湖有哪些内容代运营公司？', intent: 'commercial', tier: 'core', priority: 'P0', source: 'seed' }],
  });
  assert.match(html, /共 1 题/);
  assert.match(html, /芜湖有哪些内容代运营公司/);
  assert.match(html, /P0/);
});

test('auditPage：渲染评分、爬虫可达数与 blocker 修复建议', () => {
  const html = auditPage({
    brand,
    url: 'https://sanrenxing.cn',
    result: {
      url: 'https://sanrenxing.cn',
      score: 18,
      level: '严重',
      https: { ok: false, status: null },
      aiCrawlers: [
        { id: 'gptbot', name: 'GPTBot', blocked: true },
        { id: 'claudebot', name: 'ClaudeBot', blocked: false },
      ],
      schema: { jsonLdCount: 0, types: [] },
      findings: [
        {
          id: 'robots-403',
          level: 'blocker',
          title: 'robots.txt 返回 403',
          detail: 'WAF 拦截了 /robots.txt',
          fix: '在 nginx 放行 /robots.txt 并返回 200',
        },
      ],
    },
  });
  assert.match(html, /18/);
  assert.match(html, /严重/);
  assert.match(html, /1[\s\S]{0,24}2 可进/);
  assert.match(html, /robots\.txt 返回 403/);
  assert.match(html, /在 nginx 放行/);
});

test('auditPage：模块不可用或体检失败时展示错误而不是白屏', () => {
  const html = auditPage({ brand, url: 'https://x.cn', error: '体检失败：ECONNREFUSED' });
  assert.match(html, /体检失败/);
  assert.match(html, /ECONNREFUSED/);
});

test('doctorPage：通过/阻塞两种状态都能渲染，并给出处理动作', () => {
  const html = doctorPage({
    report: {
      ok: false,
      brandName: '恒野',
      checks: [
        { id: 'node', ok: true, level: 'blocker', title: 'Node 运行时', detail: 'v22.16.0', action: '' },
        { id: 'keys', ok: false, level: 'blocker', title: '线上引擎密钥', detail: '一个都没有', action: '写入 DEEPSEEK_API_KEY' },
      ],
    },
  });
  assert.match(html, /通过/);
  assert.match(html, /阻塞/);
  assert.match(html, /写入 DEEPSEEK_API_KEY/);
});

test('notFoundPage：包含 404 与回总览入口', () => {
  const html = notFoundPage('/nope');
  assert.match(html, /404/);
  assert.match(html, /\/nope/);
  assert.match(html, /回总览/);
});
