/**
 * lib/publish-track.js
 * 发布追踪：每篇已发布内容都要能被追到、核对、撤回。
 *
 * 合规要求（T/CGCC 119-2026 / 白帽 GEO 六原则里的「可追溯」）：
 *   已发布内容应记录 URL、账号、版本、发布日期、引用的事实 ID、负责人；
 *   发现错误时能定位所有受影响内容并撤回。这个模块负责把这些信息变成可看、可判的报告。
 *
 * 纯函数，零依赖，不读写数据库。
 */

const DAY = 86400000;

/** 风险规则：任何一条命中都应在报告里标出来 */
export function trackRisks(publication = {}, { now = Date.now(), factsByKey = new Map(), maxAgeDays = 90 } = {}) {
  const risks = [];
  const created = publication.createdAt ? new Date(publication.createdAt).getTime() : null;
  const ageDays = created ? Math.floor((now - created) / DAY) : null;
  const factKeys = Array.isArray(publication.factKeys) ? publication.factKeys : [];

  if (publication.withdrawnAt) {
    return [{ type: 'withdrawn', level: 'info', detail: `已撤回：${publication.withdrawReason || '未填写原因'}` }];
  }
  if (publication.status === 'published' && !publication.url) {
    risks.push({ type: 'missing_url', level: 'warning', detail: '状态是已发布，但没有登记 URL，无法追溯与撤回' });
  }
  if (publication.status === 'published' && !publication.account) {
    risks.push({ type: 'missing_account', level: 'warning', detail: '没有记录发布账号，出问题时找不到操作人' });
  }
  if (publication.status === 'published' && factKeys.length === 0) {
    risks.push({ type: 'no_facts', level: 'warning', detail: '没有登记引用的事实 ID，无法核对内容里的数字与资质' });
  }
  for (const key of factKeys) {
    const fact = factsByKey.get(key);
    if (!fact) {
      risks.push({ type: 'fact_missing', level: 'critical', detail: `引用了未登记的事实「${key}」` });
      continue;
    }
    if (fact.validUntil && new Date(fact.validUntil).getTime() < now) {
      risks.push({ type: 'fact_expired', level: 'critical', detail: `引用的事实「${key}」已过期，页面需更新或撤回` });
    }
  }
  if (ageDays !== null && ageDays > maxAgeDays && publication.status === 'published') {
    risks.push({ type: 'stale_review', level: 'info', detail: `发布已 ${ageDays} 天，建议复核一次事实是否变化` });
  }
  return risks;
}

/**
 * @param {{publications?:Array, facts?:Array, contents?:Array, now?:number}} input
 */
export function buildTrackReport({ publications = [], facts = [], contents = [], now = Date.now() } = {}) {
  const factsByKey = new Map((facts ?? []).map((fact) => [fact.key, fact]));
  const titleById = new Map((contents ?? []).map((item) => [Number(item.id), item.title]));
  const rows = (publications ?? []).map((publication) => {
    const risks = trackRisks(publication, { now, factsByKey });
    const created = publication.createdAt ? new Date(publication.createdAt).getTime() : null;
    return {
      id: publication.id,
      contentId: publication.contentId,
      title: publication.title ?? titleById.get(Number(publication.contentId)) ?? '',
      channel: publication.channel,
      status: publication.withdrawnAt ? 'withdrawn' : publication.status,
      url: publication.url,
      account: publication.account,
      factKeys: publication.factKeys ?? [],
      createdAt: publication.createdAt,
      ageDays: created ? Math.floor((now - created) / DAY) : null,
      withdrawnAt: publication.withdrawnAt ?? null,
      withdrawReason: publication.withdrawReason ?? null,
      risks,
    };
  });

  const summary = {
    total: rows.length,
    published: rows.filter((row) => row.status === 'published').length,
    withdrawn: rows.filter((row) => row.status === 'withdrawn').length,
    withCritical: rows.filter((row) => row.risks.some((risk) => risk.level === 'critical')).length,
    withWarning: rows.filter((row) => row.risks.some((risk) => risk.level === 'warning')).length,
    traceable: rows.filter((row) => row.status === 'published' && row.url && row.account).length,
  };
  return { summary, rows };
}

/** 渲染 Markdown 追踪报告 */
export function renderTrackMarkdown(report = {}) {
  const s = report.summary ?? {};
  const lines = [];
  lines.push('# 发布追踪（可追溯 · 可撤回）', '');
  lines.push(
    `共 ${s.total ?? 0} 条发布：已发布 ${s.published ?? 0} · 已撤回 ${s.withdrawn ?? 0} · 可完整追溯 ${s.traceable ?? 0} · 有严重风险 ${s.withCritical ?? 0} · 有警告 ${s.withWarning ?? 0}`,
    '',
  );
  if (!(report.rows ?? []).length) {
    lines.push('- 还没有发布记录。');
    return `${lines.join('\n')}\n`;
  }
  lines.push('| # | 内容 | 渠道 | 状态 | URL | 账号 | 事实 | 风险 |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of report.rows) {
    const risk = row.risks.length ? row.risks.map((item) => `${item.level}:${item.type}`).join('、') : '无';
    lines.push(
      `| ${row.id} | ${row.title || `#${row.contentId}`} | ${row.channel} | ${row.status} | ${row.url ?? '—'} | ${row.account ?? '—'} | ${(row.factKeys ?? []).join('、') || '—'} | ${risk} |`,
    );
  }
  const critical = report.rows.flatMap((row) => row.risks.filter((risk) => risk.level === 'critical').map((risk) => ({ row, risk })));
  if (critical.length) {
    lines.push('', '## 立刻处理', '');
    for (const { row, risk } of critical) lines.push(`- 发布 #${row.id}（${row.title || `#${row.contentId}`}）：${risk.detail} → 更新或撤回`);
  }
  return `${lines.join('\n')}\n`;
}
