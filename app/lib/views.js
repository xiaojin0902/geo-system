import { systemName } from './branding.js';
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


// ── 白标主题：布局读取这里的值，服务端每请求按客户设置注入 ──
let THEME = { title: systemName(), logo: systemName(), color: '#7c5cff', footer: '' };

// 动作类页面：客户不能执行时（托管/到期）从导航里隐藏，避免点了才报错
const ACTION_PATHS = new Set(['/run-diagnose', '/tools', '/distribution', '/pipeline', '/video', '/doctor']);
let NAV_POLICY = { canAct: true, role: 'admin' };

/** 设置本请求的导航策略（每请求重置，避免串台） */
export function setNavPolicy(policy = {}) {
  NAV_POLICY = { canAct: policy.canAct !== false, role: policy.role ?? 'admin' };
}

/** 设置进程内主题（白标） */
export function setTheme(partial = {}) {
  THEME = {
    title: String(partial.title ?? THEME.title),
    logo: String(partial.logo ?? THEME.logo),
    color: String(partial.color ?? THEME.color),
    footer: String(partial.footer ?? THEME.footer),
  };
}

/** 读当前主题（测试与页面用） */
export function getTheme() {
  return { ...THEME };
}

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
.nav{position:sticky;top:0;z-index:9;display:flex;align-items:center;gap:2px;padding:6px 18px;min-height:52px;flex-wrap:wrap;
background:rgba(11,12,16,.92);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
.nav .logo{font-weight:700;letter-spacing:-.01em;margin-right:16px}
.nav .logo i{color:var(--accent);font-style:normal}
.nav a{padding:6px 10px;border-radius:8px;color:var(--dim);font-size:13px;white-space:nowrap}
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
export function layout({ title, active = '', body = '', brandName = '', right = '' }) {
  const items = [
    ['/', '总览'],
    ['/run-diagnose', '跑诊断'],
    ['/cockpit', '语义份额驾驶舱'],
    ['/responses', '回答浏览器'],
    ['/facts', '事实库'],
    ['/watch', '巡检'],
    ['/alerts', '异动告警'],
    ['/attribution', '内容归因'],
    ['/compare', '竞品对位'],
    ['/insights', '可见度分析'],
    ['/tools', '工具箱'],
    ['/distribution', '分发矩阵'],
    ['/weekly', '周报'],
    ['/agent', '代理总览'],
    ['/pipeline', '闭环验收'],
    ['/questions', '问题库'],
    ['/audit', '官网体检'],
    ['/seo', 'SEO 体检'],
    ['/video', '短视频脚本'],
    ['/doctor', '环境自检'],
  ];
  const nav = items
    .filter(([href]) => (NAV_POLICY.canAct || !ACTION_PATHS.has(href)) && (href !== '/agent' || NAV_POLICY.role === 'agent'))
    .map(([href, label]) => `<a href="${href}" class="${href === active ? 'on' : ''}">${esc(label)}</a>`)
    .join('');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(THEME.title)}</title>
<style>${CSS}
:root{--accent:${THEME.color};--accent-dim:${THEME.color}33}
</style></head>
<body>
<div class="nav">
  <span class="logo">${THEME.logo.replace(/[<]/g, '')}</span>
  ${nav}
  <span class="spacer"></span>
  <span class="sub">${esc(brandName || THEME.title)}</span>
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
  admin = false,
  subscription = null,
  role = 'admin',
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

${subscription ? `<div class="hint" style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;border-color:${subscription.expired ? '#ef4444' : subscription.mode === 'managed' ? '#22d3ee' : '#7c5cff'}">
  <b>${esc(subscription.planName)}</b>
  <span class="badge ${subscription.mode === 'managed' ? 'info' : 'mut'}">${esc(subscription.modeName)}</span>
  <span class="sub">配额 ${esc(subscription.quotaQuestions)} 题/月 · 到期 ${esc(subscription.expireAt ? String(subscription.expireAt).slice(0, 10) : '未设置')}</span>
  ${subscription.expired ? '<span class="badge bad">已到期，只读</span>' : ''}
  ${subscription.mode === 'managed' ? '<span class="sub">诊断由服务商代跑，你只需查看结果</span>' : ''}
</div>` : ''}

${admin ? `<div class="hint" style="display:flex;gap:16px;flex-wrap:wrap;align-items:center">
  <b>管理员</b>
  <a href="/clients" style="color:#b6a4ff">客户管理</a>
  <a href="/settings" style="color:#b6a4ff">白标与配额</a>
  <a href="/audit-log" style="color:#b6a4ff">审计日志</a>
  <a href="/logout" style="color:var(--dim2)">退出登录</a>
</div>` : '<div style="margin-bottom:10px"><a href="/logout" style="color:var(--dim2);font-size:12px">退出登录</a></div>'}

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

/** 简易 SVG 折线图（零依赖，服务端渲染，不需要前端图表库） */
function sparkline(values, { width = 520, height = 120, color = '#7c5cff', label = '' } = {}) {
  const nums = values.map((v) => (Number.isFinite(Number(v)) ? Number(v) : null));
  const pts = nums.map((v, i) => (v === null ? null : [i, v])).filter(Boolean);
  if (pts.length < 2) return `<div class="empty">数据不足，跑两轮后出趋势</div>`;
  const max = Math.max(...pts.map((p) => p[1]), 1);
  const min = Math.min(...pts.map((p) => p[1]), 0);
  const span = max - min || 1;
  const px = (i) => 10 + (i / Math.max(1, nums.length - 1)) * (width - 20);
  const py = (v) => height - 12 - ((v - min) / span) * (height - 26);
  const path = pts.map((p, idx) => `${idx === 0 ? 'M' : 'L'}${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`).join(' ');
  const dots = pts
    .map((p) => `<circle cx="${px(p[0]).toFixed(1)}" cy="${py(p[1]).toFixed(1)}" r="3" fill="${color}"/>`)
    .join('');
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${esc(label)}">
    <line x1="10" y1="${height - 12}" x2="${width - 10}" y2="${height - 12}" stroke="#252a36"/>
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2"/>
    ${dots}
  </svg>`;
}

/** 横向条形图（用于份额/分布对比） */
function bars(items, { color = '#7c5cff', max } = {}) {
  const list = items.filter((it) => Number(it.value) > 0).slice(0, 10);
  const top = max ?? Math.max(...list.map((it) => Number(it.value)), 1);
  if (!list.length) return `<div class="empty">暂无数据</div>`;
  return `<div class="card">${list
    .map((it) => {
      const width = Math.max(2, (Number(it.value) / top) * 100);
      return `<div style="margin-bottom:10px">
        <div class="row" style="justify-content:space-between;display:flex;font-size:12px;margin-bottom:4px">
          <span>${esc(it.label)}</span><span class="mono" style="color:var(--dim)">${esc(it.display ?? it.value)}</span>
        </div>
        <div style="height:8px;background:#0a0b0f;border:1px solid var(--line);border-radius:6px;overflow:hidden">
          <div style="height:100%;width:${width.toFixed(1)}%;background:${it.color ?? color}"></div>
        </div></div>`;
    })
    .join('')}</div>`;
}

/**
 * 语义份额驾驶舱：对标摘星AI 的「驾驶舱」——
 * 一屏看全「AI 里谁被提、说得多好、和谁比、引了谁、跨引擎差多少、趋势怎么走」。
 * @param {{brand:object, runs:Array, runId:number|null, insights:object|null, previous:object|null,
 *          trend:Array, engines:Array}} data
 */
export function cockpitPage({
  brand = {},
  runs = [],
  runId = null,
  insights = null,
  previous = null,
  trend = [],
  engines = [],
  plan = null,
} = {}) {
  const pct = (v) => `${((Number(v) || 0) * 100).toFixed(1)}%`;
  const num = (v, d = 1) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '—');
  const runOptions = runs
    .map(
      (r) =>
        `<option value="${esc(r.runId)}"${String(r.runId) === String(runId) ? ' selected' : ''}>#${esc(r.runId)} · ${esc(r.kind)} · ${r.total === null || r.total === undefined ? '无分' : esc(r.total)}分</option>`,
    )
    .join('');

  if (!insights) {
    return layout({
      title: '语义份额驾驶舱',
      active: '/cockpit',
      brandName: brand.name ?? '恒野',
      body: `<h1>语义份额驾驶舱</h1><div class="card empty" style="margin-top:16px">还没有可分析的运行。先去「跑诊断」跑一轮。</div>`,
    });
  }

  const { sample, exposure, citations, sov, sentiment, engines: engineStats, verdictCounts, fanout, sameNameThreats } = insights;
  const delta = (cur, prev, isPct = true) => {
    if (prev === null || prev === undefined || !Number.isFinite(Number(prev))) return '';
    const diff = Number(cur) - Number(prev);
    const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
    const color = diff > 0 ? '#4ade80' : diff < 0 ? '#f87171' : '#8b93a7';
    return `<span style="color:${color};font-size:12px">${arrow} ${isPct ? (diff * 100).toFixed(1) + 'pt' : diff.toFixed(1)}</span>`;
  };

  const sentimentTotal = (sentiment.positive + sentiment.neutral + sentiment.negative) || 1;
  const sentimentBar = `<div class="card">
    <div style="display:flex;height:14px;border-radius:7px;overflow:hidden;border:1px solid var(--line)">
      <div style="width:${(sentiment.positive / sentimentTotal * 100).toFixed(1)}%;background:#22c55e"></div>
      <div style="width:${(sentiment.neutral / sentimentTotal * 100).toFixed(1)}%;background:#3a4152"></div>
      <div style="width:${(sentiment.negative / sentimentTotal * 100).toFixed(1)}%;background:#ef4444"></div>
    </div>
    <div class="sub" style="margin-top:8px">正面 ${esc(sentiment.positive)} · 中性 ${esc(sentiment.neutral)} · 负面 ${esc(sentiment.negative)}（得分 ${num(sentiment.score, 2)}）</div>
  </div>`;

  const sovBars = bars(
    [
      { label: `${brand.name ?? '本品牌'}（本品牌）`, value: sov.brandShare, display: pct(sov.brandShare), color: '#7c5cff' },
      ...(sov.competitors ?? []).map((c) => ({ label: c.name, value: c.share, display: pct(c.share), color: '#22d3ee' })),
    ],
    { max: 1 },
  );

  const citationBars = bars(
    (citations.byDomain ?? []).map((d) => ({
      label: `${d.domain}（${d.typeLabel}）`,
      value: d.share,
      display: pct(d.share),
      color: d.type === 'own' ? '#22c55e' : d.sameName ? '#ef4444' : d.type === 'registry' ? '#f59e0b' : '#7c5cff',
    })),
    { max: 1 },
  );

  const engineRows = (engineStats ?? [])
    .map(
      (e) => `<tr><td>${esc(engines.find((x) => x.id === e.engine)?.label ?? e.engine)}</td>
        <td class="mono">${esc(e.answers)}</td><td class="mono">${esc(e.ok)}</td>
        <td class="mono">${esc(e.mentioned)}</td>
        <td class="mono" style="color:${e.mentionRate >= 0.5 ? '#4ade80' : e.mentionRate > 0 ? '#fbbf24' : '#f87171'}">${pct(e.mentionRate)}</td></tr>`,
    )
    .join('');

  const verdictBars = bars(
    Object.entries(verdictCounts ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => ({
        label:
          { recommended: '推荐', conditionally_recommended: '条件推荐', candidate: '候选', listed: '列入', mentioned: '仅提及', not_mentioned: '未提及', ambiguous: '歧义', unknown: '未知', refused: '拒答', engine_error: '引擎错误' }[k] ?? k,
        value: v,
        display: String(v),
        color: k === 'recommended' || k === 'conditionally_recommended' ? '#22c55e' : k === 'not_mentioned' || k === 'engine_error' ? '#ef4444' : '#7c5cff',
      })),
    { max: sample.total || 1 },
  );

  const threatList = (sameNameThreats ?? []).length
    ? `<div class="hint" style="border-color:#ef4444;background:rgba(239,68,68,.07)">
        <b>同名实体威胁</b>（AI 讲你的品牌名时，引的是别家）
        <ul style="margin:6px 0 0;padding-left:20px">${sameNameThreats.map((t) => `<li>${esc(t.message)}</li>`).join('')}</ul>
      </div>`
    : '';

  const body = `
<h1>语义份额驾驶舱</h1>
<div class="sub">一屏看全：AI 里谁被提、说得多好、和谁比、引了谁、跨引擎差多少、趋势怎么走 · ${esc([brand.city, brand.industry].filter(Boolean).join(' · '))}</div>

<div class="row" style="margin:16px 0">
  <label class="sub">选择运行</label>
  <select id="runSel">${runOptions}</select>
  <span class="sub">有效样本 ${esc(sample.ok)} / ${esc(sample.total)}</span>
</div>

<div class="grid g4">
  <div class="card"><div class="k">语义份额 SoV</div><div class="v">${pct(sov.brandShare)} ${delta(sov.brandShare, previous?.sov?.brandShare)}</div>
    <div class="sub">本品牌提及 ${esc(sov.brandMentions)} 次</div></div>
  <div class="card"><div class="k">提及率</div><div class="v">${pct(sample.mentionRate)} ${delta(sample.mentionRate, previous?.sample?.mentionRate)}</div>
    <div class="sub">有效回答中被提到</div></div>
  <div class="card"><div class="k">自有站点引用占比</div><div class="v">${pct(citations.ownShare)} ${delta(citations.ownShare, previous?.citations?.ownShare)}</div>
    <div class="sub">共 ${esc(citations.total)} 条引用 / ${esc(citations.uniqueDomains)} 域名</div></div>
  <div class="card"><div class="k">情感得分</div><div class="v">${num(sentiment.score, 2)}</div>
    <div class="sub">正 ${esc(sentiment.positive)} / 负 ${esc(sentiment.negative)}</div></div>
</div>

<h2>趋势（近 ${esc(trend.length)} 轮）</h2>
<div class="card">
  <div class="sub" style="margin-bottom:6px">总分（0-100）</div>
  ${sparkline(trend.map((t) => t.total), { color: '#7c5cff', label: '总分趋势' })}
  <div class="sub" style="margin:12px 0 6px">提及率</div>
  ${sparkline(trend.map((t) => t.mentionRate), { color: '#22d3ee', label: '提及率趋势' })}
  <div class="sub" style="margin-top:8px">${trend.map((t) => `#${esc(t.runId)}`).join(' · ')}</div>
</div>

<h2>多引擎覆盖（摘星AI 的「11 大模型」在这里逐家看）</h2>
${
    engineRows
      ? `<table><thead><tr><th>引擎</th><th>回答数</th><th>有效</th><th>提及</th><th>提及率</th></tr></thead><tbody>${engineRows}</tbody></table>`
      : `<div class="card empty">暂无引擎分布</div>`
  }
<div class="sub" style="margin-top:8px">引擎配置状态见「环境自检」；未配置密钥的引擎不会出现在这里。</div>

<h2>情感倾向</h2>
${sentimentBar}

<h2>竞品语义份额（SoV）</h2>
${sovBars}

<h2>引用源份额（AI 在引谁）</h2>
${citationBars}
${threatList}

<h2>判定分布（10 态）</h2>
${verdictBars}

<h2>30 / 60 / 90 天路线图</h2>
${
    (plan?.phases ?? []).length
      ? `<div class="grid" style="grid-template-columns:repeat(3,1fr);gap:14px">
        ${plan.phases
          .map(
            (phase) => `<div class="card">
            <div class="k">${esc(phase.window)}</div>
            <div class="v" style="font-size:17px">${esc(phase.focus)}</div>
            <div class="sub" style="margin:8px 0 6px">目标</div>
            <ul style="margin:0;padding-left:18px;line-height:1.8;font-size:12.5px">${(phase.goals ?? []).map((g) => `<li>${esc(g)}</li>`).join('')}</ul>
            ${(phase.actions ?? []).length ? `<div class="sub" style="margin:10px 0 4px">配套动作</div><ol style="margin:0;padding-left:18px;line-height:1.8;font-size:12.5px">${phase.actions.map((a) => `<li>${esc(a.action)}</li>`).join('')}</ol>` : ''}
            <div class="sub" style="margin-top:10px;color:#4ade80">验收：${esc(phase.success ?? '')}</div>
          </div>`,
          )
          .join('')}
      </div>`
      : `<div class="card empty">样本不足，暂不生成路线图</div>`
  }

<div class="sub" style="margin-top:26px">曝光质量：篇幅占比 ${pct(exposure.avgWordShare)} · 位置权重 ${num(exposure.avgPositionWeight, 3)} · 首句命中率 ${pct(exposure.firstSentenceRate)}
｜ fan-out ${esc(fanout?.unique ?? 0)} 条改写词</div>

<script>
document.getElementById('runSel').addEventListener('change', (e) => {
  location.href = '/cockpit?run=' + encodeURIComponent(e.target.value);
});
</script>`;
  return layout({ title: '语义份额驾驶舱', active: '/cockpit', body, brandName: brand.name ?? '恒野' });
}

/**
 * 内容矩阵分发页：11 个渠道 × 内容 的覆盖矩阵。
 * 对标摘星AI 的「内容矩阵分发」——不是看发了多少篇，而是看「每个渠道是否都铺到了」。
 * @param {{brand?:object, channels?:Array, contents?:Array, publications?:Array}} data
 */
export function distributionPage({ brand = {}, channels = [], contents = [], publications = [] } = {}) {
  const stateLabel = { not_connected: ['未接入', 'mut'], dry_run: ['模拟发布', 'warn'], api: ['已接入 API', 'ok'] };
  const covered = new Map(); // `${contentId}|${channelName}` -> status
  for (const pub of publications) covered.set(`${pub.contentId}|${pub.channel}`, pub.status);

  const channelRows = channels
    .map((c) => {
      const [label, cls] = stateLabel[c.state] ?? [c.state, 'mut'];
      const count = publications.filter((p) => p.channel === c.name).length;
      return `<tr><td>${esc(c.name)}</td><td class="mono">${esc(c.id)}</td>
        <td><span class="badge ${cls}">${esc(label)}</span></td>
        <td class="mono">${esc(count)}</td><td class="sub">${esc(c.note ?? '')}</td></tr>`;
    })
    .join('');

  const matrixHead = channels.map((c) => `<th style="text-align:center">${esc(c.name)}</th>`).join('');
  const matrixRows = contents
    .slice(0, 30)
    .map((content) => {
      const cells = channels
        .map((c) => {
          const status = covered.get(`${content.id}|${c.name}`);
          const mark = status ? (status === 'published' ? '✅' : '○') : '·';
          const title = status ? (status === 'published' ? '已真实发布' : '已模拟登记') : '未分发';
          return `<td style="text-align:center" title="${esc(title)}">${mark}</td>`;
        })
        .join('');
      return `<tr><td class="mono">#${esc(content.id)}</td><td>${esc((content.title ?? '—').slice(0, 28))}</td>${cells}</tr>`;
    })
    .join('');

  const totalCells = contents.length * channels.length;
  const filled = publications.length;
  const coverage = totalCells ? Math.min(100, (filled / totalCells) * 100) : 0;
  const missing = contents.length && channels.length
    ? channels
        .map((c) => ({ name: c.name, count: publications.filter((p) => p.channel === c.name).length }))
        .filter((c) => c.count === 0)
        .map((c) => c.name)
    : [];

  return layout({
    title: '分发矩阵',
    active: '/distribution',
    brandName: brand.name ?? '恒野',
    body: `
<h1>内容矩阵分发</h1>
<div class="sub">11 个渠道 × 全部内容 的覆盖矩阵 · 对标摘星AI 的「内容矩阵分发」</div>

<div class="grid g4" style="margin:16px 0">
  <div class="card"><div class="k">渠道数</div><div class="v">${esc(channels.length)}</div><div class="sub">${esc(channels.filter((c) => c.state === 'api').length)} 个已接入 API</div></div>
  <div class="card"><div class="k">内容数</div><div class="v">${esc(contents.length)}</div><div class="sub">来自内容库</div></div>
  <div class="card"><div class="k">分发记录</div><div class="v">${esc(filled)}</div><div class="sub">含 dry_run 与真实发布</div></div>
  <div class="card"><div class="k">矩阵覆盖率</div><div class="v">${coverage.toFixed(1)}%</div><div class="sub">${esc(totalCells)} 个格子已填 ${esc(filled)}</div></div>
</div>

${
    missing.length
      ? `<div class="hint">还没铺过的渠道：<b>${esc(missing.join('、'))}</b>。用 <span class="mono">node bin/geo.js distribute --content &lt;id&gt; --channels "${esc(missing[0])}"</span> 补一发。</div>`
      : ''
  }

<h2>渠道状态</h2>
<table><thead><tr><th>渠道</th><th>ID</th><th>状态</th><th>已分发</th><th>说明</th></tr></thead><tbody>${channelRows}</tbody></table>
<div class="sub" style="margin-top:8px">升级为真实发布：在 <span class="mono">app/.env</span> 配 <span class="mono">PUBLISH_&lt;渠道ID大写&gt;_WEBHOOK</span>。</div>

<h2>内容 × 渠道 矩阵</h2>
${
    contents.length
      ? `<div style="overflow-x:auto"><table><thead><tr><th>内容</th><th>标题</th>${matrixHead}</tr></thead><tbody>${matrixRows}</tbody></table></div>
         <div class="sub" style="margin-top:8px">✅ 已真实发布 · ○ 已模拟登记 · · 未分发（点开渠道配置后可批量补）</div>`
      : `<div class="card empty">还没有内容。先到「工具箱」或 CLI 生成 brief 与草稿。</div>`
  }

<h2>最近分发记录</h2>
${
    publications.length
      ? `<table><thead><tr><th>内容</th><th>渠道</th><th>状态</th><th>时间</th></tr></thead><tbody>${publications
          .slice(0, 12)
          .map(
            (p) =>
              `<tr><td class="mono">#${esc(p.contentId)}</td><td>${esc(p.channel)}</td>
               <td><span class="badge ${p.status === 'published' ? 'ok' : 'warn'}">${esc(p.status)}</span></td>
               <td class="mono">${esc(String(p.createdAt ?? '').slice(0, 16).replace('T', ' '))}</td></tr>`,
          )
          .join('')}</tbody></table>`
      : `<div class="card empty">还没有分发记录。运行 <span class="mono">node bin/geo.js distribute --all</span> 试一次。</div>`
  }
`,
  });
}

/**
 * SEO 体检页（对标摘星AI「GEO+SEO+短视频SEO 三位一体」的 SEO 侧）。
 * 数据来自 `geo seo` 写入的 data/seo/latest.json。
 */
export function seoPage({ brand = {}, result = null } = {}) {
  if (!result) {
    return layout({
      title: 'SEO 体检',
      active: '/seo',
      brandName: brand.name ?? '恒野',
      body: `<h1>SEO 体检</h1><div class="card empty" style="margin-top:16px">还没有结果。运行 <span class="mono">node bin/geo.js seo --url &lt;网址&gt;</span> 生成。</div>`,
    });
  }
  const badge = (level) =>
    `<span class="badge ${level === 'blocker' ? 'bad' : level === 'warn' ? 'warn' : 'mut'}">${esc(level)}</span>`;
  const rows = (result.checks ?? [])
    .map(
      (c) => `<tr><td>${c.ok ? '<span class="badge ok">通过</span>' : badge(c.level)}</td>
        <td><b>${esc(c.label)}</b><div class="sub">${esc(c.detail)}</div>
        ${c.ok ? '' : `<div class="sub" style="color:#8b93a7;margin-top:4px">修复：${esc(c.fix)}</div>`}</td></tr>`,
    )
    .join('');
  const m = result.metrics ?? {};
  const recs = (result.recommendations ?? []).map((r) => `<li>${esc(r)}</li>`).join('');
  const video = result.videoSeo ?? {};
  const body = `
<h1>SEO 体检</h1>
<div class="sub">传统 SEO + 短视频 SEO · ${esc(result.url ?? '')}${result.keyword ? ' · 关键词「' + esc(result.keyword) + '」' : ''}</div>

<div class="grid g4" style="margin:16px 0">
  <div class="card"><div class="k">SEO 评分</div><div class="v">${esc(result.score)}<small> / 100</small></div><div class="sub">${esc(result.level ?? '')}</div></div>
  <div class="card"><div class="k">通过 / 待修</div><div class="v">${esc((result.checks ?? []).filter((c) => c.ok).length)}<small> / ${esc((result.checks ?? []).filter((c) => !c.ok).length)}</small></div><div class="sub">阻断 ${esc((result.checks ?? []).filter((c) => !c.ok && c.level === 'blocker').length)}</div></div>
  <div class="card"><div class="k">标题 / 词数</div><div class="v" style="font-size:16px">${esc(m.titleLen ?? 0)} 字 / ${esc(m.wordCount ?? 0)}</div><div class="sub">H1 ${esc(m.h1Count ?? 0)} · H2 ${esc(m.h2Count ?? 0)}</div></div>
  <div class="card"><div class="k">图片 alt 覆盖</div><div class="v" style="font-size:16px">${esc(m.imgCount ?? 0)} 张 / 缺 ${esc(m.imgNoAlt ?? 0)}</div><div class="sub">JSON-LD ${esc(m.jsonLdCount ?? 0)} 段</div></div>
</div>

<h2>检查明细</h2>
<table><thead><tr><th>结果</th><th>检查项与修复</th></tr></thead><tbody>${rows}</tbody></table>

<h2>短视频 SEO 建议</h2>
<div class="card"><div class="sub">标题长度 ${esc(video.titleLen ?? 0)} 字 · 话题 ${esc(video.hashtagCount ?? 0)} 个 · 封面：${esc(video.coverHint ?? '—')}</div>
<ul style="margin:8px 0 0;padding-left:20px;line-height:1.9">${(video.tips ?? []).map((t) => `<li>${esc(t)}</li>`).join('') || '<li class="sub">暂无建议</li>'}</ul></div>

<h2>行动建议</h2>
${recs ? `<div class="card"><ol style="margin:0;padding-left:20px;line-height:2">${recs}</ol></div>` : '<div class="card empty">没有额外建议</div>'}

<div class="hint">这个页面与「官网体检」（查 AI 可抓取性）互补：一个查「能不能被 AI 抓」，一个查「传统搜索与短视频搜索能不能排好」。两个都过，才是三位一体的基础。</div>`;
  return layout({ title: 'SEO 体检', active: '/seo', body, brandName: brand.name ?? '恒野' });
}

/**
 * 短视频脚本页（对标摘星AI「AI 短视频矩阵」的脚本层）。
 * 只展示 `geo video` 产出的可拍摄脚本（口播/分镜/SRT），不做视频渲染。
 */
export function videoPage({ brand = {}, files = [], selected = null, content = '' } = {}) {
  const list = files
    .map(
      (f) =>
        `<a href="/video?file=${encodeURIComponent(f.id)}" style="display:block;padding:9px 12px;border:1px solid var(--line);border-radius:9px;margin-bottom:8px;${f.id === selected ? 'background:rgba(124,92,255,.14);border-color:#4b3fa8' : ''}">
          <b>#${esc(f.id)}</b> <span class="sub">${esc(f.title)}</span></a>`,
    )
    .join('');
  const body = `
<h1>短视频脚本</h1>
<div class="sub">文章 → 口播稿 / 分镜 / 标题 / 话题 / 封面 / 合规检查 · 对标摘星AI 的「AI 短视频矩阵」脚本层</div>

<div class="grid g2" style="margin-top:16px">
  <div>
    <h2>已生成脚本（${esc(files.length)}）</h2>
    ${list || '<div class="card empty">还没有脚本。运行 <span class="mono">node bin/geo.js video --content &lt;id&gt;</span> 生成。</div>'}
  </div>
  <div>
    <h2>${selected ? '脚本 #' + esc(selected) : '预览'}</h2>
    <div class="card">${
      content
        ? `<pre class="mono" style="white-space:pre-wrap;line-height:1.7;margin:0;font-size:12.5px">${esc(content)}</pre>`
        : `<div class="empty">左侧选一个脚本预览</div>`
    }</div>
  </div>
</div>

<div class="hint">说明：这里产出的是「可拍摄的脚本」——口播稿、分镜、标题、话题，配套可导出 SRT 字幕与分镜 CSV，直接交给拍摄或剪辑。脚本已内置合规检查：绝对化用语、效果承诺、无来源数字会在生成时被标出。</div>`;
  return layout({ title: '短视频脚本', active: '/video', body, brandName: brand.name ?? '恒野' });
}

/** 登录页：客户与管理员都用它进系统 */
export function loginPage({ error = '', next = '/' } = {}) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · ${systemName()}</title>
<meta name="robots" content="noindex"><style>${CSS}
body{display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{width:360px;background:linear-gradient(160deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:16px;padding:28px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--dim2);font-size:12px;margin-bottom:18px}
label{display:block;font-size:12px;color:var(--dim);margin:12px 0 6px}
input{width:100%;background:#0a0b0f;color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:14px}
button{width:100%;margin-top:18px;background:var(--accent);color:#fff;border:0;border-radius:10px;padding:11px;font-size:14px;cursor:pointer}
.err{background:rgba(239,68,68,.12);color:#f87171;border-radius:9px;padding:9px 12px;font-size:12.5px;margin-bottom:12px}
.hint2{color:var(--dim2);font-size:11.5px;margin-top:14px;line-height:1.7}
</style></head><body>
<form class="box" method="post" action="/login">
  <h1>恒野 <span style="color:var(--accent)">GEO</span></h1>
  <div class="sub">AI 可见度监测系统 · 请登录</div>
  ${error ? `<div class="err">${esc(error)}</div>` : ''}
  <input type="hidden" name="next" value="${esc(next)}">
  <label>用户名</label><input name="username" autocomplete="username" required autofocus>
  <label>密码</label><input name="password" type="password" autocomplete="current-password" required>
  <button type="submit">登录</button>
  <div class="hint2">管理员首次启动时，终端会打印初始密码；客户账号由管理员创建。</div>
</form></body></html>`;
}

/**
 * 代理总览：服务商 → 代理 → 客户 三层中的代理视角。
 * 代理只看自己名下的客户、自己的进货配额与分成，不碰全局设置。
 */
export function agentPage({
  agent = '',
  agentName = '',
  quota = 0,
  used = 0,
  commissionRate = 0,
  totalRevenue = 0,
  clients = [],
  generatedAt = '',
} = {}) {
  const pct = (v) => `${(Number(v) * 100).toFixed(0)}%`;
  const rows = clients
    .map(
      ({ brand, sub, used: clientUsed }) => `<tr>
      <td><b>${esc(brand.name ?? brand.slug)}</b><div class="sub mono">${esc(brand.slug)}</div></td>
      <td><span class="badge ${sub.mode === 'managed' ? 'info' : 'mut'}">${esc(sub.modeName)}</span></td>
      <td>${esc(sub.planName)}</td>
      <td class="mono">${esc(sub.expireAt ? String(sub.expireAt).slice(0, 10) : '—')}</td>
      <td class="mono">${esc(clientUsed)} / ${esc(sub.quotaQuestions)}</td>
      <td>${sub.expired ? '<span class="badge bad">已到期</span>' : sub.active ? '<span class="badge ok">有效</span>' : '<span class="badge mut">未开通</span>'}</td>
      <td><a href="/?brand=${encodeURIComponent(brand.slug)}" style="color:#b6a4ff">看板</a></td>
    </tr>`,
    )
    .join('');
  return layout({
    title: '代理总览',
    active: '/agent',
    body: `
<h1>代理总览 · ${esc(agentName)}</h1>
<div class="sub">账号 ${esc(agent)} · 生成于 ${esc(generatedAt)}</div>

<div class="grid g4" style="margin:16px 0">
  <div class="card"><div class="k">名下客户</div><div class="v">${esc(clients.length)}</div><div class="sub">其中 ${esc(clients.filter((c) => c.sub.active).length)} 个有效</div></div>
  <div class="card"><div class="k">进货配额</div><div class="v">${esc(used)}<small> / ${esc(quota)}</small></div><div class="sub">本月已用题数</div></div>
  <div class="card"><div class="k">本月客户营收</div><div class="v">¥${esc(totalRevenue)}</div><div class="sub">按当前套餐价估算</div></div>
  <div class="card"><div class="k">分成比例</div><div class="v">${pct(commissionRate)}</div><div class="sub">约 ¥${esc(Math.round(totalRevenue * commissionRate))}</div></div>
</div>

<div class="hint">你可以：新增客户（/clients）、替客户开通/续费（/clients 的订阅表单）、查看每个客户的看板与周报。
<b>不能</b>修改全局设置（白标、审计日志），也看不到其他代理的客户。</div>

<h2>我的客户</h2>
${
    clients.length
      ? `<table><thead><tr><th>客户</th><th>模式</th><th>套餐</th><th>到期</th><th>本月用量</th><th>状态</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="card empty">还没有客户。去 <a href="/clients" style="color:#b6a4ff">客户管理</a> 新建一个。</div>`
  }
`,
  });
}

/**
 * 结算看板：按效果计费的托管客户，本月应结多少。
 * 核心信息只有三个：用哪个口径、涨了多少、应收多少。
 */
export function billingPage({ rows = [], month = '', total = 0, generatedAt = '' } = {}) {
  const body = `
<h1>托管结算看板</h1>
<div class="sub">${esc(month)} · 按效果计费（可持续复算）· 生成于 ${esc(generatedAt)}</div>

<div class="grid g4" style="margin:16px 0">
  <div class="card"><div class="k">结算客户</div><div class="v">${esc(rows.length)}</div><div class="sub">托管版客户</div></div>
  <div class="card"><div class="k">本月应收合计</div><div class="v">¥${esc(total)}</div><div class="sub">按各客户口径</div></div>
  <div class="card"><div class="k">计费口径</div><div class="v" style="font-size:15px">${esc(rows[0]?.unitName ?? '—')}</div><div class="sub">可在设置里调整</div></div>
  <div class="card"><div class="k">结算月份</div><div class="v" style="font-size:18px">${esc(month)}</div><div class="sub">--month 可切换</div></div>
</div>

<div class="hint">托管 = 按效果收费：只对「本期相对基线的增量」计费，效果为负时不收费；支持保底与封顶，避免双方吃亏。
客户可在看板核对每一个数字。</div>

${
    rows.length
      ? `<table><thead><tr><th>客户</th><th>模式</th><th>口径</th><th>本期</th><th>增量</th><th>单价</th><th>应收</th><th></th></tr></thead><tbody>
        ${rows
          .map(
            (row) => `<tr>
            <td><b>${esc(row.name)}</b><div class="sub mono">${esc(row.slug)}</div></td>
            <td><span class="badge ${row.mode === 'managed' ? 'info' : 'mut'}">${esc(row.modeName)}</span></td>
            <td class="sub">${esc(row.unitName)}</td>
            <td class="mono">${esc(row.currentMentioned)} 提及 / ${esc(row.currentAnswers)} 答</td>
            <td class="mono">${esc(row.quantity)} ${esc(row.unitLabel)}</td>
            <td class="mono">¥${esc(row.price)}</td>
            <td class="mono"><b>¥${esc(row.total)}</b>${row.floored ? ' <span class="badge warn">保底</span>' : ''}${row.capped ? ' <span class="badge warn">封顶</span>' : ''}</td>
            <td><a href="/?brand=${encodeURIComponent(row.slug)}" style="color:#b6a4ff">看板</a></td>
          </tr>`,
          )
          .join('')}
      </tbody></table>`
      : `<div class="card empty">还没有需要结算的托管客户（托管客户开通后会自动按效果计费）。</div>`
  }
`;
  return layout({ title: '结算看板', active: '/billing', body });
}

/**
 * 客户列表（仅管理员）：一屏看所有客户的最新分数与账号。
 */
export function clientsPage({ clients = [], plans = [], generatedAt = '' } = {}) {
  const rows = clients
    .map(
      (c) => `<tr>
        <td><b>${esc(c.name ?? c.slug)}</b><div class="sub mono">${esc(c.slug)}</div></td>
        <td class="mono">${c.latestScore === null || c.latestScore === undefined ? '—' : esc(c.latestScore)}</td>
        <td>${esc(c.level ?? '—')}</td>
        <td class="mono">${esc(c.runs ?? 0)}</td>
        <td class="mono">${esc(c.lastRunAt ? String(c.lastRunAt).slice(0, 10) : '—')}</td>
        <td class="mono">${esc(c.users ?? 0)}</td>
        <td><span class="badge ${c.mode === 'managed' ? 'info' : 'mut'}">${esc(c.modeName ?? '—')}</span></td>
        <td>${esc(c.planName ?? '未开通')}${c.expired ? ' <span class="badge bad">已到期</span>' : ''}</td>
        <td class="mono">${esc(c.expireAt ? String(c.expireAt).slice(0, 10) : '—')}</td>
        <td class="mono">${esc(c.quotaQuestions ?? 0)}</td>
        <td><a href="/?brand=${encodeURIComponent(c.slug)}" style="color:#b6a4ff">看板</a></td>
      </tr>`,
    )
    .join('');
  return layout({
    title: '客户管理',
    active: '/clients',
    body: `
<h1>客户管理</h1>
<div class="sub">共 ${esc(clients.length)} 个客户 · 生成于 ${esc(generatedAt)}</div>

<h2>开通 / 续费订阅</h2>
<div class="card">
  <form id="subForm" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
    <div><label class="sub">客户</label><br>
      <select name="slug" required style="background:#0a0b0f;color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:9px 11px">
        ${clients.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}（${esc(c.slug)}）</option>`).join('')}
      </select></div>
    <div><label class="sub">服务模式</label><br>
      <select name="mode" style="background:#0a0b0f;color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:9px 11px">
        <option value="self_service">自助版（客户自己用）</option>
        <option value="managed">托管版（我们全托管）</option>
      </select></div>
    <div><label class="sub">套餐</label><br>
      <select name="plan" style="background:#0a0b0f;color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:9px 11px">
        ${plans.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} · ¥${esc(p.priceMonthly)}/月 · ${esc(p.quotaQuestions)} 题</option>`).join('')}
      </select></div>
    <div><label class="sub">时长（天）</label><br>
      <input name="days" type="number" value="30" min="1" max="3650" style="width:110px;background:#0a0b0f;color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:9px 11px"></div>
    <button type="submit" style="background:var(--accent);color:#fff;border:0;border-radius:9px;padding:10px 16px;cursor:pointer">开通 / 续费</button>
  </form>
  <div id="smsg" class="sub" style="margin-top:10px"></div>
</div>

<h2>新建客户</h2>
<div class="card">
  <form id="createForm" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
    <div><label class="sub">品牌名</label><br><input name="name" placeholder="如 王某的烘焙店" required style="background:#0a0b0f;color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:9px 11px"></div>
    <div><label class="sub">slug（英文）</label><br><input name="slug" placeholder="wang-bakery" required pattern="[a-z0-9-]+" style="background:#0a0b0f;color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:9px 11px"></div>
    <div><label class="sub">城市</label><br><input name="city" placeholder="芜湖" style="background:#0a0b0f;color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:9px 11px"></div>
    <div><label class="sub">官网</label><br><input name="url" placeholder="https://" style="background:#0a0b0f;color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:9px 11px;min-width:200px"></div>
    <button type="submit" style="background:var(--accent);color:#fff;border:0;border-radius:9px;padding:10px 16px;cursor:pointer">创建</button>
  </form>
  <div id="msg" class="sub" style="margin-top:10px"></div>
</div>

<h2>创建客户账号</h2>
<div class="card">
  <form id="userForm" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
    <div><label class="sub">登录名</label><br><input name="username" placeholder="wanglaoban" required style="background:#0a0b0f;color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:9px 11px"></div>
    <div><label class="sub">初始密码（≥8 位）</label><br><input name="password" type="password" required minlength="8" style="background:#0a0b0f;color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:9px 11px"></div>
    <div><label class="sub">绑定客户</label><br>
      <select name="brandSlug" required style="background:#0a0b0f;color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:9px 11px">
        ${clients.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}（${esc(c.slug)}）</option>`).join('')}
      </select></div>
    <button type="submit" style="background:var(--accent);color:#fff;border:0;border-radius:9px;padding:10px 16px;cursor:pointer">创建账号</button>
  </form>
  <div id="umsg" class="sub" style="margin-top:10px"></div>
</div>

<h2>全部客户</h2>
${
    clients.length
      ? `<table><thead><tr><th>客户</th><th>最新分</th><th>等级</th><th>运行</th><th>最近运行</th><th>账号</th><th>模式</th><th>套餐</th><th>到期</th><th>配额</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="card empty">还没有客户</div>`
  }

<script>
document.getElementById('createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const payload = Object.fromEntries(form.entries());
  const msg = document.getElementById('msg');
  msg.textContent = '创建中…';
  const res = await fetch('/api/clients', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await res.json();
  msg.textContent = res.ok ? '已创建：' + data.client.slug + '（刷新页面可见）' : '失败：' + (data.error || res.status);
  if (res.ok) setTimeout(() => location.reload(), 800);
});
document.getElementById('subForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = Object.fromEntries(new FormData(e.target).entries());
  const msg = document.getElementById('smsg');
  const res = await fetch('/api/clients/subscription', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({}));
  msg.textContent = res.ok ? ('已开通：' + data.subscription.planName + ' / ' + data.subscription.modeName + '，到期 ' + String(data.subscription.expireAt).slice(0, 10)) : '失败：' + (data.error || res.status);
  if (res.ok) setTimeout(() => location.reload(), 900);
});
document.getElementById('userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = Object.fromEntries(new FormData(e.target).entries());
  const msg = document.getElementById('umsg');
  const res = await fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({}));
  msg.textContent = res.ok ? '已创建账号：' + data.user.username + '（绑定 ' + data.user.brandSlug + '）' : '失败：' + (data.error || res.status);
  if (res.ok) e.target.reset();
});
</script>`,
  });
}

/** 白标与配额设置（管理员可改全局与各客户） */
export function settingsPage({ brand = {}, settings = {}, isAdmin = false, generatedAt = '' } = {}) {
  const field = (name, label, value, hint = '') =>
    `<div style="margin-bottom:14px"><label class="sub">${esc(label)}</label><br>
      <input name="${esc(name)}" value="${esc(value ?? '')}" style="width:100%;max-width:520px;background:#0a0b0f;color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:9px 11px">
      ${hint ? `<div class="sub" style="margin-top:4px">${esc(hint)}</div>` : ''}</div>`;
  return layout({
    title: '白标与配额',
    active: '/settings',
    body: `
<h1>白标与配额</h1>
<div class="sub">客户看到的名字、颜色、页脚与用量上限 · 生成于 ${esc(generatedAt)}</div>

<form id="settingsForm" class="card" style="margin-top:16px">
  ${field('app_title', '系统名称', settings.app_title ?? systemName(), '显示在浏览器标题与页头')}
  ${field('logo_text', 'Logo 文案', settings.logo_text ?? systemName())}
  ${field('primary_color', '主色（HEX）', settings.primary_color ?? '#7c5cff')}
  ${field('footer_text', '页脚文案', settings.footer_text ?? '')}
  ${field('public_url', '对外访问地址', settings.public_url ?? '', '用于生成分享链接，如 https://geo.sanrenxing.cn')}
  ${field('quota_questions', '每月题数上限', settings.quota_questions ?? '300', '0 表示不限；超出后诊断会被拒绝')}
  <button type="submit" style="background:var(--accent);color:#fff;border:0;border-radius:9px;padding:10px 18px;cursor:pointer">保存</button>
  <span id="msg" class="sub" style="margin-left:10px"></span>
</form>

<div class="hint">白标只改「客户看到的东西」，不改算法口径。多客户场景下，每个客户可单独设配额；全局设置作用于默认品牌。</div>

<script>
document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = Object.fromEntries(new FormData(e.target).entries());
  const msg = document.getElementById('msg');
  const res = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({}));
  msg.textContent = res.ok ? '已保存' : '失败：' + (data.error || res.status);
});
</script>`,
  });
}

/** 审计日志（管理员）：谁在什么时候对哪个客户做了什么 */
export function auditLogPage({ entries = [], generatedAt = '' } = {}) {
  const rows = entries
    .map(
      (e) => `<tr><td class="mono">${esc(String(e.ts).slice(0, 19).replace('T', ' '))}</td>
        <td>${esc(e.actor ?? '—')}</td><td class="mono">${esc(e.brandSlug ?? '—')}</td>
        <td><span class="badge mut">${esc(e.action)}</span></td><td class="sub">${esc(e.detail ?? '')}</td></tr>`,
    )
    .join('');
  return layout({
    title: '审计日志',
    active: '/audit-log',
    body: `
<h1>审计日志</h1>
<div class="sub">登录、诊断、发布、分享等关键动作 · 最近 ${esc(entries.length)} 条 · ${esc(generatedAt)}</div>
${
    entries.length
      ? `<table style="margin-top:16px"><thead><tr><th>时间</th><th>操作者</th><th>客户</th><th>动作</th><th>详情</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="card empty" style="margin-top:16px">还没有审计记录</div>`
  }`,
  });
}

/**
 * 回答浏览器：逐条看 AI 到底怎么回答的（对标 elmo / aperture 的 Responses 视图）。
 * 客户最常问「AI 原话是什么、引用的是哪条链接」——这个页面就是给它的。
 */
export function responsesPage({ brand = {}, runs = [], runId = null, rows = [], engine = '', verdict = '' } = {}) {
  const verdictLabels = {
    recommended: ['推荐', 'ok'], conditionally_recommended: ['条件推荐', 'ok'], candidate: ['候选', 'info'],
    listed: ['列入', 'info'], mentioned: ['仅提及', 'mut'], not_mentioned: ['未提及', 'bad'],
    ambiguous: ['歧义', 'warn'], unknown: ['未知', 'mut'], refused: ['拒答', 'warn'], engine_error: ['引擎错误', 'bad'],
  };
  const engines = [...new Set(rows.map((r) => r.engine))].sort();
  const runOptions = runs
    .map((r) => `<option value="${esc(r.runId)}"${String(r.runId) === String(runId) ? ' selected' : ''}>#${esc(r.runId)} · ${esc(r.kind)}</option>`)
    .join('');
  const engineOptions = ['', ...engines]
    .map((e) => `<option value="${esc(e)}"${e === engine ? ' selected' : ''}>${esc(e || '全部引擎')}</option>`)
    .join('');
  const verdictOptions = ['', ...Object.keys(verdictLabels)]
    .map((v) => `<option value="${esc(v)}"${v === verdict ? ' selected' : ''}>${esc(v ? verdictLabels[v][0] : '全部判定')}</option>`)
    .join('');

  const items = rows
    .map((row) => {
      const [label, cls] = verdictLabels[row.verdict] ?? [row.verdict, 'mut'];
      const citations = Array.isArray(row.citations) ? row.citations : [];
      return `<div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center">
          <div><b>${esc(row.question)}</b></div>
          <div><span class="badge mut">${esc(row.engine)}</span> <span class="badge ${cls}">${esc(label)}</span>
          <span class="sub" style="margin-left:8px">${esc(citations.length)} 条引用 · ${esc(row.latencyMs ?? 0)}ms</span></div>
        </div>
        <details style="margin-top:8px"><summary class="sub" style="cursor:pointer">看 AI 原话</summary>
          <pre class="mono" style="white-space:pre-wrap;line-height:1.75;margin:8px 0 0;font-size:12.5px">${esc(row.text || '（空回答）')}</pre>
        </details>
        ${row.matchedText ? `<div class="sub" style="margin-top:6px">命中片段：<span class="mono">${esc(row.matchedText)}</span></div>` : ''}
        ${citations.length ? `<div class="sub" style="margin-top:6px">引用：${citations.slice(0, 5).map((c) => `<span class="mono">${esc(String(c.url ?? c).replace(/^https?:\/\//, '').slice(0, 40))}</span>`).join(' · ')}</div>` : ''}
      </div>`;
    })
    .join('');

  return layout({
    title: '回答浏览器',
    active: '/responses',
    body: `
<h1>回答浏览器</h1>
<div class="sub">逐条查看 AI 的原话、判定与引用来源 · 第 ${esc(rows.length)} 条 · ${esc([brand.city, brand.industry].filter(Boolean).join(' · '))}</div>

<form method="get" action="/responses" class="card" style="margin:16px 0;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
  <select name="run" style="background:#0a0b0f;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px">${runOptions}</select>
  <select name="engine" style="background:#0a0b0f;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px">${engineOptions}</select>
  <select name="verdict" style="background:#0a0b0f;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px">${verdictOptions}</select>
  <button type="submit" style="background:var(--accent);color:#fff;border:0;border-radius:8px;padding:8px 16px;cursor:pointer">筛选</button>
  <a href="/responses" class="sub">重置</a>
</form>

${items || '<div class="card empty">这一轮没有可展示的回答（或筛选后为空）</div>'}
`,
  });
}

/** 异动告警页：本期 vs 上期，谁掉了、谁涨了、该做什么 */
export function alertsPage({ brand = {}, result = {}, runId = null, runs = [], generatedAt = '' } = {}) {
  const icon = { critical: '🔴', warning: '🟡', positive: '🟢', info: '⚪' };
  const badge = { critical: 'bad', warning: 'warn', positive: 'ok', info: 'mut' };
  const runOptions = runs
    .map((r) => `<option value="${esc(r.runId)}"${String(r.runId) === String(runId) ? ' selected' : ''}>#${esc(r.runId)} · ${esc(r.kind)}</option>`)
    .join('');
  const items = (result.alerts ?? [])
    .map(
      (alert) => `<div class="card" style="margin-bottom:10px;border-left:3px solid ${alert.level === 'critical' ? '#ef4444' : alert.level === 'warning' ? '#f59e0b' : alert.level === 'positive' ? '#22c55e' : '#252a36'}">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <b>${icon[alert.level] ?? '•'} ${esc(alert.title)}</b>
        <span class="badge ${badge[alert.level] ?? 'mut'}">${esc(alert.level)}</span>
      </div>
      <div class="sub" style="margin-top:6px">${esc(alert.detail)}</div>
      <div class="sub" style="margin-top:6px;color:#8b93a7">→ ${esc(alert.action)}</div>
    </div>`,
    )
    .join('');
  const s = result.summary ?? {};
  return layout({
    title: '异动告警',
    active: '/alerts',
    body: `
<h1>异动告警</h1>
<div class="sub">本期 vs 上期 · 阈值：提及率 ±${esc(result.thresholds?.mentionDropPt ?? 15)}pt / 总分 −${esc(result.thresholds?.scoreDrop ?? 10)} / 竞品 +${esc(result.thresholds?.competitorGainPt ?? 20)}pt</div>

<form method="get" action="/alerts" class="row" style="margin:16px 0">
  <select name="run" style="background:#0a0b0f;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px">${runOptions}</select>
  <button type="submit" style="background:var(--accent);color:#fff;border:0;border-radius:8px;padding:8px 16px;cursor:pointer">查看</button>
</form>

<div class="grid g4" style="margin-bottom:16px">
  <div class="card"><div class="k">告警总数</div><div class="v">${esc(s.total ?? 0)}</div></div>
  <div class="card"><div class="k">严重</div><div class="v" style="color:#f87171">${esc(s.critical ?? 0)}</div></div>
  <div class="card"><div class="k">警告</div><div class="v" style="color:#fbbf24">${esc(s.warning ?? 0)}</div></div>
  <div class="card"><div class="k">利好</div><div class="v" style="color:#4ade80">${esc(s.positive ?? 0)}</div></div>
</div>

${items || '<div class="card empty">本期没有异动</div>'}

<div class="hint">告警来自两轮真实数据的环比，不是模型判断。阈值可在「白标与配额」里用
<span class="mono">alert_mention_drop_pt</span> / <span class="mono">alert_score_drop</span> / <span class="mono">alert_competitor_gain_pt</span> 调整。</div>
`,
  });
}

/** 内容归因页：哪篇文章被 AI 引用了 */
export function attributionPage({ brand = {}, report = {}, generatedAt = '' } = {}) {
  const totals = report.totals ?? {};
  const rows = (report.byContent ?? [])
    .map(
      (item, index) => `<tr>
      <td class="mono">${index + 1}</td>
      <td><b>${esc(item.title || `#${item.contentId}`)}</b><div class="sub">${esc(item.publications.map((p) => `${p.channel}（${p.status}）`).join(' · '))}</div></td>
      <td class="mono">${esc(item.citations)}</td>
      <td class="sub">${esc(item.engines.join('、') || '—')}</td>
      <td class="sub">${esc(item.questions.slice(0, 2).join('；') || '—')}</td>
    </tr>`,
    )
    .join('');
  return layout({
    title: '内容归因',
    active: '/attribution',
    body: `
<h1>内容引用归因</h1>
<div class="sub">我们发的哪篇文章被 AI 引用了 · 生成于 ${esc(generatedAt)}</div>

<div class="grid g4" style="margin:16px 0">
  <div class="card"><div class="k">AI 引用总数</div><div class="v">${esc(totals.citations ?? 0)}</div><div class="sub">来自 ${esc(totals.questions ?? 0)} 个问题</div></div>
  <div class="card"><div class="k">自有域名被引</div><div class="v">${esc(totals.ownCitations ?? 0)}</div><div class="sub">占比 ${(((totals.ownShare ?? 0)) * 100).toFixed(1)}%</div></div>
  <div class="card"><div class="k">已绑定内容</div><div class="v">${esc(totals.contents ?? 0)}</div><div class="sub">有发布 URL 的内容</div></div>
  <div class="card"><div class="k">发布记录</div><div class="v">${esc(totals.publications ?? 0)}</div><div class="sub">含 dry_run</div></div>
</div>

<h2>内容贡献榜</h2>
${
    (report.byContent ?? []).length
      ? `<table><thead><tr><th>#</th><th>内容 / 渠道</th><th>被引次数</th><th>引擎</th><th>命中问题</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="card empty">本期没有「已发布 URL」被引用。先在内容库里给内容补发布 URL（publish --url），再跑诊断。</div>`
  }

<h2>自有域名被引（未绑定内容）</h2>
${
    (report.ownCitationsUnmatched ?? []).length
      ? `<div class="card"><ul style="margin:0;padding-left:20px;line-height:1.9">${report.ownCitationsUnmatched.map((c) => `<li class="mono">${esc(c.url)}（${esc(c.engine)}）</li>`).join('')}</ul></div>`
      : `<div class="card empty">无（或自有域名没有被引）</div>`
  }

<h2>引用源 Top</h2>
<div class="card"><ul style="margin:0;padding-left:20px;line-height:1.9">
${(report.topDomains ?? []).slice(0, 10).map((d) => `<li>${esc(d.domain)}${d.own ? ' <span class="badge ok">自有</span>' : ''} · ${esc(d.count)} 次</li>`).join('') || '<li class="sub">无引用</li>'}
</ul></div>
`,
  });
}

/** 竞品对位页：同一个问题，AI 提了谁 */
export function comparePage({ brand = {}, report = {}, generatedAt = '' } = {}) {
  const s = report.summary ?? {};
  const gaps = (report.gaps ?? [])
    .map((gap) => `<tr><td>${esc(gap.question)}</td><td>${esc(gap.competitors.join('、'))}</td></tr>`)
    .join('');
  const strengths = (report.strengths ?? []).map((item) => `<li>${esc(item.question)}</li>`).join('');
  return layout({
    title: '竞品对位',
    active: '/compare',
    body: `
<h1>竞品对位</h1>
<div class="sub">同一个问题，AI 提了谁、没提谁 · ${esc((report.competitors ?? []).join('、') || '未配置竞品')} · 生成于 ${esc(generatedAt)}</div>

<div class="grid g4" style="margin:16px 0">
  <div class="card"><div class="k">本品牌胜率</div><div class="v">${((s.winRate ?? 0) * 100).toFixed(1)}%</div><div class="sub">${esc(s.brandWins ?? 0)} / ${esc(s.total ?? 0)} 题</div></div>
  <div class="card"><div class="k">竞品独占</div><div class="v" style="color:#f87171">${esc(s.competitorWins ?? 0)}</div><div class="sub">需要抢回来的问题</div></div>
  <div class="card"><div class="k">双方都提</div><div class="v">${esc(s.both ?? 0)}</div><div class="sub">正面竞争</div></div>
  <div class="card"><div class="k">都没提</div><div class="v">${esc(s.neither ?? 0)}</div><div class="sub">空白机会</div></div>
</div>

<h2>需要抢回来的问题</h2>
${
    gaps
      ? `<table><thead><tr><th>问题</th><th>竞品（被 AI 提到）</th></tr></thead><tbody>${gaps}</tbody></table>`
      : `<div class="card empty">本期没有竞品独占的问题</div>`
  }

<h2>我们的优势问题</h2>
${strengths ? `<div class="card"><ul style="margin:0;padding-left:20px;line-height:1.9">${strengths}</ul></div>` : '<div class="card empty">无</div>'}
`,
  });
}

/** 事实库页：登记与核对「内容只能引用的权威事实」 */
export function factsPage({ brand = {}, facts = [], health = {}, generatedAt = '' } = {}) {
  const rows = (facts ?? [])
    .map(
      (fact) => `<tr>
      <td class="mono">${esc(fact.key)}</td>
      <td>${esc(fact.value)}</td>
      <td class="mono sub">${esc(fact.sourceUrl ?? '—')}</td>
      <td>${esc(fact.owner ?? '—')}</td>
      <td class="mono">${esc(fact.validUntil ? String(fact.validUntil).slice(0, 10) : '长期')}</td>
      <td>${fact.status === 'verified' ? '<span class="badge ok">已核验</span>' : '<span class="badge warn">待核验</span>'}</td>
    </tr>`,
    )
    .join('');
  return layout({
    title: '事实库',
    active: '/facts',
    body: `
<h1>事实主数据</h1>
<div class="sub">内容与报告只能引用这里登记过的事实 · 生成于 ${esc(generatedAt)}</div>

<div class="grid g4" style="margin:16px 0">
  <div class="card"><div class="k">事实总数</div><div class="v">${esc(health.total ?? 0)}</div></div>
  <div class="card"><div class="k">已核验</div><div class="v" style="color:#4ade80">${esc(health.verified ?? 0)}</div></div>
  <div class="card"><div class="k">缺关键事实</div><div class="v" style="color:${(health.missing ?? []).length ? '#f87171' : '#4ade80'}">${esc((health.missing ?? []).length)}</div><div class="sub">${esc((health.missing ?? []).join('、') || '齐全')}</div></div>
  <div class="card"><div class="k">不可用</div><div class="v" style="color:${(health.unusable ?? []).length ? '#fbbf24' : '#4ade80'}">${esc((health.unusable ?? []).length)}</div><div class="sub">缺来源/过期/未核验</div></div>
</div>

<div class="hint">为什么要有这一页：AI 把价格、资质、地址说错一次，客户会被投诉甚至处罚。登记「唯一可信源 + 责任人 + 有效期」后，
写稿与报告只能引用可用事实；缺来源或过期的事实会被直接拦下。</div>

<h2>登记事实（命令行）</h2>
<div class="card"><pre class="mono" style="margin:0;white-space:pre-wrap">node bin/geo.js facts --brand ${esc(brand.slug ?? 'hengye')} --add \\
  --key legal_name --value "芜湖恒野数字科技有限公司" \\
  --source "https://你的官网/about" --owner "金XX" --valid-days 365</pre></div>

<h2>事实清单</h2>
${
    (facts ?? []).length
      ? `<table><thead><tr><th>字段</th><th>值</th><th>来源</th><th>责任人</th><th>有效期</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="card empty">还没有登记事实。先登记公司全称、城市、地址、电话、价格区间这 5 项关键事实。</div>`
  }
`,
  });
}

/** 巡检页：7×24 配置 + 最近运行历史 */
export function watchPage({ brand = {}, config = {}, history = [], generatedAt = '' } = {}) {
  const rows = (history ?? [])
    .map(
      (item) => `<tr><td class="mono">#${esc(item.id)}</td>
      <td class="mono">${esc(String(item.startedAt).slice(0, 19).replace('T', ' '))}</td>
      <td><span class="badge ${item.status === 'done' ? 'ok' : item.status === 'failed' ? 'bad' : 'info'}">${esc(item.status)}</span></td>
      <td class="sub mono">${esc(item.detail ?? '')}</td></tr>`,
    )
    .join('');
  const next = config.enabled
    ? new Date((config.lastRunAt ? new Date(config.lastRunAt).getTime() : Date.now()) + config.intervalMinutes * 60000).toLocaleString('zh-CN', { hour12: false })
    : '未启用';
  return layout({
    title: '巡检',
    active: '/watch',
    body: `
<h1>7×24 巡检</h1>
<div class="sub">按间隔自动跑诊断，出问题能看出来 · 生成于 ${esc(generatedAt)}</div>

<div class="grid g4" style="margin:16px 0">
  <div class="card"><div class="k">状态</div><div class="v" style="font-size:16px">${config.enabled ? '已启用' : '未启用'}</div></div>
  <div class="card"><div class="k">间隔</div><div class="v">${esc(config.intervalMinutes)}<small> 分钟</small></div></div>
  <div class="card"><div class="k">引擎 / 题数</div><div class="v" style="font-size:15px">${esc(config.engines)} · ${esc(config.limit)}</div></div>
  <div class="card"><div class="k">下次预计</div><div class="v" style="font-size:14px">${esc(next)}</div></div>
</div>

<div class="hint">系统本身不会常驻，靠 cron / launchd / systemd 触发。生成调度配置：<span class="mono">node bin/geo.js watch --brand ${esc(brand.slug ?? 'hengye')} --install</span>。
每次巡检都会写进下面的历史表，失败可追溯。</div>

<h2>最近运行</h2>
${
    (history ?? []).length
      ? `<table><thead><tr><th>#</th><th>开始时间</th><th>状态</th><th>详情</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="card empty">还没有巡检记录。启用后先手动跑一次：<span class="mono">node bin/geo.js watch --brand ${esc(brand.slug ?? 'hengye')} --run</span></div>`
  }
`,
  });
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
