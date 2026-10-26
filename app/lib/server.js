/**
 * lib/server.js
 * 本地控制台服务（零依赖，node:http）。
 *
 * 定位：给「不想敲命令」的日常使用提供入口——跑诊断、看报告、查问题库、体检官网。
 * 设计取舍：
 *   1. 诊断不在这里重写一遍，而是 spawn 现有 CLI（bin/geo.js）。
 *      好处是控制台与命令行**行为完全一致**，不会出现「网页跑出来和命令跑出来不一样」。
 *   2. 只监听 127.0.0.1，默认不对外暴露；不引入任何鉴权（本机单用户工具）。
 *   3. 报告直接读 data/reports/*.html 原文件，不做二次渲染。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP_ROOT, DATA_DIR, brandPath, dbPath } from './config.js';
import { engineHasKey, engineReadiness, getEngine, listEngines } from './engines/index.js';
import { openStore } from './store.js';
import { runDoctor } from './doctor.js';
import {
  actorOf,
  buildCookie,
  clientCanAccess,
  ensureAdmin,
  newSessionToken,
  verifyPassword,
} from './auth.js';

/** 页面里拼接品牌名等用户可控文本时的最小转义 */
const escHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
import { analyzeRun } from './analytics.js';
import {
  auditPage,
  dashboardPage,
  diagnosePage,
  doctorPage,
  cockpitPage,
  distributionPage,
  insightsPage,
  layout,
  loginPage,
  responsesPage,
  setTheme,
  clientsPage,
  settingsPage,
  auditLogPage,
  notFoundPage,
  pipelinePage,
  questionsPage,
  seoPage,
  toolsPage,
  videoPage,
} from './views.js';

const REPORT_DIR = path.join(DATA_DIR, 'reports');
const MAX_JOB_OUTPUT = 200_000;
const JOB_TTL_MS = 30 * 60 * 1000;

/** 运行中的诊断任务（内存态；控制台重启即清空，这是有意为之） */
const jobs = new Map();
let currentJobId = null;

function newJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function trimJobOutput(text) {
  const value = String(text ?? '');
  return value.length > MAX_JOB_OUTPUT ? value.slice(-MAX_JOB_OUTPUT) : value;
}

function readBrand(slug) {
  try {
    return JSON.parse(fs.readFileSync(brandPath(slug), 'utf8'));
  } catch {
    return { name: '恒野', slug };
  }
}

/** 尽量只读地汇总控制台需要的数据；数据库不存在时返回空态而不是报错 */
function collectState(slug) {
  const state = {
    brand: readBrand(slug),
    runs: [],
    counts: { questions: 0, keywords: 0, contents: 0, runs: 0 },
    latest: null,
  };
  if (!fs.existsSync(dbPath())) return state;

  let store = null;
  try {
    store = openStore(dbPath());
    const brandRow = store.getBrand(slug);
    if (!brandRow) return state;
    state.brand = { ...state.brand, ...brandRow };
    // 评分不在 runs 表里，逐轮 join scores（轮数上限 20，开销可忽略）
    state.runs = store.listRuns(brandRow.id, 20).map((run) => {
      const score = store.getScore(run.runId ?? run.id);
      return {
        runId: run.runId ?? run.id,
        kind: run.kind,
        status: run.status,
        samples: run.okN ?? run.samples ?? run.plannedN ?? null,
        total: score?.total ?? null,
        level: score?.level ?? null,
        startedAt: run.startedAt ?? '',
      };
    });
    state.counts.questions = store.listQuestions(brandRow.id).length;
    state.counts.keywords = store.listKeywords(brandRow.id).length;
    state.counts.contents = store.listContents(brandRow.id).length;
    state.counts.runs = state.runs.length;
    state.latest = state.runs.find((run) => run.total !== null) ?? state.runs[0] ?? null;
    return state;
  } catch {
    return state;
  } finally {
    if (store) {
      try {
        store.close();
      } catch {
        /* 关闭失败不影响页面 */
      }
    }
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function serveStaticReport(res, fileName) {
  // 只允许 reports 目录下的白名单后缀，且禁止路径穿越
  const base = path.basename(fileName);
  if (!/^[\w.-]+\.(html|css|js|png|jpg|svg|ico|json|txt)$/i.test(base)) {
    return html(res, 400, notFoundPage(fileName));
  }
  const file = path.join(REPORT_DIR, base);
  if (!file.startsWith(REPORT_DIR) || !fs.existsSync(file)) {
    return html(res, 404, notFoundPage(`/reports/${base}`));
  }
  const ext = path.extname(base).toLowerCase();
  const type =
    ext === '.html'
      ? 'text/html; charset=utf-8'
      : ext === '.json'
        ? 'application/json; charset=utf-8'
        : ext === '.png'
          ? 'image/png'
          : ext === '.svg'
            ? 'image/svg+xml'
            : ext === '.jpg'
              ? 'image/jpeg'
              : ext === '.css'
                ? 'text/css; charset=utf-8'
                : ext === '.js'
                  ? 'application/javascript; charset=utf-8'
                  : 'text/plain; charset=utf-8';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

/** 读取原始请求体（表单提交用；readBody 只解析 JSON） */
function readRawBody(req, limit = 200000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) reject(new Error('请求体过大'));
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

/** 起一个 CLI 子进程，把输出流式收进 job（诊断与闭环验收共用） */
function startCliJob(args, meta = {}) {
  const id = newJobId();
  const job = {
    id,
    status: 'running',
    ...meta,
    stdout: '',
    stderr: '',
    exitCode: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(id, job);
  currentJobId = id;

  const child = spawn(process.execPath, [path.join(APP_ROOT, 'bin', 'geo.js'), ...args], {
    cwd: APP_ROOT,
    env: { ...process.env, GEO_SERVE_JOB: id },
  });

  child.stdout.on('data', (chunk) => {
    job.stdout = trimJobOutput(job.stdout + String(chunk));
  });
  child.stderr.on('data', (chunk) => {
    job.stderr = trimJobOutput(job.stderr + String(chunk));
  });
  child.on('error', (error) => {
    job.stderr = trimJobOutput(`${job.stderr}\n无法启动子进程：${error.message}`);
    job.status = 'done';
    job.exitCode = -1;
    job.finishedAt = new Date().toISOString();
    currentJobId = null;
  });
  child.on('close', (code) => {
    job.exitCode = code;
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    if (currentJobId === id) currentJobId = null;
  });

  // 定期清理老任务，避免内存里堆输出
  for (const [jobId, item] of jobs) {
    if (item.status === 'done' && Date.now() - Date.parse(item.finishedAt) > JOB_TTL_MS) {
      jobs.delete(jobId);
    }
  }
  return job;
}

function engineStatus() {
  return listEngines().map((meta) => ({
    id: meta.id,
    label: meta.label,
    requiresKey: meta.requiresKey,
    configured: !meta.requiresKey || engineHasKey(meta.id, process.env),
  }));
}

/**
 * Basic Auth：线上部署时默认开启（未配 BASIC_USER 则不启用，保持本地零门槛）。
 * 为什么不用第三方登录：自用/客户演示场景下，一个账号密码就够，且不引入外部依赖与账号体系。
 */
function checkAuth(req, auth) {
  if (!auth || !auth.user) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const index = decoded.indexOf(':');
    const user = index >= 0 ? decoded.slice(0, index) : decoded;
    const pass = index >= 0 ? decoded.slice(index + 1) : '';
    return user === auth.user && pass === auth.pass;
  } catch {
    return false;
  }
}

async function handle(req, res, slug, auth = null) {
  const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
  const pathname = decodeURIComponent(url.pathname);

  // ---------------------------------------------------------------- 登录与会话
  // 公开路径：健康检查、客户分享链接、登录页、静态图标
  const isPublic =
    pathname === '/health' || pathname.startsWith('/s/') || pathname === '/login' || pathname === '/favicon.ico';

  // 当前登录者：优先会话 cookie，其次 Basic Auth（本机/运维兜底）
  let actor = null;
  if (!(pathname.startsWith('/s/') || pathname === '/health' || pathname === '/login')) {
    if (fs.existsSync(dbPath())) {
      let store = null;
      try {
        store = openStore(dbPath());
        actor = actorOf(store, req);
      } catch {
        actor = null;
      } finally {
        if (store) {
          try {
            store.close();
          } catch {
            /* ignore */
          }
        }
      }
    }
    if (!actor && checkAuth(req, auth)) {
      actor = { username: 'admin', role: 'admin', brandSlug: null, viaBasic: true };
    }
    if (!actor) {
      // 未登录：页面跳登录页，API 返回 401
      if (pathname.startsWith('/api/')) {
        return json(res, 401, { ok: false, error: '未登录' });
      }
      res.writeHead(302, { location: `/login?next=${encodeURIComponent(pathname)}` });
      res.end();
      return;
    }
    // 客户角色：只能看自己品牌，且只能访问白名单页面
    if (actor.role === 'client') {
      if (!actor.brandSlug) {
        return html(res, 403, layout({ title: '未绑定品牌', body: '<h1>账号未绑定品牌</h1><div class="sub">请联系管理员。</div>' }));
      }
      slug = actor.brandSlug;
      if (!clientCanAccess(pathname)) {
        return html(res, 403, layout({ title: '无权访问', body: '<h1>无权访问</h1><div class="sub">该页面仅管理员可用。</div>' }));
      }
    }
  }

  // 白标：按设置覆盖标题/logo/主色（每请求注入，避免多客户串台）
  if (fs.existsSync(dbPath()) && !pathname.startsWith('/s/') && pathname !== '/health') {
    let themeStore = null;
    try {
      themeStore = openStore(dbPath());
      const globalSettings = themeStore.listSettings(null);
      const brandRow = themeStore.getBrand(slug);
      const brandSettings = brandRow ? themeStore.listSettings(brandRow.id) : {};
      const merged = { ...globalSettings, ...brandSettings };
      setTheme({
        title: merged.app_title || '恒野 GEO',
        logo: merged.logo_text || '恒野 GEO',
        color: merged.primary_color || '#7c5cff',
        footer: merged.footer_text || '',
      });
    } catch {
      /* 主题失败不影响主流程 */
    } finally {
      if (themeStore) {
        try {
          themeStore.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  // 登录 / 登出
  if (req.method === 'GET' && pathname === '/login') {
    return html(res, 200, loginPage({ next: url.searchParams.get('next') ?? '/' }));
  }
  if (req.method === 'POST' && pathname === '/login') {
    const raw = await readRawBody(req);
    const form = new URLSearchParams(raw);
    const username = String(form.get('username') ?? '').trim();
    const password = String(form.get('password') ?? '');
    let store = null;
    try {
      store = openStore(dbPath());
      const user = store.getUser(username);
      const ok = Boolean(user && user.active && verifyPassword(password, user.passHash));
      const ip = req.socket?.remoteAddress ?? null;
      if (!ok) {
        store.writeAudit({ actor: username || 'anonymous', action: 'login_failed', detail: '用户名或密码错误', ip });
        return html(res, 401, loginPage({ error: '用户名或密码错误', next: String(form.get('next') ?? '/') }));
      }
      const token = newSessionToken();
      store.createSession({ token, username: user.username, role: user.role });
      store.writeAudit({ actor: user.username, action: 'login', detail: `角色 ${user.role}`, ip });
      const next = String(form.get('next') ?? '/');
      const safeNext = next.startsWith('/') ? next : '/';
      res.writeHead(302, { location: safeNext, 'set-cookie': buildCookie(token) });
      res.end();
      return;
    } finally {
      if (store) {
        try {
          store.close();
        } catch {
          /* ignore */
        }
      }
    }
  }
  if (pathname === '/logout') {
    let store = null;
    try {
      store = openStore(dbPath());
      const current = actorOf(store, req);
      if (current) {
        store.deleteSession(current.token);
        store.writeAudit({ actor: current.username, action: 'logout', detail: '' });
      }
    } catch {
      /* ignore */
    } finally {
      if (store) {
        try {
          store.close();
        } catch {
          /* ignore */
        }
      }
    }
    res.writeHead(302, { location: '/login', 'set-cookie': buildCookie('', 0) });
    res.end();
    return;
  }

  // ---------------------------------------------------------------- 静态报告
  if (pathname.startsWith('/reports/')) {
    return serveStaticReport(res, pathname.slice('/reports/'.length));
  }

  // ---------------------------------------------------------------- 页面
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const state = collectState(slug);
    const demoRuns = state.runs.filter((r) => r.kind === 'demo').length;
    return html(
      res,
      200,
      dashboardPage({
        brand: state.brand,
        runs: state.runs,
        latest: state.latest,
        keys: [
          { name: 'DEEPSEEK_API_KEY', present: Boolean(process.env.DEEPSEEK_API_KEY) },
          { name: 'DASHSCOPE_API_KEY', present: Boolean(process.env.DASHSCOPE_API_KEY) },
        ],
        engines: engineStatus(),
        admin: actor?.role === 'admin',
        counts: state.counts,
        demoRuns,
        liveRuns: state.runs.length - demoRuns,
      }),
    );
  }

  if (req.method === 'GET' && pathname === '/run-diagnose') {
    const running = currentJobId ? jobs.get(currentJobId) : null;
    return html(
      res,
      200,
      diagnosePage({
        brand: readBrand(slug),
        engines: engineStatus(),
        running,
      }),
    );
  }

  if (req.method === 'GET' && pathname === '/questions') {
    const state = collectState(slug);
    let questions = [];
    if (fs.existsSync(dbPath())) {
      let store = null;
      try {
        store = openStore(dbPath());
        const brandRow = store.getBrand(slug);
        if (brandRow) {
          questions = store
            .listQuestions(brandRow.id)
            .map((q) => ({ ...q, intent: q.intent ?? null }));
        }
      } catch {
        questions = [];
      } finally {
        if (store) {
          try {
            store.close();
          } catch {
            /* ignore */
          }
        }
      }
    }
    return html(res, 200, questionsPage({ brand: state.brand, questions }));
  }

  if (req.method === 'GET' && pathname === '/video') {
    const state = collectState(slug);
    const dir = path.join(DATA_DIR, 'videos');
    let files = [];
    try {
      if (fs.existsSync(dir)) {
        files = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.md'))
          .map((f) => ({ id: f.replace(/\.md$/u, ''), title: '' }))
          .reverse();
      }
    } catch {
      files = [];
    }
    // 用内容标题补全列表名（有就补，没有就空着）
    try {
      const store = openStore(dbPath());
      const brandRow = store.getBrand(slug);
      if (brandRow) {
        const contents = store.listContents(brandRow.id);
        files = files.map((f) => ({
          ...f,
          title: (contents.find((c) => String(c.id) === String(f.id))?.title ?? '').slice(0, 30),
        }));
      }
      store.close();
    } catch {
      /* 忽略：列表名不是关键路径 */
    }
    const wantFile = String(url.searchParams.get('file') ?? '');
    const selected = files.some((f) => f.id === wantFile) ? wantFile : null;
    let content = '';
    if (selected) {
      try {
        content = fs.readFileSync(path.join(dir, `${selected}.md`), 'utf8');
      } catch {
        content = '';
      }
    }
    return html(res, 200, videoPage({ brand: state.brand, files, selected, content }));
  }

  if (req.method === 'GET' && pathname === '/seo') {
    const state = collectState(slug);
    let result = null;
    try {
      const file = path.join(DATA_DIR, 'seo', 'latest.json');
      if (fs.existsSync(file)) result = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      result = null;
    }
    return html(res, 200, seoPage({ brand: state.brand, result }));
  }

  if (req.method === 'GET' && pathname === '/audit') {
    const target = url.searchParams.get('url') ?? '';
    let result = null;
    let error = null;
    if (target.trim()) {
      try {
        const mod = await import('./audit-site.js');
        result = await mod.auditSite(target.trim());
      } catch (err) {
        error =
          err?.code === 'ERR_MODULE_NOT_FOUND'
            ? '官网体检模块（lib/audit-site.js）当前不可用。'
            : `体检失败：${err?.message ?? err}`;
      }
    }
    return html(res, 200, auditPage({ brand: readBrand(slug), url: target, result, error }));
  }

  if (req.method === 'GET' && pathname === '/pipeline') {
    let report = null;
    let reportFile = null;
    try {
      const files = fs
        .readdirSync(REPORT_DIR)
        .filter((name) => name.startsWith('demo-') && name.endsWith('.md'))
        .sort();
      if (files.length) {
        reportFile = path.join(REPORT_DIR, files.at(-1));
        report = fs.readFileSync(reportFile, 'utf8');
      }
    } catch {
      report = null;
    }
    const running = currentJobId ? jobs.get(currentJobId) : null;
    return html(
      res,
      200,
      pipelinePage({
        brand: readBrand(slug),
        report,
        reportFile,
        running: running && running.status === 'running' ? running.id : null,
      }),
    );
  }

  if (req.method === 'POST' && pathname === '/api/demo') {
    if (currentJobId && jobs.get(currentJobId)?.status === 'running') {
      return json(res, 409, { error: '已有任务在跑，等它结束再开始。' });
    }
    return json(
      res,
      200,
      { ok: true, job: startCliJob(['demo', '--brand', slug, '--limit', '12', '--questions', '24', '--json']) },
    );
  }

  if (req.method === 'GET' && pathname === '/tools') {
    const state = collectState(slug);
    const keywords = url.searchParams.get('keywords') ?? '';
    const band = url.searchParams.get('band') ?? 'standard';
    const count = Math.max(1, Math.min(48, Number(url.searchParams.get('count')) || 12));

    let quote = null;
    if (keywords.trim()) {
      try {
        const module = await import('./quote.js');
        const items = keywords
          .split(',')
          .map((chunk) => chunk.trim())
          .filter(Boolean)
          .map((chunk) => {
            const at = chunk.lastIndexOf(':');
            return at > 0
              ? { term: chunk.slice(0, at).trim(), difficulty: chunk.slice(at + 1).trim() }
              : { term: chunk };
          });
        quote = module.buildQuote({ items, band });
      } catch {
        quote = null;
      }
    }

    let questions = null;
    if (url.searchParams.has('count')) {
      try {
        const module = await import('./questions-gen.js');
        const generated = module.generateQuestions({ brand: readBrand(slug), count });
        questions = generated.questions;
      } catch {
        questions = null;
      }
    }

    let channels = null;
    try {
      const module = await import('./publish-channels.js');
      channels = module.listChannels({ env: process.env });
    } catch {
      channels = null;
    }

    return html(
      res,
      200,
      toolsPage({ brand: state.brand, keywords, band, quote, questionCount: count, questions, channels }),
    );
  }

  if (req.method === 'GET' && pathname === '/distribution') {
    const state = collectState(slug);
    let channels = [];
    let publications = [];
    let contents = [];
    if (fs.existsSync(dbPath())) {
      let store = null;
      try {
        const mod = await import('./publish-channels.js');
        channels = mod.listChannels({ env: process.env });
      } catch {
        channels = [];
      }
      try {
        store = openStore(dbPath());
        const brandRow = store.getBrand(slug);
        if (brandRow) {
          contents = store.listContents(brandRow.id);
          publications = store.listPublications ? store.listPublications(brandRow.id) : [];
        }
      } catch {
        publications = [];
      } finally {
        if (store) {
          try {
            store.close();
          } catch {
            /* ignore */
          }
        }
      }
    }
    return html(res, 200, distributionPage({ brand: state.brand, channels, contents, publications }));
  }

  // ---------------------------------------------------------- 回答浏览器
  if (req.method === 'GET' && pathname === '/responses') {
    const state = collectState(slug);
    const requested = Number(url.searchParams.get('run'));
    const fallback = state.runs.find((run) => run.total !== null) ?? state.runs[0] ?? null;
    const runId = Number.isFinite(requested) && requested > 0 ? requested : (fallback ? fallback.runId : null);
    const engine = String(url.searchParams.get('engine') ?? '');
    const verdict = String(url.searchParams.get('verdict') ?? '');
    let rows = [];
    if (runId && fs.existsSync(dbPath())) {
      let store = null;
      try {
        store = openStore(dbPath());
        const detail = store.getRunDetail(runId);
        rows = (detail?.rows ?? []).map((row) => ({
          question: row.question?.text ?? '',
          engine: row.answer?.engine ?? '—',
          verdict: row.judgment?.verdict ?? 'unknown',
          text: row.answer?.text ?? '',
          citations: row.answer?.citations ?? [],
          matchedText: row.judgment?.matchedText ?? '',
          latencyMs: row.answer?.latencyMs ?? 0,
        }));
      } catch {
        rows = [];
      } finally {
        if (store) {
          try {
            store.close();
          } catch {
            /* ignore */
          }
        }
      }
    }
    if (engine) rows = rows.filter((row) => row.engine === engine);
    if (verdict) rows = rows.filter((row) => row.verdict === verdict);
    return html(res, 200, responsesPage({ brand: state.brand, runs: state.runs, runId, rows, engine, verdict }));
  }

  // ---------------------------------------------------------- 引擎与供应商信息（前端不漂移）
  if (req.method === 'GET' && pathname === '/api/providers') {
    const list = listEngines().map((meta) => {
      const readiness = meta.requiresKey ? engineReadiness(meta.id, process.env) : { ready: true, reason: '' };
      let described = {};
      try {
        const engine = getEngine(meta.id, { env: process.env });
        described = typeof engine.describe === 'function' ? engine.describe() : {};
      } catch {
        described = {};
      }
      return {
        id: meta.id,
        label: meta.label,
        configured: readiness.ready,
        reason: readiness.reason,
        endpoint: described.endpoint ?? null,
        model: described.model ?? null,
        builtinSearch: Boolean(described.builtinSearch),
      };
    });
    return json(res, 200, { ok: true, count: list.length, engines: list });
  }

  // ---------------------------------------------------------- 客户周报
  if (req.method === 'GET' && pathname === '/weekly') {
    let report = null;
    if (fs.existsSync(dbPath())) {
      let store = null;
      try {
        store = openStore(dbPath());
        const brandRow = store.getBrand(slug);
        if (brandRow) {
          const rows = store.listRuns(brandRow.id, 30);
          if (rows.length) {
            const runs = rows.map((r) => {
              const score = store.getScore(r.id);
              return {
                runId: r.id,
                kind: r.kind,
                status: r.status,
                samples: r.okN ?? null,
                total: score?.total ?? null,
                level: score?.level ?? null,
                startedAt: r.startedAt ?? '',
              };
            });
            const latest = runs.find((r) => r.total !== null) ?? runs[0];
            const detail = store.getRunDetail(latest.runId);
            const weeklyMod = await import('./weekly.js');
            const analyticsMod = await import('./analytics.js');
            let insights = detail ? analyticsMod.analyzeRun({ brand: brandRow, rows: detail.rows }) : null;
            if (insights) insights.score = store.getScore(latest.runId);
            let previous = null;
            const prevRow = runs.find((r) => r.runId !== latest.runId);
            if (prevRow) {
              const prevDetail = store.getRunDetail(prevRow.runId);
              if (prevDetail) {
                previous = analyticsMod.analyzeRun({ brand: brandRow, rows: prevDetail.rows });
                previous.score = store.getScore(prevRow.runId);
              }
            }
            report = weeklyMod.buildWeeklyReport({ brand: brandRow, runs, insights, previous });
          }
        }
      } catch {
        report = null;
      } finally {
        if (store) {
          try {
            store.close();
          } catch {
            /* ignore */
          }
        }
      }
    }
    if (!report) {
      return html(res, 200, layout({ title: '周报', active: '/weekly', body: '<h1>周报</h1><div class="card empty" style="margin-top:16px">还没有运行数据，先跑一轮诊断。</div>' }));
    }
    const weeklyMod = await import('./weekly.js');
    // 周报本身就是一个完整 HTML 文档，直接返回（客户可打印/转发）
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(weeklyMod.renderWeeklyHtml(report));
    return;
  }

  // ---------------------------------------------------------- 多客户管理（管理员）
  if (req.method === 'GET' && pathname === '/clients') {
    if (actor?.role !== 'admin') return html(res, 403, layout({ title: '无权访问', body: '<h1>无权访问</h1>' }));
    let clients = [];
    if (fs.existsSync(dbPath())) {
      let store = null;
      try {
        store = openStore(dbPath());
        const users = store.listUsers();
        clients = store.listBrands().map((brand) => {
          const runs = store.listRuns(brand.id, 5);
          const scored = runs.find((run) => run.total !== null) ?? runs[0] ?? null;
          return {
            slug: brand.slug,
            name: brand.name,
            runs: runs.length,
            latestScore: scored?.total ?? null,
            level: scored?.level ?? null,
            lastRunAt: scored?.startedAt ?? null,
            users: users.filter((u) => u.brandSlug === brand.slug).length,
          };
        });
      } catch {
        clients = [];
      } finally {
        if (store) {
          try {
            store.close();
          } catch {
            /* ignore */
          }
        }
      }
    }
    return html(res, 200, clientsPage({ clients, generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }) }));
  }

  if (req.method === 'GET' && pathname === '/settings') {
    if (actor?.role !== 'admin') return html(res, 403, layout({ title: '无权访问', body: '<h1>无权访问</h1>' }));
    let settings = {};
    if (fs.existsSync(dbPath())) {
      let store = null;
      try {
        store = openStore(dbPath());
        settings = store.listSettings(null);
      } catch {
        settings = {};
      } finally {
        if (store) {
          try {
            store.close();
          } catch {
            /* ignore */
          }
        }
      }
    }
    return html(res, 200, settingsPage({ brand: readBrand(slug), settings, isAdmin: true, generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }) }));
  }

  if (req.method === 'GET' && pathname === '/audit-log') {
    if (actor?.role !== 'admin') return html(res, 403, layout({ title: '无权访问', body: '<h1>无权访问</h1>' }));
    let entries = [];
    if (fs.existsSync(dbPath())) {
      let store = null;
      try {
        store = openStore(dbPath());
        entries = store.listAudit({ limit: 200 });
      } catch {
        entries = [];
      } finally {
        if (store) {
          try {
            store.close();
          } catch {
            /* ignore */
          }
        }
      }
    }
    return html(res, 200, auditLogPage({ entries, generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }) }));
  }

  // 新建客户（管理员）
  if (req.method === 'POST' && pathname === '/api/clients') {
    if (actor?.role !== 'admin') return json(res, 403, { ok: false, error: '无权操作' });
    let store = null;
    try {
      const body = await readBody(req);
      const slug = String(body.slug ?? '').trim().toLowerCase();
      const name = String(body.name ?? '').trim();
      if (!/^[a-z0-9-]{2,40}$/u.test(slug)) return json(res, 400, { ok: false, error: 'slug 只能用 2-40 位小写字母/数字/连字符' });
      if (!name) return json(res, 400, { ok: false, error: '品牌名不能为空' });
      store = openStore(dbPath());
      if (store.getBrand(slug)) return json(res, 409, { ok: false, error: `客户「${slug}」已存在` });
      store.upsertBrand({
        slug,
        name,
        legalName: name,
        city: String(body.city ?? '').trim(),
        industry: '内容代运营',
        scope: '本地',
        urls: body.url ? [String(body.url).trim()] : [],
        aliases: [name],
        rejectedNames: [],
        competitors: [],
      });
      store.writeAudit({ actor: actor.username, brandSlug: slug, action: 'client_create', detail: name });
      return json(res, 200, { ok: true, client: { slug, name } });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    } finally {
      if (store) {
        try {
          store.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  // 创建客户账号（管理员）
  if (req.method === 'POST' && pathname === '/api/users') {
    if (actor?.role !== 'admin') return json(res, 403, { ok: false, error: '无权操作' });
    let store = null;
    try {
      const body = await readBody(req);
      const username = String(body.username ?? '').trim();
      const password = String(body.password ?? '');
      const brandSlug = String(body.brandSlug ?? '').trim();
      if (!/^[a-zA-Z0-9_.-]{3,40}$/u.test(username)) return json(res, 400, { ok: false, error: '用户名 3-40 位字母/数字/._-' });
      if (password.length < 8) return json(res, 400, { ok: false, error: '密码至少 8 位' });
      store = openStore(dbPath());
      if (!store.getBrand(brandSlug)) return json(res, 404, { ok: false, error: '品牌不存在' });
      const { hashPassword } = await import('./auth.js');
      store.createUser({ username, passHash: hashPassword(password), role: 'client', brandSlug });
      store.writeAudit({ actor: actor.username, brandSlug, action: 'user_create', detail: username });
      return json(res, 200, { ok: true, user: { username, role: 'client', brandSlug } });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    } finally {
      if (store) {
        try {
          store.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  // 保存白标与配额
  if (req.method === 'POST' && pathname === '/api/settings') {
    if (actor?.role !== 'admin') return json(res, 403, { ok: false, error: '无权操作' });
    let store = null;
    try {
      const body = await readBody(req);
      store = openStore(dbPath());
      for (const [key, value] of Object.entries(body)) {
        if (!/^[a-z_]{2,40}$/u.test(key)) continue;
        store.setSetting(key, String(value ?? ''), null);
      }
      store.writeAudit({ actor: actor.username, action: 'settings_update', detail: Object.keys(body).join(',') });
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    } finally {
      if (store) {
        try {
          store.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ---------------------------------------------------------- 客户分享链接
  if (req.method === 'GET' && pathname.startsWith('/s/')) {
    const token = pathname.slice(3).trim();
    let share = null;
    let insights = null;
    let brand = { name: '恒野' };
    let runMeta = null;
    if (token && fs.existsSync(dbPath())) {
      let store = null;
      try {
        store = openStore(dbPath());
        share = store.getShare(token);
        if (share) {
          const brandRow = store.getBrand(share.brandSlug);
          if (brandRow) brand = brandRow;
          const runId = share.runId;
          if (runId) {
            const detail = store.getRunDetail(runId);
            if (detail) {
              insights = analyzeRun({ brand: detail.brand, rows: detail.rows });
              runMeta = store.listRuns(brandRow.id, 200).find((r) => r.runId === runId) ?? null;
            }
          }
        }
      } catch {
        share = null;
      } finally {
        if (store) {
          try {
            store.close();
          } catch {
            /* ignore */
          }
        }
      }
    }
    if (!share) {
      return html(
        res,
        404,
        layout({
          title: '链接已失效',
          body: `<h1>链接已失效</h1><div class="sub">这个分享链接不存在、已过期或被撤销。请联系你的服务商重新生成。</div>`,
        }),
      );
    }
    const page = insightsPage({ brand, runs: runMeta ? [runMeta] : [], runId: share.runId, insights });
    const banner = `<div class="hint" style="border-color:#22d3ee;background:rgba(34,211,238,.08)">
      客户分享视图 · 只读 · 品牌「${escHtml(brand.name ?? '')}」· 到期 ${escHtml(String(share.expiresAt ?? '长期').slice(0, 10))}
    </div>`;
    return html(res, 200, page.replace('<h1>', banner + '<h1>'));
  }

  if (req.method === 'GET' && pathname === '/cockpit') {
    const state = collectState(slug);
    const requested = Number(url.searchParams.get('run'));
    const fallback = state.runs.find((run) => run.total !== null) ?? state.runs[0] ?? null;
    const runId = Number.isFinite(requested) && requested > 0 ? requested : (fallback ? fallback.runId : null);
    let insights = null;
    let previous = null;
    let plan = null;
    const trend = [];
    if (runId && fs.existsSync(dbPath())) {
      let store = null;
      try {
        store = openStore(dbPath());
        const detail = store.getRunDetail(runId);
        if (detail) {
          insights = analyzeRun({ brand: detail.brand, rows: detail.rows });
          try {
            const planMod = await import('./action-plan.js');
            plan = planMod.buildActionPlan({
              brand: detail.brand,
              score: store.getScore(runId),
              insights,
              rows: detail.rows,
              competitors: insights.sov?.competitors ?? [],
            });
          } catch {
            plan = null;
          }
        }

        // 上一轮（用于 delta 对比）
        const ordered = state.runs.filter((run) => run.runId < runId);
        for (const candidate of ordered) {
          const prevDetail = store.getRunDetail(candidate.runId);
          if (!prevDetail) continue;
          previous = analyzeRun({ brand: prevDetail.brand, rows: prevDetail.rows });
          break;
        }

        // 趋势：最近 8 轮（升序），每轮算总分与提及率
        const recent = state.runs.slice(0, 8).slice().reverse();
        for (const run of recent) {
          const runDetail = store.getRunDetail(run.runId);
          if (!runDetail) continue;
          const runInsights = analyzeRun({ brand: runDetail.brand, rows: runDetail.rows });
          trend.push({
            runId: run.runId,
            total: run.total ?? 0,
            mentionRate: runInsights.sample?.mentionRate ?? 0,
          });
        }
      } catch {
        insights = insights ?? null;
      } finally {
        if (store) {
          try {
            store.close();
          } catch {
            /* ignore */
          }
        }
      }
    }
    return html(
      res,
      200,
      cockpitPage({
        brand: state.brand,
        runs: state.runs,
        runId,
        insights,
        previous,
        trend,
        plan,
        engines: engineStatus(),
      }),
    );
  }

  if (req.method === 'GET' && pathname === '/insights') {
    const state = collectState(slug);
    const requested = Number(url.searchParams.get('run'));
    const fallback = state.runs.find((run) => run.total !== null) ?? state.runs[0] ?? null;
    const runId = Number.isFinite(requested) && requested > 0 ? requested : (fallback ? fallback.runId : null);
    let insights = null;
    if (runId && fs.existsSync(dbPath())) {
      let store = null;
      try {
        store = openStore(dbPath());
        const detail = store.getRunDetail(runId);
        if (detail) insights = analyzeRun({ brand: detail.brand, rows: detail.rows });
      } catch {
        insights = null;
      } finally {
        if (store) {
          try {
            store.close();
          } catch {
            /* ignore */
          }
        }
      }
    }
    return html(
      res,
      200,
      insightsPage({ brand: state.brand, runs: state.runs, runId, insights }),
    );
  }

  if (req.method === 'GET' && pathname === '/doctor') {
    const probe = url.searchParams.get('probe') === '1';
    const report = await runDoctor({ env: process.env, probe, brandSlug: slug });
    return html(res, 200, doctorPage({ report }));
  }

  // 报告页：/run/<id> → data/reports/run-<id>.html
  const runMatch = pathname.match(/^\/run\/(\d+)$/);
  if (req.method === 'GET' && runMatch) {
    const file = path.join(REPORT_DIR, `run-${runMatch[1]}.html`);
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return fs.createReadStream(file).pipe(res);
    }
    return html(
      res,
      404,
      layout({
        title: '报告不存在',
        body: `<h1>报告不存在</h1>
          <div class="sub">没有找到 <span class="mono">data/reports/run-${runMatch[1]}.html</span>。</div>
          <p><a class="btn ghost" href="/" style="margin-top:16px">回总览</a></p>`,
      }),
    );
  }

  // ---------------------------------------------------------------- API
  if (req.method === 'GET' && pathname === '/api/state') {
    return json(res, 200, {
      ...collectState(slug),
      keys: {
        DEEPSEEK_API_KEY: Boolean(process.env.DEEPSEEK_API_KEY),
        DASHSCOPE_API_KEY: Boolean(process.env.DASHSCOPE_API_KEY),
      },
      engines: engineStatus(),
      reportDir: REPORT_DIR,
    });
  }

  if (req.method === 'POST' && pathname === '/api/diagnose') {
    if (currentJobId && jobs.get(currentJobId)?.status === 'running') {
      return json(res, 409, { error: '已有一轮诊断在跑，等它结束再开始。' });
    }
    const body = await readBody(req);
    const engines = String(body.engines ?? 'mock').trim() || 'mock';
    const limit = Math.max(1, Math.min(200, Number(body.limit) || 30));
    if (!/^(mock|live|all|[a-z0-9_,-]+)$/i.test(engines)) {
      return json(res, 400, { error: '引擎参数不合法' });
    }
    // 用量配额：本月已采集样本数 + 本次题数 不得超过上限（0 = 不限）
    try {
      const quotaStore = openStore(dbPath());
      try {
        const brandRow = quotaStore.getBrand(slug);
        if (brandRow) {
          const quota = Number(quotaStore.getSetting('quota_questions', brandRow.id) ?? quotaStore.getSetting('quota_questions', null) ?? '0');
          if (quota > 0) {
            const monthStart = new Date();
            monthStart.setDate(1);
            monthStart.setHours(0, 0, 0, 0);
            const used = quotaStore
              .listRuns(brandRow.id, 500)
              .filter((run) => run.startedAt && new Date(run.startedAt).getTime() >= monthStart.getTime())
              .reduce((sum, run) => sum + Number(run.okN ?? 0), 0);
            if (used + limit > quota) {
              return json(res, 429, { error: `本月配额不足：已用 ${used}/${quota} 题，本次申请 ${limit} 题。请调整配额或下月再跑。` });
            }
          }
        }
      } finally {
        quotaStore.close();
      }
    } catch {
      /* 配额检查失败不阻断（宁可放行也不误杀） */
    }
    try {
      const auditStore = openStore(dbPath());
      try {
        auditStore.writeAudit({ actor: actor?.username ?? 'unknown', brandSlug: slug, action: 'diagnose_start', detail: `engines=${engines} limit=${limit}` });
      } finally {
        auditStore.close();
      }
    } catch {
      /* 审计失败不阻断 */
    }
    return json(
      res,
      200,
      {
        ok: true,
        job: startCliJob(['diagnose', '--brand', slug, '--engines', engines, '--limit', String(limit)], {
          engines,
          limit,
        }),
      },
    );
  }

  if (req.method === 'GET' && pathname === '/api/job') {
    const id = url.searchParams.get('id') ?? '';
    const job = jobs.get(id);
    if (!job) return json(res, 404, { error: '任务不存在或已过期' });
    return json(res, 200, job);
  }

  if (req.method === 'POST' && pathname === '/api/init') {
    const job = {
      id: newJobId(),
      status: 'running',
      stdout: '',
      stderr: '',
      exitCode: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    jobs.set(job.id, job);
    const child = spawn(process.execPath, [path.join(APP_ROOT, 'bin', 'geo.js'), 'init', '--brand', slug], {
      cwd: APP_ROOT,
      env: { ...process.env },
    });
    child.stdout.on('data', (c) => {
      job.stdout = trimJobOutput(job.stdout + String(c));
    });
    child.stderr.on('data', (c) => {
      job.stderr = trimJobOutput(job.stderr + String(c));
    });
    child.on('close', (code) => {
      job.exitCode = code;
      job.status = 'done';
      job.finishedAt = new Date().toISOString();
    });
    return json(res, 200, { ok: true, job });
  }

  if (req.method === 'GET' && pathname === '/health') {
    return json(res, 200, { ok: true, uptime: process.uptime() });
  }

  return html(res, 404, notFoundPage(pathname));
}

/**
 * 启动控制台。
 * @param {object} [options]
 * @param {number} [options.port]
 * @param {string} [options.host]
 * @param {string} [options.brand] 品牌 slug
 * @returns {Promise<{url:string, port:number, close:()=>Promise<void>, server:http.Server}>}
 */
export async function startServer({ port = 8787, host = '127.0.0.1', brand = 'hengye', auth = null } = {}) {
  // 首次启动自动建管理员：密码来自 ADMIN_PASSWORD，没配就随机生成并只打印一次
  if (fs.existsSync(dbPath())) {
    let store = null;
    try {
      store = openStore(dbPath());
      const result = ensureAdmin(store, { password: String(process.env.ADMIN_PASSWORD ?? '').trim() });
      if (result.created) {
        console.log('');
        console.log('════════════════════════════════════════');
        console.log(`  已创建管理员账号：${result.username}`);
        console.log(`  初始密码：${result.password}`);
        console.log('  请登录后立即在「设置」里改密码（或重设 ADMIN_PASSWORD 后重建账号）');
        console.log('════════════════════════════════════════');
        console.log('');
      }
    } catch (error) {
      console.log(`管理员初始化失败：${error?.message ?? error}`);
    } finally {
      if (store) {
        try {
          store.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res, brand, auth).catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      html(
        res,
        500,
        layout({
          title: '服务错误',
          body: `<h1>500</h1><div class="term">${String(error?.stack ?? error).replace(/[<>&]/g, '')}</div>`,
        }),
      );
    });
  });

  // 端口被占用就顺延，最多试 10 个（本地工具不该因为端口冲突起不来）
  let lastError = null;
  for (let offset = 0; offset < 10; offset += 1) {
    const candidate = port + offset;
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener('listening', onReady);
          reject(error);
        };
        const onReady = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onReady);
        server.listen(candidate, host);
      });
      const actual = server.address().port;
      return {
        server,
        port: actual,
        url: `http://${host}:${actual}`,
        close: () =>
          new Promise((resolve) => {
            server.close(() => resolve());
          }),
      };
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }
  throw lastError ?? new Error('无法启动本地服务');
}
