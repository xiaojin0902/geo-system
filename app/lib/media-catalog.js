/**
 * lib/media-catalog.js
 * GEO 信源网络：把「可发布渠道」做成可管理、可报价、可追踪效果的目录。
 *
 * 对标头部服务商的「媒体资源 / 信源网络」：客户真正买的是「我的内容会出现在哪些信源上」，
 * 所以目录必须同时回答四个问题——
 * 1. 有哪些渠道、属于哪一类（`MEDIA_TYPES`）；
 * 2. 这个渠道在当前环境能不能自动发（`mediaReadiness`：api / webhook / browser / manual）；
 * 3. 发一轮大概多少钱（`estimateCost`：单篇区间 × 篇数，标注是估算）；
 * 4. 发出去之后，AI 回答里会不会引到它（`domains` + `aiCited`，供引用归因匹配）。
 *
 * 设计取舍：
 * - 纯数据 + 纯函数：零依赖、不联网、不读写文件与数据库，落库与真实发布都由调用方负责；
 * - 价格只写区间、不写「刊例价」：区间是公开市场经验值（¥0-3000），仅用于报价时给范围，
 *   不是任何一家渠道的官方报价，也不是对客户的承诺；实际成交价必须以当期询价为准；
 * - `aiCited` 只表示「中文 AI 回答里较常见」，是可辩护的经验判断，不写「保证收录 / 保证被引」；
 * - `domains` 只存主域名（不带协议与 www），用于把 AI 引用里的链接归因回渠道。
 */

/**
 * 八大渠道类型。顺序即报表 / 筛选器的展示顺序，不要随意调整。
 * @type {ReadonlyArray<string>}
 */
export const MEDIA_TYPES = Object.freeze([
  '中央媒体',
  '门户网站',
  '行业垂直',
  '地方媒体',
  '自媒体平台',
  '问答社区',
  '视频平台',
  '自媒体矩阵',
]);

/**
 * 内置渠道目录（23 条）。
 *
 * 字段说明：
 * - `id`：稳定标识，测试与调用方都靠它定位，发布后不可改名；
 * - `domains`：主域名，用于从 AI 引用里识别「这个信源是不是被引了」；
 * - `publishMode`：默认发布方式，'api' | 'webhook' | 'browser' | 'manual'；
 * - `envKey`：可选。该键在 env 里有值即视为已配置，渠道升级为 api 自动化；
 * - `priceMin` / `priceMax`：单篇成本区间（元），公开市场经验值估算，非官方报价；
 * - `indexSpeed`：'fast' | 'normal' | 'slow'，收录/被检索的常见速度，同样是经验值；
 * - `aiCited`：中文 AI 回答里是否较常见。为 true 时 note 必须给出可辩护的理由；
 * - `note`：一句中文说明，写清楚「适合什么内容」，不写效果承诺。
 *
 * 刻意不写「客户名 / 案例 / 保证收录」：目录是通用资源库，任何具体客户都应留在
 * 调用方自己的数据里；效果只能靠 `domains` + 引用记录事后统计，不能预先承诺。
 *
 * @type {ReadonlyArray<{
 *   id: string, name: string, type: string, domains: string[],
 *   publishMode: 'api'|'webhook'|'browser'|'manual', envKey?: string,
 *   priceMin: number, priceMax: number, indexSpeed: 'fast'|'normal'|'slow',
 *   aiCited: boolean, note: string
 * }>}
 */
export const MEDIA_CATALOG = Object.freeze([
  // ---- 中央媒体：权威度高、审核严格，通常只能人工送审 ----
  {
    id: 'renmin',
    name: '人民网',
    type: '中央媒体',
    domains: ['people.com.cn'],
    publishMode: 'manual',
    priceMin: 800,
    priceMax: 3000,
    indexSpeed: 'fast',
    aiCited: true,
    note: '央媒权威源，AI 常引用其政策与行业报道；只能人工送审',
  },
  {
    id: 'xinhua',
    name: '新华网',
    type: '中央媒体',
    domains: ['xinhuanet.com', 'news.cn'],
    publishMode: 'manual',
    priceMin: 1000,
    priceMax: 3000,
    indexSpeed: 'fast',
    aiCited: true,
    note: '央媒权威源，AI 常引用其通稿；审核周期长，需预留排期',
  },
  {
    id: 'chinanews',
    name: '中国新闻网',
    type: '中央媒体',
    domains: ['chinanews.com.cn', 'chinanews.com'],
    publishMode: 'manual',
    priceMin: 600,
    priceMax: 2000,
    indexSpeed: 'normal',
    aiCited: true,
    note: '央媒资讯源，AI 常引用其社会与产业新闻；适合品牌背书',
  },

  // ---- 门户网站：分发量大、收录快，适合本地服务词 ----
  {
    id: 'toutiao',
    name: '今日头条',
    type: '门户网站',
    domains: ['toutiao.com'],
    publishMode: 'webhook',
    envKey: 'PUBLISH_TOUTIAO_WEBHOOK',
    priceMin: 0,
    priceMax: 200,
    indexSpeed: 'fast',
    aiCited: true,
    note: '资讯分发热门，AI 常引用其聚合内容；标题需克制，夸张易限流',
  },
  {
    id: 'sohu',
    name: '搜狐号',
    type: '门户网站',
    domains: ['sohu.com'],
    publishMode: 'webhook',
    envKey: 'PUBLISH_SOHU_WEBHOOK',
    priceMin: 0,
    priceMax: 150,
    indexSpeed: 'fast',
    aiCited: true,
    note: '搜狐号资讯，收录友好，AI 常引用行业解读类文章',
  },
  {
    id: 'netease',
    name: '网易号',
    type: '门户网站',
    domains: ['163.com'],
    publishMode: 'manual',
    priceMin: 0,
    priceMax: 200,
    indexSpeed: 'normal',
    aiCited: true,
    note: '门户分发，AI 常引用其行业与生活类报道；适合长文解读',
  },
  {
    id: 'sina',
    name: '新浪看点',
    type: '门户网站',
    domains: ['sina.com.cn', 'sina.cn'],
    publishMode: 'manual',
    priceMin: 0,
    priceMax: 150,
    indexSpeed: 'fast',
    aiCited: false,
    note: '门户分发，收录较快；偏资讯流，长文适配一般',
  },

  // ---- 行业垂直：选题要对口，被引概率取决于行业匹配度 ----
  {
    id: '36kr',
    name: '36氪',
    type: '行业垂直',
    domains: ['36kr.com'],
    publishMode: 'manual',
    priceMin: 500,
    priceMax: 1500,
    indexSpeed: 'normal',
    aiCited: true,
    note: '创投与科技垂直，AI 常引用其融资与产品分析；需编辑选题通过',
  },
  {
    id: 'huxiu',
    name: '虎嗅',
    type: '行业垂直',
    domains: ['huxiu.com'],
    publishMode: 'manual',
    priceMin: 400,
    priceMax: 1200,
    indexSpeed: 'normal',
    aiCited: true,
    note: '商业评论垂直，AI 常引用其观点长文；更看重作者署名与观点',
  },
  {
    id: 'ebrun',
    name: '亿邦动力',
    type: '行业垂直',
    domains: ['ebrun.com'],
    publishMode: 'manual',
    priceMin: 300,
    priceMax: 1000,
    indexSpeed: 'normal',
    aiCited: true,
    note: '电商与零售垂直，AI 常引用其行业数据与案例拆解',
  },
  {
    id: 'dianshangbao',
    name: '电商报',
    type: '行业垂直',
    domains: ['dsb.cn', 'dianshangbao.com'],
    publishMode: 'manual',
    priceMin: 200,
    priceMax: 800,
    indexSpeed: 'slow',
    aiCited: false,
    note: '电商资讯垂直，适合铺行业词；收录与引用不稳定，按需选投',
  },

  // ---- 地方媒体：本地服务词的主力信源 ----
  {
    id: 'wuhu-news',
    name: '芜湖新闻网',
    type: '地方媒体',
    domains: ['wuhunews.cn', 'wuhu.gov.cn'],
    publishMode: 'manual',
    priceMin: 100,
    priceMax: 500,
    indexSpeed: 'normal',
    aiCited: true,
    note: '芜湖本地新闻源，AI 常引用本地报道；适合本地服务词与政务语境',
  },
  {
    id: 'dajiang-evening',
    name: '大江晚报',
    type: '地方媒体',
    domains: ['dajiangwanbao.com'],
    publishMode: 'manual',
    priceMin: 100,
    priceMax: 400,
    indexSpeed: 'slow',
    aiCited: false,
    note: '芜湖本地都市报，线下影响力大于线上收录；适合品牌本地曝光',
  },

  // ---- 自媒体平台：可自动化程度最高，是信源网络的量 ----
  {
    id: 'wechat',
    name: '微信公众号',
    type: '自媒体平台',
    domains: ['mp.weixin.qq.com'],
    publishMode: 'api',
    envKey: 'PUBLISH_WECHAT_WEBHOOK',
    priceMin: 0,
    priceMax: 0,
    indexSpeed: 'fast',
    aiCited: true,
    note: '自有阵地，零成本；AI 常引用公众号行业解读，搜索权重随账号质量波动',
  },
  {
    id: 'baijiahao',
    name: '百家号',
    type: '自媒体平台',
    domains: ['baijiahao.baidu.com'],
    publishMode: 'webhook',
    envKey: 'PUBLISH_BAIJIAHAO_WEBHOOK',
    priceMin: 0,
    priceMax: 150,
    indexSpeed: 'fast',
    aiCited: true,
    note: '百度系分发（原「百度百家」），AI 常引用其资讯；适合本地服务词',
  },
  {
    id: 'xiaohongshu',
    name: '小红书',
    type: '自媒体平台',
    domains: ['xiaohongshu.com', 'xhslink.com'],
    publishMode: 'browser',
    envKey: 'PUBLISH_XIAOHONGSHU_WEBHOOK',
    priceMin: 50,
    priceMax: 500,
    indexSpeed: 'fast',
    aiCited: true,
    note: '图文笔记，AI 常引用其测评与种草内容；需口语化、分段短，硬广易限流',
  },
  {
    id: 'weibo',
    name: '微博',
    type: '自媒体平台',
    domains: ['weibo.com', 'weibo.cn'],
    publishMode: 'api',
    envKey: 'PUBLISH_WEIBO_WEBHOOK',
    priceMin: 0,
    priceMax: 300,
    indexSpeed: 'fast',
    aiCited: false,
    note: '短图文与话题，传播快但留存短，AI 引用偏少；适合事件配合',
  },

  // ---- 问答社区：AI 回答的高频引用对象，但必须真人语气 ----
  {
    id: 'zhihu',
    name: '知乎',
    type: '问答社区',
    domains: ['zhihu.com'],
    publishMode: 'browser',
    envKey: 'PUBLISH_ZHIHU_WEBHOOK',
    priceMin: 50,
    priceMax: 300,
    indexSpeed: 'fast',
    aiCited: true,
    note: '问答与专栏并存，AI 常引用其高赞回答；发布需真人语气，硬广易被折叠',
  },
  {
    id: 'baidu-zhidao',
    name: '百度知道',
    type: '问答社区',
    domains: ['zhidao.baidu.com'],
    publishMode: 'manual',
    priceMin: 0,
    priceMax: 100,
    indexSpeed: 'normal',
    aiCited: true,
    note: '长尾问答，AI 常引用其标准问答；一题一问，适合「多少钱 / 怎么选」',
  },

  // ---- 视频平台：内容形态不同，引用多来自字幕与简介 ----
  {
    id: 'douyin',
    name: '抖音',
    type: '视频平台',
    domains: ['douyin.com'],
    publishMode: 'api',
    envKey: 'PUBLISH_DOUYIN_WEBHOOK',
    priceMin: 100,
    priceMax: 600,
    indexSpeed: 'fast',
    aiCited: false,
    note: '短视频与图文，配合 video-script 使用；进入 AI 回答的比例偏低',
  },
  {
    id: 'bilibili',
    name: 'B站',
    type: '视频平台',
    domains: ['bilibili.com'],
    publishMode: 'browser',
    envKey: 'PUBLISH_BILIBILI_WEBHOOK',
    priceMin: 0,
    priceMax: 500,
    indexSpeed: 'normal',
    aiCited: false,
    note: '中长视频与专栏，适合深度内容；AI 引用集中在科技区',
  },
  {
    id: 'shipinhao',
    name: '视频号',
    type: '视频平台',
    domains: ['channels.weixin.qq.com'],
    publishMode: 'api',
    envKey: 'PUBLISH_SHIPINHAO_WEBHOOK',
    priceMin: 0,
    priceMax: 300,
    indexSpeed: 'normal',
    aiCited: false,
    note: '微信内视频，公私域联动好；公开搜索可检索性弱，AI 引用少',
  },

  // ---- 自媒体矩阵：不是单一平台，而是「多号批量分发」这一动作 ----
  {
    id: 'matrix',
    name: '自媒体矩阵（多号分发）',
    type: '自媒体矩阵',
    domains: [],
    publishMode: 'manual',
    priceMin: 0,
    priceMax: 200,
    indexSpeed: 'normal',
    aiCited: false,
    note: '一批中小号批量分发，用于长尾覆盖；单号权重低，适合做量不适合做背书',
  },
]);

// ---------------------------------------------------------------- 内部常量与工具

/** 发布方式的中文展示名，渲染表格与提示文案共用。 */
const MODE_LABELS = Object.freeze({
  api: 'API',
  webhook: 'Webhook',
  browser: '浏览器',
  manual: '人工',
});

/** 收录速度的中文展示名。 */
const SPEED_LABELS = Object.freeze({
  fast: '快',
  normal: '一般',
  slow: '慢',
});

/** 浏览器自动化的固定提示：这是恒野本机发布链路的真实前置条件。 */
const BROWSER_HINT = '需要 Chrome 调试端口';

/** 只认字符串，去掉首尾空白；数字 / null 一律按空处理。 */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 环境变量统一转成去空白的字符串（兼容传数字 0 的写法）。 */
function envText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/** 环境变量对象只接受普通对象，其它一律当空对象，避免 null 崩掉调用方。 */
function envObject(env) {
  return env && typeof env === 'object' ? env : {};
}

/** 价格字段只认非负有限数，其它按 0 处理，避免 NaN 传播到报价单。 */
function price(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 渠道名比较器。
 * 用中文排序规则而不是裸 `<`：中文名的码点顺序对使用者毫无意义，拼音序才可读。
 * 同 aiCited 的渠道按名称升序，保证同一份目录每次渲染顺序一致。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareName(a, b) {
  return String(a).localeCompare(String(b), 'zh-Hans-CN');
}

/**
 * 搜索用的规范化：小写 + 去首尾空白。
 * 中文没有大小写，但域名（zhihu / Bilibili）和英文备注会大小写混写。
 * @param {unknown} value
 * @returns {string}
 */
function fold(value) {
  return String(value ?? '').toLowerCase().trim();
}

// ---------------------------------------------------------------- 对外接口

/**
 * 按类型与关键词筛选渠道目录。
 *
 * 规则：
 * - `type` 精确匹配（去首尾空白），空串表示不过滤；
 * - `search` 在 name / note / domains 三个字段里做不区分大小写的包含匹配，命中任一即保留；
 * - 结果先按 `aiCited` 降序（常被引的排前面），再按 name 升序；
 * - 返回的是目录条目的浅拷贝，调用方改字段不会污染 `MEDIA_CATALOG`。
 *
 * `env` 只作为调用方上下文保留（例如界面里顺手叠加就绪状态），不参与筛选与排序，
 * 否则「同一筛选条件在不同机器上结果不同」，报价与报表就不可复现了。
 *
 * @param {object} [options]
 * @param {string} [options.type=''] 渠道类型，必须是 MEDIA_TYPES 之一
 * @param {string} [options.search=''] 关键词，可为空
 * @param {Record<string, string|undefined>} [options.env={}] 环境变量（预留，不参与筛选）
 * @returns {Array<object>} 新数组，元素为目录条目浅拷贝
 */
export function listMedia({ type = '', search = '', env = {} } = {}) {
  void envObject(env); // 显式声明「这里读 env 但不使用」，避免被误认为漏实现
  const wantedType = text(type);
  const keyword = fold(search);

  const matched = MEDIA_CATALOG.filter((media) => {
    if (wantedType && media.type !== wantedType) return false;
    if (!keyword) return true;
    const haystack = [media.name, media.note, ...(media.domains || [])].map(fold);
    return haystack.some((field) => field.includes(keyword));
  });

  return matched
    .map((media) => ({ ...media, domains: [...(media.domains || [])] }))
    .sort((a, b) => {
      if (a.aiCited !== b.aiCited) return a.aiCited ? -1 : 1;
      const byName = compareName(a.name, b.name);
      return byName !== 0 ? byName : compareName(a.id, b.id);
    });
}

/**
 * 判断一个渠道在当前环境下能不能自动发布。
 *
 * 就绪优先级：
 * 1. `manual`：永远就绪，人工发本身就是可用路径；
 * 2. 配了 `envKey`（api / webhook / browser 都一样）：升级为 api，`{ready:true, mode:'api'}`；
 *    zhihu 这类「默认浏览器、配了 webhook 就走接口」的渠道正是靠这条；
 * 3. api / webhook 没配 key：`{ready:false, mode:'api'|'webhook', reason:'未配置 XXX'}`；
 * 4. browser 没配 key：`{ready:true, mode:'browser', hint:'需要 Chrome 调试端口'}`；
 * 5. 未知方式：`{ready:false, mode:'unknown', reason}`，不猜。
 *
 * 注意：这里只判断「通道是否可用」，不判断账号是否授权、稿件是否合规——
 * 那两件事必须在真实发布时再校验，不能拿就绪状态当发布许可。
 *
 * @param {object} media 目录条目（或调用方自定义的同类对象）
 * @param {Record<string, string|undefined>} [env={}] 环境变量来源
 * @returns {{ready: boolean, mode: string, hint?: string, reason?: string}}
 */
export function mediaReadiness(media, env = {}) {
  if (!media || typeof media !== 'object') {
    return { ready: false, mode: 'unknown', reason: '渠道不存在' };
  }

  const mode = text(media.publishMode) || 'manual';
  const source = envObject(env);
  const envKey = text(media.envKey);
  const configured = envKey ? envText(source[envKey]) : '';

  // 人工发布不依赖任何密钥，先判定，免得 manual 渠道被下面的 api 分支误伤。
  if (mode === 'manual') return { ready: true, mode: 'manual' };

  if (mode === 'api' || mode === 'webhook' || mode === 'browser') {
    if (configured) return { ready: true, mode: 'api' };
    if (mode === 'browser') return { ready: true, mode: 'browser', hint: BROWSER_HINT };
    return {
      ready: false,
      mode,
      reason: `未配置 ${envKey || '发布密钥'}`,
    };
  }

  return {
    ready: false,
    mode: 'unknown',
    reason: `未知发布方式：${mode}`,
  };
}

/**
 * 估算一轮投放的成本区间。
 *
 * 每条渠道取 `priceMin` / `priceMax` 乘篇数，再整体求和。价格是公开市场经验值估算，
 * 只能用于报价区间，不能当成应付金额；`mixed` 表示这轮里有没有可零成本发布的渠道
 * （价格下限为 0 即算，因为客户可以选择只发免费渠道）。
 *
 * 篇数非法时按 1 处理：报价宁可少算一篇，也不要把 NaN 写进合同。
 *
 * @param {Array<object>} [mediaList=[]] 渠道列表，通常来自 listMedia 的结果
 * @param {object} [options]
 * @param {number} [options.count=1] 每个渠道发几篇，正整数
 * @returns {{
 *   items: Array<{id: string, name: string, count: number, min: number, max: number}>,
 *   totalMin: number, totalMax: number, mixed: boolean
 * }}
 */
export function estimateCost(mediaList = [], { count = 1 } = {}) {
  const list = Array.isArray(mediaList) ? mediaList : [];
  const safeCount =
    typeof count === 'number' && Number.isFinite(count) && count >= 1 ? Math.floor(count) : 1;

  const items = list
    .filter((media) => media && typeof media === 'object')
    .map((media) => ({
      id: text(media.id),
      name: text(media.name) || text(media.id) || '未命名渠道',
      count: safeCount,
      min: price(media.priceMin) * safeCount,
      max: price(media.priceMax) * safeCount,
    }));

  const totalMin = items.reduce((sum, item) => sum + item.min, 0);
  const totalMax = items.reduce((sum, item) => sum + item.max, 0);

  return {
    items,
    totalMin,
    totalMax,
    mixed: items.some((item) => item.min === 0),
  };
}

/**
 * 把渠道列表渲染成 Markdown 表格：渠道 | 类型 | 发布方式 | 单篇成本 | 收录速度 | AI 常引 | 备注。
 *
 * 纯函数：不读环境、不联网，同一输入永远得到同一段文本；空列表返回「暂无渠道」。
 * 单元格里的 `|` 会被转义、换行会被压成空格，避免把报表表格拆坏。
 *
 * 成本列写的是「单篇」区间，不是总额——总额请用 estimateCost，避免读者看串。
 *
 * @param {Array<object>} mediaList 渠道列表
 * @returns {string} Markdown 文本，非空时以换行结尾
 */
export function renderMediaTable(mediaList) {
  const rows = Array.isArray(mediaList)
    ? mediaList.filter((media) => media && typeof media === 'object')
    : [];
  if (rows.length === 0) return '暂无渠道';

  /** 单元格清洗：转义竖线、压平换行，空值统一显示为破折号。 */
  const cell = (value) =>
    String(value ?? '')
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, ' ')
      .trim() || '—';

  /** 成本展示：上下限相同只写一个数，否则写区间。 */
  const cost = (media) => {
    const min = price(media.priceMin);
    const max = price(media.priceMax);
    return min === max ? `¥${min}` : `¥${min}-${max}`;
  };

  const lines = [
    '| 渠道 | 类型 | 发布方式 | 单篇成本 | 收录速度 | AI 常引 | 备注 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];

  for (const media of rows) {
    const name = cell(media.name || media.id || '未命名渠道');
    const type = cell(media.type);
    const mode = cell(MODE_LABELS[text(media.publishMode)] || '未知');
    const speed = cell(SPEED_LABELS[text(media.indexSpeed)] || '未知');
    const cited = media.aiCited === true ? '是' : '否';
    const note = cell(media.note);
    lines.push(`| ${name} | ${type} | ${mode} | ${cost(media)} | ${speed} | ${cited} | ${note} |`);
  }

  return `${lines.join('\n')}\n`;
}
