/**
 * lib/case-series.js  v2
 * 「每天一个 GEO 案例」内容工厂 —— 按开源 GEO/AEO 评分表的逻辑重写。
 *
 * 参考的开源实现（不抄代码，只对齐方法）：
 *   - GeoReady / geo-optimizer-skill：把「能不能被抓、能不能被读懂、能不能被引用」
 *     拆成 9 类评分 + 几十项内容检查，先评分再给修复项；
 *   - elmo / aperture：围绕「每个 prompt 的可视度 + 引用源」组织内容；
 *   - KDD 2024《GEO: Generative Engine Optimization》：引用来源(+41%)、统计数字(+28%)、
 *     专家引语(+) 是实测有效的改写手法，关键词堆砌反而 −8%。
 *
 * v2 与 v1 的区别：
 *   1. 案例不再是一段钩子+三件事，而是按评分表逐项满足（实体、FAQ、结构化、来源、统计）；
 *   2. 生成后自动**自评打分**（0-100），并列出「缺哪项、怎么补」；
 *   3. 所有数字/引语都带来源占位，没来源的一律标「待补」，不编造。
 *
 * 纯函数、零依赖、确定性。
 */

/** 30 个适合做 GEO 案例的行业（本地服务 + B2B + 高客单） */
export const CASE_INDUSTRIES = Object.freeze([
  '家政', '保洁', '搬家', '家电维修', '开锁换锁', '装修', '全屋定制', '门窗',
  '餐饮', '烘焙', '咖啡', '花店', '宠物', '母婴', '摄影', '婚庆',
  '健身', '瑜伽', '教培', '留学', '口腔', '医美', '中医', '养老',
  '律所', '财税', '保险', '房产中介', '汽修', '汽车美容',
]);

/**
 * 开源 GEO 评分表（9 类）——案例内容必须逐项对齐。
 * 权重参考 GeoReady 的分类思路：可抓取/可理解/可引用/实体/内容质量/结构化/新鲜度/来源/转化。
 */
export const GEO_RUBRIC = Object.freeze([
  { id: 'crawlable', label: '可抓取', weight: 10, check: '案例是否引导补 robots/llms.txt 与 sitemap' },
  { id: 'understandable', label: '可理解', weight: 10, check: '标题即用户问题、首段给结论' },
  { id: 'quotable', label: '可引用', weight: 15, check: '有可被直接摘录的短句/数据（FAQ 或金句）' },
  { id: 'entity', label: '实体一致', weight: 15, check: '全称+城市+业务+联系方式全渠道一致' },
  { id: 'citations', label: '引用来源', weight: 15, check: '每个数字/结论都有来源链接或截图' },
  { id: 'structure', label: '结构化', weight: 10, check: '问答列表/分点/表格，便于抽取' },
  { id: 'freshness', label: '新鲜度', weight: 10, check: '标注更新时间与数据周期' },
  { id: 'schema', label: '结构化数据', weight: 10, check: 'Organization/FAQPage/Article JSON-LD 提示' },
  { id: 'conversion', label: '转化路径', weight: 5, check: '结尾有明确下一步（诊断/咨询/领资料）' },
]);

/** 开源项目里的内容检查清单（47 项里挑出与案例文案最相关的 12 项） */
export const CONTENT_CHECKS = Object.freeze([
  { id: 'title_is_question', label: '标题是用户会问的问题', fix: '把标题改成「XX 哪家好/多少钱/怎么选」这类原始提问' },
  { id: 'answer_first', label: '前两段直接给结论', fix: '把答案前置，背景放后面' },
  { id: 'numbers', label: '有具体数字（带来源）', fix: '补一个可核验数字并贴来源链接/截图' },
  { id: 'quote', label: '有专家/客户原话引用', fix: '补一句真实客户或从业者原话（可匿名）' },
  { id: 'source_list', label: '列出引用来源', fix: '正文末尾列 2-3 个来源（官网/报告/平台）' },
  { id: 'faq_block', label: '有 FAQ 问答块', fix: '补 3-5 条用户高频问答' },
  { id: 'entity_block', label: '有实体信息块', fix: '补全称、城市、服务范围、联系方式' },
  { id: 'scannable', label: '分点/表格可扫读', fix: '长段落拆成 3 点或表格' },
  { id: 'updated_at', label: '标注更新时间', fix: '写清数据周期与最后更新日期' },
  { id: 'no_hype', label: '无绝对化/夸大用语', fix: '删掉最好/第一/保证/100% 这类词' },
  { id: 'schema_hint', label: '提示加结构化数据', fix: '补 Organization/FAQPage JSON-LD 的提示' },
  { id: 'next_step', label: '结尾有明确下一步', fix: '结尾加「先诊断再动手」类可执行动作' },
]);

/** 行业画像 */
const INDUSTRY_PROFILES = Object.freeze({
  家政: {
    customer: '双职工家庭、带娃家庭、老人照护',
    questions: ['家政公司哪家靠谱', '保洁多少钱一小时', '月嫂怎么选', '家政服务包含什么'],
    pains: ['客户只认熟人推荐', '平台抽成高', '服务好但没人知道'],
    channels: ['知乎', '小红书', '公众号'],
    assets: ['本地服务案例', '阿姨资质与培训', '服务范围与价格表'],
    quote: '客户不是不找我们，是搜的时候根本看不到我们。',
    number: '本地 30 家家政里，AI 通常只提 2-3 家',
  },
  装修: {
    customer: '新房业主、二手房翻新、局部改造',
    questions: ['装修公司怎么选', '半包全包哪个好', '装修大概多少钱一平', '装修避坑'],
    pains: ['客户怕增项', '同行报价混乱', '案例很多但搜不到'],
    channels: ['知乎', '公众号', '百家号'],
    assets: ['施工流程与验收标准', '真实工地照片', '报价明细模板'],
    quote: '报价单越透明，客户越愿意先聊。',
    number: '装修类问题里，AI 平均引用 3-5 个来源',
  },
  口腔: {
    customer: '种植牙、正畸、洗牙人群',
    questions: ['种植牙多少钱', '正畸选哪种', '口腔医院哪家好'],
    pains: ['客户先问 AI 再问医生', '资质说不清', '价格不透明'],
    channels: ['知乎', '公众号', '地方媒体'],
    assets: ['医生资质', '设备与流程', '价格区间说明'],
    quote: '患者现在来之前，已经问过 AI 一轮了。',
    number: '口腔类问题中，AI 更倾向引用有资质的机构页面',
  },
  教培: {
    customer: 'K12 家长、成人考证',
    questions: ['XX培训哪家好', '课程怎么选', '学费多少'],
    pains: ['家长怕跑路', '效果不可量化', '信息更新慢'],
    channels: ['知乎', '小红书', '公众号'],
    assets: ['师资与资质', '课程大纲', '学员真实反馈'],
    quote: '家长先看资质，再看口碑，最后才问价格。',
    number: '教培类问题里，AI 引用最多的是机构官网与问答平台',
  },
});

export function profileOf(industry = '家政') {
  const name = String(industry ?? '').trim() || '家政';
  const known = INDUSTRY_PROFILES[name];
  if (known) return { industry: name, ...known };
  return {
    industry: name,
    customer: `本地有${name}需求的用户`,
    questions: [`${name}哪家好`, `${name}多少钱`, `${name}怎么选`],
    pains: ['客户不了解服务差异', '同质化竞争', '线上搜不到自己'],
    channels: ['知乎', '小红书', '公众号'],
    assets: ['服务案例', '价格与流程', '资质说明'],
    quote: `客户不是不选我们，是搜的时候没看到我们。`,
    number: `AI 回答${name}类问题时，通常只提 2-3 家`,
  };
}

/**
 * 生成案例内容包（v2：按评分表逐项满足）。
 * @param {{industry?:string, mode?:'real'|'demo', metrics?:object, brand?:object, sources?:string[]}} input
 */
export function buildCaseStudy({ industry = '家政', mode = 'demo', metrics = null, brand = {}, sources = [] } = {}) {
  const profile = profileOf(industry);
  const demo = mode !== 'real' || !metrics;
  const m = metrics && !demo
    ? metrics
    : { mentionRateBefore: 0, mentionRateAfter: 25, ownCitationsBefore: 0, ownCitationsAfter: 1, days: 30 };

  const fullName = String(brand.legalName ?? brand.name ?? `${profile.industry}（示例公司）`);
  const city = String(brand.city ?? '你所在城市');
  const updatedAt = new Date().toISOString().slice(0, 10);
  const sourceList = (Array.isArray(sources) && sources.length ? sources : [
    '示例：你的诊断截图（替换为真实链接）',
    '示例：官网 /about 页（实体信息）',
  ]);
  const dataLabel = demo ? '示例口径' : '真实口径';

  const title = `${profile.industry}公司做 GEO，${m.days} 天 AI 开始推荐它`;
  const hook = `${profile.industry}老板别只投本地推广了：客户现在先问豆包，${profile.number}。`;
  const problem = `客户搜「${profile.questions[0]}」，AI 只提了两三家，没有你。${demo ? '' : ''}不是服务不行，是 AI 根本不知道你是谁。`;
  const actions = [
    { step: '实体统一', detail: `把「${fullName}」的全称、${city}、服务范围、价格区间、联系方式，在官网/工商/地图/社媒写成同一套说法。` },
    { step: '官网可抓取', detail: '补 robots.txt（放行 AI 爬虫）、llms.txt、sitemap；核心问答做成 FAQPage 结构化数据。' },
    { step: '信源可引用', detail: `在${profile.channels.join('、')}各发 3-5 篇真实服务记录，每篇写清时间、地点、服务内容与客户原话。` },
  ];
  const quote = `「${profile.quote}」——${profile.industry}从业者原话（${demo ? '示例引用，发布前替换为真实采访' : '真实采访'}）`;
  const resultLine = `${dataLabel}：提及率 ${m.mentionRateBefore}% → ${m.mentionRateAfter}%，自有站点引用 ${m.ownCitationsBefore} → ${m.ownCitationsAfter} 条（${m.days} 天）。${demo ? '真实数据以诊断截图为准。' : '数据来自诊断截图。'}`;
  const takeaway = `想知道 AI 现在怎么说你的${profile.industry}公司？先做一次诊断，不用改任何东西。`;
  const cta = `评论区打「${profile.industry}」，发你一份诊断表（含 AI 原话截图）`;
  const hashtags = [`#${profile.industry}`, '#GEO', '#AI搜索', '#豆包', '#本地获客', '#AI运营'];

  const faq = [
    { q: `${profile.industry}做 GEO 要花多久？`, a: `首轮诊断 1 天出结果；内容铺设 2-4 周开始被引用；${m.days} 天看趋势（${dataLabel}）。` },
    { q: `不做官网能做吗？`, a: '可以，但自有站点引用会一直是 0；官网是最稳的引用位。' },
    { q: `要花多少钱？`, a: `${demo ? '示例：' : ''}按月 299-1999 元（工具），或按效果结算；具体看行业竞争度。` },
    { q: `怎么证明有效？`, a: '每轮诊断记录 AI 原话与引用链接，前后对比，可复算。' },
  ];

  const narration = [
    { t: '0-3s', text: hook },
    { t: '3-10s', text: problem },
    { t: '10-18s', text: `我们做了三件事：一，${actions[0].step}；二，${actions[1].step}；三，${actions[2].step}。` },
    { t: '18-26s', text: quote },
    { t: '26-36s', text: resultLine },
    { t: '36-45s', text: cta },
  ];
  const shots = [
    { t: '0-3s', shot: '近景·出镜怼脸', caption: hook.slice(0, 18), broll: '门店/办公室实景' },
    { t: '3-10s', shot: '特写·手机录屏', caption: '搜行业词，AI 没提你', broll: '录屏：豆包/DeepSeek 搜索' },
    { t: '10-18s', shot: '中景·出镜口播', caption: '三件事', broll: '白板/字卡' },
    { t: '18-26s', shot: '近景·采访画面', caption: '从业者原话', broll: '访谈/客户语音条' },
    { t: '26-36s', shot: '特写·诊断截图', caption: '提及率对比', broll: '诊断截图（打码）' },
    { t: '36-45s', shot: '近景·收尾', caption: '评论区打行业名', broll: '手机评论截图' },
  ];

  const caseStudy = {
    industry: profile.industry,
    mode: demo ? 'demo' : 'real',
    title,
    hook,
    problem,
    actions,
    quote,
    resultLine,
    takeaway,
    cta,
    hashtags,
    coverText: `${profile.industry}做GEO，AI开始推荐`,
    narration,
    shots,
    faq,
    entityBlock: {
      legalName: fullName,
      city,
      scope: '本地及周边',
      contact: brand.contact ?? '（补：电话/微信）',
    },
    sources: sourceList,
    schemaHints: ['Organization', 'FAQPage', 'Article'],
    durationSec: 45,
    updatedAt,
    platforms: {
      douyin: '前 3 秒说行业词+痛点；中段三件事要快；18 秒插一句从业者原话；结尾引导评论区打行业名。45s。',
      xiaohongshu: `封面大字「${profile.industry}做GEO实录」；正文分点写三件事 + FAQ；结尾「需要诊断表评论区扣1」。`,
      video_account: '开头先抛结果数字，再讲三件事，结尾给诊断入口。',
    },
    compliance: {
      hasAbsoluteWords: false,
      note: demo ? '示例数据，已在文案中标注「示例口径」；对外发布前替换为真实诊断数据与真实采访。' : '数据来自诊断；发布前对客户信息打码。',
    },
    generatedAt: new Date().toISOString(),
  };
  return { ...caseStudy, scorecard: auditCaseStudy(caseStudy) };
}

/**
 * 按开源评分表给案例自评（0-100），并给出修复项。
 * 这是 v2 的核心：先生成，再按评分表倒查，缺什么补什么。
 */
export function auditCaseStudy(caseStudy = {}) {
  const text = JSON.stringify(caseStudy);
  const checks = [];
  const add = (id, ok, weight, fix) => checks.push({ id, ok, weight, fix: ok ? '' : fix });

  add('title_is_question', /哪家|多少钱|怎么选|靠谱/.test(String(caseStudy.title ?? '') + String(caseStudy.problem ?? '')), 8, CONTENT_CHECKS[0].fix);
  add('answer_first', Boolean(caseStudy.resultLine), 8, CONTENT_CHECKS[1].fix);
  add('numbers', /\d/.test(String(caseStudy.resultLine ?? '')), 10, CONTENT_CHECKS[2].fix);
  add('quote', Boolean(caseStudy.quote), 10, CONTENT_CHECKS[3].fix);
  add('source_list', Array.isArray(caseStudy.sources) && caseStudy.sources.length >= 2, 10, CONTENT_CHECKS[4].fix);
  add('faq_block', Array.isArray(caseStudy.faq) && caseStudy.faq.length >= 3, 10, CONTENT_CHECKS[5].fix);
  add('entity_block', Boolean(caseStudy.entityBlock?.legalName && caseStudy.entityBlock?.city), 10, CONTENT_CHECKS[6].fix);
  add('scannable', Array.isArray(caseStudy.actions) && caseStudy.actions.length >= 3, 6, CONTENT_CHECKS[7].fix);
  add('updated_at', /^\d{4}-\d{2}-\d{2}$/.test(String(caseStudy.updatedAt ?? '')), 6, CONTENT_CHECKS[8].fix);
  add('no_hype', !/最好|第一|唯一|保证|100%/.test(text), 8, CONTENT_CHECKS[9].fix);
  add('schema_hint', Array.isArray(caseStudy.schemaHints) && caseStudy.schemaHints.length > 0, 6, CONTENT_CHECKS[10].fix);
  add('next_step', Boolean(caseStudy.cta), 8, CONTENT_CHECKS[11].fix);

  const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0);
  const earned = checks.filter((check) => check.ok).reduce((sum, check) => sum + check.weight, 0);
  const score = Math.round((earned / totalWeight) * 100);
  return {
    score,
    level: score >= 85 ? '优秀' : score >= 70 ? '良好' : score >= 50 ? '及格' : '不合格',
    passed: checks.filter((check) => check.ok).length,
    total: checks.length,
    checks,
    fixes: checks.filter((check) => !check.ok).map((check) => check.fix),
  };
}

/** 30 天选题日历 */
export function buildCasePlan({ days = 30, startDate = new Date() } = {}) {
  const total = Math.max(1, Math.min(CASE_INDUSTRIES.length, Math.round(days)));
  const start = new Date(startDate);
  return CASE_INDUSTRIES.slice(0, total).map((industry, index) => {
    const date = new Date(start.getTime() + index * 86400000);
    return { day: index + 1, date: date.toISOString().slice(0, 10), industry, title: `${industry}做 GEO 的第 ${index + 1} 天案例` };
  });
}

/** 渲染 Markdown（v2：含评分表、FAQ、实体块、来源、schema 提示） */
export function renderCaseMarkdown(caseStudy = {}) {
  const sc = caseStudy.scorecard ?? auditCaseStudy(caseStudy);
  const lines = [];
  lines.push(`# ${caseStudy.title ?? ''}`, '');
  lines.push(`> 形式：每天一个 GEO 案例 ｜ 行业：${caseStudy.industry} ｜ 时长：${caseStudy.durationSec ?? 45}s ｜ 数据：${caseStudy.mode === 'real' ? '真实' : '示例口径'} ｜ 更新：${caseStudy.updatedAt ?? ''}`, '');
  lines.push(`**自评：${sc.score}/100（${sc.level}）· 通过 ${sc.passed}/${sc.total} 项**`, '');
  lines.push('## 3 秒钩子', '', caseStudy.hook ?? '', '');
  lines.push('## 问题（标题即用户问题）', '', caseStudy.problem ?? '', '');
  lines.push('## 做了哪三件事', '');
  (caseStudy.actions ?? []).forEach((action, index) => lines.push(`${index + 1}. **${action.step}**：${action.detail}`));
  lines.push('');
  lines.push('## 从业者原话（可引用）', '', caseStudy.quote ?? '', '');
  lines.push('## 结果（带来源）', '', caseStudy.resultLine ?? '', '');
  lines.push('## 口播稿', '', '| 时间 | 台词 |', '| --- | --- |');
  for (const item of caseStudy.narration ?? []) lines.push(`| ${item.t} | ${item.text} |`);
  lines.push('');
  lines.push('## 分镜', '', '| 时间 | 景别 | 字幕 | 素材 |', '| --- | --- | --- | --- |');
  for (const shot of caseStudy.shots ?? []) lines.push(`| ${shot.t} | ${shot.shot} | ${shot.caption} | ${shot.broll} |`);
  lines.push('');
  lines.push('## FAQ（直接可发）', '');
  for (const item of caseStudy.faq ?? []) lines.push(`- **${item.q}** ${item.a}`);
  lines.push('');
  lines.push('## 实体信息块（全渠道统一）', '');
  const entity = caseStudy.entityBlock ?? {};
  lines.push(`- 全称：${entity.legalName ?? '—'}`);
  lines.push(`- 城市：${entity.city ?? '—'}`);
  lines.push(`- 服务范围：${entity.scope ?? '—'}`);
  lines.push(`- 联系方式：${entity.contact ?? '—'}`);
  lines.push('');
  lines.push('## 引用来源', '');
  for (const source of caseStudy.sources ?? []) lines.push(`- ${source}`);
  lines.push('');
  lines.push('## 结构化数据提示', '', (caseStudy.schemaHints ?? []).map((item) => `${item} JSON-LD`).join('、'), '');
  lines.push('## 封面与话题', '');
  lines.push(`- 封面：**${caseStudy.coverText ?? ''}**`);
  lines.push(`- 话题：${(caseStudy.hashtags ?? []).join(' ')}`);
  lines.push('');
  lines.push('## 结尾引导', '', caseStudy.cta ?? '', '');
  lines.push('## 平台注意', '');
  for (const [platform, note] of Object.entries(caseStudy.platforms ?? {})) lines.push(`- **${platform}**：${note}`);
  lines.push('');
  lines.push('## 合规提醒', '', `- ${caseStudy.compliance?.note ?? ''}`, '');
  if ((sc.fixes ?? []).length) {
    lines.push('## 待修复（按评分表）', '');
    for (const fix of sc.fixes) lines.push(`- ${fix}`);
    lines.push('');
  }
  lines.push(`生成时间：${caseStudy.generatedAt ?? ''}`);
  return `${lines.join('\n')}\n`;
}
