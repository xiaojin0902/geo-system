/**
 * lib/digital-human.js
 * 数字人视频「接入口」：把口播稿交给外部数字人服务商，拿回视频地址。
 *
 * 定位（重要）：
 *   本模块不自己做视频渲染（那需要 GPU 与付费模型）。它做三件事：
 *     1) 把脚本整理成「一条口播 + 分段字幕 + 参数」的渲染请求；
 *     2) 按服务商适配成各自的 HTTP 协议（HeyGen / 硅基智能 / 火山数字人 / 自定义）；
 *     3) 拿回 job id → 轮询 → 视频 URL。
 *
 * 没有配置服务商时不要假装能出片：`readiness()` 返回未就绪，`exportShootPackage()`
 * 仍然可用——它导出 SRT + 分镜 CSV，可以直接丢给剪映/人工拍摄。
 */

export const DH_PROVIDERS = Object.freeze([
  { id: 'heygen', label: 'HeyGen', keyEnv: 'HEYGEN_API_KEY', endpoint: 'https://api.heygen.com/v2/video/generate', avatarEnv: 'HEYGEN_AVATAR_ID', voiceEnv: 'HEYGEN_VOICE_ID' },
  { id: 'silicon', label: '硅基智能', keyEnv: 'SILICON_API_KEY', endpoint: 'https://api.siliconintelligence.com/v1/video/generate', avatarEnv: 'SILICON_AVATAR_ID', voiceEnv: 'SILICON_VOICE_ID' },
  { id: 'volcengine', label: '火山数字人', keyEnv: 'VOLC_DH_ACCESS_KEY', endpoint: 'https://open.volcengineapi.com/api/v1/digital_human/video', avatarEnv: 'VOLC_DH_AVATAR_ID', voiceEnv: 'VOLC_DH_VOICE_ID' },
  { id: 'custom', label: '自建/中转', keyEnv: 'DH_API_KEY', endpointEnv: 'DH_ENDPOINT', avatarEnv: 'DH_AVATAR_ID', voiceEnv: 'DH_VOICE_ID' },
]);

export function readiness(env = {}) {
  const providerId = String(env.DH_PROVIDER ?? '').trim().toLowerCase();
  if (!providerId) return { ready: false, reason: '未配置 DH_PROVIDER（heygen / silicon / volcengine / custom）' };
  const provider = DH_PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return { ready: false, reason: `未知数字人服务商「${providerId}」` };
  const endpoint = provider.endpointEnv ? String(env[provider.endpointEnv] ?? '').trim() : provider.endpoint;
  if (!endpoint) return { ready: false, reason: `未配置 ${provider.endpointEnv}` };
  if (!String(env[provider.keyEnv] ?? '').trim()) return { ready: false, reason: `未配置 ${provider.keyEnv}` };
  if (!String(env[provider.avatarEnv] ?? '').trim()) return { ready: false, reason: `未配置 ${provider.avatarEnv}（数字人形象 ID）` };
  return { ready: true, reason: '', provider: provider.id, endpoint };
}

/** 组装渲染请求（纯函数，便于测试与不同服务商适配） */
export function buildRenderRequest({ script = {}, env = {}, brand = {} } = {}) {
  const readinessInfo = readiness(env);
  const provider = DH_PROVIDERS.find((p) => p.id === readinessInfo.provider) ?? null;
  const narration = (script.narration ?? []).map((item) => String(item.text ?? '')).filter(Boolean);
  const text = narration.join('。');
  return {
    provider: provider?.id ?? null,
    endpoint: readinessInfo.endpoint ?? null,
    payload: {
      // 各家字段名不同，统一在这里映射；适配层出错只影响该家
      text,
      avatar_id: provider ? String(env[provider.avatarEnv] ?? '') : '',
      voice_id: provider ? String(env[provider.voiceEnv] ?? '') : '',
      aspect_ratio: '9:16',
      background: 'transparent',
      title: String(script.title ?? brand.name ?? '').slice(0, 60),
      subtitles: (script.shots ?? []).map((shot) => ({ t: shot.t, text: shot.caption ?? '' })),
      duration_sec: Number(script.durationSec ?? 60),
    },
  };
}

/** 提交渲染任务 */
export async function submitRender({ script = {}, env = {}, brand = {}, fetchImpl } = {}) {
  const info = readiness(env);
  if (!info.ready) return { ok: false, reason: info.reason };
  const request = buildRenderRequest({ script, env, brand });
  const provider = DH_PROVIDERS.find((p) => p.id === request.provider);
  const f = fetchImpl ?? globalThis.fetch;
  try {
    const res = await f(request.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${String(env[provider.keyEnv] ?? '').trim()}` },
      body: JSON.stringify(request.payload),
    });
    const data = await res.json().catch(() => ({}));
    const jobId = data.job_id ?? data.data?.job_id ?? data.video_id ?? data.data?.video_id ?? null;
    if (!res.ok || !jobId) {
      return { ok: false, reason: `提交失败：${data.message ?? data.error ?? `HTTP ${res.status}`}` };
    }
    return { ok: true, jobId, provider: provider.id };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/** 轮询任务（各家用同一套 GET 约定；取不到就返回 processing） */
export async function pollRender({ jobId, env = {}, fetchImpl } = {}) {
  const info = readiness(env);
  if (!info.ready) return { ok: false, reason: info.reason };
  const f = fetchImpl ?? globalThis.fetch;
  const provider = DH_PROVIDERS.find((p) => p.id === info.provider);
  try {
    const res = await f(`${info.endpoint.replace(/\/+$/u, '')}/${encodeURIComponent(jobId)}`, {
      headers: { authorization: `Bearer ${String(env[provider.keyEnv] ?? '').trim()}` },
    });
    const data = await res.json().catch(() => ({}));
    const status = String(data.status ?? data.data?.status ?? '').toLowerCase();
    const url = data.video_url ?? data.url ?? data.data?.video_url ?? data.data?.url ?? null;
    if (url) return { ok: true, status: 'completed', url };
    return { ok: true, status: status || 'processing' };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

function secToSrt(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(Math.floor(s % 60)).padStart(2, '0');
  const ms = String(Math.round((s - Math.floor(s)) * 1000)).padStart(3, '0');
  return `${hh}:${mm}:${ss},${ms}`;
}

/** 解析 "0-3s" 这类时间轴 */
function parseRange(range = '') {
  const match = String(range).match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/u);
  if (!match) return [0, 0];
  return [Number(match[1]), Number(match[2])];
}

/**
 * 导出「可拍摄包」：SRT 字幕 + 分镜 CSV + 口播全文。
 * 给剪映/人工拍摄用，不依赖任何外部服务（零配置也能出东西）。
 */
export function exportShootPackage(script = {}) {
  const narration = script.narration ?? [];
  const srt = narration
    .map((item, index) => {
      const [start, end] = parseRange(item.t);
      return `${index + 1}\n${secToSrt(start)} --> ${secToSrt(end)}\n${String(item.text ?? '')}\n`;
    })
    .join('\n');
  const csvLines = ['时间,景别,字幕,素材建议'];
  for (const shot of script.shots ?? []) {
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    csvLines.push([shot.t, shot.shot, shot.caption, shot.broll].map(cell).join(','));
  }
  return {
    srt,
    csv: csvLines.join('\n'),
    narrationText: narration.map((item) => item.text).join('\n'),
    title: script.title ?? '',
    hashtags: (script.hashtags ?? []).join(' '),
  };
}
