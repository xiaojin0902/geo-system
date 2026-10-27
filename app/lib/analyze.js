/**
 * lib/analyze.js — 判定、评分、引用分析（v2 精简版）
 *
 * 判定只保留 6 态（够代运营交付用）：
 *   recommended 推荐 / listed 列入 / mentioned 仅提及 / not_mentioned 未提及 /
 *   ambiguous 歧义（同名实体等） / engine_error 采集失败
 *
 * 评分 0-100 = 提及 60 + 判定质量 25 + 引用多样性 15（口径写死，可复算）
 */

export const VERDICTS = Object.freeze({
  recommended: { label: '推荐', weight: 1, counts: true },
  listed: { label: '列入', weight: 0.8, counts: true },
  mentioned: { label: '仅提及', weight: 0.5, counts: true },
  not_mentioned: { label: '未提及', weight: 0, counts: true },
  ambiguous: { label: '歧义', weight: 0, counts: false },
  engine_error: { label: '采集失败', weight: 0, counts: false },
});

const CN_PUNCT = /[，。！？；：""''（）【】]/gu;

/** 从客户资料里取出品牌名与需要排除的同名实体 */
export function brandNamesOf(client = {}) {
  const facts = client.facts ?? {};
  const names = [client.name, facts.legalName, ...(Array.isArray(facts.aliases) ? facts.aliases : [])]
    .map((name) => String(name ?? '').trim())
    .filter((name) => name.length >= 2);
  const rejected = (Array.isArray(facts.rejectedNames) ? facts.rejectedNames : []).map((name) => String(name).trim()).filter(Boolean);
  return { names: [...new Set(names)], rejected };
}

/** 判定一条回答 */
export function judgeAnswer({ text = '', client = {} } = {}) {
  const body = String(text ?? '');
  if (!body.trim()) return { verdict: 'engine_error', matched: '', reasons: ['回答为空'] };
  const { names, rejected } = brandNamesOf(client);
  const matchedBrand = names.find((name) => body.includes(name)) ?? '';
  const matchedRejected = rejected.find((name) => body.includes(name)) ?? '';

  if (matchedRejected && !matchedBrand) {
    return { verdict: 'ambiguous', matched: matchedRejected, reasons: [`只命中同名实体「${matchedRejected}」，未出现本品牌`] };
  }
  if (!matchedBrand) return { verdict: 'not_mentioned', matched: '', reasons: ['回答中未出现品牌名或别名'] };

  const head = body.slice(0, Math.min(120, body.length));
  const recommendWords = /推荐|首选|靠谱|不错|值得|可以选择|建议选/u;
  const listWords = /排名|榜|之一|几家|前三|名单/u;
  if (recommendWords.test(head)) return { verdict: 'recommended', matched: matchedBrand, reasons: ['前 120 字出现推荐/正面评价'] };
  if (listWords.test(body)) return { verdict: 'listed', matched: matchedBrand, reasons: ['回答以列举/排名方式带出品牌'] };
  return { verdict: 'mentioned', matched: matchedBrand, reasons: ['提到品牌但未进入推荐/列举'] };
}

/** 统计与评分 */
export function analyzeRows({ rows = [], client = {} } = {}) {
  const valid = rows.filter((row) => VERDICTS[row.verdict]?.counts !== false);
  const mentioned = valid.filter((row) => row.verdict !== 'not_mentioned');
  const total = valid.length;
  const mentionRate = total ? mentioned.length / total : 0;

  const domainCount = new Map();
  let citationTotal = 0;
  for (const row of rows) {
    for (const cite of row.citations ?? []) {
      citationTotal += 1;
      try {
        const host = new URL(cite.url).hostname.replace(/^www\./u, '');
        domainCount.set(host, (domainCount.get(host) ?? 0) + 1);
      } catch { /* 忽略非法 URL */ }
    }
  }
  const domains = [...domainCount.entries()].map(([domain, count]) => ({ domain, count })).sort((a, b) => b.count - a.count);

  const competitors = (client.competitors ?? []).map((name) => {
    const mentions = rows.filter((row) => String(row.text ?? '').includes(String(name))).length;
    return { name, mentions, share: mentionRate > 0 ? mentions / Math.max(1, mentioned.length) : 0 };
  });

  const verdictCounts = Object.fromEntries(Object.keys(VERDICTS).map((id) => [id, rows.filter((row) => row.verdict === id).length]));

  // 弱项问题：AI 没提或歧义的，用来生成「先写哪几篇」
  const topQuestions = rows
    .filter((row) => ['not_mentioned', 'ambiguous'].includes(row.verdict))
    .map((row) => row.question)
    .filter((question, index, list) => question && list.indexOf(question) === index)
    .slice(0, 5);

  return {
    sample: { total, ok: valid.length, mentioned: mentioned.length, mentionRate },
    topQuestions,
    verdictCounts,
    citations: { total: citationTotal, domains },
    competitors,
    engines: [...new Set(rows.map((row) => row.engine))].map((engine) => {
      const engineRows = rows.filter((row) => row.engine === engine);
      const engineValid = engineRows.filter((row) => VERDICTS[row.verdict]?.counts !== false);
      const engineMentioned = engineValid.filter((row) => row.verdict !== 'not_mentioned').length;
      return { engine, answers: engineRows.length, ok: engineValid.length, mentioned: engineMentioned, mentionRate: engineValid.length ? engineMentioned / engineValid.length : 0 };
    }),
  };
}

/** 0-100 评分（口径固定，可复算） */
export function scoreOf(analysis) {
  const sample = analysis?.sample ?? { total: 0, ok: 0, mentioned: 0, mentionRate: 0 };
  if (!sample.total) {
    return { total: null, level: '样本不足', breakdown: { mention: 0, quality: 0, citation: 0, reason: '没有有效样本，不出分（没测成 ≠ 0 分）' } };
  }
  const mention = Math.round(sample.mentionRate * 60);
  const weighted = (analysis.verdictCounts?.recommended ?? 0) * 1 + (analysis.verdictCounts?.listed ?? 0) * 0.8 + (analysis.verdictCounts?.mentioned ?? 0) * 0.5;
  const quality = Math.round(Math.min(1, weighted / Math.max(1, sample.total)) * 25);
  const citation = Math.round(Math.min(1, (analysis.citations?.domains?.length ?? 0) / 5) * 15);
  const total = mention + quality + citation;
  const level = total >= 60 ? '好' : total >= 30 ? '一般' : '隐形';
  return { total, level, breakdown: { mention, quality, citation, mentionRate: sample.mentionRate, domains: analysis.citations?.domains?.length ?? 0 } };
}

/** 生成「可执行建议」：按判定缺口给动作 */
export function buildActions({ analysis = {}, client = {} } = {}) {
  const actions = [];
  const sample = analysis.sample ?? {};
  if (!sample.total) {
    actions.push('先补采集：换可用引擎或补题数，覆盖率到 50% 以上再谈优化');
    return actions;
  }
  if (sample.mentionRate < 0.3) {
    actions.push(`提及率只有 ${(sample.mentionRate * 100).toFixed(0)}%：先把「全称+城市+业务」在官网/工商/地图写成一套，再补 3 篇问答内容`);
  } else if (sample.mentionRate < 0.7) {
    actions.push('提及率中等：重点抢「对比/推荐」类问题，每类各写 1 篇对比型内容');
  } else {
    actions.push('提及率已达标：把重点转到「自有站点引用占比」，让 AI 从引别家改成引你');
  }
  if ((analysis.citations?.domains?.length ?? 0) > 0) {
    actions.push(`引用源集中在 ${analysis.citations.domains.slice(0, 3).map((d) => d.domain).join('、')}：去这些平台占位`);
  }
  const strongCompetitor = (analysis.competitors ?? []).sort((a, b) => b.mentions - a.mentions)[0];
  if (strongCompetitor && strongCompetitor.mentions > 0) {
    actions.push(`竞品「${strongCompetitor.name}」被提 ${strongCompetitor.mentions} 次：针对它被提的问题写对比与实测`);
  }
  return actions.slice(0, 5);
}
