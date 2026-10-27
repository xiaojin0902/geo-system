/**
 * lib/pipeline.js — 六步流程的编排（服务端与 CLI 共用同一套逻辑）
 */
import { askEngine, engineReady } from './engines.js';
import { judgeAnswer, analyzeRows, scoreOf, buildActions } from './analyze.js';
import { buildDeliveryPlan } from './plan.js';
import { buildBrief, buildDraft } from './content.js';
import { renderReportHtml } from './deliver.js';
import fs from 'node:fs';
import path from 'node:path';

/** 客户默认问题：优先用客户事实里登记的，否则按行业/城市生成 */
export function defaultQuestions(client = {}) {
  const industry = client.industry || '服务';
  const city = client.city || '本地';
  const facts = client.facts ?? {};
  if (Array.isArray(facts.questions) && facts.questions.length) return facts.questions;
  return [
    `${industry}哪家好？`,
    `${city}${industry}多少钱？`,
    `${industry}怎么选？`,
    `${industry}靠谱吗？`,
    `${industry}服务包含什么？`,
  ];
}

/** 采集 + 判定 + 评分（返回本轮结果） */
export async function runDiagnose({ store, cycleId, client, engine = 'mock', limit = 5, env = process.env }) {
  const ready = engineReady(engine, env);
  if (!ready.ready) throw new Error(`引擎不可用：${ready.reason}`);
  const questions = defaultQuestions(client).slice(0, Math.max(1, Math.min(30, limit)));
  const runId = store.createRun({ cycleId, engine, questions });
  for (const question of questions) {
    const answer = await askEngine({ id: engine, question, client, env });
    const judged = answer.status === 'engine_error'
      ? { verdict: 'engine_error', matched: '', reasons: [answer.error ?? ''] }
      : judgeAnswer({ text: answer.text, client });
    store.saveAnswer({
      runId, question, engine,
      text: answer.text, citations: answer.citations, mode: answer.mode, latencyMs: answer.latencyMs,
      verdict: judged.verdict, matched: judged.matched, reasons: judged.reasons,
    });
  }
  store.finishRun(runId);
  return collectCycle({ store, cycleId, client });
}

/** 汇总一个周期的数据（行/分析/评分），评分缺失时按规则现算 */
export function collectCycle({ store, cycleId, client = null }) {
  const cycle = store.getCycle(cycleId);
  const owner = client ?? store.getClientById(cycle.clientId);
  const runs = store.listRuns(cycleId);
  const rows = runs.flatMap((run) => store.listRunRows(run.id));
  const analysis = analyzeRows({ rows, client: owner });
  const score = store.latestScore(cycleId) ?? scoreOf(analysis);
  return { cycle, client: owner, runs, rows, analysis, score };
}

/** 生成六步待办（第一次诊断后调用） */
export function ensurePlan({ store, cycleId }) {
  const existing = store.listTasks(cycleId);
  if (existing.length) return existing;
  const collected = collectCycle({ store, cycleId });
  const actions = buildActions({ analysis: collected.analysis, client: collected.client });
  const plan = buildDeliveryPlan({ client: collected.client, analysis: collected.analysis, actions, period: collected.cycle.period });
  plan.tasks.unshift({
    step: 'diagnose', title: '诊断：已完成首轮采集', owner: '系统',
    dueAt: new Date().toISOString(), status: 'done', detail: `${collected.analysis.sample?.total ?? 0} 条样本`,
  });
  store.seedTasks(cycleId, plan.tasks);
  return store.listTasks(cycleId);
}

/** 生成一篇内容（brief → 初稿） */
export function generateContent({ store, cycleId }) {
  const collected = collectCycle({ store, cycleId });
  const question = defaultQuestions(collected.client)[0];
  const brief = buildBrief({ client: collected.client, question, analysis: collected.analysis });
  const draft = buildDraft({ brief, client: collected.client });
  const id = store.createContent({ cycleId, kind: 'article', title: draft.title, body: draft.body, facts: collected.client.facts });
  return { id, title: draft.title, body: draft.body };
}

/** 生成交付物：报告文件 + 分享 token */
export function generateDeliverables({ store, cycleId, dataDir, shareToken, days = 30 }) {
  const collected = collectCycle({ store, cycleId });
  const actions = buildActions({ analysis: collected.analysis, client: collected.client });
  const report = renderReportHtml({
    client: collected.client, cycle: collected.cycle,
    analysis: collected.analysis, score: collected.score, actions,
    contents: store.listContents(cycleId), publishes: store.listPublishes(cycleId),
  });
  const dir = path.join(dataDir, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `report-${cycleId}.html`);
  fs.writeFileSync(file, report, 'utf8');
  store.addDeliverable({ cycleId, kind: 'report', path: file });
  let token = null;
  if (typeof shareToken === 'function') {
    token = shareToken();
    store.addDeliverable({ cycleId, kind: 'share', token, expiresAt: new Date(Date.now() + days * 86400000).toISOString() });
  }
  return { file, token, actions };
}
