/**
 * lib/doctor.js
 * 环境自检：把「离能跑真实数据还差什么」变成可执行清单。
 *
 * 为什么需要它：这个项目最常见的时间浪费不是写代码，而是
 * 「以为 Key 填好了 → 跑 live → 报错 → 不知道是 Key 错、模型不支持检索、还是网络问题」。
 * doctor 把每一层拆开单独确认，并且默认**不发网络请求**（只有 probe 才发）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, DATA_DIR, brandPath, dbPath } from './config.js';
import { engineHasKey, engineReadiness, getEngine, listEngines } from './engines/index.js';

const REQUIRED_NODE = [22, 5];
const KEY_HINTS = {
  DEEPSEEK_API_KEY: 'https://platform.deepseek.com/api_keys 申请，DeepSeek 检索走官方 API',
  DASHSCOPE_API_KEY: 'https://bailian.console.aliyun.com 申请，通义千问联网检索走百炼',
};

function hasKey(env, name) {
  const value = env?.[name] ?? process.env?.[name] ?? '';
  return typeof value === 'string' && value.trim().length > 0;
}

/** 节点是否支持 node:sqlite（本项目零依赖的前提） */
function sqliteAvailable() {
  try {
    // 只用 require 探测能力，不创建数据库
    const mod = process.getBuiltinModule
      ? process.getBuiltinModule('node:sqlite')
      : null;
    return Boolean(mod && typeof mod.DatabaseSync === 'function');
  } catch {
    return false;
  }
}

function nodeVersionOk() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > REQUIRED_NODE[0] || (major === REQUIRED_NODE[0] && minor >= REQUIRED_NODE[1]);
}

/**
 * 跑一次自检。
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {boolean} [options.probe] 是否真的调一次模型 API 验证凭证（会消耗极少量额度）
 * @param {Function} [options.fetchImpl]
 * @param {string} [options.brandSlug]
 * @param {number} [options.timeoutMs]
 */
export async function runDoctor({
  env = {},
  probe = false,
  fetchImpl,
  brandSlug = 'hengye',
  timeoutMs = 20_000,
} = {}) {
  const checks = [];
  const push = (check) => checks.push({ level: 'warn', ok: false, action: '', ...check });

  // 1) Node 运行时
  const version = process.versions.node;
  push({
    id: 'node',
    ok: nodeVersionOk(),
    level: 'blocker',
    title: `Node 运行时 v${version}`,
    detail: nodeVersionOk() ? '满足 >= 22.5 要求' : '版本过低，node:sqlite 与 node --test 可能不可用',
    action: nodeVersionOk() ? '' : '升级到 Node 22.5+（推荐 22 LTS 或 24）',
  });

  push({
    id: 'sqlite',
    ok: sqliteAvailable(),
    level: 'blocker',
    title: 'node:sqlite 内置模块',
    detail: sqliteAvailable() ? '可用（本项目零依赖存储的前提）' : '不可用，数据库无法打开',
    action: sqliteAvailable() ? '' : '确认 Node >= 22.5，或启动时加 --experimental-sqlite',
  });

  // 2) 数据目录与数据库
  const dbFile = dbPath();
  const dbExists = fs.existsSync(dbFile);
  const dirWritable = (() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.accessSync(DATA_DIR, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  })();
  push({
    id: 'data-dir',
    ok: dirWritable,
    level: 'blocker',
    title: `数据目录 ${DATA_DIR}`,
    detail: dirWritable ? '可写' : '不可写，数据库与报告都无法落盘',
    action: dirWritable ? '' : `检查目录权限：${DATA_DIR}`,
  });
  push({
    id: 'db',
    ok: dbExists,
    level: 'warn',
    title: 'geo.db',
    detail: dbExists ? `已存在（${(fs.statSync(dbFile).size / 1024).toFixed(1)} KB）` : '尚未创建',
    action: dbExists ? '' : '在 app 目录跑一次：node bin/geo.js init --brand hengye',
  });

  // 3) 品牌配置
  let brandName = '恒野';
  let brandOk = false;
  try {
    const file = brandPath(brandSlug);
    brandOk = fs.existsSync(file);
    if (brandOk) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      brandName = parsed.name ?? brandName;
    }
  } catch {
    brandOk = false;
  }
  push({
    id: 'brand',
    ok: brandOk,
    level: 'warn',
    title: `品牌配置 brands/${brandSlug}.json`,
    detail: brandOk ? `已加载：${brandName}` : '文件不存在，init 会用它写入品牌与题目',
    action: brandOk ? '' : `确认 brands/${brandSlug}.json 存在`,
  });

  // 4) 密钥
  const envFile = path.join(APP_ROOT, '.env');
  const envExists = fs.existsSync(envFile);
  push({
    id: 'env-file',
    ok: envExists,
    level: 'warn',
    title: `.env 文件 ${envFile}`,
    detail: envExists ? '已存在' : '不存在（proces.env 里注入的密钥同样有效）',
    action: envExists ? '' : '照着 .env.example 复制一份，填入密钥',
  });

  const keyNames = ['DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY'];
  const keys = keyNames.map((name) => ({
    name,
    present: hasKey(env, name),
    hint: KEY_HINTS[name] ?? '',
  }));
  const configuredKeys = keys.filter((k) => k.present);
  push({
    id: 'keys',
    ok: configuredKeys.length > 0,
    level: 'blocker',
    title: '线上引擎密钥',
    detail:
      configuredKeys.length > 0
        ? `已配置：${configuredKeys.map((k) => k.name).join('、')}`
        : '一个都没有：现在只能跑 demo 演示数据，报告不能作为对客户的结论',
    action:
      configuredKeys.length > 0
        ? ''
        : '在 app/.env 写入 DEEPSEEK_API_KEY=sk-xxx（或 DASHSCOPE_API_KEY=sk-xxx）',
  });

  // 5) 引擎可用性
  const engines = listEngines().map((meta) => {
    const readiness = meta.requiresKey ? engineReadiness(meta.id, env) : { ready: true, reason: '' };
    return {
      id: meta.id,
      label: meta.label,
      requiresKey: meta.requiresKey,
      configured: readiness.ready,
      reason: readiness.reason,
    };
  });
  push({
    id: 'engines',
    ok: engines.filter((e) => e.requiresKey && e.configured).length > 0,
    level: 'warn',
    title: '可用线上引擎',
    detail: engines
      .filter((e) => e.requiresKey)
      .map((e) => `${e.label}${e.configured ? ' ✅' : ` ✖（${e.reason}）`}`)
      .join(' · '),
    action: '引擎清单只在 lib/engines/index.js 维护，新增引擎请改这一处',
  });

  // 6) 可选：真调一次验证凭证（只验证鉴权，不做检索）
  let probeNote = '';
  const probes = [];
  if (probe) {
    const runnable = engines.filter((e) => e.requiresKey && e.configured);
    if (!runnable.length) {
      probeNote = '没有已配置的线上引擎，跳过探测。';
    } else {
      for (const meta of runnable) {
        const startedAt = Date.now();
        try {
          const engine = getEngine(meta.id, { env, fetchImpl });
          const result = await engine.ask('请只回复两个字：收到', { timeoutMs });
          probes.push({
            engine: meta.id,
            ok: result.status === 'ok' || result.status === 'refused',
            status: result.status,
            latencyMs: result.latencyMs ?? Date.now() - startedAt,
            mode: result.mode ?? null,
            error: result.error ?? null,
          });
        } catch (error) {
          probes.push({
            engine: meta.id,
            ok: false,
            status: 'exception',
            latencyMs: Date.now() - startedAt,
            error: error?.message ?? String(error),
          });
        }
      }
      probeNote = probes
        .map(
          (p) =>
            `${p.engine}：${p.ok ? '✅ 通' : '❌ 不通'} · ${p.status} · ${p.latencyMs}ms` +
            (p.mode ? ` · ${p.mode}` : '') +
            (p.error ? ` · ${p.error.slice(0, 120)}` : ''),
        )
        .join('\n');
    }
  }

  const blockers = checks.filter((c) => !c.ok && c.level === 'blocker');
  return {
    ok: blockers.length === 0,
    brandName,
    checks,
    keys,
    engines,
    probes,
    probeNote,
  };
}
