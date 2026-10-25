/**
 * article-contracts.js —— 文章合同三件套（篇幅 / 客户存在感 / 标题治理）
 *
 * 对应 OmniRank 的三组规则，这里压成一份纯规则实现：
 * - 篇幅合同（article_length_contract.py）：字数边界决定「这一稿能不能发」；
 * - 客户存在感（client_presence_policy.py）：品牌被提到的次数与位置；
 * - 标题治理（title_promise_gate / title_jargon_blacklist / title_batch_dedupe /
 *   title_keyword_alignment）：承诺词、绝对化、重复、意图、标题党。
 *
 * 设计约束：
 * - 零依赖、纯函数：同一输入永远同一输出，不读文件、不查库、不调模型；
 * - 只做判定与建议，不改写正文：fixes 给的是「动作」，不是替换后的文本；
 * - 阻断（blocker）只留给「发出去会出事」的项：字数越界、品牌缺席、
 *   承诺词 / 绝对化 / 重复标题；其余一律进提醒（warn），避免把风格偏好变成硬门。
 */

/**
 * 篇幅合同（中文字符，按去空白后的字符数计）。
 *
 * 为什么上下限都要有？（本文件最容易被改坏的地方，改之前先读完）
 * - 只有下限：模型会用「综上所述 / 众所周知」把句子拉长凑字，
 *   注水会稀释可抽取答案的密度，篇幅变长反而更难被引用；
 * - 只有上限：短稿会把「直接答案 / 判断依据 / 适用边界」整块省掉，
 *   读者拿不到完整决策信息，等于没写；
 * - 所以 min/max 是硬边界（越界即阻断），idealMin/idealMax 是交付目标带
 *   （偏短/偏长只提醒，不阻断）：1200 字大约刚好放下「直接答案 + 3 个判断维度
 *   + 交付边界」，1800-3000 是这类选题信息密度最高的一段，
 *   4500 以上基本只能靠重复结论和堆关键词凑，收益为负。
 */
export const LENGTH_CONTRACT = Object.freeze({
  min: 1200,
  max: 4500,
  idealMin: 1800,
  idealMax: 3000,
});

/**
 * 标题治理规则。
 *
 * 分三类，对应两种处置：
 * - 承诺词（保证/一定/100%/立刻/马上/永久/绝无）：效果无法承诺，
 *   属于广告法意义上的不实表示 → blocker；
 * - 黑名单（最好/第一/唯一/顶级/稳赚/绝对）：绝对化用语，广告法第九条 → blocker；
 * - 标题党（揭秘/震惊/必看）：不违规但读者与 AI 摘要都不认 → warn。
 *
 * 刻意用「词表 + 等级表」而不是正则：规则可被测试逐词遍历，
 * 也方便后来的人只加词、不改判定逻辑。
 */
export const TITLE_RULES = Object.freeze({
  maxLength: 30,
  promiseWords: Object.freeze(['保证', '一定', '100%', '立刻', '马上', '永久', '绝无']),
  blacklistWords: Object.freeze(['最好', '第一', '唯一', '顶级', '稳赚', '绝对']),
  clickbaitWords: Object.freeze(['揭秘', '震惊', '必看']),
  levels: Object.freeze({
    length: 'blocker',
    promise: 'blocker',
    blacklist: 'blocker',
    duplicate: 'blocker',
    intent: 'warn',
    clickbait: 'warn',
  }),
});

// ---------------------------------------------------------------------------
// 内部工具：字数、品牌名、标题归一化
// ---------------------------------------------------------------------------

/** 统一字数口径：去掉全部空白（含全角空格、换行）后的字符数 */
function countChars(text) {
  return Array.from(String(text ?? '').replace(/\s+/g, '')).length;
}

/** 文件名/正文匹配用的紧凑化：去空白，全角百分号折成半角 */
function compactText(text) {
  return String(text ?? '')
    .replace(/\s+/g, '')
    .replace(/％/g, '%');
}

/** 品牌配置允许直接传字符串，便于 CLI/测试临时使用 */
function brandSource(brand) {
  if (typeof brand === 'string') return { name: brand };
  if (brand && typeof brand === 'object') return brand;
  return {};
}

/**
 * 收集品牌名：name / legalName / aliases，去空白后按字面去重。
 * 返回「最长优先」的顺序 —— 全称先匹配，短名才不会把同一处重复计一次。
 */
function brandNames(brand) {
  const source = brandSource(brand);
  const raw = [];
  if (typeof source.name === 'string') raw.push(source.name);
  if (typeof source.legalName === 'string') raw.push(source.legalName);
  if (Array.isArray(source.aliases)) {
    for (const alias of source.aliases) {
      if (typeof alias === 'string') raw.push(alias);
    }
  }
  const seen = new Set();
  const names = [];
  for (const item of raw) {
    const name = compactText(item);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

/** 展示用品牌名：优先 name，其次 legalName，最后第一个别名 */
function displayBrandName(brand) {
  const source = brandSource(brand);
  const candidates = [source.name, source.legalName];
  if (Array.isArray(source.aliases)) candidates.push(...source.aliases);
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

/**
 * 统计提及次数：按「最长优先」逐轮替换成哨兵字符，
 * 于是「芜湖恒野数字科技有限公司」只算 1 次，不会被「恒野」再计一次。
 */
function countMentions(text, names) {
  let rest = compactText(text);
  let total = 0;
  for (const name of names) {
    let index = rest.indexOf(name);
    while (index !== -1) {
      total += 1;
      rest = `${rest.slice(0, index)}${'\u0000'.repeat(name.length)}${rest.slice(index + name.length)}`;
      index = rest.indexOf(name, index + name.length);
    }
  }
  return total;
}

/**
 * 首段：第一个非空、且不是「纯标题行」的段落。
 * 正文以「# 标题」开头是常态，标题块不能算首段，否则首段命中会永远为 false。
 */
function firstParagraph(body) {
  const blocks = String(body ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    if (lines.every((line) => /^#{1,6}\s/.test(line))) continue;
    return compactText(lines.join(''));
  }
  return '';
}

/** 标题归一化：去空白、去标点、转小写，用于「是否重复」的精确比对 */
function normalizeTitle(text) {
  return compactText(text)
    .replace(/[，。！？、；：,.!?;:'"“”‘’（）()【】\[\]《》〈〉<>「」『』—–\-_/\\|·…~^*#@&+=]+/g, '')
    .toLowerCase();
}

/** 标题字数：按码位计，避免把 emoji 之类算成两个字 */
function titleLength(title) {
  return Array.from(String(title ?? '').trim()).length;
}

/** 在标题里命中哪些词（空白与全角百分号已归一化） */
function hitWords(text, words) {
  const haystack = compactText(text).toLowerCase();
  return words.filter((word) => haystack.includes(compactText(word).toLowerCase()));
}

/** 收集 brief 里的意图锚点：term 优先，keywords 支持字符串 / { term } / { text } */
function briefAnchors(brief) {
  const source = brief && typeof brief === 'object' ? brief : {};
  const anchors = [];
  const push = (value) => {
    if (typeof value !== 'string') return;
    const text = value.trim();
    if (text.length >= 2) anchors.push(text);
  };
  push(source.term);
  if (Array.isArray(source.keywords)) {
    for (const item of source.keywords) {
      if (typeof item === 'string') push(item);
      else if (item && typeof item === 'object') {
        push(item.term);
        push(item.text);
      }
    }
  } else if (typeof source.keywords === 'string') {
    push(source.keywords);
  }
  return [...new Set(anchors)];
}

/**
 * 双字覆盖率：给「缩写/改写但仍是同一个生意对象」留一条活路，
 * 例如 term「芜湖内容代运营」对标题「内容代运营怎么选」覆盖 4/6 ≈ 0.67。
 */
function bigramCoverage(anchor, haystack) {
  const chars = Array.from(compactText(anchor).toLowerCase());
  if (chars.length < 2) return haystack.includes(chars.join('')) ? 1 : 0;
  let hit = 0;
  for (let i = 0; i < chars.length - 1; i += 1) {
    if (haystack.includes(`${chars[i]}${chars[i + 1]}`)) hit += 1;
  }
  return hit / (chars.length - 1);
}

/** 找重复标题：归一化后完全一致即算重复，返回命中的原始标题 */
function findDuplicate(title, existingTitles) {
  const target = normalizeTitle(title);
  if (!target) return '';
  const list = Array.isArray(existingTitles) ? existingTitles : [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    if (normalizeTitle(item) === target) return item.trim();
  }
  return '';
}

// ---------------------------------------------------------------------------
// 篇幅合同
// ---------------------------------------------------------------------------

/** 五档：过短 / 偏短 / 合规 / 偏长 / 过长（边界对齐 LENGTH_CONTRACT） */
function lengthLevel(chars) {
  const { min, max, idealMin, idealMax } = LENGTH_CONTRACT;
  if (chars < min) return '过短';
  if (chars < idealMin) return '偏短';
  if (chars <= idealMax) return '合规';
  if (chars <= max) return '偏长';
  return '过长';
}

/** 每档都给可执行的信息：当前字数、差多少、目标区间 */
function lengthMessage(chars, level) {
  const { min, max, idealMin, idealMax } = LENGTH_CONTRACT;
  if (level === '过短') {
    return `正文 ${chars} 字，低于篇幅下限 ${min} 字，还差 ${min - chars} 字。`;
  }
  if (level === '偏短') {
    return `正文 ${chars} 字，已过下限 ${min} 字但未到理想下限 ${idealMin} 字，建议再补 ${idealMin - chars} 字。`;
  }
  if (level === '合规') {
    return `正文 ${chars} 字，落在理想区间 ${idealMin}-${idealMax} 字。`;
  }
  if (level === '偏长') {
    return `正文 ${chars} 字，超过理想上限 ${idealMax} 字但仍在合同上限 ${max} 字内，建议精简 ${chars - idealMax} 字。`;
  }
  return `正文 ${chars} 字，超过合同上限 ${max} 字，超出 ${chars - max} 字。`;
}

/**
 * 检查篇幅。
 *
 * ok 的含义是「落在硬边界 [min, max] 内」：偏短/偏长仍可发，只进提醒；
 * 过短/过长才是阻断 —— 这两种发出去一定损质量（缺整块信息 / 靠注水撑长）。
 *
 * @param {{body?: string}} [params]
 * @returns {{ok: boolean, chars: number, level: '过短'|'偏短'|'合规'|'偏长'|'过长', message: string}}
 */
export function checkLength({ body = '' } = {}) {
  const chars = countChars(body);
  const level = lengthLevel(chars);
  const ok = chars >= LENGTH_CONTRACT.min && chars <= LENGTH_CONTRACT.max;
  return { ok, chars, level, message: lengthMessage(chars, level) };
}

// ---------------------------------------------------------------------------
// 客户存在感
// ---------------------------------------------------------------------------

/**
 * 检查客户存在感：品牌在正文里提了几次、首段有没有、标题有没有。
 *
 * 通过条件只有两条（合同原文）：正文提及 ≥ 3 次，且首段命中。
 * 标题命中不算进 ok —— 标题未带品牌只由 applyContracts 记一条提醒，
 * 避免「标题里塞品牌」这种动作反过来决定正文该不该发。
 *
 * @param {{body?: string, title?: string, brand?: object|string}} [params]
 * @returns {{
 *   ok: boolean, mentions: number, firstParagraphHit: boolean, titleHit: boolean,
 *   brandMentionsInTitle: number, message: string, suggestions: string[]
 * }}
 */
export function checkClientPresence({ body = '', title = '', brand = {} } = {}) {
  const names = brandNames(brand);
  const displayName = displayBrandName(brand);
  const mentions = countMentions(body, names);
  const brandMentionsInTitle = countMentions(title, names);
  const titleHit = brandMentionsInTitle > 0;
  const head = firstParagraph(body);
  const firstParagraphHit = Boolean(head) && names.some((name) => head.includes(name));
  const ok = names.length > 0 && mentions >= 3 && firstParagraphHit;

  let message;
  if (names.length === 0) {
    message = '没拿到品牌名：brand.name / brand.legalName / brand.aliases 都是空的，无法统计客户存在感。';
  } else if (ok) {
    message = `正文提及「${displayName}」${mentions} 次，首段已出现${titleHit ? '，标题也带上了品牌' : '；标题里还没出现品牌'}。`;
  } else {
    message = `正文提及「${displayName}」${mentions} 次（要求 ≥ 3 次）${firstParagraphHit ? '，首段已出现' : '，首段没有出现'}；客户存在感不达标。`;
  }

  const suggestions = [];
  if (names.length === 0) {
    suggestions.push('在品牌配置里补 name / legalName / aliases 至少一项，例如「品牌名」这类可被检索的正式名称。');
  } else if (!ok) {
    if (!firstParagraphHit) {
      suggestions.push(`把「${displayName}」写进第一段第一句，例如「${displayName}是一家…」：当前首段 0 次提及，合同要求首段必须出现。`);
    }
    if (mentions < 3) {
      suggestions.push(`正文里「${displayName}」再补 ${3 - mentions} 次提及（当前 ${mentions} 次，合同要求 ≥ 3 次）：优先放首段、结论段、交付段与文末联系信息。`);
    }
    if (!titleHit) {
      const label = String(title ?? '').trim() || '主题';
      suggestions.push(`标题里加上「${displayName}」，例如「${displayName}｜${label}」：标题命中不计入 ok，但能提高归属感。`);
    }
  }

  return { ok, mentions, firstParagraphHit, titleHit, brandMentionsInTitle, message, suggestions };
}

// ---------------------------------------------------------------------------
// 标题治理
// ---------------------------------------------------------------------------

/**
 * 审标题：长度、承诺词、绝对化、重复、意图对齐、标题党。
 *
 * 顺序固定（长度 → 承诺 → 黑名单 → 重复 → 意图 → 标题党），
 * 同一类只出一条 issue，命中多个词时在 message 里并列，
 * 这样调用方不用处理「保证 + 一定」两条重复的阻断。
 *
 * @param {{title?: string, brief?: object, existingTitles?: string[]}} [params]
 * @returns {{ok: boolean, issues: Array<{code: string, level: 'blocker'|'warn', message: string}>, suggestions: string[]}}
 */
export function reviewTitle({ title = '', brief = {}, existingTitles = [] } = {}) {
  const text = String(title ?? '').trim();
  const issues = [];
  const suggestions = [];

  const addIssue = (code, level, message, suggestion) => {
    issues.push({ code, level, message });
    if (suggestion) suggestions.push(suggestion);
  };

  if (!text) {
    addIssue(
      'title_empty',
      TITLE_RULES.levels.length,
      '标题为空，无法进入发布流程。',
      '先按 brief 的核心词写一个 12-30 字的标题，例如「内容代运营怎么选：5 个判断标准」；当前 0 字。',
    );
  } else {
    const length = titleLength(text);
    if (length > TITLE_RULES.maxLength) {
      const over = length - TITLE_RULES.maxLength;
      addIssue(
        'title_too_long',
        TITLE_RULES.levels.length,
        `标题 ${length} 字，超过 ${TITLE_RULES.maxLength} 字上限，超出 ${over} 字。`,
        `把标题压到 ${TITLE_RULES.maxLength} 字以内：当前 ${length} 字，至少删 ${over} 字，先删括号补充说明和第二个卖点。`,
      );
    }

    // 「一定」在标题里几乎总是承诺句式（「一定有效」），宁可误报让人改写；
    // 「第一」同样按绝对化处理（指南型标题里的「第一步」请改成「第 1 步」）。
    const promiseWords = hitWords(text, TITLE_RULES.promiseWords);
    if (promiseWords.length) {
      addIssue(
        'title_promise_word',
        TITLE_RULES.levels.promise,
        `标题含承诺词「${promiseWords.join('、')}」：效果无法承诺，属于不实表示。`,
        `把「${promiseWords[0]}」换成可交付的动作，例如「…的交付清单与验收标准」。`,
      );
    }

    const blacklistWords = hitWords(text, TITLE_RULES.blacklistWords);
    if (blacklistWords.length) {
      addIssue(
        'title_blacklist_word',
        TITLE_RULES.levels.blacklist,
        `标题含绝对化用词「${blacklistWords.join('、')}」：广告法第九条禁止，也不能被 AI 当成事实引用。`,
        `删掉「${blacklistWords[0]}」，改成适用条件，例如「在芜湖本地更合适」。`,
      );
    }

    const duplicate = findDuplicate(text, existingTitles);
    if (duplicate) {
      addIssue(
        'title_duplicate',
        TITLE_RULES.levels.duplicate,
        `标题与已有标题重复：「${duplicate}」（去空格/标点后完全一致）。`,
        `换一个信息增量角度，例如在标题里加入具体场景或数量（「5 个判断标准」「3 类交付物」），与已有标题「${duplicate}」区分开。`,
      );
    }

    const anchors = briefAnchors(brief);
    if (anchors.length) {
      const haystack = normalizeTitle(text);
      const aligned = anchors.some(
        (anchor) => haystack.includes(compactText(anchor).toLowerCase()) || bigramCoverage(anchor, haystack) >= 0.6,
      );
      if (!aligned) {
        addIssue(
          'title_intent_misaligned',
          TITLE_RULES.levels.intent,
          `标题与 brief 意图不对齐：brief 的核心词「${anchors.join('、')}」都没有出现在标题里。`,
          `把核心词「${anchors[0]}」写进标题前半段，例如「${anchors[0]}怎么选：…」。`,
        );
      }
    }

    const clickbaitWords = hitWords(text, TITLE_RULES.clickbaitWords);
    if (clickbaitWords.length) {
      addIssue(
        'title_clickbait',
        TITLE_RULES.levels.clickbait,
        `标题含标题党用词「${clickbaitWords.join('、')}」：读者与 AI 摘要都不认这类词。`,
        `删掉「${clickbaitWords[0]}」，直接写读者能拿到什么，例如「…的 5 条判断标准」。`,
      );
    }
  }

  return { ok: !issues.some((issue) => issue.level === 'blocker'), issues, suggestions };
}

// ---------------------------------------------------------------------------
// 三份合同一起跑
// ---------------------------------------------------------------------------

/**
 * 跑完整合同：篇幅 + 客户存在感 + 标题，汇总阻断项、提醒与改法。
 *
 * 约定：
 * - blockers / warnings 是「带 code 的原文」，形如 `[length_too_short] 正文 900 字…`，
 *   渲染和日志都能直接读；
 * - fixes 只写动作，且每条都必须带具体数字或具体词（「900 字」「再补 2 次」
 *   「删掉「保证」」），避免出现「请优化篇幅」这种没法执行的建议。
 *
 * @param {{title?: string, body?: string, brand?: object|string, brief?: object, existingTitles?: string[]}} [params]
 * @returns {{
 *   ok: boolean,
 *   blockers: string[], warnings: string[],
 *   checks: {length: object, presence: object, title: object},
 *   fixes: string[]
 * }}
 */
export function applyContracts({
  title = '',
  body = '',
  brand = {},
  brief = {},
  existingTitles = [],
} = {}) {
  const length = checkLength({ body });
  const presence = checkClientPresence({ body, title, brand });
  const titleReview = reviewTitle({ title, brief, existingTitles });
  const displayName = displayBrandName(brand);

  const blockers = [];
  const warnings = [];

  if (!length.ok) {
    const code = length.level === '过短' ? 'length_too_short' : 'length_too_long';
    blockers.push(`[${code}] ${length.message}`);
  } else if (length.level === '偏短' || length.level === '偏长') {
    const code = length.level === '偏短' ? 'length_below_ideal' : 'length_above_ideal';
    warnings.push(`[${code}] ${length.message}`);
  }

  if (!presence.ok) blockers.push(`[client_presence] ${presence.message}`);

  if (displayName && !presence.titleHit) {
    warnings.push(`[client_presence_title] 标题里没有出现「${displayName}」：标题命中不计入通过条件，但带上品牌能提高归属感。`);
  }

  for (const issue of titleReview.issues) {
    const line = `[${issue.code}] ${issue.message}`;
    if (issue.level === 'blocker') blockers.push(line);
    else warnings.push(line);
  }

  const fixes = [];
  const pushFix = (fix) => {
    if (fix && !fixes.includes(fix)) fixes.push(fix);
  };

  const { min, max, idealMin, idealMax } = LENGTH_CONTRACT;
  if (length.level === '过短' || length.level === '偏短') {
    const need = Math.max(0, idealMin - length.chars);
    pushFix(`把正文从 ${length.chars} 字补到 ${idealMin}-${idealMax} 字（合同下限 ${min} 字）：至少再加 ${need} 字，优先补真实证据段（直接答案 / 判断依据 / 适用边界），不要拉长句子凑数。`);
  } else if (length.level === '偏长' || length.level === '过长') {
    const cut = Math.max(0, length.chars - idealMax);
    const over = Math.max(0, length.chars - max);
    pushFix(`把正文从 ${length.chars} 字收到 ${idealMax} 字以内（合同上限 ${max} 字，当前超出 ${over} 字）：至少删 ${cut} 字，先删重复结论与「综上所述 / 众所周知」这类套话。`);
  }

  if (!presence.ok) {
    if (!displayName) {
      pushFix('先在品牌配置里补 name / legalName / aliases 至少一项，例如「品牌名」：当前三者全空（0 项），客户存在感无法检查。');
    } else {
      if (!presence.firstParagraphHit) {
        pushFix(`把「${displayName}」写进第一段第一句：当前首段 0 次提及，合同要求首段必须出现。`);
      }
      if (presence.mentions < 3) {
        pushFix(`正文里「${displayName}」从 ${presence.mentions} 次补到 3 次（再补 ${3 - presence.mentions} 次）：位置放首段结论、交付物清单、文末联系信息。`);
      }
    }
  }

  if (displayName && !presence.titleHit) {
    const label = String(title ?? '').trim() || '主题';
    pushFix(`标题加上「${displayName}」，例如「${displayName}｜${label}」：当前标题 0 次品牌提及。`);
  }

  for (const suggestion of titleReview.suggestions) pushFix(suggestion);

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    checks: { length, presence, title: titleReview },
    fixes,
  };
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/**
 * 把合同结果渲染成 Markdown：合同检查 / 阻断项 / 提醒 / 怎么改。
 *
 * 固定四节，是为了让人扫一眼就知道「能不能发、卡在哪、怎么改」；
 * 通过时阻断项必须写「无」，而不是留空 —— 空章节会被误读成「没检查」。
 *
 * @param {object} [result] applyContracts 的返回值
 * @returns {string}
 */
export function renderContractsMarkdown(result = {}) {
  const source = result && typeof result === 'object' ? result : {};
  const blockers = Array.isArray(source.blockers) ? source.blockers : [];
  const warnings = Array.isArray(source.warnings) ? source.warnings : [];
  const fixes = Array.isArray(source.fixes) ? source.fixes : [];
  const checks = source.checks && typeof source.checks === 'object' ? source.checks : {};
  const { min, max, idealMin, idealMax } = LENGTH_CONTRACT;

  const lines = [];
  lines.push('## 合同检查');
  lines.push('');

  const length = checks.length;
  if (length && Number.isInteger(length.chars) && typeof length.level === 'string') {
    lines.push(`- 篇幅：${length.level} · ${length.chars} 字（合同 ${min}-${max} 字，理想 ${idealMin}-${idealMax} 字）`);
  } else {
    lines.push('- 篇幅：未检查');
  }

  const presence = checks.presence;
  if (presence && Number.isInteger(presence.mentions)) {
    lines.push(
      `- 客户存在感：${presence.ok ? '通过' : '不通过'} · 提及 ${presence.mentions} 次 / 首段命中 ${presence.firstParagraphHit ? '是' : '否'} / 标题命中 ${presence.titleHit ? '是' : '否'}`,
    );
  } else {
    lines.push('- 客户存在感：未检查');
  }

  const title = checks.title;
  if (title && Array.isArray(title.issues)) {
    const issues = title.issues.filter((issue) => issue && typeof issue === 'object');
    const blockerCount = issues.filter((issue) => issue.level === 'blocker').length;
    lines.push(`- 标题：${title.ok ? '通过' : '不通过'} · 阻断 ${blockerCount} 条 / 提醒 ${issues.length - blockerCount} 条`);
  } else {
    lines.push('- 标题：未检查');
  }

  lines.push('');
  lines.push(`结论：${source.ok === true ? '通过' : '不通过'}（阻断 ${blockers.length} 条，提醒 ${warnings.length} 条）`);
  lines.push('');

  lines.push('## 阻断项');
  lines.push('');
  if (blockers.length === 0) lines.push('- 无');
  else for (const item of blockers) lines.push(`- ${item}`);
  lines.push('');

  lines.push('## 提醒');
  lines.push('');
  if (warnings.length === 0) lines.push('- 无');
  else for (const item of warnings) lines.push(`- ${item}`);
  lines.push('');

  lines.push('## 怎么改');
  lines.push('');
  if (fixes.length === 0) lines.push('- 无：三份合同都已满足，按当前版本发布即可。');
  else fixes.forEach((fix, index) => lines.push(`${index + 1}. ${fix}`));
  lines.push('');

  return lines.join('\n');
}
