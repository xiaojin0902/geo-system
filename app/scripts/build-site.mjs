#!/usr/bin/env node
/**
 * scripts/build-site.mjs
 * 把 GEO 数据（SQLite + 报告）构建成可静态托管的「GEO 系统」。
 *
 * 为什么要静态化：GitHub Pages 只能托管静态文件，但 GEO 系统需要跑 Node + SQLite。
 * 解法是把「计算」放到 GitHub Actions（每天定时跑），把「结果」构建成静态站。
 * 于是：系统不需要服务器、永久免费、打开就是最新数据；历史报告按 run 归档可追溯。
 *
 * 用法：node scripts/build-site.mjs --out ../site-dist [--brand hengye]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, dbPath, loadEnv } from '../lib/config.js';
import { openStore } from '../lib/store.js';
import { analyzeRun } from '../lib/analytics.js';
import { buildActionPlan } from '../lib/action-plan.js';
import { listEngines, engineReadiness } from '../lib/engines/index.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { out: path.join(APP_ROOT, '..', 'site-dist'), brand: 'hengye' };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--out') args.out = path.resolve(argv[++i]);
    else if (token === '--brand') args.brand = argv[++i];
  }
  return args;
}

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const pct = (v) => `${((Number(v) || 0) * 100).toFixed(1)}%`;
const fmtTime = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  } catch {
    return String(iso);
  }
};

const CSS = `
:root{--bg:#0a0b0f;--panel:#12141b;--panel2:#171a23;--line:#252a36;--ink:#e9ecf3;--dim:#8b93a7;--dim2:#5f6779;
--accent:#7c5cff;--green:#22c55e;--amber:#f59e0b;--red:#ef4444;--cyan:#22d3ee}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.65 -apple-system,BlinkMacSystemFont,"SF Pro SC","PingFang SC","Microsoft YaHei",sans-serif}
a{color:inherit;text-decoration:none}
.nav{position:sticky;top:0;z-index:9;display:flex;align-items:center;gap:4px;padding:0 24px;height:52px;
background:rgba(10,11,15,.94);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
.nav .logo{font-weight:700;margin-right:16px}.nav .logo i{color:var(--accent);font-style:normal}
.nav a{padding:6px 12px;border-radius:8px;color:var(--dim);font-size:13px}
.nav a:hover{background:var(--panel);color:var(--ink)}
.nav a.on{background:rgba(124,92,255,.15);color:#b6a4ff}
.nav .sp{flex:1}.nav .tag{font-size:11px;color:var(--dim2);border:1px solid var(--line);padding:2px 8px;border-radius:99px}
.wrap{max-width:1180px;margin:0 auto;padding:28px 24px 80px}
h1{font-size:23px;margin:0 0 4px;letter-spacing:-.02em}
h2{font-size:15px;margin:30px 0 12px}
.sub{color:var(--dim2);font-size:12px}
.grid{display:grid;gap:14px}.g4{grid-template-columns:repeat(4,1fr)}.g2{grid-template-columns:repeat(2,1fr)}
.card{background:linear-gradient(160deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.card .k{color:var(--dim2);font-size:11px;letter-spacing:.06em;text-transform:uppercase}
.card .v{font-size:24px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums;margin-top:2px}
.card .v small{font-size:12px;font-weight:400;color:var(--dim)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--dim2);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.06em;padding:9px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:11px 10px;border-bottom:1px solid rgba(38,43,55,.6);vertical-align:top}
tr:hover td{background:rgba(124,92,255,.05)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:6px;white-space:nowrap}
.ok{background:rgba(34,197,94,.14);color:#4ade80}.warn{background:rgba(245,158,11,.14);color:#fbbf24}
.bad{background:rgba(239,68,68,.14);color:#f87171}.mut{background:rgba(139,147,167,.14);color:#a9b1c3}
.info{background:rgba(34,211,238,.12);color:#67e8f9}
.hint{border-left:3px solid var(--accent);background:rgba(124,92,255,.07);padding:12px 16px;border-radius:0 10px 10px 0;font-size:12.5px;color:#cfd5e3;line-height:1.7;margin:14px 0}
.empty{padding:26px;text-align:center;color:var(--dim2)}
.foot{margin-top:40px;border-top:1px solid var(--line);padding-top:16px;color:var(--dim2);font-size:11.5px;line-height:1.9}
@media(max-width:820px){.g4,.g2{grid-template-columns:1fr 1fr}}
`;

function layout({ title, active, body, brandName = '恒野 GEO', right = '' }) {
  const items = [
    ['index.html', '总览'],
    ['runs.html', '历史运行'],
    ['report.html', '最新报告'],
    ['questions.html', '问题库'],
    ['content.html', '内容库'],
    ['tools.html', '工具箱'],
    ['audit.html', '官网体检'],
    ['pipeline.html', '闭环验收'],
    ['ops.html', '操作台'],
    ['systems.html', '口径'],
  ];
  const nav = items
    .map(([href, label]) => `<a href="${href}" class="${href === active ? 'on' : ''}">${esc(label)}</a>`)
    .join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(brandName)}</title>
<meta name="robots" content="noindex,follow">
<style>${CSS}</style></head><body>
<div class="nav"><span class="logo">恒野 <i>GEO</i> 系统</span>${nav}<span class="sp"></span>
<span class="tag">${esc(right || brandName)}</span></div>
<div class="wrap">${body}</div></body></html>`;
}

function verdictBadge(v) {
  const map = {
    recommended: ['推荐', 'ok'],
    conditionally_recommended: ['条件推荐', 'ok'],
    candidate: ['候选', 'info'],
    listed: ['列入', 'info'],
    mentioned: ['仅提及', 'mut'],
    not_mentioned: ['未提及', 'bad'],
    ambiguous: ['歧义', 'warn'],
    unknown: ['未知', 'mut'],
    refused: ['拒答', 'warn'],
    engine_error: ['引擎错误', 'bad'],
  };
  const [label, cls] = map[v] ?? [v ?? '—', 'mut'];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function buildIndex({ brand, runs, latest, insights, plan, engines, generatedAt }) {
  const scoreCards = latest
    ? `<div class="grid g4">
    <div class="card"><div class="k">总分</div><div class="v">${latest.total ?? '—'}<small> / 100</small></div>
      <div class="sub">${esc(latest.level ?? '')} · run #${esc(latest.runId)}</div></div>
    <div class="card"><div class="k">提及率</div><div class="v">${pct(insights?.sample?.mentionRate)}</div>
      <div class="sub">有效 ${esc(insights?.sample?.ok ?? 0)} 条样本</div></div>
    <div class="card"><div class="k">自有站点引用占比</div><div class="v">${pct(insights?.citations?.ownShare)}</div>
      <div class="sub">共 ${esc(insights?.citations?.total ?? 0)} 条引用</div></div>
    <div class="card"><div class="k">竞品份额</div><div class="v">${pct(insights?.sov?.brandShare)}</div>
      <div class="sub">${esc((insights?.sov?.competitors ?? []).length)} 个竞品对比</div></div>
  </div>`
    : `<div class="card empty">还没有运行数据。等第一次定时任务跑完。</div>`;

  const verdictRows = insights?.verdictCounts
    ? `<table><thead><tr><th>判定</th><th>条数</th></tr></thead><tbody>${Object.entries(insights.verdictCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `<tr><td>${verdictBadge(k)}</td><td class="mono">${esc(v)}</td></tr>`)
        .join('')}</tbody></table>`
    : '';

  const sovRows = insights?.sov
    ? `<table><thead><tr><th>品牌</th><th>提及题数</th><th>份额</th></tr></thead><tbody>
      <tr><td><b>${esc(brand.name ?? '本品牌')}</b></td><td class="mono">${esc(insights.sov.brandMentions)}</td><td class="mono">${pct(insights.sov.brandShare)}</td></tr>
      ${(insights.sov.competitors ?? [])
        .map(
          (c) =>
            `<tr><td>${esc(c.name)}</td><td class="mono">${esc(c.mentions)}</td><td class="mono">${pct(c.share)}</td></tr>`,
        )
        .join('')}
    </tbody></table>`
    : '';

  const domainRows = insights?.citations?.byDomain?.length
    ? `<table><thead><tr><th>域名</th><th>被引</th><th>占比</th><th>类型</th></tr></thead><tbody>${insights.citations.byDomain
        .slice(0, 12)
        .map(
          (d) =>
            `<tr><td class="mono">${esc(d.domain)}</td><td class="mono">${esc(d.count)}</td><td class="mono">${pct(d.share)}</td><td><span class="badge ${
              d.type === 'own' ? 'ok' : d.type === 'registry' ? 'info' : d.sameName ? 'bad' : 'mut'
            }">${esc(d.typeLabel)}</span></td></tr>`,
        )
        .join('')}</tbody></table>`
    : `<div class="card empty">本轮没有可解析的引用来源。</div>`;

  const fanRows = insights?.fanout?.top?.length
    ? `<table><thead><tr><th>引擎改写出的检索词</th><th>次数</th><th>引擎</th></tr></thead><tbody>${insights.fanout.top
        .map(
          (f) =>
            `<tr><td>${esc(f.query)}</td><td class="mono">${esc(f.count)}</td><td class="sub">${esc((f.engines ?? []).join('、'))}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : `<div class="card empty">未采集到改写词。</div>`;

  const threatRows = insights?.sameNameThreats?.length
    ? insights.sameNameThreats.map((t) => `<li>${esc(t.message)}</li>`).join('')
    : '';

  const planRows = plan?.top10?.length
    ? plan.top10
        .map(
          (a) =>
            `<tr><td class="mono">${esc(a.rank)}</td><td><b>${esc(a.action)}</b><div class="sub">${esc(a.why)}</div>
             <div class="sub" style="margin-top:4px">证据：${esc(a.evidence)}</div></td>
             <td>${esc(a.owner)}</td><td>${esc(a.deadline)}</td></tr>`,
        )
        .join('')
    : '';

  const weekRows = plan?.days30?.length
    ? plan.days30
        .map(
          (w) =>
            `<tr><td class="mono">${esc(w.week)}</td><td><b>${esc(w.goal)}</b><div class="sub">${esc((w.tasks ?? []).join(' · '))}</div></td></tr>`,
        )
        .join('')
    : '';

  const engineRows = engines
    .map(
      (e) =>
        `<tr><td>${esc(e.label)}</td><td><span class="badge ${e.configured ? 'ok' : 'mut'}">${e.configured ? '已配置' : '未配置'}</span></td>
        <td class="sub">${esc(e.reason || '')}</td></tr>`,
    )
    .join('');

  const body = `
<h1>${esc(brand.name ?? '恒野')} · GEO 监测系统</h1>
<div class="sub">${esc([brand.city, brand.scope, brand.industry].filter(Boolean).join(' · '))} ｜ 数据生成于 ${esc(generatedAt)}</div>

${scoreCards}

<div class="hint">这是你自己的 GEO 系统：每天自动采集 AI 引擎的回答、判定品牌可见度、算引用源与竞品份额、生成行动清单。
历史报告在「历史运行」里按 run 归档；系统页面对搜索引擎封闭（noindex），只有拿到地址的人能看。</div>

<h2>判定分布（10 态）</h2>
${verdictRows || '<div class="card empty">暂无判定数据</div>'}

<h2>竞品份额（SoV）</h2>
${sovRows || '<div class="card empty">暂无竞品数据</div>'}

<h2>引用源分析</h2>
${domainRows}
${threatRows ? `<div class="hint" style="border-color:var(--red);background:rgba(239,68,68,.07)"><b>同名实体威胁</b><ul style="margin:6px 0 0;padding-left:20px">${threatRows}</ul></div>` : ''}

<h2>Query fan-out（引擎改写出的检索词）</h2>
${fanRows}

<h2>行动清单（Top10）</h2>
${planRows ? `<table><thead><tr><th>#</th><th>行动与证据</th><th>谁做</th><th>时限</th></tr></thead><tbody>${planRows}</tbody></table>` : '<div class="card empty">样本不足，暂不生成行动清单</div>'}

<h2>30 天计划</h2>
${weekRows ? `<table><thead><tr><th>周</th><th>目标与任务</th></tr></thead><tbody>${weekRows}</tbody></table>` : ''}

<h2>引擎状态</h2>
<table><thead><tr><th>引擎</th><th>状态</th><th>说明</th></tr></thead><tbody>${engineRows}</tbody></table>

<div class="foot">
  系统组成：采集（5 个中文引擎）→ 判定（10 态 + 实体消歧）→ 评分（三层加权）→ 可见度分析 → 行动清单 → 报告归档。<br>
  数据口径可复算：所有分数、份额、占比都由规则算出，不依赖模型拍板。本页由 GitHub Actions 每天自动重建。
</div>`;

  return layout({ title: '总览', active: 'index.html', body });
}

function buildRuns({ brand, runs, generatedAt }) {
  const rows = runs
    .map(
      (r) =>
        `<tr><td class="mono">#${esc(r.runId)}</td><td><span class="badge ${r.kind === 'live' ? 'info' : 'warn'}">${esc(r.kind)}</span></td>
        <td>${esc(r.status)}</td><td class="mono">${esc(r.samples ?? '—')}</td>
        <td class="mono">${r.total === null || r.total === undefined ? '—' : esc(r.total)}</td>
        <td>${esc(r.level ?? '—')}</td><td class="mono">${esc(fmtTime(r.startedAt))}</td>
        <td><a href="reports/run-${esc(r.runId)}.html" style="color:#b6a4ff">看报告</a></td></tr>`,
    )
    .join('');
  const body = `
<h1>历史运行</h1>
<div class="sub">共 ${esc(runs.length)} 轮 · 数据生成于 ${esc(generatedAt)}</div>
${
  runs.length
    ? `<table style="margin-top:16px"><thead><tr><th>运行</th><th>类型</th><th>状态</th><th>样本</th><th>总分</th><th>等级</th><th>时间</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : `<div class="card empty" style="margin-top:16px">还没有运行记录</div>`
}`;
  return layout({ title: '历史运行', active: 'runs.html', body });
}

function buildSystems({ engines, brand, generatedAt }) {
  const engineRows = engines
    .map(
      (e) =>
        `<tr><td>${esc(e.label)}</td><td class="mono">${esc(e.id)}</td>
         <td><span class="badge ${e.configured ? 'ok' : 'mut'}">${e.configured ? '已配置' : '未配置'}</span></td>
         <td class="sub">${esc(e.reason || '')}</td></tr>`,
    )
    .join('');
  const body = `
<h1>引擎与口径</h1>
<div class="sub">系统怎么算的，都在这一页 · 数据生成于 ${esc(generatedAt)}</div>

<h2>引擎清单</h2>
<table><thead><tr><th>引擎</th><th>ID</th><th>状态</th><th>说明</th></tr></thead><tbody>${engineRows}</tbody></table>
<div class="hint">配置方式：在仓库 Settings → Secrets and variables → Actions 里加对应的 API Key，定时任务会在下一轮使用。
DeepSeek 需要 <span class="mono">DEEPSEEK_API_KEY</span>；豆包还需 <span class="mono">DOUBAO_MODEL</span>（方舟推理接入点 ID）；元宝需中转地址 <span class="mono">YUANBAO_BASE_URL</span>。</div>

<h2>判定与评分口径</h2>
<table><thead><tr><th>环节</th><th>口径</th></tr></thead><tbody>
<tr><td>判定</td><td>10 态硬轴：推荐 / 条件推荐 / 列入 / 候选 / 仅提及 / 未提及 / 歧义 / 未知 / 拒答 / 引擎错误</td></tr>
<tr><td>权重</td><td>推荐 1.0 · 条件推荐 0.85 · 列入 0.7 · 候选 0.55 · 仅提及 0.4 · 未提及 0</td></tr>
<tr><td>排除</td><td>歧义/未知/拒答/引擎错误 <b>不进分母</b>，只进覆盖率（没测成 ≠ 0 分）</td></tr>
<tr><td>评分</td><td>三层加权 20/40/40（品牌认知 / 区域决策 / 场景拓展），覆盖率 &lt; 50% 不出总分</td></tr>
<tr><td>实体消歧</td><td>命中同名实体（如河南恒野农牧）且无本品牌线索 → 判未提及，不算你的可见度</td></tr>
<tr><td>引用源</td><td>按域名聚合；区分自有 / 工商企查 / 社媒 / 媒体 / 同名实体（同名实体不算机会）</td></tr>
<tr><td>证据等级</td><td>A=原话+可点开来源 · B=有原话无引用 · C=无原话</td></tr>
</tbody></table>

<div class="foot">品牌：${esc(brand.name ?? '')} ｜ 生成时间：${esc(generatedAt)}</div>`;
  return layout({ title: '引擎与口径', active: 'systems.html', body });
}


function buildQuestions({ brand, questions, generatedAt }) {
  const rows = questions
    .map(
      (q) =>
        `<tr><td class="mono">${esc(q.id)}</td><td>${esc(q.text)}</td>
         <td><span class="badge mut">${esc(q.intent ?? '—')}</span></td>
         <td>${esc(q.tier ?? '—')}</td><td>${esc(q.priority ?? '—')}</td></tr>`,
    )
    .join('');
  const body = `
<h1>问题库</h1>
<div class="sub">共 ${esc(questions.length)} 条 · 用户真实会问 AI 的问题（生成时已剔除品牌名，避免引导模型）· 生成于 ${esc(generatedAt)}</div>
${
  questions.length
    ? `<table style="margin-top:16px"><thead><tr><th>ID</th><th>问题</th><th>意图</th><th>层级</th><th>优先级</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<div class="card empty" style="margin-top:16px">问题库为空。到「操作台」跑一次 questions 生成题目。</div>`
}
<div class="hint">想看新题目：去 <a href="ops.html" style="color:#b6a4ff">操作台</a> → 在 GitHub Actions 里选 <span class="mono">action=questions</span>，跑完这里会自动更新。</div>`;
  return layout({ title: '问题库', active: 'questions.html', body });
}

function buildContent({ brand, contents, briefs, drafts, generatedAt }) {
  const rows = contents
    .map(
      (c) =>
        `<tr><td class="mono">#${esc(c.id)}</td><td>${esc(c.title ?? '—')}</td><td>${esc(c.format ?? '—')}</td>
         <td><span class="badge ${c.status === 'draft' ? 'info' : c.status === 'needs_review' ? 'warn' : c.status === 'published' ? 'ok' : 'mut'}">${esc(c.status ?? '—')}</span></td>
         <td class="mono">${esc((c.createdAt ?? '').slice(0, 10))}</td></tr>`,
    )
    .join('');
  const briefList = briefs.slice(0, 20).map((f) => `<li class="mono">${esc(f)}</li>`).join('');
  const draftList = drafts.slice(0, 20).map((f) => `<li class="mono">${esc(f)}</li>`).join('');
  const body = `
<h1>内容库</h1>
<div class="sub">brief → 写稿 → 四道闸（篇幅/存在感/标题/七维终审）→ 发布登记 · 生成于 ${esc(generatedAt)}</div>

<h2>内容记录（${esc(contents.length)}）</h2>
${
  contents.length
    ? `<table><thead><tr><th>ID</th><th>标题</th><th>文体</th><th>状态</th><th>创建</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<div class="card empty">还没有内容记录。到「操作台」跑 brief（需要先有 keywords）。</div>`
}

<h2>Brief 文件（${esc(briefs.length)}）</h2>
${briefList ? `<div class="card"><ul style="margin:0;padding-left:20px;line-height:1.9">${briefList}</ul></div>` : `<div class="card empty">暂无 brief</div>`}

<h2>草稿文件（${esc(drafts.length)}）</h2>
${draftList ? `<div class="card"><ul style="margin:0;padding-left:20px;line-height:1.9">${draftList}</ul></div>` : `<div class="card empty">暂无草稿</div>`}

<div class="hint">写稿与发布需要模型密钥（或模板模式）。发布默认 dry_run，只登记不真发；配 <span class="mono">PUBLISH_&lt;渠道&gt;_WEBHOOK</span> 才会真实调用。</div>`;
  return layout({ title: '内容库', active: 'content.html', body });
}

function buildAudit({ audit, generatedAt }) {
  const result = audit?.result ?? audit;
  let inner;
  if (!result || !result.url) {
    inner = `<div class="card empty">还没有体检结果。到「操作台」跑一次 <span class="mono">action=audit</span>。</div>`;
  } else {
    const findings = (result.findings ?? [])
      .map(
        (f) =>
          `<tr><td><span class="badge ${f.level === 'blocker' ? 'bad' : f.level === 'warn' ? 'warn' : 'mut'}">${esc(f.level)}</span></td>
           <td><b>${esc(f.title)}</b><div class="sub">${esc(f.detail)}</div>
           <div class="sub" style="margin-top:4px;color:#8b93a7">修复：${esc(f.fix)}</div></td></tr>`,
      )
      .join('');
    inner = `<div class="grid g4" style="margin-bottom:16px">
      <div class="card"><div class="k">可抓取评分</div><div class="v">${esc(result.score)}<small> / 100</small></div><div class="sub">${esc(result.level ?? '')}</div></div>
      <div class="card"><div class="k">HTTPS</div><div class="v">${result.https?.ok ? '通' : '不通'}</div><div class="sub">${esc(result.url)}</div></div>
      <div class="card"><div class="k">AI 爬虫</div><div class="v">${esc((result.aiCrawlers ?? []).filter((c) => !c.blocked).length)}<small> / ${esc((result.aiCrawlers ?? []).length)} 可进</small></div></div>
      <div class="card"><div class="k">llms / sitemap</div><div class="v" style="font-size:16px">${result.llmsTxt?.found ? '有' : '无'} · ${result.sitemap?.found ? '有' : '无'}</div></div>
    </div>
    ${findings ? `<table><thead><tr><th>级别</th><th>问题与修复</th></tr></thead><tbody>${findings}</tbody></table>` : `<div class="card empty">没有发现问题</div>`}`;
  }
  return layout({
    title: '官网体检',
    active: 'audit.html',
    body: `<h1>官网体检</h1><div class="sub">AI 爬虫能不能抓到你的网站 · 生成于 ${esc(generatedAt)}</div>${inner}`,
  });
}

function buildTools({ brand, generatedAt }) {
  const body = `
<h1>工具箱</h1>
<div class="sub">报价计算器（纯前端算，不联网）· 生成于 ${esc(generatedAt)}</div>

<h2>报价（关键词 → 篇数 → 金额与毛利）</h2>
<div class="card">
  <textarea id="kw" placeholder="每行一个：关键词:难度&#10;例：芜湖内容代运营多少钱:7&#10;　　内容代运营怎么选:5" style="width:100%;min-height:110px;background:#0a0b0f;color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:10px;font-family:ui-monospace,Menlo,monospace;font-size:12px"></textarea>
  <div class="row" style="display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap">
    <select id="band" style="background:#0a0b0f;color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:9px">
      <option value="lite">轻量（最少 5 篇，120 元/篇）</option>
      <option value="standard" selected>标准（最少 7 篇，180 元/篇）</option>
      <option value="deep">深度（最少 10 篇，260 元/篇）</option>
    </select>
    <button id="calc" style="background:var(--accent);color:#fff;border:0;border-radius:9px;padding:9px 16px;cursor:pointer">算报价</button>
  </div>
  <div id="out" style="margin-top:14px"></div>
</div>

<div class="hint">口径：篇数 = 难度 ≤3 → 3 篇、≤6 → 5 篇、否则 8 篇；不足档位下限按档位下限计。成本盘子：写作 20 + 发布 30 + 运营 10 = 60 元/篇。毛利 =（报价 − 成本）/ 报价。</div>

<script>
const BANDS = { lite:{min:5,price:120,label:'轻量'}, standard:{min:7,price:180,label:'标准'}, deep:{min:10,price:260,label:'深度'} };
const INTENT = { price:1.3, compare:1.2, howto:1.1, city:1.05, what:1.0, risk:0.9 };
const INTENT_LABEL = { price:'价格', compare:'对比', howto:'方法', city:'本地', what:'认知', risk:'风险' };
function guessIntent(t){ if(/多少钱|报价|价格|费用|收费/.test(t))return 'price'; if(/对比|哪个好|比较|vs/.test(t))return 'compare'; if(/怎么|如何|流程/.test(t))return 'howto'; if(/哪家|有哪些|推荐|本地|附近/.test(t))return 'city'; if(/坑|风险|避雷/.test(t))return 'risk'; return 'what'; }
function calc(){
  const band = BANDS[document.getElementById('band').value];
  const lines = document.getElementById('kw').value.split('\\n').map(s=>s.trim()).filter(Boolean).map(s=>{
    const i = s.lastIndexOf(':'); let term=s, diff=5;
    if(i>0){ term=s.slice(0,i).trim(); const d=Number(s.slice(i+1)); if(Number.isFinite(d)&&d>=0&&d<=10) diff=d; }
    const intent = guessIntent(term);
    let art = diff<=3?3:diff<=6?5:8;
    art = Math.max(art, band.min);
    const sub = art*band.price;
    return { term, intent, diff, art, sub };
  });
  if(!lines.length){ document.getElementById('out').innerHTML='<div class="empty">没有解析到关键词</div>'; return; }
  const subtotal = lines.reduce((s,l)=>s+l.sub,0);
  const articles = lines.reduce((s,l)=>s+l.art,0);
  const cost = articles*60;
  const margin = subtotal?((subtotal-cost)/subtotal*100).toFixed(1):'0.0';
  document.getElementById('out').innerHTML = '<table><thead><tr><th>关键词</th><th>意图</th><th>难度</th><th>篇数</th><th>单价</th><th>小计</th></tr></thead><tbody>'
    + lines.map(l=>'<tr><td>'+l.term+'</td><td>'+(INTENT_LABEL[l.intent]||l.intent)+'</td><td class="mono">'+l.diff+'</td><td class="mono">'+l.art+'</td><td class="mono">'+band.price+'</td><td class="mono">'+l.sub+'</td></tr>').join('')
    + '</tbody></table><div class="grid g4" style="margin-top:14px">'
    + '<div class="card"><div class="k">合计</div><div class="v">¥'+subtotal+'</div><div class="sub">'+articles+' 篇</div></div>'
    + '<div class="card"><div class="k">成本</div><div class="v">¥'+cost+'</div><div class="sub">60 元/篇</div></div>'
    + '<div class="card"><div class="k">毛利</div><div class="v">'+margin+'%</div><div class="sub">¥'+(subtotal-cost)+'</div></div>'
    + '<div class="card"><div class="k">档位</div><div class="v" style="font-size:18px">'+band.label+'</div></div></div>';
}
document.getElementById('calc').onclick = calc;
document.getElementById('kw').value = '芜湖内容代运营多少钱:7\\n内容代运营怎么选:5\\n本地起号陪跑:3';
calc();
</script>`;
  return layout({ title: '工具箱', active: 'tools.html', body });
}

function buildPipeline({ demoReport, generatedAt }) {
  const body = `
<h1>闭环验收</h1>
<div class="sub">建库 → 出题 → 诊断 → 分析 → 行动 → 关键词 → brief → 写稿 → 发布 → 监测（10 步）· 生成于 ${esc(generatedAt)}</div>
${
  demoReport
    ? `<div class="card" style="margin-top:16px"><div class="sub">最近一次：${esc(demoReport.name)}</div>
       <pre class="mono" style="white-space:pre-wrap;line-height:1.7;max-height:620px;overflow:auto;margin:10px 0 0">${esc(demoReport.content)}</pre></div>`
    : `<div class="card empty" style="margin-top:16px">还没有闭环验收记录。到「操作台」跑 <span class="mono">action=demo</span>。</div>`
}
<div class="hint">这一步验证「整条流水线能不能串起来」。真正每天跑的是诊断（geo.yml），这里用于排查哪一步断了。</div>`;
  return layout({ title: '闭环验收', active: 'pipeline.html', body });
}

function buildOps({ repoUrl, generatedAt }) {
  const body = `
<h1>操作台</h1>
<div class="sub">系统是静态站 + GitHub Actions 后端：功能靠触发工作流完成，结果自动回到本站在线更新 · ${esc(generatedAt)}</div>

<div class="hint">静态托管（GitHub Pages）跑不了 Node 服务，所以所有「要执行」的功能都做成 GitHub Actions：
你点一下 <b>Run workflow</b>，云端跑完会把数据提交回仓库并重新发布本站，约 1-3 分钟。</div>

<h2>① 每日自动（不用管）</h2>
<table><thead><tr><th>工作流</th><th>时间</th><th>做什么</th></tr></thead><tbody>
<tr><td><span class="mono">GEO 每日采集与发布</span></td><td>每天 07:12（北京时间）</td><td>真实引擎采集 12 题 → 判定 → 评分 → 分析 → 行动 → 重建站点</td></tr>
</tbody></table>

<h2>② 手动功能（点按钮）</h2>
<table><thead><tr><th>功能</th><th>怎么触发</th><th>参数</th></tr></thead><tbody>
<tr><td>跑一轮诊断</td><td rowspan="5"><a href="${esc(repoUrl)}/actions/workflows/ops.yml" style="color:#b6a4ff">打开操作工作流 → Run workflow</a></td><td><span class="mono">action=diagnose</span> · engines=live/mock · limit=12</td></tr>
<tr><td>官网可抓取体检</td><td><span class="mono">action=audit</span> · url=留空则用品牌配置</td></tr>
<tr><td>自动出题</td><td><span class="mono">action=questions</span></td></tr>
<tr><td>闭环验收（10 步）</td><td><span class="mono">action=demo</span> · limit=8</td></tr>
<tr><td>只重建站点</td><td><span class="mono">action=build</span></td></tr>
</tbody></table>

<h2>③ 看运行历史</h2>
<p><a href="${esc(repoUrl)}/actions" style="color:#b6a4ff">全部工作流运行记录</a>（含日志，失败能看原因）</p>

<h2>为什么不是网页上直接点</h2>
<p class="sub">GitHub Pages 只托管静态文件，没有服务端进程。要「网页上点一下就执行」，需要一台常驻服务器（Node + SQLite），成本约 ¥30/月；
或者用带登录的云函数方案。当前免费方案用 GitHub Actions 当后端，功能一样，只是入口在 GitHub。</p>

<h2>如果想升级成真·网页操作</h2>
<ul class="sub" style="line-height:2">
<li>方案 A：Render/Railway 免费或低价实例部署 <span class="mono">geo serve</span>（本地控制台有全部 8 个页面 + 立即执行），加 Basic Auth，约 ¥0-30/月</li>
<li>方案 B：Vercel + 外部数据库（Turso 免费版），serverless 执行短任务，长任务走队列</li>
<li>方案 C：继续用本方案，零成本，操作入口在 GitHub</li>
</ul>

<div class="foot">仓库：<a href="${esc(repoUrl)}" style="color:#b6a4ff">${esc(repoUrl.replace('https://github.com/', ''))}</a></div>`;
  return layout({ title: '操作台', active: 'ops.html', body });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnv();
  const generatedAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

  const outDir = args.out;
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'reports'), { recursive: true });

  let brand = { name: '恒野', city: '芜湖', scope: '全国线上交付', industry: '内容代运营' };
  let runs = [];
  let latest = null;
  let insights = null;
  let plan = null;
  let questions = [];
  let contents = [];
  let audit = null;
  let demoReport = null;

  if (fs.existsSync(dbPath())) {
    const store = openStore(dbPath());
    try {
      const brandRow = store.getBrand(args.brand);
      if (brandRow) {
        brand = { ...brand, ...brandRow };
        runs = store.listRuns(brandRow.id, 60).map((run) => {
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
        questions = store.listQuestions(brandRow.id).map((q) => ({
          id: q.id,
          text: q.text,
          intent: q.intent,
          tier: q.tier,
          priority: q.priority,
        }));
        contents = store.listContents(brandRow.id).map((c) => ({
          id: c.id,
          title: c.title,
          format: c.format,
          status: c.status,
          createdAt: c.createdAt,
        }));
        latest = runs.find((r) => r.total !== null) ?? runs[0] ?? null;
        if (latest) {
          const detail = store.getRunDetail(latest.runId);
          if (detail) {
            insights = analyzeRun({ brand: brandRow, rows: detail.rows });
            plan = buildActionPlan({
              brand: brandRow,
              score: store.getScore(latest.runId),
              insights,
              rows: detail.rows,
              competitors: insights.sov?.competitors ?? [],
            });
          }
        }
      }
    } finally {
      store.close();
    }
  }

  // 官网体检结果（由 ops 工作流写入）
  try {
    const auditFile = path.join(DATA_DIR, 'audit-latest.json');
    if (fs.existsSync(auditFile)) {
      const rawAudit = fs.readFileSync(auditFile, 'utf8');
      const start = rawAudit.indexOf('{');
      // 容错：CLI 可能在 JSON 前打印进度行，直接 parse 会失败
      audit = start >= 0 ? JSON.parse(rawAudit.slice(start)) : null;
    }
  } catch { audit = null; }

  // 最近一次闭环验收报告
  try {
    const reportDir2 = path.join(DATA_DIR, 'reports');
    if (fs.existsSync(reportDir2)) {
      const demos = fs
        .readdirSync(reportDir2)
        .filter((f) => /^demo-.*\.md$/.test(f))
        .sort();
      if (demos.length) {
        demoReport = { name: demos.at(-1), content: fs.readFileSync(path.join(reportDir2, demos.at(-1)), 'utf8') };
      }
    }
  } catch { demoReport = null; }

  let briefs = [];
  let drafts = [];
  try {
    const briefDir = path.join(DATA_DIR, 'briefs');
    if (fs.existsSync(briefDir)) briefs = fs.readdirSync(briefDir).filter((f) => f.endsWith('.md')).slice(0, 20);
    const draftDir = path.join(DATA_DIR, 'drafts');
    if (fs.existsSync(draftDir)) drafts = fs.readdirSync(draftDir).filter((f) => f.endsWith('.md')).slice(0, 20);
  } catch { /* 没有就留空 */ }

  const repoUrl = process.env.GEO_REPO_URL || 'https://github.com/xiaojin0902/geo-system';

  const engines = listEngines().map((meta) => {
    const readiness = meta.requiresKey ? engineReadiness(meta.id, process.env) : { ready: true, reason: '' };
    return { ...meta, configured: readiness.ready, reason: readiness.reason };
  });

  fs.writeFileSync(
    path.join(outDir, 'index.html'),
    buildIndex({ brand, runs, latest, insights, plan, engines, generatedAt }),
  );
  fs.writeFileSync(path.join(outDir, 'runs.html'), buildRuns({ brand, runs, generatedAt }));
  fs.writeFileSync(path.join(outDir, 'systems.html'), buildSystems({ engines, brand, generatedAt }));
  fs.writeFileSync(path.join(outDir, 'questions.html'), buildQuestions({ brand, questions, generatedAt }));
  fs.writeFileSync(path.join(outDir, 'content.html'), buildContent({ brand, contents, briefs, drafts, generatedAt }));
  fs.writeFileSync(path.join(outDir, 'tools.html'), buildTools({ brand, generatedAt }));
  fs.writeFileSync(path.join(outDir, 'audit.html'), buildAudit({ audit, generatedAt }));
  fs.writeFileSync(path.join(outDir, 'pipeline.html'), buildPipeline({ demoReport, generatedAt }));
  fs.writeFileSync(path.join(outDir, 'ops.html'), buildOps({ repoUrl, generatedAt }));

  // 最新报告 + 历史报告
  const reportDir = path.join(DATA_DIR, 'reports');
  let latestReport = null;
  if (fs.existsSync(reportDir)) {
    for (const file of fs.readdirSync(reportDir)) {
      if (/^run-\d+\.html$/.test(file)) {
        fs.copyFileSync(path.join(reportDir, file), path.join(outDir, 'reports', file));
      }
    }
    if (latest) {
      const candidate = path.join(reportDir, `run-${latest.runId}.html`);
      if (fs.existsSync(candidate)) latestReport = `reports/run-${latest.runId}.html`;
    }
  }
  if (latestReport) {
    fs.copyFileSync(path.join(outDir, latestReport), path.join(outDir, 'report.html'));
  } else {
    fs.writeFileSync(
      path.join(outDir, 'report.html'),
      layout({
        title: '最新报告',
        active: 'report.html',
        body: `<h1>最新报告</h1><div class="card empty">还没有生成诊断报告</div>`,
      }),
    );
  }

  // 系统对搜索引擎封闭（内部/客户系统），但允许 AI 引用说明
  fs.writeFileSync(
    path.join(outDir, 'robots.txt'),
    'User-agent: *\nDisallow: /\n\n# 这是内部/客户 GEO 系统，不对外收录\n',
  );
  fs.writeFileSync(
    path.join(outDir, 'llms.txt'),
    [
      '# 恒野 GEO 系统',
      '',
      '> 站内为品牌 AI 可见度监测数据，仅供客户查看，不对外收录。',
      '',
      '## 说明',
      '- 数据由规则计算，可复算：判定 10 态、三层加权评分、引用源聚合、竞品份额。',
      '- 本站已通过 robots.txt 禁止搜索引擎收录。',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(outDir, '404.html'),
    layout({ title: '页面不存在', body: '<h1>404</h1><div class="sub">没有这个页面</div>' }),
  );

  const files = fs.readdirSync(outDir);
  console.log(`构建完成：${outDir}`);
  console.log(`  页面：${files.filter((f) => f.endsWith('.html')).join(', ')}`);
  console.log(`  报告：${fs.readdirSync(path.join(outDir, 'reports')).length} 份`);
  console.log(`  数据：runs=${runs.length} latest=${latest ? latest.runId : 'none'} questions=${questions.length} contents=${contents.length}`);
  console.log(`  体检：${audit && audit.url ? audit.url + ' ' + audit.score + '分' : '无'} ｜ 闭环验收：${demoReport ? demoReport.name : '无'}`);
}

main();
