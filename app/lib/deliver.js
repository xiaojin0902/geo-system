/**
 * lib/deliver.js — 交付物：报告页、周报、分享 token。
 * 输出自包含 HTML（可直接发客户 / 打印成 PDF）。
 */
import crypto from 'node:crypto';

const ESC = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function createShareToken() {
  return crypto.randomBytes(16).toString('hex');
}

/** 报告页（深色、可打印） */
export function renderReportHtml({ client = {}, cycle = {}, analysis = {}, score = {}, actions = [], contents = [], publishes = [] } = {}) {
  const sample = analysis.sample ?? {};
  const verdicts = analysis.verdictCounts ?? {};
  const domains = (analysis.citations?.domains ?? []).slice(0, 8);
  const rows = Object.entries(verdicts)
    .filter(([, count]) => count > 0)
    .map(([id, count]) => `<tr><td>${ESC({ recommended: '推荐', listed: '列入', mentioned: '仅提及', not_mentioned: '未提及', ambiguous: '歧义', engine_error: '采集失败' }[id] ?? id)}</td><td>${count}</td></tr>`)
    .join('');
  const actionItems = (actions ?? []).map((action) => `<li>${ESC(action)}</li>`).join('');
  const domainItems = domains.map((item) => `<li><span class="mono">${ESC(item.domain)}</span> · ${item.count} 次</li>`).join('');
  const contentItems = (contents ?? []).map((item) => `<li>${ESC(item.title)} <span class="tag">${ESC(item.status)}</span></li>`).join('');
  const publishItems = (publishes ?? []).map((item) => `<li>${ESC(item.channel)}：<span class="mono">${ESC(item.url ?? '—')}</span></li>`).join('');

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ESC(client.name ?? '')} · AI 可见度报告（${ESC(cycle.period ?? '')}）</title>
<style>
body{margin:0;background:#0b0c10;color:#e9ecf3;font:14px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:32px 24px 64px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:15px;margin:26px 0 10px}
.sub{color:#8d95a8;font-size:12px}
.card{background:#14161d;border:1px solid #262b37;border-radius:14px;padding:18px;margin:14px 0}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.k{color:#5d6577;font-size:11px;letter-spacing:.06em;text-transform:uppercase}
.v{font-size:26px;font-weight:650}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:8px 10px;border-bottom:1px solid #262b37;text-align:left}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}
.tag{background:#262b37;border-radius:6px;padding:1px 6px;font-size:11px;color:#a9b1c3}
li{margin:4px 0}
@media print{body{background:#fff;color:#111}.card{border-color:#ddd}}
</style></head><body><div class="wrap">
<h1>${ESC(client.name ?? '')} · AI 可见度报告</h1>
<div class="sub">${ESC(cycle.period ?? '')} ｜ ${ESC(client.industry ?? '')} ｜ ${ESC(client.city ?? '')} ｜ 生成于 ${ESC(new Date().toLocaleString('zh-CN', { hour12: false }))}</div>

<div class="grid">
  <div class="card"><div class="k">总分</div><div class="v">${score.total ?? '—'}<small style="font-size:12px;color:#8d95a8">/100</small></div><div class="sub">${ESC(score.level ?? '')}</div></div>
  <div class="card"><div class="k">AI 提及率</div><div class="v">${((sample.mentionRate ?? 0) * 100).toFixed(1)}%</div><div class="sub">有效样本 ${sample.ok ?? 0}/${sample.total ?? 0}</div></div>
  <div class="card"><div class="k">引用源</div><div class="v">${analysis.citations?.domains?.length ?? 0}</div><div class="sub">共 ${analysis.citations?.total ?? 0} 条引用</div></div>
</div>

<h2>判定分布</h2><div class="card"><table><tr><th>判定</th><th>条数</th></tr>${rows || '<tr><td>暂无</td><td>0</td></tr>'}</table></div>

<h2>本月行动（按缺口生成）</h2><div class="card"><ul>${actionItems || '<li>暂无</li>'}</ul></div>

<h2>AI 引用了谁</h2><div class="card"><ul>${domainItems || '<li>本轮没有引用</li>'}</ul></div>

<h2>内容与发布</h2><div class="card"><ul>${contentItems || '<li>暂无内容</li>'}</ul><ul>${publishItems}</ul></div>

<p class="sub">口径：提及率 = 被提及的回答 / 有效回答；评分 = 提及 60 + 判定质量 25 + 引用多样性 15。所有数字可复算，不承诺排名。</p>
</div></body></html>`;
}

/** 周报 Markdown */
export function renderWeeklyMarkdown({ client = {}, analysis = {}, score = {}, actions = [], period = '' } = {}) {
  const sample = analysis.sample ?? {};
  const lines = [];
  lines.push(`# ${client.name ?? ''} · 周报（${period}）`, '');
  lines.push(`**本周结论**：AI 提及率 ${((sample.mentionRate ?? 0) * 100).toFixed(0)}%，总分 ${score.total ?? '—'}（${score.level ?? '—'}），共 ${sample.ok ?? 0} 条有效样本。`, '');
  lines.push('## 关键指标', '', '| 指标 | 本期 |', '| --- | --- |');
  lines.push(`| 总分 | ${score.total ?? '—'} |`);
  lines.push(`| 提及率 | ${((sample.mentionRate ?? 0) * 100).toFixed(1)}% |`);
  lines.push(`| 引用条数 | ${analysis.citations?.total ?? 0} |`);
  lines.push(`| 覆盖引擎 | ${(analysis.engines ?? []).length} |`, '');
  lines.push('## 本周做了什么', '');
  for (const action of actions.length ? actions : ['补实体信息', '官网可抓取改造', '铺 3 篇问答']) lines.push(`- ${action}`);
  lines.push('', '## 下周计划', '');
  lines.push('- 复测一轮，对比提及率与引用源');
  lines.push('- 把被引最多的平台再铺 2 篇');
  return `${lines.join('\n')}\n`;
}
