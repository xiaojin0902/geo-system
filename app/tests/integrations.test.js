/**
 * tests/integrations.test.js
 * 三条「接上真实平台」的路径：公众号官方 API、浏览器半自动、数字人渲染。
 * 这里只测纯逻辑（HTML 转换、就绪判断、可拍摄包、请求组装），
 * 网络与浏览器行为通过注入 fetch / 显式跳过验证，绝不在测试里发真实请求。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToWechatHtml, wechatReadiness } from '../lib/publishers/wechat.js';
import { exportShootPackage } from '../lib/shoot-package.js';
import { platformInfo, PLATFORMS, chromeLaunchHint } from '../lib/publishers/browser.js';

const SCRIPT = {
  title: '内容代运营怎么做',
  durationSec: 30,
  narration: [
    { t: '0-3s', text: '90%的人不知道这件事' },
    { t: '3-15s', text: '先说结论：先定位再拍摄' },
    { t: '15-30s', text: '恒野在芜湖做内容代运营' },
  ],
  shots: [
    { t: '0-3s', shot: '近景·出镜口播', caption: '90%的人不知道', broll: '人物实拍' },
    { t: '3-15s', shot: '特写·录屏', caption: '先定位再拍摄', broll: '手机录屏' },
  ],
  hashtags: ['#内容运营', '#GEO'],
};

// ---------------------------------------------------------------- 公众号

test('公众号未配置时明确说明缺什么', () => {
  assert.equal(wechatReadiness({}).ready, false);
  assert.match(wechatReadiness({}).reason, /WECHAT_APPID/);
  assert.match(wechatReadiness({ WECHAT_APPID: 'wx1' }).reason, /WECHAT_SECRET/);
  assert.equal(wechatReadiness({ WECHAT_APPID: 'wx1', WECHAT_SECRET: 's' }).ready, true);
});

test('Markdown 转公众号 HTML：标题/加粗/列表/链接', () => {
  const html = markdownToWechatHtml('## 小标题\n\n正文**加粗**和[链接](https://example.com)\n\n- 一\n- 二');
  assert.ok(html.includes('<h2>小标题</h2>'));
  assert.ok(html.includes('<strong>加粗</strong>'));
  assert.ok(html.includes('<a href="https://example.com">链接</a>'));
  assert.ok(html.includes('<ul>') && html.includes('<li>一</li>'));
});

test('公众号 HTML 会转义尖括号，避免注入', () => {
  const html = markdownToWechatHtml('<script>alert(1)</script>');
  assert.equal(html.includes('<script>'), false);
  assert.ok(html.includes('&lt;script&gt;'));
});

// ---------------------------------------------------------------- 浏览器

test('六个平台编辑器地址齐全', () => {
  assert.deepEqual(Object.keys(PLATFORMS), ['zhihu', 'toutiao', 'baijiahao', 'xiaohongshu', 'douyin', 'wechat_mp']);
  assert.equal(platformInfo('zhihu').url, 'https://zhuanlan.zhihu.com/write');
  assert.equal(platformInfo('未知'), null);
});

test('每个平台都配了标题与正文选择器（平台改版时只改这里）', () => {
  for (const [id, platform] of Object.entries(PLATFORMS)) {
    assert.ok(Array.isArray(platform.title) && platform.title.length > 0, `${id} 缺标题选择器`);
    assert.ok(Array.isArray(platform.body) && platform.body.length > 0, `${id} 缺正文选择器`);
  }
});

test('调试端口提示命令可复制执行', () => {
  assert.match(chromeLaunchHint(), /--remote-debugging-port=9222/);
  assert.match(chromeLaunchHint(9333), /9333/);
});
