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
    ['systems.html', '引擎与口径'],
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
  console.log(`  数据：runs=${runs.length} latest=${latest ? latest.runId : 'none'}`);
}

main();
