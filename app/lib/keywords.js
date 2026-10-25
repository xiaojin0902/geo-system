/**
 * 关键词挖掘（content-brief 负责）
 *
 * 输入：题目种子（questions.csv 的 99 条）或品牌配置；输出 8 类关键词簇。
 * 设计参考：GEO 关键词按「实体→本地→价格→对比→流程→风险→认知→竞品」分层，
 * 便于后续按簇排内容优先级（未复制任何第三方源码/提示词）。
 *
 * 约束：
 * - 零依赖、纯函数、确定性输出（同一输入严格同序同值）。
 * - difficulty 按 SPEC §3.6 四条启发式累加，基础 1，clamp 到 1-5。
 * - 不编造服务名：模板补充只使用品牌配置里已有的字段。
 */

/** 8 类关键词簇（顺序即报告/展示顺序） */
export const CLUSTERS = [
  '品牌实体',
  '本地推荐',
  '价格费用',
  '对比选择',
  '流程交付',
  '避坑风险',
  'GEO认知',
  '竞品替代',
];

const PRIORITIES = ['P0', 'P1', 'P2'];

const PRICE_RE = /(价格|多少钱|费用|收费|报价|贵不贵|便宜|预算|性价比|付款|分期)/;
const RISK_RE = /(避坑|坑|风险|骗|套路|踩雷|翻车|不靠谱|维权|退款|隐患|猫腻)/;
const PROCESS_RE = /(流程|多久|周期|交付|合作|签约|售后|修改|改稿|怎么开始|怎么做|步骤|需要准备|对接|排期|上线|验收)/;
const GEO_RE = /(geo|生成式|ai\s*搜索|ai搜索|被\s*ai|ai\s*推荐|大模型|ai\s*助手|deepseek|豆包|文心|kimi|通义|chatgpt|ai\s*可见性|收录|ai\s*回答)/i;
const COMPARE_RE = /(对比|区别|差异|怎么选|如何选|选哪个|选哪家|哪个好|哪家好|哪个更|哪家更|vs|和.{1,16}(?:比|对比|区别)|比较(?:一下|下|哪|区别|优劣|优缺点))/;
const BRAND_ATTR_RE = /(做什么|是家什么|是什么公司|什么公司|官网|团队|多少人|创始人|老板是谁|联系方式|怎么联系|介绍|是谁|在哪|地址|成立|全称)/;
const LOCAL_RE = /(本地|同城|附近|周边|上门|面谈)/;
const RECOMMEND_RE = /(推荐|哪家|排行|榜单|服务商|公司|工作室|靠谱)/;
const RECOMMEND_WORD_RE = /(推荐|排名|排行|榜单)/;
const PRICE_WORD_RE = /(价格|多少钱|费用|收费|报价)/;
const LOCAL_WORD_RE = /(本地|同城|附近|周边|上门|面谈)/;

/** 字符串去首尾空白并去掉常见标点，作为 term */
function cleanTerm(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’「『（(]+/, '')
    .replace(/["'“”‘’」』）)？?。.!！,，;；:：、]+$/, '')
    .trim();
}

/** 品牌/竞品名命中检测 */
function namesInText(text, names) {
  const raw = String(text ?? '');
  return (names || []).filter((n) => n && raw.includes(n));
}

/** 本地地名信号：品牌所在地 + 可选的本地候选区 + 通用本地词 */
function hasLocalPlace(text, brand = {}) {
  const raw = String(text ?? '');
  const places = [brand.city, ...(Array.isArray(brand.localAreas) ? brand.localAreas : [])].filter(Boolean);
  return places.some((p) => raw.includes(p)) || LOCAL_WORD_RE.test(raw);
}

/**
 * 判定题目/词条所属簇。
 * 优先看文本里的强信号，弱信号（推荐/哪家）最后结合地名判定；
 * 都拿不准时退回题目意图。
 */
export function classifyCluster(text, brand = {}, intent = '') {
  const raw = String(text ?? '');
  if (!raw.trim()) return intent ? clusterFromIntent(intent) : '品牌实体';

  const others = [...(brand.rejectedNames || []), ...(brand.competitors || [])].filter(Boolean);
  if (namesInText(raw, others).length > 0) return '竞品替代';
  if (/(替代|取代|换掉|换成)/.test(raw)) return '竞品替代';
  if (PRICE_RE.test(raw)) return '价格费用';
  if (RISK_RE.test(raw)) return '避坑风险';
  if (PROCESS_RE.test(raw)) return '流程交付';
  if (GEO_RE.test(raw)) return 'GEO认知';

  const aliases = [brand.name, brand.legalName, ...(brand.aliases || [])].filter(Boolean);
  const hasAlias = namesInText(raw, aliases).length > 0;
  const isLocal = hasLocalPlace(raw, brand);

  // 品牌自身的实体问题（是什么公司/团队/官网…）优先于本地推荐。
  if (hasAlias && BRAND_ATTR_RE.test(raw)) return '品牌实体';
  // 本地 + 推荐/哪家 → 本地推荐；先于泛化的「区别/选哪个」判断。
  if (isLocal && RECOMMEND_RE.test(raw)) return '本地推荐';
  if (COMPARE_RE.test(raw)) return '对比选择';
  if (hasAlias) return '品牌实体';
  if (BRAND_ATTR_RE.test(raw)) return '品牌实体';
  if (isLocal) return '本地推荐';
  if (intent) return clusterFromIntent(intent);
  return '品牌实体';
}

/** 意图 → 簇 的兜底映射（题目没有可分类信号时使用） */
function clusterFromIntent(intent) {
  switch (intent) {
    case '价格':
      return '价格费用';
    case '比较':
      return '对比选择';
    case '流程':
      return '流程交付';
    case '避坑':
      return '避坑风险';
    case '本地':
    case '推荐':
      return '本地推荐';
    case '认知':
      return 'GEO认知';
    case '替代':
      return '竞品替代';
    case '发现':
    default:
      return '品牌实体';
  }
}

/** 簇 → 关键词意图标签 */
function intentOfCluster(cluster) {
  switch (cluster) {
    case '品牌实体':
      return '发现';
    case '本地推荐':
      return '推荐';
    case '价格费用':
      return '价格';
    case '对比选择':
      return '比较';
    case '流程交付':
      return '流程';
    case '避坑风险':
      return '避坑';
    case 'GEO认知':
      return '认知';
    case '竞品替代':
      return '替代';
    default:
      return '发现';
  }
}

/**
 * SPEC §3.6 difficulty 启发式：基础 1，含本地地名 +1、含推荐/排名 +1、
 * 含价格/多少钱 +1、长句（>12 字）+1，clamp 1-5。
 */
export function difficultyOf(text, brand = {}) {
  const raw = String(text ?? '');
  let difficulty = 1;
  const reasons = [];
  if (hasLocalPlace(raw, brand)) {
    difficulty += 1;
    reasons.push('含本地地名');
  }
  if (RECOMMEND_WORD_RE.test(raw)) {
    difficulty += 1;
    reasons.push('含推荐/排名词');
  }
  if (PRICE_WORD_RE.test(raw)) {
    difficulty += 1;
    reasons.push('含价格词');
  }
  if (raw.replace(/\s+/g, '').length > 12) {
    difficulty += 1;
    reasons.push('长句（>12 字）');
  }
  return { difficulty: Math.max(1, Math.min(5, difficulty)), reasons };
}

/** 优先级：优先沿用题目种子给的 P0/P1/P2；没有则按簇推导 */
function priorityOf(question, cluster) {
  const given = question && typeof question === 'object' ? question.priority : null;
  if (given && PRIORITIES.includes(given)) return given;
  if (['品牌实体', '本地推荐', '价格费用', '竞品替代'].includes(cluster)) return 'P0';
  if (cluster === 'GEO认知') return 'P2';
  return 'P1';
}

/** 生成 note：来源 + 层级 + 难度依据，方便人工复核 */
function noteOf({ question, cluster, difficulty, reasons, generated }) {
  const bits = [];
  if (!generated) {
    bits.push(`来源：${(question && question.source) || '题目种子'}`);
    if (question && question.intent) bits.push(`意图：${question.intent}`);
    if (question && question.tier) bits.push(`层级：${question.tier}`);
  } else {
    bits.push('来源：品牌配置模板生成（题目种子未覆盖此簇）');
  }
  bits.push(`难度：${difficulty}/5（${reasons.length ? reasons.join('、') : '基础难度'}）`);
  return bits.join(' · ');
}

/** 题目种子归一化：兼容字符串 / {text,intent,tier,priority,source} / 数据库行 */
function normalizeQuestion(q) {
  if (typeof q === 'string') {
    return { text: q, intent: '', tier: '', priority: '', source: '题目种子' };
  }
  if (q && typeof q === 'object') {
    return {
      text: cleanTerm(q.text ?? q.question ?? q.term ?? ''),
      intent: q.intent || '',
      tier: q.tier || '',
      priority: q.priority || '',
      source: q.source || '题目种子',
      cluster: q.cluster || '',
    };
  }
  return { text: '', intent: '', tier: '', priority: '', source: '题目种子' };
}

/** 题目种子没覆盖的簇，用品牌配置里的既有字段补 1 条模板词，保证 8 簇齐全 */
export function templateKeywords(brand = {}) {
  const name = brand.name || '品牌';
  const city = brand.city || '';
  const place = city || '本地';
  const services = (brand.services || []).filter(Boolean);
  const serviceA = services[0] || brand.industry || '内容服务';
  const serviceB = services[1] || '同类服务';
  const competitor = (brand.competitors || []).filter(Boolean)[0];

  const base = [
    { text: `${name}是做什么的`, intent: '发现', tier: 'brand_awareness', priority: 'P0', cluster: '品牌实体' },
    { text: `${place}${serviceA}推荐哪家好`, intent: '推荐', tier: 'regional_industry', priority: 'P0', cluster: '本地推荐' },
    { text: `${serviceA}多少钱`, intent: '价格', tier: 'super_tier1', priority: 'P0', cluster: '价格费用' },
    { text: `${serviceA}和${serviceB}怎么选`, intent: '比较', tier: 'super_tier1', priority: 'P1', cluster: '对比选择' },
    { text: `${serviceA}的合作流程与交付周期`, intent: '流程', tier: 'super_tier1', priority: 'P1', cluster: '流程交付' },
    { text: `${serviceA}有哪些坑要避开`, intent: '避坑', tier: 'super_tier1', priority: 'P1', cluster: '避坑风险' },
    { text: 'GEO 优化是什么，怎么让 AI 搜索提到我的品牌', intent: '认知', tier: 'super_tier1', priority: 'P2', cluster: 'GEO认知' },
    {
      text: competitor ? `${competitor}的替代方案有哪些` : `${serviceA}服务商怎么换`,
      intent: '替代',
      tier: 'super_tier1',
      priority: 'P1',
      cluster: '竞品替代',
    },
  ];
  return base.map((item) => ({ ...item, source: '模板生成', generated: true }));
}

function clusterIndex(cluster) {
  const idx = CLUSTERS.indexOf(cluster);
  return idx === -1 ? CLUSTERS.length : idx;
}

function priorityIndex(priority) {
  const idx = PRIORITIES.indexOf(priority);
  return idx === -1 ? PRIORITIES.length : idx;
}

/**
 * 展开关键词。
 * @param {{brand?: object, questions?: Array}} params
 * @returns {Array<{term:string, cluster:string, intent:string, difficulty:number, priority:string, note:string}>}
 */
export function expandKeywords({ brand = {}, questions = [] } = {}) {
  const sourceQuestions = Array.isArray(questions) ? questions : [];
  const entries = [];
  const seen = new Set();

  const pushEntry = (question, forcedCluster) => {
    const text = cleanTerm(question.text);
    if (!text) return;
    const term = text;
    if (seen.has(term)) return;
    const cluster = forcedCluster || question.cluster || classifyCluster(text, brand, question.intent) || clusterFromIntent(question.intent);
    const intent = question.intent || intentOfCluster(cluster);
    const { difficulty, reasons } = difficultyOf(text, brand);
    const priority = priorityOf(question, cluster);
    seen.add(term);
    entries.push({
      term,
      cluster,
      intent,
      difficulty,
      priority,
      note: noteOf({ question, cluster, difficulty, reasons, generated: Boolean(question.generated) }),
    });
  };

  for (const item of sourceQuestions) {
    const question = normalizeQuestion(item);
    pushEntry(question);
  }

  // 完全没有题目、品牌也没有可用字段时，没有可挖掘的输入。
  const hasBrandInfo = Boolean(
    brand.name || brand.city || brand.industry || (Array.isArray(brand.services) && brand.services.length),
  );
  if (entries.length === 0 && !hasBrandInfo) return [];

  // 题目种子可能只覆盖部分簇：用品牌既有字段补齐，保证 8 类都有落点。
  const covered = new Set(entries.map((entry) => entry.cluster));
  for (const template of templateKeywords(brand)) {
    if (covered.has(template.cluster)) continue;
    pushEntry(template, template.cluster);
    covered.add(template.cluster);
  }

  entries.sort((a, b) => {
    const clusterDiff = clusterIndex(a.cluster) - clusterIndex(b.cluster);
    if (clusterDiff !== 0) return clusterDiff;
    const priorityDiff = priorityIndex(a.priority) - priorityIndex(b.priority);
    if (priorityDiff !== 0) return priorityDiff;
    const difficultyDiff = b.difficulty - a.difficulty;
    if (difficultyDiff !== 0) return difficultyDiff;
    if (a.term === b.term) return 0;
    return a.term < b.term ? -1 : 1;
  });

  return entries;
}
