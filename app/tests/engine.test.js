/**
 * tests/engine.test.js
 * 覆盖：引擎清单/选择、mock 确定性 + 分布 + 引用、http 重试/超时/错误分类、
 * deepseek / dashscope 的无 key 与假 fetch 成功/失败路径。
 * 全程零网络、零 npm 依赖。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { listEngines, getEngine, selectEngines } from '../lib/engines/index.js';
import { postJson } from '../lib/engines/http.js';
import { createMockEngine } from '../lib/engines/mock.js';
import { createDeepseekEngine } from '../lib/engines/deepseek.js';
import { createDashscopeEngine } from '../lib/engines/dashscope.js';

const KEY_NAMES = ['DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY'];

const brand = {
  slug: 'hengye',
  name: '恒野',
  legalName: '芜湖恒野数字科技有限公司',
  aliases: ['恒野', '芜湖恒野', '恒野数字科技', '恒野工作室'],
  ambiguousAliases: ['恒野'],
  city: '芜湖',
  industry: '内容代运营 / GEO 优化服务',
  services: ['内容代运营', '起号陪跑', '老板 IP', '工具代建', 'GEO 优化'],
  targetCustomers: ['个人创作者', '本地商家', '小团队'],
  competitors: ['宇典科技', '力行文化'],
};

/** 临时清空 key 环境变量，避免本机真实 key 影响「无 key」断言。 */
function useCleanKeyEnv(t) {
  const saved = {};
  for (const name of KEY_NAMES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  t.after(() => {
    for (const name of KEY_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
}

/** 构造一个假的 fetch Response。 */
function fakeResponse(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

// ---------------------------------------------------------------------------
// 引擎清单与选择
// ---------------------------------------------------------------------------

test('listEngines 返回唯一引擎清单（mock + 11 家 AI 引擎）', () => {
  const engines = listEngines();
  assert.deepEqual(
    engines.map((engine) => engine.id),
    [
      'mock',
      'deepseek', 'dashscope', 'doubao', 'kimi', 'yuanbao',
      'wenxin', 'zhipu', 'hunyuan', 'minimax', 'gemini', 'openai',
    ],
  );
  assert.equal(engines[0].requiresKey, false);
  assert.equal(engines[1].requiresKey, true);
  assert.equal(engines[2].requiresKey, true);
  for (const engine of engines) {
    assert.equal(typeof engine.label, 'string');
    assert.ok(engine.label.length > 0);
  }
  // 返回值应为副本，外部修改不影响常量源
  engines[0].id = 'hacked';
  assert.equal(listEngines()[0].id, 'mock');
});

test('getEngine 返回带 id/label/ask 的实例，未知 id 抛中文错误', async () => {
  const mock = getEngine('mock');
  assert.equal(mock.id, 'mock');
  assert.equal(typeof mock.ask, 'function');

  const deepseek = getEngine('deepseek', { env: {} });
  assert.equal(deepseek.id, 'deepseek');
  const dashscope = getEngine('dashscope', { env: {} });
  assert.equal(dashscope.id, 'dashscope');

  assert.throws(() => getEngine('gpt'), /未知引擎「gpt」/);
});

test("selectEngines('mock') 只返回 mock", () => {
  const engines = selectEngines('mock', { env: {} });
  assert.deepEqual(engines.map((engine) => engine.id), ['mock']);
});

test("selectEngines('live') 无 key 时抛出可操作错误，并建议 --engines mock", (t) => {
  useCleanKeyEnv(t);
  assert.throws(
    () => selectEngines('live', { env: {} }),
    (error) => {
      assert.match(error.message, /DEEPSEEK_API_KEY/);
      assert.match(error.message, /mock/);
      return true;
    },
  );
});

test("selectEngines('live') 只返回已配置 key 的引擎", (t) => {
  useCleanKeyEnv(t);
  const engines = selectEngines('live', { env: { DASHSCOPE_API_KEY: 'test-key' } });
  assert.deepEqual(engines.map((engine) => engine.id), ['dashscope']);
});

test("selectEngines('all') = mock + 已配置 key 的线上引擎", (t) => {
  useCleanKeyEnv(t);
  const engines = selectEngines('all', { env: { DEEPSEEK_API_KEY: 'test-key' } });
  assert.deepEqual(engines.map((engine) => engine.id), ['mock', 'deepseek']);
});

test("selectEngines 支持逗号列表与顺序、去重、未知 id 报错", (t) => {
  useCleanKeyEnv(t);
  const env = { DEEPSEEK_API_KEY: 'test-key', DASHSCOPE_API_KEY: 'test-key' };
  const engines = selectEngines('deepseek,mock,dashscope,mock', { env });
  assert.deepEqual(engines.map((engine) => engine.id), ['deepseek', 'mock', 'dashscope']);

  assert.throws(() => selectEngines('mock,foo', { env }), /未知引擎「foo」/);
});

// ---------------------------------------------------------------------------
// mock 引擎：确定性 + 分布 + 引用
// ---------------------------------------------------------------------------

test('mock 引擎完全确定性：同一问题同一品牌 → 同一回答', async () => {
  const question = '芜湖有哪些靠谱的内容代运营公司？';
  const engineA = createMockEngine();
  const engineB = createMockEngine();
  const first = await engineA.ask(question, { brand });
  const second = await engineA.ask(question, { brand });
  const third = await engineB.ask(question, { brand });

  assert.deepEqual(first, second);
  assert.deepEqual(first, third);
  assert.equal(first.status, 'ok');
  assert.ok(first.text.startsWith('[DEMO] '), '正常回答必须带 [DEMO] 前缀');
  assert.ok(Array.isArray(first.citations));
  assert.ok(first.citations.length >= 2 && first.citations.length <= 3, '应含 2-3 条假引用');
  for (const citation of first.citations) {
    // 引用域名来自演示站池（example.com 的子域名），用于演示「引用源分析」功能
    assert.match(citation.url, /^https:\/\/([a-z0-9-]+\.)?example\.com\/demo\//);
    assert.equal(typeof citation.title, 'string');
  }
  assert.equal(typeof first.latencyMs, 'number');
});

test('mock 引擎分布：约 40% 提及品牌、10% 拒答、5% engine_error（400 题抽样）', async () => {
  const engine = createMockEngine();
  const total = 400;
  let mentioned = 0;
  let refused = 0;
  let engineError = 0;
  let ok = 0;

  for (let i = 0; i < total; i += 1) {
    const result = await engine.ask(`演示问题-${i}：芜湖内容代运营怎么选？`, { brand });
    if (result.status === 'engine_error') {
      engineError += 1;
      assert.equal(result.text, '');
      assert.ok(result.error && result.error.length > 0);
      continue;
    }
    if (result.status === 'refused') {
      refused += 1;
      assert.ok(result.text.startsWith('[DEMO] '), '拒答回答也带 [DEMO] 前缀');
      continue;
    }
    assert.equal(result.status, 'ok');
    ok += 1;
    assert.ok(result.text.startsWith('[DEMO] '));
    assert.ok(result.citations.length >= 2 && result.citations.length <= 3);
    if (result.text.includes('恒野')) mentioned += 1;
  }

  const ratio = (count) => count / total;
  assert.ok(ratio(mentioned) >= 0.3 && ratio(mentioned) <= 0.5, `品牌提及率异常：${ratio(mentioned)}`);
  assert.ok(ratio(refused) >= 0.05 && ratio(refused) <= 0.16, `拒答率异常：${ratio(refused)}`);
  assert.ok(ratio(engineError) >= 0.02 && ratio(engineError) <= 0.09, `engine_error 率异常：${ratio(engineError)}`);
  assert.equal(ok + refused + engineError, total);
});

test('mock 引擎不联网：没有 key、没有 fetch 也能得到回答', async (t) => {
  useCleanKeyEnv(t);
  const engine = createMockEngine();
  const result = await engine.ask('恒野是做什么的？', { brand, timeoutMs: 1 });
  assert.ok(['ok', 'refused', 'engine_error'].includes(result.status));
  assert.equal(typeof result.text, 'string');
});

// ---------------------------------------------------------------------------
// http：重试 / 超时 / 错误分类
// ---------------------------------------------------------------------------

test('postJson 成功时发送 JSON body 并解析响应', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return fakeResponse(200, JSON.stringify({ hello: 'world' }));
  };

  const data = await postJson('https://example.com/api', {
    headers: { authorization: 'Bearer x' },
    body: { model: 'm' },
    fetchImpl,
  });

  assert.deepEqual(data, { hello: 'world' });
  assert.equal(captured.url, 'https://example.com/api');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['content-type'], 'application/json');
  assert.equal(captured.init.headers.authorization, 'Bearer x');
  assert.deepEqual(JSON.parse(captured.init.body), { model: 'm' });
});

test('postJson 网络错误重试 2 次后成功（合计 3 次请求）', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) throw new TypeError('network down');
    return fakeResponse(200, '{"ok":true}');
  };

  const data = await postJson('https://example.com/api', {
    body: {},
    retries: 2,
    retryBaseMs: 0,
    fetchImpl,
  });

  assert.deepEqual(data, { ok: true });
  assert.equal(calls, 3);
});

test('postJson 对 401 不重试，直接抛带状态码的中文错误', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return fakeResponse(401, '{"error":"invalid api key"}');
  };

  await assert.rejects(
    postJson('https://example.com/api', { body: {}, retries: 2, retryBaseMs: 0, fetchImpl }),
    (error) => {
      assert.equal(error.code, 'HTTP');
      assert.equal(error.statusCode, 401);
      assert.match(error.message, /HTTP 401/);
      return true;
    },
  );
  assert.equal(calls, 1, '4xx 不应重试');
});

test('postJson 对 5xx 重试到次数上限后抛错', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return fakeResponse(503, 'upstream down');
  };

  await assert.rejects(
    postJson('https://example.com/api', { body: {}, retries: 2, retryBaseMs: 0, fetchImpl }),
    /HTTP 503/,
  );
  assert.equal(calls, 3);
});

test('postJson 超时抛 TIMEOUT 错误', async () => {
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });

  await assert.rejects(
    postJson('https://example.com/api', { body: {}, timeoutMs: 5, retries: 0, fetchImpl }),
    (error) => {
      assert.equal(error.code, 'TIMEOUT');
      assert.match(error.message, /超时/);
      return true;
    },
  );
});

test('postJson 响应不是 JSON 时抛 PARSE 错误且不重试', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return fakeResponse(200, 'not-json');
  };

  await assert.rejects(
    postJson('https://example.com/api', { body: {}, retries: 2, retryBaseMs: 0, fetchImpl }),
    (error) => {
      assert.equal(error.code, 'PARSE');
      return true;
    },
  );
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// deepseek / dashscope
// ---------------------------------------------------------------------------

test('deepseek 无 key → status:unavailable（不抛异常）', async (t) => {
  useCleanKeyEnv(t);
  const engine = createDeepseekEngine({ env: {} });
  const result = await engine.ask('芜湖有哪些内容代运营公司？', { brand });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.text, '');
  assert.deepEqual(result.citations, []);
  assert.match(result.error, /DEEPSEEK_API_KEY/);
});

test('dashscope 无 key → status:unavailable（不抛异常）', async (t) => {
  useCleanKeyEnv(t);
  const engine = createDashscopeEngine({ env: {} });
  const result = await engine.ask('芜湖有哪些内容代运营公司？', { brand });
  assert.equal(result.status, 'unavailable');
  assert.match(result.error, /DASHSCOPE_API_KEY/);
});

test('deepseek 正常路径：请求体符合 OpenAI 兼容格式，抽取引用', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return fakeResponse(
      200,
      JSON.stringify({
        choices: [{ message: { content: '芜湖恒野是一家内容工作室。参考：https://example.com/ref-a' } }],
      }),
    );
  };

  const engine = createDeepseekEngine({ env: { DEEPSEEK_API_KEY: 'test-key' }, fetchImpl, retrieval: false });
  const result = await engine.ask('芜湖有哪些内容代运营公司？', { brand, timeoutMs: 1000 });

  assert.equal(result.status, 'ok');
  assert.match(result.text, /芜湖恒野/);
  assert.equal(result.citations[0].url, 'https://example.com/ref-a');
  assert.ok(result.latencyMs >= 0);

  assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(captured.init.headers.authorization, 'Bearer test-key');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'deepseek-chat');
  assert.equal(body.messages.at(-1).role, 'user');
  assert.equal(body.messages.at(-1).content, '芜湖有哪些内容代运营公司？');
});

test('deepseek 拒答回答 → status:refused', async () => {
  const fetchImpl = async () =>
    fakeResponse(200, JSON.stringify({ choices: [{ message: { content: '抱歉，我无法回答这个问题。' } }] }));
  const engine = createDeepseekEngine({ env: { DEEPSEEK_API_KEY: 'test-key' }, fetchImpl, retrieval: false });
  const result = await engine.ask('某个不能回答的问题', { brand });
  assert.equal(result.status, 'refused');
});

test('deepseek 网络失败 → status:engine_error（不抛异常）', async () => {
  const fetchImpl = async () => {
    throw new TypeError('boom');
  };
  const engine = createDeepseekEngine({
    env: { DEEPSEEK_API_KEY: 'test-key' },
    fetchImpl,
    retries: 0,
    retryBaseMs: 0,
    retrieval: false,
  });
  const result = await engine.ask('芜湖有哪些内容代运营公司？', { brand });
  assert.equal(result.status, 'engine_error');
  assert.match(result.error, /网络错误/);
});

test('deepseek 空回答 → status:engine_error', async () => {
  const fetchImpl = async () => fakeResponse(200, JSON.stringify({ choices: [{ message: { content: '' } }] }));
  const engine = createDeepseekEngine({ env: { DEEPSEEK_API_KEY: 'test-key' }, fetchImpl, retrieval: false });
  const result = await engine.ask('芜湖有哪些内容代运营公司？', { brand });
  assert.equal(result.status, 'engine_error');
});

test('dashscope 正常路径：qwen-plus + extra_body.enable_search，解析 search_info 引用', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return fakeResponse(
      200,
      JSON.stringify({
        choices: [{ message: { content: '芜湖恒野数字科技提供内容代运营服务。' } }],
        search_info: {
          search_results: [
            { title: '示例来源', url: 'https://example.com/search-a' },
            { title: '另一来源', url: 'https://example.com/search-b' },
          ],
        },
      }),
    );
  };

  const engine = createDashscopeEngine({ env: { DASHSCOPE_API_KEY: 'test-key' }, fetchImpl });
  const result = await engine.ask({ text: '芜湖有哪些内容代运营公司？' }, { brand, timeoutMs: 1000 });

  assert.equal(result.status, 'ok');
  assert.equal(captured.url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'qwen-plus');
  assert.deepEqual(body.extra_body, { enable_search: true });
  assert.equal(body.messages.at(-1).content, '芜湖有哪些内容代运营公司？');
  assert.deepEqual(
    result.citations.map((citation) => citation.url),
    ['https://example.com/search-a', 'https://example.com/search-b'],
  );
});

test('dashscope 上游 401 → status:engine_error', async () => {
  const fetchImpl = async () => fakeResponse(401, '{"error":"bad key"}');
  const engine = createDashscopeEngine({ env: { DASHSCOPE_API_KEY: 'bad' }, fetchImpl, retryBaseMs: 0 });
  const result = await engine.ask('芜湖有哪些内容代运营公司？', { brand });
  assert.equal(result.status, 'engine_error');
  assert.match(result.error, /HTTP 401/);
});
