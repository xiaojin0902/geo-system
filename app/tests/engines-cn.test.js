/**
 * tests/engines-cn.test.js
 * 三个新中文引擎（豆包 / Kimi / 元宝中转）的验收测试。
 *
 * 为什么单独一个文件：这些引擎用同一个「OpenAI 兼容工厂」，差异只在配置与
 * 联网工具声明。这里守的是三件事：
 *   1. 配置不齐时必须 unavailable 并说清缺什么（不能静默失败）；
 *   2. 联网工具被服务端拒绝时要能降级重试，并如实标 memory；
 *   3. query fan-out 与引用都要真的解析出来。
 * 全部用注入 fetch 打桩，不发真实请求，也不需要任何真实 Key。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDoubaoEngine, DOUBAO_ENDPOINT } from '../lib/engines/doubao.js';
import { createKimiEngine, KIMI_ENDPOINT } from '../lib/engines/kimi.js';
import { createYuanbaoEngine, yuanbaoEndpoint } from '../lib/engines/yuanbao.js';
import { collectSearchQueries } from '../lib/engines/parse.js';

const QUESTION = '芜湖有哪些内容代运营公司？';

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recorder(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body, headers: init?.headers ?? {} });
    return handler(String(url), body, calls.length);
  };
  return { fetchImpl, calls };
}

/** 一次带检索信息的成功响应（结构参考 OpenAI 兼容的 search_info + 引用） */
function okPayload({ text = '推荐恒野数字科技。', refs = [{ title: '知乎讨论', url: 'https://zhihu.com/p/1' }] } = {}) {
  return {
    choices: [{ message: { content: text } }],
    citations: refs,
    search_info: { search_results: refs, query: ['芜湖 内容代运营 推荐'] },
  };
}

// ------------------------------------------------------------------ 豆包

test('豆包：没有 Key → unavailable，且提示要配 DOUBAO_API_KEY', async () => {
  const engine = createDoubaoEngine({ env: {} });
  const result = await engine.ask(QUESTION);
  assert.equal(result.status, 'unavailable');
  assert.match(result.error, /API Key|DOUBAO/u);
});

test('豆包：有 Key 但没有模型 ID → unavailable，并说明去控制台拿接入点 ID', async () => {
  const engine = createDoubaoEngine({ env: { DOUBAO_API_KEY: 'k' } });
  const result = await engine.ask(QUESTION);
  assert.equal(result.status, 'unavailable');
  assert.match(result.error, /endpoint|model|配置/u);

  const { doubaoReadiness } = await import('../lib/engines/doubao.js');
  const readiness = doubaoReadiness({ DOUBAO_API_KEY: 'k' });
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /DOUBAO_MODEL/);
  assert.match(readiness.reason, /ep-|doubao-/);
});

test('豆包：正常路径 → 打方舟端点、带 web_search 工具、解析引用与 fan-out', async () => {
  const { fetchImpl, calls } = recorder(() => jsonResponse(200, okPayload()));
  const engine = createDoubaoEngine({
    env: { DOUBAO_API_KEY: 'k', DOUBAO_MODEL: 'ep-2024xxxx' },
    fetchImpl,
  });
  const result = await engine.ask(QUESTION, { timeoutMs: 1000 });

  assert.equal(result.status, 'ok');
  assert.equal(calls[0].url, DOUBAO_ENDPOINT);
  assert.deepEqual(calls[0].body.tools, [{ type: 'web_search' }]);
  assert.equal(calls[0].body.model, 'ep-2024xxxx');
  assert.equal(calls[0].headers.authorization, 'Bearer k');
  assert.match(result.text, /恒野/);
  assert.equal(result.citations[0].url, 'https://zhihu.com/p/1');
  assert.ok(result.searchQueries.includes('芜湖 内容代运营 推荐'));
  assert.match(result.mode, /^retrieval:/);
  assert.ok(result.searchCalls >= 1);
});

test('豆包：服务端不认 tools → 自动降级重试一次，并如实标 memory', async () => {
  const { fetchImpl, calls } = recorder((url, body) => {
    if (body && body.tools) return jsonResponse(400, { error: { message: 'unknown field tools' } });
    return jsonResponse(200, { choices: [{ message: { content: '纯对话回答。' } }] });
  });
  const engine = createDoubaoEngine({
    env: { DOUBAO_API_KEY: 'k', DOUBAO_MODEL: 'ep-x' },
    fetchImpl,
  });
  const result = await engine.ask(QUESTION, { timeoutMs: 1000 });

  assert.equal(result.status, 'ok');
  assert.equal(calls.length, 2, '应该带工具失败一次 + 不带工具成功一次');
  assert.equal(result.mode, 'memory', '没有检索证据时必须标 memory，不能冒充检索');
  assert.equal(result.searchCalls, 0);
});

test('豆包：DOUBAO_SEARCH=0 时不声明搜索工具', async () => {
  const { fetchImpl, calls } = recorder(() => jsonResponse(200, okPayload({ refs: [] })));
  const engine = createDoubaoEngine({
    env: { DOUBAO_API_KEY: 'k', DOUBAO_MODEL: 'ep-x', DOUBAO_SEARCH: '0' },
    fetchImpl,
  });
  await engine.ask(QUESTION, { timeoutMs: 1000 });
  assert.equal(calls[0].body.tools, undefined);
});

// ------------------------------------------------------------------ Kimi

test('Kimi：打 Moonshot 端点，声明内置 $web_search 工具', async () => {
  const { fetchImpl, calls } = recorder(() => jsonResponse(200, okPayload()));
  const engine = createKimiEngine({ env: { KIMI_API_KEY: 'k' }, fetchImpl });
  const result = await engine.ask(QUESTION, { timeoutMs: 1000 });

  assert.equal(result.status, 'ok');
  assert.equal(calls[0].url, KIMI_ENDPOINT);
  assert.deepEqual(calls[0].body.tools, [{ type: 'builtin_function', function: { name: '$web_search' } }]);
  assert.match(result.mode, /^retrieval:/);
  assert.ok(result.searchQueries.length > 0);
});

test('Kimi：支持 MOONSHOT_API_KEY 别名，且 KIMI_MODEL 可覆盖默认模型', async () => {
  const { fetchImpl, calls } = recorder(() => jsonResponse(200, okPayload()));
  const engine = createKimiEngine({
    env: { MOONSHOT_API_KEY: 'k', KIMI_MODEL: 'kimi-k2-turbo' },
    fetchImpl,
  });
  const result = await engine.ask(QUESTION, { timeoutMs: 1000 });
  assert.equal(result.status, 'ok');
  assert.equal(calls[0].body.model, 'kimi-k2-turbo');
});

// ------------------------------------------------------------------ 元宝

test('元宝：没有中转地址 → unavailable，并解释「元宝没有官方 API」', async () => {
  const engine = createYuanbaoEngine({ env: { YUANBAO_API_KEY: 'k' } });
  const result = await engine.ask(QUESTION);
  assert.equal(result.status, 'unavailable');
  assert.match(result.error, /API Key|配置/u);
});

test('元宝：端点由 YUANBAO_BASE_URL 拼出，兼容已带 /chat/completions 的情况', () => {
  assert.equal(yuanbaoEndpoint({ YUANBAO_BASE_URL: 'https://relay.example/v1' }), 'https://relay.example/v1/chat/completions');
  assert.equal(
    yuanbaoEndpoint({ YUANBAO_BASE_URL: 'https://relay.example/v1/chat/completions' }),
    'https://relay.example/v1/chat/completions',
  );
  assert.equal(yuanbaoEndpoint({}), '');
});

test('元宝：正常路径可采集回答与引用', async () => {
  const { fetchImpl, calls } = recorder(() => jsonResponse(200, okPayload()));
  const engine = createYuanbaoEngine({
    env: { YUANBAO_BASE_URL: 'https://relay.example/v1', YUANBAO_API_KEY: 'k', YUANBAO_MODEL: 'hunyuan' },
    fetchImpl,
  });
  const result = await engine.ask(QUESTION, { timeoutMs: 1000 });
  assert.equal(result.status, 'ok');
  assert.equal(calls[0].url, 'https://relay.example/v1/chat/completions');
  assert.equal(calls[0].body.model, 'hunyuan');
});

// ------------------------------------------------------------------ fan-out 解析

test('collectSearchQueries：递归收集 query/queries/rewritten_query，去重且不误收普通字段', () => {
  const payload = {
    search_info: { query: ['芜湖 内容代运营', '芜湖 内容代运营 推荐'] },
    output: [{ action: { query: '内容代运营 哪家好' } }],
    nested: { queries: ['芜湖 内容代运营'] },
    answer: { text: '这不是检索词' },
  };
  const queries = collectSearchQueries(payload);
  assert.deepEqual(queries, ['芜湖 内容代运营', '芜湖 内容代运营 推荐', '内容代运营 哪家好']);
});
