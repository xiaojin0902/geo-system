/**
 * lib/views.js — 页面（代运营交付视角，只保留 3 类页面：工作台 / 客户 / 设置）
 */
const ESC = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let THEME = { title: '恒见 GEO', color: '#7c5cff' };

export function setTheme(partial = {}) {
  THEME = { title: String(partial.title ?? THEME.title), color: String(partial.color ?? THEME.color) };
}

const CSS = `
:root{--bg:#0b0c10;--panel:#14161d;--panel2:#1a1d26;--line:#262b37;--ink:#e9ecf3;--dim:#8d95a8;--dim2:#5d6577;--accent:${THEME.color};--ok:#22c55e;--warn:#f59e0b;--bad:#ef4444}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
a{color:inherit;text-decoration:none}
.nav{display:flex;align-items:center;gap:14px;padding:10px 22px;border-bottom:1px solid var(--line);background:rgba(11,12,16,.95);position:sticky;top:0;z-index:5}
.nav .logo{font-weight:700}.nav .logo i{color:var(--accent);font-style:normal}
.nav a{color:var(--dim);font-size:13px;padding:4px 10px;border-radius:8px}
.nav a:hover{background:var(--panel);color:var(--ink)}
.nav .sp{flex:1}.nav .who{color:var(--dim2);font-size:12px}
.wrap{max-width:1120px;margin:0 auto;padding:26px 22px 70px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:26px 0 10px}
.sub{color:var(--dim2);font-size:12px}
.card{background:linear-gradient(160deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.grid{display:grid;gap:14px}.g4{grid-template-columns:repeat(4,1fr)}.g2{grid-template-columns:repeat(2,1fr)}
.k{color:var(--dim2);font-size:11px;letter-spacing:.06em;text-transform:uppercase}
.v{font-size:24px;font-weight:650}.v small{font-size:12px;color:var(--dim)}
.badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:6px}
.ok{background:rgba(34,197,94,.14);color:#4ade80}.warn{background:rgba(245,158,11,.14);color:#fbbf24}
.bad{background:rgba(239,68,68,.14);color:#f87171}.mut{background:rgba(141,149,168,.14);color:#a9b1c3}
.btn{display:inline-block;background:var(--accent);color:#fff;border:0;border-radius:9px;padding:8px 14px;font-size:13px;cursor:pointer}
.btn.ghost{background:var(--panel2);border:1px solid var(--line);color:var(--ink)}
.steps{display:flex;gap:6px;margin:10px 0}
.step{flex:1;border:1px solid var(--line);border-radius:9px;padding:8px 10px;font-size:12px;color:var(--dim)}
.step.done{border-color:rgba(34,197,94,.5);color:#4ade80;background:rgba(34,197,94,.08)}
.step.now{border-color:rgba(124,92,255,.6);color:#b6a4ff;background:rgba(124,92,255,.1)}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:9px 10px;border-bottom:1px solid var(--line);text-align:left}
th{color:var(--dim2);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}
.empty{padding:24px;text-align:center;color:var(--dim2)}
.hint{border-left:3px solid var(--accent);background:rgba(124,92,255,.08);padding:11px 15px;border-radius:0 10px 10px 0;font-size:12.5px;color:#cfd5e3;margin:12px 0}
input,select{background:var(--panel);border:1px solid var(--line);color:var(--ink);border-radius:9px;padding:8px 11px;font-size:13px;font-family:inherit}
label{display:block;font-size:12px;color:var(--dim);margin:10px 0 4px}
@media(max-width:820px){.g4,.g2{grid-template-columns:1fr 1fr}.steps{flex-wrap:wrap}}
`;

const LOGIN_CSS = `body{display:flex;align-items:center;justify-content:center;min-height:100vh}.box{width:340px;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:26px}`;

function shell({ title, body, active = '' }) {
  const nav = [
    ['/', '工作台'],
    ['/clients', '客户'],
    ['/settings', '设置'],
  ].map(([href, label]) => `<a href="${href}" style="${href === active ? 'color:#b6a4ff;background:rgba(124,92,255,.14)' : ''}">${label}</a>`).join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ESC(title)} · ${ESC(THEME.title)}</title><style>${CSS}</style></head><body>
<div class="nav"><span class="logo">${ESC(THEME.title)}</span>${nav}<span class="sp"></span><span class="who"><a href="/logout">退出</a></span></div>
<div class="wrap">${body}</div></body></html>`;
}

/** 登录页 */
export function loginPage({ error = '' } = {}) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · ${ESC(THEME.title)}</title><style>${CSS}${LOGIN_CSS}</style></head><body>
<form class="box" method="post" action="/login">
  <h1 style="font-size:19px;margin:0 0 4px">${ESC(THEME.title)}</h1>
  <div class="sub" style="margin-bottom:14px">GEO 代运营交付系统</div>
  ${error ? `<div class="badge bad" style="display:block;margin-bottom:12px">${ESC(error)}</div>` : ''}
  <label>用户名</label><input name="username" required autofocus style="width:100%">
  <label>密码</label><input name="password" type="password" required style="width:100%">
  <button class="btn" style="width:100%;margin-top:16px" type="submit">登录</button>
</form></body></html>`;
}

const STEP_LABELS = { diagnose: '诊断', plan: '方案', content: '内容', publish: '发布', remeasure: '复测', deliver: '交付' };
const STEP_ORDER = ['diagnose', 'plan', 'content', 'publish', 'remeasure', 'deliver'];

function stepBar(tasks = []) {
  const byStep = new Map();
  for (const task of tasks) {
    const list = byStep.get(task.step) ?? [];
    list.push(task);
    byStep.set(task.step, list);
  }
  let currentFound = false;
  return `<div class="steps">${STEP_ORDER.map((step) => {
    const list = byStep.get(step) ?? [];
    const done = list.length > 0 && list.every((task) => task.status === 'done');
    let cls = '';
    if (done) cls = 'done';
    else if (!currentFound) { cls = 'now'; currentFound = true; }
    return `<div class="step ${cls}">${STEP_LABELS[step]}${done ? ' ✓' : ''}</div>`;
  }).join('')}</div>`;
}

/** 工作台：客户卡片 + 今日待办 */
export function dashboardPage({ clients = [], summary = {}, today = [] } = {}) {
  const cards = clients.map((item) => {
    const { client, cycle, tasks, score, analysis } = item;
    const due = tasks.filter((task) => task.status !== 'done').slice(0, 2);
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <div><b style="font-size:15px">${ESC(client.name)}</b><div class="sub">${ESC(client.industry ?? '')} · ${ESC(client.city ?? '')} · ${ESC(cycle?.period ?? '未开周期')}</div></div>
        <a class="btn ghost" href="/client/${encodeURIComponent(client.slug)}">进入</a>
      </div>
      ${stepBar(tasks)}
      <div style="display:flex;gap:16px;font-size:12px;color:var(--dim)">
        <span>总分 <b class="${score?.total >= 60 ? 'ok' : score?.total >= 30 ? 'warn' : 'bad'}">${score?.total ?? '—'}</b></span>
        <span>提及率 ${((analysis?.sample?.mentionRate ?? 0) * 100).toFixed(0)}%</span>
        <span>待办 ${tasks.filter((t) => t.status !== 'done').length}</span>
      </div>
      ${due.length ? `<div class="sub" style="margin-top:8px">下一步：${due.map((task) => ESC(task.title)).join('；')}</div>` : '<div class="sub" style="margin-top:8px">本轮已全部完成</div>'}
    </div>`;
  }).join('');

  const todoRows = today.map((item) => `<tr>
    <td><a href="/client/${encodeURIComponent(item.slug)}" style="color:#b6a4ff">${ESC(item.clientName)}</a></td>
    <td>${ESC(STEP_LABELS[item.step] ?? item.step)}</td>
    <td>${ESC(item.title)}</td>
    <td class="mono">${ESC(item.dueAt ? String(item.dueAt).slice(0, 10) : '—')}</td>
  </tr>`).join('');

  return shell({
    title: '工作台',
    active: '/',
    body: `
<h1>工作台</h1>
<div class="sub">今天要交付什么，一眼看完 · ${ESC(summary.generatedAt ?? '')}</div>

<div class="grid g4" style="margin:16px 0">
  <div class="card"><div class="k">客户</div><div class="v">${clients.length}</div></div>
  <div class="card"><div class="k">进行中周期</div><div class="v">${clients.filter((item) => item.cycle).length}</div></div>
  <div class="card"><div class="k">待办</div><div class="v">${summary.openTasks ?? 0}</div></div>
  <div class="card"><div class="k">平均分</div><div class="v">${summary.avgScore ?? '—'}</div></div>
</div>

<div class="hint">流程固定六步：<b>诊断 → 方案 → 内容 → 发布 → 复测 → 交付</b>。点「进入」看单个客户的待办与结果。</div>

<h2>今日待办</h2>
${todoRows ? `<table><tr><th>客户</th><th>步骤</th><th>任务</th><th>截止</th></tr>${todoRows}</table>` : '<div class="card empty">今天没有待办，去「客户」里新建一个或跑一轮诊断</div>'}

<h2>客户</h2>
<div class="grid g2">${cards || '<div class="card empty">还没有客户。<a class="btn" href="/clients">新建客户</a></div>'}</div>

<h2>快速开始</h2>
<div class="card" style="display:flex;gap:10px;flex-wrap:wrap">
  <a class="btn" href="/clients">新建客户</a>
  <a class="btn ghost" href="/settings">引擎与白标</a>
</div>`,
  });
}

/** 客户详情 */
export function clientPage({ client = {}, cycle = {}, tasks = [], analysis = {}, score = {}, actions = [], contents = [], publishes = [], deliverables = [] } = {}) {
  const taskRows = tasks.map((task) => `<tr>
    <td>${ESC(STEP_LABELS[task.step] ?? task.step)}</td>
    <td>${ESC(task.title)}<div class="sub">${ESC(task.detail ?? '')}</div></td>
    <td class="mono">${ESC(task.dueAt ? String(task.dueAt).slice(0, 10) : '—')}</td>
    <td>${task.status === 'done' ? '<span class="badge ok">已完成</span>' : `<form method="post" action="/task/${task.id}/done" style="display:inline"><button class="btn ghost" style="padding:3px 10px">完成</button></form>`}</td>
  </tr>`).join('');
  const contentRows = contents.map((item) => `<tr><td>${ESC(item.kind)}</td><td>${ESC(item.title)}</td><td><span class="badge mut">${ESC(item.status)}</span></td><td class="mono">${ESC(item.createdAt?.slice(0, 10) ?? '')}</td></tr>`).join('');
  const publishRows = publishes.map((item) => `<tr><td>${ESC(item.title)}</td><td>${ESC(item.channel)}</td><td class="mono">${ESC(item.url ?? '—')}</td><td class="mono">${ESC(item.publishedAt?.slice(0, 10) ?? '')}</td></tr>`).join('');
  const deliverRows = deliverables.map((item) => `<tr><td>${ESC(item.kind)}</td><td class="mono">${item.token ? `<a href="/s/${ESC(item.token)}" style="color:#b6a4ff">分享链接</a>` : ESC(item.path ?? '—')}</td><td class="mono">${ESC(item.createdAt?.slice(0, 16) ?? '')}</td></tr>`).join('');

  return shell({
    title: client.name,
    active: '/',
    body: `
<h1>${ESC(client.name)}</h1>
<div class="sub">${ESC(client.industry ?? '')} · ${ESC(client.city ?? '')} · ${ESC(client.url ?? '')} · 周期 ${ESC(cycle.period ?? '—')}</div>
${stepBar(tasks)}

<div class="grid g4" style="margin:14px 0">
  <div class="card"><div class="k">总分</div><div class="v">${score.total ?? '—'}<small>/100</small></div><div class="sub">${ESC(score.level ?? '')}</div></div>
  <div class="card"><div class="k">提及率</div><div class="v">${((analysis.sample?.mentionRate ?? 0) * 100).toFixed(1)}%</div><div class="sub">有效 ${analysis.sample?.ok ?? 0}/${analysis.sample?.total ?? 0}</div></div>
  <div class="card"><div class="k">引用源</div><div class="v">${analysis.citations?.domains?.length ?? 0}</div><div class="sub">共 ${analysis.citations?.total ?? 0} 条</div></div>
  <div class="card"><div class="k">内容 / 发布</div><div class="v" style="font-size:18px">${contents.length} / ${publishes.length}</div></div>
</div>

<div class="card" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
  <form method="post" action="/client/${encodeURIComponent(client.slug)}/diagnose" style="display:flex;gap:8px;align-items:center">
    <select name="engine"><option value="mock">Mock（不花钱）</option><option value="deepseek">DeepSeek</option></select>
    <input name="limit" type="number" value="5" min="1" max="30" style="width:70px">
    <button class="btn" type="submit">跑诊断</button>
  </form>
  <form method="post" action="/client/${encodeURIComponent(client.slug)}/content" style="display:flex;gap:8px;align-items:center">
    <button class="btn ghost" type="submit">生成 1 篇内容</button>
  </form>
  <form method="post" action="/client/${encodeURIComponent(client.slug)}/deliver" style="display:flex;gap:8px;align-items:center">
    <button class="btn ghost" type="submit">生成报告 + 分享链接</button>
  </form>
</div>

<h2>行动建议</h2>
<div class="card"><ul style="margin:0;padding-left:20px">${(actions ?? []).map((action) => `<li>${ESC(action)}</li>`).join('') || '<li>先跑一轮诊断</li>'}</ul></div>

<h2>待办（六步流程）</h2>
${taskRows ? `<table><tr><th>步骤</th><th>任务</th><th>截止</th><th></th></tr>${taskRows}</table>` : '<div class="card empty">还没有待办，跑一轮诊断后自动生成</div>'}

<h2>内容</h2>
${contentRows ? `<table><tr><th>类型</th><th>标题</th><th>状态</th><th>创建</th></tr>${contentRows}</table>` : '<div class="card empty">还没有内容</div>'}

<h2>发布</h2>
${publishRows ? `<table><tr><th>内容</th><th>渠道</th><th>链接</th><th>时间</th></tr>${publishRows}</table>` : '<div class="card empty">还没有发布记录</div>'}

<h2>交付物</h2>
${deliverRows ? `<table><tr><th>类型</th><th>位置</th><th>时间</th></tr>${deliverRows}</table>` : '<div class="card empty">还没有交付物</div>'}
`,
  });
}

/** 设置页 */
export function settingsPage({ engines = [], settings = {} } = {}) {
  return shell({
    title: '设置',
    active: '/settings',
    body: `
<h1>设置</h1>
<div class="sub">引擎密钥来自 .env；白标与系统名可改</div>

<h2>引擎状态</h2>
<table><tr><th>引擎</th><th>状态</th><th>说明</th></tr>
${engines.map((engine) => `<tr><td>${ESC(engine.label)}</td><td>${engine.configured ? '<span class="badge ok">可用</span>' : '<span class="badge mut">未配置</span>'}</td><td class="sub">${ESC(engine.note ?? '')}</td></tr>`).join('')}
</table>
<div class="hint">配置方式：在 <span class="mono">app/.env</span> 写 <span class="mono">DEEPSEEK_API_KEY=sk-…</span>，重启服务生效。</div>

<h2>白标</h2>
<form method="post" action="/settings" class="card">
  <label>系统名称</label><input name="title" value="${ESC(settings.title ?? '恒见 GEO')}" style="width:100%;max-width:420px">
  <label>主色（HEX）</label><input name="color" value="${ESC(settings.color ?? '#7c5cff')}" style="width:160px">
  <div style="margin-top:14px"><button class="btn" type="submit">保存</button></div>
</form>
`,
  });
}

/** 新建客户页 */
export function clientsPage({ clients = [] } = {}) {
  const rows = clients.map((client) => `<tr>
    <td><b>${ESC(client.name)}</b><div class="sub mono">${ESC(client.slug)}</div></td>
    <td>${ESC(client.industry ?? '—')}</td><td>${ESC(client.city ?? '—')}</td>
    <td>${ESC((client.competitors ?? []).join('、') || '—')}</td>
    <td><a class="btn ghost" href="/client/${encodeURIComponent(client.slug)}">进入</a></td>
  </tr>`).join('');
  return shell({
    title: '客户',
    active: '/clients',
    body: `
<h1>客户</h1>
<div class="sub">一个客户 = 一个交付周期（诊断→方案→内容→发布→复测→交付）</div>

<h2>新建客户</h2>
<form method="post" action="/clients" class="card" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
  <div><label>客户名</label><input name="name" required placeholder="演示家政"></div>
  <div><label>英文短名（slug）</label><input name="slug" required pattern="[a-z0-9-]+" placeholder="demo-jiazheng"></div>
  <div><label>行业</label><input name="industry" placeholder="家政"></div>
  <div><label>城市</label><input name="city" placeholder="芜湖"></div>
  <div><label>竞品（逗号分隔）</label><input name="competitors" placeholder="同行A,同行B"></div>
  <div><button class="btn" type="submit">创建</button></div>
</form>

<h2>全部客户</h2>
${rows ? `<table><tr><th>客户</th><th>行业</th><th>城市</th><th>竞品</th><th></th></tr>${rows}</table>` : '<div class="card empty">还没有客户</div>'}
`,
  });
}
