/**
 * lib/compare.js
 * 竞品对位：同一个问题，AI 提了谁、没提谁。
 *
 * 为什么按问题而不是按总分比：客户真正的问题是「客户搜 XX 时，AI 推荐了竞品没推荐我」。
 * 总分只能说明整体，对位表才能指导下一篇内容写什么。
 *
 * 规则：名字匹配用「包含」但不区分大小写；只用可公开的名称，不做语义猜测。
 * 纯函数，不联网。
 */

const norm = (value) => String(value ?? '').trim().toLowerCase();

function namesOf(brand = {}) {
  const names = [brand.name, brand.legalName, ...(Array.isArray(brand.aliases) ? brand.aliases : [])]
    .map(norm)
    .filter((name) => name.length >= 2);
  return [...new Set(names)];
}

/**
 * @param {{brand?:object, rows?:Array, competitors?:string[]}} input
 */
export function buildComparison({ brand = {}, rows = [], competitors = [] } = {}) {
  const brandNames = namesOf(brand);
  const competitorNames = [
    ...new Set(
      [
        ...(Array.isArray(competitors) ? competitors : []),
        ...(Array.isArray(brand.competitors) ? brand.competitors : []),
      ]
        .map((item) => (typeof item === 'string' ? item : item?.name))
        .map((name) => String(name ?? '').trim())
        .filter((name) => name.length >= 2),
    ),
  ];

  const questions = [];
  const seen = new Set();
  for (const row of rows ?? []) {
    const text = String(row?.answer?.text ?? '');
    const questionText = String(row?.question?.text ?? '');
    const key = `${row?.question?.id ?? questionText}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const lower = text.toLowerCase();
    const brandMentioned = brandNames.some((name) => lower.includes(name));
    const mentionedCompetitors = competitorNames.filter((name) => lower.includes(norm(name)));
    const winner = brandMentioned && mentionedCompetitors.length === 0
      ? 'brand'
      : !brandMentioned && mentionedCompetitors.length > 0
        ? 'competitor'
        : brandMentioned && mentionedCompetitors.length > 0
          ? 'both'
          : 'neither';

    questions.push({
      questionId: row?.question?.id ?? null,
      question: questionText,
      brandMentioned,
      competitors: mentionedCompetitors,
      winner,
      verdict: row?.judgment?.verdict ?? 'unknown',
    });
  }

  const summary = {
    total: questions.length,
    brandWins: questions.filter((q) => q.winner === 'brand').length,
    competitorWins: questions.filter((q) => q.winner === 'competitor').length,
    both: questions.filter((q) => q.winner === 'both').length,
    neither: questions.filter((q) => q.winner === 'neither').length,
  };
  const winRate = summary.total ? summary.brandWins / summary.total : 0;

  return {
    brand: brand.name ?? '',
    competitors: competitorNames,
    summary: { ...summary, winRate },
    gaps: questions.filter((q) => q.winner === 'competitor').slice(0, 20),
    strengths: questions.filter((q) => q.winner === 'brand').slice(0, 10),
    questions,
  };
}

/** 渲染 Markdown：先给结论，再给可执行的内容方向 */
export function renderComparisonMarkdown(report = {}) {
  const s = report.summary ?? {};
  const lines = [];
  lines.push(`# 竞品对位 · ${report.brand || ''}`, '');
  lines.push(
    `共 ${s.total ?? 0} 个问题：本品牌独占 ${s.brandWins ?? 0} · 竞品独占 ${s.competitorWins ?? 0} · 双方都提 ${s.both ?? 0} · 都没提 ${s.neither ?? 0}（本品牌胜率 ${((s.winRate ?? 0) * 100).toFixed(1)}%）`,
    '',
  );
  lines.push('## 需要抢回来的问题（竞品被提、我们没被提）', '');
  if (!(report.gaps ?? []).length) lines.push('- 无：本期没有竞品独占的问题。');
  else {
    lines.push('| 问题 | 竞品 |', '| --- | --- |');
    for (const gap of report.gaps) lines.push(`| ${gap.question} | ${gap.competitors.join('、')} |`);
  }
  lines.push('', '## 我们的优势问题（只有我们被提）', '');
  if (!(report.strengths ?? []).length) lines.push('- 无');
  else for (const item of report.strengths) lines.push(`- ${item.question}`);
  lines.push('', '## 下一步', '');
  if ((report.gaps ?? []).length) {
    lines.push(`- 针对上面 ${report.gaps.length} 个问题各写 1 篇对比/实测内容（含价格、流程、优劣），优先覆盖被竞品独占的。`);
    lines.push('- 在自家官网为这些问题补 FAQ 页并加 FAQPage 结构化数据，争取自有引用。');
  } else {
    lines.push('- 保持当前内容节奏，重点转到「自有站点引用占比」。');
  }
  return `${lines.join('\n')}\n`;
}
