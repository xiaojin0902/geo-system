/**
 * lib/publishers/browser.js
 * 浏览器半自动发布：用你自己登录的 Chrome，把稿子填进平台编辑器，最后一步留给人点。
 *
 * 为什么需要它：
 *   知乎/头条/百家号/小红书/抖音/公众号后台 都没有「第三方可用的官方发文 API」，
 *   或者需要企业资质 + 应用审核。现实做法是复用你已登录的浏览器会话（MultiPost、
 *   unified-publish-mcp 这类工具都是这个思路）。
 *
 * 安全边界（刻意设计）：
 *   1) 只做「导航 + 填标题 + 填正文」，**绝不点击发布按钮**；
 *   2) 不读取、不上传任何登录凭据；所有操作都在你本机 Chrome 里发生；
 *   3) 平台 DOM 会变，选择器是可配置的，失败时给出明确原因而不是假装成功。
 *
 * 依赖：Chrome 以 `--remote-debugging-port=9222` 启动；Node 22 自带 WebSocket，零依赖。
 */

export const PLATFORMS = Object.freeze({
  zhihu: { name: '知乎', url: 'https://zhuanlan.zhihu.com/write', title: ['textarea[placeholder*="标题"]', 'input[placeholder*="标题"]'], body: ['.public-DraftEditor-content', '.DraftEditor-root [contenteditable="true"]', '[contenteditable="true"]'] },
  toutiao: { name: '今日头条', url: 'https://mp.toutiao.com/profile_v4/graphic/publish', title: ['.article-title', 'textarea[placeholder*="标题"]', 'input[placeholder*="标题"]'], body: ['.ProseMirror', '.ql-editor', '[contenteditable="true"]'] },
  baijiahao: { name: '百家号', url: 'https://baijiahao.baidu.com/builder/rc/edit?type=news', title: ['.title-input', 'input[placeholder*="标题"]', 'textarea[placeholder*="标题"]'], body: ['.edui-body-container', '.ProseMirror', '[contenteditable="true"]'] },
  xiaohongshu: { name: '小红书', url: 'https://creator.xiaohongshu.com/publish/publish?source=official', title: ['.title input', 'input[placeholder*="标题"]'], body: ['.ql-editor', '#post-textarea', '[contenteditable="true"]'] },
  douyin: { name: '抖音', url: 'https://creator.douyin.com/creator-micro/content/upload', title: ['input[placeholder*="标题"]', '.semi-input'], body: ['.semi-input-textarea', '[contenteditable="true"]', 'textarea'] },
  wechat_mp: { name: '公众号后台', url: 'https://mp.weixin.qq.com/', title: ['#title', 'input[placeholder*="标题"]'], body: ['.ProseMirror', '#ueditor_0', '[contenteditable="true"]'] },
});

export function platformInfo(id) {
  const key = String(id ?? '').toLowerCase();
  const platform = PLATFORMS[key];
  if (!platform) return null;
  return { id: key, ...platform };
}

/** 打印给用户的启动命令（Chrome 必须以调试端口启动才能接管） */
export function chromeLaunchHint(port = 9222) {
  return `open -na "Google Chrome" --args --remote-debugging-port=${port}`;
}

/** 最小的 CDP 客户端：一个 WebSocket 连接 + 顺序请求 */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接 Chrome 调试端口超时')), 5000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener('error', (event) => {
      clearTimeout(timer);
      reject(new Error(`连接调试端口失败：${event?.message ?? '未知错误'}`));
    }, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message ?? 'CDP 调用失败'));
      else resolve(msg.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP 调用超时：${method}`));
        }
      }, 15000);
    });
  return { ws, send, close: () => ws.close() };
}

async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`调试端口返回 HTTP ${res.status}`);
  return res.json();
}

async function newTarget(port, url) {
  // 新版 Chrome 只接受 PUT；老版接受 POST，两个都试
  for (const method of ['PUT', 'POST']) {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method });
    if (res.ok) return res.json();
  }
  throw new Error('无法新建标签页（调试端口可用但 /json/new 被拒绝）');
}

/** 在页面里执行的填充脚本（纯字符串，避免被平台 CSP 拦截） */
function fillScript({ title, body, titleSelectors, bodySelectors }) {
  return `(() => {
    const trySelectors = (selectors) => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      return null;
    };
    const setNative = (el, value) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
      if (proto) {
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, value);
      } else {
        el.focus();
        document.execCommand && document.execCommand('insertText', false, value);
        if (el.textContent !== value) el.textContent = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const titleEl = trySelectors(${JSON.stringify(titleSelectors)});
    const bodyEl = trySelectors(${JSON.stringify(bodySelectors)});
    if (titleEl) setNative(titleEl, ${JSON.stringify(String(title).slice(0, 100))});
    if (bodyEl) setNative(bodyEl, ${JSON.stringify(String(body))});
    return { title: !!titleEl, body: !!bodyEl, url: location.href };
  })()`;
}

/**
 * 打开平台编辑器并填入稿件（不提交）。
 * @returns {Promise<{ok:boolean, platform?:string, url?:string, filled?:{title:boolean, body:boolean}, reason?:string, hint?:string}>}
 */
export async function openForPublish({ platform, title = '', body = '', port = 9222 } = {}) {
  const info = platformInfo(platform);
  if (!info) return { ok: false, reason: `未知平台「${platform}」，可用：${Object.keys(PLATFORMS).join('、')}` };
  if (!String(title).trim()) return { ok: false, reason: '标题不能为空' };

  try {
    await listTargets(port);
  } catch (error) {
    return { ok: false, reason: `Chrome 调试端口不可用（${error?.message ?? error}）`, hint: chromeLaunchHint(port) };
  }

  try {
    const target = await newTarget(port, info.url);
    if (!target?.webSocketDebuggerUrl) return { ok: false, reason: '新建标签页没有返回调试地址', hint: chromeLaunchHint(port) };
    const session = await connect(target.webSocketDebuggerUrl);
    try {
      await session.send('Page.enable');
      // 等页面骨架出来（平台都是 SPA，固定等 2.5s 比盲目重试稳）
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const result = await session.send('Runtime.evaluate', {
        expression: fillScript({ title, body, titleSelectors: info.title, bodySelectors: info.body }),
        returnByValue: true,
        awaitPromise: true,
      });
      const filled = result?.result?.value ?? { title: false, body: false };
      return {
        ok: filled.title || filled.body,
        platform: info.id,
        url: filled.url ?? info.url,
        filled: { title: Boolean(filled.title), body: Boolean(filled.body) },
        reason: filled.title && filled.body ? '' : '部分字段没找到（平台改版了？），可在页面手动补',
        hint: '稿件已填入编辑器，请在浏览器里检查后自己点「发布」。',
      };
    } finally {
      session.close();
    }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}
