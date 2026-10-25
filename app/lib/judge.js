/**
 * lib/judge.js
 * 品牌提及判定层（SPEC §3.4）：**确定性优先**。
 *
 * 红线：
 *  - 先做名单/别名/法律后缀的确定性匹配，不交给大模型拍板；
 *  - 拿不准（例如「恒野」这种常见词、上下文无线索）→ ambiguous，绝不折算成 not_mentioned；
 *  - 没测成（refused / engine_error / unavailable / 空回答）→ 对应状态，不当作「未提及」。
 *
 * method 取值含义：
 *  - exact       正式名 / 别名精确命中
 *  - legal_suffix 通过「别名 + 法律后缀（有限公司/公司…）」扩展命中
 *  - rejected    命中否决名（易混淆实体），按契约判 not_mentioned
 *  - heuristic   别名歧义需要用上下文启发式判断
 *  - fallback    未命中 / 空回答等回落判定
 */

export const VERDICTS = Object.freeze([
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

/** 法律后缀扩展：别名 + 后缀 → 常见法律实体写法，用于识别「恒野数字科技有限公司」这类变体。 */
const LEGAL_SUFFIXES = Object.freeze(['有限责任公司', '股份有限公司', '有限公司', '公司']);

/** 通用品牌线索词：出现这些词说明上下文在谈「一家具体实体 / 品牌」，可解除常见词歧义。 */
const GENERIC_CLUES = Object.freeze(['工作室', '公司', '团队', '品牌', '官网', '联系方式', '邮箱', '成立于', '服务商', '代运营', '陪跑', 'geo']);

/** 推荐语境词（SPEC §3.4 规则 4）。 */
const RECOMMEND_RE = /推荐|首选|第一|排名|top|值得|靠谱|榜单|前三|优选|优先/u;

/** 否定语境：先剔除，避免把「不推荐恒野」判成 recommended。 */
const NEGATIVE_RE = /不推荐|不建议|不靠谱|不首选|不是首选|没推荐|未推荐|不入选|不值|不怎么样/gu;

/** 枚举语境：顿号、1./2. 编号。 */
const ENUM_RE = /、|(?:^|[^0-9a-z])(?:[1-9])[.．、)）]/u;

/** 对比语境。 */
const LIST_CTX_RE = /对比|类似|也可以/u;

/**
 * 条件推荐语境：推荐但有前提。
 * 与 recommended 的区别在商业含义：条件推荐说明「你不总是首选」，
 * 补内容时要针对那个前提（预算/场景/规模），而不是单纯堆推荐词。
 */
const CONDITIONAL_RE = /如果.{0,12}(预算|规模|需求|要求|适合|需要)|适合.{0,8}(的话|人群|场景)|预算有限|预算不高|看情况|视需求|取决于/u;

/** 候选/备选语境：被列为选项，但没有推荐倾向。 */
const CANDIDATE_RE = /候选|备选|入围|可作为选项|可以考虑|之一/u;

function toHalfWidth(char) {
  const code = char.charCodeAt(0);
  if (code === 0x3000) return ' ';
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0);
  return char;
}

/**
 * 归一化 + 记录「归一化下标 → 原文下标」映射，便于取原话片段。
 * 规则：全角→半角、去空白、小写。
 */
function normalizeWithMap(value) {
  const source = String(value ?? '');
  let normalized = '';
  const map = [];
  let originalIndex = 0;

  for (const rawChar of source) {
    const start = originalIndex;
    originalIndex += rawChar.length;
    const half = toHalfWidth(rawChar);
    if (/^\s*$/u.test(half)) continue;
    const lowered = half.toLowerCase();
    for (const char of lowered) {
      normalized += char;
      map.push(start);
    }
  }
  return { normalized, map };
}

/**
 * 归一化文本（全角→半角、去空白、小写）。用于匹配与关键词检测。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeText(value) {
  return normalizeWithMap(value).normalized;
}

function normalizeCandidate(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  return normalizeText(value);
}

/** 否决名候选（兼容 rejectedNames / rejected 两种字段名）。 */
function buildRejectedCandidates(brand) {
  const source = brand || {};
  const list = Array.isArray(source.rejectedNames)
    ? source.rejectedNames
    : Array.isArray(source.rejected)
      ? source.rejected
      : [];
  const candidates = [];
  const seen = new Set();
  for (const item of list) {
    const needle = normalizeCandidate(item);
    if (needle.length < 2 || seen.has(needle)) continue;
    seen.add(needle);
    candidates.push({ surface: item.trim(), needle, kind: 'rejected', source: 'literal' });
  }
  return candidates;
}

/** 正式名 / 别名（literal）+ 法律后缀扩展（expanded）候选。 */
function buildBrandCandidates(brand) {
  const source = brand || {};
  const aliases = (Array.isArray(source.aliases) ? source.aliases : []).filter(
    (item) => typeof item === 'string' && item.trim(),
  );

  const literal = [];
  const seen = new Set();
  const addLiteral = (value, kind) => {
    const needle = normalizeCandidate(value);
    if (needle.length < 2 || seen.has(needle)) return;
    seen.add(needle);
    literal.push({ surface: value.trim(), needle, kind, source: 'literal' });
  };

  addLiteral(source.name, 'name');
  addLiteral(source.legalName, 'legalName');
  for (const alias of aliases) addLiteral(alias, 'alias');

  // 法律后缀扩展：别名 + 有限公司 / 公司 …
  const expanded = [];
  for (const alias of aliases) {
    for (const suffix of LEGAL_SUFFIXES) {
      const surface = `${alias.trim()}${suffix}`;
      const needle = normalizeText(surface);
      if (needle.length < 3 || seen.has(needle)) continue;
      seen.add(needle);
      expanded.push({ surface, needle, kind: 'alias_suffix', source: 'expanded' });
    }
  }

  return [...literal, ...expanded];
}

/** 品牌线索集合：城市、行业、服务、法律名片段、网址主域等。 */
function buildClues(brand) {
  const source = brand || {};
  const clues = new Set();
  for (const clue of GENERIC_CLUES) clues.add(normalizeText(clue));

  const add = (value) => {
    if (typeof value !== 'string') return;
    for (const part of value.split(/[/、,，;；·|]+/u)) {
      const normalized = normalizeText(part);
      if (normalized.length >= 2) clues.add(normalized);
    }
  };

  add(source.city);
  add(source.industry);
  add(source.scope);
  for (const service of Array.isArray(source.services) ? source.services : []) add(service);
  for (const url of Array.isArray(source.urls) ? source.urls : []) {
    try {
      const host = new URL(String(url)).hostname.toLowerCase().replace(/^www\./u, '');
      const label = host.split('.')[0];
      if (label && label.length >= 2) clues.add(normalizeText(label));
    } catch {
      // 非法 URL 忽略
    }
  }

  // legalName 去掉品牌名后的片段（如「芜湖数字科技有限公司」「数字科技」）作为法律实体线索
  const nameNormalized = normalizeText(source.name);
  const legalNormalized = normalizeText(source.legalName);
  if (nameNormalized && legalNormalized && legalNormalized.includes(nameNormalized)) {
    const rest = legalNormalized.replace(nameNormalized, '');
    if (rest.length >= 2) clues.add(rest);
    const cityNormalized = normalizeText(source.city);
    if (cityNormalized && rest.includes(cityNormalized)) {
      const restWithoutCity = rest.replace(cityNormalized, '');
      if (restWithoutCity.length >= 2) clues.add(restWithoutCity);
    }
  }

  return clues;
}

function findOccurrences(normalizedText, candidates) {
  const hits = [];
  for (const candidate of candidates) {
    if (!candidate.needle) continue;
    let from = 0;
    let index = normalizedText.indexOf(candidate.needle, from);
    while (index !== -1) {
      hits.push({ ...candidate, index });
      from = index + 1;
      index = normalizedText.indexOf(candidate.needle, from);
    }
  }
  return hits;
}

/** 选最可信的一处命中：最长优先 → literal 优先于扩展 → 位置靠前优先。 */
function pickBest(hits) {
  if (!hits.length) return null;
  const sorted = [...hits].sort((a, b) => {
    if (b.needle.length !== a.needle.length) return b.needle.length - a.needle.length;
    if (a.source !== b.source) return a.source === 'literal' ? -1 : 1;
    return a.index - b.index;
  });
  return sorted[0];
}

/** 取命中处原文前后 radius 个字符作为上下文。 */
function contextAround(text, map, index, needleLength, radius = 40) {
  const startOriginal = map[index] ?? 0;
  const lastNormalizedIndex = index + needleLength - 1;
  const endOriginal = (map[lastNormalizedIndex] ?? startOriginal) + 1;
  return text.slice(Math.max(0, startOriginal - radius), Math.min(text.length, endOriginal + radius));
}

function hasBrandClue(contextText, clues) {
  const normalizedContext = normalizeText(contextText);
  for (const clue of clues) {
    if (clue && normalizedContext.includes(clue)) return true;
  }
  return false;
}

/** 推荐档位启发式（SPEC §3.4 规则 4）。 */
function classifyMention(contextText) {
  const normalized = normalizeText(contextText);
  const withoutNegatives = normalized.replace(NEGATIVE_RE, '');
  const negated = withoutNegatives !== normalized;
  const keywordMatch = withoutNegatives.match(RECOMMEND_RE);

  // 判定顺序很重要：前提条件 > 推荐 > 候选 > 列举 > 仅提及。
  // 为什么条件前置：像「如果预算有限，可以考虑 X」这种句子同时命中
  // 「可以考虑（候选词）」和「如果…预算（条件词）」，商业含义是「有条件推荐」，
  // 排在候选前面才不会把有前提的推荐降级成普通候选项。
  if (CONDITIONAL_RE.test(normalized)) {
    return {
      verdict: 'conditionally_recommended',
      reason: '推荐档位启发式：命中处带前提条件（如果/适合…的话/预算/看情况/视需求）→ conditionally_recommended',
      negated,
    };
  }
  if (keywordMatch) {
    return {
      verdict: 'recommended',
      reason: `推荐档位启发式：命中处前后 40 字内出现推荐词「${keywordMatch[0]}」→ recommended`,
      negated,
    };
  }
  if (CANDIDATE_RE.test(normalized)) {
    return {
      verdict: 'candidate',
      reason: '推荐档位启发式：命中处处于候选/备选语境（候选/备选/入围/可以考虑）→ candidate',
      negated,
    };
  }
  if (ENUM_RE.test(normalized) || LIST_CTX_RE.test(normalized)) {
    return {
      verdict: 'listed',
      reason: '推荐档位启发式：命中处处于枚举/对比语境（出现「、」或 1./2. 编号，或含对比/类似/也可以）→ listed',
      negated,
    };
  }
  return {
    verdict: 'mentioned',
    reason: '推荐档位启发式：命中处未检出推荐词，也不在枚举/对比语境 → mentioned',
    negated,
  };
}

function confidenceFor(verdict, method) {
  const base = {
    recommended: 0.85,
    conditionally_recommended: 0.8,
    candidate: 0.7,
    listed: 0.75,
    mentioned: 0.9,
  }[verdict] ?? 0.5;
  const value = method === 'legal_suffix' ? base * 0.95 : base;
  return Math.round(value * 100) / 100;
}

function buildResult(verdict, { matchedText = '', method = 'fallback', confidence = 1, reasons = [] } = {}) {
  return {
    verdict,
    matchedText,
    method,
    confidence,
    reasons: reasons.filter(Boolean),
  };
}

/**
 * 判定一条回答里品牌被提及的情况。
 * @param {object} input
 * @param {string} [input.text] 回答正文
 * @param {'ok'|'refused'|'engine_error'|'unavailable'} [input.status] 采集状态
 * @param {object} [input.brand] brands/<slug>.json 形状的品牌对象
 * @param {string} [input.engineId] 引擎 id（写进 reasons 便于复核）
 * @returns {{verdict:string, matchedText:string, method:string, confidence:number, reasons:string[]}}
 */
export function judgeAnswer({ text, status, brand = {}, engineId = '' } = {}) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  const answerStatus = typeof status === 'string' && status ? status : 'ok';
  const engineTag = engineId ? `（引擎：${engineId}）` : '';

  if (answerStatus === 'engine_error') {
    return buildResult('engine_error', {
      reasons: [`引擎错误${engineTag}：本次没有取得回答，不计入分母，也不记 0 分`],
    });
  }
  if (answerStatus === 'refused') {
    return buildResult('refused', {
      reasons: [`模型拒答${engineTag}：本次不计入分母（没测成 ≠ 未提及）`],
    });
  }
  if (answerStatus === 'unavailable') {
    return buildResult('engine_error', {
      reasons: [`引擎不可用${engineTag}（status=unavailable）：无 key 或服务不可达，不计入分母`],
    });
  }

  const { normalized, map } = normalizeWithMap(source);
  const isDemo = normalized.includes('[demo]');
  const commonReasons = isDemo ? ['回答带 [DEMO] 前缀（演示数据，不得当作真实 AI 回答）'] : [];

  if (!normalized) {
    return buildResult('unknown', {
      confidence: 0,
      reasons: [...commonReasons, '回答为空或只有空白，无法判定 → unknown（不计入分母）'],
    });
  }

  if (answerStatus !== 'ok') {
    return buildResult('engine_error', {
      reasons: [...commonReasons, `未知采集状态「${answerStatus}」，按引擎错误处理，不计入分母`],
    });
  }

  // 1) 否决名优先（SPEC §3.4 顺序）：命中易混淆实体 → not_mentioned
  //    但有一条现实修正：一条回答可能**同时**提到本品牌与同名公司（对比/纠错场景）。
  //    若同时出现本品牌线索（城市 / 全称 / 业务词），就不能简单按否决名判未提及，
  //    否则会把「AI 同时提到了我们和别家」误杀成「没提我们」。
  const rejected = pickBest(findOccurrences(normalized, buildRejectedCandidates(brand)));
  if (rejected) {
    const disambiguationConfig = (brand && brand.disambiguation) || {};
    const requireClues = (Array.isArray(disambiguationConfig.requireClues) ? disambiguationConfig.requireClues : [])
      .map((item) => normalizeText(item))
      .filter(Boolean);
    const legalNameNeedle = normalizeText(brand && brand.legalName);
    const rejectedContext = normalizeText(
      contextAround(source, map, rejected.index, rejected.needle.length, 120),
    );
    const hasOurClue =
      (legalNameNeedle && normalized.includes(legalNameNeedle)) ||
      requireClues.some((clue) => rejectedContext.includes(clue));

    if (!hasOurClue) {
      return buildResult('not_mentioned', {
        matchedText: rejected.surface,
        method: 'rejected',
        confidence: 1,
        reasons: [
          ...commonReasons,
          `回答中出现否决名（易混淆实体）「${rejected.surface}」，且附近没有本品牌线索 → 按 rejected 判 not_mentioned`,
        ],
      });
    }
    // 有本品牌线索：不在这里下结论，继续走实体匹配与消歧
  }

  // 2) 正式名 / 别名 / 法律后缀扩展匹配
  const candidates = buildBrandCandidates(brand);
  if (!candidates.length) {
    return buildResult('unknown', {
      confidence: 0,
      reasons: [...commonReasons, '品牌配置缺少正式名/别名，无法做实体匹配 → unknown（不折算成未提及）'],
    });
  }

  const best = pickBest(findOccurrences(normalized, candidates));
  if (!best) {
    return buildResult('not_mentioned', {
      method: 'fallback',
      confidence: isDemo ? 0.9 : 0.6,
      reasons: [
        ...commonReasons,
        isDemo
          ? '[DEMO] 演示回答中未出现品牌正式名或别名 → not_mentioned（method=fallback）'
          : '未出现品牌正式名或别名 → not_mentioned（method=fallback）；若回答明显指代本品牌但未写名字，请人工复核',
      ],
    });
  }

  const context = contextAround(source, map, best.index, best.needle.length, 40);
  const matchReason =
    best.source === 'expanded'
      ? `通过法律后缀扩展匹配到「${best.surface}」（${best.kind}，method=legal_suffix）`
      : `匹配到${best.kind === 'legalName' ? '正式名' : best.kind === 'name' ? '品牌名' : '别名'}「${best.surface}」（method=exact）`;

  // 3) 实体消歧：这是真实数据暴露出来的最严重问题。
  //    「恒野」这种常见词，AI 回答里提到的很可能是河南恒野农牧、苏州恒野仓储等同名公司。
  //    只靠「上下文有没有『公司』」这种通用线索会放过它们（因为同名公司也是「公司」），
  //    所以必须让品牌配置显式给出「排除线索」与「必需线索」，两者同时参与判定。
  const ambiguousAliases = new Set(
    (Array.isArray(brand && brand.ambiguousAliases) ? brand.ambiguousAliases : [])
      .map(normalizeCandidate)
      .filter(Boolean),
  );
  const disambiguation = (brand && brand.disambiguation) || {};
  const rejectClues = (Array.isArray(disambiguation.rejectClues) ? disambiguation.rejectClues : [])
    .map((item) => normalizeText(item))
    .filter(Boolean);
  const requireClues = (Array.isArray(disambiguation.requireClues) ? disambiguation.requireClues : [])
    .map((item) => normalizeText(item))
    .filter(Boolean);
  const isAmbiguousAlias = best.source === 'literal' && ambiguousAliases.has(best.needle);

  if (isAmbiguousAlias && (rejectClues.length || requireClues.length)) {
    // 消歧要看更宽的上下文（同一段回答里，城市/行业线索常在命中处 40 字之外）
    const wide = normalizeText(contextAround(source, map, best.index, best.needle.length, 120));
    const rejectHit = rejectClues.find((clue) => wide.includes(clue));
    const requireHit = requireClues.find((clue) => wide.includes(clue));

    if (rejectHit && !requireHit) {
      return buildResult('not_mentioned', {
        matchedText: best.surface,
        method: 'disambiguation',
        confidence: 0.9,
        reasons: [
          ...commonReasons,
          matchReason,
          `实体消歧：命中处上下文出现排除线索「${rejectHit}」且没有本品牌线索 → 判定为同名其他实体，按 not_mentioned 处理（不是本品牌的可见度）`,
        ],
      });
    }
    if (requireHit) {
      const tierHit = classifyMention(contextAround(source, map, best.index, best.needle.length, 40) + source.slice(Math.max(0, (map[best.index] ?? 0) - 120), (map[best.index] ?? 0) + 160));
      return buildResult(tierHit.verdict, {
        matchedText: best.surface,
        method: 'disambiguation',
        confidence: confidenceFor(tierHit.verdict, 'exact'),
        reasons: [
          ...commonReasons,
          matchReason,
          `实体消歧：命中本品牌线索「${requireHit}」→ 确认是本公司，按正常档位判定`,
          tierHit.reason,
        ],
      });
    }
  }

  if (isAmbiguousAlias && !hasBrandClue(context, buildClues(brand))) {
    return buildResult('ambiguous', {
      matchedText: best.surface,
      method: 'heuristic',
      confidence: 0.35,
      reasons: [
        ...commonReasons,
        matchReason,
        `别名「${best.surface}」在 brand.ambiguousAliases 中声明为常见词，命中处上下文没有城市/行业/法律实体等品牌线索 → ambiguous（拿不准就是 ambiguous，不折算成未提及）`,
      ],
    });
  }

  // 4) 推荐档位启发式
  const tier = classifyMention(context);
  const method = best.source === 'expanded' ? 'legal_suffix' : 'exact';
  const reasons = [...commonReasons, matchReason, tier.reason];
  if (tier.negated) reasons.push('上下文含否定表达（如「不推荐」），已先剔除再判推荐档位');

  return buildResult(tier.verdict, {
    matchedText: best.surface,
    method,
    confidence: confidenceFor(tier.verdict, method),
    reasons,
  });
}
