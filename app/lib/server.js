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
import { engineHasKey, listEngines } from './engines/index.js';
import { openStore } from './store.js';
import { runDoctor } from './doctor.js';
import { analyzeRun } from './analytics.js';
import {
  auditPage,
  dashboardPage,
  diagnosePage,
  doctorPage,
  insightsPage,
  layout,
  notFoundPage,
  pipelinePage,
  questionsPage,
  toolsPage,
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

async function handle(req, res, slug) {
  const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
  const pathname = decodeURIComponent(url.pathname);

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
export async function startServer({ port = 8787, host = '127.0.0.1', brand = 'hengye' } = {}) {
  const server = http.createServer((req, res) => {
    handle(req, res, brand).catch((error) => {
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
