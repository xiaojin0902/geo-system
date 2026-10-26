/**
 * lib/publishers/wechat.js
 * 微信公众号官方 API 发布（唯一有完整官方发布能力的中文内容平台）。
 *
 * 三步：
 *   1) 取 access_token（client_credential，2 小时有效，模块内缓存）；
 *   2) 新建草稿 draft/add（Markdown → 微信可接受的 HTML）；
 *   3) 可选群发 freepublish/submit（必须显式 WECHAT_AUTO_PUBLISH=1）。
 *
 * 前置条件（缺一不可，缺了就返回明确原因，不假装成功）：
 *   - 认证的服务号/订阅号（个人号没有发布接口权限）；
 *   - 公众号后台「基本配置」拿到 AppID / AppSecret；
 *   - 在「IP 白名单」里加入本机出口 IP（否则 errcode 40164）；
 *   - 素材库有可用的封面图（thumb_media_id）——没有也能建草稿，但群发会失败。
 */

const TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/token';
const DRAFT_URL = 'https://api.weixin.qq.com/cgi-bin/draft/add';
const PUBLISH_URL = 'https://api.weixin.qq.com/cgi-bin/freepublish/submit';

let tokenCache = { key: '', token: '', expiresAt: 0 };

/** 是否配置齐全 */
export function wechatReadiness(env = {}) {
  const appid = String(env.WECHAT_APPID ?? '').trim();
  const secret = String(env.WECHAT_SECRET ?? '').trim();
  if (!appid) return { ready: false, reason: '未配置 WECHAT_APPID' };
  if (!secret) return { ready: false, reason: '未配置 WECHAT_SECRET' };
  return { ready: true, reason: '' };
}

/** Markdown → 微信草稿可接受的富文本（只覆盖我们文章生成器会产出的语法） */
export function markdownToWechatHtml(markdown = '') {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let listOpen = false;
  const closeList = () => {
    if (listOpen) {
      out.push('</ul>');
      listOpen = false;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      closeList();
      out.push('');
      continue;
    }
    const inline = (text) =>
      text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>');
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      if (!listOpen) {
        out.push('<ul>');
        listOpen = true;
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    const ordered = line.match(/^\d+[.、]\s+(.*)$/);
    if (ordered) {
      closeList();
      out.push(`<p>${inline(ordered[1])}</p>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function digestOf(body = '') {
  return String(body).replace(/[#*`>\[\]()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
}

async function getAccessToken({ env, fetchImpl }) {
  const appid = String(env.WECHAT_APPID ?? '').trim();
  const secret = String(env.WECHAT_SECRET ?? '').trim();
  const key = `${appid}:${secret}`;
  if (tokenCache.key === key && tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  const url = `${TOKEN_URL}?grant_type=client_credential&appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}`;
  const res = await fetchImpl(url);
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`获取 access_token 失败：${data.errmsg ?? '未知错误'}（errcode ${data.errcode ?? '?'}）`);
  }
  tokenCache = { key, token: data.access_token, expiresAt: Date.now() + Math.max(60, (data.expires_in ?? 7200) - 120) * 1000 };
  return data.access_token;
}

/**
 * 发布（先建草稿；WECHAT_AUTO_PUBLISH=1 时再群发）。
 * @returns {Promise<{ok:boolean, mode:'draft'|'publish', mediaId?:string, publishId?:string, url?:string, reason?:string}>}
 */
export async function publishToWechat({ title = '', body = '', author = '', env = {}, fetchImpl, autoPublish } = {}) {
  const readiness = wechatReadiness(env);
  if (!readiness.ready) return { ok: false, reason: readiness.reason };
  if (!String(title).trim()) return { ok: false, reason: '标题不能为空' };
  if (String(body).trim().length < 200) return { ok: false, reason: '正文过短，公众号草稿至少 200 字' };

  const f = fetchImpl ?? globalThis.fetch;
  try {
    const token = await getAccessToken({ env, fetchImpl: f });
    const html = markdownToWechatHtml(body);
    const payload = {
      articles: [
        {
          title: String(title).slice(0, 64),
          author,
          digest: digestOf(body),
          content: html,
          content_source_url: String(env.WECHAT_SOURCE_URL ?? ''),
        },
      ],
    };
    const draftRes = await f(`${DRAFT_URL}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const draft = await draftRes.json();
    if (!draft.media_id) {
      return { ok: false, reason: `建草稿失败：${draft.errmsg ?? '未知错误'}（errcode ${draft.errcode ?? '?'}）` };
    }
    const auto = autoPublish ?? String(env.WECHAT_AUTO_PUBLISH ?? '') === '1';
    if (!auto) {
      return { ok: true, mode: 'draft', mediaId: draft.media_id };
    }
    const pubRes = await f(`${PUBLISH_URL}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ media_id: draft.media_id }),
    });
    const publish = await pubRes.json();
    if (publish.errcode && publish.errcode !== 0) {
      return {
        ok: false,
        mode: 'draft',
        mediaId: draft.media_id,
        reason: `草稿已建但群发失败：${publish.errmsg ?? ''}（errcode ${publish.errcode}）`,
      };
    }
    return { ok: true, mode: 'publish', mediaId: draft.media_id, publishId: publish.publish_id };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/** 测试用：清空 token 缓存 */
export function __resetWechatTokenCache() {
  tokenCache = { key: '', token: '', expiresAt: 0 };
}
