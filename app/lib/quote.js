import { systemName } from './branding.js';
/**
 * lib/quote.js
 * GEO 报价与关键词价值评分（恒野内容工作室对客户报「做多少篇、多少钱」）。
 *
 * 设计参考：OmniRank 的 keyword_value_scorer / batch_pricing / pricing_bands /
 * transparent_pricing 的公式思路，参数已按恒野的真实成本重写（未复制任何第三方源码）。
 *
 * 为什么按「篇数」计价，而不是按 token / 字数？
 *  - 客户买的是「能被 AI 引用的内容资产」，不是模型算力。一篇稿子的成本大头是选题、撰写、
 *    发布与后续运营（见 UNIT_COST），这些和字数 / token 关系很弱，按篇数报价才对得上成本。
 *  - 客户听得懂「多少篇、多少钱」，听不懂也没法验收 token 数；按篇数还能直接对应交付清单。
 *  - 难词需要多铺几篇才可能被 AI 反复引用，所以价值评分最后必须落成「建议篇数」，而不是一个虚分。
 *
 * 为什么毛利要单独算？
 *  - 单篇售价 - 单篇成本才是这单生意赚不赚钱；只看总收入会把「卖得多、亏得也多」看成好单。
 *  - 毛利单独列出来，客户能看到钱花在哪（透明报价），我们也能判断这个档位 / 折扣能不能接。
 *  - 不含税的 subtotal 与含税的 total 分开，毛利按客户实际付的 total 算，避免把代收的税当利润。
 *
 * 约束：零依赖、纯函数、确定性输出（同一输入严格同值），不改动任何已有模块。
 */

/** 单篇成本构成（元 / 篇）。这是成本盘子，不是售价。 */
export const UNIT_COST = Object.freeze({
  writing: 20, // 写作：选题、资料核对、成稿
  publishing: 30, // 发布：平台账号维护、排版、发布与分发
  ops: 10, // 运营：数据回收、改稿、复盘
});

/**
 * 档位常量。
 * 档位决定「最少篇数」与「单篇价」；篇数不足时按档位最少篇数计，
 * 因为再少的量也要走一遍同样的交付流程（定位、排期、发布、复盘），成本不会同比例下降。
 */
export const PRICE_BANDS = Object.freeze({
  lite: Object.freeze({ label: '轻量', minArticles: 5, articlePrice: 120 }),
  standard: Object.freeze({ label: '标准', minArticles: 7, articlePrice: 180 }),
  deep: Object.freeze({ label: '深度', minArticles: 10, articlePrice: 260 }),
});

/** 未指定档位时的默认档位。 */
const DEFAULT_BAND = 'standard';

/** 难度非法 / 缺失时的兜底值。 */
const DEFAULT_DIFFICULTY = 5;

/** 文本难度 → 0-10 分值。 */
const DIFFICULTY_TEXT = Object.freeze({ low: 3, medium: 6, high: 9 });

/**
 * 意图权重：越靠近成交，权重越高。
 * 价值分上限不是 10 而是 13（price 1.3 × 满分 10），用来把高转化词和泛认知词拉开差距。
 */
const INTENT_WEIGHTS = Object.freeze({
  price: 1.3,
  compare: 1.2,
  howto: 1.1,
  city: 1.05,
  what: 1.0,
  risk: 0.9,
});

/** 意图 → 中文说明（写进 reasons，便于销售向客户解释）。 */
const INTENT_REASONS = Object.freeze({
  price: '价格类意图转化高：用户已在比价，内容离成交最近，权重 1.3',
  compare: '对比类意图决策靠前：用户正在选服务商，最容易被 AI 推荐，权重 1.2',
  howto: '流程类意图偏决策前段：适合建立专业感与信任，权重 1.1',
  city: '本地类意图地域精准：竞争范围小，同等篇数更容易被引用，权重 1.05',
  what: '认知类意图偏泛：覆盖面广但转化弱，按中性权重 1.0',
  risk: '风险类意图以防守为主：能建立信任但不直接带来询盘，权重 0.9',
});

/** 意图 → Markdown 展示名。 */
const INTENT_LABELS = Object.freeze({
  price: '价格',
  compare: '对比',
  howto: '流程',
  city: '本地',
  what: '认知',
  risk: '风险',
});

/** 四舍五入到指定小数位（先加 EPSILON，避免 1.005 这类二进制误差）。 */
function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

/**
 * 难度归一化。
 * 接受 0-10 的数字、low / medium / high 字符串（映射 3/6/9，兼容大小写），
 * 以及 CSV 里常见的数字字符串（如 '7'）；其余视为非法值，回退 5 并写 warning。
 * @param {number|string|undefined|null} input
 * @returns {{ difficulty: number, warnings: string[] }}
 */
function normalizeDifficulty(input) {
  const warnings = [];

  // 1) 数字：0-10 直接用，越界视为非法
  if (typeof input === 'number' && Number.isFinite(input)) {
    if (input >= 0 && input <= 10) return { difficulty: input, warnings };
    warnings.push(`难度值 ${input} 超出 0-10 区间，按默认 ${DEFAULT_DIFFICULTY} 计算`);
    return { difficulty: DEFAULT_DIFFICULTY, warnings };
  }

  // 2) 字符串：先查 low / medium / high，再兼容数字字符串
  if (typeof input === 'string') {
    const raw = input.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(DIFFICULTY_TEXT, raw)) {
      return { difficulty: DIFFICULTY_TEXT[raw], warnings };
    }
    if (raw === '') {
      warnings.push(`难度值为空，按默认 ${DEFAULT_DIFFICULTY} 计算`);
      return { difficulty: DEFAULT_DIFFICULTY, warnings };
    }
    if (Number.isFinite(Number(raw))) {
      const numeric = Number(raw);
      if (numeric >= 0 && numeric <= 10) return { difficulty: numeric, warnings };
      warnings.push(`难度值「${input}」超出 0-10 区间，按默认 ${DEFAULT_DIFFICULTY} 计算`);
      return { difficulty: DEFAULT_DIFFICULTY, warnings };
    }
    warnings.push(`难度值「${input}」非法（只接受 0-10 或 low/medium/high），按默认 ${DEFAULT_DIFFICULTY} 计算`);
    return { difficulty: DEFAULT_DIFFICULTY, warnings };
  }

  // 3) 缺失或其它类型
  if (input === undefined || input === null) {
    warnings.push(`未提供难度，按默认 ${DEFAULT_DIFFICULTY} 计算`);
  } else {
    warnings.push(`难度值「${String(input)}」非法（只接受 0-10 或 low/medium/high），按默认 ${DEFAULT_DIFFICULTY} 计算`);
  }
  return { difficulty: DEFAULT_DIFFICULTY, warnings };
}

/** 难度分 → 中文档位标签（低 / 中 / 高），与建议篇数的分界一致。 */
function difficultyLabel(difficulty) {
  if (difficulty <= 3) return '低';
  if (difficulty <= 6) return '中';
  return '高';
}

/**
 * 难度 → 建议篇数。
 * 难词要多铺：AI 回答同一词的候选来源多，单篇很难被稳定引用，需要篇数堆出「被看见」的概率。
 */
function recommendArticlesFor(difficulty) {
  if (difficulty <= 3) return 3;
  if (difficulty <= 6) return 5;
  return 8;
}

/** 意图归一化：大小写 / 空白容错；缺省按认知类 what。 */
function normalizeIntent(intent) {
  const raw = String(intent ?? '').trim().toLowerCase();
  return raw === '' ? 'what' : raw;
}

/**
 * 关键词价值评分（内部版：额外带回 warning，供 buildQuote 汇总到报价 warnings）。
 * @param {object} [options]
 * @param {string} [options.term]
 * @param {string} [options.intent]
 * @param {number|string} [options.difficulty]
 * @param {number} [options.competitorsCovered]
 * @returns {{ score: object, warnings: string[] }}
 */
function scoreKeywordDetailed(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const term = String(opts.term ?? '').trim();
  const rawIntent = String(opts.intent ?? '').trim();
  const intent = normalizeIntent(rawIntent);
  const intentWeight = Object.prototype.hasOwnProperty.call(INTENT_WEIGHTS, intent) ? INTENT_WEIGHTS[intent] : 1.0;

  const { difficulty, warnings } = normalizeDifficulty(opts.difficulty);
  const label = difficultyLabel(difficulty);
  const valueScore = round((intentWeight * (10 - difficulty)) / 10 * 10, 1);
  const recommendArticles = recommendArticlesFor(difficulty);

  const reasons = [];

  // 理由 1：意图权重
  if (rawIntent === '') {
    reasons.push('未提供意图，按认知类中性权重 1.0 计');
  } else if (Object.prototype.hasOwnProperty.call(INTENT_REASONS, intent)) {
    reasons.push(INTENT_REASONS[intent]);
  } else {
    reasons.push(`意图「${rawIntent}」未登记，按中性权重 1.0 计`);
  }

  // 理由 2：难度与建议篇数
  const difficultyNotes = {
    低: '属于容易上排名的词，少量篇数即可覆盖',
    中: '属于中等竞争词，按常规篇数铺开',
    高: '属于难词，AI 引用门槛高，难词要多铺',
  };
  reasons.push(`难度 ${difficulty}（${label}）：${difficultyNotes[label]}，建议做 ${recommendArticles} 篇`);

  // 理由 3：价值分公式，保证可复算
  reasons.push(`价值分 ${valueScore} = 意图权重 ${intentWeight} × (10 - 难度 ${difficulty}) / 10 × 10，越高越值得先做`);

  // 理由 4（可选）：竞品已覆盖情况。只影响解释，不改变公式，避免同一关键词因竞品家数反复跳价。
  const covered = Number(opts.competitorsCovered);
  if (Number.isFinite(covered) && covered > 0) {
    reasons.push(`竞品已覆盖 ${covered} 个相关词，属正面竞争，需要更多篇数才能拉开差异`);
  }

  // 非法难度的 warning 同时写进 reasons，保证 scoreKeyword 的调用方也能看到
  for (const warning of warnings) reasons.push(`警告：${warning}`);

  if (term === '') reasons.push('关键词为空，建议先补齐词条再做报价');

  return {
    score: {
      term,
      intent,
      difficulty,
      difficultyLabel: label,
      valueScore,
      recommendArticles,
      reasons,
    },
    warnings,
  };
}

/**
 * 关键词价值评分。
 * @param {object} [options]
 * @param {string} [options.term] 关键词
 * @param {string} [options.intent] price / compare / howto / city / what / risk，未知意图按 1.0
 * @param {number|string} [options.difficulty] 0-10 或 low / medium / high
 * @param {number} [options.competitorsCovered] 已覆盖该词的竞品数量（只影响解释）
 * @returns {{
 *   term: string,
 *   intent: string,
 *   difficulty: number,
 *   difficultyLabel: '低'|'中'|'高',
 *   valueScore: number,
 *   recommendArticles: number,
 *   reasons: string[]
 * }} 价值分 = 意图权重 × (10 - 难度) / 10 × 10，区间 0-13。
 */
export function scoreKeyword(options = {}) {
  return scoreKeywordDetailed(options).score;
}

/**
 * 生成一份报价。
 * 每个 item 先评分，再按档位单篇价计价：
 *   articles = max(recommendArticles, band.minArticles)
 *   subtotal = articles × band.articlePrice
 * 篇数不足档位最少篇数时按最少篇数计（见 PRICE_BANDS 注释）。
 *
 * @param {object} [options]
 * @param {Array<{term?:string, intent?:string, difficulty?:number|string, competitorsCovered?:number}|string>} [options.items] 关键词条目
 * @param {'lite'|'standard'|'deep'} [options.band] 档位，未知档位回退标准档并 warning
 * @param {number} [options.taxRate] 税率小数（如 0.06），默认 0
 * @returns {{
 *   band: string,
 *   bandLabel: string,
 *   lines: Array<{term:string,intent:string,difficulty:number,articles:number,unitPrice:number,subtotal:number}>,
 *   subtotal: number,
 *   tax: number,
 *   total: number,
 *   cost: {writing:number,publishing:number,ops:number,total:number},
 *   margin: number,
 *   warnings: string[]
 * }} 空 items 时返回零值结构并 warning「没有可报价的关键词」。
 */
export function buildQuote({ items = [], band = DEFAULT_BAND, taxRate = 0 } = {}) {
  const warnings = [];
  const itemList = Array.isArray(items) ? items : [];

  // 1) 档位：未知档位不静默算错价，回退标准档并明确告警
  const bandKey = String(band ?? DEFAULT_BAND).trim().toLowerCase();
  let bandConfig = Object.prototype.hasOwnProperty.call(PRICE_BANDS, bandKey) ? PRICE_BANDS[bandKey] : null;
  let resolvedBand = bandKey;
  if (!bandConfig) {
    bandConfig = PRICE_BANDS[DEFAULT_BAND];
    resolvedBand = DEFAULT_BAND;
    warnings.push(`未知档位「${String(band ?? '')}」，已回退到「${bandConfig.label}」档`);
  }

  // 2) 税率：非法值按 0 处理，避免把 NaN / 负数带进金额
  let rate = 0;
  const numericRate = Number(taxRate);
  if (Number.isFinite(numericRate) && numericRate >= 0) {
    rate = numericRate;
  } else {
    warnings.push(`税率「${String(taxRate)}」非法（需为 ≥0 的小数，如 0.06），已按 0 计算`);
  }

  // 3) 逐条评分 + 计价
  const lines = [];
  for (const item of itemList) {
    const rawItem = item && typeof item === 'object' ? item : { term: item };
    const { score, warnings: itemWarnings } = scoreKeywordDetailed(rawItem);
    for (const warning of itemWarnings) {
      warnings.push(`${score.term === '' ? '未命名关键词' : `「${score.term}」`}：${warning}`);
    }
    const articles = Math.max(score.recommendArticles, bandConfig.minArticles);
    const unitPrice = bandConfig.articlePrice;
    lines.push({
      term: score.term,
      intent: score.intent,
      difficulty: score.difficulty,
      articles,
      unitPrice,
      subtotal: articles * unitPrice,
    });
  }

  if (lines.length === 0) warnings.push('没有可报价的关键词');

  // 4) 金额：subtotal 不含税，tax / total 单列，避免把税算进毛利
  const subtotal = round(
    lines.reduce((sum, line) => sum + line.subtotal, 0),
    2,
  );
  const tax = round(subtotal * rate, 2);
  const total = round(subtotal + tax, 2);

  // 5) 成本与毛利：成本按总篇数摊，毛利按客户实际付的 total 算
  const totalArticles = lines.reduce((sum, line) => sum + line.articles, 0);
  const cost = {
    writing: round(totalArticles * UNIT_COST.writing, 2),
    publishing: round(totalArticles * UNIT_COST.publishing, 2),
    ops: round(totalArticles * UNIT_COST.ops, 2),
    total: 0,
  };
  cost.total = round(cost.writing + cost.publishing + cost.ops, 2);

  // total <= 0 时直接记 0，避免除零得到 Infinity / NaN
  const margin = total > 0 ? round((total - cost.total) / total, 3) : 0;

  return {
    band: resolvedBand,
    bandLabel: bandConfig.label,
    lines,
    subtotal,
    tax,
    total,
    cost,
    margin,
    warnings,
  };
}

/** 转义 Markdown 表格单元格，防止关键词里的 | 或换行破坏表格。 */
function escapeCell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/** 金额展示：整数不带小数点，小数保留 2 位。 */
function formatMoney(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  return String(round(numeric, 2));
}

/**
 * 把报价渲染成 Markdown（可直接贴进微信 / 飞书 / 邮件）。
 * 结构：标题 → 档位摘要 → 「## 报价明细」→ 「## 成本构成」→ 「## 毛利」→ 可选「## 提示」。
 * @param {ReturnType<typeof buildQuote>} quote
 * @returns {string} 空报价返回「暂无可报价项」。
 */
export function renderQuoteMarkdown(quote) {
  const data = quote && typeof quote === 'object' ? quote : {};
  const lines = Array.isArray(data.lines) ? data.lines : [];
  if (lines.length === 0) return '暂无可报价项';

  const cost = data.cost && typeof data.cost === 'object' ? data.cost : {};
  const totalArticles = lines.reduce((sum, line) => sum + (Number(line.articles) || 0), 0);
  const unitTotalCost = UNIT_COST.writing + UNIT_COST.publishing + UNIT_COST.ops;
  const subtotal = Number(data.subtotal) || 0;
  const tax = Number(data.tax) || 0;
  const total = Number(data.total) || 0;
  const costTotal = Number(cost.total) || 0;
  const margin = Number(data.margin) || 0;
  const marginPct = round(margin * 100, 1);
  const gross = round(total - costTotal, 2);

  const out = [];

  out.push(`# ${systemName()} 内容报价`);
  out.push('');
  out.push(`- 档位：${data.bandLabel || '标准'}`);
  out.push(`- 关键词：${lines.length} 个，合计 ${totalArticles} 篇`);
  out.push('');

  // 1) 明细表
  out.push('## 报价明细');
  out.push('');
  out.push('| 关键词 | 意图 | 难度 | 篇数 | 单价（元） | 小计（元） |');
  out.push('| --- | --- | --- | ---: | ---: | ---: |');
  for (const line of lines) {
    const intentLabel = INTENT_LABELS[line.intent] || escapeCell(line.intent) || '未标注';
    out.push(
      `| ${escapeCell(line.term)} | ${intentLabel} | ${line.difficulty} | ${line.articles} | ` +
        `${formatMoney(line.unitPrice)} | ${formatMoney(line.subtotal)} |`,
    );
  }
  out.push(`| **合计** |  |  | **${totalArticles}** |  | **${formatMoney(subtotal)}** |`);
  out.push('');
  out.push(
    tax > 0
      ? `- 含税总计：${formatMoney(total)} 元（其中税额 ${formatMoney(tax)} 元）`
      : `- 合计金额：${formatMoney(total)} 元（未含税）`,
  );
  out.push('');

  // 2) 成本构成：单篇成本 × 总篇数，客户能核对钱花在哪
  out.push('## 成本构成');
  out.push('');
  out.push(`- 写作：${totalArticles} 篇 × ${UNIT_COST.writing} 元 = ${formatMoney(cost.writing)} 元`);
  out.push(`- 发布：${totalArticles} 篇 × ${UNIT_COST.publishing} 元 = ${formatMoney(cost.publishing)} 元`);
  out.push(`- 运营：${totalArticles} 篇 × ${UNIT_COST.ops} 元 = ${formatMoney(cost.ops)} 元`);
  out.push(`- 合计：${formatMoney(costTotal)} 元（单篇成本 ${unitTotalCost} 元；成本盘子，不是售价）`);
  out.push('');

  // 3) 毛利：单独一行，避免把代收的税当利润
  out.push('## 毛利');
  out.push('');
  out.push(`- 毛利率：${marginPct}%（毛利 ${formatMoney(gross)} 元 / 收入 ${formatMoney(total)} 元）`);

  // 4) 提示（回退档位、非法难度等），有问题要说清楚，不藏在金额里
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  if (warnings.length > 0) {
    out.push('');
    out.push('## 提示');
    out.push('');
    for (const warning of warnings) out.push(`- ${warning}`);
  }

  return `${out.join('\n')}\n`;
}
