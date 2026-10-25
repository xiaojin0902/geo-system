/**
 * lib/views.js
 * 本地控制台的 HTML 视图（纯函数，输入数据 → 输出完整 HTML 字符串）。
 *
 * 为什么独立成文件：视图没有副作用才好测（tests/views.test.js 只断言结构），
 * 服务端只负责路由和取数。所有字段都做 HTML 转义——题目、品牌名、错误信息
 * 都来自数据库或网络，不能直接拼进 HTML。
 *
 * 视觉约定：深色、单文件内联 CSS、无外部资源（离线可用、不依赖 CDN）。
 */

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const CSS = `
:root{--bg:#0b0c10;--panel:#14161d;--panel2:#1a1d26;--line:#262b37;--ink:#e9ecf3;--dim:#8d95a8;--dim2:#5d6577;
--accent:#7c5cff;--green:#22c55e;--amber:#f59e0b;--red:#ef4444;--cyan:#22d3ee}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.65 -apple-system,BlinkMacSystemFont,"SF Pro SC","PingFang SC","Microsoft YaHei",sans-serif}
a{color:inherit;text-decoration:none}
.nav{position:sticky;top:0;z-index:9;display:flex;align-items:center;gap:4px;padding:0 24px;height:52px;
background:rgba(11,12,16,.92);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
.nav .logo{font-weight:700;letter-spacing:-.01em;margin-right:16px}
.nav .logo i{color:var(--accent);font-style:normal}
.nav a{padding:6px 12px;border-radius:8px;color:var(--dim);font-size:13px}
.nav a:hover{background:var(--panel);color:var(--ink)}
.nav a.on{background:rgba(124,92,255,.15);color:#b6a4ff}
.nav .spacer{flex:1}
.badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:6px;white-space:nowrap}
.ok{background:rgba(34,197,94,.14);color:#4ade80}
.warn{background:rgba(245,158,11,.14);color:#fbbf24}
.bad{background:rgba(239,68,68,.14);color:#f87171}
.info{background:rgba(34,211,238,.12);color:#67e8f9}
.mut{background:rgba(141,149,168,.14);color:#a9b1c3}
.wrap{max-width:1120px;margin:0 auto;padding:28px 24px 72px}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.02em}
h2{font-size:15px;margin:28px 0 12px;color:var(--ink)}
.sub{color:var(--dim2);font-size:12px}
.grid{display:grid;gap:14px}
.g4{grid-template-columns:repeat(4,1fr)}
.g2{grid-template-columns:repeat(2,1fr)}
.card{background:linear-gradient(160deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.card .k{color:var(--dim2);font-size:11px;letter-spacing:.06em;text-transform:uppercase}
.card .v{font-size:24px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums;margin-top:2px}
.card .v small{font-size:12px;font-weight:400;color:var(--dim)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--dim2);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.06em;padding:9px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:11px 10px;border-bottom:1px solid rgba(38,43,55,.6);vertical-align:top}
tr:hover td{background:rgba(124,92,255,.05)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.btn{display:inline-flex;align-items:center;gap:7px;background:var(--accent);color:#fff;border:0;border-radius:9px;
padding:9px 16px;font-size:13px;font-weight:560;cursor:pointer;font-family:inherit}
.btn:hover{filter:brightness(1.1)}
.btn.ghost{background:var(--panel2);border:1px solid var(--line);color:var(--ink)}
.btn:disabled{opacity:.5;cursor:not-allowed}
select,input[type=text],input[type=search],input[type=url]{background:var(--panel);border:1px solid var(--line);
color:var(--ink);border-radius:9px;padding:9px 11px;font-size:13px;font-family:inherit;outline:none}
select:focus,input:focus{border-color:var(--accent)}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.hint{border-left:3px solid var(--amber);background:rgba(245,158,11,.07);padding:12px 16px;border-radius:0 10px 10px 0;
font-size:12.5px;color:#cfd5e3;line-height:1.7;margin:14px 0}
.hint b{color:#fbbf24}
.term{background:#07080c;border:1px solid var(--line);border-radius:10px;padding:14px 16px;font-family:ui-monospace,Menlo,monospace;
font-size:12px;line-height:1.7;white-space:pre-wrap;max-height:320px;overflow:auto;color:#c8d0e0}
.empty{padding:28px;text-align:center;color:var(--dim2);font-size:13px}
.pill{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
.footer{margin-top:36px;padding-top:18px;border-top:1px solid var(--line);color:var(--dim2);font-size:11.5px;line-height:1.9}
@media(max-width:820px){.g4{grid-template-columns:repeat(2,1fr)}.g2{grid-template-columns:1fr}}
`;

/**
 * 页面外壳。
 * @param {{title:string, active:string, body:string, brandName?:string, right?:string}} options
 */
export function layout({ title, active = '', body = '', brandName = '恒野', right = '' }) {
  const items = [
    ['/', '总览'],
    ['/run-diagnose', '跑诊断'],
    ['/insights', '可见度分析'],
    ['/tools', '工具箱'],
    ['/pipeline', '闭环验收'],
    ['/questions', '问题库'],
    ['/audit', '官网体检'],
    ['/doctor', '环境自检'],
  ];
  const nav = items
    .map(([href, label]) => `<a href="${href}" class="${href === active ? 'on' : ''}">${esc(label)}</a>`)
    .join('');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · 恒野 GEO</title>
<style>${CSS}</style></head>
<body>
<div class="nav">
  <span class="logo">恒野 <i>GEO</i></span>
  ${nav}
  <span class="spacer"></span>
  <span class="sub">${esc(brandName)}</span>
  ${right ? `<span style="margin-left:10px">${right}</span>` : ''}
</div>
<div class="wrap">${body}</div>
</body></html>`;
}

/**
 * 总览页。
 * @param {object} data
 */
export function dashboardPage({
  brand = {},
  runs = [],
  latest = null,
  keys = [],
  engines = [],
  counts = {},
  demoRuns = 0,
  liveRuns = 0,
}) {
  const configured = keys.filter((k) => k.present);
  const keyLine = keys.length
    ? keys
        .map(
          (k) =>
            `<span class="badge ${k.present ? 'ok' : 'bad'}">${esc(k.name)} ${k.present ? '已配置' : '未配置'}</span>`,
        )
        .join(' ')
    : '<span class="badge mut">无密钥配置</span>';

  const engineBadges = engines
    .map(
      (e) =>
        `<span class="badge ${e.configured ? 'ok' : 'mut'}">${esc(e.label ?? e.id)}</span>`,
    )
    .join(' ');

  const runRows = runs.length
    ? runs
        .map(
          (r) => `<tr>
        <td class="mono">#${esc(r.runId)}</td>
        <td><span class="badge ${r.kind === 'live' ? 'info' : 'warn'}">${esc(r.kind)}</span></td>
        <td>${esc(r.status)}</td>
        <td class="mono">${esc(r.samples ?? '—')}</td>
        <td class="mono">${r.total === null || r.total === undefined ? '—' : esc(r.total)}</td>
        <td>${esc(r.level ?? '—')}</td>
        <td class="mono">${esc((r.startedAt ?? '').replace('T', ' ').slice(0, 16))}</td>
        <td><a href="/run/${esc(r.runId)}" style="color:#b6a4ff">看报告</a></td>
      </tr>`,
        )
        .join('')
    : '';

  const latestCard =
    latest && latest.total !== null && latest.total !== undefined
      ? `<div class="card"><div class="k">最近一轮总分</div>
         <div class="v">${esc(latest.total)}<small> / 100</small></div>
         <div class="sub" style="margin-top:4px">${esc(latest.level ?? '')} · Run #${esc(latest.runId)}</div></div>`
      : `<div class="card"><div class="k">最近一轮总分</div>
         <div class="v" style="color:#5d6577">—</div>
         <div class="sub" style="margin-top:4px">还没有可用的评分</div></div>`;

  const body = `
<h1>${esc(brand.name ?? '恒野')} · GEO 控制台</h1>
<div class="sub">${esc([brand.city, brand.scope, brand.industry].filter(Boolean).join(' · ') || '品牌信息待补充')}</div>

${configured.length === 0
      ? `<div class="hint"><b>现在跑的是演示数据。</b>在 <span class="mono">hengye-geo/app/.env</span> 里填
         <span class="mono">DEEPSEEK_API_KEY</span>（或 DASHSCOPE_API_KEY），然后跑一轮 <b>live</b> 诊断，
         才是真实的 AI 搜索可见度。填完可以先点「环境自检」确认通不通。</div>`
      : ''}

<div class="grid g4" style="margin-top:18px">
  <div class="card"><div class="k">问题库</div><div class="v">${esc(counts.questions ?? 0)}<small> 题</small></div>
    <div class="sub" style="margin-top:4px">真实用户会问 AI 的问题</div></div>
  ${latestCard}
  <div class="card"><div class="k">历史运行</div><div class="v">${esc(counts.runs ?? 0)}<small> 轮</small></div>
    <div class="sub" style="margin-top:4px">demo ${esc(demoRuns)} · live ${esc(liveRuns)}</div></div>
  <div class="card"><div class="k">关键词 / 内容</div><div class="v">${esc(counts.keywords ?? 0)}<small> / ${esc(counts.contents ?? 0)}</small></div>
    <div class="sub" style="margin-top:4px">关键词簇 / 已生成内容</div></div>
</div>

<h2>引擎与密钥</h2>
<div class="card">
  <div class="row" style="margin-bottom:10px">${keyLine}</div>
  <div class="row">${engineBadges}</div>
  <div class="sub" style="margin-top:10px">密钥只在你本机的 <span class="mono">app/.env</span>，不会上传到任何地方。</div>
</div>

<h2>历史运行</h2>
${
    runs.length
      ? `<table><thead><tr><th>运行</th><th>类型</th><th>状态</th><th>样本</th><th>总分</th><th>等级</th><th>开始时间</th><th></th></tr></thead>
   <tbody>${runRows}</tbody></table>`
      : `<div class="card empty">还没有运行记录。先去「跑诊断」跑一轮（没有 Key 就用 demo 模式）。</div>`
  }

<div class="footer">
  数据文件：<span class="mono">app/data/geo.db</span> · 报告：<span class="mono">app/data/reports/</span><br>
  提示：<span class="mono">demo</span> 数据仅用于验证流程，报告顶部会标注「DEMO 演示数据」，不可作为对客户的结论。
</div>`;
  return layout({ title: '总览', active: '/', body, brandName: brand.name ?? '恒野' });
}

/**
 * 跑诊断页：一个表单 + 任务输出。
 * @param {{brand?:object, engines?:Array, running?:object|null}} data
 */
export function diagnosePage({ brand = {}, engines = [], running = null }) {
  // 只统计「需要密钥且已配置」的线上引擎：mock 永远可用，但不能算作能跑真实数据
  const configured = engines.filter((e) => e.requiresKey && e.configured);
  const options = [
    `<option value="mock">mock（演示数据，不调用任何 API）</option>`,
    `<option value="live">live（已配置的全部线上引擎）</option>`,
    ...engines
      .filter((e) => e.requiresKey && e.configured)
      .map((e) => `<option value="${esc(e.id)}">${esc(e.label)}（单引擎）</option>`),
  ].join('');

  const body = `
<h1>跑一轮诊断</h1>
<div class="sub">采集 → 判定 → 评分 → 出报告。一轮 30 题大约 1-3 分钟。</div>

${configured.length === 0
      ? `<div class="hint"><b>当前没有配置任何线上引擎密钥</b>，只能跑 demo 演示数据。
         想跑真实数据：在 <span class="mono">app/.env</span> 写入
         <span class="mono">DEEPSEEK_API_KEY=sk-...</span> 后重启控制台，或先点「环境自检」。</div>`
      : ''}

<div class="card" style="margin-top:16px">
  <div class="row">
    <label class="sub">引擎</label>
    <select id="engines">${options}</select>
    <label class="sub">题数</label>
    <select id="limit">
      <option value="12">12（快速试跑）</option>
      <option value="30" selected>30（标准）</option>
      <option value="50">50（全量）</option>
    </select>
    <button class="btn" id="go">开始诊断</button>
    <span id="state" class="sub"></span>
  </div>
</div>

<h2>运行输出</h2>
<div class="term" id="out">${running ? esc(running.stdout ?? '') : '（等待开始）'}</div>

<script>
const out = document.getElementById('out');
const state = document.getElementById('state');
const go = document.getElementById('go');
let timer = null;

function setRunning(on){
  go.disabled = on;
  state.textContent = on ? '运行中…' : '';
}

async function poll(id){
  const res = await fetch('/api/job?id=' + encodeURIComponent(id));
  const job = await res.json();
  out.textContent = job.stdout || '（无输出）';
  if(job.stderr) out.textContent += '\\n' + job.stderr;
  out.scrollTop = out.scrollHeight;
  if(job.status === 'running'){ timer = setTimeout(() => poll(id), 1200); return; }
  setRunning(false);
  state.innerHTML = job.exitCode === 0
    ? '✅ 完成，<a href="/" style="color:#b6a4ff">回总览看结果</a>'
    : '❌ 失败（退出码 ' + job.exitCode + '），详见上方输出';
}

go.addEventListener('click', async () => {
  clearTimeout(timer);
  out.textContent = '启动中…';
  setRunning(true);
  const payload = { engines: document.getElementById('engines').value, limit: Number(document.getElementById('limit').value) };
  const res = await fetch('/api/diagnose', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
  const data = await res.json();
  if(!res.ok){ setRunning(false); out.textContent = '启动失败：' + (data.error || res.status); return; }
  poll(data.job.id);
});
${running && running.status === 'running' ? `poll(${JSON.stringify(running.id)});` : ''}
</script>`;
  return layout({ title: '跑诊断', active: '/run-diagnose', body, brandName: brand.name ?? '恒野' });
}

/**
 * 问题库页。
 * @param {{brand?:object, questions?:Array}} data
 */
export function questionsPage({ brand = {}, questions = [] }) {
  const rows = questions
    .map(
      (q) => `<tr>
      <td class="mono">${esc(q.id)}</td>
      <td>${esc(q.text)}</td>
      <td><span class="badge mut">${esc(q.intent ?? '—')}</span></td>
      <td>${esc(q.tier ?? '—')}</td>
      <td>${esc(q.priority ?? '—')}</td>
      <td class="mono">${esc(q.source ?? '—')}</td>
    </tr>`,
    )
    .join('');
  const body = `
<h1>问题库</h1>
<div class="sub">用户真实会问 AI 的问题。诊断就是拿这些问题逐个问引擎，看答案里有没有你。</div>
<h2>共 ${esc(questions.length)} 题</h2>
${
    questions.length
      ? `<table><thead><tr><th>ID</th><th>问题</th><th>意图</th><th>层级</th><th>优先级</th><th>来源</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="card empty">问题库是空的。先跑 <span class="mono">geo init</span> 初始化。</div>`
  }`;
  return layout({ title: '问题库', active: '/questions', body, brandName: brand.name ?? '恒野' });
}

/**
 * 官网体检页。
 * @param {{brand?:object, url?:string, result?:object|null, error?:string|null}} data
 */
export function auditPage({ brand = {}, url = '', result = null, error = null }) {
  const levelBadge = (level) =>
    `<span class="badge ${level === 'blocker' ? 'bad' : level === 'warn' ? 'warn' : 'info'}">${esc(level)}</span>`;

  let resultHtml = '';
  if (error) {
    resultHtml = `<div class="card"><span class="badge bad">体检失败</span><div class="term" style="margin-top:10px">${esc(error)}</div></div>`;
  } else if (result) {
    const findings = (result.findings ?? [])
      .map(
        (f) => `<tr>
        <td>${levelBadge(f.level)}</td>
        <td><b>${esc(f.title)}</b><div class="sub">${esc(f.detail)}</div>
          <div class="sub" style="color:#8d95a8;margin-top:4px">修复：${esc(f.fix)}</div></td>
      </tr>`,
      )
      .join('');
    resultHtml = `
<div class="grid g4" style="margin:16px 0">
  <div class="card"><div class="k">可抓取评分</div><div class="v">${esc(result.score)}<small> / 100</small></div>
    <div class="sub" style="margin-top:4px">${esc(result.level ?? '')}</div></div>
  <div class="card"><div class="k">HTTPS</div><div class="v">${result.https?.ok ? '通' : '不通'}</div>
    <div class="sub" style="margin-top:4px">状态 ${esc(result.https?.status ?? '—')}</div></div>
  <div class="card"><div class="k">AI 爬虫</div><div class="v">${esc((result.aiCrawlers ?? []).filter((c) => !c.blocked).length)}<small> / ${esc((result.aiCrawlers ?? []).length)} 可进</small></div>
    <div class="sub" style="margin-top:4px">GPTBot / ClaudeBot / PerplexityBot / Bytespider…</div></div>
  <div class="card"><div class="k">结构化数据</div><div class="v">${esc(result.schema?.jsonLdCount ?? 0)}<small> 段 JSON-LD</small></div>
    <div class="sub" style="margin-top:4px">${esc((result.schema?.types ?? []).join('、') || '无')}</div></div>
</div>
${
      findings
        ? `<table><thead><tr><th>级别</th><th>问题与修复</th></tr></thead><tbody>${findings}</tbody></table>`
        : `<div class="card empty">没有发现阻塞项。</div>`
    }`;
  }

  const body = `
<h1>官网体检</h1>
<div class="sub">AI 爬虫抓不到你的网站，后面写再多的内容都不会被引用。这是 GEO 的物理前提。</div>
<div class="card" style="margin-top:16px">
  <form method="get" action="/audit" class="row">
    <input type="url" name="url" value="${esc(url)}" placeholder="https://sanrenxing.cn" style="min-width:320px;flex:1" required>
    <button class="btn" type="submit">开始体检</button>
  </form>
  <div class="sub" style="margin-top:8px">检查项：HTTPS / robots.txt / 各 AI 爬虫 UA 可达性 / llms.txt / sitemap / JSON-LD / 渲染依赖</div>
</div>
${resultHtml}`;
  return layout({ title: '官网体检', active: '/audit', body, brandName: brand.name ?? '恒野' });
}

/**
 * 可见度分析页：引用源 / 竞品份额 / 曝光质量 / 情感 / 引擎对比。
 * 数据来自 lib/analytics.js（纯规则、可复算），与报告第五章同源。
 * @param {{brand?:object, runs?:Array, runId?:number|null, insights?:object|null}} data
 */
export function insightsPage({ brand = {}, runs = [], runId = null, insights = null }) {
  const pct = (ratio) => `${((Number(ratio) || 0) * 100).toFixed(1)}%`;
  const runOptions = runs
    .map(
      (r) =>
        `<option value="${esc(r.runId)}"${String(r.runId) === String(runId) ? ' selected' : ''}>` +
        `#${esc(r.runId)} · ${esc(r.kind)} · ${r.total === null || r.total === undefined ? '无分' : esc(r.total)}分</option>`,
    )
    .join('');

  if (!insights) {
    return layout({
      title: '可见度分析',
      active: '/insights',
      brandName: brand.name ?? '恒野',
      body: `<h1>可见度分析</h1>
        <div class="sub">引用源 / 竞品份额 / 曝光质量 / 情感倾向</div>
        <div class="card empty" style="margin-top:16px">还没有可分析的运行。先去「跑诊断」跑一轮。</div>`,
    });
  }

  const { sample, exposure, citations, sov, sentiment, engines } = insights;
  const typeBadge = (type, label) => {
    const cls = type === 'own' ? 'ok' : type === 'social' ? 'info' : type === 'media' ? 'warn' : 'mut';
    return `<span class="badge ${cls}">${esc(label)}</span>`;
  };

  const sovRows = [
    `<tr><td><b>${esc(brand.name ?? '本品牌')}</b></td><td class="mono">${esc(sov.brandMentions)}</td>
     <td class="mono">${pct(sov.brandShare)}</td></tr>`,
    ...sov.competitors.map(
      (c) => `<tr><td>${esc(c.name)}</td><td class="mono">${esc(c.mentions)}</td>
      <td class="mono">${pct(c.share)}</td></tr>`,
    ),
  ].join('');

  const domainRows = citations.byDomain
    .slice(0, 15)
    .map(
      (d) => `<tr><td class="mono">${esc(d.domain)}</td><td class="mono">${esc(d.count)}</td>
      <td class="mono">${pct(d.share)}</td><td>${typeBadge(d.type, d.typeLabel)}</td>
      <td class="sub">${esc((d.titles ?? []).join(' / ').slice(0, 80))}</td></tr>`,
    )
    .join('');

  const engineRows = engines
    .map(
      (e) => `<tr><td class="mono">${esc(e.engine)}</td><td class="mono">${esc(e.answers)}</td>
      <td class="mono">${esc(e.ok)}</td><td class="mono">${esc(e.mentioned)}</td>
      <td class="mono">${pct(e.mentionRate)}</td></tr>`,
    )
    .join('');

  const opportunityRows = (insights.opportunities ?? [])
    .map(
      (o) => `<tr><td class="mono">${esc(o.domain)}</td><td>${typeBadge('other', o.typeLabel)}</td>
      <td class="mono">${esc(o.count)}</td><td class="sub">${esc(o.reason)}</td></tr>`,
    )
    .join('');

  const body = `
<h1>可见度分析</h1>
<div class="sub">引用源 / 竞品份额 / 曝光质量 / 情感倾向 —— 与诊断报告第五章同源，纯规则可复算。</div>

<div class="row" style="margin:16px 0">
  <label class="sub">选择运行</label>
  <select id="runSel">${runOptions}</select>
  <span class="sub">样本 ${esc(sample.total)} 条，有效 ${esc(sample.ok)} 条</span>
</div>

<div class="grid g4">
  <div class="card"><div class="k">提及率</div><div class="v">${pct(sample.mentionRate)}</div>
    <div class="sub" style="margin-top:4px">有效回答中被提到品牌的比例</div></div>
  <div class="card"><div class="k">篇幅占比</div><div class="v">${pct(exposure.avgWordShare)}</div>
    <div class="sub" style="margin-top:4px">提到你的句子占回答字数</div></div>
  <div class="card"><div class="k">位置权重</div><div class="v">${Number(exposure.avgPositionWeight).toFixed(3)}</div>
    <div class="sub" style="margin-top:4px">首句命中率 ${pct(exposure.firstSentenceRate)}（越靠前越高）</div></div>
  <div class="card"><div class="k">情感得分</div><div class="v">${Number(sentiment.score).toFixed(2)}</div>
    <div class="sub" style="margin-top:4px">正 ${esc(sentiment.positive)} · 中 ${esc(sentiment.neutral)} · 负 ${esc(sentiment.negative)}</div></div>
</div>

<h2>判定分布（10 态）</h2>
${
    insights.verdictCounts && Object.keys(insights.verdictCounts).length
      ? `<div class="card"><div class="row" style="gap:8px">${Object.entries(insights.verdictCounts)
          .sort((a, b) => b[1] - a[1])
          .map(
            ([key, count]) =>
              `<span class="badge ${key === 'recommended' || key === 'conditionally_recommended' ? 'ok' : key === 'not_mentioned' || key === 'engine_error' ? 'bad' : 'mut'}">${esc(
                {
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
                }[key] ?? key,
              )} ${esc(count)}</span>`,
          )
          .join('')}</div></div>`
      : `<div class="card empty">暂无判定数据</div>`
  }

<h2>竞品份额（SoV）</h2>
<table><thead><tr><th>品牌</th><th>提及题数</th><th>份额</th></tr></thead><tbody>${sovRows}</tbody></table>

<h2>引用源分析（AI 在引用哪些站）</h2>
${
    citations.uniqueDomains
      ? `<table><thead><tr><th>域名</th><th>被引次数</th><th>占比</th><th>类型</th><th>标题示例</th></tr></thead><tbody>${domainRows}</tbody></table>
         <div class="sub" style="margin-top:8px">共 ${esc(citations.total)} 条引用 / ${esc(citations.uniqueDomains)} 个域名，自有站点占 ${pct(citations.ownShare)}。</div>`
      : `<div class="card empty">本轮回答没有返回可解析的引用（部分引擎不返回 citations）。</div>`
  }

<h2>Query fan-out（引擎改写出的检索词）</h2>
${
    insights.fanout && insights.fanout.unique
      ? `<table><thead><tr><th>改写出的检索词</th><th>出现次数</th><th>引擎</th></tr></thead><tbody>${insights.fanout.top
          .map(
            (f) => `<tr><td>${esc(f.query)}</td><td class="mono">${esc(f.count)}</td>
            <td class="sub">${esc(f.engines.join('、'))}</td></tr>`,
          )
          .join('')}</tbody></table>
         <div class="sub" style="margin-top:8px">共 ${esc(insights.fanout.total)} 条改写词 / ${esc(insights.fanout.unique)} 条去重；含品牌名的 ${esc(insights.fanout.brandInQueries)} 条。</div>`
      : `<div class="card empty">本轮没有采集到改写词（引擎未返回 fan-out 信息）。</div>`
  }

<h2>机会缺口（优先在这些站建立可被引用的内容）</h2>
${
    opportunityRows
      ? `<table><thead><tr><th>域名</th><th>类型</th><th>被引次数</th><th>为什么</th></tr></thead><tbody>${opportunityRows}</tbody></table>`
      : `<div class="card empty">没有可识别的外部引用源。</div>`
  }

<h2>引擎对比</h2>
<table><thead><tr><th>引擎</th><th>回答数</th><th>有效</th><th>提及</th><th>提及率</th></tr></thead><tbody>${engineRows}</tbody></table>

<script>
document.getElementById('runSel').addEventListener('change', (e) => {
  location.href = '/insights?run=' + encodeURIComponent(e.target.value);
});
</script>`;
  return layout({ title: '可见度分析', active: '/insights', body, brandName: brand.name ?? '恒野' });
}

/**
 * 工具箱页：把「不想敲命令」的三件事做成表单——报价 / 自动出题 / 渠道状态。
 * 全部走 GET 查询参数（无 JS 依赖也能用），结果由服务端渲染。
 * @param {{brand?:object, keywords?:string, band?:string, quote?:object|null,
 *          questionCount?:number, questions?:object[]|null, channels?:object[]|null}} data
 */
export function toolsPage({
  brand = {},
  keywords = '',
  band = 'standard',
  quote = null,
  questionCount = 12,
  questions = null,
  channels = null,
} = {}) {
  const pct = (value) => `${((Number(value) || 0) * 100).toFixed(1)}%`;
  const intentLabel = (intent) =>
    ({ what: '认知', city: '本地', compare: '对比', price: '价格', howto: '方法', risk: '风险' }[intent] ?? intent);
  const bandOption = (id, label) =>
    `<option value="${esc(id)}"${band === id ? ' selected' : ''}>${esc(label)}</option>`;

  const quoteBlock = quote
    ? `<table><thead><tr><th>关键词</th><th>意图</th><th>难度</th><th>篇数</th><th>单价</th><th>小计</th></tr></thead>
       <tbody>${quote.lines
         .map(
           (line) => `<tr><td>${esc(line.term)}</td><td>${esc(intentLabel(line.intent))}</td>
           <td class="mono">${esc(line.difficulty)}</td><td class="mono">${esc(line.articles)}</td>
           <td class="mono">${esc(line.unitPrice)}</td><td class="mono">${esc(line.subtotal)}</td></tr>`,
         )
         .join('')}</tbody></table>
       <div class="grid g4" style="margin-top:14px">
         <div class="card"><div class="k">合计</div><div class="v">¥${esc(quote.total)}</div>
           <div class="sub">${esc(quote.lines.reduce((sum, line) => sum + line.articles, 0))} 篇</div></div>
         <div class="card"><div class="k">成本（写作+发布+运营）</div><div class="v">¥${esc(quote.cost?.total ?? 0)}</div>
           <div class="sub">单篇 60 元成本盘子</div></div>
         <div class="card"><div class="k">毛利</div><div class="v">${pct(quote.margin)}</div>
           <div class="sub">毛利 ¥${esc(Math.round((quote.total ?? 0) - (quote.cost?.total ?? 0)))}</div></div>
         <div class="card"><div class="k">档位</div><div class="v" style="font-size:18px">${esc(quote.bandLabel ?? quote.band ?? '')}</div>
           <div class="sub">篇数不足按档位下限计</div></div>
       </div>`
    : '';

  const questionsBlock = questions
    ? `<div class="card"><div class="sub">共 ${esc(questions.length)} 题（题目里不含品牌名）</div>
       <ul style="margin:10px 0 0;padding-left:20px;line-height:2">
       ${questions
         .slice(0, 24)
         .map(
           (q) =>
             `<li>${esc(q.text)} <span class="badge mut">${esc(q.priority)} · ${esc(q.tier)} · ${esc(q.intent)}</span></li>`,
         )
         .join('')}</ul></div>`
    : '';

  const channelBlock = channels
    ? `<table><thead><tr><th>渠道</th><th>状态</th><th>说明</th></tr></thead><tbody>${channels
        .map(
          (item) =>
            `<tr><td>${esc(item.name)}</td><td><span class="badge ${
              item.state === 'api' ? 'ok' : item.state === 'dry_run' ? 'warn' : 'mut'
            }">${esc({ api: '已接入 API', dry_run: '模拟发布', not_connected: '未接入' }[item.state] ?? item.state)}</span></td>
            <td class="sub">${esc(item.note ?? '')}</td></tr>`,
        )
        .join('')}</tbody></table>
       <div class="sub" style="margin-top:8px">升级为真实发布：在 app/.env 配 <span class="mono">PUBLISH_&lt;渠道ID&gt;_WEBHOOK</span>。</div>`
    : '';

  const body = `
<h1>工具箱</h1>
<div class="sub">报价 / 自动出题 / 发布渠道 —— 不用敲命令也能用。</div>

<h2>报价（关键词 → 篇数 → 金额与毛利）</h2>
<div class="card">
  <form method="get" action="/tools" class="row">
    <input type="text" name="keywords" value="${esc(keywords)}"
      placeholder="芜湖内容代运营多少钱:7,内容代运营怎么选:5" style="min-width:380px;flex:1">
    <select name="band">
      ${bandOption('lite', '轻量（最少 5 篇）')}
      ${bandOption('standard', '标准（最少 7 篇）')}
      ${bandOption('deep', '深度（最少 10 篇）')}
    </select>
    <button class="btn" type="submit">算报价</button>
  </form>
  <div class="sub" style="margin-top:8px">格式：<span class="mono">关键词:难度</span>，难度 0-10 或 low/medium/high，逗号分隔。</div>
</div>
${quoteBlock}

<h2>自动出题（三层 × 六意图）</h2>
<div class="card">
  <form method="get" action="/tools" class="row">
    <input type="hidden" name="keywords" value="${esc(keywords)}">
    <input type="hidden" name="band" value="${esc(band)}">
    <label class="sub">题数</label>
    <select name="count">
      ${[8, 12, 24, 48].map((n) => `<option value="${n}"${n === questionCount ? ' selected' : ''}>${n} 题</option>`).join('')}
    </select>
    <button class="btn" type="submit">生成题目</button>
  </form>
</div>
${questionsBlock}

<h2>发布渠道状态</h2>
${channelBlock || `<div class="card empty">渠道模块未就绪。</div>`}
`;
  return layout({ title: '工具箱', active: '/tools', body, brandName: brand.name ?? '恒野' });
}

/**
 * 闭环验收页：一键把 10 个步骤跑一遍，看哪一步断了。
 * 数据来自 `geo demo --json`（真实子进程调用 CLI，不是模拟）。
 * @param {{brand?:object, report?:string|null, reportFile?:string|null, running?:string|null}} data
 */
export function pipelinePage({ brand = {}, report = null, reportFile = null, running = null } = {}) {
  const body = `
<h1>端到端闭环验收</h1>
<div class="sub">建库 → 出题 → 诊断 → 分析 → 行动 → 关键词 → brief → 写稿 → 发布 → 监测，用 mock 引擎跑，不花一分钱。</div>

<div class="hint">
  <b>这一步验证的是「整条流水线能不能串起来」</b>，不是真实 AI 数据。
  跑完会在 <span class="mono">data/reports/demo-*.md</span> 留一份带每步结果的验收报告。
</div>

<div class="card" style="margin-top:16px">
  <div class="row">
    <button class="btn" id="go">跑一轮闭环验收</button>
    <span id="state" class="sub"></span>
  </div>
  <div class="term" id="out" style="margin-top:12px">${report ? esc(report) : '（等待开始）'}</div>
</div>

${reportFile ? `<div class="sub" style="margin-top:10px">最近一次验收报告：<span class="mono">${esc(reportFile)}</span></div>` : ''}

<script>
const out = document.getElementById('out');
const state = document.getElementById('state');
const go = document.getElementById('go');
let timer = null;

function setRunning(on){ go.disabled = on; state.textContent = on ? '运行中…（10 步，约 10-30 秒）' : ''; }

async function poll(id){
  const res = await fetch('/api/job?id=' + encodeURIComponent(id));
  const job = await res.json();
  out.textContent = job.stdout || '（无输出）';
  if(job.stderr) out.textContent += '\\n' + job.stderr;
  out.scrollTop = out.scrollHeight;
  if(job.status === 'running'){ timer = setTimeout(() => poll(id), 1200); return; }
  setRunning(false);
  state.innerHTML = job.exitCode === 0
    ? '✅ 闭环全部通过'
    : '❌ 有步骤失败（退出码 ' + job.exitCode + '），详见上方输出';
}

go.addEventListener('click', async () => {
  clearTimeout(timer);
  out.textContent = '启动中…';
  setRunning(true);
  const res = await fetch('/api/demo', { method: 'POST', headers: {'content-type':'application/json'}, body: '{}' });
  const data = await res.json();
  if(!res.ok){ setRunning(false); out.textContent = '启动失败：' + (data.error || res.status); return; }
  poll(data.job.id);
});
${running ? `poll(${JSON.stringify(running)});` : ''}
</script>`;
  return layout({ title: '闭环验收', active: '/pipeline', body, brandName: brand.name ?? '恒野' });
}

/**
 * 环境自检页。
 * @param {{report:object}} data
 */
export function doctorPage({ report = {} }) {
  const checks = (report.checks ?? [])
    .map(
      (c) => `<tr>
      <td><span class="badge ${c.ok ? 'ok' : c.level === 'blocker' ? 'bad' : 'warn'}">${c.ok ? '通过' : c.level === 'blocker' ? '阻塞' : '待处理'}</span></td>
      <td><b>${esc(c.title)}</b><div class="sub">${esc(c.detail)}</div></td>
      <td class="sub">${esc(c.action ?? '')}</td>
    </tr>`,
    )
    .join('');
  const body = `
<h1>环境自检</h1>
<div class="sub">告诉你「现在离能跑真实数据还差什么」，每一项都能对上一个具体动作。</div>
${
    report.ok
      ? `<div class="hint" style="border-color:#22c55e;background:rgba(34,197,94,.07)"><b>全部就绪。</b>可以跑 live 诊断了。</div>`
      : ''
  }
<h2>检查项</h2>
<table><thead><tr><th>状态</th><th>检查</th><th>怎么处理</th></tr></thead><tbody>${checks}</tbody></table>
${
    report.probeNote
      ? `<div class="hint">${esc(report.probeNote)}</div>`
      : ''
  }
<div class="footer">本页不发任何网络请求（除非你点了「探测」）。密钥只读本机 <span class="mono">app/.env</span>。</div>`;
  return layout({ title: '环境自检', active: '/doctor', body, brandName: report.brandName ?? '恒野' });
}

/** 404 页 */
export function notFoundPage(pathname = '') {
  return layout({
    title: '页面不存在',
    body: `<h1>404</h1><div class="sub">没有这个页面：<span class="mono">${esc(pathname)}</span></div>
      <p><a class="btn ghost" href="/" style="margin-top:16px">回总览</a></p>`,
  });
}
