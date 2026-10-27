/**
 * lib/db.js — 数据层（SQLite，Node 22 内置 node:sqlite，零依赖）
 *
 * 设计原则：
 *   1. 一切围绕「交付周期」组织：clients → cycles → runs/contents/publishes/deliverables；
 *   2. 工作台待办来自 tasks 表，不靠前端猜；
 *   3. 只做加法迁移（addColumn），老库不会因为新字段炸掉。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  industry TEXT, city TEXT, url TEXT, contact TEXT,
  competitors_json TEXT, facts_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  period TEXT NOT NULL,              -- YYYY-MM
  status TEXT NOT NULL DEFAULT 'running',
  created_at TEXT NOT NULL,
  UNIQUE(client_id, period)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  engine TEXT NOT NULL,
  questions TEXT,                    -- JSON 数组
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  meta TEXT
);

CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  engine TEXT NOT NULL,
  text TEXT,
  citations_json TEXT,
  mode TEXT,                         -- retrieval / memory
  latency_ms INTEGER
);

CREATE TABLE IF NOT EXISTS verdicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  answer_id INTEGER NOT NULL REFERENCES answers(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL,
  matched TEXT,
  reasons_json TEXT
);

CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  total REAL, level TEXT,
  breakdown_json TEXT,
  computed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  step TEXT NOT NULL,                -- diagnose/plan/content/publish/remeasure/deliver
  title TEXT NOT NULL,
  owner TEXT,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'todo', -- todo/doing/done
  detail TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'article',  -- article/video/qa
  title TEXT NOT NULL,
  body TEXT,
  facts_json TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publishes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id INTEGER NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  url TEXT,
  account TEXT,
  status TEXT NOT NULL DEFAULT 'published',
  published_at TEXT,
  withdrawn_at TEXT
);

CREATE TABLE IF NOT EXISTS deliverables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                -- report/weekly/share
  token TEXT,
  path TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cycles_client ON cycles(client_id);
CREATE INDEX IF NOT EXISTS idx_runs_cycle ON runs(cycle_id);
CREATE INDEX IF NOT EXISTS idx_tasks_cycle ON tasks(cycle_id);
`;

export const nowIso = () => new Date().toISOString();

export function openDb(file = ':memory:') {
  const dir = path.dirname(file);
  if (file !== ':memory:') fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

/** 轻量 DAO：只暴露业务用得到的方法，避免到处写 SQL */
export class Store {
  constructor(file) {
    this.db = openDb(file);
  }

  close() {
    this.db.close();
  }

  // ---------------------------------------------------------------- clients
  upsertClient(client = {}) {
    const slug = String(client.slug ?? '').trim();
    if (!slug) throw new Error('client.slug 必填');
    const ts = nowIso();
    this.db.prepare(
      `INSERT INTO clients (slug, name, industry, city, url, contact, competitors_json, facts_json, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(slug) DO UPDATE SET
         name=excluded.name, industry=excluded.industry, city=excluded.city, url=excluded.url,
         contact=excluded.contact, competitors_json=excluded.competitors_json, facts_json=excluded.facts_json`,
    ).run(
      slug,
      String(client.name ?? slug),
      client.industry ?? null,
      client.city ?? null,
      client.url ?? null,
      client.contact ?? null,
      JSON.stringify(client.competitors ?? []),
      JSON.stringify(client.facts ?? {}),
      client.status ?? 'active',
      ts,
    );
    return this.getClient(slug);
  }

  getClient(slug) {
    const row = this.db.prepare('SELECT * FROM clients WHERE slug = ?').get(String(slug));
    return row ? mapClient(row) : null;
  }

  getClientById(id) {
    const row = this.db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(id));
    return row ? mapClient(row) : null;
  }

  listClients() {
    return this.db.prepare('SELECT * FROM clients ORDER BY id').all().map(mapClient);
  }

  // ---------------------------------------------------------------- cycles
  createCycle({ clientId, period }) {
    const ts = nowIso();
    const exist = this.db.prepare('SELECT * FROM cycles WHERE client_id = ? AND period = ?').get(Number(clientId), String(period));
    if (exist) return mapCycle(exist);
    this.db.prepare('INSERT INTO cycles (client_id, period, status, created_at) VALUES (?,?,?,?)').run(Number(clientId), String(period), 'running', ts);
    const row = this.db.prepare('SELECT * FROM cycles WHERE client_id = ? AND period = ?').get(Number(clientId), String(period));
    return mapCycle(row);
  }

  getCycle(id) {
    const row = this.db.prepare('SELECT * FROM cycles WHERE id = ?').get(Number(id));
    return row ? mapCycle(row) : null;
  }

  listCycles(clientId) {
    return this.db.prepare('SELECT * FROM cycles WHERE client_id = ? ORDER BY period DESC').all(Number(clientId)).map(mapCycle);
  }

  currentCycle(clientId, period = new Date().toISOString().slice(0, 7)) {
    return this.createCycle({ clientId, period });
  }

  // ---------------------------------------------------------------- runs / answers / verdicts
  createRun({ cycleId, engine, questions }) {
    const result = this.db.prepare('INSERT INTO runs (cycle_id, engine, questions, started_at, status) VALUES (?,?,?,?,?)').run(
      Number(cycleId), String(engine), JSON.stringify(questions ?? []), nowIso(), 'running',
    );
    return Number(result.lastInsertRowid);
  }

  finishRun(runId, status = 'done') {
    this.db.prepare('UPDATE runs SET status = ?, finished_at = ? WHERE id = ?').run(status, nowIso(), Number(runId));
  }

  saveAnswer({ runId, question, engine, text, citations = [], mode = 'memory', latencyMs = 0, verdict = 'not_mentioned', matched = '', reasons = [] }) {
    const result = this.db.prepare('INSERT INTO answers (run_id, question, engine, text, citations_json, mode, latency_ms) VALUES (?,?,?,?,?,?,?)').run(
      Number(runId), String(question), String(engine), String(text ?? ''), JSON.stringify(citations), mode, Number(latencyMs) || 0,
    );
    const answerId = Number(result.lastInsertRowid);
    this.db.prepare('INSERT INTO verdicts (answer_id, verdict, matched, reasons_json) VALUES (?,?,?,?)').run(
      answerId, String(verdict), String(matched ?? ''), JSON.stringify(reasons ?? []),
    );
    return answerId;
  }

  listRunRows(runId) {
    return this.db.prepare(
      `SELECT a.*, v.verdict, v.matched, v.reasons_json
         FROM answers a LEFT JOIN verdicts v ON v.answer_id = a.id
        WHERE a.run_id = ? ORDER BY a.id`,
    ).all(Number(runId)).map((row) => ({
      question: row.question,
      engine: row.engine,
      text: row.text,
      citations: parseJson(row.citations_json, []),
      mode: row.mode,
      latencyMs: row.latency_ms,
      verdict: row.verdict ?? 'unknown',
      matched: row.matched ?? '',
      reasons: parseJson(row.reasons_json, []),
    }));
  }

  listRuns(cycleId) {
    return this.db.prepare('SELECT * FROM runs WHERE cycle_id = ? ORDER BY id').all(Number(cycleId)).map((row) => ({
      id: Number(row.id),
      engine: row.engine,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      questions: parseJson(row.questions, []),
    }));
  }

  // ---------------------------------------------------------------- scores
  saveScore({ cycleId, total, level, breakdown }) {
    this.db.prepare('INSERT INTO scores (cycle_id, total, level, breakdown_json, computed_at) VALUES (?,?,?,?,?)').run(
      Number(cycleId), total === null ? null : Number(total), level ?? null, JSON.stringify(breakdown ?? {}), nowIso(),
    );
  }

  latestScore(cycleId) {
    const row = this.db.prepare('SELECT * FROM scores WHERE cycle_id = ? ORDER BY id DESC LIMIT 1').get(Number(cycleId));
    if (!row) return null;
    return { total: row.total === null ? null : Number(row.total), level: row.level, breakdown: parseJson(row.breakdown_json, {}) };
  }

  // ---------------------------------------------------------------- tasks
  seedTasks(cycleId, tasks = []) {
    const insert = this.db.prepare('INSERT INTO tasks (cycle_id, step, title, owner, due_at, status, detail, sort) VALUES (?,?,?,?,?,?,?,?)');
    tasks.forEach((task, index) => {
      insert.run(Number(cycleId), task.step, task.title, task.owner ?? null, task.dueAt ?? null, task.status ?? 'todo', task.detail ?? null, index);
    });
  }

  listTasks(cycleId) {
    return this.db.prepare('SELECT * FROM tasks WHERE cycle_id = ? ORDER BY sort, id').all(Number(cycleId)).map((row) => ({
      id: Number(row.id),
      step: row.step,
      title: row.title,
      owner: row.owner,
      dueAt: row.due_at,
      status: row.status,
      detail: row.detail,
    }));
  }

  setTaskStatus(taskId, status) {
    return this.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(String(status), Number(taskId)).changes > 0;
  }

  // ---------------------------------------------------------------- contents / publishes
  createContent({ cycleId, kind = 'article', title, body = '', facts = {} }) {
    const result = this.db.prepare('INSERT INTO contents (cycle_id, kind, title, body, facts_json, status, created_at) VALUES (?,?,?,?,?,?,?)').run(
      Number(cycleId), kind, String(title), String(body), JSON.stringify(facts), 'draft', nowIso(),
    );
    return Number(result.lastInsertRowid);
  }

  listContents(cycleId) {
    return this.db.prepare('SELECT * FROM contents WHERE cycle_id = ? ORDER BY id').all(Number(cycleId)).map((row) => ({
      id: Number(row.id), kind: row.kind, title: row.title, body: row.body, status: row.status, createdAt: row.created_at,
    }));
  }

  addPublish({ contentId, channel, url = null, account = null }) {
    const result = this.db.prepare('INSERT INTO publishes (content_id, channel, url, account, status, published_at) VALUES (?,?,?,?,?,?)').run(
      Number(contentId), String(channel), url, account, 'published', nowIso(),
    );
    return Number(result.lastInsertRowid);
  }

  listPublishes(cycleId) {
    return this.db.prepare(
      `SELECT p.*, c.title FROM publishes p JOIN contents c ON c.id = p.content_id WHERE c.cycle_id = ? ORDER BY p.id DESC`,
    ).all(Number(cycleId)).map((row) => ({
      id: Number(row.id), contentId: Number(row.content_id), channel: row.channel, url: row.url, account: row.account,
      status: row.withdrawn_at ? 'withdrawn' : row.status, publishedAt: row.published_at, title: row.title,
    }));
  }

  // ---------------------------------------------------------------- deliverables
  addDeliverable({ cycleId, kind, token = null, path = null, expiresAt = null }) {
    const result = this.db.prepare('INSERT INTO deliverables (cycle_id, kind, token, path, created_at, expires_at) VALUES (?,?,?,?,?,?)').run(
      Number(cycleId), kind, token, path, nowIso(), expiresAt,
    );
    return Number(result.lastInsertRowid);
  }

  getDeliverableByToken(token) {
    const row = this.db.prepare('SELECT * FROM deliverables WHERE token = ?').get(String(token ?? ''));
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
    return { id: Number(row.id), cycleId: Number(row.cycle_id), kind: row.kind, token: row.token, path: row.path, createdAt: row.created_at, expiresAt: row.expires_at };
  }

  // ---------------------------------------------------------------- settings / auth
  getSetting(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(String(key));
    return row ? row.value : fallback;
  }

  setSetting(key, value) {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(String(key), String(value));
  }

  createUser({ username, passHash, role = 'admin' }) {
    try {
      this.db.prepare('INSERT INTO users (username, pass_hash, role, created_at) VALUES (?,?,?,?)').run(String(username), String(passHash), role, nowIso());
    } catch (error) {
      if (String(error?.message ?? '').includes('UNIQUE')) throw new Error(`用户「${username}」已存在`);
      throw error;
    }
    return this.getUser(username);
  }

  getUser(username) {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? ''));
    return row ? { id: Number(row.id), username: row.username, passHash: row.pass_hash, role: row.role, active: Number(row.active) === 1 } : null;
  }

  createSession({ token, username, days = 7 }) {
    const expires = new Date(Date.now() + days * 86400000).toISOString();
    this.db.prepare('INSERT INTO sessions (token, username, expires_at) VALUES (?,?,?)').run(String(token), String(username), expires);
    return expires;
  }

  getSession(token) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE token = ?').get(String(token ?? ''));
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.db.prepare('DELETE FROM sessions WHERE token = ?').run(String(token));
      return null;
    }
    return { token: row.token, username: row.username };
  }

  deleteSession(token) {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(String(token ?? ''));
  }
}

function mapClient(row) {
  return {
    id: Number(row.id), slug: row.slug, name: row.name, industry: row.industry, city: row.city, url: row.url,
    contact: row.contact, competitors: parseJson(row.competitors_json, []), facts: parseJson(row.facts_json, {}),
    status: row.status, createdAt: row.created_at,
  };
}

function mapCycle(row) {
  return { id: Number(row.id), clientId: Number(row.client_id), period: row.period, status: row.status, createdAt: row.created_at };
}

function parseJson(text, fallback) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}
