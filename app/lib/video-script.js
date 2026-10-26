/**
 * lib/video-script.js
 * 文章 → 口播短视频脚本（对标摘星AI 的「AI 短视频矩阵」里的脚本层）。
 *
 * 边界说明（避免虚假承诺）：
 *   本模块只产「可拍摄的脚本」——钩子、口播稿、分镜、标题、话题、封面、合规检查。
 *   **不做视频渲染、不做数字人**（那需要外部视频模型/付费服务）。
 *
 * 设计原则：
 *   1) 纯规则、确定性：同输入永远同输出，便于 A/B 与复算；
 *   2) 合规优先：绝对化用语、承诺效果、无来源数字，一律在脚本阶段拦下；
 *   3) 时长可控：段落按 durationSec 均分时间轴，首段必须是钩子。
 */

export const SCRIPT_STYLES = Object.freeze(['口播科普', '避坑清单', '对比测评', '案例复盘', '快问快答']);

const ABSOLUTE_WORDS = ['最好', '第一', '唯一', '顶级', '保证', '100%', '稳赚', '绝对', '永久'];
const PROMISE_PATTERNS = [/保证[^。！？\n]{0,8}(涨粉|有效|效果|排名)/u, /一定[^。！？\n]{0,8}(有效|会火|能火)/u];

const HOOK_TEMPLATES = Object.freeze({
  口播科普: (kw) => `90% 的人不知道${kw}的真相`,
  避坑清单: (kw) => `这 3 个坑，我劝你别踩（${kw}）`,
  对比测评: (kw) => `${kw}到底选哪个？一次讲清`,
  案例复盘: (kw) => `一个客户，我们只改了 3 件事`,
  快问快答: (kw) => `${kw}，到底值不值？`,
});

const PLATFORM_NOTES = Object.freeze({
  douyin: '60 秒内、前 3 秒必须出钩子；字幕大一点；结尾引导评论区提问。',
  xiaohongshu: '30-60 秒、口语化、多分段；封面用大字标题 + 3 个关键词。',
  video_account: '60-90 秒、信息密度高；开头先说结论；适合口播 + 录屏。',
});

const clean = (text) => String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/[#>*`_~]/g, '').replace(/\s+/g, ' ').trim();

/** 模板草稿里的「写作指令占位」不应该进脚本 */
const PLACEHOLDER_PATTERN = /待补|模板模式|结构骨架|本节要点|TODO|（[^）]*待[^）]*）/u;

/** 把正文切成句子，优先保留信息量高的 */
function pickSentences(body, limit) {
  const sentences = clean(body)
    .split(/[。！？!?\n]+/u)
    .map((s) => s.replace(/^[）)\-—\s]+/u, '').trim())
    .filter((s) => s.length >= 10 && !PLACEHOLDER_PATTERN.test(s) && !/^\d+[.、]\s*$/u.test(s));
  const scored = sentences.map((s, index) => {
    let score = 0;
    if (/[0-9０-９]/.test(s)) score += 3;
    if (/怎么|如何|为什么|多少|哪家/u.test(s)) score += 2;
    if (/步骤|方法|标准|建议|区别/u.test(s)) score += 1;
    if (s.length > 80) score -= 1;
    return { s, index, score };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.s);
}

function timeframe(index, total, durationSec) {
  const step = durationSec / Math.max(total, 1);
  const start = Math.round(index * step);
  const end = Math.round((index + 1) * step);
  return `${start}-${end}s`;
}

/**
 * 生成短视频脚本。
 * @param {object} [input]
 * @param {string} [input.title]
 * @param {string} [input.body]
 * @param {object} [input.brief]
 * @param {{name?:string,city?:string}} [input.brand]
 * @param {string} [input.style]
 * @param {number} [input.durationSec]
 */
export function buildVideoScript({
  title = '',
  body = '',
  brief = {},
  brand = {},
  style = '口播科普',
  durationSec = 60,
} = {}) {
  const safeStyle = SCRIPT_STYLES.includes(style) ? style : '口播科普';
  const duration = Math.max(15, Math.min(180, Number(durationSec) || 60));
  const rawKeyword = String(brief?.term ?? brief?.keyword ?? title ?? '这件事')
    .replace(/[：:｜|（）()「」【】]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || '这件事';
  let keyword = rawKeyword.slice(0, 12);
  let hook = HOOK_TEMPLATES[safeStyle](keyword);
  // 钩子超长时先缩关键词，而不是把句子从中间切断
  if (hook.length > 28) {
    keyword = rawKeyword.slice(0, 8);
    hook = HOOK_TEMPLATES[safeStyle](keyword);
  }
  hook = hook.slice(0, 28).replace(/[（(]$/u, '');

  // 段落数量随时长走：15-30s → 3 段；31-60s → 4-5 段；>60s → 6 段
  const segments = duration <= 30 ? 3 : duration <= 60 ? 5 : 6;
  const picked = pickSentences(body, segments - 1);

  const brandLine = [brand?.name, brand?.city].filter(Boolean).join('，');
  const narrationSource = [
    hook,
    ...picked,
    brandLine && !picked.some((s) => s.includes(String(brand.name))) ? `${brandLine}做的就是这个。` : '',
  ].filter(Boolean);

  // 段落过多时合并尾部，保证时间轴清晰
  const merged = [];
  for (const text of narrationSource) {
    merged.push(text.length > 70 ? `${text.slice(0, 68)}…` : text);
  }
  while (merged.length > segments) {
    const last = merged.pop();
    merged[merged.length - 1] = `${merged[merged.length - 1]} ${last}`.slice(0, 70);
  }

  const narration = merged.map((text, index) => ({
    t: timeframe(index, merged.length, duration),
    text: String(text).replace(/^[）)\-—，,。\s]+/u, '').trim(),
  }));

  const shotCycle = [
    { shot: '近景 · 出镜口播', broll: '纯色背景/办公室实景' },
    { shot: '中景 · 边说边比手势', broll: '工作场景实拍' },
    { shot: '特写 · 手机录屏/截图', broll: '产品页、数据截图' },
    { shot: '近景 · 出镜口播', broll: '案例画面' },
    { shot: '特写 · 关键结论字卡', broll: '结论字幕动效' },
    { shot: '中景 · 收尾+引导', broll: '账号主页/联系方式' },
  ];
  const shots = narration.map((item, index) => ({
    t: item.t,
    shot: shotCycle[index % shotCycle.length].shot,
    caption: item.text.slice(0, 18),
    broll: shotCycle[index % shotCycle.length].broll,
  }));

  const titleOptions = [
    `${keyword}，90%的人做错了`,
    `${keyword}怎么做？3步讲清`,
    `${keyword}避坑指南`,
    `别再瞎做${keyword}了`,
  ]
    .map((t) => t.slice(0, 18))
    .filter((t, i, arr) => arr.indexOf(t) === i)
    .slice(0, 4);

  const hashtags = ['#' + keyword.replace(/\s+/g, ''), '#内容运营', '#GEO', '#AI搜索', '#品牌增长', '#创业', '#干货']
    .filter((t, i, arr) => arr.indexOf(t) === i)
    .slice(0, 7);

  const coverText = `${keyword}`.slice(0, 12);

  const fullText = `${title} ${body} ${narration.map((n) => n.text).join(' ')}`;
  const issues = [];
  const hitWords = ABSOLUTE_WORDS.filter((word) => fullText.includes(word));
  if (hitWords.length) issues.push(`出现绝对化用语：${hitWords.join('、')}（改用可核实表述）`);
  for (const pattern of PROMISE_PATTERNS) {
    const hit = fullText.match(pattern);
    if (hit) issues.push(`出现效果承诺：${hit[0]}（不要承诺涨粉/效果）`);
  }
  if (/[0-9０-９]+\s*[%％]/u.test(clean(body)) && !/https?:\/\//u.test(body) && !/来源[:：]/u.test(body)) {
    issues.push('出现百分比数字但没有来源链接（补「来源：xxx」或删掉百分比）');
  }

  return {
    title: String(title ?? '').slice(0, 60),
    style: safeStyle,
    durationSec: duration,
    hook,
    narration,
    shots,
    titleOptions,
    hashtags,
    coverText,
    compliance: { passed: issues.length === 0, issues },
    platformNotes: { ...PLATFORM_NOTES },
  };
}

/** 渲染成可交给拍摄/剪辑的 Markdown。 */
export function renderVideoScriptMarkdown(script = {}) {
  const lines = [];
  lines.push(`## 标题`, '', script.title || '（无标题）', '');
  lines.push(`## 3 秒钩子`, '', `> ${script.hook ?? ''}`, '');
  lines.push(`## 口播稿（${script.durationSec ?? 60} 秒 · ${script.style ?? ''}）`, '');
  lines.push('| 时间 | 台词 |', '| --- | --- |');
  for (const item of script.narration ?? []) lines.push(`| ${item.t} | ${item.text} |`);
  lines.push('');
  lines.push('## 分镜', '');
  lines.push('| 时间 | 景别/动作 | 字幕 | 素材建议 |', '| --- | --- | --- | --- |');
  for (const shot of script.shots ?? []) {
    lines.push(`| ${shot.t} | ${shot.shot} | ${shot.caption} | ${shot.broll} |`);
  }
  lines.push('');
  lines.push('## 标题备选', '');
  for (const t of script.titleOptions ?? []) lines.push(`- ${t}`);
  lines.push('');
  lines.push('## 话题标签', '', (script.hashtags ?? []).join(' '), '');
  lines.push('## 封面文案', '', `**${script.coverText ?? ''}**`, '');
  lines.push('## 合规检查', '');
  if (script.compliance?.passed) lines.push('- 通过：未发现绝对化用语、效果承诺与无来源数字。');
  else for (const issue of script.compliance?.issues ?? []) lines.push(`- ⚠️ ${issue}`);
  lines.push('');
  lines.push('## 平台注意', '');
  for (const [key, note] of Object.entries(script.platformNotes ?? {})) lines.push(`- **${key}**：${note}`);
  return `${lines.join('\n')}\n`;
}
