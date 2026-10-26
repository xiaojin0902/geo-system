// 测试：7×24 巡检（配置夹取、调度判断、cron 生成、状态渲染）
import test from 'node:test';
import assert from 'node:assert/strict';
import { watchConfig, nextRunAt, isDue, cronLines, renderWatchStatus } from '../lib/watch.js';

test('配置夹取：间隔最小 15、最大 1440，非法回落默认', () => {
  assert.equal(watchConfig({ watch_interval_minutes: '2' }).intervalMinutes, 15);
  assert.equal(watchConfig({ watch_interval_minutes: '9999' }).intervalMinutes, 1440);
  assert.equal(watchConfig({}).intervalMinutes, 60);
  assert.equal(watchConfig({ watch_enabled: '1' }).enabled, true);
  assert.equal(watchConfig({ watch_enabled: '0' }).enabled, false);
});

test('未启用时没有下次运行时间、永不 due', () => {
  const config = watchConfig({ watch_enabled: '0' });
  assert.equal(nextRunAt(config), null);
  assert.equal(isDue(config), false);
});

test('启用但从未运行 → 立即 due', () => {
  const config = watchConfig({ watch_enabled: '1' });
  assert.equal(isDue(config, { now: Date.now() }), true);
});

test('到点判断：上次运行 + 间隔之后才 due', () => {
  const now = Date.now();
  const lastRunAt = new Date(now - 30 * 60000).toISOString();
  const config = watchConfig({ watch_enabled: '1', watch_interval_minutes: '60', watch_last_run_at: lastRunAt });
  assert.equal(isDue(config, { now }), false);
  assert.equal(isDue(config, { now: now + 31 * 60000 }), true);
});

test('cron 是 5 段，且按间隔正确生成', () => {
  const line = (minutes) => cronLines({ brand: 'x', intervalMinutes: minutes, appRoot: '/a', nodeBin: 'n', cliPath: 'c', logFile: 'l' })[1];
  assert.match(line(30), /^\*\/30 \* \* \* \* /);
  assert.match(line(60), /^0 \* \* \* \* /);
  assert.match(line(120), /^0 \*\/2 \* \* \* /);
  assert.match(line(1440), /^0 7 \* \* \* /);
});

test('cron 行包含绝对路径与日志重定向', () => {
  const line = cronLines({ brand: 'hengye', intervalMinutes: 60, appRoot: '/app', nodeBin: '/n', cliPath: '/c', logFile: '/log' })[1];
  assert.match(line, /cd \/app/);
  assert.match(line, /watch --brand hengye --run/);
  assert.match(line, />> \/log/);
});

test('状态渲染：含启用/间隔/下次预计与历史表', () => {
  const md = renderWatchStatus({
    config: watchConfig({ watch_enabled: '1', watch_interval_minutes: '60' }),
    history: [{ id: 1, startedAt: '2026-10-27T00:00:00Z', status: 'done', detail: 'run #30' }],
  });
  assert.match(md, /巡检状态/);
  assert.match(md, /每 60 分钟/);
  assert.match(md, /run #30/);
});
