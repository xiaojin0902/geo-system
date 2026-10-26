/**
 * lib/facts.js
 * 事实主数据：内容与报告只能引用这里登记过的事实（抗幻觉的底座）。
 *
 * 为什么这是合规的起点：
 *   2026 年 GEO 行业最大的风险不是「排不上去」，而是「AI 把错误事实说出去」——
 *   价格、资质、地址、电话写错一次，客户会被投诉甚至罚款。
 *   所以每个事实必须带：唯一可信源、责任人、有效期、状态。
 *   内容生成时只允许引用 verified 且未过期的事实；过期/缺来源的事实直接拦下。
 *
 * 纯函数 + 常量，零依赖，不读写数据库。
 */

/** 事实字段目录：key → 标签、是否关键、示例、来源要求 */
export const FACT_KEYS = Object.freeze([
  { key: 'legal_name', label: '公司全称', critical: true, sourceType: 'official', example: '芜湖恒野数字科技有限公司' },
  { key: 'city', label: '所在城市', critical: true, sourceType: 'official', example: '芜湖' },
  { key: 'address', label: '注册/办公地址', critical: true, sourceType: 'official', example: '芜湖市镜湖区…' },
  { key: 'phone', label: '联系电话', critical: true, sourceType: 'official', example: '400-xxx-xxxx' },
  { key: 'price_range', label: '价格区间', critical: true, sourceType: 'sales', example: '¥299–1,999/月' },
  { key: 'service_scope', label: '服务范围', critical: false, sourceType: 'official', example: '全国线上交付' },
  { key: 'founded_year', label: '成立年份', critical: false, sourceType: 'official', example: '2026' },
  { key: 'qualification', label: '资质/备案', critical: false, sourceType: 'official', example: 'ICP 备案号 …' },
  { key: 'service_hours', label: '服务时间', critical: false, sourceType: 'official', example: '工作日 9:00–18:00' },
  { key: 'refund_policy', label: '退款政策', critical: false, sourceType: 'contract', example: '未开始交付可全退' },
]);

const FACT_INDEX = new Map(FACT_KEYS.map((item) => [item.key, item]));

/** 事实状态 */
export const FACT_STATUS = Object.freeze({
  verified: { id: 'verified', label: '已核验' },
  pending: { id: 'pending', label: '待核验' },
  stale: { id: 'stale', label: '已过期' },
});

export function keyMeta(key) {
  return FACT_INDEX.get(String(key ?? '')) ?? null;
}

/** 事实是否可用于内容/报告 */
export function isUsable(fact, { now = Date.now() } = {}) {
  if (!fact) return { usable: false, reason: '事实不存在' };
  if (fact.status !== 'verified') return { usable: false, reason: `状态为「${FACT_STATUS[fact.status]?.label ?? fact.status}」，未核验不得引用` };
  if (!fact.sourceUrl) return { usable: false, reason: '缺少可信来源链接' };
  if (fact.validUntil && new Date(fact.validUntil).getTime() < now) {
    return { usable: false, reason: `已过期（有效期至 ${String(fact.validUntil).slice(0, 10)}）` };
  }
  return { usable: true, reason: '' };
}

/**
 * 事实健康度：内容生产前先看这个。
 * @param {Array} facts
 * @param {{now?:number, requiredKeys?:string[]}} [options]
 */
export function factHealth(facts = [], { now = Date.now(), requiredKeys = [] } = {}) {
  const list = Array.isArray(facts) ? facts : [];
  const byKey = new Map(list.map((fact) => [fact.key, fact]));
  const criticalKeys = requiredKeys.length
    ? requiredKeys
    : FACT_KEYS.filter((item) => item.critical).map((item) => item.key);

  const missing = criticalKeys.filter((key) => !byKey.has(key));
  const unusable = [];
  let expiringSoon = 0;
  const soon = now + 30 * 86400000;
  for (const fact of list) {
    const check = isUsable(fact, { now });
    if (!check.usable) unusable.push({ key: fact.key, reason: check.reason });
    else if (fact.validUntil && new Date(fact.validUntil).getTime() <= soon) expiringSoon += 1;
  }

  return {
    total: list.length,
    verified: list.filter((fact) => fact.status === 'verified').length,
    missing,
    unusable,
    expiringSoon,
    ready: missing.length === 0 && unusable.length === 0,
    requiredKeys: criticalKeys,
  };
}

/**
 * 内容生成前的硬门槛：缺关键事实或事实不可用 → 不允许写稿。
 * @returns {{ok:boolean, blockers:Array<{type:string,detail:string,action:string}>}}
 */
export function contentGate(facts = [], { now = Date.now(), requiredKeys = [] } = {}) {
  const health = factHealth(facts, { now, requiredKeys });
  const blockers = [];
  for (const key of health.missing) {
    blockers.push({
      type: 'missing',
      detail: `缺少关键事实「${keyMeta(key)?.label ?? key}」`,
      action: `补登记：node bin/geo.js facts --add --key ${key} --value "…" --source "https://…" --owner "责任人"`,
    });
  }
  for (const item of health.unusable) {
    blockers.push({
      type: 'unusable',
      detail: `事实「${keyMeta(item.key)?.label ?? item.key}」不可用：${item.reason}`,
      action: '更新该事实的来源/有效期，或标记为已核验后重试',
    });
  }
  return { ok: blockers.length === 0, blockers, health };
}

/** 把可用事实渲染成「权威事实表」，供 brief/写稿 prompt 引用 */
export function renderFactsForPrompt(facts = [], { now = Date.now() } = {}) {
  const usable = (facts ?? []).filter((fact) => isUsable(fact, { now }).usable);
  if (!usable.length) return '（暂无已核验事实，禁止编造具体数字、资质、价格）';
  const lines = ['以下为已核验事实，只能引用这些，不得改写数字与名称：'];
  for (const fact of usable) {
    lines.push(`- ${keyMeta(fact.key)?.label ?? fact.key}：${fact.value}（来源：${fact.sourceUrl}）`);
  }
  return lines.join('\n');
}

/** 渲染 Markdown 清单 */
export function renderFactsMarkdown(facts = [], { now = Date.now(), requiredKeys = [] } = {}) {
  const health = factHealth(facts, { now, requiredKeys });
  const lines = [];
  lines.push('# 事实主数据（抗幻觉）', '');
  lines.push(`共 ${health.total} 条，已核验 ${health.verified} 条；缺关键事实 ${health.missing.length} 项；不可用 ${health.unusable.length} 项；30 天内到期 ${health.expiringSoon} 项。`, '');
  if (health.missing.length) {
    lines.push('## 缺关键事实', '');
    for (const key of health.missing) lines.push(`- ${keyMeta(key)?.label ?? key}（${key}）`);
    lines.push('');
  }
  if (health.unusable.length) {
    lines.push('## 不可用事实', '');
    for (const item of health.unusable) lines.push(`- ${keyMeta(item.key)?.label ?? item.key}：${item.reason}`);
    lines.push('');
  }
  lines.push('## 事实清单', '');
  lines.push('| 字段 | 值 | 来源 | 责任人 | 有效期 | 状态 |', '| --- | --- | --- | --- | --- | --- |');
  for (const fact of facts ?? []) {
    const check = isUsable(fact, { now });
    lines.push(
      `| ${keyMeta(fact.key)?.label ?? fact.key} | ${fact.value} | ${fact.sourceUrl ?? '—'} | ${fact.owner ?? '—'} | ${fact.validUntil ? String(fact.validUntil).slice(0, 10) : '长期'} | ${check.usable ? '可用' : check.reason} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}
