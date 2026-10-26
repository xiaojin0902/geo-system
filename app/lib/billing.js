/**
 * lib/billing.js
 * 托管版「按效果计费」：只按真实涨出来的效果收钱。
 *
 * 为什么要单独做：
 *   托管服务如果按月固定收费，客户会觉得「没效果也在付钱」；
 *   按效果收费必须回答三个问题——计量什么、和谁比、怎么防扯皮。
 *   这个模块把三件事固定下来：
 *     1) 计量口径（只数可核验的事件：AI 提及条数、引用条数、提及率百分点、推荐次数）；
 *     2) 基线（上期或指定轮次，可复算）；
 *     3) 保底 + 封顶（避免客户零效果时我们白干，也避免单月暴涨客户不认）。
 *
 * 约束：纯函数、零依赖、不读写数据库、不发网络。
 */

const pct = (v) => `${((Number(v) || 0) * 100).toFixed(1)}%`;
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '—');

/** 可选的计费单位 */
export const BILLING_UNITS = Object.freeze([
  {
    id: 'mention_gain',
    name: '新增 AI 提及条数',
    description: '本期被 AI 提及的回答条数 − 上期同口径条数',
    defaultPrice: 80,
    unitLabel: '条',
  },
  {
    id: 'citation_gain',
    name: '新增引用条数',
    description: '本期 AI 回答里的引用总数 − 上期同口径',
    defaultPrice: 30,
    unitLabel: '条',
  },
  {
    id: 'mention_rate_pt',
    name: '提及率提升（百分点）',
    description: '本期提及率 − 上期提及率，按百分点计',
    defaultPrice: 200,
    unitLabel: 'pt',
  },
  {
    id: 'recommended_count',
    name: '被推荐次数（绝对值）',
    description: '本期判定为「推荐 / 条件推荐」的回答条数',
    defaultPrice: 150,
    unitLabel: '次',
  },
]);

export const BILLING_MODE = Object.freeze({
  fixed: { id: 'fixed', name: '固定月费' },
  performance: { id: 'performance', name: '按效果计费' },
});

export function unitOf(id) {
  return BILLING_UNITS.find((unit) => unit.id === id) ?? BILLING_UNITS[0];
}

/** 从一批 run 的行数据里统计口径指标（行结构同 analytics.analyzeRun 的 rows） */
export function measureRows(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const MENTIONED = new Set(['recommended', 'conditionally_recommended', 'candidate', 'listed', 'mentioned']);
  let answers = 0;
  let mentioned = 0;
  let recommended = 0;
  let citations = 0;
  let ownCitations = 0;
  for (const row of list) {
    const verdict = String(row?.judgment?.verdict ?? 'unknown');
    if (['ambiguous', 'unknown', 'refused', 'engine_error'].includes(verdict)) continue; // 无效样本不计
    answers += 1;
    if (MENTIONED.has(verdict)) mentioned += 1;
    if (verdict === 'recommended' || verdict === 'conditionally_recommended') recommended += 1;
    const cites = Array.isArray(row?.answer?.citations) ? row.answer.citations : [];
    citations += cites.length;
  }
  return {
    answers,
    mentioned,
    recommended,
    citations,
    mentionRate: answers ? mentioned / answers : 0,
    ownCitations,
  };
}

/**
 * 计算结算单。
 * @param {object} input
 * @param {{name?:string}} [input.brand]
 * @param {object} [input.current] measureRows 的结果（本期）
 * @param {object} [input.baseline] 基线口径（上期/指定轮次），缺省全 0
 * @param {object} [input.settings] billing_mode / billing_unit / billing_price / billing_min / billing_cap
 * @param {string} [input.month] 结算月份 YYYY-MM
 * @param {string} [input.baselineLabel] 基线说明（展示用，避免扯皮）
 */
export function computeSettlement({
  brand = {},
  current = {},
  baseline = {},
  settings = {},
  month = new Date().toISOString().slice(0, 7),
  baselineLabel = '上期同口径',
} = {}) {
  const mode = settings.billing_mode === 'performance' ? 'performance' : (settings.billing_mode === 'fixed' ? 'fixed' : 'performance');
  const unit = unitOf(settings.billing_unit);
  const price = Number(settings.billing_price) > 0 ? Number(settings.billing_price) : unit.defaultPrice;
  const minFee = Math.max(0, Number(settings.billing_min ?? 0));
  const cap = Number(settings.billing_cap) > 0 ? Number(settings.billing_cap) : 0;

  const curMention = Number(current.mentioned ?? 0);
  const baseMention = Number(baseline.mentioned ?? 0);
  const curCitations = Number(current.citations ?? 0);
  const baseCitations = Number(baseline.citations ?? 0);
  const curRate = Number(current.mentionRate ?? 0);
  const baseRate = Number(baseline.mentionRate ?? 0);
  const curRecommended = Number(current.recommended ?? 0);

  const quantities = {
    mention_gain: Math.max(0, curMention - baseMention),
    citation_gain: Math.max(0, curCitations - baseCitations),
    mention_rate_pt: Math.max(0, Math.round((curRate - baseRate) * 1000) / 10),
    recommended_count: curRecommended,
  };
  const quantity = quantities[unit.id] ?? 0;
  const subtotal = Math.round(quantity * price);

  let total = subtotal;
  if (mode === 'fixed') total = Math.round(Number(settings.billing_fixed_fee ?? 0));
  else {
    if (total < minFee) total = minFee;
    if (cap > 0 && total > cap) total = cap;
  }

  return {
    brand: brand.name ?? '',
    month,
    mode,
    modeName: BILLING_MODE[mode].name,
    unit: unit.id,
    unitName: unit.name,
    unitLabel: unit.unitLabel,
    price,
    quantity,
    subtotal,
    minFee,
    cap,
    total,
    current: { answers: current.answers ?? 0, mentioned: curMention, mentionRate: curRate, citations: curCitations, recommended: curRecommended },
    baseline: { answers: baseline.answers ?? 0, mentioned: baseMention, mentionRate: baseRate, citations: baseCitations },
    baselineLabel,
    capped: cap > 0 && subtotal > cap,
    floored: minFee > 0 && subtotal < minFee,
    evidence: [
      `本期 ${current.answers ?? 0} 条有效回答，提及 ${curMention} 条（提及率 ${pct(curRate)}），引用 ${curCitations} 条（${baselineLabel}：提及 ${baseMention} 条 / 提及率 ${pct(baseRate)} / 引用 ${baseCitations} 条）`,
      `计费口径：${unit.name} = max(0, 本期 − 基线) = ${quantity} ${unit.unitLabel} × ¥${price} = ¥${subtotal}`,
      `保底 ¥${minFee}${cap > 0 ? ` · 封顶 ¥${cap}` : ''} → 应收 ¥${total}`,
    ],
  };
}

/** 渲染成结算单（Markdown，可直接发给客户） */
export function renderSettlementMarkdown(settlement = {}) {
  const s = settlement;
  const lines = [];
  lines.push(`# ${s.brand || '客户'} · 托管结算单（${s.month}）`, '');
  lines.push(`- 计费方式：**${s.modeName}**`);
  lines.push(`- 计量口径：${s.unitName}`);
  lines.push(`- 基线：${s.baselineLabel}`, '');
  lines.push('| 项目 | 本期 | 基线 | 增量 |', '| --- | --- | --- | --- |');
  lines.push(`| 有效回答 | ${s.current.answers} | ${s.baseline.answers} | — |`);
  lines.push(`| AI 提及条数 | ${s.current.mentioned} | ${s.baseline.mentioned} | ${s.current.mentioned - s.baseline.mentioned} |`);
  lines.push(`| 提及率 | ${pct(s.current.mentionRate)} | ${pct(s.baseline.mentionRate)} | ${(Math.round((s.current.mentionRate - s.baseline.mentionRate) * 1000) / 10).toFixed(1)}pt |`);
  lines.push(`| 引用条数 | ${s.current.citations} | ${s.baseline.citations} | ${s.current.citations - s.baseline.citations} |`, '');
  lines.push('## 计费明细', '');
  lines.push(`- 计量：${s.quantity} ${s.unitLabel} × ¥${s.price} = ¥${s.subtotal}`);
  if (s.floored) lines.push(`- 保底：应收不低于 ¥${s.minFee}`);
  if (s.capped) lines.push(`- 封顶：应收不超过 ¥${s.cap}`);
  lines.push(`- **应收合计：¥${s.total}**`, '');
  lines.push('## 数据依据', '');
  for (const item of s.evidence ?? []) lines.push(`- ${item}`);
  lines.push('', `> 口径可复算：所有数字来自平台内的 AI 回答与判定记录，客户可在看板核对。`);
  return `${lines.join('\n')}\n`;
}
