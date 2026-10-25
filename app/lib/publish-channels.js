/**
 * lib/publish-channels.js
 * 发布渠道抽象：把「发到哪个平台」收敛成一份渠道清单 + 三态解析 + 统一回执。
 *
 * 对应 OmniRank `services/publish_channels/` 的设计，只保留恒野当前用得上的部分：
 * - not_connected：没配 webhook，也没有开模拟，渠道不可用；
 * - dry_run：默认态，整条发布流程走完，但只在本地生成回执，不访问任何外部地址；
 * - api：该渠道配了 `PUBLISH_<ID大写>_WEBHOOK`，显式 `dryRun: false` 时才真正 POST。
 *
 * 为什么默认模拟：恒野以人工发布为主，开源版不预置任何平台凭据。默认 dry_run 让零配置
 * 也能跑通「校验 → 回执 → 登记」全流程，同时保证任何一次误调用都不会把稿件发到真实平台。
 * 真实网络必须同时满足三个条件：state 为 api、webhook 非空、调用方显式 `dryRun: false`。
 *
 * 为什么失败返回回执对象而不是抛异常：渠道超时、5xx、回执脏数据都是业务结果，调用方
 * （CLI / 控制台 / 定时任务）要把它们登记成失败回执并继续处理下一篇；让整条命令崩掉反而
 * 会丢掉这些上下文。只有「渠道 id 不存在」这类编程错误才抛 Error。
 *
 * 约束：零依赖、纯函数（`publishTo` 只在上述三个条件齐备时才发起一次网络请求）；
 * 不读写文件与数据库，落库由调用方负责。
 */

/** 渠道三态。顺序即 UI 展示顺序，不要随意调整。 */
export const CHANNEL_STATES = Object.freeze(['not_connected', 'dry_run', 'api']);

/**
 * 渠道清单。
 *
 * 刻意不写 `state`：同一份定义在 demo 与生产环境都能用，渠道到底处于哪一态由
 * `resolveChannelState()` 按环境变量实时解析。`requires` 预留给后续的账号绑定 / OAuth
 * 等必填项，当前所有渠道都只需要一个可选的 webhook，所以保持空数组。
 */
export const CHANNELS = Object.freeze([
  {
    id: 'zhihu',
    name: '知乎专栏',
    requires: [],
    note: '长文专栏，适合方法论与行业分析；配 webhook 后走真实发布 API',
  },
  {
    id: 'xiaohongshu',
    name: '小红书',
    requires: [],
    note: '图文笔记，正文要口语化、分段短；配 webhook 后走真实发布 API',
  },
  {
    id: 'wechat',
    name: '微信公众号',
    requires: [],
    note: '公众号图文，适合完整长文与案例拆解；配 webhook 后走真实发布 API',
  },
  {
    id: 'sohu',
    name: '搜狐号',
    requires: [],
    note: '搜狐号资讯，收录友好，适合行业解读；配 webhook 后走真实发布 API',
  },
  {
    id: 'baijiahao',
    name: '百家号',
    requires: [],
    note: '百家号资讯，百度系分发，适合本地服务词；配 webhook 后走真实发布 API',
  },
  {
    id: 'webhook',
    name: '通用 Webhook',
    requires: [],
    note: '通用 HTTP 回调，把稿件推给任意自建发布服务',
  },
]);

/** 正文下限：低于 200 字的稿子发出去既不像文章，也过不了平台原创审核。 */
const MIN_BODY_CHARS = 200;

/**
 * dry_run 回执里的固定时间占位。
 * 模拟回执必须可复现（测试、幂等登记都依赖这一点），所以不用 Date.now()；
 * 用 epoch 明示「这不是真实发布时间」，避免被误当成事实。
 */
const SIMULATED_AT = '1970-01-01T00:00:00.000Z';

/** 三态的中文展示名，渲染 Markdown / 控制台时共用。 */
const STATE_LABELS = Object.freeze({
  not_connected: '未接入',
  dry_run: '模拟发布',
  api: '已接入 API',
});

// ---------------------------------------------------------------- 内部工具

/** 内容字段只认字符串，并去掉首尾空白；数字 / null 一律按空处理。 */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 环境变量统一转成去空白的字符串；兼容测试里直接传数字 0 的情况。 */
function envText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/**
 * 渠道 id 对应的 webhook 环境变量名。
 * 约定：`PUBLISH_<ID大写>_WEBHOOK`，例如 PUBLISH_ZHIHU_WEBHOOK。
 * @param {string} channelId
 * @returns {string}
 */
function webhookEnvKey(channelId) {
  return `PUBLISH_${channelId.toUpperCase()}_WEBHOOK`;
}

/**
 * 按 id 找渠道，找不到就抛中文错误。
 * 允许大小写与首尾空白差异，但绝不返回一个「猜出来的」渠道。
 * @param {string} channelId
 * @returns {{id: string, name: string, requires: string[], note: string}}
 */
function channelById(channelId) {
  const id = text(channelId).toLowerCase();
  const channel = CHANNELS.find((item) => item.id === id);
  if (!channel) {
    const available = CHANNELS.map((item) => item.id).join('、');
    throw new Error(`未知发布渠道：${id || '（空）'}；可用渠道：${available}`);
  }
  return channel;
}

/** 统一内容结构；contentId 可能是数字（CLI 传的是主键），统一转成字符串。 */
function normalizeContent(content) {
  const source = content && typeof content === 'object' ? content : {};
  return {
    title: text(source.title),
    body: text(source.body),
    url: text(source.url),
    contentId: envText(source.contentId),
  };
}

/**
 * FNV-1a 64 位哈希。
 * 用它而不是随机数 / 时间戳，是为了让「同一渠道 + 同一稿件」的回执号永远一致：
 * 重跑不会产生重复记录，测试也能直接比对。输出 16 位小写十六进制。
 * @param {string} value
 * @returns {string}
 */
function hash64(value) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * 生成模拟回执。
 * 回执号把渠道、标题、正文、url、contentId 一起纳入哈希：内容改一个字，回执号就变，
 * 便于后续按回执号判断「这次登记的是不是同一版稿子」。
 * @param {string} channelId
 * @param {{title: string, body: string, url: string, contentId: string}} content
 * @returns {{channel: string, title: string, chars: number, simulatedAt: string, receiptId: string}}
 */
function buildDryRunReceipt(channelId, content) {
  const seed = JSON.stringify([
    channelId,
    content.title,
    content.body,
    content.url,
    content.contentId,
  ]);
  return {
    channel: channelId,
    title: content.title,
    chars: content.body.length,
    simulatedAt: SIMULATED_AT,
    receiptId: `dry-${hash64(seed)}`,
  };
}

/**
 * 调 webhook 并解析 JSON 回执。
 * 所有失败都收成 `{ok:false,state:'api',error}`：HTTP 非 2xx、网络异常、回执不是 JSON
 * 都只是「这一次没发成功」，不应该让调用方进程崩掉。
 * @param {string} webhook
 * @param {{title: string, body: string, url: string, contentId: string}} content
 * @param {Function|undefined} fetchImpl
 * @returns {Promise<{ok: boolean, state: string, receipt?: unknown, error?: string}>}
 */
async function sendToWebhook(webhook, content, fetchImpl) {
  if (!webhook) {
    // 理论上 state=api 时一定非空；这里兜底，防止环境在两次读取之间被改掉。
    return { ok: false, state: 'api', error: '渠道 webhook 未配置' };
  }

  const request =
    typeof fetchImpl === 'function'
      ? fetchImpl
      : typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : null;
  if (!request) {
    return { ok: false, state: 'api', error: '当前运行环境没有可用的 fetch' };
  }

  try {
    const response = await request(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: content.title,
        body: content.body,
        url: content.url,
        contentId: content.contentId,
      }),
    });

    if (!response || !response.ok) {
      const status = response && response.status ? String(response.status) : '未知';
      return { ok: false, state: 'api', error: `渠道返回 HTTP ${status}` };
    }

    let receipt;
    try {
      receipt = await response.json();
    } catch {
      return { ok: false, state: 'api', error: '渠道回执不是合法 JSON' };
    }

    return { ok: true, state: 'api', receipt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || '');
    return { ok: false, state: 'api', error: message || '发布请求失败' };
  }
}

// ---------------------------------------------------------------- 对外接口

/**
 * 列出所有渠道，并解析出当前环境下的 state 与 ready。
 *
 * ready 的含义是「这条渠道能不能走完一次发布流程」：
 * - api：能真发，ready=true；
 * - dry_run：能出模拟回执，同样 ready=true（只是回执会标明模拟）；
 * - not_connected：流程都进不去，ready=false。
 *
 * 返回的是新对象，调用方修改不会污染 CHANNELS。
 *
 * @param {{env?: Record<string, string|undefined>}} [options]
 * @returns {Array<{id: string, name: string, requires: string[], note: string, state: string, ready: boolean}>}
 */
export function listChannels({ env = {} } = {}) {
  const source = env && typeof env === 'object' ? env : {};
  return CHANNELS.map((channel) => {
    const state = resolveChannelState(channel.id, { env: source });
    return {
      id: channel.id,
      name: channel.name,
      requires: [...channel.requires],
      note: channel.note,
      state,
      ready: state !== 'not_connected',
    };
  });
}

/**
 * 解析单个渠道的状态。
 *
 * 优先级（与 OmniRank 的「没有默认值」相反，这里默认模拟，保证零配置可演示）：
 * 1. 配了 `PUBLISH_<ID大写>_WEBHOOK` → api；
 * 2. 否则 `PUBLISH_DRY_RUN !== '0'`（含未设置）→ dry_run；
 * 3. `PUBLISH_DRY_RUN=0` 且没有 webhook → not_connected。
 *
 * @param {string} channelId 渠道 id，如 zhihu / xiaohongshu
 * @param {{env?: Record<string, string|undefined>}} [options]
 * @returns {'not_connected'|'dry_run'|'api'}
 * @throws {Error} 渠道不存在时抛中文错误（编程错误，不吞）
 */
export function resolveChannelState(channelId, { env = {} } = {}) {
  const channel = channelById(channelId);
  const source = env && typeof env === 'object' ? env : {};

  if (envText(source[webhookEnvKey(channel.id)])) return 'api';
  return envText(source.PUBLISH_DRY_RUN) !== '0' ? 'dry_run' : 'not_connected';
}

/**
 * 把一篇稿子发布到指定渠道。
 *
 * 行为：
 * - 渠道不存在 / 标题为空 / 正文不足 200 字 → 返回 `{ok:false, reason}`（渠道不存在则抛错）；
 * - not_connected → `{ok:false, state, reason:'渠道未接入', hint}`；
 * - dry_run，或调用方显式 / 默认 `dryRun: true` → 确定性模拟回执，不发网络；
 * - api 且 `dryRun: false` → POST webhook，成功返回渠道 JSON 回执，失败返回 error 对象。
 *
 * 注意：`dryRun` 默认 true 是安全默认值。哪怕渠道已经配好 webhook，只要没有显式传
 * `dryRun: false`，也只会出模拟回执——真实发布必须是调用方的主动选择。
 *
 * @param {object} [options]
 * @param {string} options.channel 渠道 id
 * @param {{title: string, body: string, url?: string, contentId?: string|number}} [options.content]
 * @param {boolean} [options.dryRun=true] 为 false 且渠道为 api 时才真正发网络
 * @param {Record<string, string|undefined>} [options.env] 环境变量来源，默认空对象
 * @param {Function} [options.fetchImpl] 注入的 fetch（测试用），默认 globalThis.fetch
 * @returns {Promise<object>} 统一回执对象
 */
export async function publishTo({
  channel,
  content,
  dryRun = true,
  env = {},
  fetchImpl,
} = {}) {
  const definition = channelById(channel);
  const payload = normalizeContent(content);

  if (!payload.title) return { ok: false, reason: '标题不能为空' };
  if (payload.body.length < MIN_BODY_CHARS) {
    return { ok: false, reason: '正文过短，不适合发布' };
  }

  const source = env && typeof env === 'object' ? env : {};
  const state = resolveChannelState(definition.id, { env: source });

  if (state === 'not_connected') {
    return {
      ok: false,
      state,
      reason: '渠道未接入',
      hint:
        `设置 ${webhookEnvKey(definition.id)} 接入真实发布，` +
        '或保持 PUBLISH_DRY_RUN 未设为 0 使用模拟发布',
    };
  }

  // 只有显式 dryRun:false 才允许走真实网络；null / undefined / 其它值一律按模拟处理。
  if (state === 'dry_run' || dryRun !== false) {
    return {
      ok: true,
      state: 'dry_run',
      receipt: buildDryRunReceipt(definition.id, payload),
    };
  }

  const webhook = envText(source[webhookEnvKey(definition.id)]);
  return sendToWebhook(webhook, payload, fetchImpl);
}

/**
 * 把渠道列表渲染成三列 Markdown 表格：渠道 / 状态 / 说明。
 *
 * 状态用中文（未接入 / 模拟发布 / 已接入 API），方便直接贴进报告或 CLI 输出。
 * 纯函数：不读环境、不联网，重复调用结果一致；空列表返回「暂无渠道」。
 *
 * @param {Array<{name?: string, id?: string, state?: string, note?: string}>} channels
 * @returns {string}
 */
export function renderChannelsMarkdown(channels) {
  const rows = Array.isArray(channels)
    ? channels.filter((channel) => channel && typeof channel === 'object')
    : [];
  if (rows.length === 0) return '暂无渠道';

  // 单元格里的 | 会把表格拆坏，换行也会破坏行结构，统一在这一层处理。
  const cell = (value) =>
    String(value ?? '')
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, ' ')
      .trim() || '—';

  const lines = ['| 渠道 | 状态 | 说明 |', '| --- | --- | --- |'];
  for (const channel of rows) {
    const name = cell(channel.name || channel.id || '未命名渠道');
    const state = cell(STATE_LABELS[channel.state] || '未知状态');
    const note = cell(channel.note);
    lines.push(`| ${name} | ${state} | ${note} |`);
  }
  return `${lines.join('\n')}\n`;
}
