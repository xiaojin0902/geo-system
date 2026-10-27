#!/usr/bin/env node
/**
 * server.js — 代运营交付系统（v2）
 *
 * 页面只有三个：工作台 / 客户 / 设置；动作只有四个：跑诊断、出内容、出交付、勾待办。
 * 六步流程：诊断 → 方案 → 内容 → 发布 → 复测 → 交付。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/db.js';
import { listEngines, engineReady, askEngine } from './lib/engines.js';
import { buildActions } from './lib/analyze.js';
import { createShareToken } from './lib/deliver.js';
import { defaultQuestions, runDiagnose, collectCycle, ensurePlan, generateContent, generateDeliverables } from './lib/pipeline.js';
import { actorOf, cookieHeader, ensureAdmin, hashPassword, newToken, verifyPassword } from './lib/auth.js';
import { dashboardPage, clientPage, clientsPage, settingsPage, loginPage, setTheme } from './lib/views.js';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(APP_ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'geo.db');
const PORT = Number(process.env.PORT ?? 8795);

// ---------------------------------------------------------------- 简单 .env 读取
function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(APP_ROOT, '.env'), 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/u);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/gu, '');
    }
  } catch { /* 没有 .env 也能跑 */ }
}

const store = new Store(DB_FILE);
const generatedAt = () => new Date().toLocaleString('zh-CN', { hour12: false });

/** 当前客户看板数据（工作台用） */
function clientCards() {
  const clients = store.listClients();
  return clients.map((client) => {
    const cycles = store.listCycles(client.id);
    const cycle = cycles[0] ?? null;
    const tasks = cycle ? store.listTasks(cycle.id) : [];
    const collected = cycle ? collectCycle({ store, cycleId: cycle.id, client }) : { analysis: { sample: {} }, score: {} };
    return { client, cycle, tasks, score: collected.score, analysis: collected.analysis };
  });
}

function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(raw));
  });
}

function parseForm(raw) {
  return new URLSearchParams(String(raw ?? ''));
}

function getActor(req) {
  return actorOf(store, req);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
  const pathname = decodeURIComponent(url.pathname);

  // 主题（白标）
  setTheme({
    title: store.getSetting('title', '恒见 GEO'),
    color: store.getSetting('color', '#7c5cff'),
  });

  const isPublic = pathname === '/health' || pathname === '/login' || pathname.startsWith('/s/');

  // 客户分享链接：免登录看报告
  if (pathname.startsWith('/s/')) {
    const token = pathname.slice(3);
    const record = store.getDeliverableByToken(token);
    if (!record || record.kind !== 'share') return html(res, 404, '<h1>链接已失效</h1>');
    const file = path.join(DATA_DIR, 'reports', `report-${record.cycleId}.html`);
    if (!fs.existsSync(file)) return html(res, 404, '<h1>报告不存在</h1>');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(file).pipe(res);
    return;
  }

  // 登录 / 登出
  if (pathname === '/login') {
    if (req.method === 'POST') {
      const form = parseForm(await readBody(req));
      const user = store.getUser(form.get('username') ?? '');
      if (!user || !verifyPassword(form.get('password') ?? '', user.passHash)) {
        return html(res, 401, loginPage({ error: '用户名或密码错误' }));
      }
      const token = newToken();
      store.createSession({ token, username: user.username });
      res.writeHead(302, { location: '/', 'set-cookie': cookieHeader(token) });
      res.end();
      return;
    }
    return html(res, 200, loginPage({}));
  }
  if (pathname === '/logout') {
    const cookies = (req.headers.cookie ?? '').match(/geo2_session=([^;]+)/u);
    if (cookies) store.deleteSession(cookies[1]);
    res.writeHead(302, { location: '/login', 'set-cookie': cookieHeader('', 0) });
    res.end();
    return;
  }
  if (pathname === '/health') return json(res, 200, { ok: true });

  const actor = getActor(req);
  if (!actor && !isPublic) {
    res.writeHead(302, { location: '/login' });
    res.end();
    return;
  }

  // ---------------------------------------------------------------- 动作
  if (req.method === 'POST' && pathname === '/clients') {
    const form = parseForm(await readBody(req));
    const client = store.upsertClient({
      slug: form.get('slug') ?? '',
      name: form.get('name') ?? '',
      industry: form.get('industry') ?? '',
      city: form.get('city') ?? '',
      competitors: String(form.get('competitors') ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    });
    store.currentCycle(client.id);
    res.writeHead(302, { location: `/client/${encodeURIComponent(client.slug)}` });
    res.end();
    return;
  }

  if (req.method === 'POST' && pathname.startsWith('/task/')) {
    const match = pathname.match(/^\/task\/(\d+)\/done$/u);
    if (match) store.setTaskStatus(Number(match[1]), 'done');
    res.writeHead(302, { location: req.headers.referer ?? '/', });
    res.end();
    return;
  }

  const clientAction = pathname.match(/^\/client\/([^/]+)\/(diagnose|content|deliver)$/u);
  if (req.method === 'POST' && clientAction) {
    const client = store.getClient(decodeURIComponent(clientAction[1]));
    if (!client) return json(res, 404, { error: '客户不存在' });
    const cycle = store.currentCycle(client.id);
    const action = clientAction[2];

    if (action === 'diagnose') {
      const form = parseForm(await readBody(req));
      const engine = form.get('engine') ?? 'mock';
      const limit = Math.max(1, Math.min(30, Number(form.get('limit')) || 5));
      try {
        const result = await runDiagnose({ store, cycleId: cycle.id, client, engine, limit, env: process.env });
        store.saveScore({ cycleId: cycle.id, total: result.score.total, level: result.score.level, breakdown: result.score.breakdown });
        ensurePlan({ store, cycleId: cycle.id });
      } catch (error) {
        return html(res, 400, `<h1>诊断失败</h1><p>${String(error?.message ?? error)}</p>`);
      }
      res.writeHead(302, { location: `/client/${encodeURIComponent(client.slug)}` });
      res.end();
      return;
    }

    if (action === 'content') {
      generateContent({ store, cycleId: cycle.id });
      res.writeHead(302, { location: `/client/${encodeURIComponent(client.slug)}` });
      res.end();
      return;
    }

    if (action === 'deliver') {
      generateDeliverables({ store, cycleId: cycle.id, dataDir: DATA_DIR, shareToken: createShareToken });
      res.writeHead(302, { location: `/client/${encodeURIComponent(client.slug)}` });
      res.end();
      return;
    }
  }

  if (req.method === 'POST' && pathname === '/settings') {
    const form = parseForm(await readBody(req));
    store.setSetting('title', form.get('title') ?? '恒见 GEO');
    store.setSetting('color', form.get('color') ?? '#7c5cff');
    res.writeHead(302, { location: '/settings' });
    res.end();
    return;
  }

  // ---------------------------------------------------------------- 页面
  if (pathname === '/' || pathname === '/index.html') {
    const cards = clientCards();
    const today = cards.flatMap((item) => item.tasks
      .filter((task) => task.status !== 'done')
      .map((task) => ({ slug: item.client.slug, clientName: item.client.name, step: task.step, title: task.title, dueAt: task.dueAt })))
      .sort((a, b) => String(a.dueAt ?? '').localeCompare(String(b.dueAt ?? '')))
      .slice(0, 6);
    const scores = cards.map((item) => item.score?.total).filter((value) => Number.isFinite(value));
    return html(res, 200, dashboardPage({
      clients: cards,
      today,
      summary: {
        generatedAt: generatedAt(),
        openTasks: cards.reduce((sum, item) => sum + item.tasks.filter((task) => task.status !== 'done').length, 0),
        avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      },
    }));
  }

  if (pathname === '/clients') {
    return html(res, 200, clientsPage({ clients: store.listClients() }));
  }

  const clientMatch = pathname.match(/^\/client\/([^/]+)$/u);
  if (clientMatch) {
    const client = store.getClient(decodeURIComponent(clientMatch[1]));
    if (!client) return html(res, 404, '<h1>客户不存在</h1>');
    const cycle = store.currentCycle(client.id);
    const tasks = store.listTasks(cycle.id);
    const collected = collectCycle({ store, cycleId: cycle.id, client });
    const actions = buildActions({ analysis: collected.analysis, client });
    const deliverables = store.listCycles(client.id).flatMap((item) =>
      store.db.prepare('SELECT * FROM deliverables WHERE cycle_id = ? ORDER BY id DESC').all(item.id).map((row) => ({
        kind: row.kind, token: row.token, path: row.path, createdAt: row.created_at,
      })),
    );
    return html(res, 200, clientPage({
      client, cycle, tasks, analysis: collected.analysis, score: collected.score,
      actions, contents: store.listContents(cycle.id), publishes: store.listPublishes(cycle.id), deliverables,
    }));
  }

  if (pathname === '/settings') {
    return html(res, 200, settingsPage({
      engines: listEngines(process.env),
      settings: { title: store.getSetting('title', '恒见 GEO'), color: store.getSetting('color', '#7c5cff') },
    }));
  }

  return html(res, 404, '<h1>404</h1>');
}

// ---------------------------------------------------------------- 启动
loadEnv();
const admin = ensureAdmin(store, { password: String(process.env.ADMIN_PASSWORD ?? '').trim() });
if (admin.created) {
  console.log('');
  console.log('════════════════════════════════════');
  console.log(`  已创建管理员：${admin.username}`);
  console.log(`  初始密码：${admin.password}`);
  console.log('════════════════════════════════════');
  console.log('');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (res.headersSent) return res.end();
    html(res, 500, `<h1>500</h1><pre>${String(error?.stack ?? error).replace(/[<>&]/gu, '')}</pre>`);
  });
});

// 直接运行 server.js（或被 CLI 引用）时启动监听；被测试 import 时不启动
const isMain = Boolean(process.argv[1]) && /server\.js$/u.test(process.argv[1]);
if (isMain || process.argv.includes('--serve')) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`代运营交付系统已启动：http://127.0.0.1:${PORT}`);
  });
}

export { handle, store, server };
