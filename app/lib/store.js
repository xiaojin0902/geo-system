// 恒野 GEO 自研版 · SQLite 存储层
// 契约见 SPEC.md §2 / §3.2：完整 schema + DAO，方法签名固定；JSON 字段序列化，时间一律 ISO，不做业务判断。
// 说明：node:sqlite 在 Node 22 仍标记 Experimental（启动时会打印无害的 ExperimentalWarning）。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dbPath } from './config.js';

/** 表结构（SPEC §2）。所有表 IF NOT EXISTS，可重复调用；子表外键级联删除，PRAGMA foreign_keys=ON 生效。 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS brands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT,
  legal_name TEXT,
  aliases_json TEXT,
  rejected_json TEXT,
  city TEXT,
  scope TEXT,
  industry TEXT,
  competitors_json TEXT,
  services_json TEXT,
  urls_json TEXT,
  created_at TEXT NOT NULL,
  -- 以下为 SPEC §4 品牌配置里 judge / brief / report 需要用到的字段（SPEC §2 只列了最小集），
  -- 统一落在这里，保证 getBrand() 能完整回传，不丢信息。
  ambiguous_aliases_json TEXT,
  target_customers_json TEXT,
  price_range TEXT,
  differentiators_json TEXT,
  evidence_facts_json TEXT,
  content_rules_json TEXT,
  contact_json TEXT,
  -- 实体消歧与同名实体识别（真实数据驱动，2026-10-26 追加）
  disambiguation_json TEXT,
  same_name_hints_json TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  intent TEXT,
  tier TEXT,
  priority TEXT,
  source TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (brand_id, text)
);
CREATE INDEX IF NOT EXISTS idx_questions_brand_priority ON questions(brand_id, priority, id);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'live',
  engine_set TEXT,
  planned_n INTEGER,
  ok_n INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_brand ON runs(brand_id, id);

CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  engine TEXT NOT NULL,
  answer_text TEXT,
  citations_json TEXT,
  -- 引擎把问题改写成的检索词（query fan-out），JSON 字符串数组
  search_queries_json TEXT,
  status TEXT,
  latency_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_answers_run ON answers(run_id);
CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id);

CREATE TABLE IF NOT EXISTS judgments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  answer_id INTEGER NOT NULL UNIQUE REFERENCES answers(id) ON DELETE CASCADE,
  verdict TEXT,
  matched_text TEXT,
  method TEXT,
  confidence REAL,
  reasons_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  layers_json TEXT,
  total REAL,
  level TEXT,
  coverage_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  cluster TEXT,
  intent TEXT,
  difficulty INTEGER,
  priority TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (brand_id, term)
);
CREATE INDEX IF NOT EXISTS idx_keywords_brand ON keywords(brand_id);

CREATE TABLE IF NOT EXISTS contents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  keyword_id INTEGER REFERENCES keywords(id) ON DELETE SET NULL,
  question_id INTEGER REFERENCES questions(id) ON DELETE SET NULL,
  title TEXT,
  format TEXT,
  status TEXT,
  brief_json TEXT,
  body_md TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contents_brand ON contents(brand_id);

CREATE TABLE IF NOT EXISTS publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id INTEGER NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
  channel TEXT,
  url TEXT,
  status TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publications_content ON publications(content_id);

CREATE TABLE IF NOT EXISTS monitoring (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
  engine TEXT,
  verdict TEXT,
  checked_at TEXT NOT NULL,
  run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_monitoring_brand_time ON monitoring(brand_id, checked_at);
`;

/** 枚举（仅作为文档字符串导出；写入前不做业务校验） */
export const ENUMS = Object.freeze({
  runKind: ['demo', 'live'],
  answerStatus: ['ok', 'engine_error', 'refused', 'unavailable'],
  verdict: [
    'recommended',
    'conditionally_recommended',
    'candidate',
    'listed',
    'mentioned',
    'not_mentioned',
    'ambiguous',
    'unknown',
    'refused',
    'engine_error',
  ],
  scoreLevel: ['领先', '良好', '中等', '偏弱', '落后', '隐形', '样本不足'],
});

function nowIso() {
  return new Date().toISOString();
}

function jsonText(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function parseJson(text, fallback) {
  if (text === undefined || text === null || text === '') return fallback;
  try {
    const value = JSON.parse(text);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapBrand(row) {
  return {
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    legalName: row.legal_name,
    aliases: parseJson(row.aliases_json, []),
    rejectedNames: parseJson(row.rejected_json, []),
    ambiguousAliases: parseJson(row.ambiguous_aliases_json, []),
    city: row.city,
    scope: row.scope,
    industry: row.industry,
    services: parseJson(row.services_json, []),
    targetCustomers: parseJson(row.target_customers_json, []),
    priceRange: row.price_range,
    competitors: parseJson(row.competitors_json, []),
    urls: parseJson(row.urls_json, []),
    differentiators: parseJson(row.differentiators_json, []),
    evidenceFacts: parseJson(row.evidence_facts_json, []),
    contentRules: parseJson(row.content_rules_json, {}),
    disambiguation: parseJson(row.disambiguation_json, null),
    sameNameDomainHints: parseJson(row.same_name_hints_json, []),
    contact: parseJson(row.contact_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapQuestion(row) {
  return {
    id: Number(row.id),
    brandId: Number(row.brand_id),
    text: row.text,
    intent: row.intent,
    tier: row.tier,
    priority: row.priority,
    source: row.source,
    createdAt: row.created_at,
  };
}

function mapRun(row) {
  return {
    id: Number(row.id),
    brandId: Number(row.brand_id),
    kind: row.kind,
    engineSet: row.engine_set,
    plannedN: row.planned_n === null ? null : Number(row.planned_n),
    okN: row.ok_n === null ? null : Number(row.ok_n),
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapScore(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    layers: parseJson(row.layers_json, {}),
    total: row.total === null ? null : Number(row.total),
    level: row.level,
    coverage: parseJson(row.coverage_json, {}),
    createdAt: row.created_at,
  };
}

function mapKeyword(row) {
  return {
    id: Number(row.id),
    brandId: Number(row.brand_id),
    term: row.term,
    cluster: row.cluster,
    intent: row.intent,
    difficulty: row.difficulty === null ? null : Number(row.difficulty),
    priority: row.priority,
    note: row.note,
    createdAt: row.created_at,
  };
}

function mapContent(row) {
  return {
    id: Number(row.id),
    brandId: Number(row.brand_id),
    keywordId: row.keyword_id === null ? null : Number(row.keyword_id),
    questionId: row.question_id === null ? null : Number(row.question_id),
    title: row.title,
    format: row.format,
    status: row.status,
    brief: parseJson(row.brief_json, null),
    bodyMd: row.body_md,
    createdAt: row.created_at,
  };
}

export class Store {
  #statements = new Map();

  constructor(file = dbPath()) {
    const target = String(file ?? ':memory:');
    const isMemory = target === ':memory:';
    this.path = isMemory ? target : path.resolve(target);
    if (!isMemory) {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
    }
    this.db = new DatabaseSync(this.path);
    // 并发友好：WAL + 外键强制 + 忙等待
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.initSchema();
  }

  /** 建表（幂等）。openStore 内部已自动调用。 */
  initSchema() {
    this.db.exec(SCHEMA_SQL);
    this.#migrate();
  }

  /**
   * 轻量迁移：只做「加列」这类幂等操作，不动的数据。
   * node:sqlite 没有迁移框架，这里用 PRAGMA 判断列是否存在，避免老库直接报错。
   */
  #migrate() {
    const addColumn = (table, column, ddl) => {
      try {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
        if (!columns.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      } catch {
        /* 迁移失败不阻断主流程：新列只是可选能力 */
      }
    };
    addColumn('answers', 'search_queries_json', 'search_queries_json TEXT');
    addColumn('brands', 'disambiguation_json', 'disambiguation_json TEXT');
    addColumn('brands', 'same_name_hints_json', 'same_name_hints_json TEXT');
  }

  close() {
    this.#statements.clear();
    this.db.close();
  }

  /** 预编译语句缓存：所有 DAO 都走 prepared statements。 */
  #stmt(sql) {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  #tx(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 回滚失败时不掩盖原始错误 */
      }
      throw error;
    }
  }

  #brandById(id) {
    if (id === undefined || id === null) return null;
    const row = this.#stmt('SELECT * FROM brands WHERE id = ?').get(Number(id));
    return row ? mapBrand(row) : null;
  }

  // ------------------------------------------------------------------ brands

  /** 写入或更新品牌，返回 brandId（slug 唯一）。 */
  upsertBrand(brand = {}) {
    const slug = String(brand.slug ?? '').trim();
    if (!slug) throw new Error('品牌数据缺少 slug，无法写入 brands 表');
    const ts = nowIso();
    this.#stmt(
      `INSERT INTO brands (
         slug, name, legal_name, aliases_json, rejected_json, city, scope, industry,
         competitors_json, services_json, urls_json, created_at,
         ambiguous_aliases_json, target_customers_json, price_range,
         differentiators_json, evidence_facts_json, content_rules_json, contact_json,
         disambiguation_json, same_name_hints_json, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(slug) DO UPDATE SET
         name = excluded.name,
         legal_name = excluded.legal_name,
         aliases_json = excluded.aliases_json,
         rejected_json = excluded.rejected_json,
         city = excluded.city,
         scope = excluded.scope,
         industry = excluded.industry,
         competitors_json = excluded.competitors_json,
         services_json = excluded.services_json,
         urls_json = excluded.urls_json,
         ambiguous_aliases_json = excluded.ambiguous_aliases_json,
         target_customers_json = excluded.target_customers_json,
         price_range = excluded.price_range,
         differentiators_json = excluded.differentiators_json,
         evidence_facts_json = excluded.evidence_facts_json,
         content_rules_json = excluded.content_rules_json,
         contact_json = excluded.contact_json,
         disambiguation_json = excluded.disambiguation_json,
         same_name_hints_json = excluded.same_name_hints_json,
         updated_at = excluded.updated_at`,
    ).run(
      slug,
      brand.name ?? null,
      brand.legalName ?? null,
      jsonText(brand.aliases),
      jsonText(brand.rejectedNames),
      brand.city ?? null,
      brand.scope ?? null,
      brand.industry ?? null,
      jsonText(brand.competitors),
      jsonText(brand.services),
      jsonText(brand.urls),
      ts,
      jsonText(brand.ambiguousAliases),
      jsonText(brand.targetCustomers),
      brand.priceRange ?? null,
      jsonText(brand.differentiators),
      jsonText(brand.evidenceFacts),
      jsonText(brand.contentRules),
      jsonText(brand.contact),
      jsonText(brand.disambiguation),
      jsonText(brand.sameNameDomainHints),
      ts,
    );
    const row = this.#stmt('SELECT id FROM brands WHERE slug = ?').get(slug);
    return Number(row.id);
  }

  /** 按 slug 取品牌（aliases/rejected/competitors/services/urls 等已反序列化）。 */
  getBrand(slug) {
    const row = this.#stmt('SELECT * FROM brands WHERE slug = ?').get(String(slug ?? ''));
    return row ? mapBrand(row) : null;
  }

  listBrands() {
    return this.#stmt('SELECT * FROM brands ORDER BY id ASC').all().map(mapBrand);
  }

  // --------------------------------------------------------------- questions

  /** 批量写种子题目，按 (brand_id, text) 去重；返回本次新增条数。 */
  seedQuestions(brandId, questions = []) {
    const insert = this.#stmt(
      'INSERT OR IGNORE INTO questions (brand_id, text, intent, tier, priority, source, created_at) VALUES (?,?,?,?,?,?,?)',
    );
    let inserted = 0;
    this.#tx(() => {
      for (const question of questions) {
        if (!question || typeof question.text !== 'string') continue;
        const text = question.text.trim();
        if (!text) continue;
        const result = insert.run(
          Number(brandId),
          text,
          question.intent ?? null,
          question.tier ?? null,
          question.priority ?? null,
          question.source ?? null,
          nowIso(),
        );
        inserted += Number(result.changes) || 0;
      }
    });
    return inserted;
  }

  /** 题目列表，默认按 P0→P1→P2、id 升序。 */
  listQuestions(brandId, { priority } = {}) {
    const filtered = priority !== undefined && priority !== null && priority !== '';
    const sql = filtered
      ? 'SELECT * FROM questions WHERE brand_id = ? AND priority = ? ORDER BY priority ASC, id ASC'
      : 'SELECT * FROM questions WHERE brand_id = ? ORDER BY priority ASC, id ASC';
    const rows = filtered
      ? this.#stmt(sql).all(Number(brandId), String(priority))
      : this.#stmt(sql).all(Number(brandId));
    return rows.map(mapQuestion);
  }

  // ------------------------------------------------------------------- runs

  createRun({ brandId, kind = 'live', engineSet = '', plannedN = 0 } = {}) {
    const result = this.#stmt(
      "INSERT INTO runs (brand_id, kind, engine_set, planned_n, ok_n, status, started_at) VALUES (?,?,?,?,0,'running',?)",
    ).run(Number(brandId), String(kind), String(engineSet ?? ''), Number(plannedN) || 0, nowIso());
    return Number(result.lastInsertRowid);
  }

  finishRun(runId, { status = 'done', okN = 0 } = {}) {
    this.#stmt('UPDATE runs SET status = ?, ok_n = ?, finished_at = ? WHERE id = ?').run(
      String(status),
      Number(okN) || 0,
      nowIso(),
      Number(runId),
    );
  }

  getRun(runId) {
    const row = this.#stmt('SELECT * FROM runs WHERE id = ?').get(Number(runId));
    return row ? mapRun(row) : null;
  }

  listRuns(brandId, limit = 20) {
    const rows = this.#stmt('SELECT * FROM runs WHERE brand_id = ? ORDER BY id DESC LIMIT ?').all(
      Number(brandId),
      Math.max(1, Number(limit) || 20),
    );
    return rows.map(mapRun);
  }

  // ---------------------------------------------------------------- answers

  saveAnswer({
    runId,
    questionId,
    engine,
    text = '',
    citations = [],
    searchQueries = [],
    status = 'ok',
    latencyMs = 0,
  } = {}) {
    const result = this.#stmt(
      'INSERT INTO answers (run_id, question_id, engine, answer_text, citations_json, search_queries_json, status, latency_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(
      Number(runId),
      Number(questionId),
      String(engine),
      text ?? '',
      jsonText(Array.isArray(citations) ? citations : []),
      jsonText(Array.isArray(searchQueries) ? searchQueries : []),
      String(status),
      numberOrNull(latencyMs) ?? 0,
      nowIso(),
    );
    return Number(result.lastInsertRowid);
  }

  saveJudgment(answerId, judgment = {}) {
    this.#stmt(
      `INSERT INTO judgments (answer_id, verdict, matched_text, method, confidence, reasons_json, created_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(answer_id) DO UPDATE SET
         verdict = excluded.verdict,
         matched_text = excluded.matched_text,
         method = excluded.method,
         confidence = excluded.confidence,
         reasons_json = excluded.reasons_json,
         created_at = excluded.created_at`,
    ).run(
      Number(answerId),
      String(judgment.verdict ?? 'unknown'),
      judgment.matchedText ?? null,
      judgment.method ?? null,
      numberOrNull(judgment.confidence) ?? 0,
      jsonText(Array.isArray(judgment.reasons) ? judgment.reasons : []),
      nowIso(),
    );
  }

  // ----------------------------------------------------------------- scores

  saveScore(runId, score = {}) {
    this.#stmt(
      `INSERT INTO scores (run_id, layers_json, total, level, coverage_json, created_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(run_id) DO UPDATE SET
         layers_json = excluded.layers_json,
         total = excluded.total,
         level = excluded.level,
         coverage_json = excluded.coverage_json,
         created_at = excluded.created_at`,
    ).run(
      Number(runId),
      jsonText(score.layers ?? {}),
      numberOrNull(score.total),
      String(score.level ?? '样本不足'),
      jsonText(score.coverage ?? {}),
      nowIso(),
    );
  }

  /** 读取某轮评分（SPEC 之外补的只读 DAO，供 report 重建/监测对比使用）。 */
  getScore(runId) {
    const row = this.#stmt('SELECT * FROM scores WHERE run_id = ?').get(Number(runId));
    return mapScore(row);
  }

  /** 某轮详情：{run, brand, rows:[{question, answer, judgment}]}；run 不存在返回 null。 */
  getRunDetail(runId) {
    const run = this.getRun(runId);
    if (!run) return null;
    const brand = this.#brandById(run.brandId);
    const rows = this.#stmt(
      `SELECT
         q.id AS q_id, q.text AS q_text, q.intent AS q_intent, q.tier AS q_tier,
         q.priority AS q_priority, q.source AS q_source,
         a.id AS a_id, a.engine AS a_engine, a.answer_text AS a_text, a.citations_json AS a_citations, a.search_queries_json AS a_search_queries,
         a.status AS a_status, a.latency_ms AS a_latency, a.created_at AS a_created,
         j.verdict AS j_verdict, j.matched_text AS j_matched, j.method AS j_method,
         j.confidence AS j_confidence, j.reasons_json AS j_reasons, j.created_at AS j_created
       FROM answers a
       JOIN questions q ON q.id = a.question_id
       LEFT JOIN judgments j ON j.answer_id = a.id
       WHERE a.run_id = ?
       ORDER BY q.priority ASC, q.id ASC, a.engine ASC`,
    ).all(Number(runId));
    return {
      run,
      brand,
      rows: rows.map((row) => ({
        question: {
          id: Number(row.q_id),
          brandId: run.brandId,
          text: row.q_text,
          intent: row.q_intent,
          tier: row.q_tier,
          priority: row.q_priority,
          source: row.q_source,
        },
        answer: {
          id: Number(row.a_id),
          runId: run.id,
          questionId: Number(row.q_id),
          engine: row.a_engine,
          text: row.a_text,
          citations: parseJson(row.a_citations, []),
          searchQueries: parseJson(row.a_search_queries, []),
          status: row.a_status,
          latencyMs: row.a_latency === null ? null : Number(row.a_latency),
          createdAt: row.a_created,
        },
        judgment:
          row.j_verdict === null
            ? null
            : {
                answerId: Number(row.a_id),
                verdict: row.j_verdict,
                matchedText: row.j_matched,
                method: row.j_method,
                confidence: row.j_confidence === null ? null : Number(row.j_confidence),
                reasons: parseJson(row.j_reasons, []),
                createdAt: row.j_created,
              },
      })),
    };
  }

  // --------------------------------------------------------------- keywords

  /** 写入或更新关键词（brand_id + term 唯一），返回 id。 */
  upsertKeyword(brandId, keyword = {}) {
    const term = String(keyword.term ?? '').trim();
    if (!term) throw new Error('关键词数据缺少 term，无法写入 keywords 表');
    this.#stmt(
      `INSERT INTO keywords (brand_id, term, cluster, intent, difficulty, priority, note, created_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(brand_id, term) DO UPDATE SET
         cluster = excluded.cluster,
         intent = excluded.intent,
         difficulty = excluded.difficulty,
         priority = excluded.priority,
         note = excluded.note`,
    ).run(
      Number(brandId),
      term,
      keyword.cluster ?? null,
      keyword.intent ?? null,
      numberOrNull(keyword.difficulty),
      keyword.priority ?? null,
      keyword.note ?? null,
      nowIso(),
    );
    const row = this.#stmt('SELECT id FROM keywords WHERE brand_id = ? AND term = ?').get(Number(brandId), term);
    return Number(row.id);
  }

  listKeywords(brandId, { priority } = {}) {
    const filtered = priority !== undefined && priority !== null && priority !== '';
    const sql = filtered
      ? 'SELECT * FROM keywords WHERE brand_id = ? AND priority = ? ORDER BY priority ASC, difficulty DESC, id ASC'
      : 'SELECT * FROM keywords WHERE brand_id = ? ORDER BY priority ASC, difficulty DESC, id ASC';
    const rows = filtered
      ? this.#stmt(sql).all(Number(brandId), String(priority))
      : this.#stmt(sql).all(Number(brandId));
    return rows.map(mapKeyword);
  }

  // --------------------------------------------------------------- contents

  createContent({
    brandId,
    keywordId = null,
    questionId = null,
    title = null,
    format = null,
    status = 'draft',
    brief = null,
    bodyMd = null,
  } = {}) {
    const result = this.#stmt(
      'INSERT INTO contents (brand_id, keyword_id, question_id, title, format, status, brief_json, body_md, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(
      Number(brandId),
      keywordId === null || keywordId === undefined ? null : Number(keywordId),
      questionId === null || questionId === undefined ? null : Number(questionId),
      title,
      format,
      String(status ?? 'draft'),
      jsonText(brief),
      bodyMd,
      nowIso(),
    );
    return Number(result.lastInsertRowid);
  }

  listContents(brandId) {
    return this.#stmt('SELECT * FROM contents WHERE brand_id = ? ORDER BY id DESC').all(Number(brandId)).map(mapContent);
  }

  updateContentStatus(id, status) {
    this.#stmt('UPDATE contents SET status = ? WHERE id = ?').run(String(status), Number(id));
  }

  // ----------------------------------------------------------- publications

  /** 某品牌全部发布记录（含内容标题，供分发矩阵页使用） */
  listPublications(brandId) {
    return this.#stmt(
      `SELECT p.id, p.content_id, p.channel, p.url, p.status, p.created_at, c.title
         FROM publications p
         JOIN contents c ON c.id = p.content_id
        WHERE c.brand_id = ?
        ORDER BY p.id DESC`,
    ).all(Number(brandId)).map((row) => ({
      id: Number(row.id),
      contentId: Number(row.content_id),
      channel: row.channel,
      url: row.url,
      status: row.status,
      createdAt: row.created_at,
      title: row.title,
    }));
  }

  createPublication({ contentId, channel, url = null, status = 'dry_run' } = {}) {
    const result = this.#stmt(
      'INSERT INTO publications (content_id, channel, url, status, created_at) VALUES (?,?,?,?,?)',
    ).run(Number(contentId), channel ?? null, url ?? null, String(status ?? 'dry_run'), nowIso());
    return Number(result.lastInsertRowid);
  }

  // -------------------------------------------------------------- monitoring

  saveMonitoringCheck({ brandId, questionId = null, engine, verdict, runId = null, checkedAt } = {}) {
    const result = this.#stmt(
      'INSERT INTO monitoring (brand_id, question_id, engine, verdict, checked_at, run_id) VALUES (?,?,?,?,?,?)',
    ).run(
      Number(brandId),
      questionId === null || questionId === undefined ? null : Number(questionId),
      engine ?? null,
      verdict ?? null,
      checkedAt ?? nowIso(),
      runId === null || runId === undefined ? null : Number(runId),
    );
    return Number(result.lastInsertRowid);
  }

  /** 监测趋势：按 (题目, 引擎) 聚合近 days 天记录，顺序稳定（题目文本、引擎）。 */
  monitoringTrend(brandId, days = 30) {
    const span = Math.max(1, Number(days) || 30);
    const cutoff = new Date(Date.now() - span * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.#stmt(
      `SELECT m.question_id, q.text AS question_text, m.engine, m.verdict, m.checked_at
       FROM monitoring m
       LEFT JOIN questions q ON q.id = m.question_id
       WHERE m.brand_id = ? AND m.checked_at >= ?
       ORDER BY q.text ASC, m.engine ASC, m.checked_at ASC`,
    ).all(Number(brandId), cutoff);
    const groups = new Map();
    for (const row of rows) {
      const questionId = row.question_id === null ? null : Number(row.question_id);
      const key = `${questionId ?? 'null'}::${row.engine ?? ''}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          questionId,
          questionText: row.question_text ?? '',
          engine: row.engine ?? '',
          checks: [],
        };
        groups.set(key, group);
      }
      group.checks.push({ checkedAt: row.checked_at, verdict: row.verdict });
    }
    return [...groups.values()];
  }
}

/** 打开数据库（默认 app/data/geo.db），自动建表。 */
export function openStore(file = dbPath()) {
  return new Store(file);
}
