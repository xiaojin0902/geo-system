/**
 * lib/plan.js — 交付计划：把一个周期的六步拆成可勾选的任务（工作台待办来源）
 *
 * 六步固定：诊断 → 方案 → 内容 → 发布 → 复测 → 交付
 * 任务带步骤、负责人、截止日，工作台按天提醒。
 */

const DAY = 86400000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();

export const STEPS = Object.freeze([
  { id: 'diagnose', label: '诊断', desc: '跑一轮 AI 可见度采集' },
  { id: 'plan', label: '方案', desc: '按缺口定 3 个动作' },
  { id: 'content', label: '内容', desc: '写 3 篇可被引用的内容' },
  { id: 'publish', label: '发布', desc: '发到客户可控的渠道' },
  { id: 'remeasure', label: '复测', desc: '再跑一轮看变化' },
  { id: 'deliver', label: '交付', desc: '出报告与周报，发给客户' },
]);

/**
 * @param {{client?:object, analysis?:object, actions?:string[], period?:string}} input
 */
export function buildDeliveryPlan({ client = {}, analysis = {}, actions = [], period = '' } = {}) {
  const weakQuestions = (analysis.domains ?? []).length; // 占位，真实由调用方传问题
  const tasks = [];
  const push = (step, title, owner, offset, detail) => {
    tasks.push({ step, title, owner, dueAt: iso(offset), status: 'todo', detail: detail ?? '' });
  };

  push('plan', `出月度方案：${actions.length || 3} 个动作，写明谁做/何时验收`, '运营', 1, (actions ?? []).join('；'));
  for (let i = 1; i <= 3; i += 1) {
    push('content', `第 ${i} 篇内容：针对「${(analysis.topQuestions ?? [])[i - 1] ?? client.industry ?? '核心问题'}」写问答/对比`, '内容', 3 + i, '结论先行 + FAQ + 实体信息块');
  }
  push('publish', '发布到 2 个客户可控渠道（官网/公众号/知乎）', '运营', 8, '每篇带 URL 与账号，登记进系统');
  push('remeasure', '复测：再跑一轮采集，对比提及率与引用', '运营', 21, '口径与首轮一致');
  push('deliver', '交付：出报告 + 周报，发客户并约下次沟通', '运营', 28, '附带下月计划');

  return { period, tasks, steps: STEPS };
}

/** 把计划渲染成 Markdown（给客户看的月度方案） */
export function renderPlanMarkdown({ client = {}, analysis = {}, actions = [], period = '' } = {}) {
  const lines = [];
  lines.push(`# ${client.name ?? '客户'} · ${period} 交付方案`, '');
  lines.push(`行业：${client.industry ?? '—'} ｜ 城市：${client.city ?? '—'} ｜ 口径：本轮 ${analysis.sample?.total ?? 0} 条有效样本，提及率 ${((analysis.sample?.mentionRate ?? 0) * 100).toFixed(1)}%`, '');
  lines.push('## 结论', '');
  lines.push((analysis.sample?.mentionRate ?? 0) < 0.3
    ? 'AI 基本不提你，问题在「实体信息不可核实 + 缺少可引用信源」，先把这两块补上。'
    : '已有基础提及，重点是把「被提及」变成「被推荐 + 被引用」。');
  lines.push('', '## 本月三个动作', '');
  (actions.length ? actions : ['补齐实体信息', '官网可抓取改造', '铺 3 篇问答内容']).slice(0, 3).forEach((action, index) => {
    lines.push(`${index + 1}. ${action}`);
  });
  lines.push('', '## 六步交付节奏', '');
  lines.push('| 步骤 | 做什么 | 时间 |', '| --- | --- | --- |');
  for (const step of STEPS) lines.push(`| ${step.label} | ${step.desc} | 第 ${STEPS.indexOf(step) * 5 + 1}-${STEPS.indexOf(step) * 5 + 5} 天 |`);
  lines.push('', '## 验收口径', '');
  lines.push('- 提及率、引用源、竞品份额三个指标与首轮同口径对比');
  lines.push('- 每个数字可在看板与报告里复算，不承诺排名');
  return `${lines.join('\n')}\n`;
}
