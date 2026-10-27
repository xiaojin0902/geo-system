#!/usr/bin/env node
/**
 * geo — 代运营交付系统 CLI（v2）
 *
 * 命令（只有 7 个）：
 *   init     新建客户（自动开本月周期）
 *   diagnose 跑一轮诊断（采集→判定→评分→生成待办）
 *   content  生成一篇可交付内容
 *   deliver  生成报告 + 分享链接
 *   list     列出客户与周期
 *   report   重出某周期报告
 *   serve    启动控制台
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/db.js';
import { runDiagnose, ensurePlan, collectCycle, generateContent, generateDeliverables } from '../lib/pipeline.js';
import { createShareToken } from '../lib/deliver.js';
import { hashPassword } from '../lib/auth.js';
import { buildActions } from '../lib/analyze.js';
import { renderReportHtml } from '../lib/deliver.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(APP_ROOT, 'data');

function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(APP_ROOT, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/u);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/gu, '');
    }
  } catch { /* 无 .env 也能跑 */ }
}

function args() {
  const out = {};
  const list = process.argv.slice(3);
  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = list[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    }
  }
  return out;
}

function fmt(analysis, score) {
  return {
    total: score.total,
    level: score.level,
    mentionRate: `${((analysis.sample?.mentionRate ?? 0) * 100).toFixed(1)}%`,
    samples: `${analysis.sample?.ok ?? 0}/${analysis.sample?.total ?? 0}`,
    citations: analysis.citations?.total ?? 0,
    domains: (analysis.citations?.domains ?? []).map((d) => d.domain).slice(0, 5).join('、') || '无',
  };
}

async function main() {
  loadEnv();
  const command = process.argv[2] ?? 'help';
  const flags = args();
  const store = new Store(path.join(DATA_DIR, 'geo.db'));

  if (command === 'serve') {
    store.close();
    process.argv.push('--serve');
    await import('../server.js');
    return;
  }

  if (command === 'init') {
    const slug = flags.slug;
    const name = flags.name;
    if (!slug || !name) throw new Error('用法：node bin/geo.js init --slug demo --name 演示家政 --industry 家政 --city 芜湖');
    const client = store.upsertClient({
      slug,
      name,
      industry: flags.industry ?? '',
      city: flags.city ?? '',
      url: flags.url ?? '',
      contact: flags.contact ?? '',
      competitors: String(flags.competitors ?? '').split(',').map((x) => x.trim()).filter(Boolean),
      facts: {
        legalName: flags.legalName ?? name,
        priceRange: flags.priceRange ?? '',
        rejectedNames: String(flags.rejected ?? '').split(',').map((x) => x.trim()).filter(Boolean),
      },
    });
    const cycle = store.currentCycle(client.id);
    console.log(`✔ 客户已创建：${client.name}（${client.slug}）`);
    console.log(`  周期：${cycle.period}（#${cycle.id}）`);
    console.log(`  下一步：node bin/geo.js diagnose --slug ${client.slug} --engine mock --limit 5`);
    store.close();
    return;
  }

  if (command === 'list') {
    const clients = store.listClients();
    if (!clients.length) console.log('还没有客户。先：node bin/geo.js init --slug demo --name 演示家政 --industry 家政');
    for (const client of clients) {
      const cycles = store.listCycles(client.id);
      const cycle = cycles[0];
      const collected = cycle ? collectCycle({ store, cycleId: cycle.id, client }) : null;
      const tasks = cycle ? store.listTasks(cycle.id) : [];
      console.log(`${client.slug.padEnd(16)} ${client.name.padEnd(12)} ${cycle?.period ?? '—'}  分数 ${collected?.score?.total ?? '—'}  待办 ${tasks.filter((t) => t.status !== 'done').length}`);
    }
    store.close();
    return;
  }

  const client = flags.slug ? store.getClient(flags.slug) : store.listClients()[0];
  if (!client && command !== 'help') {
    console.log('没有客户。先：node bin/geo.js init --slug demo --name 演示家政 --industry 家政 --city 芜湖');
    store.close();
    return;
  }
  const cycle = client ? store.currentCycle(client.id) : null;

  if (command === 'diagnose') {
    const engine = flags.engine ?? 'mock';
    const limit = Number(flags.limit ?? 5);
    const result = await runDiagnose({ store, cycleId: cycle.id, client, engine, limit, env: process.env });
    store.saveScore({ cycleId: cycle.id, total: result.score.total, level: result.score.level, breakdown: result.score.breakdown });
    const tasks = ensurePlan({ store, cycleId: cycle.id });
    console.log(`✔ 诊断完成：${client.name} · 周期 ${cycle.period}`);
    console.log('  ', JSON.stringify(fmt(result.analysis, result.score)));
    console.log(`  待办已生成：${tasks.length} 项（诊断/方案/内容/发布/复测/交付）`);
    console.log(`  下一步：node bin/geo.js content --slug ${client.slug}`);
    store.close();
    return;
  }

  if (command === 'content') {
    const created = generateContent({ store, cycleId: cycle.id });
    console.log(`✔ 内容已生成：#${created.id} ${created.title}（${created.body.length} 字）`);
    console.log(`  查看：${path.join(DATA_DIR, 'contents')}`);
    store.close();
    return;
  }

  if (command === 'deliver' || command === 'report') {
    const out = generateDeliverables({ store, cycleId: cycle.id, dataDir: DATA_DIR, shareToken: createShareToken });
    const collected = collectCycle({ store, cycleId: cycle.id, client });
    const actions = buildActions({ analysis: collected.analysis, client });
    console.log(`✔ 已生成报告：${out.file}`);
    console.log(`  分享链接：/s/${out.token}（30 天有效，需通过服务地址访问）`);
    console.log(`  本轮建议：${actions[0] ?? '—'}`);
    store.close();
    return;
  }

  console.log(`geo — GEO 代运营交付系统

用法：node bin/geo.js <命令> [参数]

命令：
  init      新建客户（自动开本月周期）
  diagnose  跑一轮诊断（--engine mock|deepseek --limit 5）
  content   生成一篇可交付内容
  deliver   生成报告 + 分享链接
  list      列出客户
  report    重新生成报告
  serve     启动控制台（默认 8787）

示例：
  node bin/geo.js init --slug demo --name 演示家政 --industry 家政 --city 芜湖
  node bin/geo.js diagnose --slug demo --engine mock --limit 5
  node bin/geo.js content --slug demo
  node bin/geo.js deliver --slug demo
  node bin/geo.js serve
`);
  store.close();
}

main().catch((error) => {
  console.error('✖', String(error?.message ?? error));
  process.exit(1);
});
