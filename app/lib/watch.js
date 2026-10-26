/**
 * lib/watch.js
 * 7×24 巡检：把「每天一次」升级成「按配置频率持续巡检」。
 *
 * 现实约束（诚实说明）：
 *   系统本身是 Node 进程，不会自己常驻；常驻靠 cron / launchd / systemd 触发。
 *   所以这里做三件事：算「该不该跑」、生成调度配置、记录每次运行历史。
 *   绝不假装自己是守护进程。
 *
 * 纯函数为主，零依赖。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

export const DEFAULT_WATCH = Object.freeze({
  intervalMinutes: 60,
  engines: 'live',
  limit: 12,
  minIntervalMinutes: 15,
  maxIntervalMinutes: 1440,
});

/** 读取并夹取巡检配置（来自品牌 settings） */
export function watchConfig(settings = {}) {
  const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  return {
    enabled: String(settings.watch_enabled ?? '') === '1',
    intervalMinutes: clamp(settings.watch_interval_minutes, DEFAULT_WATCH.minIntervalMinutes, DEFAULT_WATCH.maxIntervalMinutes, DEFAULT_WATCH.intervalMinutes),
    engines: String(settings.watch_engines ?? '').trim() || DEFAULT_WATCH.engines,
    limit: clamp(settings.watch_limit, 1, 100, DEFAULT_WATCH.limit),
    lastRunAt: settings.watch_last_run_at ?? null,
  };
}

/** 下次该跑的时间（毫秒时间戳）；未启用返回 null */
export function nextRunAt(config = {}, { now = Date.now() } = {}) {
  if (!config.enabled) return null;
  const interval = Number(config.intervalMinutes) * 60000;
  const last = config.lastRunAt ? new Date(config.lastRunAt).getTime() : null;
  return last ? last + interval : now;
}

/** 现在是否到点 */
export function isDue(config = {}, { now = Date.now() } = {}) {
  const next = nextRunAt(config, { now });
  return next !== null && now >= next;
}

/** 生成 cron 行（分钟级；UTC 与本地都写清） */
export function cronLines({ brand, intervalMinutes = 60, appRoot, nodeBin, cliPath, logFile }) {
  const every = Math.min(1440, Math.max(15, Math.round(intervalMinutes)));
  // cron 是 5 段：分 时 日 月 周
  const cron = every < 60
    ? `*/${every} * * * *`
    : every === 60
      ? '0 * * * *'
      : every >= 1440
        ? '0 7 * * *'
        : `0 */${Math.round(every / 60)} * * *`;
  const command = `cd ${appRoot} && ${nodeBin} ${cliPath} watch --brand ${brand} --run >> ${logFile} 2>&1`;
  return [
    '# 由 watch 命令生成：按间隔巡检（复制到 crontab -e）',
    `${cron} ${command}`,
    '# 说明：cron 用系统时区；也可用 launchd/systemd 替代。',
  ];
}

/**
 * 真正执行一次巡检：跑一轮诊断并记录历史。
 * @returns {Promise<{ok:boolean, runId?:number, exitCode:number, detail:string}>}
 */
export function runWatchOnce({ brand, config = {}, appRoot, nodeBin = process.execPath, cliPath, onStart, onFinish, spawnImpl = spawn } = {}) {
  const watchRunId = onStart?.() ?? null;
  return new Promise((resolve) => {
    const child = spawnImpl(
      nodeBin,
      [cliPath, 'diagnose', '--brand', brand, '--engines', config.engines || 'live', '--limit', String(config.limit || 12)],
      { cwd: appRoot, env: { ...process.env } },
    );
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('error', (error) => {
      onFinish?.(watchRunId, { status: 'failed', detail: String(error?.message ?? error) });
      resolve({ ok: false, watchRunId, exitCode: -1, detail: String(error?.message ?? error) });
    });
    child.on('close', (code) => {
      const match = output.match(/run #(\d+)/iu);
      const detail = match ? `run #${match[1]}` : output.trim().split('\n').slice(-2).join(' ').slice(0, 200);
      onFinish?.(watchRunId, { status: code === 0 ? 'done' : 'failed', detail });
      resolve({ ok: code === 0, watchRunId, exitCode: code ?? -1, detail, runId: match ? Number(match[1]) : null });
    });
  });
}

/** 渲染状态（CLI/页面共用） */
export function renderWatchStatus({ config = {}, history = [], generatedAt = '' } = {}) {
  const lines = [];
  lines.push('# 巡检状态', '');
  lines.push(`- 启用：${config.enabled ? '是' : '否'}`);
  lines.push(`- 间隔：每 ${config.intervalMinutes} 分钟`);
  lines.push(`- 引擎：${config.engines} · 每次 ${config.limit} 题`);
  lines.push(`- 上次运行：${config.lastRunAt ? String(config.lastRunAt).slice(0, 19).replace('T', ' ') : '从未'}`);
  const next = nextRunAt(config);
  lines.push(`- 下次预计：${next ? new Date(next).toLocaleString('zh-CN', { hour12: false }) : '未启用'}`);
  if (generatedAt) lines.push(`- 生成时间：${generatedAt}`);
  lines.push('', '## 最近运行', '');
  if (!history.length) lines.push('- 无记录');
  else {
    lines.push('| # | 开始 | 状态 | 详情 |', '| --- | --- | --- | --- |');
    for (const item of history.slice(0, 10)) {
      lines.push(`| ${item.id} | ${String(item.startedAt).slice(0, 19).replace('T', ' ')} | ${item.status} | ${item.detail ?? ''} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** 默认路径（供 CLI 使用） */
export function watchPaths(appRoot) {
  return {
    appRoot,
    cliPath: path.join(appRoot, 'bin', 'geo.js'),
    logFile: path.join(appRoot, 'data', 'watch.log'),
  };
}
