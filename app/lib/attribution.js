/**
 * lib/attribution.js
 * 内容 → 引用归因：回答「我们发的哪篇文章，被 AI 引用了」。
 *
 * 这是服务客户最有说服力的一页：
 *   客户不关心「跑了多少题」，关心「我花钱写的内容，AI 到底引没引」。
 *
 * 匹配规则（保守，宁可漏判也不乱认）：
 *   1) 精确 URL 匹配（去掉协议与末尾斜杠后相等）；
 *   2) 同域名 + 路径前缀匹配（文章页被引用，通常就是这条 URL）；
 *   3) 自有域名（brand.urls）下的其它页面，记为「自有站点被引（未绑定内容）」。
 *   不按标题模糊匹配——标题相似但页面不同，会把功劳记错。
 */

const normalizeUrl = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return `${url.host.toLowerCase()}${url.pathname.replace(/\/+$/u, '')}`;
  } catch {
    return '';
  }
};

const hostOf = (value) => {
  try {
    return new URL(String(value)).host.toLowerCase();
  } catch {
    return '';
  }
};

/**
 * @param {object} input
 * @param {object} [input.brand] 品牌（urls 用于识别自有域名）
 * @param {Array} [input.rows] run 明细行（question/answer/judgment）
 * @param {Array} [input.contents] 内容列表（id/title）
 * @param {Array} [input.publications] 发布记录（contentId/channel/url）
 */
export function buildAttribution({ brand = {}, rows = [], contents = [], publications = [] } = {}) {
  const contentsById = new Map((contents ?? []).map((item) => [Number(item.id), item]));
  const ownHosts = new Set(
    (Array.isArray(brand.urls) ? brand.urls : [])
      .map((u) => hostOf(u))
      .filter(Boolean)
      .map((h) => h.replace(/^www\./u, '')),
  );

  // 收集所有引用
  const citations = [];
  for (const row of rows ?? []) {
    const answerCitations = Array.isArray(row?.answer?.citations) ? row.answer.citations : [];
    for (const cite of answerCitations) {
      const url = typeof cite === 'string' ? cite : cite?.url;
      if (!url) continue;
      citations.push({
        url: String(url),
        normalized: normalizeUrl(url),
        host: hostOf(url).replace(/^www\./u, ''),
        engine: row?.answer?.engine ?? 'unknown',
        question: row?.question?.text ?? '',
      });
    }
  }

  const pubs = (publications ?? []).map((pub) => ({
    contentId: Number(pub.contentId ?? pub.content_id),
    channel: pub.channel ?? '',
    url: pub.url ?? '',
    normalized: normalizeUrl(pub.url),
    status: pub.status ?? 'dry_run',
    title: contentsById.get(Number(pub.contentId ?? pub.content_id))?.title ?? '',
  }));

  const byContent = new Map();
  const matchedCitationIndexes = new Set();
  for (const pub of pubs) {
    if (!pub.url) continue;
    const hits = [];
    citations.forEach((cite, index) => {
      if (matchedCitationIndexes.has(index)) return;
      const exact = pub.normalized && cite.normalized === pub.normalized;
      const prefix = pub.normalized && cite.normalized.startsWith(`${pub.normalized}/`);
      const sameHost = pub.normalized.split('/')[0] === cite.host;
      if (exact || prefix || (sameHost && cite.normalized.includes(pub.normalized.split('/').slice(1).join('/')))) {
        matchedCitationIndexes.add(index);
        hits.push(cite);
      }
    });
    const key = String(pub.contentId);
    const existing = byContent.get(key) ?? {
      contentId: pub.contentId,
      title: pub.title,
      publications: [],
      citations: 0,
      engines: new Set(),
      questions: new Set(),
      urls: new Set(),
    };
    existing.publications.push({ channel: pub.channel, url: pub.url, status: pub.status, hits: hits.length });
    existing.citations += hits.length;
    for (const hit of hits) {
      existing.engines.add(hit.engine);
      if (hit.question) existing.questions.add(hit.question);
      existing.urls.add(hit.url);
    }
    byContent.set(key, existing);
  }

  const ownCitations = citations.filter((cite) => ownHosts.has(cite.host));
  const matchedOwn = ownCitations.filter((cite) =>
    [...matchedCitationIndexes].some((index) => citations[index]?.normalized === cite.normalized),
  );

  const byDomain = new Map();
  for (const cite of citations) {
    const entry = byDomain.get(cite.host) ?? { domain: cite.host, count: 0, engines: new Set(), own: ownHosts.has(cite.host) };
    entry.count += 1;
    entry.engines.add(cite.engine);
    byDomain.set(cite.host, entry);
  }

  return {
    brand: brand.name ?? '',
    totals: {
      citations: citations.length,
      questions: new Set((rows ?? []).map((row) => row?.question?.id)).size,
      publications: pubs.filter((pub) => pub.url).length,
      contents: byContent.size,
      ownCitations: ownCitations.length,
      ownCitationsMatched: matchedOwn.length,
      ownShare: citations.length ? ownCitations.length / citations.length : 0,
    },
    byContent: [...byContent.values()]
      .map((item) => ({
        ...item,
        engines: [...item.engines],
        questions: [...item.questions].slice(0, 5),
        urls: [...item.urls].slice(0, 3),
      }))
      .sort((a, b) => b.citations - a.citations),
    ownDomains: [...ownHosts],
    ownCitationsUnmatched: ownCitations
      .filter((cite) => !matchedOwn.some((m) => m.normalized === cite.normalized))
      .slice(0, 10),
    topDomains: [...byDomain.values()]
      .map((item) => ({ domain: item.domain, count: item.count, own: item.own, engines: [...item.engines] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
  };
}

/** 渲染成 Markdown（可直接塞进周报/结算单） */
export function renderAttributionMarkdown(report = {}) {
  const lines = [];
  const totals = report.totals ?? {};
  lines.push(`# 内容引用归因 · ${report.brand || ''}`, '');
  lines.push(
    `共 ${totals.citations ?? 0} 条引用 · 自有域名 ${totals.ownCitations ?? 0} 条（${((totals.ownShare ?? 0) * 100).toFixed(1)}%）· 已绑定内容 ${totals.contents ?? 0} 个`,
    '',
  );
  if (!(report.byContent ?? []).length) {
    lines.push('## 结论');
    lines.push('');
    lines.push('- 本期没有任何「已发布 URL」被 AI 引用。先确认发布记录里有 URL，再检查页面是否可被抓取。');
    return `${lines.join('\n')}\n`;
  }
  lines.push('## 内容贡献榜', '');
  lines.push('| 排名 | 内容 | 渠道 | 被引次数 | 涉及引擎 |', '| --- | --- | --- | --- | --- |');
  report.byContent.forEach((item, index) => {
    lines.push(
      `| ${index + 1} | ${item.title || `#${item.contentId}`} | ${item.publications.map((p) => p.channel).join('、')} | ${item.citations} | ${item.engines.join('、')} |`,
    );
  });
  lines.push('', '## 自有域名被引（未绑定内容）', '');
  if (!(report.ownCitationsUnmatched ?? []).length) lines.push('- 无');
  else for (const cite of report.ownCitationsUnmatched) lines.push(`- ${cite.url}（${cite.engine}）`);
  lines.push('', '## 引用源 Top', '');
  for (const domain of (report.topDomains ?? []).slice(0, 8)) {
    lines.push(`- ${domain.domain}${domain.own ? '（自有）' : ''}：${domain.count} 次`);
  }
  return `${lines.join('\n')}\n`;
}
