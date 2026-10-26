/**
 * lib/i18n.js
 * 多语种 / 出海：让 GEO 系统能给英文（以及少量其他语种）客户跑诊断、出报告。
 *
 * 设计取舍（都是踩过的坑）：
 *   1) 纯函数、零依赖、不碰网络与数据库：翻译层一旦有副作用，报告渲染就没法单测；
 *   2) 词条以「扁平 key」组织，不做嵌套对象查找——报告模板里写 `t('mentionRate', loc)` 最短；
 *   3) 缺词条必须能被发现：
 *      - 目标语言缺失 → 回落 zh-CN（保住交付，不至于报告里出现空白）；
 *      - zh-CN 也缺失 → 返回 `locale:key`（渲染出来一眼看到是漏词条，而不是静默空串）；
 *   4) 数字/百分比不走 Intl：ICU 版本一升级，es-ES 的分隔符或空格就可能变（NBSP / 窄空格），
 *      报告快照测试会莫名炸。这里手工格式化，输出稳定可断言。
 */

/** 支持的标准 locale（顺序即展示优先级；zh-CN 是兜底语言） */
export const LOCALES = Object.freeze(['zh-CN', 'en-US', 'ja-JP', 'es-ES']);

/** 兜底语言：任何缺失都回落到它 */
const DEFAULT_LOCALE = 'zh-CN';

/** 判定十态（与 lib/judge.js 的 VERDICTS 保持一致，顺序即报告展示顺序） */
const VERDICT_STATES = Object.freeze([
  'recommended',
  'conditionally_recommended',
  'candidate',
  'listed',
  'mentioned',
  'not_mentioned',
  'ambiguous',
  'unknown',
  'refused',
  'engine_error',
]);

/**
 * 词条表：zh-CN 为准，其余语言按同一份 key 铺开。
 * 注意 `citations` 同时被「指标」与「报告章节」引用，所以取两边都读得通的「引用」，
 * 指标侧的精确说法另给 `citationCount` / `citationSources`。
 * `baiduIndex` 只有中文：海外客户不用百度指数，这条正好用来验证「回落 zh-CN」。
 */
const MESSAGES = Object.freeze({
  'zh-CN': Object.freeze({
    // 指标
    score: '总分',
    mentionRate: '提及率',
    citations: '引用',
    citationCount: '引用数',
    citationSources: '引用来源',
    ownShare: '自有占比',
    shareOfVoice: '声量份额',
    sentiment: '情感倾向',
    sample: '样本',
    sampleCount: '样本 {count} 条',
    coverage: '采集覆盖率',
    rank: '排名',
    trend: '趋势',
    baiduIndex: '百度指数',
    // 判定十态
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
    // 报告章节
    summary: '摘要',
    highlights: '亮点',
    risks: '风险',
    actions: '行动建议',
    nextWeek: '下周计划',
    engines: '引擎覆盖',
    dataQuality: '数据质量',
    verdictDistribution: '判定分布',
    evidence: '证据',
    reportTitle: 'GEO 诊断报告',
    reportSubtitle: '品牌：{brand} · 周期：{period}',
    // 页面 / CLI
    diagnose: '诊断',
    insights: '洞察',
    weekly: '周报',
    cockpit: '驾驶舱',
    report: '报告',
    plan: '方案',
    // 通用
    yes: '是',
    no: '否',
    none: '无',
    noData: '暂无数据',
    total: '合计',
    average: '平均',
    period: '报告周期',
    language: '语言',
    up: '上升',
    down: '下降',
    flat: '持平',
    generatedAt: '生成时间',
    brand: '品牌',
  }),
  'en-US': Object.freeze({
    // 指标
    score: 'Score',
    mentionRate: 'Mention rate',
    citations: 'Citations',
    citationCount: 'Citation count',
    citationSources: 'Citation sources',
    ownShare: 'Owned share',
    shareOfVoice: 'Share of voice',
    sentiment: 'Sentiment',
    sample: 'Sample',
    sampleCount: '{count} samples',
    coverage: 'Collection coverage',
    rank: 'Rank',
    trend: 'Trend',
    // 判定十态
    recommended: 'Recommended',
    conditionally_recommended: 'Conditionally recommended',
    candidate: 'Candidate',
    listed: 'Listed',
    mentioned: 'Mentioned only',
    not_mentioned: 'Not mentioned',
    ambiguous: 'Ambiguous',
    unknown: 'Unknown',
    refused: 'Refused',
    engine_error: 'Engine error',
    // 报告章节
    summary: 'Summary',
    highlights: 'Highlights',
    risks: 'Risks',
    actions: 'Actions',
    nextWeek: 'Next week',
    engines: 'Engines',
    dataQuality: 'Data quality',
    verdictDistribution: 'Verdict distribution',
    evidence: 'Evidence',
    reportTitle: 'GEO Diagnostic Report',
    reportSubtitle: 'Brand: {brand} · Period: {period}',
    // 页面 / CLI
    diagnose: 'Diagnose',
    insights: 'Insights',
    weekly: 'Weekly report',
    cockpit: 'Cockpit',
    report: 'Report',
    plan: 'Plan',
    // 通用
    yes: 'Yes',
    no: 'No',
    none: 'None',
    noData: 'No data',
    total: 'Total',
    average: 'Average',
    period: 'Period',
    language: 'Language',
    up: 'Up',
    down: 'Down',
    flat: 'Flat',
    generatedAt: 'Generated at',
    brand: 'Brand',
  }),
  'ja-JP': Object.freeze({
    // 指标
    score: 'スコア',
    mentionRate: '言及率',
    citations: '引用',
    citationCount: '引用数',
    citationSources: '引用元',
    ownShare: '自社シェア',
    shareOfVoice: 'シェア・オブ・ボイス',
    sentiment: 'センチメント',
    sample: 'サンプル',
    sampleCount: 'サンプル {count} 件',
    coverage: '収集カバー率',
    rank: '順位',
    trend: 'トレンド',
    // 判定十态
    recommended: '推奨',
    conditionally_recommended: '条件付き推奨',
    candidate: '候補',
    listed: '掲載',
    mentioned: '言及のみ',
    not_mentioned: '言及なし',
    ambiguous: '曖昧',
    unknown: '不明',
    refused: '回答拒否',
    engine_error: 'エンジンエラー',
    // 报告章节
    summary: 'サマリー',
    highlights: 'ハイライト',
    risks: 'リスク',
    actions: 'アクション',
    nextWeek: '来週の計画',
    engines: 'エンジン',
    dataQuality: 'データ品質',
    verdictDistribution: '判定分布',
    evidence: '根拠',
    reportTitle: 'GEO 診断レポート',
    reportSubtitle: 'ブランド：{brand} · 対象期間：{period}',
    // 页面 / CLI
    diagnose: '診断',
    insights: 'インサイト',
    weekly: '週次レポート',
    cockpit: 'コックピット',
    report: 'レポート',
    plan: 'プラン',
    // 通用
    yes: 'はい',
    no: 'いいえ',
    none: 'なし',
    noData: 'データなし',
    total: '合計',
    average: '平均',
    period: '対象期間',
    language: '言語',
    up: '上昇',
    down: '下降',
    flat: '横ばい',
    generatedAt: '生成日時',
    brand: 'ブランド',
  }),
  'es-ES': Object.freeze({
    // 指标
    score: 'Puntuación',
    mentionRate: 'Tasa de mención',
    citations: 'Citas',
    citationCount: 'Número de citas',
    citationSources: 'Fuentes citadas',
    ownShare: 'Cuota propia',
    shareOfVoice: 'Cuota de voz',
    sentiment: 'Sentimiento',
    sample: 'Muestra',
    sampleCount: '{count} muestras',
    coverage: 'Cobertura de recolección',
    rank: 'Posición',
    trend: 'Tendencia',
    // 判定十态
    recommended: 'Recomendado',
    conditionally_recommended: 'Recomendado con condiciones',
    candidate: 'Candidato',
    listed: 'Listado',
    mentioned: 'Solo mención',
    not_mentioned: 'Sin mención',
    ambiguous: 'Ambiguo',
    unknown: 'Desconocido',
    refused: 'Respuesta rechazada',
    engine_error: 'Error del motor',
    // 报告章节
    summary: 'Resumen',
    highlights: 'Puntos destacados',
    risks: 'Riesgos',
    actions: 'Acciones',
    nextWeek: 'Próxima semana',
    engines: 'Motores',
    dataQuality: 'Calidad de datos',
    verdictDistribution: 'Distribución de veredictos',
    evidence: 'Evidencia',
    reportTitle: 'Informe de diagnóstico GEO',
    reportSubtitle: 'Marca: {brand} · Periodo: {period}',
    // 页面 / CLI
    diagnose: 'Diagnóstico',
    insights: 'Hallazgos',
    weekly: 'Informe semanal',
    cockpit: 'Panel de control',
    report: 'Informe',
    plan: 'Plan',
    // 通用
    yes: 'Sí',
    no: 'No',
    none: 'Ninguno',
    noData: 'Sin datos',
    total: 'Total',
    average: 'Promedio',
    period: 'Periodo',
    language: 'Idioma',
    up: 'Sube',
    down: 'Baja',
    flat: 'Estable',
    generatedAt: 'Generado el',
    brand: 'Marca',
  }),
});

/** 语言码 → 标准 locale（'zh' / 'zh-cn' / 'ZH_CN' 都收敛到这里） */
const CANONICAL_BY_LOWER = Object.freeze(
  Object.fromEntries(LOCALES.map((locale) => [locale.toLowerCase(), locale])),
);

/** 只给语言码（'en' / 'es-419' / 'ja-JP-u-ca-japanese'）时，按主语言落到默认地区 */
const CANONICAL_BY_LANGUAGE = Object.freeze(
  Object.fromEntries(LOCALES.map((locale) => [locale.split('-')[0], locale])),
);

/** 数字符号：西语区小数点用逗号、千分位用点，是出海最容易翻车的一处 */
const NUMBER_SYMBOLS = Object.freeze({
  'zh-CN': Object.freeze({ group: ',', decimal: '.' }),
  'en-US': Object.freeze({ group: ',', decimal: '.' }),
  'ja-JP': Object.freeze({ group: ',', decimal: '.' }),
  'es-ES': Object.freeze({ group: '.', decimal: ',' }),
});

/** 百分比前是否留空格（西语习惯「25,0 %」） */
const PERCENT_SPACED = Object.freeze({ 'es-ES': true });

/**
 * 报告标题的周期括号：中日用全角括号且紧贴标题，英西用半角括号且前面留空格
 * （「GEO Diagnostic Report (2026-10)」是英文排版惯例）。
 */
const PERIOD_PARENS = Object.freeze({
  'zh-CN': Object.freeze({ open: '（', close: '）', spaceBefore: false }),
  'en-US': Object.freeze({ open: '(', close: ')', spaceBefore: true }),
  'ja-JP': Object.freeze({ open: '（', close: '）', spaceBefore: false }),
  'es-ES': Object.freeze({ open: '(', close: ')', spaceBefore: true }),
});

/**
 * 品牌名出海对照：中文名在英文报告里用官方英文名，不然客户看到「恒野」会以为发错版本。
 * 没登记的品牌原样输出——宁可保留原名，也不自作主张音译。
 */
const BRAND_ALIASES = Object.freeze({
  恒野: Object.freeze({ 'en-US': 'Henye' }),
});

/** formatNumber 默认最多保留的小数位（再长对报告没意义，还容易暴露浮点尾巴） */
const NUMBER_MAX_DIGITS = 3;

/** 非法数字的统一占位符（与 lib/report.js 等模块的 '—' 约定一致） */
const NUMBER_PLACEHOLDER = '—';

/** 把入参收敛成有限数字；空串 / 布尔 / NaN / Infinity 都视为无效 */
function toFiniteNumber(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/** 整数部分加千分位：1234567 → 1,234,567 */
function groupInteger(digits, separator) {
  return String(digits).replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/** 取绝对值后定点截断，拆成整数 / 小数两段（负号不参与分组） */
function splitFixed(num, digits) {
  const text = Math.abs(num).toFixed(digits);
  const [intPart = '0', fracPart = ''] = text.split('.');
  return { intPart, fracPart };
}

/**
 * 把 locale 入参归一化成标准 locale。
 * 支持 'zh' / 'zh-cn' / 'ZH-CN' / 'zh_CN' / 'en' / 'en-us' 这类写法；
 * 未知语言、空值、非字符串一律回落 zh-CN（宁可给中文，也不给半截报告）。
 * @param {string} input 语言标识
 * @returns {string} LOCALES 中的某一项
 */
export function resolveLocale(input) {
  const raw = String(input ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (!raw) return DEFAULT_LOCALE;
  if (Object.hasOwn(CANONICAL_BY_LOWER, raw)) return CANONICAL_BY_LOWER[raw];
  const language = raw.split('-')[0];
  if (Object.hasOwn(CANONICAL_BY_LANGUAGE, language)) return CANONICAL_BY_LANGUAGE[language];
  return DEFAULT_LOCALE;
}

/** 用 `{name}` 占位符替换变量；变量缺失时保留占位符原样，方便一眼看出漏传 */
function interpolate(template, vars) {
  if (vars === null || typeof vars !== 'object') return String(template);
  return String(template).replace(/\{(\w+)\}/g, (whole, name) => {
    const value = vars[name];
    return Object.hasOwn(vars, name) && value !== null && value !== undefined ? String(value) : whole;
  });
}

/**
 * 取词条。
 * 查找顺序：目标 locale → zh-CN → 返回 `${locale}:${key}`（可发现，不返回空串）。
 * 非法 locale 先被 resolveLocale 收敛到 zh-CN，所以 `t(key, 'fr')` 得到中文而不是乱码。
 * @param {string} key 词条 key（如 'mentionRate'）
 * @param {string} locale 语言标识
 * @param {Record<string, string|number>} [vars] 占位符变量，如 { brand: '恒野' }
 * @returns {string} 翻译结果
 */
export function t(key, locale, vars = {}) {
  const resolved = resolveLocale(locale);
  const name = String(key ?? '');
  const target = MESSAGES[resolved];
  const fallback = MESSAGES[DEFAULT_LOCALE];
  const raw = Object.hasOwn(target, name) ? target[name] : Object.hasOwn(fallback, name) ? fallback[name] : null;
  if (raw === null || raw === undefined) return `${resolved}:${name}`;
  return interpolate(raw, vars);
}

/**
 * 数字格式化：千分位 + 本地小数点，最多 3 位小数并裁掉末尾 0。
 *   zh-CN / en-US / ja-JP：1,234.5
 *   es-ES：1.234,5
 * 非法数字返回 '—'（与报告其它模块一致，不伪造 0）。
 * @param {number|string} value 数值
 * @param {string} locale 语言标识
 * @returns {string} 格式化文本
 */
export function formatNumber(value, locale) {
  const num = toFiniteNumber(value);
  const { group, decimal } = NUMBER_SYMBOLS[resolveLocale(locale)] ?? NUMBER_SYMBOLS[DEFAULT_LOCALE];
  if (num === null) return NUMBER_PLACEHOLDER;
  // 超过 1e21 之后 toFixed 会退化成指数形式，分组就失去意义了，原样返回
  if (Math.abs(num) >= 1e21) return String(num);
  const { intPart, fracPart: fixedFrac } = splitFixed(num, NUMBER_MAX_DIGITS);
  const fracPart = fixedFrac.replace(/0+$/, ''); // 1,234.500 → 1,234.5；1,234.000 → 1,234
  const body = fracPart
    ? `${groupInteger(intPart, group)}${decimal}${fracPart}`
    : groupInteger(intPart, group);
  const negative = num < 0 && (Number(intPart) !== 0 || Number(fracPart || 0) !== 0);
  return negative ? `-${body}` : body;
}

/**
 * 百分比格式化（入参是 0~1 的比率，不是已乘 100 的数）。
 *   zh-CN / en-US / ja-JP：25.0%
 *   es-ES：25,0 %
 * @param {number|string} ratio 比率，如 0.25
 * @param {string} locale 语言标识
 * @param {number} [digits=1] 小数位（0~6）
 * @returns {string} 格式化文本
 */
export function formatPercent(ratio, locale, digits = 1) {
  const num = toFiniteNumber(ratio);
  const resolved = resolveLocale(locale);
  const { group, decimal } = NUMBER_SYMBOLS[resolved] ?? NUMBER_SYMBOLS[DEFAULT_LOCALE];
  if (num === null) return NUMBER_PLACEHOLDER;
  const places = Math.min(6, Math.max(0, Math.trunc(Number(digits)) || 0));
  const percent = num * 100;
  if (!Number.isFinite(percent)) return NUMBER_PLACEHOLDER;
  if (Math.abs(percent) >= 1e21) return `${percent}%`;
  const { intPart, fracPart } = splitFixed(percent, places);
  const body = places > 0 ? `${groupInteger(intPart, group)}${decimal}${fracPart}` : groupInteger(intPart, group);
  const negative = percent < 0 && (Number(intPart) !== 0 || Number(fracPart || 0) !== 0);
  const space = PERCENT_SPACED[resolved] ? ' ' : '';
  return `${negative ? '-' : ''}${body}${space}%`;
}

/** 各语种的问题生成提示词：五类意图（价格/对比/推荐/流程/风险）+ 禁止出现品牌名 */
const QUESTION_PROMPT_TEMPLATES = Object.freeze({
  'zh-CN': `你是一名 GEO（生成式引擎优化）调研员。请生成 10 个真实用户会直接抛给 AI 助手（如 ChatGPT / 豆包 / 元宝）的中文问题，用于品牌 AI 可见性诊断。

硬性要求：
1. 不要出现任何品牌名、公司名、店铺名、产品型号或带明显指代的简称，只描述需求场景。
2. 必须覆盖五类意图，缺一不可：
   - 价格：多少钱、费用怎么算、预算区间；
   - 对比：A 和 B 哪个好、区别在哪、怎么选；
   - 推荐：求推荐、榜单排名、口碑怎么样；
   - 流程：怎么做、步骤、周期、需要准备什么；
   - 风险：有什么坑、靠不靠谱、失败案例怎么规避。
3. 用用户口语提问，像真的在搜索框里输入，不要广告语气，不要模板腔。
4. 每行一个问题，共 10 行，除编号外不要解释或寒暄。`,
  'en-US': `You are a GEO (generative engine optimization) researcher. Write 10 questions that real English-speaking users would type straight into an AI assistant (ChatGPT / Gemini / Perplexity) so we can diagnose a brand's AI visibility.

Hard requirements:
1. Never mention any brand name, company name, store name or product model — no abbreviations that hint at them either. Describe the need only.
2. Cover all five intents, none may be missing:
   - price: how much it costs, pricing model, budget range;
   - comparison: which is better, X vs Y, how to choose;
   - recommendation: best options, rankings, reviews and reputation;
   - process: how to get started, steps, timeline, what to prepare;
   - risk: common pitfalls, is it trustworthy, how to avoid failure.
3. Sound like a real user typing a search query; no marketing tone, no template phrasing.
4. One question per line, 10 lines total, no extra commentary.`,
  'ja-JP': `あなたは GEO（生成 AI 最適化）のリサーチャーです。ブランドの AI 可視性を診断するため、実際のユーザーが AI アシスタント（ChatGPT / Gemini / Perplexity）にそのまま入力する日本語の質問を 10 個作成してください。

必須条件：
1. ブランド名・会社名・店舗名・製品型番を一切出さないこと（略称での示唆も不可）。需要の状況だけを描写する。
2. 次の五つの意図をすべてカバーすること（欠落不可）：
   - 価格：費用はいくらか、料金体系、予算の目安；
   - 比較：どちらが良いか、違い、選び方；
   - おすすめ：おすすめは？ランキング、評判；
   - 手順：始め方、ステップ、期間、事前準備；
   - リスク：失敗しやすい点、信頼できるか、回避策。
3. 実際の検索入力のように口語で書く。広告的な表現やテンプレ的な言い回しは使わない。
4. 1 行に 1 問、合計 10 行。番号以外の説明や挨拶は不要。`,
  'es-ES': `Eres un investigador de GEO (optimización para motores generativos). Escribe 10 preguntas que usuarios hispanohablantes reales escribirían directamente en un asistente de IA (ChatGPT / Gemini / Perplexity) para diagnosticar la visibilidad de una marca en IA.

Requisitos obligatorios:
1. No incluyas ningún nombre de marca, empresa, tienda o modelo de producto, ni siglas que los revelen. Describe solo la necesidad.
2. Cubre las cinco intenciones, sin excepción:
   - precio: cuánto cuesta, cómo se calcula, rango de presupuesto;
   - comparación: cuál es mejor, diferencias, cómo elegir;
   - recomendación: opciones recomendadas, rankings, opiniones;
   - proceso: cómo empezar, pasos, plazos, qué preparar;
   - riesgo: errores habituales, si es de fiar, cómo evitarlos.
3. Escribe como un usuario real en el buscador; sin tono publicitario ni plantillas.
4. Una pregunta por línea, 10 líneas en total, sin explicaciones adicionales.`,
});

/**
 * 生成「用户会问 AI 的问题」用的语言提示词模板。
 * 模板本身已含五类意图与「不出现品牌名」的约束，未知 locale 回落中文。
 * @param {string} locale 语言标识
 * @returns {string} 提示词模板
 */
export function questionPromptTemplate(locale) {
  return QUESTION_PROMPT_TEMPLATES[resolveLocale(locale)] ?? QUESTION_PROMPT_TEMPLATES[DEFAULT_LOCALE];
}

/**
 * 判定十态翻译（中文/英文/日文/西语）。
 * 未知判定原样返回——引擎新增状态时，报告里显示的仍是那个状态码，不会变成空白。
 * @param {string} verdict 判定状态
 * @param {string} locale 语言标识
 * @returns {string} 本地化后的判定名
 */
export function translateVerdict(verdict, locale) {
  const resolved = resolveLocale(locale);
  const key = String(verdict ?? '').trim();
  if (!key) return '';
  const target = MESSAGES[resolved];
  const fallback = MESSAGES[DEFAULT_LOCALE];
  if (Object.hasOwn(target, key) && VERDICT_STATES.includes(key)) return target[key];
  if (Object.hasOwn(fallback, key) && VERDICT_STATES.includes(key)) return fallback[key];
  return String(verdict);
}

/** 取品牌在该语言下的展示名：登记过就用官方译名，否则原样输出 */
function localizeBrand(brand, locale) {
  const name = String(brand ?? '').trim();
  if (!name) return '';
  const aliases = BRAND_ALIASES[name];
  return (aliases && aliases[locale]) || name;
}

/**
 * 生成报告标题：「品牌 · 报告标题（周期）」。
 *   zh-CN：恒野 · GEO 诊断报告（2026-10）
 *   en-US：Henye · GEO Diagnostic Report (2026-10)
 *   ja-JP：恒野 · GEO 診断レポート（2026-10）
 * 品牌或周期为空时不留下孤零零的分隔符 / 空括号。
 * @param {{ brand?: string, locale?: string, period?: string }} [options] 标题参数
 * @returns {string} 报告标题
 */
export function localeReportTitle({ brand = '', locale = 'zh-CN', period = '' } = {}) {
  const resolved = resolveLocale(locale);
  const displayBrand = localizeBrand(brand, resolved);
  const periodText = String(period ?? '').trim();
  const parens = PERIOD_PARENS[resolved] ?? PERIOD_PARENS[DEFAULT_LOCALE];
  const title = t('reportTitle', resolved);
  const titleWithPeriod = periodText
    ? `${title}${parens.spaceBefore ? ' ' : ''}${parens.open}${periodText}${parens.close}`
    : title;
  return displayBrand ? `${displayBrand} · ${titleWithPeriod}` : titleWithPeriod;
}
