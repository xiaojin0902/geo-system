/**
 * lib/plans.js
 * 服务模式与套餐：区分「客户自己用」和「全托管给我们」。
 *
 * 为什么要区分：两种生意的交付物不同——
 *   - self_service（自助）：客户登录自己跑诊断、看驾驶舱、出周报；我们只提供工具与配额。
 *   - managed（托管）：我们跑，客户只看结果（报告/周报/分享链接），执行动作对我们开放。
 *
 * 套餐只决定「配额与功能开关」，不决定算法口径——口径永远一致，避免客户之间结论不可比。
 */

export const SERVICE_MODES = Object.freeze({
  self_service: {
    id: 'self_service',
    name: '自助版',
    description: '客户自己登录使用：跑诊断、看驾驶舱、出周报、导出报告',
    clientCanAct: true,
  },
  managed: {
    id: 'managed',
    name: '托管版',
    description: '我们全托管：客户只读查看报告与周报，执行动作由服务商完成',
    clientCanAct: false,
  },
});

export const PLANS = Object.freeze([
  {
    id: 'basic',
    name: '基础版',
    priceMonthly: 299,
    quotaQuestions: 120,
    features: ['单品牌', '4 个引擎', '月度周报', '分享链接'],
    modes: ['self_service', 'managed'],
  },
  {
    id: 'pro',
    name: '专业版',
    priceMonthly: 699,
    quotaQuestions: 400,
    features: ['单品牌', '13 个引擎', '周报+月报', '分享链接', '内容矩阵分发'],
    modes: ['self_service', 'managed'],
  },
  {
    id: 'agency',
    name: '服务商版',
    priceMonthly: 1999,
    quotaQuestions: 1500,
    features: ['多品牌', '13 个引擎', '白标', 'API', '全部功能'],
    modes: ['self_service', 'managed'],
  },
]);

export function planOf(id) {
  return PLANS.find((plan) => plan.id === String(id ?? '').toLowerCase()) ?? null;
}

export function modeOf(id) {
  return SERVICE_MODES[String(id ?? '').toLowerCase()] ?? SERVICE_MODES.self_service;
}

/**
 * 解析某客户的订阅状态：套餐、模式、配额、是否到期、客户能否执行动作。
 * @param {object} settings 该客户在 settings 表里的键值
 * @param {{now?:number}} [options]
 */
export function resolveSubscription(settings = {}, { now = Date.now() } = {}) {
  const plan = planOf(settings.plan) ?? null;
  const mode = modeOf(settings.service_mode);
  const quotaRaw = Number(settings.quota_questions);
  const quota = Number.isFinite(quotaRaw) && quotaRaw >= 0 ? quotaRaw : (plan ? plan.quotaQuestions : 0);
  const expireAt = String(settings.expire_at ?? '').trim() || null;
  const expired = expireAt ? new Date(expireAt).getTime() < now : false;
  return {
    planId: plan?.id ?? null,
    planName: plan?.name ?? '未开通',
    priceMonthly: plan?.priceMonthly ?? 0,
    mode: mode.id,
    modeName: mode.name,
    quotaQuestions: quota,
    expireAt,
    expired,
    active: Boolean(plan) && !expired,
    clientCanAct: mode.clientCanAct && !expired,
  };
}
