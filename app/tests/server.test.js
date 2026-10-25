/**
 * tests/server.test.js
 * 控制台服务与环境自检的验收测试。
 *
 * 说明：服务端测试会真实监听 127.0.0.1 的临时端口并发本地 HTTP 请求，
 * 但**不会 spawn 诊断子进程**（那会写数据库、耗时长），只验证页面与只读 API。
 * 自检模块全程不发网络请求。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runDoctor } from '../lib/doctor.js';
import { startServer } from '../lib/server.js';

// ---------------------------------------------------------------- 环境自检

test('doctor：没有任何密钥时 ok=false，且明确指向 DEEPSEEK_API_KEY', async () => {
  const report = await runDoctor({ env: {}, brandSlug: 'hengye' });
  assert.equal(report.ok, false);
  const keyCheck = report.checks.find((c) => c.id === 'keys');
  assert.ok(keyCheck, '必须有 keys 检查项');
  assert.equal(keyCheck.ok, false);
  assert.match(keyCheck.detail, /demo/);
  assert.match(keyCheck.action, /DEEPSEEK_API_KEY/);
  // 不允许把「没 key」当成通过
  assert.equal(report.keys.filter((k) => k.present).length, 0);
});

test('doctor：注入了密钥后 keys 检查通过（不校验真伪，只校验存在性）', async () => {
  const report = await runDoctor({
    env: { DEEPSEEK_API_KEY: 'sk-test-xxx' },
    brandSlug: 'hengye',
  });
  const keyCheck = report.checks.find((c) => c.id === 'keys');
  assert.equal(keyCheck.ok, true);
  assert.match(keyCheck.detail, /DEEPSEEK_API_KEY/);
  // 引擎表里 deepseek 应标记为已配置
  assert.equal(report.engines.find((e) => e.id === 'deepseek').configured, true);
});

test('doctor：probe=false 时不发任何请求（fetchImpl 被调用即失败）', async () => {
  const report = await runDoctor({
    env: { DEEPSEEK_API_KEY: 'sk-test-xxx' },
    probe: false,
    fetchImpl: async () => {
      throw new Error('不该发请求');
    },
    brandSlug: 'hengye',
  });
  assert.deepEqual(report.probes, []);
});

test('doctor：probe=true 时会真调一次引擎，成功则标注 mode', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ output_text: '收到', output: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const report = await runDoctor({
    env: { DEEPSEEK_API_KEY: 'sk-test-xxx' },
    probe: true,
    fetchImpl,
    brandSlug: 'hengye',
    timeoutMs: 3000,
  });
  assert.equal(report.probes.length, 1);
  assert.equal(report.probes[0].ok, true);
  assert.match(report.probes[0].mode, /retrieval/);
  assert.match(report.probeNote, /DeepSeek|deepseek/);
});

// ---------------------------------------------------------------- 本地服务

// 注意：DATA_DIR 在 config.js 被 import 时就固化了，测试里改环境变量不会生效，
// 因此这里直接对现有数据目录做**只读**页面断言（不写库、不 spawn 诊断）。
async function withServer(fn) {
  const handle = await startServer({ port: 0, host: '127.0.0.1', brand: 'hengye' });
  try {
    await fn(handle);
  } finally {
    await handle.close();
  }
}

test('serve：总览页可访问且包含关键提示', async () => {
  await withServer(async ({ url }) => {
    const res = await fetch(`${url}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /恒野/);
    assert.match(html, /GEO/);
  });
});

test('serve：/health 与 /api/state 返回 JSON', async () => {
  await withServer(async ({ url }) => {
    const health = await (await fetch(`${url}/health`)).json();
    assert.equal(health.ok, true);
    const state = await (await fetch(`${url}/api/state`)).json();
    assert.ok('brand' in state && 'runs' in state && 'engines' in state);
    assert.equal(Array.isArray(state.runs), true);
    assert.equal(typeof state.counts, 'object');
  });
});

test('serve：未知路径返回 404 页面而不是崩溃', async () => {
  await withServer(async ({ url }) => {
    const res = await fetch(`${url}/no-such-page`);
    assert.equal(res.status, 404);
    assert.match(await res.text(), /404/);
  });
});

test('serve：报告静态路由禁止路径穿越与非法后缀', async () => {
  await withServer(async ({ url }) => {
    const bad = await fetch(`${url}/reports/..%2F..%2Fpackage.json`);
    assert.ok(bad.status >= 400, `期望 4xx，实际 ${bad.status}`);
    const missing = await fetch(`${url}/reports/run-999.html`);
    assert.equal(missing.status, 404);
  });
});

test('serve：POST /api/diagnose 参数非法时返回 400（不启动子进程）', async () => {
  await withServer(async ({ url }) => {
    const res = await fetch(`${url}/api/diagnose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engines: 'bad engine!!', limit: 10 }),
    });
    assert.equal(res.status, 400);
  });
});

test('serve：端口被占用时自动顺延', async () => {
  const first = await startServer({ port: 0, host: '127.0.0.1', brand: 'hengye' });
  try {
    const second = await startServer({ port: first.port, host: '127.0.0.1', brand: 'hengye' });
    try {
      assert.notEqual(second.port, first.port);
      assert.equal(second.port, first.port + 1);
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
  }
});
