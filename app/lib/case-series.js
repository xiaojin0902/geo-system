/**
 * lib/case-series.js
 * 「每天一个 GEO 案例」内容工厂：输入行业，输出一整套可直接拍/直接发的案例内容。
 *
 * 为什么单独做：
 *   短视频案例是 GEO 服务商最有效的获客内容（客户看完就知道自己行业能不能做）。
 *   但每期都从零想脚本很慢，而且容易写成硬广。
 *   这里把「行业痛点 → GEO 动作 → 结果口径 → 可执行建议」固化成模板，
 *   一天一条只需要换行业，20 分钟出片。
 *
 * 合规红线（写死在模板里）：
 *   - 不编造客户数字：所有效果都标「示例口径」或留待填占位；
 *   - 不用绝对化用语（最好/第一/保证/100%）；
 *   - 每个案例都附「数据来源：诊断截图」这句，避免空口承诺。
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

/** 行业 → 客户画像与典型问题（让案例像真的） */
const INDUSTRY_PROFILES = Object.freeze({
  家政: {
    customer: '双职工家庭、带娃家庭、老人照护',
    questions: ['家政公司哪家靠谱', '保洁多少钱一小时', '月嫂怎么选', '家政服务包含什么'],
    pains: ['客户只认熟人推荐', '平台抽成高', '服务好但没人知道'],
    channels: ['知乎', '小红书', '公众号'],
    assets: ['本地服务案例', '阿姨资质与培训', '服务范围与价格表'],
  },
  装修: {
    customer: '新房业主、二手房翻新、局部改造',
    questions: ['装修公司怎么选', '半包全包哪个好', '装修大概多少钱一平', '装修避坑'],
    pains: ['客户怕增项', '同行报价混乱', '案例很多但搜不到'],
    channels: ['知乎', '公众号', '百家号'],
    assets: ['施工流程与验收标准', '真实工地照片', '报价明细模板'],
  },
  口腔: {
    customer: '种植牙、正畸、洗牙人群',
    questions: ['种植牙多少钱', '正畸选哪种', '口腔医院哪家好'],
    pains: ['客户先问AI再问医生', '资质说不清', '价格不透明'],
    channels: ['知乎', '公众号', '地方媒体'],
    assets: ['医生资质', '设备与流程', '价格区间说明'],
  },
  教培: {
    customer: 'K12 家长、成人考证',
    questions: ['XX培训哪家好', '课程怎么选', '学费多少'],
    pains: ['家长怕跑路', '效果不可量化', '信息更新慢'],
    channels: ['知乎', '小红书', '公众号'],
    assets: ['师资与资质', '课程大纲', '学员真实反馈'],
  },
});

/** 取行业画像；没登记的行业用通用画像 + 行业名替换 */
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
  };
}

/**
 * 生成一个 GEO 案例内容包。
 * @param {{industry?:string, mode?:'real'|'demo', metrics?:object, brand?:object}} input
 */
export function buildCaseStudy({ industry = '家政', mode = 'demo', metrics = null, brand = {} } = {}) {
  const profile = profileOf(industry);
  const demo = mode !== 'real' || !metrics;
  // 示例口径：明确标注「示例」，绝不冒充真实客户结果
  const m = metrics && !demo
    ? metrics
    : { mentionRateBefore: 0, mentionRateAfter: 25, ownCitationsBefore: 0, ownCitationsAfter: 1, days: 30 };

  const title = `${profile.industry}公司做 GEO，${m.days} 天 AI 开始推荐它`;
  const hook = `${profile.industry}老板别只投本地推广了，客户现在先问豆包`;
  const problem = `客户搜「${profile.questions[0]}」，AI 只提了两三家，没有你——不是服务不行，是 AI 根本不知道你是谁。`;
  const actions = [
    { step: '统一实体信息', detail: `把公司全称、服务范围、区域、价格区间，在官网/工商/地图/社媒写成同一套说法（${profile.assets[0]}）。` },
    { step: '官网变成可抓取', detail: '加 llms.txt、Organization + FAQPage 结构化数据，把客户最常问的 10 个问题做成问答页。' },
    { step: '铺第三方信源', detail: `在${profile.channels.join('、')}发真实服务案例（每篇带时间、地点、服务内容），让 AI 有可引用的第三方依据。` },
  ];
  const resultLine = demo
    ? `示例口径：提及率 ${m.mentionRateBefore}% → ${m.mentionRateAfter}%，自有站点引用 ${m.ownCitationsBefore} → ${m.ownCitationsAfter} 条（30 天）。真实数据以诊断截图为准。`
    : `真实口径：提及率 ${m.mentionRateBefore}% → ${m.mentionRateAfter}%，自有站点引用 ${m.ownCitationsBefore} → ${m.ownCitationsAfter} 条（${m.days} 天）。数据来自诊断截图。`;
  const takeaway = `想不想知道 AI 现在怎么说你的${profile.industry}公司？先做一次诊断，不用改任何东西。`;
  const cta = `评论区打「${profile.industry}」，我发你一份诊断表（含 AI 原话截图）`;
  const hashtags = [`#${profile.industry}`, '#GEO', '#AI搜索', '#豆包', '#本地获客', '#AI运营'];

  const narration = [
    { t: '0-3s', text: hook },
    { t: '3-10s', text: problem },
    { t: '10-18s', text: `我们做了三件事：一，${actions[0].step}；二，${actions[1].step}；三，${actions[2].step}。` },
    { t: '18-28s', text: resultLine },
    { t: '28-38s', text: takeaway },
    { t: '38-45s', text: cta },
  ];
  const shots = [
    { t: '0-3s', shot: '近景·出镜怼脸', caption: hook.slice(0, 18), broll: '办公室/门店实景' },
    { t: '3-10s', shot: '特写·手机录屏', caption: '搜行业词，AI 没提你', broll: '录屏：豆包/DeepSeek 搜索' },
    { t: '10-18s', shot: '中景·出镜口播', caption: '三件事', broll: '白板/字卡' },
    { t: '18-28s', shot: '特写·数据截图', caption: '提及率对比', broll: '诊断截图（打码）' },
    { t: '28-38s', shot: '近景·出镜', caption: '先诊断再动手', broll: '电脑屏幕' },
    { t: '38-45s', shot: '近景·收尾', caption: '评论区打行业名', broll: '手机评论截图' },
  ];

  return {
    industry: profile.industry,
    mode: demo ? 'demo' : 'real',
    title,
    hook,
    problem,
    actions,
    resultLine,
    takeaway,
    cta,
    hashtags,
    coverText: `${profile.industry}做GEO，AI开始推荐`,
    narration,
    shots,
    durationSec: 45,
    platforms: {
      douyin: `前 3 秒说行业词 + 痛点；中段三件事要快；结尾引导评论区打行业名。时长 45s。`,
      xiaohongshu: `封面大字「${profile.industry}做GEO实录」；正文分点写三件事；结尾加「需要诊断表评论区扣1」。`,
      video_account: '开头先抛结果数字，再讲三件事，结尾给诊断入口。',
    },
    compliance: {
      hasAbsoluteWords: false,
      note: demo ? '示例数据，已在文案中标注「示例口径」；对外发布前替换为真实诊断数据。' : '数据来自诊断，发布前建议打码客户信息。',
    },
    generatedAt: new Date().toISOString(),
  };
}

/** 30 天选题日历（每天一个行业，不重复） */
export function buildCasePlan({ days = 30, startDate = new Date() } = {}) {
  const total = Math.max(1, Math.min(CASE_INDUSTRIES.length, Math.round(days)));
  const start = new Date(startDate);
  return CASE_INDUSTRIES.slice(0, total).map((industry, index) => {
    const date = new Date(start.getTime() + index * 86400000);
    return {
      day: index + 1,
      date: date.toISOString().slice(0, 10),
      industry,
      title: `${industry}做 GEO 的第 ${index + 1} 天案例`,
    };
  });
}

/** 渲染成可交给拍摄的 Markdown */
export function renderCaseMarkdown(caseStudy = {}) {
  const lines = [];
  lines.push(`# ${caseStudy.title ?? ''}`, '');
  lines.push(`> 形式：每天一个 GEO 案例 ｜ 行业：${caseStudy.industry} ｜ 时长：${caseStudy.durationSec ?? 45}s ｜ 数据：${caseStudy.mode === 'real' ? '真实' : '示例口径'}`, '');
  lines.push('## 3 秒钩子', '', caseStudy.hook ?? '', '');
  lines.push('## 问题', '', caseStudy.problem ?? '', '');
  lines.push('## 做了哪三件事', '');
  (caseStudy.actions ?? []).forEach((action, index) => {
    lines.push(`${index + 1}. **${action.step}**：${action.detail}`);
  });
  lines.push('');
  lines.push('## 结果', '', caseStudy.resultLine ?? '', '');
  lines.push('## 口播稿', '', '| 时间 | 台词 |', '| --- | --- |');
  for (const item of caseStudy.narration ?? []) lines.push(`| ${item.t} | ${item.text} |`);
  lines.push('');
  lines.push('## 分镜', '', '| 时间 | 景别 | 字幕 | 素材 |', '| --- | --- | --- | --- |');
  for (const shot of caseStudy.shots ?? []) lines.push(`| ${shot.t} | ${shot.shot} | ${shot.caption} | ${shot.broll} |`);
  lines.push('');
  lines.push('## 封面与话题', '');
  lines.push(`- 封面：**${caseStudy.coverText ?? ''}**`);
  lines.push(`- 话题：${(caseStudy.hashtags ?? []).join(' ')}`);
  lines.push('');
  lines.push('## 结尾引导', '', caseStudy.cta ?? '', '');
  lines.push('## 平台注意', '');
  for (const [platform, note] of Object.entries(caseStudy.platforms ?? {})) lines.push(`- **${platform}**：${note}`);
  lines.push('');
  lines.push('## 合规提醒', '', `- ${caseStudy.compliance?.note ?? '发布前核对数据来源'}`, '');
  lines.push(`生成时间：${caseStudy.generatedAt ?? ''}`);
  return `${lines.join('\n')}\n`;
}
