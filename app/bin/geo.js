#!/usr/bin/env node
// 恒野 GEO 自研版 · 命令行入口（SPEC §3.9）
// 只做编排：读配置 → 调 lib/* 模块 → 落 SQLite → 渲染报告 → 打印中文结果。
// 其它成员负责的模块用动态 import 加载；未就绪时给出明确中文提示，绝不静默失败。
// 退出码约定：成功 0；失败 1（process.exitCode = 1）。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { APP_ROOT, DATA_DIR, brandPath, dbPath, loadEnv } from '../lib/config.js';
import { openStore } from '../lib/store.js';

const HELP = `
恒野 GEO 自研版 · 命令行（node bin/geo.js）

用法：node bin/geo.js <命令> [选项]

命令：
  init       建表 + 写入品牌（brands/<slug>.json）与种子题目
  diagnose   跑一轮 AI 可见性诊断：采集 → 判定 → 评分 → 报告
  keywords   挖掘关键词簇并写入 keywords 表
  brief      生成内容 brief（必须引用的事实 + 禁用词 + 大纲）
  write      按 brief 生成草稿（无 key 用模板模式）+ 事实核查
  publish    登记发布记录（默认 dry_run，不真实发稿）
  monitor    复跑题目做效果监测，并与上一轮对比
  report     按 run 重建 Markdown / HTML 报告
  runs       列出该品牌的历史运行
  insights   可见度分析：引用源 / 竞品份额 / 曝光质量 / 情感
  aeo        生成 AEO 资产：llms.txt / robots.txt / JSON-LD（可直接放上服务器）
  quote      报价：关键词价值评分 → 篇数 × 单价 → 成本与毛利
  plan       生成 Top10 行动 + 30 天计划（默认最近一轮）
  questions  自动出题：按三层六意图生成用户会问 AI 的问题
  schedule   生成定时任务配置（crontab / launchd），把诊断与监测自动化
  rejudge    用最新判定规则离线重判某一轮（不重新采集，不花钱）
  video      把内容转成短视频脚本（口播/分镜/标题/话题/合规）
  seo        传统 SEO + 短视频 SEO 体检（对标摘星AI 三位一体）
  distribute 内容矩阵分发：把内容批量投到多个渠道（dry_run / 真实 API）
  share      客户分享链接：生成只读报告链接（可设到期，可吊销）
  weekly     生成客户周报（对比上一轮），可推送到 webhook
  demo       端到端闭环验收：建库→出题→诊断→分析→行动→关键词→brief→写稿→发布→监测
  serve      启动本地网页控制台（跑诊断 / 看报告 / 问题库 / 官网体检）
  doctor     环境自检：还差什么才能跑真实数据
  audit      官网 AI 可抓取性体检（robots / 爬虫可达 / llms.txt / JSON-LD）

公共选项：
  --brand <slug>      品牌标识，默认 hengye
  --json              以 JSON 输出（diagnose / keywords / brief / write / publish / monitor / report / runs）
  --help, -h          显示本说明

各命令：
  node bin/geo.js init --brand hengye
  node bin/geo.js diagnose --brand hengye [--engines mock|live|all|deepseek,dashscope] [--limit 30] [--priority P0] [--json]
  node bin/geo.js keywords --brand hengye [--json]
  node bin/geo.js brief --brand hengye --keyword <term> [--question <id>] [--out <file>] [--json]
  node bin/geo.js write --brand hengye --content <id> [--engines deepseek|dashscope|none] [--json]
  node bin/geo.js publish --brand hengye --content <id> --channel <渠道名> [--url <url>] [--status dry_run|published] [--json]
  node bin/geo.js monitor --brand hengye [--engines mock|live] [--limit 10] [--json]
  node bin/geo.js report --run <id> [--out <目录>] [--json]
  node bin/geo.js runs --brand hengye [--limit 20] [--json]
  node bin/geo.js insights [--run <id>] [--json]
  node bin/geo.js aeo [--out <目录>] [--base-url <站点根>] [--json]
  node bin/geo.js quote --keywords "词1:难度,词2" [--band lite|standard|deep] [--tax 0.06] [--json]
  node bin/geo.js plan [--run <id>] [--json]
  node bin/geo.js questions [--generate] [--count 24] [--seed 1] [--write] [--json]
  node bin/geo.js schedule [--engines live] [--limit 20] [--json] [--write]
  node bin/geo.js video --content <id> [--style 口播科普] [--duration 60] [--json]
  node bin/geo.js seo --url <网址> [--keyword <词>] [--json]
  node bin/geo.js distribute --content <id> [--channels 知乎,头条] [--all] [--live] [--json]
  node bin/geo.js share --run <id> [--days 30] [--base https://你的域名] [--json]
  node bin/geo.js share --list | --revoke <token>
  node bin/geo.js weekly --brand hengye [--push <webhook>] [--json]
  node bin/geo.js demo [--brand hengye] [--limit 12] [--questions 24] [--json]
  node bin/geo.js rejudge --run <id> [--json]
  node bin/geo.js serve [--port 8787] [--no-open] [--brand hengye]
  node bin/geo.js doctor [--probe] [--json]
  node bin/geo.js audit [--url https://sanrenxing.cn] [--out <file>] [--json]

说明：
  · --engines 缺省 live。没有可用 API key 时会明确提示，并建议先用 --engines mock 跑通流程。
  · write 默认尝试已配置的在线写作引擎（DeepSeek 优先，其次 dashscope）；--engines none 或没有 key 时回退模板骨架。
  · mock 是本地确定性演示引擎，报告会显著标注「DEMO 演示数据，非真实 AI 回答」，不会冒充真实采集。
  · 数据库：<app>/data/geo.db；报告：<app>/data/reports/；brief：<app>/data/briefs/；草稿：<app>/data/drafts/。
  · 测试可用环境变量 HENGYE_GEO_DATA_DIR 覆盖数据目录。
  · 命令失败时退出码为 1，并打印可操作的中文错误。
`.trimStart();

const ANSWER_STATUSES = new Set(['ok', 'engine_error', 'refused', 'unavailable']);
const VERDICT_LABELS = {
  recommended: '推荐',
  conditionally_recommended: '条件推荐',
  candidate: '候选',
  listed: '列入',
  mentioned: '仅提及',
  not_mentioned: '未提及',
  ambiguous: '歧义',
  unknown: '未知',
  refused: '拒答',
  engine_error: '引擎错误',
};
const ANSWER_STATUS_LABELS = {
  ok: '正常',
  engine_error: '引擎错误',
  refused: '被拒答',
  unavailable: '引擎不可用',
};
/** 提及程度排序（用于监测对比）。拿不准的 ambiguous/unknown 与 not_mentioned 同档。 */
const VERDICT_RANK = {
  not_mentioned: 0, ambiguous: 0, unknown: 0,
  mentioned: 1, candidate: 2, listed: 3, conditionally_recommended: 4, recommended: 5,
};
/** 可用于写作的在线引擎（DeepSeek 优先，其次 dashscope；mock 只用于采集演示） */
const WRITING_ENGINE_IDS = ['deepseek', 'dashscope'];
/** writer.js factCheckDraft 的违规类型 → 中文标签 */
const VIOLATION_LABELS = {
  banned_word: '禁用词',
  absolute: '绝对化用语',
  unsourced_number: '无来源数字',
  fabricated_case: '虚构案例',
};

/** 可操作的中文错误：message 一句话，hints 是后续建议行。 */
class CliError extends Error {
  constructor(message, hints = []) {
    super(message);
    this.name = 'CliError';
    this.hints = Array.isArray(hints) ? hints.filter(Boolean) : [hints].filter(Boolean);
  }
}

// ------------------------------------------------------------------ 基础工具

/** 手写参数解析：支持 --key value、--key=value、-h；位置参数放 positional。 */
function parseArgv(argv = []) {
  const flags = Object.create(null);
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '-h') {
      flags.help = true;
      continue;
    }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[body] = next;
        index += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }
    positional.push(token);
  }
  return { command: positional[0], flags };
}

/** 取字符串参数；true 表示用户漏写值。 */
function stringFlag(value, name) {
  if (value === undefined) return undefined;
  if (value === true) throw new CliError(`参数 --${name} 缺少值`, `示例：--${name} <值>`);
  const text = String(value).trim();
  return text || undefined;
}

/** 取正整数参数。 */
function intFlag(value, name, fallback) {
  if (value === undefined) return fallback;
  if (value === true) throw new CliError(`参数 --${name} 缺少值`, `示例：--${name} 12`);
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new CliError(`参数 --${name} 需要正整数，收到 "${value}"`, `示例：--${name} 12`);
  }
  return number;
}

function priorityFlag(value) {
  const text = stringFlag(value, 'priority');
  if (!text) return undefined;
  const normalized = text.toUpperCase();
  if (!['P0', 'P1', 'P2'].includes(normalized)) {
    throw new CliError(`--priority 只支持 P0 / P1 / P2，收到 "${value}"`);
  }
  return normalized;
}

function brandSlug(flags) {
  return stringFlag(flags.brand, 'brand') ?? 'hengye';
}

function truncate(text, max = 40) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function verdictLabel(verdict) {
  if (!verdict) return '—';
  return VERDICT_LABELS[verdict] ?? verdict;
}

function answerStatusLabel(status) {
  return ANSWER_STATUS_LABELS[status] ?? String(status ?? '—');
}

/** 覆盖率百分比：与报告（report.js fmtPct）一致，保留 1 位小数。 */
export function formatPercent(ratio) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(1)}%`;
}

function formatScore(score) {
  const coverage = formatPercent(score?.coverage?.ratio);
  if (!score || score.total === null || score.total === undefined) {
    return `样本不足（覆盖率 ${coverage}）`;
  }
  return `${score.total} 分 · 等级 ${score.level}（覆盖率 ${coverage}）`;
}

function formatDelta(delta) {
  if (typeof delta !== 'number' || !Number.isFinite(delta)) return '—';
  const rounded = Math.round(delta * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}

/** 报告模块（SPEC §3.8）按 snake_case 读取 run 字段；store 层保持 camelCase，这里做一次兼容映射。 */
function toReportRun(run) {
  if (!run) return run;
  return {
    ...run,
    planned_n: run.plannedN,
    ok_n: run.okN,
    engine_set: run.engineSet,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
  };
}

function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const pad = (value) => String(value).padStart(2, '0');
  // 库里存 UTC ISO，展示给用户时转成本机时区
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    const wide =
      code >= 0x1100 &&
      (code <= 0x115f ||
        (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x1f300 && code <= 0x1f64f));
    width += wide ? 2 : 1;
  }
  return width;
}

function padDisplay(text, width) {
  return `${text}${' '.repeat(Math.max(0, width - displayWidth(text)))}`;
}

function printTable(headers, rows) {
  const widths = headers.map((header, column) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[column] ?? ''))),
  );
  console.log(`  ${headers.map((header, index) => padDisplay(header, widths[index])).join('  ')}`);
  console.log(`  ${widths.map((width) => '─'.repeat(width)).join('  ')}`);
  for (const row of rows) {
    console.log(`  ${row.map((cell, index) => padDisplay(cell ?? '', widths[index])).join('  ')}`);
  }
}

function log(flags, ...args) {
  if (!flags.json) console.log(...args);
}

// -------------------------------------------------------------- 模块加载/存储

async function loadModule(relativePath, label, hints = []) {
  try {
    return await import(new URL(relativePath, import.meta.url).href);
  } catch (error) {
    const code = error?.code ?? '';
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new CliError(`${label}尚未就绪：${relativePath} 加载失败（${error.message}）`, hints);
    }
    throw new CliError(`${label}加载失败：${relativePath}（${error.message}）`, hints);
  }
}

async function tryLoadModule(relativePath) {
  try {
    return await import(new URL(relativePath, import.meta.url).href);
  } catch (error) {
    const code = error?.code ?? '';
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
}

async function withStore(fn) {
  const store = openStore();
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

function requireBrand(store, slug) {
  const brand = store.getBrand(slug);
  if (!brand) {
    throw new CliError(`数据库中没有品牌「${slug}」`, `请先初始化：node bin/geo.js init --brand ${slug}`);
  }
  return brand;
}

function readJsonFile(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new CliError(`找不到${label}：${file}`, '请先创建该文件后再运行。');
    }
    throw new CliError(`读取${label}失败：${file}（${error.message}）`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(`${label}不是合法 JSON：${file}（${error.message}）`);
  }
}

function selectEnginesOrFail(enginesModule, enginesSpec, slug) {
  try {
    const engines = enginesModule.selectEngines(enginesSpec, { env: process.env });
    if (!Array.isArray(engines) || engines.length === 0) {
      throw new Error('返回的引擎列表为空');
    }
    return engines;
  } catch (error) {
    throw new CliError(`无法使用引擎「${enginesSpec}」：${error.message}`, [
      '没有可用 API key 时，可以先用演示引擎把流程跑通：',
      `  node bin/geo.js diagnose --brand ${slug} --engines mock --limit 12`,
      '需要真实采集时，把 DEEPSEEK_API_KEY / DASHSCOPE_API_KEY 写进 app/.env（格式：KEY=值）。',
    ]);
  }
}

/** 一轮采集：逐题逐引擎 ask → 落 answer → 判定 → 落 judgment；返回 run 概况。 */
async function collectSamples({ store, brand, engines, questions, judge, quiet = false, onSample }) {
  const engineSet = engines.map((engine) => engine.id).join(',');
  // 只要这批引擎里含 mock，就按 demo 记录，报告顶部必须带 DEMO 横幅（SPEC §0.6）。
  const kind = engines.some((engine) => engine.id === 'mock') ? 'demo' : 'live';
  const plannedN = questions.length * engines.length;
  const runId = store.createRun({ brandId: brand.id, kind, engineSet, plannedN });
  let okN = 0;
  let done = 0;
  for (const question of questions) {
    for (const engine of engines) {
      done += 1;
      const startedAt = Date.now();
      let result;
      try {
        result = await engine.ask(question.text, { brand, timeoutMs: 60000 });
      } catch (error) {
        result = {
          text: '',
          citations: [],
          status: 'engine_error',
          error: error?.message ?? String(error),
          latencyMs: Date.now() - startedAt,
        };
      }
      const status = ANSWER_STATUSES.has(result?.status) ? result.status : 'engine_error';
      const latencyMs = Number.isFinite(Number(result?.latencyMs))
        ? Math.max(0, Math.round(Number(result.latencyMs)))
        : Date.now() - startedAt;
      const answerId = store.saveAnswer({
        runId,
        questionId: question.id,
        engine: String(engine.id),
        text: result?.text ?? '',
        citations: Array.isArray(result?.citations) ? result.citations : [],
        // query fan-out：引擎把问题改写成的检索词（有就存，没有就是空数组）
        searchQueries: Array.isArray(result?.searchQueries) ? result.searchQueries : [],
        status,
        latencyMs,
      });
      let judgment;
      try {
        judgment = judge.judgeAnswer({ text: result?.text ?? '', status, brand, engineId: engine.id });
      } catch (error) {
        judgment = {
          verdict: status === 'refused' ? 'refused' : status === 'ok' ? 'unknown' : 'engine_error',
          matchedText: null,
          method: 'fallback',
          confidence: 0,
          reasons: [`判定模块异常，按未确定处理（不计入分母）：${error?.message ?? error}`],
        };
      }
      if (!judgment || typeof judgment !== 'object' || !judgment.verdict) {
        judgment = { verdict: 'unknown', matchedText: null, method: 'fallback', confidence: 0, reasons: [] };
      }
      store.saveJudgment(answerId, judgment);
      if (status === 'ok') okN += 1;
      if (onSample) onSample({ runId, question, engine, status, judgment });
      if (!quiet) {
        const outcome = status === 'ok' ? verdictLabel(judgment.verdict) : answerStatusLabel(status);
        console.log(
          `  [${String(done).padStart(2)}/${plannedN}] ${padDisplay(String(engine.id), 9)} ${truncate(question.text, 30)} → ${outcome}`,
        );
      }
    }
  }
  store.finishRun(runId, { status: okN > 0 ? 'done' : 'failed', okN });
  return { runId, kind, okN, plannedN, engineSet };
}

/** 渲染并写入 run-<id>.md / run-<id>.html。 */
function renderAndWriteReport({ reportModule, brand, detail, score, demo, runId, outDir }) {
  const run = toReportRun(detail.run);
  const markdown = reportModule.renderReportMarkdown({ brand, run, detail, score });
  if (typeof markdown !== 'string' || !markdown.trim()) {
    throw new CliError('报告模块返回了空内容（renderReportMarkdown）', '请检查 lib/report.js 的实现。');
  }
  const title = `${brand.name} GEO 诊断报告 · Run #${runId}`;
  const subtitle = `${brand.legalName ?? brand.name} · ${demo ? 'DEMO 演示数据' : '真实采集'} · ${String(
    detail.run.startedAt ?? '',
  ).slice(0, 10)}`;
  const html = reportModule.renderReportHtml(markdown, { title, subtitle, demo });
  if (typeof html !== 'string' || !html.trim()) {
    throw new CliError('报告模块返回了空 HTML（renderReportHtml）', '请检查 lib/report.js 的实现。');
  }
  const dir = outDir ?? path.join(DATA_DIR, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const mdPath = path.join(dir, `run-${runId}.md`);
  const htmlPath = path.join(dir, `run-${runId}.html`);
  fs.writeFileSync(mdPath, markdown, 'utf8');
  fs.writeFileSync(htmlPath, html, 'utf8');
  return { mdPath, htmlPath };
}

/** 运行列表页（data/reports/index.html），失败不影响主流程。 */
function tryWriteIndexHtml({ reportModule, store, brand, flags }) {
  if (typeof reportModule.renderIndexHtml !== 'function') return null;
  try {
    const dir = path.join(DATA_DIR, 'reports');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'index.html');
    const runs = store.listRuns(brand.id, 50).map(toReportRun);
    fs.writeFileSync(file, reportModule.renderIndexHtml({ brand, runs }), 'utf8');
    return file;
  } catch (error) {
    log(flags, `  ⚠ 运行列表页生成失败（不影响本次报告）：${error.message}`);
    return null;
  }
}

// -------------------------------------------------------------------- 命令

/** init：建表 + 写入品牌 + seed 题目。只依赖 config/store，必须能独立工作。 */
async function cmdInit(flags) {
  const slug = brandSlug(flags);
  let file;
  try {
    file = brandPath(slug);
  } catch (error) {
    throw new CliError(error.message, ['--brand 只允许字母、数字、下划线和短横线，例如 hengye']);
  }
  const brand = readJsonFile(file, `品牌配置 brands/${slug}.json`);
  if (!brand || typeof brand !== 'object' || Array.isArray(brand)) {
    throw new CliError(`品牌配置内容必须是对象：${file}`);
  }
  if (brand.slug && brand.slug !== slug) {
    throw new CliError(`品牌配置里的 slug="${brand.slug}" 与 --brand "${slug}" 不一致`, '请统一两者后重试。');
  }
  if (!brand.name) throw new CliError(`品牌配置缺少 name 字段：${file}`);
  brand.slug = slug;

  const questionsFile = path.join(APP_ROOT, 'brands', `${slug}-questions.json`);
  let questions = null;
  if (fs.existsSync(questionsFile)) {
    const parsed = readJsonFile(questionsFile, `题目文件 brands/${slug}-questions.json`);
    if (!Array.isArray(parsed)) throw new CliError(`题目文件内容必须是数组：${questionsFile}`);
    questions = parsed;
  }

  return withStore((store) => {
    const brandId = store.upsertBrand(brand);
    const seeded = questions ? store.seedQuestions(brandId, questions) : 0;
    const total = store.listQuestions(brandId).length;
    const payload = {
      brandId,
      slug,
      name: brand.name,
      dbPath: dbPath(),
      brandFile: file,
      questionsFile: questions ? questionsFile : null,
      questionInserted: seeded,
      questionTotal: total,
    };
    if (flags.json) {
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    }
    console.log('✔ 初始化完成');
    console.log(`  数据库：${dbPath()}`);
    console.log(`  品牌：${brand.name}（slug=${slug}，id=${brandId}）`);
    if (questions) {
      console.log(`  题目：共 ${total} 条（本次新增 ${seeded} 条，已存在自动跳过）`);
    } else {
      console.log(`  题目：共 ${total} 条（未找到 ${path.basename(questionsFile)}，可用 --brand 指向有题目的品牌）`);
    }
    console.log('');
    console.log('下一步：');
    console.log(`  node bin/geo.js diagnose --brand ${slug} --engines mock --limit 12   # 先用演示引擎跑通流程`);
    console.log(`  node bin/geo.js runs --brand ${slug}`);
    return 0;
  });
}

/** diagnose：选引擎 → 题目 → 采集 → 判定 → 评分 → 报告。 */
async function cmdDiagnose(flags) {
  const slug = brandSlug(flags);
  const enginesSpec = stringFlag(flags.engines, 'engines') ?? 'live';
  const limit = intFlag(flags.limit, 'limit', 30);
  const priority = priorityFlag(flags.priority);
  const quiet = Boolean(flags.json);
  loadEnv();

  const enginesModule = await loadModule(
    '../lib/engines/index.js',
    '采集引擎模块（lib/engines/index.js）',
    ['引擎与判定内核由 engine-core 负责，完成后即可用。'],
  );
  const engines = selectEnginesOrFail(enginesModule, enginesSpec, slug);
  const [judgeModule, scoreModule, reportModule] = await Promise.all([
    loadModule('../lib/judge.js', '判定模块（lib/judge.js）', ['判定由 engine-core 负责，完成后即可用。']),
    loadModule('../lib/score.js', '评分模块（lib/score.js）', ['评分由 engine-core 负责，完成后即可用。']),
    loadModule('../lib/report.js', '报告模块（lib/report.js）', [
      '报告渲染由 content-brief 负责；模块就绪前诊断无法产出报告文件。',
    ]),
  ]);
  if (typeof reportModule.renderReportMarkdown !== 'function' || typeof reportModule.renderReportHtml !== 'function') {
    throw new CliError('报告模块缺少 renderReportMarkdown / renderReportHtml', '请检查 lib/report.js 的导出。');
  }

  return withStore(async (store) => {
    const brand = requireBrand(store, slug);
    const questions = store.listQuestions(brand.id, priority ? { priority } : {});
    if (questions.length === 0) {
      throw new CliError(
        `品牌「${slug}」还没有种子题目${priority ? `（优先级 ${priority}）` : ''}`,
        `请检查 brands/${slug}-questions.json 后重新运行：node bin/geo.js init --brand ${slug}`,
      );
    }
    const planned = questions.slice(0, limit);
    const demo = engines.some((engine) => engine.id === 'mock');
    log(flags, `▸ 诊断开始：${brand.name}（${slug}）`);
    log(flags, `  引擎：${engines.map((engine) => engine.id).join(' + ')}${demo ? '（DEMO 演示数据）' : ''}`);
    log(flags, `  题目：${planned.length} 条${priority ? `（${priority} 优先）` : '（P0 优先）'} × 引擎 ${engines.length} 个`);
    if (demo) log(flags, '  ⚠ demo 数据仅用于演示流程，不是真实 AI 回答。');

    const collected = await collectSamples({
      store,
      brand,
      engines,
      questions: planned,
      judge: judgeModule,
      quiet,
    });
    const { runId, kind, okN, plannedN } = collected;
    const detail = store.getRunDetail(runId);
    const score = scoreModule.scoreRun({ rows: detail.rows, plannedN });
    store.saveScore(runId, score);
    let files;
    try {
      files = renderAndWriteReport({
        reportModule,
        brand,
        detail,
        score,
        demo: kind === 'demo',
        runId,
      });
    } catch (error) {
      // run 已落库：即便报告渲染失败，也先刷新运行列表，避免 index.html 落后于最新 run
      tryWriteIndexHtml({ reportModule, store, brand, flags });
      throw error;
    }
    const indexPath = tryWriteIndexHtml({ reportModule, store, brand, flags });
    const payload = {
      runId,
      kind,
      brand: slug,
      engines: engines.map((engine) => engine.id),
      plannedN,
      okN,
      coverage: score?.coverage ?? null,
      total: score?.total ?? null,
      level: score?.level ?? null,
      demo: kind === 'demo',
      reportMd: files.mdPath,
      reportHtml: files.htmlPath,
      indexHtml: indexPath,
    };
    if (flags.json) {
      console.log(JSON.stringify(payload, null, 2));
      return okN > 0 ? 0 : 1;
    }
    console.log('');
    console.log(`✔ 诊断完成：runId=${runId}`);
    console.log(`  引擎：${engines.map((engine) => engine.id).join(' + ')}（${kind === 'demo' ? 'demo 演示' : 'live 真实采集'}）`);
    console.log(`  样本：${okN}/${plannedN} 成功（覆盖率 ${formatPercent(score?.coverage?.ratio)}）`);
    console.log(`  评分：${formatScore(score)}`);
    console.log(`  报告：${files.mdPath}`);
    console.log(`        ${files.htmlPath}`);
    if (indexPath) console.log(`  列表：${indexPath}`);
    if (kind === 'demo') {
      console.log('  提示：本次为 DEMO 演示数据（mock 引擎），报告顶部已标注，不能当作真实 AI 回答结论。');
    }
    if (okN === 0) {
      console.log('  ⚠ 所有样本都未采集成功，本轮只记录覆盖率，不给出总分。');
    }
    return okN > 0 ? 0 : 1;
  });
}

/** keywords：expandKeywords → 落 keywords 表 → 统计输出。 */
async function cmdKeywords(flags) {
  const slug = brandSlug(flags);
  const keywordsModule = await loadModule('../lib/keywords.js', '关键词模块（lib/keywords.js）', [
    '关键词挖掘由 content-brief 负责，完成后即可用。',
  ]);
  return withStore((store) => {
    const brand = requireBrand(store, slug);
    const questions = store.listQuestions(brand.id);
    let list;
    try {
      list = keywordsModule.expandKeywords({ brand, questions });
    } catch (error) {
      throw new CliError(`关键词挖掘失败（lib/keywords.js）：${error.message}`);
    }
    if (!Array.isArray(list) || list.length === 0) {
      throw new CliError('关键词模块没有返回任何结果', '请检查 lib/keywords.js 的 expandKeywords 实现。');
    }
    for (const keyword of list) store.upsertKeyword(brand.id, keyword);
    const stored = store.listKeywords(brand.id);
    const clusters = {};
    const priorities = {};
    for (const keyword of stored) {
      clusters[keyword.cluster ?? '未分类'] = (clusters[keyword.cluster ?? '未分类'] ?? 0) + 1;
      priorities[keyword.priority ?? '未标'] = (priorities[keyword.priority ?? '未标'] ?? 0) + 1;
    }
    const payload = { brandId: brand.id, count: stored.length, clusters, priorities, keywords: stored };
    if (flags.json) {
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    }
    console.log(`✔ 关键词挖掘完成：${stored.length} 个（已写入 keywords 表）`);
    console.log(`  簇分布：${Object.entries(clusters).map(([name, count]) => `${name} ${count}`).join(' · ')}`);
    console.log(`  优先级：${Object.entries(priorities).map(([name, count]) => `${name} ${count}`).join(' · ')}`);
    console.log('');
    console.log('  前 10 个：');
    for (const keyword of stored.slice(0, 10)) {
      console.log(
        `    [${keyword.priority ?? '—'}][难度 ${keyword.difficulty ?? '—'}] ${keyword.term}  （${keyword.cluster ?? '未分类'}）`,
      );
    }
    console.log('');
    console.log('下一步（挑一个关键词生成内容 brief）：');
    const sample = stored[0];
    if (sample) console.log(`  node bin/geo.js brief --brand ${slug} --keyword "${sample.term}"`);
    return 0;
  });
}

/** brief：buildBrief + renderBriefMarkdown → contents 表 + data/briefs/<slug>-<id>.md。 */
async function cmdBrief(flags) {
  const slug = brandSlug(flags);
  const keywordTerm = stringFlag(flags.keyword, 'keyword');
  const questionId = intFlag(flags.question, 'question', undefined);
  if (!keywordTerm && questionId === undefined) {
    throw new CliError('缺少 --keyword <关键词>（或 --question <题目 id>）', [
      `用法：node bin/geo.js brief --brand ${slug} --keyword "芜湖内容代运营"`,
      `先看有哪些关键词：node bin/geo.js keywords --brand ${slug}`,
    ]);
  }
  const briefModule = await loadModule('../lib/brief.js', '内容 brief 模块（lib/brief.js）', [
    '内容 brief 由 content-brief 负责，完成后即可用。',
  ]);
  return withStore((store) => {
    const brand = requireBrand(store, slug);
    const allQuestions = store.listQuestions(brand.id);
    let keyword = null;
    if (keywordTerm) {
      keyword = store.listKeywords(brand.id).find((item) => item.term === keywordTerm) ?? null;
      if (!keyword) {
        throw new CliError(`关键词「${keywordTerm}」不在 keywords 表中`, [
          `先挖掘关键词：node bin/geo.js keywords --brand ${slug}`,
          `再按词生成：node bin/geo.js brief --brand ${slug} --keyword "<keywords 列表里的词>"`,
        ]);
      }
    }
    let question = null;
    if (questionId !== undefined) {
      question = allQuestions.find((item) => item.id === questionId) ?? null;
      if (!question) {
        throw new CliError(`题目 id=${questionId} 不存在`, [
          `题目 id 是 questions 表主键；可改用 --keyword 指定关键词，或先看 init 输出的题目数量后重试。`,
          `查看关键词：node bin/geo.js keywords --brand ${slug}`,
        ]);
      }
    } else {
      question = pickQuestionForKeyword(allQuestions, keyword?.term ?? '');
    }

    const [lastRun] = store.listRuns(brand.id, 1);
    const lastScore = lastRun ? store.getScore(lastRun.id) : null;
    const lastRunStats = lastRun
      ? {
          runId: lastRun.id,
          kind: lastRun.kind,
          total: lastScore?.total ?? null,
          level: lastScore?.level ?? '样本不足',
          coverage: lastScore?.coverage ?? null,
          finishedAt: lastRun.finishedAt,
        }
      : null;

    let brief;
    try {
      brief = briefModule.buildBrief({ brand, question, keyword, lastRunStats });
    } catch (error) {
      throw new CliError(`生成 brief 失败（lib/brief.js）：${error.message}`);
    }
    if (!brief || typeof brief !== 'object') throw new CliError('brief 模块返回了空结果（buildBrief）');
    const markdown = briefModule.renderBriefMarkdown(brief);
    if (typeof markdown !== 'string' || !markdown.trim()) {
      throw new CliError('brief 模块返回了空 Markdown（renderBriefMarkdown）');
    }

    const outFlag = stringFlag(flags.out, 'out');
    const file = outFlag
      ? path.resolve(outFlag)
      : path.join(DATA_DIR, 'briefs', `${slug}-${keyword?.id ?? question?.id ?? 'draft'}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, markdown, 'utf8');

    const contentId = store.createContent({
      brandId: brand.id,
      keywordId: keyword?.id ?? null,
      questionId: question?.id ?? null,
      title: brief.title ?? `内容 brief：${keyword?.term ?? question?.text ?? slug}`,
      format: brief.format ?? null,
      status: 'draft',
      brief,
      bodyMd: markdown,
    });
    const payload = {
      contentId,
      brand: slug,
      keyword: keyword?.term ?? null,
      questionId: question?.id ?? null,
      question: question?.text ?? null,
      title: brief.title ?? null,
      format: brief.format ?? null,
      briefFile: file,
      lastRunStats,
    };
    if (flags.json) {
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    }
    console.log('✔ Brief 已生成');
    console.log(`  标题：${brief.title ?? '—'}`);
    console.log(`  目标问题：${question?.text ?? '（未匹配到具象问题）'}`);
    console.log(`  关键词：${keyword?.term ?? '—'} · 格式：${brief.format ?? '—'}`);
    console.log(`  content id：${contentId}（登记发布记录时使用）`);
    console.log(`  文件：${file}`);
    if (!keyword) console.log('  提示：本次按 --question 生成，未关联 keywords 表中的关键词。');
    console.log('');
    console.log('下一步（登记发布，默认 dry_run）：');
    console.log(`  node bin/geo.js publish --brand ${slug} --content ${contentId} --channel 知乎专栏`);
    return 0;
  });
}

/** 为关键词挑一个相关题目：优先包含关键词的题，退化为 P0 首题。 */
function pickQuestionForKeyword(questions, term) {
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const normalized = String(term ?? '').trim();
  if (normalized) {
    const direct = questions.find((question) => String(question.text).includes(normalized));
    if (direct) return direct;
    const tokens = normalized.split(/[\s·,，、/]+/).filter((token) => token.length >= 2);
    for (const token of tokens) {
      const hit = questions.find((question) => String(question.text).includes(token));
      if (hit) return hit;
    }
  }
  return questions[0];
}

/** 落草稿正文。SPEC §3.2 只定义了 updateContentStatus(id,status)，没有更新正文的 DAO；
 *  task-7 限定只改 bin/geo.js，因此这里用最小 UPDATE 写 body_md（store.db 是公开连接）。 */
function saveDraftBody(store, contentId, bodyMd) {
  store.db.prepare('UPDATE contents SET body_md = ? WHERE id = ?').run(String(bodyMd ?? ''), Number(contentId));
}

/**
 * 选写作引擎：'none' → 模板模式；否则按 DeepSeek 优先、其次 dashscope，
 * 只使用已配置 key 的引擎；一个都没有时返回 engine=null 由 writer 回退模板（不报错）。
 */
async function resolveWritingEngine(enginesSpec, slug) {
  const warnings = [];
  const requested = String(enginesSpec ?? 'live').trim().toLowerCase();
  if (requested === 'none') {
    return { engine: null, engineId: null, warnings, requestedLabel: '模板模式（--engines none）' };
  }
  let candidates;
  if (!requested || requested === 'live') {
    candidates = [...WRITING_ENGINE_IDS];
  } else {
    candidates = requested.split(',').map((item) => item.trim()).filter(Boolean);
    const invalid = candidates.filter((id) => !WRITING_ENGINE_IDS.includes(id));
    if (invalid.length) {
      throw new CliError(
        `--engines 只支持 none / deepseek / dashscope（或逗号组合），收到 "${invalid.join(',')}"`,
        [`模板模式（无需 key）：node bin/geo.js write --brand ${slug} --content <id> --engines none`],
      );
    }
  }
  const enginesModule = await loadModule(
    '../lib/engines/index.js',
    '采集引擎模块（lib/engines/index.js）',
    ['写作引擎实例来自 lib/engines/index.js（engine-core 负责）。'],
  );
  const usable = candidates.filter((id) =>
    typeof enginesModule.engineHasKey === 'function' ? enginesModule.engineHasKey(id, process.env) : true,
  );
  if (usable.length === 0) {
    warnings.push(
      `未检测到可用写作引擎 key（${candidates.join(' / ')}），已回退模板模式；在 app/.env 配置 DEEPSEEK_API_KEY 后可生成 LLM 草稿。`,
    );
    return { engine: null, engineId: null, warnings, requestedLabel: `回退模板模式（${requested} 无可用 key）` };
  }
  const engineId = usable[0];
  return {
    engine: enginesModule.getEngine(engineId, { env: process.env }),
    engineId,
    warnings,
    requestedLabel: `写作引擎 ${engineId}`,
  };
}

/** write：按 content 的 brief 生成草稿 → factCheckDraft → 落 body_md/状态 → data/drafts/<id>.md。 */
async function cmdWrite(flags) {
  const slug = brandSlug(flags);
  const contentId = intFlag(flags.content, 'content', undefined);
  if (contentId === undefined) {
    throw new CliError('缺少 --content <内容 id>', [
      `用法：node bin/geo.js write --brand ${slug} --content <id> [--engines deepseek|dashscope|none]`,
      'content id 来自 brief 命令的输出（先 brief 再 write）。',
    ]);
  }
  const enginesSpec = stringFlag(flags.engines, 'engines') ?? 'live';
  loadEnv();
  const writerModule = await loadModule('../lib/writer.js', '写作模块（lib/writer.js）', [
    '内容生成由 content-brief 负责，完成后即可用。',
  ]);
  for (const name of ['generateDraft', 'factCheckDraft']) {
    if (typeof writerModule[name] !== 'function') {
      throw new CliError(`写作模块缺少 ${name}()`, '请检查 lib/writer.js 的导出。');
    }
  }
  return withStore(async (store) => {
    const brand = requireBrand(store, slug);
    const content = store.listContents(brand.id).find((item) => item.id === contentId);
    if (!content) {
      throw new CliError(`content #${contentId} 不存在（或不属于品牌 ${slug}）`, [
        '先运行 brief 生成内容记录：node bin/geo.js brief --brand ' + slug + ' --keyword "<关键词>"',
      ]);
    }
    if (!content.brief || typeof content.brief !== 'object') {
      throw new CliError(`content #${contentId} 缺少 brief 数据`, '请先用 brief 命令生成带 brief 的内容记录。');
    }
    const questions = store.listQuestions(brand.id);
    const question = content.questionId ? questions.find((item) => item.id === content.questionId) ?? null : null;
    const resolved = await resolveWritingEngine(enginesSpec, slug);
    log(flags, `▸ 生成草稿：content #${contentId} · ${resolved.requestedLabel}`);

    let draft;
    try {
      draft = await writerModule.generateDraft({ brand, brief: content.brief, question, engine: resolved.engine });
    } catch (error) {
      throw new CliError(`生成草稿失败（lib/writer.js）：${error.message}`);
    }
    if (!draft || typeof draft.text !== 'string' || !draft.text.trim()) {
      throw new CliError('写作模块没有返回可用草稿（generateDraft）', '请检查 lib/writer.js 的 generateDraft 实现。');
    }

    let check;
    try {
      check = writerModule.factCheckDraft({ text: draft.text, brief: content.brief, brand });
    } catch (error) {
      throw new CliError(`事实核查失败（lib/writer.js）：${error.message}`);
    }
    const violations = Array.isArray(check?.violations) ? check.violations : [];

    // 发布前交付纪律（对应 OmniRank 的 length contract / presence policy / title 治理 / 七维终审）：
    // 模块可用就强制执行；不可用则跳过，保证流水线不被"缺一个模块"卡死。
    const draftTitle = String(draft.title ?? content.title ?? '').trim();
    let contracts = null;
    let review = null;
    const existingTitles = store
      .listContents(brand.id)
      .filter((item) => item.id !== contentId && item.title)
      .map((item) => item.title);
    try {
      const contractsModule = await import('../lib/article-contracts.js');
      contracts = contractsModule.applyContracts({
        title: draftTitle,
        body: draft.text,
        brand,
        brief: content.brief,
        existingTitles,
      });
    } catch {
      contracts = null;
    }
    try {
      const reviewModule = await import('../lib/article-review.js');
      review = reviewModule.reviewArticle({
        title: draftTitle,
        body: draft.text,
        brand,
        brief: content.brief,
        existingTitles,
      });
    } catch {
      review = null;
    }
    // 交付纪律只约束「真正由模型写出来的稿」；模板骨架是半成品，卡它会让人无法跑通流程。
    // 模板模式只做提示（warnings），不改状态。
    const gatesEnforced = String(draft.mode ?? '').toLowerCase() !== 'template';
    const contractsOk = contracts ? contracts.ok : true;
    const reviewOk = review ? review.publishable : true;
    const gatesOk = gatesEnforced ? contractsOk && reviewOk : true;
    const status = violations.length === 0 && gatesOk ? 'draft' : 'needs_review';
    const wordCount = Number.isFinite(Number(check?.wordCount))
      ? Number(check.wordCount)
      : Array.from(draft.text.replace(/\s+/g, '')).length;
    const gateWarnings = [];
    if (!gatesEnforced) {
      if (contracts && !contracts.ok) gateWarnings.push(`模板骨架未通过合同检查（${contracts.blockers.length} 项），仅作流程演示`);
      if (review && !review.publishable) gateWarnings.push(`模板骨架未通过终审（${review.total} 分 / ${review.level}），仅作流程演示`);
    }
    const warnings = [
      ...(Array.isArray(draft.warnings) ? draft.warnings : []),
      ...resolved.warnings,
      ...gateWarnings,
    ];

    saveDraftBody(store, contentId, draft.text);
    store.updateContentStatus(contentId, status);

    const draftsDir = path.join(DATA_DIR, 'drafts');
    fs.mkdirSync(draftsDir, { recursive: true });
    const draftFile = path.join(draftsDir, `${contentId}.md`);
    fs.writeFileSync(draftFile, draft.text, 'utf8');

    const violationTypes = [...new Set(violations.map((violation) => violation.type))];
    const payload = {
      contentId,
      brand: slug,
      mode: draft.mode ?? (resolved.engine ? 'llm' : 'template'),
      engineId: draft.engineId ?? resolved.engineId ?? null,
      wordCount,
      passed: violations.length === 0,
      status,
      violationCount: violations.length,
      violationTypes,
      violations,
      warnings,
      contracts: contracts
        ? { ok: contracts.ok, blockers: contracts.blockers, warnings: contracts.warnings, fixes: contracts.fixes }
        : null,
      review: review
        ? {
            total: review.total,
            level: review.level,
            publishable: review.publishable,
            needsHumanSignoff: review.needsHumanSignoff,
            risk: review.risk,
            hardCount: review.hardCount,
            softCount: review.softCount,
            defects: review.defects,
          }
        : null,
      draftFile,
      requestedEngines: enginesSpec,
    };
    if (flags.json) {
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    }
    console.log('');
    console.log(`✔ 草稿已生成：content #${contentId}`);
    console.log(
      `  模式：${payload.mode}${payload.engineId ? `（引擎 ${payload.engineId}）` : '（模板骨架，未调用 LLM）'}`,
    );
    console.log(`  字数：${wordCount}`);
    if (violations.length === 0) {
      console.log(`  事实核查：通过（0 条违规） → 状态 ${status}`);
    } else {
      console.log(
        `  事实核查：${violations.length} 条违规（${violationTypes
          .map((type) => VIOLATION_LABELS[type] ?? type)
          .join('、')}） → 状态 ${status}，需人工复核`,
      );
      for (const violation of violations.slice(0, 10)) {
        const snippet = violation.snippet ? ` ｜摘录：${truncate(violation.snippet, 40)}` : '';
        console.log(
          `    · [${VIOLATION_LABELS[violation.type] ?? violation.type}] ${truncate(violation.detail, 60)}${snippet}`,
        );
      }
      if (violations.length > 10) console.log(`    · 其余 ${violations.length - 10} 条略，详见 --json 输出`);
    }
    // 交付纪律输出：合同检查与七维终审（模块未就绪时静默跳过）
    if (contracts) {
      const { length: lengthCheck, presence: presenceCheck, title: titleCheck } = contracts.checks ?? {};
      console.log(
        `  合同检查：${contracts.ok ? '通过' : `阻断 ${contracts.blockers.length} 项`}`
          + `（篇幅 ${lengthCheck?.chars ?? wordCount} 字 / ${lengthCheck?.level ?? '—'}`
          + ` · 品牌提及 ${presenceCheck?.mentions ?? 0} 次 · 标题 ${titleCheck?.ok ? '合规' : '待改'}）`,
      );
      for (const fix of (contracts.fixes ?? []).slice(0, 5)) console.log(`    → ${fix}`);
    }
    if (review) {
      console.log(
        `  七维终审：${review.total} 分 · ${review.level} · 风险 ${review.risk}`
          + `（硬伤 ${review.hardCount} / 软伤 ${review.softCount}）`
          + (review.publishable ? ' → 可发布' : ' → 不可发布'),
      );
      for (const defect of (review.defects ?? []).slice(0, 6)) {
        const label = defect.type === 'hard' ? '硬伤' : '软伤';
        const text = defect.detail ?? defect.message ?? defect.label ?? defect.code ?? '（未提供说明）';
        console.log(`    · [${label}] ${text}`);
      }
      if (review.needsHumanSignoff) console.log('    ! 需要人工签发后才能发布');
    }
    console.log(`  草稿：${draftFile}`);
    for (const warning of warnings) console.log(`  提示：${warning}`);
    if (status === 'draft') {
      console.log('');
      console.log(`下一步：node bin/geo.js publish --brand ${slug} --content ${contentId} --channel 知乎专栏`);
    } else {
      console.log('');
      console.log('请按违规清单人工修订（或补可验证证据后重新 write），修正后状态应回到 draft。');
    }
    return 0;
  });
}

/** publish：登记发布记录（默认 dry_run），并更新 content 状态。 */
async function cmdPublish(flags) {
  const slug = brandSlug(flags);

  // --list：查看渠道三态（未接入 / 模拟 / API）
  if (flags.list) {
    try {
      const channelsModule = await import('../lib/publish-channels.js');
      const list = channelsModule.listChannels({ env: process.env });
      console.log(channelsModule.renderChannelsMarkdown(list));
      console.log('');
      console.log('配置方法：在 app/.env 里为某渠道加 PUBLISH_<ID大写>_WEBHOOK=<回调地址> 即升级为 api 态。');
      return 0;
    } catch (error) {
      throw new CliError('发布渠道模块不可用（lib/publish-channels.js）', [`详情：${error?.message ?? error}`]);
    }
  }

  const contentId = intFlag(flags.content, 'content', undefined);
  if (contentId === undefined) {
    throw new CliError('缺少 --content <内容 id>', [
      `用法：node bin/geo.js publish --brand ${slug} --content <id> --channel <渠道名>`,
      `内容 id 来自 brief 命令的输出。`,
    ]);
  }
  const channel = stringFlag(flags.channel, 'channel');
  if (!channel) {
    throw new CliError('缺少 --channel <渠道名>', `示例：--channel 知乎专栏 / 公众号 / 小红书 / 官网博客`);
  }
  const url = stringFlag(flags.url, 'url') ?? null;
  const status = stringFlag(flags.status, 'status') ?? 'dry_run';
  if (!['dry_run', 'published'].includes(status)) {
    throw new CliError(`--status 只支持 dry_run 或 published，收到 "${status}"`);
  }
  return withStore(async (store) => {
    const brand = requireBrand(store, slug);
    const content = store.listContents(brand.id).find((item) => item.id === contentId);
    if (!content) {
      throw new CliError(`content #${contentId} 不存在（或不属于品牌 ${slug}）`, '先运行 brief 生成内容，再用输出的 content id 登记发布。');
    }

    // 先把正文取出来（浏览器填充与公众号 API 都要用）
    let bodyText = String(content.bodyMd ?? content.bodyMarkdown ?? content.body ?? '');
    if (!bodyText) {
      const draftFile = path.join(DATA_DIR, 'drafts', `${content.id}.md`);
      if (fs.existsSync(draftFile)) bodyText = fs.readFileSync(draftFile, 'utf8');
    }

    // 路线 A：浏览器半自动（知乎/头条/百家号/小红书/抖音/公众号后台）
    // 只负责「开页面 + 填标题 + 填正文」，发布按钮永远留给人点。
    const platformFlag = stringFlag(flags.platform, 'platform') ?? null;
    if (flags.browser || platformFlag) {
      const platformAlias = {
        '知乎': 'zhihu', '知乎专栏': 'zhihu', '今日头条': 'toutiao', '头条': 'toutiao',
        '百家号': 'baijiahao', '小红书': 'xiaohongshu', '抖音': 'douyin',
        '公众号': 'wechat_mp', '微信公众号': 'wechat_mp', 'wechat': 'wechat_mp',
      };
      const platform = platformFlag ?? platformAlias[channel] ?? String(channel).toLowerCase();
      let browserModule;
      try {
        browserModule = await import('../lib/publishers/browser.js');
      } catch (error) {
        throw new CliError('浏览器发布模块不可用（lib/publishers/browser.js）', [`详情：${error?.message ?? error}`]);
      }
      const outcome = await browserModule.openForPublish({
        platform,
        title: String(content.title ?? ''),
        body: bodyText,
        port: intFlag(flags.port, 'port', 9222),
      });
      const publicationId = store.createPublication({ contentId, channel, url: outcome.url ?? url, status: 'dry_run' });
      const payload = { publicationId, contentId, channel, platform, browser: outcome };
      if (flags.json) {
        console.log(JSON.stringify(payload, null, 2));
        return outcome.ok ? 0 : 1;
      }
      if (outcome.ok) {
        console.log('✔ 已在浏览器里打开编辑器并填入稿件（没有点发布）');
        console.log(`  平台：${platform} · 标题：${outcome.filled?.title ? '已填' : '未填'} · 正文：${outcome.filled?.body ? '已填' : '未填'}`);
        console.log('  请在浏览器里检查排版/配图，然后自己点「发布」。');
        console.log(`  发布记录：#${publicationId}（状态 dry_run，真发后可改为 published）`);
        return 0;
      }
      console.log(`✖ 浏览器填充失败：${outcome.reason ?? '未知原因'}`);
      if (outcome.hint) console.log(`  照这个命令重启 Chrome 后重试：${outcome.hint}`);
      return 1;
    }

    // 路线 B：微信公众号官方 API（唯一有完整官方发布能力的平台）
    let wechatOutcome = null;
    const channelKey = String(channel).toLowerCase();
    if (channelKey === 'wechat' || channel === '公众号' || channel === '微信公众号') {
      try {
        const wx = await import('../lib/publishers/wechat.js');
        const wxReady = wx.wechatReadiness(process.env);
        if (wxReady.ready) {
          wechatOutcome = await wx.publishToWechat({
            title: String(content.title ?? ''),
            body: bodyText,
            author: String(brand.name ?? ''),
            env: process.env,
            autoPublish: status === 'published' && String(process.env.WECHAT_AUTO_PUBLISH ?? '') === '1',
          });
        } else {
          wechatOutcome = { ok: false, mode: 'draft', reason: `公众号 API 未就绪：${wxReady.reason}`, state: 'not_connected' };
        }
      } catch (error) {
        wechatOutcome = { ok: false, reason: `公众号发布异常：${error?.message ?? error}` };
      }
    }

    // 渠道三态（未接入 / 模拟 / API）：模块可用就先过一遍渠道抽象，再落库回执
    let channelOutcome = null;
    try {
      const channelsModule = await import('../lib/publish-channels.js');
      const list = channelsModule.listChannels({ env: process.env });
      const matched =
        list.find((item) => item.name === channel || item.id === String(channel).toLowerCase()) ?? null;
      if (matched) {
        channelOutcome = await channelsModule.publishTo({
          channel: matched.id,
          content: {
            title: String(content.title ?? ''),
            body: String(content.bodyMd ?? content.bodyMarkdown ?? content.body ?? ''),
            url: url ?? undefined,
            contentId,
          },
          dryRun: status === 'dry_run',
          env: process.env,
        });
        channelOutcome.channelName = matched.name;
      } else {
        channelOutcome = {
          ok: false,
          state: 'not_connected',
          reason: '渠道不在已登记清单里',
          hint: '可用渠道见：node bin/geo.js publish --list',
        };
      }
    } catch {
      channelOutcome = null;
    }

    if (wechatOutcome) {
      const mediaId = wechatOutcome.mediaId ? `media:${wechatOutcome.mediaId}` : null;
      channelOutcome = {
        ok: Boolean(wechatOutcome.ok),
        state: wechatOutcome.ok ? 'api' : 'not_connected',
        channelName: '微信公众号',
        reason: wechatOutcome.ok ? '' : wechatOutcome.reason,
        receipt: mediaId ? { receiptId: mediaId, url: url ?? null } : null,
        hint: wechatOutcome.ok
          ? (wechatOutcome.mode === 'publish' ? '已群发（可在公众号后台查看）' : '草稿已建；在公众号后台确认后群发，或设 WECHAT_AUTO_PUBLISH=1 自动群发')
          : '检查 AppID/Secret 与 IP 白名单（errcode 40164 表示 IP 未放行）',
      };
    }

    const publicationId = store.createPublication({ contentId, channel, url, status });
    store.writeAudit({ actor: 'cli', brandSlug: slug, action: 'publish', detail: `content=${contentId} channel=${channel} status=${status}` });
    store.updateContentStatus(contentId, status === 'published' ? 'published' : 'dry_run');
    const payload = {
      publicationId,
      contentId,
      brand: slug,
      channel,
      url,
      status,
      contentStatus: status,
      channelOutcome,
    };
    if (flags.json) {
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    }
    console.log('✔ 发布记录已创建');
    console.log(`  publication：#${publicationId} · 渠道：${channel} · 状态：${status}`);
    if (channelOutcome) {
      const stateLabels = { not_connected: '未接入', dry_run: '模拟发布', api: '已接入 API' };
      console.log(
        `  渠道状态：${stateLabels[channelOutcome.state] ?? channelOutcome.state}`
          + (channelOutcome.ok ? ' · 回执已生成' : ` · ${channelOutcome.reason ?? '未执行'}`),
      );
      if (channelOutcome.receipt?.receiptId) console.log(`  回执号：${channelOutcome.receipt.receiptId}`);
      if (channelOutcome.receipt?.url) console.log(`  回执链接：${channelOutcome.receipt.url}`);
      if (channelOutcome.hint) console.log(`  提示：${channelOutcome.hint}`);
    }
    console.log(`  content #${contentId}（${content.title ?? '—'}）状态：${status}`);
    if (status === 'dry_run') {
      console.log('  说明：dry_run 是模拟登记，并未真实发稿。真实发布后请补 --url，并加 --status published。');
    } else if (!url) {
      console.log('  提示：published 但未回填 URL，建议补 --url，便于监测归因。');
    }
    return 0;
  });
}

/** monitor：复跑（默认 10 题）→ 写 monitoring → 与上一轮对比。 */
async function cmdMonitor(flags) {
  const slug = brandSlug(flags);
  const enginesSpec = stringFlag(flags.engines, 'engines') ?? 'live';
  const limit = intFlag(flags.limit, 'limit', 10);
  const quiet = Boolean(flags.json);
  loadEnv();

  const enginesModule = await loadModule(
    '../lib/engines/index.js',
    '采集引擎模块（lib/engines/index.js）',
    ['引擎内核由 engine-core 负责，完成后即可用。'],
  );
  const engines = selectEnginesOrFail(enginesModule, enginesSpec, slug);
  const [judgeModule, scoreModule] = await Promise.all([
    loadModule('../lib/judge.js', '判定模块（lib/judge.js）', ['判定由 engine-core 负责，完成后即可用。']),
    loadModule('../lib/score.js', '评分模块（lib/score.js）', ['评分由 engine-core 负责，完成后即可用。']),
  ]);
  const reportModule = await tryLoadModule('../lib/report.js');

  return withStore(async (store) => {
    const brand = requireBrand(store, slug);
    const questions = store.listQuestions(brand.id);
    if (questions.length === 0) {
      throw new CliError(`品牌「${slug}」还没有种子题目`, `请先运行：node bin/geo.js init --brand ${slug}`);
    }
    const planned = questions.slice(0, limit);
    const previousRun = store.listRuns(brand.id, 1)[0] ?? null;
    const previousDetail = previousRun ? store.getRunDetail(previousRun.id) : null;
    const previousScore = previousRun ? store.getScore(previousRun.id) : null;
    const demo = engines.some((engine) => engine.id === 'mock');
    log(flags, `▸ 监测开始：${brand.name}（${slug}） · 题目 ${planned.length} 条`);
    if (demo) log(flags, '  ⚠ demo 数据仅用于演示流程，不是真实 AI 回答。');

    const collected = await collectSamples({
      store,
      brand,
      engines,
      questions: planned,
      judge: judgeModule,
      quiet,
      onSample: ({ runId, question, engine, judgment }) => {
        store.saveMonitoringCheck({
          brandId: brand.id,
          questionId: question.id,
          engine: String(engine.id),
          verdict: judgment.verdict,
          runId,
        });
      },
    });
    const { runId, kind, okN, plannedN } = collected;
    const detail = store.getRunDetail(runId);
    const score = scoreModule.scoreRun({ rows: detail.rows, plannedN });
    store.saveScore(runId, score);

    let reportFiles = null;
    if (reportModule && typeof reportModule.renderReportMarkdown === 'function') {
      try {
        reportFiles = renderAndWriteReport({
          reportModule,
          brand,
          detail,
          score,
          demo: kind === 'demo',
          runId,
        });
      } catch (error) {
        log(flags, `  ⚠ 报告生成失败（监测记录已保存）：${error.message}`);
      }
    } else {
      log(flags, '  ⚠ 报告模块（lib/report.js）未就绪，本次跳过报告文件。');
    }

    // monitor 也会新增 run：必须同步刷新运行列表页，否则 index.html 会落后于最新 run。
    const indexPath = reportModule ? tryWriteIndexHtml({ reportModule, store, brand, flags }) : null;

    const changes = previousDetail ? compareWithPrevious(previousDetail, detail) : null;
    const payload = {
      runId,
      kind,
      brand: slug,
      engines: engines.map((engine) => engine.id),
      plannedN,
      okN,
      coverage: score?.coverage ?? null,
      total: score?.total ?? null,
      level: score?.level ?? null,
      demo: kind === 'demo',
      previousRunId: previousRun?.id ?? null,
      previousTotal: previousScore?.total ?? null,
      previousLevel: previousScore?.level ?? null,
      changes,
      reportMd: reportFiles?.mdPath ?? null,
      reportHtml: reportFiles?.htmlPath ?? null,
      indexHtml: indexPath,
      monitoringChecks: plannedN,
    };

    if (flags.json) {
      console.log(JSON.stringify(payload, null, 2));
      return okN > 0 ? 0 : 1;
    }

    console.log('');
    console.log(`✔ 监测完成：runId=${runId}`);
    console.log(`  本次：${formatScore(score)}`);
    if (!previousRun) {
      console.log('  对比：这是首轮监测，暂无可对比的历史 run。');
    } else {
      const previousLabel =
        previousScore && previousScore.total !== null
          ? `${previousScore.total} 分 · ${previousScore.level}`
          : previousScore?.level ?? '样本不足';
      console.log(`  上次：run #${previousRun.id} · ${previousLabel}（${formatDateTime(previousRun.startedAt)}）`);
      if (previousScore && score && previousScore.total !== null && score.total !== null) {
        console.log(`  总分变化：${formatDelta(score.total - previousScore.total)}`);
      } else if (previousScore?.total === null && score?.total !== null) {
        console.log('  总分变化：上一轮样本不足 → 本轮已可出分。');
      } else if (score?.total === null) {
        console.log('  总分变化：本轮样本不足，不出分；只看覆盖率与单题判定变化。');
      }
      if (changes) {
        console.log(
          `  提及变化：提升 ${changes.improved.length} · 下降 ${changes.declined.length} · 新增提及 ${changes.newMentions.length} · 丢失提及 ${changes.lostMentions.length}`,
        );
        if (changes.uncovered.length > 0) {
          console.log(
            `  另有 ${changes.uncovered.length} 条本次首次覆盖（上一轮未测到，不参与对比），例如：${truncate(changes.uncovered[0].question, 26)}`,
          );
        }
        for (const item of changes.newMentions.slice(0, 5)) {
          console.log(`    ↑ 新增提及：${truncate(item.question, 26)}（${item.engine}：${verdictLabel(item.before)} → ${verdictLabel(item.after)}）`);
        }
        for (const item of changes.lostMentions.slice(0, 5)) {
          console.log(`    ↓ 丢失提及：${truncate(item.question, 26)}（${item.engine}：${verdictLabel(item.before)} → ${verdictLabel(item.after)}）`);
        }
        for (const item of changes.declined.slice(0, 5)) {
          console.log(`    ↓ 提及下降：${truncate(item.question, 26)}（${item.engine}：${verdictLabel(item.before)} → ${verdictLabel(item.after)}）`);
        }
      }
    }
    console.log(`  监测记录：已写入 monitoring（${plannedN} 条，覆盖率 ${formatPercent(score?.coverage?.ratio)}）`);
    if (reportFiles) console.log(`  报告：${reportFiles.htmlPath}`);
    if (indexPath) console.log(`  列表：${indexPath}`);
    if (kind === 'demo') console.log('  提示：本次为 DEMO 演示数据（mock 引擎），不能当作真实 AI 回答结论。');
    if (okN === 0) console.log('  ⚠ 所有样本都未采集成功，本轮只记录覆盖率。');
    return okN > 0 ? 0 : 1;
  });
}

function rowKey(row) {
  return `${row.question.id}::${row.answer.engine}`;
}

function compareWithPrevious(previousDetail, detail) {
  const changes = { improved: [], declined: [], newMentions: [], lostMentions: [], uncovered: [] };
  const before = new Map();
  for (const row of previousDetail?.rows ?? []) before.set(rowKey(row), row);
  for (const row of detail?.rows ?? []) {
    const previousRow = before.get(rowKey(row));
    const previousVerdict = previousRow?.judgment?.verdict ?? null;
    const nextVerdict = row.judgment?.verdict ?? null;
    const previousRank = previousVerdict === null ? null : VERDICT_RANK[previousVerdict];
    const nextRank = nextVerdict === null ? null : VERDICT_RANK[nextVerdict];
    if (nextRank === undefined || nextRank === null) continue;
    const item = {
      question: row.question.text,
      engine: row.answer.engine,
      before: previousVerdict,
      after: nextVerdict,
    };
    if (previousRank === undefined || previousRank === null) {
      // 上一轮没测到这条（题目集不同/该引擎未覆盖），不算「提及变化」，单列出来避免误读
      changes.uncovered.push(item);
      continue;
    }
    if (nextRank > previousRank) changes.improved.push(item);
    if (nextRank < previousRank) changes.declined.push(item);
    if (previousRank === 0 && nextRank > 0) changes.newMentions.push(item);
    if (previousRank > 0 && nextRank === 0) changes.lostMentions.push(item);
  }
  return changes;
}

/** report：按已有 run 重建报告（评分缺失时按规则重算并回填）。 */
async function cmdReport(flags) {
  const runId = intFlag(flags.run, 'run', undefined);
  if (runId === undefined) {
    throw new CliError('缺少 --run <id>', ['先运行：node bin/geo.js runs --brand hengye 查看可用 runId']);
  }
  const outFlag = stringFlag(flags.out, 'out');
  const outDir = outFlag ? path.resolve(outFlag) : undefined;
  return withStore(async (store) => {
    const detail = store.getRunDetail(runId);
    if (!detail) {
      throw new CliError(`run #${runId} 不存在`, ['先运行：node bin/geo.js runs --brand hengye 查看可用 runId']);
    }
    let score = store.getScore(runId);
    if (!score) {
      const scoreModule = await tryLoadModule('../lib/score.js');
      if (scoreModule && typeof scoreModule.scoreRun === 'function') {
        score = scoreModule.scoreRun({ rows: detail.rows, plannedN: detail.run.plannedN ?? detail.rows.length });
        store.saveScore(runId, score);
        log(flags, `提示：run #${runId} 没有评分记录，已按规则重算并回填 scores 表。`);
      } else {
        throw new CliError(`run #${runId} 缺少评分记录，且评分模块不可用`, `先跑一轮诊断生成评分，或等 lib/score.js 就绪。`);
      }
    }
    const reportModule = await loadModule('../lib/report.js', '报告模块（lib/report.js）', [
      '报告渲染由 content-brief 负责，完成后即可用。',
    ]);
    const files = renderAndWriteReport({
      reportModule,
      brand: detail.brand,
      detail,
      score,
      demo: detail.run.kind === 'demo',
      runId,
      outDir,
    });
    const indexPath = tryWriteIndexHtml({ reportModule, store, brand: detail.brand, flags });
    const payload = {
      runId,
      kind: detail.run.kind,
      demo: detail.run.kind === 'demo',
      total: score.total ?? null,
      level: score.level ?? null,
      coverage: score.coverage ?? null,
      reportMd: files.mdPath,
      reportHtml: files.htmlPath,
      indexHtml: indexPath,
    };
    if (flags.json) {
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    }
    console.log(`✔ 报告已重建：run #${runId}（${detail.run.kind === 'demo' ? 'DEMO 演示数据' : '真实采集'}）`);
    console.log(`  评分：${formatScore(score)}`);
    console.log(`  报告：${files.mdPath}`);
    console.log(`        ${files.htmlPath}`);
    if (indexPath) console.log(`  列表：${indexPath}`);
    if (detail.run.kind === 'demo') console.log('  提示：这是 DEMO 演示数据的报告，不能当作真实 AI 回答结论。');
    return 0;
  });
}

/** runs：列出历史运行及评分。 */
async function cmdRuns(flags) {
  const slug = brandSlug(flags);
  const limit = intFlag(flags.limit, 'limit', 20);
  return withStore((store) => {
    const brand = requireBrand(store, slug);
    const runs = store.listRuns(brand.id, limit);
    const rows = runs.map((run) => {
      const score = store.getScore(run.id);
      return {
        runId: run.id,
        kind: run.kind,
        status: run.status,
        samples: `${run.okN ?? 0}/${run.plannedN ?? 0}`,
        total: score?.total ?? null,
        level: score?.level ?? (run.status === 'done' ? '未评分' : '样本不足'),
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      };
    });
    if (flags.json) {
      console.log(JSON.stringify({ brand: slug, runs: rows }, null, 2));
      return 0;
    }
    console.log(`品牌：${brand.name}（${slug}） · 共 ${rows.length} 条运行记录`);
    if (rows.length === 0) {
      console.log('暂无运行记录。先跑一轮诊断：');
      console.log(`  node bin/geo.js diagnose --brand ${slug} --engines mock --limit 12`);
      return 0;
    }
    console.log('');
    printTable(
      ['run', '类型', '状态', '样本', '总分', '等级', '开始时间'],
      rows.map((row) => [
        `#${row.runId}`,
        row.kind,
        row.status,
        row.samples,
        row.total === null ? '—' : String(row.total),
        row.level,
        formatDateTime(row.startedAt),
      ]),
    );
    console.log('');
    console.log(`查看报告：node bin/geo.js report --run <id>`);
    return 0;
  });
}



/** 可见度分析：引用源 / 竞品份额 / 曝光质量 / 情感。默认取最近一轮。 */
async function cmdInsights(flags) {
  const slug = brandSlug(flags);
  const { analyzeRun, renderInsightsMarkdown } = await import('../lib/analytics.js');
  if (!fs.existsSync(dbPath())) {
    throw new CliError('数据库还不存在', ['先跑：node bin/geo.js init --brand ' + slug]);
  }
  const store = openStore(dbPath());
  try {
    const brand = store.getBrand(slug);
    if (!brand) throw new CliError(`品牌「${slug}」还没有初始化`, [`先跑：node bin/geo.js init --brand ${slug}`]);

    let runId = intFlag(flags.run, 'run', null);
    if (!runId) {
      const latest = store.listRuns(brand.id, 1);
      runId = latest.length ? latest[0].runId ?? latest[0].id : null;
    }
    if (!runId) throw new CliError('还没有任何运行记录', ['先跑一轮诊断：node bin/geo.js diagnose --engines mock --limit 12']);

    const detail = store.getRunDetail(runId);
    if (!detail) throw new CliError(`找不到 run #${runId}`);
    const insights = analyzeRun({ brand, rows: detail.rows });

    if (flags.json) {
      console.log(JSON.stringify({ runId, ...insights }, null, 2));
      return 0;
    }
    console.log(`Run #${runId} · ${brand.name} 可见度分析`);
    for (const line of renderInsightsMarkdown(insights)) console.log(line);
    return 0;
  } finally {
    store.close();
  }
}


/** 生成 AEO 资产：llms.txt / robots.txt / JSON-LD，默认写到 data/aeo/。 */
async function cmdAeo(flags) {
  const slug = brandSlug(flags);
  const { buildAeoBundle } = await import('../lib/aeo-assets.js');

  let brand = {};
  try {
    brand = JSON.parse(fs.readFileSync(brandPath(slug), 'utf8'));
  } catch {
    throw new CliError(`读不到品牌配置 brands/${slug}.json`, ['先跑：node bin/geo.js init --brand ' + slug]);
  }

  const baseUrl =
    stringFlag(flags['base-url'], 'base-url')
    ?? (Array.isArray(brand.urls) ? brand.urls[0] : undefined)
    ?? brand.url;

  const outDir = stringFlag(flags.out, 'out') ?? path.join(DATA_DIR, 'aeo');

  const services = (Array.isArray(brand.services) ? brand.services : []).map((name) => ({ name }));
  // 常见问题优先用品牌配置里的 evidenceFacts 释义；没有就留空（不编造）
  const bundle = buildAeoBundle({ brand, baseUrl, services, faqs: [], pages: [] });

  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const [fileName, content] of Object.entries(bundle.files)) {
    const target = path.join(outDir, fileName);
    fs.writeFileSync(target, content, 'utf8');
    written.push(target);
  }

  if (flags.json) {
    console.log(JSON.stringify({ outDir, files: written, warnings: bundle.warnings }, null, 2));
    return 0;
  }

  console.log(`已生成 AEO 资产（${written.length} 个文件）→ ${outDir}`);
  for (const file of written) console.log(`  ${path.basename(file)}`);
  if (bundle.warnings.length) {
    console.log('');
    console.log('注意事项：');
    for (const warning of bundle.warnings) console.log(`  ! ${warning}`);
  }
  console.log('');
  console.log('下一步（把文件放到站点根目录）：');
  console.log('  · llms.txt、robots.txt → 网站根目录，robots.txt 必须返回 200 纯文本');
  console.log('  · schema-*.json 的内容 → 用 <script type="application/ld+json"> 嵌进对应页面 <head>');
  console.log('  · 放完后再跑：node bin/geo.js audit --url <站点> 复检');
  return 0;
}


/** 从关键词文本猜意图（报价权重用），猜不出按 what。 */
function inferIntent(term) {
  const text = String(term ?? '');
  if (/多少钱|报价|价格|费用|收费/u.test(text)) return 'price';
  if (/对比|哪个好|vs|比较/u.test(text)) return 'compare';
  if (/怎么|如何|流程/u.test(text)) return 'howto';
  if (/哪家|有哪些|推荐|本地|附近/u.test(text)) return 'city';
  if (/坑|风险|避雷|注意/u.test(text)) return 'risk';
  return 'what';
}

/** 报价：输入「关键词[:难度],关键词[:难度]」，输出篇数、金额、成本与毛利。 */
async function cmdQuote(flags) {
  const { buildQuote, renderQuoteMarkdown } = await import('../lib/quote.js');
  const raw = stringFlag(flags.keywords, 'keywords');
  if (!raw) {
    throw new CliError('缺少 --keywords', [
      '用法示例：node bin/geo.js quote --keywords "芜湖内容代运营多少钱:7,内容代运营怎么选:5"',
      '难度可填 0-10 或 low/medium/high；不填按 5 处理',
    ]);
  }

  const items = raw
    .split(',')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const lastColon = chunk.lastIndexOf(':');
      if (lastColon > 0) {
        const term = chunk.slice(0, lastColon).trim();
        const difficulty = chunk.slice(lastColon + 1).trim();
        return { term, intent: inferIntent(term), difficulty };
      }
      return { term: chunk, intent: inferIntent(chunk) };
    });

  if (!items.length) throw new CliError('--keywords 里没有解析出有效关键词');

  const band = stringFlag(flags.band, 'band') ?? 'standard';
  const taxRate = flags.tax === undefined ? 0 : Number(flags.tax);
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1) {
    throw new CliError('--tax 需要 0-1 之间的小数，例如 0.06');
  }

  const quote = buildQuote({ items, band, taxRate });
  if (flags.json) {
    console.log(JSON.stringify(quote, null, 2));
    return 0;
  }
  console.log(renderQuoteMarkdown(quote));
  if (quote.warnings?.length) {
    console.log('注意：');
    for (const warning of quote.warnings) console.log(`  ! ${warning}`);
  }
  return 0;
}


/** Top10 行动 + 30 天计划：默认取最近一轮，与报告第七章同源。 */
async function cmdPlan(flags) {
  const slug = brandSlug(flags);
  const { analyzeRun } = await import('../lib/analytics.js');
  const { buildActionPlan, renderActionPlanMarkdown } = await import('../lib/action-plan.js');
  if (!fs.existsSync(dbPath())) {
    throw new CliError('数据库还不存在', ['先跑：node bin/geo.js init --brand ' + slug]);
  }
  const store = openStore(dbPath());
  try {
    const brand = store.getBrand(slug);
    if (!brand) throw new CliError(`品牌「${slug}」还没有初始化`, [`先跑：node bin/geo.js init --brand ${slug}`]);

    let runId = intFlag(flags.run, 'run', null);
    if (!runId) {
      const latest = store.listRuns(brand.id, 1);
      runId = latest.length ? latest[0].runId ?? latest[0].id : null;
    }
    if (!runId) throw new CliError('还没有任何运行记录', ['先跑一轮诊断：node bin/geo.js diagnose --engines mock --limit 12']);

    const detail = store.getRunDetail(runId);
    if (!detail) throw new CliError(`找不到 run #${runId}`);
    const score = store.getScore(runId);
    const insights = analyzeRun({ brand, rows: detail.rows });
    const plan = buildActionPlan({
      brand,
      score,
      insights,
      rows: detail.rows,
      competitors: insights.sov?.competitors ?? [],
    });

    if (flags.json) {
      console.log(JSON.stringify({ runId, ...plan }, null, 2));
      return 0;
    }
    console.log(`Run #${runId} · ${brand.name} 行动清单`);
    console.log('');
    console.log(renderActionPlanMarkdown(plan));
    return 0;
  } finally {
    store.close();
  }
}

/** 自动出题：三层 × 六意图；--write 写进问题库（幂等去重）。 */
async function cmdQuestions(flags) {
  const slug = brandSlug(flags);
  const { generateQuestions, renderQuestionsMarkdown } = await import('../lib/questions-gen.js');

  let brand = {};
  try {
    brand = JSON.parse(fs.readFileSync(brandPath(slug), 'utf8'));
  } catch {
    throw new CliError(`读不到品牌配置 brands/${slug}.json`, ['先跑：node bin/geo.js init --brand ' + slug]);
  }

  const count = intFlag(flags.count, 'count', 24);
  const seed = intFlag(flags.seed, 'seed', 1);
  const { questions, warnings } = generateQuestions({ brand, count, seed });

  if (flags.json) {
    console.log(JSON.stringify({ count: questions.length, questions, warnings }, null, 2));
    return 0;
  }

  console.log(`为「${brand.name ?? slug}」生成 ${questions.length} 题（seed=${seed}）`);
  if (warnings.length) {
    console.log('注意：');
    for (const warning of warnings) console.log(`  ! ${warning}`);
  }
  console.log('');
  console.log(renderQuestionsMarkdown(questions));

  if (flags.write) {
    const store = openStore(dbPath());
    try {
      const brandRow = store.getBrand(slug) ?? store.upsertBrand({ ...brand, slug });
      const brandId = brandRow.id ?? brandRow;
      const inserted = store.seedQuestions(brandId, questions);
      console.log('');
      console.log(`已写入问题库：新增 ${Array.isArray(inserted) ? inserted.length : '若干'} 条（已存在的题目自动跳过）`);
    } finally {
      store.close();
    }
  } else {
    console.log('');
    console.log('提示：加 --write 可把题目写进问题库（已存在的会自动跳过）。');
  }
  return 0;
}


/** 生成定时任务配置：诊断（周） + 监测（日）。只生成文本，不擅自改用户的 crontab。 */
async function cmdSchedule(flags) {
  const slug = brandSlug(flags);
  const engines = stringFlag(flags.engines, 'engines') ?? 'live';
  const limit = intFlag(flags.limit, 'limit', 20);
  const nodeBin = process.execPath;
  const cli = path.join(APP_ROOT, 'bin', 'geo.js');
  const logFile = path.join(DATA_DIR, 'cron.log');
  const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

  // cron 里不能依赖交互式 shell 的 cwd / PATH，所以用绝对路径 + 显式 cd
  const cmd = (args) =>
    `cd ${quote(APP_ROOT)} && ${quote(nodeBin)} ${quote(cli)} ${args} >> ${quote(logFile)} 2>&1`;

  const lines = [
    '# ── 恒野 GEO 定时任务（复制到 crontab -e；也可用 --write 生成安装脚本）──',
    `# 品牌：${slug} ｜ 引擎：${engines} ｜ 生成时间：${new Date().toISOString()}`,
    '',
    '# 每天 07:12 监测：复跑核心题并与上一轮对比（续费依据就是这条曲线）',
    `12 7 * * * ${cmd(`monitor --brand ${slug} --engines ${engines} --limit ${limit}`)}`,
    '',
    '# 每周一 06:12 全量诊断：产出一份新的诊断报告（含 Top10 行动 + 30 天计划）',
    `12 6 * * 1 ${cmd(`diagnose --brand ${slug} --engines ${engines} --limit 50`)}`,
    '',
  ];

  // 官网体检要跑在真实域名上：生成时就把域名写进去，避免 crontab 里做命令替换（sh 兼容性坑）
  let brandUrl = '';
  try {
    const brandConfig = JSON.parse(fs.readFileSync(brandPath(slug), 'utf8'));
    brandUrl = (Array.isArray(brandConfig.urls) ? brandConfig.urls[0] : '') || brandConfig.url || '';
  } catch {
    brandUrl = '';
  }
  if (brandUrl) {
    lines.push(
      '',
      '# 每月 1 号 05:12 官网体检：防止改版后把 AI 爬虫挡回去',
      `12 5 1 * * ${cmd(`audit --url ${brandUrl}`)}`,
    );
  } else {
    lines.push(
      '',
      '# 每月 1 号 05:12 官网体检：先在 brands/' + slug + '.json 里填 urls，再重新生成本配置',
    );
  }

  if (flags.json) {
    console.log(JSON.stringify({ crontab: lines, logFile }, null, 2));
    return 0;
  }

  console.log(`恒野 GEO 定时任务（品牌 ${slug}）`);
  console.log('');
  console.log(lines.join('\n'));
  console.log('');
  console.log('安装方式（任选其一）：');
  console.log('  1) 复制上面 3 行到终端执行：crontab -e');
  console.log('  2) 用 --write 生成可直接执行的安装脚本（会先注释掉旧的本项目任务）');
  console.log(`日志：${logFile}`);

  if (flags.write) {
    const dir = path.join(DATA_DIR, 'cron');
    fs.mkdirSync(dir, { recursive: true });
    const scriptFile = path.join(dir, 'install-hengye-geo-cron.sh');
    const script = [
      '#!/bin/bash',
      '# 由 恒野 GEO 生成：安装定时任务（会备份现有 crontab）',
      'set -euo pipefail',
      'BACKUP="$HOME/crontab.backup.$(date +%Y%m%d%H%M%S)"',
      'crontab -l > "$BACKUP" 2>/dev/null || true',
      'echo "已备份到 $BACKUP"',
      '# 先移除本项目旧任务，避免重复执行',
      "crontab -l 2>/dev/null | grep -v 'bin/geo.js' | crontab - || true",
      'TMP="$(mktemp)"',
      "crontab -l > \"$TMP\" 2>/dev/null || true",
      ...lines.filter((line) => line && !line.startsWith('# ──')).map((line) => `echo ${JSON.stringify(line)} >> "$TMP"`),
      'crontab "$TMP"',
      'rm -f "$TMP"',
      'echo "已安装恒野 GEO 定时任务"',
    ].join('\n');
    fs.writeFileSync(scriptFile, `${script}\n`, 'utf8');
    fs.chmodSync(scriptFile, 0o755);
    console.log('');
    console.log(`安装脚本已写入：${scriptFile}`);
    console.log(`  先看内容：cat ${scriptFile}`);
    console.log(`  确认后执行：bash ${scriptFile}`);
  }

  return 0;
}


/**
 * 端到端闭环验收：把 10 个步骤依次真实跑一遍（子进程调用本 CLI，不模拟）。
 *
 * 为什么用子进程而不是直接调函数：这样验收的是「用户真正会敲的命令」，
 * 任何一步在命令行下跑不通，这里就会失败——避免「库函数能跑、CLI 不能跑」的假绿。
 */
async function cmdDemo(flags) {
  const slug = brandSlug(flags);
  const limit = intFlag(flags.limit, 'limit', 12);
  const questionCount = intFlag(flags.questions, 'questions', 24);
  const cliPath = path.join(APP_ROOT, 'bin', 'geo.js');

  const runStep = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [cliPath, ...args], {
        cwd: APP_ROOT,
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

  const parseJson = (stdout) => {
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(stdout.slice(start, end + 1));
    } catch {
      return null;
    }
  };

  const steps = [];
  const record = (key, label, result, summary, extra = {}) => {
    steps.push({
      key,
      label,
      ok: result.code === 0,
      exitCode: result.code,
      summary,
      ...extra,
      output: `${result.stdout}\n${result.stderr}`.trim().slice(-600),
    });
  };

  if (!flags.json) {
    console.log(`恒野 GEO 端到端闭环验收（品牌 ${slug} · 引擎 mock · ${limit} 题）`);
    console.log('');
  }

  // 1) 建库 + 品牌 + 种子题
  let result = await runStep(['init', '--brand', slug]);
  record('init', '建库与品牌初始化', result, '数据库、品牌、种子问题就绪');

  // 2) 自动出题并入库
  result = await runStep(['questions', '--brand', slug, '--count', String(questionCount), '--write', '--json']);
  const generated = parseJson(result.stdout);
  record('questions', '自动出题（三层×六意图）', result, generated ? `生成 ${generated.count} 题` : '出题结果待解析');

  // 3) 诊断（mock，不花一分钱）
  result = await runStep(['diagnose', '--brand', slug, '--engines', 'mock', '--limit', String(limit), '--json']);
  const diagnose = parseJson(result.stdout);
  const runId = diagnose?.runId ?? diagnose?.run?.id ?? null;
  record('diagnose', '诊断：采集→判定→评分→报告', result, runId ? `run #${runId}` : '未取到 runId', { runId });

  // 4) 可见度分析
  result = await runStep(['insights', '--brand', slug, ...(runId ? ['--run', String(runId)] : []), '--json']);
  const insights = parseJson(result.stdout);
  record(
    'insights',
    '可见度分析（引用源/SoV/fan-out/证据等级）',
    result,
    insights ? `提及率 ${(insights.sample?.mentionRate ?? 0) * 100}% · 证据 A${insights.evidence?.A ?? 0}/B${insights.evidence?.B ?? 0}/C${insights.evidence?.C ?? 0}` : '分析结果待解析',
  );

  // 5) 行动清单
  result = await runStep(['plan', '--brand', slug, ...(runId ? ['--run', String(runId)] : []), '--json']);
  const plan = parseJson(result.stdout);
  record('plan', 'Top10 行动 + 30 天计划', result, plan ? `${plan.top10?.length ?? 0} 条行动` : '计划待解析');

  // 6) 关键词
  result = await runStep(['keywords', '--brand', slug, '--json']);
  const keywordPayload = parseJson(result.stdout);
  record('keywords', '关键词挖掘', result, keywordPayload ? '关键词簇已落库' : '关键词待解析');

  // 7) brief
  result = await runStep(['brief', '--brand', slug, '--keyword', '内容代运营', '--json']);
  let contentId = parseJson(result.stdout)?.contentId ?? null;
  if (!contentId) {
    // 关键词不在库里就退化：用第一个已入库关键词再试一次
    const list = await runStep(['keywords', '--brand', slug, '--json']);
    const payload = parseJson(list.stdout);
    const firstTerm = payload?.keywords?.[0]?.term ?? payload?.[0]?.term ?? null;
    if (firstTerm) {
      result = await runStep(['brief', '--brand', slug, '--keyword', firstTerm, '--json']);
      contentId = parseJson(result.stdout)?.contentId ?? null;
    }
  }
  record('brief', '内容 brief（证据优先）', result, contentId ? `content #${contentId}` : '未取到 contentId', { contentId });

  // 8) 写稿 + 四道闸
  if (contentId) {
    result = await runStep(['write', '--brand', slug, '--content', String(contentId), '--engines', 'none', '--json']);
    const writePayload = parseJson(result.stdout);
    record(
      'write',
      '写稿 + 篇幅/存在感/标题/七维终审',
      result,
      writePayload
        ? `状态 ${writePayload.status} · 终审 ${writePayload.review?.total ?? '—'} 分`
          + (writePayload.contracts ? ` · 合同${writePayload.contracts.ok ? '通过' : '阻断'}` : '')
        : '写稿结果待解析',
    );

    // 9) 发布（dry_run）
    result = await runStep(['publish', '--brand', slug, '--content', String(contentId), '--channel', '知乎专栏', '--json']);
    const publishPayload = parseJson(result.stdout);
    record(
      'publish',
      '发布登记（渠道三态 · dry_run）',
      result,
      publishPayload ? `回执 ${publishPayload.channelOutcome?.receipt?.receiptId ?? '已生成'}` : '发布待解析',
    );
  } else {
    record('write', '写稿 + 四道闸', { code: 1, stdout: '', stderr: '缺少 contentId，跳过' }, '跳过（未生成 brief）');
    record('publish', '发布登记（dry_run）', { code: 1, stdout: '', stderr: '缺少 contentId，跳过' }, '跳过');
  }

  // 10) 监测（对比上一轮）
  result = await runStep(['monitor', '--brand', slug, '--engines', 'mock', '--limit', String(Math.min(limit, 12)), '--json']);
  record('monitor', '效果监测（对比上一轮）', result, '监测完成');

  const okCount = steps.filter((step) => step.ok).length;
  const summary = {
    brand: slug,
    engines: 'mock',
    steps,
    okCount,
    total: steps.length,
    ok: okCount === steps.length,
    finishedAt: new Date().toISOString(),
  };

  // 落一份验收报告
  const reportDir = path.join(DATA_DIR, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportFile = path.join(reportDir, `demo-${stamp}.md`);
  const lines = [
    `# 端到端闭环验收（${slug}）`,
    '',
    `- 时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    `- 引擎：mock（演示数据，不花一分钱）`,
    `- 结果：${okCount} / ${steps.length} 步通过`,
    '',
    '| # | 步骤 | 结果 | 摘要 |',
    '| --- | --- | --- | --- |',
    ...steps.map((step, index) => `| ${index + 1} | ${step.label} | ${step.ok ? '✅' : '❌'} | ${step.summary} |`),
    '',
    '## 失败详情',
    '',
    ...(steps.filter((step) => !step.ok).length
      ? steps
          .filter((step) => !step.ok)
          .flatMap((step) => [`### ${step.label}`, '', '```', step.output, '```', ''])
      : ['无']),
  ];
  fs.writeFileSync(reportFile, `${lines.join('\n')}\n`, 'utf8');

  if (flags.json) {
    console.log(JSON.stringify({ ...summary, reportFile }, null, 2));
    return summary.ok ? 0 : 1;
  }

  for (const [index, step] of steps.entries()) {
    console.log(`${step.ok ? '✔' : '✖'} ${index + 1}. ${step.label} —— ${step.summary}`);
    if (!step.ok) {
      for (const line of step.output.split('\n').slice(-6)) console.log(`    ${line}`);
    }
  }
  console.log('');
  console.log(`${okCount === steps.length ? '✅ 闭环全部通过' : `⚠️ ${steps.length - okCount} 步失败`}（${okCount}/${steps.length}）`);
  console.log(`验收报告：${reportFile}`);
  return summary.ok ? 0 : 1;
}


/**
 * 离线重判：判定规则（尤其是实体消歧配置）改完后，不用重新采集就能重算。
 * 真实场景：AI 引用了同名公司，改完 rejectedNames/disambiguation 后，
 * 重跑一轮要花钱且答案会变（引擎本身有随机性），离线重判才能做「同数据 A/B」。
 */
async function cmdRejudge(flags) {
  const runId = intFlag(flags.run, 'run', undefined);
  if (runId === undefined) {
    throw new CliError('缺少 --run <id>', [
      '用法：node bin/geo.js rejudge --run <id>',
      '先运行：node bin/geo.js runs --brand hengye 查看可用 runId',
    ]);
  }
  const judgeModule = await import('../lib/judge.js');
  const scoreModule = await import('../lib/score.js');

  const summary = await withStore((store) => {
    const detail = store.getRunDetail(runId);
    if (!detail) throw new CliError(`run #${runId} 不存在`);
    const brand = detail.brand;

    const countVerdicts = (rows) =>
      rows.reduce((acc, row) => {
        const key = row.judgment?.verdict ?? 'null';
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});

    const before = countVerdicts(detail.rows);
    const changes = [];
    for (const row of detail.rows) {
      const previous = row.judgment?.verdict ?? null;
      const verdict = judgeModule.judgeAnswer({
        text: row.answer.text,
        status: row.answer.status,
        brand,
        engineId: row.answer.engine,
      });
      store.saveJudgment(row.answer.id, verdict);
      if (previous !== verdict.verdict) {
        changes.push({
          question: row.question.text,
          from: previous,
          to: verdict.verdict,
          reason: (verdict.reasons ?? []).at(-1) ?? '',
        });
      }
    }

    const updated = store.getRunDetail(runId);
    const score = scoreModule.scoreRun({
      rows: updated.rows,
      plannedN: updated.run.plannedN ?? updated.rows.length,
    });
    store.saveScore(runId, score);

    return {
      runId,
      changed: changes.length,
      changes,
      before,
      after: countVerdicts(updated.rows),
      score: { total: score.total, level: score.level, coverage: score.coverage },
    };
  });

  if (flags.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Run #${runId} 离线重判完成：${summary.changed} 条判定发生变化`);
    console.log(`  判定前：${JSON.stringify(summary.before)}`);
    console.log(`  判定后：${JSON.stringify(summary.after)}`);
    console.log(`  新评分：${summary.score.total ?? '样本不足'} · ${summary.score.level}`);
    for (const change of summary.changes.slice(0, 12)) {
      console.log(`  · ${change.question.slice(0, 30)}：${change.from} → ${change.to}`);
      if (change.reason) console.log(`      ${truncate(change.reason, 90)}`);
    }
    if (summary.changes.length > 12) console.log(`  · 其余 ${summary.changes.length - 12} 条略（--json 看全部）`);
  }

  // 判定与评分都变了，报告要跟着重渲染
  await cmdReport({ run: String(runId) });
  return 0;
}


/** 短视频脚本：把内容转成可拍摄脚本（对标摘星AI 的 AI 短视频矩阵）。 */
async function cmdVideo(flags) {
  const slug = brandSlug(flags);
  const contentId = intFlag(flags.content, 'content', undefined);
  if (contentId === undefined) {
    throw new CliError('缺少 --content <内容 id>', [
      '先用 brief 生成内容：node bin/geo.js brief --brand ' + slug + ' --keyword "<词>"',
      '再写稿：node bin/geo.js write --brand ' + slug + ' --content <id>',
    ]);
  }
  let mod;
  try {
    mod = await import('../lib/video-script.js');
  } catch (error) {
    throw new CliError('短视频脚本模块不可用（lib/video-script.js）', [`详情：${error?.message ?? error}`]);
  }

  return withStore(async (store) => {
    const brand = store.getBrand(slug);
    if (!brand) throw new CliError(`品牌「${slug}」还没有初始化`);
    const content = store.listContents(brand.id).find((item) => item.id === contentId);
    if (!content) throw new CliError(`content #${contentId} 不存在`);

    let body = String(content.bodyMd ?? content.bodyMarkdown ?? content.body ?? '');
    if (!body) {
      const draftFile = path.join(DATA_DIR, 'drafts', `${contentId}.md`);
      if (fs.existsSync(draftFile)) body = fs.readFileSync(draftFile, 'utf8');
    }
    if (!body.trim()) {
      throw new CliError(`content #${contentId} 还没有正文`, [`先写稿：node bin/geo.js write --brand ${slug} --content ${contentId}`]);
    }

    const style = stringFlag(flags.style, 'style') ?? '口播科普';
    const duration = intFlag(flags.duration, 'duration', 60);
    const script = mod.buildVideoScript({
      title: String(content.title ?? ''),
      body,
      brief: content.brief ?? {},
      brand,
      style,
      durationSec: duration,
    });

    const dir = path.join(DATA_DIR, 'videos');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${contentId}.md`);
    fs.writeFileSync(file, mod.renderVideoScriptMarkdown(script), 'utf8');

    // 可拍摄包：SRT 字幕 + 分镜 CSV（零配置也能用，直接丢进剪映/人工拍摄）
    let shootFiles = null;
    try {
      const pkgMod = await import('../lib/shoot-package.js');
      const pkg = pkgMod.exportShootPackage(script);
      const srtFile = path.join(dir, `${contentId}.srt`);
      const csvFile = path.join(dir, `${contentId}-分镜.csv`);
      fs.writeFileSync(srtFile, pkg.srt, 'utf8');
      fs.writeFileSync(csvFile, pkg.csv, 'utf8');
      shootFiles = { srt: srtFile, csv: csvFile };
    } catch {
      shootFiles = null;
    }

    if (flags.json) {
      console.log(JSON.stringify({ contentId, file, script }, null, 2));
      return 0;
    }
    console.log(mod.renderVideoScriptMarkdown(script));
    console.log('');
    console.log(`已写入：${file}`);
    if (shootFiles) {
      console.log(`可拍摄包：${shootFiles.srt}`);
      console.log(`            ${shootFiles.csv}`);
    }
    return 0;
  });
}

/** SEO 体检：传统 SEO + 短视频 SEO（对标摘星AI 的「GEO+SEO+短视频SEO」）。 */
async function cmdSeo(flags) {
  const target = stringFlag(flags.url, 'url');
  if (!target) {
    throw new CliError('缺少 --url <网址>', ['用法：node bin/geo.js seo --url https://sanrenxing.cn [--keyword "内容代运营"]']);
  }
  let mod;
  try {
    mod = await import('../lib/seo-check.js');
  } catch (error) {
    throw new CliError('SEO 检查模块不可用（lib/seo-check.js）', [`详情：${error?.message ?? error}`]);
  }
  const keyword = stringFlag(flags.keyword, 'keyword') ?? '';
  console.error(`正在检查 SEO：${target}`);
  const result = await mod.fetchAndAnalyzeSeo(target, { keyword });
  if (result && result.ok === false) {
    throw new CliError(`SEO 检查失败：${result.error ?? '未知错误'}`);
  }
  const dir = path.join(DATA_DIR, 'seo');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'latest.json');
  fs.writeFileSync(file, JSON.stringify({ target, keyword, ...result }, null, 2), 'utf8');

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  console.log(mod.renderSeoMarkdown(result));
  console.log('');
  console.log(`已写入：${file}`);
  return 0;
}


/** 内容矩阵分发：一条内容投多个渠道（默认 dry_run，配了 webhook 才能真发）。 */
async function cmdDistribute(flags) {
  const slug = brandSlug(flags);
  const contentId = intFlag(flags.content, 'content', undefined);
  const all = Boolean(flags.all);
  if (contentId === undefined && !all) {
    throw new CliError('缺少 --content <id>（或 --all 分发全部内容）', [
      '用法：node bin/geo.js distribute --content 3 --channels 知乎专栏,今日头条',
      '或：node bin/geo.js distribute --all',
    ]);
  }

  let mod;
  try {
    mod = await import('../lib/publish-channels.js');
  } catch (error) {
    throw new CliError('渠道模块不可用（lib/publish-channels.js）', [`详情：${error?.message ?? error}`]);
  }

  const live = Boolean(flags.live);
  const channelFlag = stringFlag(flags.channels, 'channels');

  return withStore(async (store) => {
    const brand = store.getBrand(slug);
    if (!brand) throw new CliError(`品牌「${slug}」还没有初始化`);
    const contents = store.listContents(brand.id);
    const targets = all ? contents : contents.filter((item) => item.id === contentId);
    if (!targets.length) throw new CliError(`没有可分发的内容（content #${contentId} 不存在或还没生成）`);

    const channels = mod.listChannels({ env: process.env });
    const selected = channelFlag
      ? channelFlag
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean)
          .map((name) => {
            const hit = channels.find((c) => c.name === name || c.id === name.toLowerCase());
            if (!hit) throw new CliError(`未知渠道「${name}」`, [`可用：${channels.map((c) => c.name).join('、')}`]);
            return hit;
          })
      : channels;

    const results = [];
    for (const content of targets) {
      let body = String(content.bodyMd ?? content.bodyMarkdown ?? content.body ?? '');
      if (!body) {
        const draftFile = path.join(DATA_DIR, 'drafts', `${content.id}.md`);
        if (fs.existsSync(draftFile)) body = fs.readFileSync(draftFile, 'utf8');
      }
      for (const channel of selected) {
        const outcome = await mod.publishTo({
          channel: channel.id,
          content: { title: String(content.title ?? ''), body, contentId: content.id },
          dryRun: !live,
          env: process.env,
        });
        if (outcome.ok) {
          store.createPublication({
            contentId: content.id,
            channel: channel.name,
            url: outcome.receipt?.url ?? null,
            status: live && channel.state === 'api' ? 'published' : 'dry_run',
          });
        }
        results.push({
          contentId: content.id,
          channel: channel.name,
          state: outcome.state,
          ok: outcome.ok,
          reason: outcome.reason ?? null,
          receiptId: outcome.receipt?.receiptId ?? null,
        });
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    if (flags.json) {
      console.log(JSON.stringify({ contentCount: targets.length, channelCount: selected.length, okCount, results }, null, 2));
      return 0;
    }

    console.log(`分发完成：${targets.length} 条内容 × ${selected.length} 个渠道 = ${results.length} 次，成功 ${okCount}`);
    const rows = results.map((r) => [
      `#${r.contentId}`,
      r.channel,
      r.state,
      r.ok ? '成功' : `失败：${r.reason ?? ''}`,
      r.receiptId ?? '—',
    ]);
    printTable(['内容', '渠道', '状态', '结果', '回执'], rows);
    console.log('');
    console.log(live ? '真实发布模式：只有已接入 API 的渠道会真正发出。' : '当前是 dry_run：只登记与出回执，未真实发稿。加 --live 才真发。');
    return 0;
  });
}


/** 客户分享链接：给客户看的只读报告（token 即凭证，可到期与吊销）。 */
async function cmdShare(flags) {
  const slug = brandSlug(flags);
  return withStore(async (store) => {
    const brand = requireBrand(store, slug);

    if (flags.revoke) {
      const token = stringFlag(flags.revoke, 'revoke');
      const ok = store.revokeShare(token);
      store.writeAudit({ actor: 'cli', brandSlug: slug, action: 'share_revoke', detail: token.slice(0, 10) });
      console.log(ok ? `已吊销：${token.slice(0, 8)}…` : `没找到该链接：${token.slice(0, 8)}…`);
      return ok ? 0 : 1;
    }

    if (flags.list) {
      const shares = store.listShares(brand.id);
      if (!shares.length) {
        console.log('还没有分享链接。用：node bin/geo.js share --run <id> --days 30');
        return 0;
      }
      if (flags.json) {
        console.log(JSON.stringify(shares, null, 2));
        return 0;
      }
      printTable(
        ['token', '运行', '创建', '到期', '状态'],
        shares.map((item) => [
          `${item.token.slice(0, 10)}…`,
          item.runId === null ? '最新' : `#${item.runId}`,
          String(item.createdAt).slice(0, 10),
          item.expiresAt ? String(item.expiresAt).slice(0, 10) : '长期',
          item.revoked ? '已吊销' : '有效',
        ]),
      );
      return 0;
    }

    const runId = intFlag(flags.run, 'run', undefined);
    const days = intFlag(flags.days, 'days', 30);
    const created = store.createShare({ brandId: brand.id, runId: runId ?? null, days });
    store.writeAudit({ actor: 'cli', brandSlug: slug, action: 'share_create', detail: `run=${runId ?? 'latest'} days=${days}` });
    const base = (stringFlag(flags.base, 'base') ?? process.env.GEO_PUBLIC_URL ?? '').replace(/\/+$/u, '');
    const url = base ? `${base}/s/${created.token}` : `/s/${created.token}`;

    if (flags.json) {
      console.log(JSON.stringify({ ...created, url }, null, 2));
      return 0;
    }
    console.log('✔ 分享链接已生成（只读，客户免登录可看）');
    console.log(`  链接：${url}`);
    if (!base) {
      console.log('  提示：没配 GEO_PUBLIC_URL 也没传 --base，给出的是相对路径；');
      console.log('        部署后用：node bin/geo.js share --run <id> --base https://你的域名');
    }
    console.log(`  运行：${runId === null ? '该品牌最新一轮' : `#${runId}`} · 到期：${created.expiresAt ? created.expiresAt.slice(0, 10) : '长期'}`);
    console.log(`  吊销：node bin/geo.js share --revoke ${created.token}`);
    return 0;
  });
}


/** 客户周报：对比上一轮，生成 Markdown + HTML，可推送到 webhook。 */
async function cmdWeekly(flags) {
  const slug = brandSlug(flags);
  let weeklyMod;
  try {
    weeklyMod = await import('../lib/weekly.js');
  } catch (error) {
    throw new CliError('周报模块不可用（lib/weekly.js）', [`详情：${error?.message ?? error}`]);
  }

  return withStore(async (store) => {
    const brand = requireBrand(store, slug);
    const rows = store.listRuns(brand.id, 30);
    if (!rows.length) {
      throw new CliError('还没有运行数据', ['先跑一轮：node bin/geo.js diagnose --brand ' + slug + ' --engines mock --limit 12']);
    }
    // listRuns 返回的是 id/okN，总分要单独查（与 dashboard 同一口径）
    const runs = rows.map((r) => {
      const score = store.getScore(r.id);
      return {
        runId: r.id,
        kind: r.kind,
        status: r.status,
        samples: r.okN ?? r.samples ?? null,
        total: score?.total ?? null,
        level: score?.level ?? null,
        startedAt: r.startedAt ?? '',
      };
    });

    const latest = runs.find((r) => r.total !== null && r.total !== undefined) ?? runs[0];
    const detail = store.getRunDetail(latest.runId);
    const insights = detail ? (await import('../lib/analytics.js')).analyzeRun({ brand, rows: detail.rows }) : null;
    // 周报模块从 insights.score 读总分，这里补上（analyzeRun 本身不含分数）
    if (insights) insights.score = store.getScore(latest.runId);

    let previous = null;
    const prevRow = runs.find((r) => r.runId !== latest.runId);
    if (prevRow) {
      const prevDetail = store.getRunDetail(prevRow.runId);
      if (prevDetail) {
        previous = (await import('../lib/analytics.js')).analyzeRun({ brand, rows: prevDetail.rows });
        previous.score = store.getScore(prevRow.runId);
      }
    }

    let plan = null;
    if (insights) {
      const planMod = await import('../lib/action-plan.js');
      plan = planMod.buildActionPlan({
        brand,
        score: store.getScore(latest.runId),
        insights,
        rows: detail?.rows ?? [],
        competitors: insights.sov?.competitors ?? [],
      });
    }

    const report = weeklyMod.buildWeeklyReport({
      brand,
      runs,
      insights,
      previous,
      plan,
      generatedAt: new Date().toISOString(),
    });
    store.writeAudit({ actor: 'cli', brandSlug: slug, action: 'weekly_generate', detail: `runs=${runs.length}` });
    const markdown = weeklyMod.renderWeeklyMarkdown(report);
    const htmlText = weeklyMod.renderWeeklyHtml(report);

    const dir = path.join(DATA_DIR, 'reports');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const mdFile = path.join(dir, `weekly-${slug}-${stamp}.md`);
    const htmlFile = path.join(dir, `weekly-${slug}-${stamp}.html`);
    fs.writeFileSync(mdFile, markdown, 'utf8');
    fs.writeFileSync(htmlFile, htmlText, 'utf8');

    // 推送：--push 或环境变量 WEEKLY_WEBHOOK（企微/钉钉/邮件网关都行）
    const webhook = stringFlag(flags.push, 'push') ?? String(process.env.WEEKLY_WEBHOOK ?? '').trim();
    let pushed = null;
    if (webhook) {
      try {
        const res = await fetch(webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: report.title, markdown, html: htmlText }),
        });
        pushed = { ok: res.ok, status: res.status };
      } catch (error) {
        pushed = { ok: false, error: String(error?.message ?? error) };
      }
    }

    if (flags.json) {
      console.log(JSON.stringify({ report, files: { md: mdFile, html: htmlFile }, pushed }, null, 2));
      return 0;
    }
    console.log(markdown);
    console.log('');
    console.log(`已写入：${mdFile}`);
    console.log(`        ${htmlFile}`);
    if (pushed) console.log(pushed.ok ? `已推送 webhook（HTTP ${pushed.status}）` : `推送失败：${pushed.error ?? pushed.status}`);
    return 0;
  });
}

// ---------------------------------------------------- doctor / audit / serve
// 这三个命令解决的是「装完之后怎么用起来」，不是采集主链路，因此单独成段。

/** 环境自检：把「离能跑真实数据还差什么」逐项列出来。 */
async function cmdDoctor(flags) {
  loadEnv();
  const { runDoctor } = await import('../lib/doctor.js');
  const report = await runDoctor({
    env: process.env,
    probe: Boolean(flags.probe),
    brandSlug: brandSlug(flags),
  });

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  const ICON = { blocker: '✖', warn: '!', info: '·' };
  console.log(`恒野 GEO · 环境自检（Node v${process.versions.node}）`);
  console.log('');
  for (const check of report.checks) {
    const icon = check.ok ? '✔' : (ICON[check.level] ?? '?');
    console.log(`${icon} ${check.title}`);
    console.log(`    ${check.detail}`);
    if (!check.ok && check.action) console.log(`    → ${check.action}`);
  }
  if (report.probeNote) {
    console.log('');
    console.log('真实调用探测：');
    for (const line of String(report.probeNote).split('\n')) console.log(`  ${line}`);
  }
  console.log('');
  console.log(report.ok ? '结论：可以跑 live 诊断了。' : '结论：还有阻塞项，按上面的 → 处理后重跑本命令。');
  return report.ok ? 0 : 1;
}

/** 官网 AI 可抓取性体检。没有 --url 时自动取品牌配置里的第一个网址。 */
async function cmdAudit(flags) {
  let target = stringFlag(flags.url, 'url');
  if (!target) {
    try {
      const brand = JSON.parse(fs.readFileSync(brandPath(brandSlug(flags)), 'utf8'));
      target = (Array.isArray(brand.urls) ? brand.urls : [])[0] ?? brand.site ?? brand.url ?? '';
    } catch {
      target = '';
    }
  }
  if (!target) {
    throw new CliError('没有可体检的网址', [
      '用法：node bin/geo.js audit --url https://sanrenxing.cn',
      `或在 brands/${brandSlug(flags)}.json 里配置 urls 数组`,
    ]);
  }

  let mod;
  try {
    mod = await import('../lib/audit-site.js');
  } catch (error) {
    throw new CliError('官网体检模块不可用（lib/audit-site.js 未能加载）', [
      `详情：${error?.message ?? error}`,
    ]);
  }

  // --json 时把进度写 stderr，保证 stdout 是纯 JSON（否则下游 JSON.parse 会失败）
  if (flags.json) console.error(`正在体检：${target}`);
  else console.log(`正在体检：${target}`);
  const result = await mod.auditSite(target);

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.score >= 60 ? 0 : 1;
  }

  console.log('');
  console.log(`可抓取评分：${result.score} / 100（${result.level}）`);
  console.log(`  HTTPS：${result.https?.ok ? '通' : '不通'}（${result.https?.status ?? '—'}）`);
  console.log(`  AI 爬虫：${(result.aiCrawlers ?? []).filter((c) => !c.blocked).length}/${(result.aiCrawlers ?? []).length} 可进`);
  console.log(`  llms.txt：${result.llmsTxt?.found ? '有' : '无'} · sitemap：${result.sitemap?.found ? '有' : '无'}`);
  console.log(`  JSON-LD：${result.schema?.jsonLdCount ?? 0} 段`);

  if (Array.isArray(result.findings) && result.findings.length) {
    console.log('');
    console.log('待修问题（阻塞项优先处理）：');
    for (const finding of result.findings) {
      const label = finding.level === 'blocker' ? '【阻塞】' : finding.level === 'warn' ? '【建议】' : '【提示】';
      console.log(`  ${label}${finding.title}`);
      console.log(`     ${finding.detail}`);
      if (finding.fix) console.log(`     修复：${finding.fix}`);
    }
  }

  const outFile = stringFlag(flags.out, 'out');
  if (outFile) {
    const lines = [
      `# 官网 AI 可抓取性体检：${result.url}`,
      '',
      `- 评分：${result.score} / 100（${result.level}）`,
      `- 体检时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
      `- HTTPS：${result.https?.ok ? '通' : '不通'}（${result.https?.status ?? '—'}）`,
      '',
      '## 待修问题',
      '',
      '| 级别 | 问题 | 详情 | 修复 |',
      '| --- | --- | --- | --- |',
      ...result.findings.map(
        (f) => `| ${f.level} | ${f.title} | ${String(f.detail).replace(/\|/g, '/')} | ${String(f.fix).replace(/\|/g, '/')} |`,
      ),
      '',
    ];
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
    console.log('');
    console.log(`已写入：${path.resolve(outFile)}`);
  }

  return result.score >= 60 ? 0 : 1;
}

/** 启动本地网页控制台。 */
async function cmdServe(flags) {
  loadEnv();
  const port = intFlag(flags.port, 'port', 8787);
  const { startServer } = await import('../lib/server.js');
  const { url, close } = await startServer({ port, brand: brandSlug(flags) });

  console.log(`恒野 GEO 控制台已启动：${url}`);
  console.log('  跑诊断 / 看报告 / 查问题库 / 体检官网都在这个页面里。');
  console.log('  按 Ctrl+C 停止。');

  if (!flags['no-open']) {
    try {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
      const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
      spawn(opener, args, { stdio: 'ignore', detached: true }).unref();
    } catch {
      console.log('  （自动打开浏览器失败，请手动访问上面的地址）');
    }
  }

  // 保持进程存活，直到用户 Ctrl+C
  await new Promise((resolve) => {
    const stop = () => {
      close().finally(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  console.log('');
  console.log('控制台已停止。');
  return 0;
}

// ---------------------------------------------------------------------- 入口

const HANDLERS = {
  init: cmdInit,
  diagnose: cmdDiagnose,
  keywords: cmdKeywords,
  brief: cmdBrief,
  write: cmdWrite,
  publish: cmdPublish,
  monitor: cmdMonitor,
  report: cmdReport,
  runs: cmdRuns,
  insights: cmdInsights,
  aeo: cmdAeo,
  video: cmdVideo,
  seo: cmdSeo,
  distribute: cmdDistribute,
  share: cmdShare,
  weekly: cmdWeekly,
  quote: cmdQuote,
  plan: cmdPlan,
  questions: cmdQuestions,
  schedule: cmdSchedule,
  rejudge: cmdRejudge,
  demo: cmdDemo,
  serve: cmdServe,
  doctor: cmdDoctor,
  audit: cmdAudit,
};

function printError(error) {
  if (error instanceof CliError) {
    console.error(`✖ ${error.message}`);
    for (const hint of error.hints) console.error(`  ${hint}`);
    return;
  }
  console.error(`✖ 命令执行失败：${error?.message ?? error}`);
  if (process.env.GEO_DEBUG) console.error(error?.stack);
  else console.error('  提示：设置环境变量 GEO_DEBUG=1 可查看完整堆栈。');
}

export async function main(argv = process.argv.slice(2)) {
  const { command, flags } = parseArgv(argv);
  if (!command || command === 'help' || flags.help) {
    console.log(HELP);
    return 0;
  }
  const handler = HANDLERS[command];
  if (!handler) {
    console.error(`✖ 未知命令：${command}`);
    console.error(`  可用命令：${Object.keys(HANDLERS).join(' / ')}`);
    console.error('  运行 node bin/geo.js --help 查看完整说明。');
    process.exitCode = 1;
    return 1;
  }
  try {
    const code = await handler(flags);
    if (typeof code === 'number') process.exitCode = code;
    return code ?? 0;
  } catch (error) {
    printError(error);
    process.exitCode = 1;
    return 1;
  }
}

const isCliEntry =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCliEntry) {
  await main();
}
