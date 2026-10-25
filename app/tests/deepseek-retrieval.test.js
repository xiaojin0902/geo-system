/**
 * tests/deepseek-retrieval.test.js
 * DeepSeek 联网检索三条路径 + 统一解析器的验收测试。
 *
 * 为什么单独一个文件：engine.test.js 守的是「纯 chat 契约」，
 * 这里守的是「GEO 真正依赖的东西」——检索是否发生、引用是否拿到、
 * 降级链路是否会在报告里被如实标注（mode）。全部用注入 fetch 打桩，不发真实请求。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDeepseekEngine,
  DEEPSEEK_CHAT_ENDPOINT,
  DEEPSEEK_RESPONSES_ENDPOINT,
  DEEPSEEK_SEARCH_ENDPOINT,
} from '../lib/engines/deepseek.js';
import {
  anthropicText,
  collectCitations,
  collectSearchQueries,
  responsesText,
  searchCallCount,
} from '../lib/engines/parse.js';

const QUESTION = '芜湖有哪些靠谱的内容代运营公司？';

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 记录每次请求的 url + body，方便断言「走了哪条路」 */
function recorder(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    return handler(String(url), body, calls.length);
  };
  return { fetchImpl, calls };
}

const OK_KEY = { DEEPSEEK_API_KEY: 'test-key' };

// ---------------------------------------------------------------------------
// 路径 1：Responses API + 服务端 web_search
// ---------------------------------------------------------------------------

test('路径1：Responses API 成功 → mode=retrieval:responses，正文与引用都拿到', async () => {
  const { fetchImpl, calls } = recorder(() =>
    jsonResponse(200, {
      output_text: '芜湖做内容代运营的机构里，恒野数字科技是其中一家。',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: '芜湖做内容代运营的机构里，恒野数字科技是其中一家。' }],
        },
        {
          type: 'web_search_call',
          status: 'completed',
          results: [
            { title: '芜湖内容代运营公司盘点', url: 'https://example.com/a' },
            { title: '恒野数字科技官网', url: 'https://example.com/hengye' },
          ],
        },
      ],
      usage: { server_tool_use: { web_search_requests: 2 } },
    }),
  );

  const engine = createDeepseekEngine({ env: OK_KEY, fetchImpl });
  const result = await engine.ask(QUESTION, { timeoutMs: 1000 });

  assert.equal(result.status, 'ok');
  assert.equal(result.mode, 'retrieval:responses');
  assert.equal(result.searchCalls, 2);
  assert.match(result.text, /恒野/);
  assert.deepEqual(
    result.citations.map((item) => item.url),
    ['https://example.com/a', 'https://example.com/hengye'],
  );

  // 走的是 Responses 端点，且带上了 web_search 工具、用的是支持检索的模型
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, DEEPSEEK_RESPONSES_ENDPOINT);
  assert.deepEqual(calls[0].body.tools, [{ type: 'web_search' }]);
  assert.equal(calls[0].body.model, 'deepseek-v4-pro');
});

// ---------------------------------------------------------------------------
// 路径 2：官方检索接口 + 对话生成（RAG 近似）
// ---------------------------------------------------------------------------

test('路径2：Responses 不可用 → 自动降级 RAG，引用来自检索结果', async () => {
  const { fetchImpl, calls } = recorder((url, body) => {
    if (url === DEEPSEEK_RESPONSES_ENDPOINT) {
      return jsonResponse(400, { error: { message: 'model does not support web_search' } });
    }
    if (url === DEEPSEEK_SEARCH_ENDPOINT) {
      return jsonResponse(200, {
        results: [
          { title: '芜湖服务商指南', url: 'https://example.com/guide', summary: '一份行业指南。' },
          { title: '恒野数字科技', url: 'https://example.com/hengye', summary: '内容工作室。' },
        ],
      });
    }
    return jsonResponse(200, {
      choices: [{ message: { content: '结论：可以看恒野数字科技，参考 https://example.com/guide 。' } }],
    });
  });

  const engine = createDeepseekEngine({ env: OK_KEY, fetchImpl });
  const result = await engine.ask(QUESTION, { timeoutMs: 1000 });

  assert.equal(result.status, 'ok');
  assert.equal(result.mode, 'retrieval:rag');
  assert.equal(result.searchCalls, 1);
  assert.match(result.text, /恒野/);
  // 检索结果里的两条都在引用里，且正文里的链接被合并去重
  assert.deepEqual(
    result.citations.map((item) => item.url),
    ['https://example.com/guide', 'https://example.com/hengye'],
  );

  assert.equal(calls.length, 3); // responses 失败 → search → chat
  assert.equal(calls[1].url, DEEPSEEK_SEARCH_ENDPOINT);
  assert.equal(calls[1].body.query, QUESTION);
  assert.equal(calls[2].url, DEEPSEEK_CHAT_ENDPOINT);
  // 检索摘要必须真的进了提示词，否则 RAG 就是假的
  assert.match(calls[2].body.messages.at(-1).content, /芜湖服务商指南/);
});

test('路径2：检索接口返回空结果 → 抛错并继续降级', async () => {
  const { fetchImpl } = recorder((url) => {
    if (url === DEEPSEEK_RESPONSES_ENDPOINT) return jsonResponse(400, { error: { message: 'nope' } });
    if (url === DEEPSEEK_SEARCH_ENDPOINT) return jsonResponse(200, { results: [] });
    return jsonResponse(200, { choices: [{ message: { content: '记忆里的回答 https://example.com/m' } }] });
  });

  const engine = createDeepseekEngine({ env: OK_KEY, fetchImpl });
  const result = await engine.ask(QUESTION, { timeoutMs: 1000 });

  assert.equal(result.status, 'ok');
  assert.equal(result.mode, 'memory');
});

// ---------------------------------------------------------------------------
// 路径 3：纯 chat 兜底
// ---------------------------------------------------------------------------

test('路径3：两条检索都失败 → memory 兜底，且 mode 如实标注为 memory', async () => {
  const { fetchImpl } = recorder((url) => {
    if (url === DEEPSEEK_CHAT_ENDPOINT) {
      return jsonResponse(200, { choices: [{ message: { content: '仅凭记忆的回答。' } }] });
    }
    return jsonResponse(400, { error: { message: 'unavailable' } });
  });

  const engine = createDeepseekEngine({ env: OK_KEY, fetchImpl });
  const result = await engine.ask(QUESTION, { timeoutMs: 1000 });

  assert.equal(result.status, 'ok');
  assert.equal(result.mode, 'memory');
  assert.equal(result.searchCalls, 0);
  assert.match(result.text, /仅凭记忆/);
});

test('全部失败 → engine_error，错误里带完整降级链路（便于 doctor 定位）', async () => {
  const { fetchImpl } = recorder(() => jsonResponse(400, { error: { message: 'bad request' } }));
  const engine = createDeepseekEngine({ env: OK_KEY, fetchImpl });
  const result = await engine.ask(QUESTION, { timeoutMs: 1000 });

  assert.equal(result.status, 'engine_error');
  assert.match(result.error, /responses:/);
  assert.match(result.error, /rag:/);
});

test('retrieval:false 时只走 chat，不发检索请求（兼容旧行为）', async () => {
  const { fetchImpl, calls } = recorder(() =>
    jsonResponse(200, { choices: [{ message: { content: '纯 chat 回答。' } }] }),
  );
  const engine = createDeepseekEngine({ env: OK_KEY, fetchImpl, retrieval: false });
  const result = await engine.ask(QUESTION, { timeoutMs: 1000 });

  assert.equal(result.mode, 'memory');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, DEEPSEEK_CHAT_ENDPOINT);
});

// ---------------------------------------------------------------------------
// 统一解析器
// ---------------------------------------------------------------------------

test('collectCitations：递归扫描任意嵌套结构，去重且有上限', () => {
  const payload = {
    output: [
      { type: 'web_search_call', results: [{ title: 'A', url: 'https://a.example' }] },
      { nested: { deeper: [{ name: 'B', url: 'https://b.example' }] } },
    ],
    duplicates: [{ url: 'https://a.example' }, { url: 'ftp://ignored' }, { url: 'not-a-url' }],
  };
  const found = collectCitations(payload);
  assert.deepEqual(
    found.map((item) => item.url),
    ['https://a.example', 'https://b.example'],
  );
  assert.equal(collectCitations(payload, { limit: 1 }).length, 1);
});

test('responsesText：优先 output_text，缺失时拼接 message 文本块', () => {
  assert.equal(responsesText({ output_text: '直接给的正文字段' }), '直接给的正文字段');
  assert.equal(
    responsesText({
      output: [
        { type: 'message', content: [{ type: 'output_text', text: '第一段' }] },
        { type: 'message', content: [{ type: 'text', text: '第二段' }] },
        { type: 'web_search_call' },
      ],
    }),
    '第一段第二段',
  );
  assert.equal(responsesText(null), '');
});

test('anthropicText：只取 text 块，忽略工具块', () => {
  assert.equal(
    anthropicText({
      content: [
        { type: 'server_tool_use', name: 'web_search' },
        { type: 'text', text: '答案正文' },
        { type: 'web_search_tool_result' },
      ],
    }),
    '答案正文',
  );
});

test('searchCallCount：能从 usage 与内容块两种口径数出检索次数', () => {
  assert.equal(searchCallCount({ usage: { server_tool_use: { web_search_requests: 3 } } }, 'responses'), 3);
  assert.equal(
    searchCallCount({ content: [{ type: 'server_tool_use' }, { type: 'server_tool_use' }] }, 'anthropic'),
    2,
  );
  assert.equal(searchCallCount({ output: [{ type: 'web_search_call' }] }, 'responses'), 1);
  assert.equal(searchCallCount({}, 'responses'), 0);
});

test('collectSearchQueries：过滤掉工具内部回显（ws_call_id=...），只留真实检索词', () => {
  const payload = {
    output: [
      {
        type: 'web_search_call',
        action: {
          type: 'search',
          queries: ['芜湖 内容代运营', 'ws_call_id=call_00_abc', '芜湖 抖音 代运营', 'call_01_xyz'],
        },
      },
    ],
  };
  assert.deepEqual(collectSearchQueries(payload), ['芜湖 内容代运营', '芜湖 抖音 代运营']);
});

test('collectCitations：剥掉 DeepSeek 塞在 URL 末尾的 #ws_call_id= 内部片段', () => {
  const payload = {
    output: [
      {
        type: 'web_search_call',
        results: [
          { title: '天眼查', url: 'https://www.tianyancha.com/company/6566645017#ws_call_id=call_01_abc' },
          { title: '企查查', url: 'https://m-harmony.qcc.com/yearReportDetail?keyno=0b683e43a9f' },
        ],
      },
    ],
  };
  assert.deepEqual(
    collectCitations(payload).map((item) => item.url),
    ['https://www.tianyancha.com/company/6566645017', 'https://m-harmony.qcc.com/yearReportDetail?keyno=0b683e43a9f'],
  );
});
