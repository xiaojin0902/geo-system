/**
 * lib/video-script.js
 * 短视频口播脚本：把一篇 GEO 文章 / 内容 brief 转成「3 秒钩子 + 口播稿 + 分镜卡」。
 *
 * 对标摘星 AI 的「AI 短视频矩阵」，但刻意砍掉渲染层：
 * - 不做视频渲染、不做数字人、不接任何模型，只产出能直接开拍的脚本；
 * - 输入是已有文章正文或 brief，输出是钩子、按秒切分的口播、逐段分镜与标题备选；
 * - 纯规则、零依赖、确定性：同一份输入两次调用结果完全一致（不读时间、不读随机数）。
 *
 * 为什么用规则而不是生成模型：GEO 客户要的是「稳定可复现 + 可过审」。规则版每条片子
 * 都能解释「这句话为什么在这」，出问题也能定位到具体规则；模型版做不到这两点，还会把
 * 正文里的绝对化用语悄悄带进口播。所以这里的取舍是：脚本质量靠排序，合规靠硬规则。
 *
 * 合规口径（与 lib/writer.js、lib/article-review.js 保持一致）：
 * - 绝对化用语（最/第一/唯一/顶级/保证/100%/稳赚/绝对/永久）→ issues；
 * - 效果承诺（保证涨粉、一定有效）→ issues；
 * - 正文出现「数字+%」但全文没有链接 / 来源标注 → issues。
 *
 * 一处刻意的例外：口播科普的钩子模板「90%的人不知道…」里的 90% 是口播修辞，不是事实主张，
 * 不参与百分比溯源（narration 首段被跳过）。正文自己的百分比仍然逐条查，该报照样报。
 */

/** 五种脚本风格。顺序即 UI 展示顺序，不要随意调整。 */
export const SCRIPT_STYLES = Object.freeze([
  '口播科普',
  '避坑清单',
  '对比测评',
  '案例复盘',
  '快问快答',
]);

/** 兜底风格：传了不认识的风格时按它处理，保证调用方永远拿得到脚本。 */
const DEFAULT_STYLE = '口播科普';

const DEFAULT_DURATION = 60;
const MIN_DURATION = 10;
const MAX_DURATION = 300;

/** 每 10 秒一个口播段，60 秒正好 6 段；上下再夹紧到 3–12 段。 */
const SECONDS_PER_SEGMENT = 10;
const MIN_SEGMENTS = 3;
const MAX_SEGMENTS = 12;

/** 钩子固定占前 3 秒（极短视频会等比压缩）。 */
const HOOK_SECONDS = 3;

/** 口播段字数窗口：低于 25 字听着空，高于 60 字一口气读不完。 */
const MIN_BLOCK = 25;
const MAX_BLOCK = 60;

/** 低于 14 字的碎片（标题残渣、列表词）直接丢掉，不进口播候选。 */
const MIN_BLOCK_CHARS = 14;

const MAX_HOOK = 20;
const MAX_TITLE_OPTION = 18;
const MAX_COVER = 12;
const MAX_CAPTION = 18;
const MIN_TITLE_OPTIONS = 3;
const MAX_TITLE_OPTIONS = 5;
const MIN_TAGS = 5;
const MAX_TAGS = 8;
const MAX_KEYWORD = 10;

/** 问题类型的中文标签，渲染 Markdown 时直接复用。 */
const ISSUE_TYPES = Object.freeze({
  absolute: '绝对化用语',
  promise: '效果承诺',
  unsourced_number: '无来源数字',
});

/** 每类问题的修改建议。 */
const ISSUE_ADVICE = Object.freeze({
  absolute: '广告法第九条禁止绝对化表述，也没法被 AI 当作事实引用，改成「条件 + 范围」的说法。',
  promise: '承诺涨粉 / 一定有效属于效果承诺，平台会限流；改成「因账号而异，只承诺交付」的表述。',
  unsourced_number: '正文补链接或「来源：」标注；补不上就把百分比改成定性描述。',
});

/**
 * 绝对化 / 承诺类用语。
 * re 特意不带 g：规则会被反复 test/exec，带 g 的 lastIndex 会污染下一次匹配。
 * 排除「不最好 / 不是唯一 / 不保证」这类否定式，以及「第一步 / 第一次 / 第一件事」这类序数词。
 */
const ABSOLUTE_RULES = Object.freeze([
  { label: '最', re: /(?<![不非])最(?!近|后|初|终|早|晚|新|多|少)/ },
  { label: '第一', re: /(?<![不非])第一(?!次|步|时间|天|年|月|季|批|条|篇|阶段|个|件|轮|周)/ },
  { label: '唯一', re: /(?<![不非])唯一/ },
  { label: '顶级', re: /顶级/ },
  { label: '保证', re: /(?<![不无没])保证/ },
  { label: '100%', re: /100\s*%/ },
  { label: '稳赚', re: /稳赚/ },
  { label: '绝对', re: /绝对(?![不没])/ },
  { label: '永久', re: /永久/ },
]);

/** 效果承诺：比绝对化更具体，单独给一条修改建议。 */
const PROMISE_RULES = Object.freeze([
  { label: '保证涨粉', re: /保证[^。！？\n]{0,6}(?:涨粉|涨|爆|上热门|成单|成交|转化|排名|效果)/ },
  { label: '保证效果', re: /保证(?:有效|见效|出单|赚钱|回本)/ },
  { label: '一定有效', re: /一定(?:能|会|可以)?(?:有效|见效|涨粉|爆|火|成单|成交|赚|回本)/ },
  { label: '包涨粉', re: /包(?:涨粉|成交|上热门|爆款)/ },
]);

/**
 * 正文里的出处标记：命中其一即认为带百分比的数字可核。
 * 只查 title + body，不查 brief：buildBrief 生成的证据要求里自带「来源」字样，查 brief 会误放行。
 */
const SOURCE_MARKER_RE =
  /https?:\/\/|www\.|来源\s*[:：]|出处\s*[:：]|引自|引用\s*[:：]|(?:公开|官方|行业|平台)\s*报告|统计口径|官网|据[^。！？\n]{0,8}(?:统计|报告|公开|数据)/;

/** 带百分比的数字，全局匹配用（每次 new，避免状态残留）。 */
const PERCENT_SOURCE = '\\d+(?:\\.\\d+)?\\s*%';

/** 各风格的口播段兜底文案（正文抽取不足时按顺序补，绝不复制粘贴同一句）。 */
const FALLBACK_LINES = Object.freeze({
  口播科普: [
    '先说结论：这条片子的目标是让人搜到你，而不是让所有人夸你拍得好。',
    '判断脚本能不能拍，看三点：钩子有没有痛点、口播能不能一口气读完、分镜有没有素材。',
    '别急着上设备，先用手机对着这段口播读一遍，读不顺的地方就是观众划走的地方。',
    '把客户常问的三个问题写成三条口播，比讲十遍品牌故事更容易被搜到。',
  ],
  避坑清单: [
    '第一个坑：只讲产品不讲场景，观众听完不知道这事跟自己有什么关系。',
    '第二个坑：把参数堆满，却没有一个能记住的对比，划走只要一秒。',
    '第三个坑：结尾没有行动指令，看完的人想找你，也不知道下一步做什么。',
    '避开这三个坑不一定爆，但能让每一条片子都留下可复用的素材。',
  ],
  对比测评: [
    '先看交付：外包给的是成片还是脚本加分镜，差别在你能不能自己接着拍。',
    '再看成本：自建团队要人、要设备、要流程，外包省的是试错时间。',
    '最后看可控性：选题谁定、素材归谁、数据能不能导出，这三条写进合同。',
    '没有统一答案，预算紧就先外包跑通，跑出模型再考虑自建。',
  ],
  案例复盘: [
    '改的第一件事：把品牌介绍挪到第二段，开头直接回答客户在搜的问题。',
    '改的第二件事：每条口播只讲一个点，时长从九十秒压到四十五秒。',
    '改的第三件事：结尾加一句可执行的下一步，让想咨询的人知道怎么找。',
    '三周后回看，完播率有变化，但效果因账号而异，这里只复盘改法。',
  ],
  快问快答: [
    '问：脚本要写多细？答：写到拍摄的人不用问你第二遍就够。',
    '问：一条片子多少钱？答：先看你要几条、要不要出镜，再谈报价。',
    '问：多久能拍完？答：脚本定稿后，半天到一天能拍完一批。',
    '问：没有素材怎么办？答：门店、产品、工作台，手机随手拍就够用。',
  ],
});

/** 口播段偏短时的补句（只补长度，不引入新的事实主张）。 */
const PAD_TAILS = Object.freeze({
  口播科普: '，这一点值得展开讲。',
  避坑清单: '，这一点在片子里要讲清楚。',
  对比测评: '，这一条建议写进对比表。',
  案例复盘: '，这一处改动可以复用到同类账号。',
  快问快答: '，这个问题评论区问得最多。',
});

/** 结构噪声：来源标注、占位符之类的词，念出来没有信息量。 */
const NOISE_CLAUSES = Object.freeze(
  new Set([
    '来源',
    '出处',
    '参考',
    '参考文献',
    '备注',
    '图源',
    '图片',
    '作者',
    '编辑',
    '责编',
    '校对',
    '声明',
    '版权',
    '转载',
    '待补',
    '待补充可验证事实',
  ]),
);

/** 写作占位符：brief 草稿里常见，不能进口播。 */
const NOISE_PATTERNS = Object.freeze([
  /^待补/,
  /TODO/i,
  /模板模式/,
  /结构骨架/,
  /^本节要点$/,
  /^参考资料$/,
]);

/** 钩子模板：每个风格给 2–3 句候选，取第一句不超过 20 字的。 */
const HOOK_CANDIDATES = Object.freeze({
  口播科普: ({ keyword }) => [
    `90%的人不知道，${keyword}还能这么做`,
    `90%的人不知道：${keyword}的关键在第3步`,
    '90%的人不知道，这件事很多人做反了',
  ],
  避坑清单: ({ keyword }) => [
    '这3个坑，我劝你别踩',
    `做${keyword}，这3个坑别踩`,
  ],
  对比测评: ({ keyword }) => [
    '自建团队和外包，到底选哪个',
    `${keyword}：自建还是外包？`,
    `${keyword}和代运营，到底选哪个`,
  ],
  案例复盘: () => [
    '一个客户，我们改了3件事',
    '一个客户，我们改了3件事，第2件最关键',
  ],
  快问快答: ({ keyword }) => [
    `${keyword}到底值不值得做？`,
    `${keyword}多久能见效？`,
  ],
});

/** 标题备选模板；按顺序取用，超 18 字或含违禁词的自动跳过。 */
const TITLE_TEMPLATES = Object.freeze([
  (ctx) => `${ctx.keyword}怎么做？3步讲清`,
  (ctx) => `${ctx.keyword}避坑：先看这4点`,
  (ctx) => `做${ctx.keyword}前，先问清这3件事`,
  (ctx) => `${ctx.keyword}值不值得做？算笔账`,
  (ctx) => `${ctx.city ? `${ctx.city}老板` : '老板'}做${ctx.keyword}的3个误区`,
  (ctx) => `${ctx.keyword}实操复盘：改了3件事`,
  (ctx) => `${ctx.keyword}3个关键点`,
  (ctx) => `${ctx.keyword}入门清单`,
  (ctx) => `${ctx.keyword}怎么做`,
  (ctx) => `${ctx.keyword}实操复盘`,
]);

/** 封面文案候选：取第一句不超过 12 字的。 */
const COVER_CANDIDATES = Object.freeze({
  口播科普: ({ keyword }) => [`${keyword}3步讲清`, `${keyword}的关键`, '3步讲清'],
  避坑清单: ({ keyword }) => [`${keyword}3个坑`, '这3个坑别踩', '避坑清单'],
  对比测评: ({ keyword }) => [`${keyword}怎么选`, '到底选哪个', '自建还是外包'],
  案例复盘: () => ['改了3件事', '一个客户3处改动', '复盘笔记'],
  快问快答: ({ keyword }) => [`${keyword}值不值`, '快问快答', `${keyword}问答`],
});

/** 话题标签里的风格词。 */
const STYLE_TAGS = Object.freeze({
  口播科普: '口播科普',
  避坑清单: '避坑指南',
  对比测评: '对比测评',
  案例复盘: '案例复盘',
  快问快答: '快问快答',
});

/** 分镜备选（首段钩子与末段引导在 buildShots 里单独给镜头，不占这里）。 */
const SHOT_PLANS = Object.freeze({
  口播科普: [
    { shot: '中景·出镜讲解，手指白板', broll: '白板手写 3 个关键词' },
    { shot: '特写·手机录屏，滑动搜索结果', broll: '手机录屏（搜索页 / 官网）' },
    { shot: '近景·出镜口播，切大字幕卡', broll: '字幕卡 + 轻音效' },
    { shot: '全景·工作场景，侧机位跟随', broll: '工作台空镜 / 团队背影' },
    { shot: '特写·产品细节，缓慢推近', broll: '产品特写' },
  ],
  避坑清单: [
    { shot: '中景·出镜口播，手指比 1 / 2 / 3', broll: '数字贴纸 + 踩坑示意' },
    { shot: '特写·聊天记录截屏，逐条滑过', broll: '客户对话截图（打码）' },
    { shot: '近景·出镜口播，反应镜头', broll: '人物反应镜头' },
    { shot: '全景·门店实拍，边走边说', broll: '门店门头 / 到店动线' },
  ],
  对比测评: [
    { shot: '中景·左右分屏，出镜指两侧', broll: '分屏对比图' },
    { shot: '特写·手机录屏，展示两套后台', broll: '后台数据看板（打码）' },
    { shot: '近景·出镜口播，手持报价单', broll: '报价单特写（打码）' },
    { shot: '全景·工作台，两人对谈', broll: '团队讨论空镜' },
  ],
  案例复盘: [
    { shot: '中景·出镜口播，背景放原始截图', broll: '改版前后对比图' },
    { shot: '特写·手机录屏，翻看改前改后', broll: '账号后台录屏（打码）' },
    { shot: '近景·出镜口播，手写标注重点', broll: '白板标注 / 便签' },
    { shot: '全景·门店实拍，跟拍老板', broll: '老板工作实拍（需授权）' },
  ],
  快问快答: [
    { shot: '近景·出镜口播，快速抛问题', broll: '大字问题卡' },
    { shot: '中景·出镜口播，一问一答切换机位', broll: '双机位切换素材' },
    { shot: '特写·手机录屏，边讲边指', broll: '手机演示录屏' },
    { shot: '全景·工作场景，收尾定格', broll: '团队工作空镜' },
  ],
});

/** 各风格的选句偏好词：命中即加 1 分。 */
const STYLE_HINTS = Object.freeze({
  口播科普: ['为什么', '怎么', '原理', '本质', '区别', '误区'],
  避坑清单: ['坑', '注意', '别', '避免', '风险'],
  对比测评: ['对比', '相比', '差别', '哪个', '价格', '性价比'],
  案例复盘: ['案例', '客户', '改', '复盘', '之前', '后来'],
  快问快答: ['问', '答', '多久', '多少', '要不要'],
});

/** 非字符串输入的统一取值。 */
function safeString(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/** 只把普通对象当对象处理，数组 / null / 字符串一律回退成空对象。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 按 Unicode 码点数字数：中文一字算一个，emoji 不拆成两个。 */
function charLength(text) {
  return Array.from(safeString(text)).length;
}

/** 截断到指定字数，超出时用省略号收口（结果长度恰好不超过 max）。 */
function truncate(text, max) {
  const chars = Array.from(safeString(text));
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/** 把数值夹在闭区间里。 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 时长兜底：非数字回 60，越界夹到 10–300 秒，取整。 */
function normalizeDuration(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_DURATION;
  return clamp(Math.round(num), MIN_DURATION, MAX_DURATION);
}

/**
 * 去掉 Markdown 标记，只留下能读出口的正文。
 * 处理顺序有讲究：先删整块代码与链接，再删行首标记，最后删行内强调，
 * 否则 `**` 会先被当成普通字符留下来。
 */
function stripMarkdown(input) {
  let text = safeString(input);
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/`([^`]*)`/g, '$1');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // 小标题是结构信息，不该念出来：整行删掉，而不是只删行首的 #。
  text = text.replace(/^\s{0,3}#{1,6}[^\n]*$/gm, ' ');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '');
  text = text.replace(/^\s*(?:[-*_]\s*){3,}$/gm, ' ');
  // 表格行同样不进嘴：一行表格念出来只是零散名词。
  text = text.replace(/^\s*\|.*$/gm, ' ');
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(?<!\*)\*(?!\*)([^*\n]+)\*(?!\*)/g, '$1');
  text = text.replace(/(?<!_)_(?!_)([^_\n]+)_(?!_)/g, '$1');
  text = text.replace(/~~([^~]*)~~/g, '$1');
  text = text.replace(/\[\^?[^\]]{0,12}\]/g, ' ');
  text = text.replace(/https?:\/\/\S+/g, ' ');
  text = text.replace(/\|/g, ' ');
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 单行化：去标记、压空白，用于标题 / 关键词 / 钩子 / 封面这些短文本。 */
function cleanInline(input) {
  return stripMarkdown(input).replace(/\s+/g, ' ').trim();
}

/** 去重用的归一化键：忽略标点与空白。 */
function normalizeKey(text) {
  return safeString(text).replace(/[\s。！？；：、，,.;:!?～~「」【】()（）]/g, '');
}

/** 取第一段有意义的短句，用来从标题里猜关键词。 */
function firstClause(text) {
  const parts = safeString(text).split(/[，。！？、；：,.!?;:|｜—–\-\s]+/);
  for (const part of parts) {
    const clean = cleanInline(part);
    if (charLength(clean) >= 2) return clean;
  }
  return '';
}

/** 判断文本是否含绝对化 / 承诺词（生成标题与封面时的自检）。 */
function hasBannedWords(text) {
  const value = safeString(text);
  for (const rule of ABSOLUTE_RULES) {
    if (rule.re.test(value)) return true;
  }
  for (const rule of PROMISE_RULES) {
    if (rule.re.test(value)) return true;
  }
  return false;
}

/** 关键词清洗：去违禁词、去标点、截 10 字。 */
function cleanKeyword(raw) {
  let text = cleanInline(raw);
  if (!text) return '';
  for (const rule of ABSOLUTE_RULES) {
    text = text.replace(new RegExp(rule.re.source, 'g'), '');
  }
  for (const rule of PROMISE_RULES) {
    text = text.replace(new RegExp(rule.re.source, 'g'), '');
  }
  text = text.replace(/[^\p{Script=Han}A-Za-z0-9-]/gu, '');
  return truncate(text, MAX_KEYWORD);
}

/**
 * 关键词兜底链：brief 显式关键词 → 标题首句 → brand.industry 首段 → 「短视频」。
 * 结果剔掉绝对化/承诺词与非文字符号，并截到 10 字，保证标题模板放得下。
 */
function pickKeyword({ title, brief, brand }) {
  const direct = [brief.keyword, brief.primaryKeyword, brief.term, brief.keywordText];
  for (const item of direct) {
    const keyword = cleanKeyword(firstClause(item) || item);
    if (keyword) return keyword;
  }
  const fromTitle = cleanKeyword(firstClause(title));
  if (fromTitle) return fromTitle;
  const fromBriefTitle = cleanKeyword(firstClause(brief.title));
  if (fromBriefTitle) return fromBriefTitle;
  const fromIndustry = cleanKeyword(firstClause(brand.industry));
  if (fromIndustry) return fromIndustry;
  return '短视频';
}

/** 行业短名：取第一段并去掉标点，控制在 8 字内，口播里只带一个。 */
function shortIndustry(raw) {
  const text = firstClause(cleanInline(raw));
  return truncate(text.replace(/[^\p{Script=Han}A-Za-z0-9]/gu, ''), 8);
}

/** 引号内的上下文，方便定位违规出现在哪一句。 */
function snippetAround(text, index, length, radius = 12) {
  const value = safeString(text);
  const start = Math.max(0, index - radius);
  const end = Math.min(value.length, index + length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < value.length ? '…' : '';
  return `${prefix}${value.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}

/** 按句末标点与逗号切碎，得到最小语义单元。 */
function splitClauses(text) {
  return safeString(text)
    .split(/[。！？!?；;，,、\n\r]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 判断是不是结构噪声：纯序号、来源标注、写作占位符，都不该进口播。 */
function isNoiseClause(clause) {
  const key = normalizeKey(clause);
  if (key.length < 2) return true;
  if (NOISE_CLAUSES.has(key)) return true;
  if (/^[一二三四五六七八九十百0-9]+$/.test(key)) return true;
  return NOISE_PATTERNS.some((pattern) => pattern.test(key));
}

/** 把小句合并成 25–60 字的口播块：合并时不越过 60 字。 */
function mergeClauses(clauses) {
  const blocks = [];
  let buffer = '';
  for (const clause of clauses) {
    if (!buffer) {
      buffer = clause;
      continue;
    }
    if (charLength(buffer) + charLength(clause) + 1 <= MAX_BLOCK) {
      buffer = `${buffer}，${clause}`;
    } else {
      blocks.push(buffer);
      buffer = clause;
    }
  }
  if (buffer) blocks.push(buffer);
  return blocks;
}

/** 单句打分：优先带数字、优先带「怎么/为什么/如何」，再叠风格偏好。 */
function scoreBlock(text, style) {
  let score = 0;
  if (/\d/.test(text)) score += 3;
  if (/(怎么|如何|为什么|什么|多少|哪些|要不要|能不能|是不是)/.test(text)) score += 2;
  const hints = STYLE_HINTS[style] || [];
  if (hints.some((word) => text.includes(word))) score += 1;
  const length = charLength(text);
  if (length >= MIN_BLOCK && length <= MAX_BLOCK) score += 1;
  if (/(元|天|月|年|周|小时|分钟|%|倍|条)/.test(text)) score += 1;
  return score;
}

/**
 * 从一段正文里挑口播候选：
 * 1) 先按空行分段，段与段之间不合并，避免两个话题串成一句；
 * 2) 段内切句、合并成块，丢掉不足 14 字的碎片；
 * 3) 按分数排序取前 limit 条，再按原顺序还原，保留叙述逻辑。
 */
function collectBlocks(text, style, limit) {
  const paragraphs = stripMarkdown(text)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const blocks = [];
  for (const paragraph of paragraphs) {
    const clauses = splitClauses(paragraph).filter((clause) => !isNoiseClause(clause));
    for (const block of mergeClauses(clauses)) {
      if (charLength(block) >= MIN_BLOCK_CHARS) blocks.push(block);
    }
  }
  const scored = blocks
    .map((block, index) => ({ text: block, index, score: scoreBlock(block, style) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  return scored
    .slice(0, limit)
    .sort((left, right) => left.index - right.index)
    .map((item) => item.text);
}

/** 把 brief 里的可用素材摊平成文本，供正文不足时补口播。 */
function briefTexts(brief) {
  const out = [];
  const pushArray = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) out.push(item);
      }
    }
  };
  pushArray(brief.mustIncludeFacts);
  pushArray(brief.evidenceRequirements);
  if (Array.isArray(brief.outline)) {
    for (const section of brief.outline) {
      if (isPlainObject(section)) {
        if (typeof section.h2 === 'string') out.push(section.h2);
        pushArray(section.points);
      } else if (typeof section === 'string') {
        out.push(section);
      }
    }
  }
  out.push(brief.targetQuestion, brief.format, brief.searchIntent);
  return out.filter((item) => typeof item === 'string' && item.trim());
}

/** 补句直到达到 25 字；循环次数封顶，避免空串死循环。 */
function padBlock(text, style) {
  const tail = PAD_TAILS[style] || PAD_TAILS[DEFAULT_STYLE];
  let out = text;
  let guard = 0;
  while (charLength(out) < MIN_BLOCK && guard < 8) {
    out += tail;
    guard += 1;
  }
  return out;
}

/** 超长时优先在标点处收口，收不住才硬截 + 省略号。 */
function cutBlock(text, max) {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = chars.slice(0, max - 1).join('');
  const cut = Math.max(...['。', '！', '？', '；', '，'].map((mark) => head.lastIndexOf(mark)));
  if (cut >= MIN_BLOCK - 1) return head.slice(0, cut + 1);
  return `${head}…`;
}

/** 口播段定型：清洗 → 补长 → 截断，最终一定落在 25–60 字。 */
function fitBlock(raw, style) {
  let text = cleanInline(raw);
  text = text.replace(/^[，。！？；：、,.!?;:\s]+/, '').replace(/[，,；;、\s]+$/, '');
  if (!text) text = FALLBACK_LINES[style][0];
  if (charLength(text) < MIN_BLOCK) text = padBlock(text, style);
  if (charLength(text) > MAX_BLOCK) text = cutBlock(text, MAX_BLOCK);
  return text;
}

/** 钩子：按风格取候选，第一句不超过 20 字的胜出。 */
function buildHook({ style, keyword }) {
  const builder = HOOK_CANDIDATES[style] || HOOK_CANDIDATES[DEFAULT_STYLE];
  const candidates = builder({ keyword });
  for (const candidate of candidates) {
    const text = cleanInline(candidate);
    if (text && charLength(text) <= MAX_HOOK) return text;
  }
  return truncate(cleanInline(candidates[0]) || '前3秒先说结论', MAX_HOOK);
}

/** 结尾引导：品牌名与城市放在句首，超长时优先裁掉后半句而不是品牌信息。 */
function buildCta({ style, keyword, brand, city, name }) {
  const industry = shortIndustry(brand.industry) || '内容';
  const brandPart = name
    ? `${name}${city ? `在${city}` : ''}做${industry}`
    : city
      ? `${city}本地做${industry}的`
      : `做${industry}的`;
  const tails = {
    口播科普: `想聊${keyword}的，评论区留「要」，我们一条条回。`,
    避坑清单: `想要这份${keyword}清单，评论区留「清单」。`,
    对比测评: `拿不准${keyword}怎么选，评论区说说你的预算。`,
    案例复盘: '想看你这个行业的改法，评论区留「行业」。',
    快问快答: `还有${keyword}的问题，评论区接着问。`,
  };
  const tail = tails[style] || tails[DEFAULT_STYLE];
  return fitBlock(`${brandPart}，${tail}`, style);
}

/**
 * 时间轴：首段固定 0–3s（时长不足 9 秒时按比例压缩），其余按段数均分，
 * 每段至少 1 秒，最后一段必须正好收在 durationSec。
 */
function allocateTimeline(count, durationSec) {
  const total = Math.max(1, count);
  if (total === 1) return [`0-${durationSec}s`];

  let hookEnd = durationSec >= 9 ? HOOK_SECONDS : Math.max(1, Math.floor(durationSec / 3));
  hookEnd = clamp(hookEnd, 1, durationSec - (total - 1));

  const points = [0, hookEnd];
  const rest = durationSec - hookEnd;
  for (let i = 1; i < total - 1; i += 1) {
    let point = Math.round(hookEnd + (rest * i) / (total - 1));
    point = Math.max(point, points[points.length - 1] + 1);
    point = Math.min(point, durationSec - (total - 1 - i));
    points.push(point);
  }
  points.push(durationSec);

  const spans = [];
  for (let i = 0; i < total; i += 1) spans.push(`${points[i]}-${points[i + 1]}s`);
  return spans;
}

/** 字幕：优先在标点处断开，最多 18 字。 */
function buildCaption(text) {
  const clean = cleanInline(text).replace(/^[，。！？；：、\s]+/, '');
  const chars = Array.from(clean);
  if (chars.length <= MAX_CAPTION) return clean;
  const head = chars.slice(0, MAX_CAPTION - 1).join('');
  const cut = Math.max(...['，', '。', '；', '：', '！', '？'].map((mark) => head.lastIndexOf(mark)));
  if (cut >= 6) return head.slice(0, cut);
  return `${head}…`;
}

/** 分镜：与口播段一一对应；首段给怼脸钩子镜头，末段给引导镜头。 */
function buildShots(style, narration) {
  const plan = SHOT_PLANS[style] || SHOT_PLANS[DEFAULT_STYLE];
  return narration.map((segment, index) => {
    const base = plan[index % plan.length];
    const isHook = index === 0;
    const isLast = index === narration.length - 1 && narration.length > 1;
    let shot = base.shot;
    let broll = base.broll;
    if (isHook) {
      shot = '近景·出镜口播（怼脸），大字幕压屏';
      broll = '人物正面实拍，背景干净留白';
    } else if (isLast) {
      shot = '中景·出镜口播，手势指向评论区';
      broll = '评论区截图（打码）＋门店空镜';
    }
    return {
      t: segment.t,
      shot,
      caption: buildCaption(segment.text),
      broll,
    };
  });
}

/** 标题备选：3–5 条，≤18 字、必须含关键词、不能带违禁词。 */
function buildTitleOptions({ keyword, city, style }) {
  const ctx = { keyword, city, style };
  const options = [];
  const seen = new Set();
  const push = (text) => {
    const clean = cleanInline(text);
    if (!clean || seen.has(clean)) return;
    if (charLength(clean) > MAX_TITLE_OPTION) return;
    if (!clean.includes(keyword)) return;
    if (hasBannedWords(clean)) return;
    seen.add(clean);
    options.push(clean);
  };

  for (const template of TITLE_TEMPLATES) {
    if (options.length >= MAX_TITLE_OPTIONS) break;
    push(template(ctx));
  }
  for (const suffix of ['怎么做', '3个关键点', '避坑指南', '实操复盘']) {
    if (options.length >= MIN_TITLE_OPTIONS) break;
    push(`${keyword}${suffix}`);
  }
  return options.slice(0, MAX_TITLE_OPTIONS);
}

/** 话题标签：关键词 / 城市 / 品牌 / 风格 + 固定流量词，5–8 个，全部带 #。 */
function buildHashtags({ keyword, city, brand, style, body, title, brief }) {
  const tags = [];
  const seen = new Set();
  const push = (value) => {
    const bodyText = cleanInline(value).replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '');
    if (!bodyText) return;
    const tag = `#${bodyText}`;
    if (seen.has(tag)) return;
    seen.add(tag);
    tags.push(tag);
  };

  push(keyword);
  if (city) push(`${city}本地生意`);
  if (brand.name) push(brand.name);
  push(STYLE_TAGS[style] || STYLE_TAGS[DEFAULT_STYLE]);
  push('短视频脚本');
  push('内容获客');
  const geoText = `${title}\n${body}\n${safeString(brand.industry)}\n${safeString(brief.targetQuestion)}`;
  push(/GEO|搜索优化|AI\s*搜索/i.test(geoText) ? 'GEO' : '老板IP');
  push('短视频');
  for (const extra of ['内容营销', '本地生活', '获客', '口播文案']) {
    if (tags.length >= MIN_TAGS) break;
    push(extra);
  }
  return tags.slice(0, MAX_TAGS);
}

/** 封面文案：≤12 字。 */
function buildCoverText({ style, keyword }) {
  const builder = COVER_CANDIDATES[style] || COVER_CANDIDATES[DEFAULT_STYLE];
  const candidates = builder({ keyword }).map((item) => cleanInline(item)).filter(Boolean);
  for (const candidate of candidates) {
    if (charLength(candidate) <= MAX_COVER) return candidate;
  }
  return truncate(candidates[0] || '口播脚本', MAX_COVER);
}

/** 按规则扫一类违禁词，同一词只记一条。 */
function scanRules(text, rules, type) {
  const issues = [];
  for (const rule of rules) {
    const match = rule.re.exec(text);
    if (!match) continue;
    issues.push({
      type,
      word: rule.label,
      detail: `命中${ISSUE_TYPES[type]}「${rule.label}」：${ISSUE_ADVICE[type]}`,
      snippet: snippetAround(text, match.index, match[0].length),
    });
  }
  return issues;
}

/** 百分比溯源：正文没有链接 / 来源标注时，逐个数字报一条。 */
function scanUnsourcedPercent(text, sourceText) {
  if (SOURCE_MARKER_RE.test(safeString(sourceText))) return [];
  const regex = new RegExp(PERCENT_SOURCE, 'g');
  const seen = new Set();
  const issues = [];
  for (const match of text.matchAll(regex)) {
    const value = match[0].replace(/\s+/g, '');
    if (seen.has(value)) continue;
    seen.add(value);
    issues.push({
      type: 'unsourced_number',
      word: value,
      detail: `出现「${value}」但正文没有链接或来源：${ISSUE_ADVICE.unsourced_number}`,
      snippet: snippetAround(text, match.index, match[0].length),
    });
  }
  return issues;
}

/**
 * 合规检查：
 * - 绝对化 / 承诺词查「输入标题 + 正文 + 生成脚本」，避免正文里的违禁词因为没被选进
 *   口播就逃过检查；
 * - 百分比只查输入与正文口播段（narration 首段是模板钩子，跳过，理由见文件头）；
 * - 同一类型 + 同一词只记一条，issues 保持稳定顺序。
 */
function checkCompliance({ titleText, bodyText, narration, titleOptions, coverText }) {
  const spoken = narration.map((item) => safeString(item.text));
  const scanText = [titleText, bodyText, ...spoken, ...titleOptions, coverText].join('\n');
  const sourceText = `${titleText}\n${bodyText}`;
  const percentText = [titleText, bodyText, ...spoken.slice(1)].join('\n');

  const raw = [
    ...scanRules(scanText, ABSOLUTE_RULES, 'absolute'),
    ...scanRules(scanText, PROMISE_RULES, 'promise'),
    ...scanUnsourcedPercent(percentText, sourceText),
  ];

  const seen = new Set();
  const issues = [];
  for (const issue of raw) {
    const key = `${issue.type}|${issue.word}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(issue);
  }
  return { passed: issues.length === 0, issues };
}

/** 平台注意点：时长、风格、封面三件事逐平台写清楚。 */
function buildPlatformNotes({ durationSec, coverText, keyword, style, hook }) {
  return {
    douyin:
      `竖屏 9:16，${durationSec} 秒；前 3 秒必须出钩子「${hook}」，` +
      `按「${style}」的口播节奏走，近景 + 大字幕，封面用「${coverText}」；` +
      '结尾引导评论，画面里别放二维码。',
    xiaohongshu:
      `竖屏 3:4 或 9:16，${durationSec} 秒；标题带「${keyword}」，封面 3:4 大字，` +
      '正文首句重复钩子；口播语速放慢，字幕分段上屏，评论区置顶补充信息。',
    video_account:
      `竖屏 9:16，${durationSec} 秒；口播偏稳重，开头 5 秒说清结论，封面用「${coverText}」；` +
      '可以挂公众号文章承接搜索流量，结尾加一句「想看完整版评论区说」。',
  };
}

/**
 * 生成口播短视频脚本。
 *
 * @param {object} [options]
 * @param {string} [options.title] 文章标题，同时用于猜关键词与标题备选
 * @param {string} [options.body] 文章正文（Markdown 可），口播稿的主要来源
 * @param {object} [options.brief] 内容 brief（keyword / targetQuestion / mustIncludeFacts / outline 等）
 * @param {object} [options.brand] 品牌信息（name / city / industry），用于结尾自然植入
 * @param {string} [options.style] 五种风格之一，非法值回退「口播科普」
 * @param {number} [options.durationSec] 目标时长，夹在 10–300 秒，默认 60
 * @returns {{
 *   title: string, style: string, durationSec: number, hook: string,
 *   narration: Array<{t: string, text: string}>,
 *   shots: Array<{t: string, shot: string, caption: string, broll: string}>,
 *   titleOptions: string[], hashtags: string[], coverText: string,
 *   compliance: {passed: boolean, issues: Array<object>},
 *   platformNotes: {douyin: string, xiaohongshu: string, video_account: string},
 * }}
 */
export function buildVideoScript({
  title = '',
  body = '',
  brief = {},
  brand = {},
  style = '口播科普',
  durationSec = 60,
} = {}) {
  const safeBrief = isPlainObject(brief) ? brief : {};
  const safeBrand = isPlainObject(brand) ? brand : {};
  const safeStyle = SCRIPT_STYLES.includes(style) ? style : DEFAULT_STYLE;
  const duration = normalizeDuration(durationSec);
  const bodyText = safeString(body);

  const keyword = pickKeyword({ title: cleanInline(title), brief: safeBrief, brand: safeBrand });
  const city = cleanInline(safeBrand.city);
  const name = cleanInline(safeBrand.name);
  const rawTitle = cleanInline(title) || cleanInline(safeBrief.title);
  const scriptTitle = rawTitle || `${keyword}口播脚本`;

  const hook = buildHook({ style: safeStyle, keyword });
  const targetSegments = clamp(
    Math.round(duration / SECONDS_PER_SEGMENT),
    MIN_SEGMENTS,
    MAX_SEGMENTS,
  );
  const contentBudget = Math.max(1, targetSegments - 2);

  // 选段顺序：正文 → brief 素材 → 风格兜底；全程按归一化文本去重。
  const selected = [];
  const seen = new Set();
  const take = (blocks) => {
    for (const block of blocks) {
      if (selected.length >= contentBudget) return;
      const key = normalizeKey(block);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      selected.push(block);
    }
  };

  take(collectBlocks(bodyText, safeStyle, contentBudget));
  if (selected.length < contentBudget) {
    take(collectBlocks(briefTexts(safeBrief).join('\n'), safeStyle, contentBudget));
  }
  if (selected.length < contentBudget) take(FALLBACK_LINES[safeStyle]);
  if (selected.length === 0) selected.push(FALLBACK_LINES[safeStyle][0]);

  const narrationTexts = [
    hook,
    ...selected.map((block) => fitBlock(block, safeStyle)),
    buildCta({ style: safeStyle, keyword, brand: safeBrand, city, name }),
  ];
  const spans = allocateTimeline(narrationTexts.length, duration);
  const narration = narrationTexts.map((text, index) => ({ t: spans[index], text }));

  const shots = buildShots(safeStyle, narration);
  const titleOptions = buildTitleOptions({ keyword, city, style: safeStyle });
  const hashtags = buildHashtags({
    keyword,
    city,
    brand: safeBrand,
    style: safeStyle,
    body: bodyText,
    title: rawTitle,
    brief: safeBrief,
  });
  const coverText = buildCoverText({ style: safeStyle, keyword });
  const compliance = checkCompliance({
    titleText: rawTitle,
    bodyText,
    narration,
    titleOptions,
    coverText,
  });
  const platformNotes = buildPlatformNotes({
    durationSec: duration,
    coverText,
    keyword,
    style: safeStyle,
    hook,
  });

  return {
    title: scriptTitle,
    style: safeStyle,
    durationSec: duration,
    hook,
    narration,
    shots,
    titleOptions,
    hashtags,
    coverText,
    compliance,
    platformNotes,
  };
}

/** Markdown 表格单元格：竖线转义、换行压平，空值用「—」。 */
function cell(value) {
  return (
    safeString(value)
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, ' ')
      .trim() || '—'
  );
}

/**
 * 把脚本渲染成可直接贴进报告 / 拍摄群的 Markdown。
 * 九个固定章节：标题、3秒钩子、口播稿、分镜、标题备选、话题标签、封面文案、合规检查、平台注意。
 * 缺字段时用「—」占位，不抛异常（脚本可能来自手写或旧版本）。
 *
 * @param {object} script buildVideoScript 的返回值
 * @returns {string}
 */
export function renderVideoScriptMarkdown(script) {
  const data = isPlainObject(script) ? script : {};
  const style = SCRIPT_STYLES.includes(data.style) ? data.style : DEFAULT_STYLE;
  const duration = normalizeDuration(data.durationSec);
  const hook = safeString(data.hook);
  const narration = Array.isArray(data.narration) ? data.narration : [];
  const shots = Array.isArray(data.shots) ? data.shots : [];
  const titleOptions = Array.isArray(data.titleOptions) ? data.titleOptions : [];
  const hashtags = Array.isArray(data.hashtags) ? data.hashtags : [];
  const coverText = safeString(data.coverText);
  const issues = Array.isArray(data.compliance?.issues) ? data.compliance.issues : [];
  const passed = data.compliance?.passed === true;
  const notes = isPlainObject(data.platformNotes) ? data.platformNotes : {};

  const lines = [];
  lines.push('## 标题');
  lines.push('');
  lines.push(safeString(data.title) || '口播短视频脚本');
  lines.push('');
  lines.push(`- 风格：${style}`);
  lines.push(`- 时长：${duration} 秒`);
  lines.push('');

  lines.push('## 3秒钩子');
  lines.push('');
  lines.push(hook ? `> ${cell(hook)}` : '—');
  lines.push('');

  lines.push('## 口播稿');
  lines.push('');
  lines.push('| 时间 | 台词 |');
  lines.push('| --- | --- |');
  if (narration.length === 0) lines.push('| — | — |');
  for (const item of narration) {
    lines.push(`| ${cell(item && item.t)} | ${cell(item && item.text)} |`);
  }
  lines.push('');

  lines.push('## 分镜');
  lines.push('');
  lines.push('| 时间 | 景别 | 字幕 | 素材 |');
  lines.push('| --- | --- | --- | --- |');
  if (shots.length === 0) lines.push('| — | — | — | — |');
  for (const item of shots) {
    lines.push(
      `| ${cell(item && item.t)} | ${cell(item && item.shot)} | ${cell(
        item && item.caption,
      )} | ${cell(item && item.broll)} |`,
    );
  }
  lines.push('');

  lines.push('## 标题备选');
  lines.push('');
  if (titleOptions.length === 0) lines.push('- —');
  for (const option of titleOptions) lines.push(`- ${cell(option)}`);
  lines.push('');

  lines.push('## 话题标签');
  lines.push('');
  lines.push(hashtags.length ? hashtags.map((tag) => cell(tag)).join(' ') : '—');
  lines.push('');

  lines.push('## 封面文案');
  lines.push('');
  lines.push(coverText ? cell(coverText) : '—');
  lines.push('');

  lines.push('## 合规检查');
  lines.push('');
  lines.push(`- 结论：${passed ? '通过' : `未通过（${issues.length} 条）`}`);
  for (const issue of issues) {
    const type = ISSUE_TYPES[issue && issue.type] || '其他问题';
    const detail = (issue && (issue.detail || issue.word)) || '未命名问题';
    lines.push(`- 〔${type}〕${cell(detail)}`);
  }
  if (!passed && issues.length === 0) {
    lines.push('- 〔其他问题〕合规未通过，但未返回具体问题，请人工复核。');
  }
  lines.push('');

  lines.push('## 平台注意');
  lines.push('');
  lines.push(`- 抖音：${cell(notes.douyin)}`);
  lines.push(`- 小红书：${cell(notes.xiaohongshu)}`);
  lines.push(`- 视频号：${cell(notes.video_account)}`);
  lines.push('');

  return lines.join('\n');
}
