/**
 * tests/publish-channels.test.js
 * 发布渠道抽象的验收测试：三态解析、dry_run 回执、api 投递与失败回流。
 *
 * 约定：
 * - 环境变量一律通过参数传入，不碰 process.env，测试并行时互不影响；
 * - 所有网络调用都注入 fetchImpl，本文件不会访问任何真实地址；
 * - 失败路径只断言「返回了错误回执」，不抛异常——这是调用方登记失败记录的前提。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHANNEL_STATES,
  CHANNELS,
  listChannels,
  publishTo,
  renderChannelsMarkdown,
  resolveChannelState,
} from '../lib/publish-channels.js';

/** 一段稳定超过 200 字的中文正文 */
const LONG_BODY = '恒野 GEO 的发布渠道测试正文，用来验证模拟回执与真实投递的分界。'.repeat(8);

const CONTENT = {
  title: '为什么发布渠道默认先走模拟',
  body: LONG_BODY,
  url: 'https://sanrenxing.cn/geo',
  contentId: 'content-1',
};

const API_ENV = { PUBLISH_ZHIHU_WEBHOOK: 'https://hooks.example.test/zhihu' };

/** 生成指定字数的正文，边界测试用 */
function bodyOf(length) {
  return '字'.repeat(length);
}

/**
 * 造一个可观测的 fetch 替身：记录每次调用的 url/init，并按需返回成功、失败或抛错。
 * 默认 json 返回空对象，避免测试之间共享可变对象。
 */
function createFetchStub({ ok = true, status = 200, json = {}, error = null, jsonError = null } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (error) throw error;
    return {
      ok,
      status,
      async json() {
        if (jsonError) throw jsonError;
        return json;
      },
    };
  };
  return { impl, calls };
}

/** 从 listChannels 结果里按 id 取一条，找不到直接让测试失败 */
function channelOf(list, id) {
  const found = list.find((channel) => channel.id === id);
  assert.ok(found, `渠道列表里应有 ${id}`);
  return found;
}

// ---------------------------------------------------------------- 定义与三态

test('渠道清单：三态常量齐全，6 个渠道定义结构正确且不写死 state', () => {
  assert.deepEqual(CHANNEL_STATES, ['not_connected', 'dry_run', 'api']);
  assert.ok(CHANNELS.length >= 6, '至少要有 6 个渠道');

  assert.deepEqual(
    CHANNELS.map((channel) => channel.id),
    ['zhihu', 'xiaohongshu', 'wechat', 'sohu', 'baijiahao', 'webhook'],
  );

  for (const channel of CHANNELS) {
    assert.equal(typeof channel.id, 'string');
    assert.ok(channel.name.length > 0, `${channel.id} 应有中文名`);
    assert.ok(Array.isArray(channel.requires), `${channel.id}.requires 应为数组`);
    assert.equal(typeof channel.note, 'string');
    assert.ok(!('state' in channel), `${channel.id} 的定义里不应写死 state`);
  }
});

test('默认环境：所有渠道都是 dry_run，零配置也能走通模拟流程', () => {
  const list = listChannels();

  assert.equal(list.length, CHANNELS.length);
  for (const channel of list) {
    assert.equal(channel.state, 'dry_run', `${channel.id} 默认应为 dry_run`);
    assert.equal(channel.ready, true, `${channel.id} 模拟态也应可走发布流程`);
  }
});

test('只配 ZHIHU webhook：只有知乎升级为 api，其余渠道仍是 dry_run', () => {
  const list = listChannels({ env: API_ENV });

  const zhihu = channelOf(list, 'zhihu');
  assert.equal(zhihu.state, 'api');
  assert.equal(zhihu.ready, true);

  for (const channel of list) {
    if (channel.id === 'zhihu') continue;
    assert.equal(channel.state, 'dry_run', `${channel.id} 不应被知乎的 webhook 带成 api`);
  }

  assert.equal(resolveChannelState('zhihu', { env: API_ENV }), 'api');
  assert.equal(resolveChannelState('xiaohongshu', { env: API_ENV }), 'dry_run');
});

test('PUBLISH_DRY_RUN=0 且没 webhook：全部 not_connected；webhook 仍可覆盖它', () => {
  const off = listChannels({ env: { PUBLISH_DRY_RUN: '0' } });
  for (const channel of off) {
    assert.equal(channel.state, 'not_connected', `${channel.id} 没接入时应为 not_connected`);
    assert.equal(channel.ready, false, `${channel.id} 没接入时不应 ready`);
  }

  // webhook 的优先级高于 PUBLISH_DRY_RUN=0：配了就是 api，不该被全局开关压掉
  const mixed = listChannels({
    env: { PUBLISH_DRY_RUN: '0', PUBLISH_ZHIHU_WEBHOOK: API_ENV.PUBLISH_ZHIHU_WEBHOOK },
  });
  assert.equal(channelOf(mixed, 'zhihu').state, 'api');
  assert.equal(channelOf(mixed, 'wechat').state, 'not_connected');
});

test('未知渠道：解析和发布都抛中文错误，不返回假回执', async () => {
  assert.throws(
    () => resolveChannelState('douyin'),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /未知发布渠道/);
      return true;
    },
  );

  await assert.rejects(
    () => publishTo({ channel: 'douyin', content: CONTENT }),
    /未知发布渠道/,
  );
});

// ---------------------------------------------------------------- 内容校验

test('正文不足 200 字：返回固定原因，且不调用 fetch', async () => {
  const stub = createFetchStub();
  const result = await publishTo({
    channel: 'zhihu',
    content: { ...CONTENT, body: '短正文'.repeat(20) },
    dryRun: false,
    env: API_ENV,
    fetchImpl: stub.impl,
  });

  assert.deepEqual(result, { ok: false, reason: '正文过短，不适合发布' });
  assert.equal(stub.calls.length, 0, '内容不合格时不该发起任何网络请求');
});

test('正文刚好 200 字：边界通过，回执 chars 与正文长度一致', async () => {
  const result = await publishTo({
    channel: 'zhihu',
    content: { ...CONTENT, body: bodyOf(200) },
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, 'dry_run');
  assert.equal(result.receipt.chars, 200);
});

test('标题为空或全是空白：拒绝发布，且不调用 fetch', async () => {
  const stub = createFetchStub();

  for (const title of ['', '   ']) {
    const result = await publishTo({
      channel: 'zhihu',
      content: { ...CONTENT, title },
      dryRun: false,
      env: API_ENV,
      fetchImpl: stub.impl,
    });
    assert.deepEqual(result, { ok: false, reason: '标题不能为空' });
  }

  assert.equal(stub.calls.length, 0);
});

// ---------------------------------------------------------------- dry_run 回执

test('dry_run 回执：同一内容两次完全一致，回执号是确定性 hash', async () => {
  const first = await publishTo({ channel: 'zhihu', content: CONTENT });
  const second = await publishTo({ channel: 'zhihu', content: CONTENT });

  // 不用随机数 / 时间戳，所以两次调用必须逐字段相等
  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  assert.equal(first.state, 'dry_run');
  assert.equal(first.receipt.channel, 'zhihu');
  assert.equal(first.receipt.title, CONTENT.title);
  assert.equal(first.receipt.chars, CONTENT.body.length);
  assert.match(first.receipt.receiptId, /^dry-[0-9a-f]{16}$/);
  assert.equal(typeof first.receipt.simulatedAt, 'string');
  assert.ok(first.receipt.simulatedAt.length > 0);

  // 内容变了，回执号必须跟着变，避免把两版稿子登记成同一次发布
  const changed = await publishTo({
    channel: 'zhihu',
    content: { ...CONTENT, title: '换一个标题' },
  });
  assert.notEqual(changed.receipt.receiptId, first.receipt.receiptId);
});

test('网络边界：只有显式 api 态 + dryRun:false 才会真正发请求', async () => {
  const stub = createFetchStub();

  // 1) api 态但没显式 dryRun:false：默认只模拟
  const apiButImplicit = await publishTo({
    channel: 'zhihu',
    content: CONTENT,
    env: API_ENV,
    fetchImpl: stub.impl,
  });
  assert.equal(apiButImplicit.state, 'dry_run');

  // 2) 显式 dryRun:false 但渠道仍是 dry_run：不联网
  const dryRunState = await publishTo({
    channel: 'zhihu',
    content: CONTENT,
    dryRun: false,
    env: {},
    fetchImpl: stub.impl,
  });
  assert.equal(dryRunState.state, 'dry_run');

  assert.equal(stub.calls.length, 0, '上述两种情况都不该访问网络');
});

// ---------------------------------------------------------------- api 投递

test('api 成功：POST 到 webhook、JSON 载荷正确、渠道回执原样返回', async () => {
  const apiReceipt = {
    receiptId: 'api-001',
    url: 'https://zhuanlan.zhihu.com/p/1',
    status: 'published',
  };
  const stub = createFetchStub({ json: apiReceipt });

  const result = await publishTo({
    channel: 'zhihu',
    content: CONTENT,
    dryRun: false,
    env: API_ENV,
    fetchImpl: stub.impl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, 'api');
  assert.deepEqual(result.receipt, apiReceipt);

  assert.equal(stub.calls.length, 1);
  const [{ url, init }] = stub.calls;
  assert.equal(url, API_ENV.PUBLISH_ZHIHU_WEBHOOK);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), {
    title: CONTENT.title,
    body: CONTENT.body,
    url: CONTENT.url,
    contentId: CONTENT.contentId,
  });
});

test('api 失败：HTTP 500 返回错误回执，不抛异常', async () => {
  const stub = createFetchStub({ ok: false, status: 500 });

  const result = await publishTo({
    channel: 'zhihu',
    content: CONTENT,
    dryRun: false,
    env: API_ENV,
    fetchImpl: stub.impl,
  });

  assert.equal(result.ok, false);
  assert.equal(result.state, 'api');
  assert.match(result.error, /500/);
  assert.equal(stub.calls.length, 1);
});

test('api 失败：网络异常被收进 error 字段，调用方进程不崩', async () => {
  const stub = createFetchStub({
    error: new Error('connect ECONNREFUSED 127.0.0.1:9'),
  });

  const result = await publishTo({
    channel: 'zhihu',
    content: CONTENT,
    dryRun: false,
    env: API_ENV,
    fetchImpl: stub.impl,
  });

  assert.equal(result.ok, false);
  assert.equal(result.state, 'api');
  assert.match(result.error, /ECONNREFUSED/);
});

test('api 失败：回执不是合法 JSON 时也返回错误对象', async () => {
  const stub = createFetchStub({ jsonError: new SyntaxError('Unexpected token <') });

  const result = await publishTo({
    channel: 'zhihu',
    content: CONTENT,
    dryRun: false,
    env: API_ENV,
    fetchImpl: stub.impl,
  });

  assert.equal(result.ok, false);
  assert.equal(result.state, 'api');
  assert.match(result.error, /JSON/);
});

test('not_connected：返回原因与可操作 hint，且绝不发网络', async () => {
  const stub = createFetchStub();

  const result = await publishTo({
    channel: 'zhihu',
    content: CONTENT,
    dryRun: false,
    env: { PUBLISH_DRY_RUN: '0' },
    fetchImpl: stub.impl,
  });

  assert.equal(result.ok, false);
  assert.equal(result.state, 'not_connected');
  assert.equal(result.reason, '渠道未接入');
  assert.match(result.hint, /PUBLISH_ZHIHU_WEBHOOK/, 'hint 要指出具体该配哪个变量');
  assert.equal(stub.calls.length, 0);
});

// ---------------------------------------------------------------- 列表与渲染

test('listChannels.ready：dry_run / api 为 true，not_connected 为 false', () => {
  const dryRun = channelOf(listChannels(), 'zhihu');
  const api = channelOf(listChannels({ env: API_ENV }), 'zhihu');
  const off = channelOf(listChannels({ env: { PUBLISH_DRY_RUN: '0' } }), 'zhihu');

  assert.equal(dryRun.ready, true);
  assert.equal(api.ready, true);
  assert.equal(off.ready, false);
});

test('renderChannelsMarkdown：三列表格，状态显示中文（未接入 / 模拟发布 / 已接入 API）', () => {
  const markdown = renderChannelsMarkdown([
    { name: '知乎专栏', state: 'not_connected', note: '还没配 webhook' },
    { name: '小红书', state: 'dry_run', note: '本次只出模拟回执' },
    { name: '微信公众号', state: 'api', note: '已接入自建发布服务' },
  ]);
  const lines = markdown.trimEnd().split('\n');

  assert.deepEqual(lines[0], '| 渠道 | 状态 | 说明 |');
  assert.equal(lines.length, 5, '表头 + 分隔行 + 3 行数据');
  assert.match(lines[2], /知乎专栏 \| 未接入 \|/);
  assert.match(lines[3], /小红书 \| 模拟发布 \|/);
  assert.match(lines[4], /微信公众号 \| 已接入 API \|/);
});

test('纯函数：重复调用结果一致，且不改动 env / content / CHANNELS', async () => {
  const env = Object.freeze({ ...API_ENV });
  const content = Object.freeze({ ...CONTENT });
  const envSnapshot = JSON.stringify(env);
  const contentSnapshot = JSON.stringify(content);
  const channelsSnapshot = JSON.stringify(CHANNELS);

  const firstList = listChannels({ env });
  const secondList = listChannels({ env });
  assert.deepEqual(firstList, secondList);
  assert.equal(
    renderChannelsMarkdown(firstList),
    renderChannelsMarkdown(secondList),
    '同一份渠道列表渲染结果必须一致',
  );

  // api 态 + 默认 dryRun=true，仍然只出模拟回执，不触发网络
  const firstReceipt = await publishTo({ channel: 'zhihu', content, env });
  const secondReceipt = await publishTo({ channel: 'zhihu', content, env });
  assert.deepEqual(firstReceipt, secondReceipt);

  assert.equal(JSON.stringify(env), envSnapshot);
  assert.equal(JSON.stringify(content), contentSnapshot);
  assert.equal(JSON.stringify(CHANNELS), channelsSnapshot);
});
