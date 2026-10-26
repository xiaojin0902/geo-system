/**
 * lib/shoot-package.js
 * 可拍摄包：把短视频脚本导出成「能直接交给拍摄/剪辑」的文件。
 *
 * 产出三样东西，全部零依赖、不联网：
 *   - SRT 字幕（时间轴与口播对齐，可直接导入剪映）
 *   - 分镜 CSV（时间/景别/字幕/素材建议，Excel 可打开）
 *   - 口播全文（方便配音或提词）
 *
 * 与数字人无关：这里不调任何视频生成服务，只把已有脚本整理成文件。
 */

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
