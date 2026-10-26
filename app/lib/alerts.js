/**
 * lib/alerts.js
 * 异动告警：AI 可见度不是每天线性变化，客户真正在意的是「哪天突然掉了/涨了」。
 *
 * 设计取舍：
 *   - 只用可复算的指标（提及率、总分、自有引用、竞品份额、同名威胁），不引入主观判断；
 *   - 有「坏消息」也有「好消息」（涨了同样值得通知），否则客户只记住掉分；
 *   - 阈值可配（settings: alert_*），默认值偏保守，避免天天报警造成疲劳；
 *   - 纯函数：输入两轮分析结果，输出告警列表，不发网络。
 */

export const ALERT_LEVELS = Object.freeze({
  critical: { id: 'critical', name: '严重', weight: 3 },
  warning: { id: 'warning', name: '警告', weight: 2 },
  info: { id: 'info', name: '提示', weight: 1 },
  positive: { id: 'positive', name: '利好', weight: 0 },
});

/** 默认阈值（可在设置里覆盖：alert_mention_drop_pt / alert_score_drop / alert_competitor_gain_pt / alert_min_samples） */
export const DEFAULT_THRESHOLDS = Object.freeze({
  mentionDropPt: 15,
  scoreDrop: 10,
  competitorGainPt: 20,
  minSamples: 5,
});

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function thresholdsOf(settings = {}) {
  const pick = (key, fallback) => {
    const value = Number(settings[key]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    mentionDropPt: pick('alert_mention_drop_pt', DEFAULT_THRESHOLDS.mentionDropPt),
    scoreDrop: pick('alert_score_drop', DEFAULT_THRESHOLDS.scoreDrop),
    competitorGainPt: pick('alert_competitor_gain_pt', DEFAULT_THRESHOLDS.competitorGainPt),
    minSamples: pick('alert_min_samples', DEFAULT_THRESHOLDS.minSamples),
  };
}

/** 环比百分比（按百分点展示，如 25% → 10% 记为 -15pt） */
function ptDelta(now, prev) {
  return Math.round((num(now) - num(prev)) * 1000) / 10;
}

/**
 * 评估两轮之间的异动。
 * @param {{brand?:object, current?:object, previous?:object, settings?:object, runId?:number|string}} input
 */
export function evaluateAlerts({ brand = {}, current = null, previous = null, settings = {}, runId = null } = {}) {
  const thresholds = thresholdsOf(settings);
  const alerts = [];

  if (!current) {
    return {
      runId,
      thresholds,
      alerts: [
        {
          id: 'no_data',
          level: 'warning',
          rule: 'no_current',
          title: '本轮没有可分析的数据',
          detail: '采集失败或样本不足，无法判断可见度变化。',
          action: '检查引擎密钥与网络，重新跑一轮诊断。',
        },
      ],
      summary: { total: 1, critical: 0, warning: 1, positive: 0 },
    };
  }

  const curSample = current.sample ?? {};
  const prevSample = previous?.sample ?? {};
  const curOk = num(curSample.ok, num(curSample.total, 0));
  const prevOk = num(prevSample.ok, num(prevSample.total, 0));
  const curMention = num(curSample.mentionRate, 0);
  const prevMention = num(prevSample.mentionRate, 0);
  const curScore = num(current.score?.total ?? current.score, 0);
  const prevScore = num(previous?.score?.total ?? previous?.score, 0);
  const curOwn = num(current.citations?.ownShare, 0);
  const prevOwn = num(previous?.citations?.ownShare, 0);

  // 样本不足：先提醒数据可信度
  if (curOk < thresholds.minSamples) {
    alerts.push({
      id: 'low_samples',
      level: 'critical',
      rule: 'low_samples',
      title: `有效样本只有 ${curOk} 条，结论不可用`,
      detail: `阈值要求至少 ${thresholds.minSamples} 条；样本太少时分数波动大，容易误判。`,
      action: '补采（提高题数或换可用引擎），样本够了再看趋势。',
    });
  }

  if (previous && prevOk > 0) {
    const mentionDelta = ptDelta(curMention, prevMention);
    if (mentionDelta <= -thresholds.mentionDropPt) {
      alerts.push({
        id: 'mention_drop',
        level: 'critical',
        rule: 'mention_drop',
        title: `AI 提及率掉了 ${Math.abs(mentionDelta)}pt`,
        detail: `从 ${(prevMention * 100).toFixed(1)}% 降到 ${(curMention * 100).toFixed(1)}%（有效样本 ${curOk}）。`,
        action: '先看「回答浏览器」哪些问题丢了提及，再检查内容与信源是否被竞品覆盖。',
      });
    } else if (mentionDelta >= thresholds.mentionDropPt) {
      alerts.push({
        id: 'mention_gain',
        level: 'positive',
        rule: 'mention_gain',
        title: `AI 提及率涨了 ${mentionDelta}pt`,
        detail: `从 ${(prevMention * 100).toFixed(1)}% 升到 ${(curMention * 100).toFixed(1)}%。`,
        action: '把这轮的内容/信源动作记录下来，复制到其他问题。',
      });
    }

    const scoreDelta = Math.round((curScore - prevScore) * 10) / 10;
    if (previous.score && scoreDelta <= -thresholds.scoreDrop) {
      alerts.push({
        id: 'score_drop',
        level: 'warning',
        rule: 'score_drop',
        title: `可见度总分掉了 ${Math.abs(scoreDelta)} 分`,
        detail: `从 ${prevScore} 降到 ${curScore}。`,
        action: '看驾驶舱的趋势与判定分布，定位是哪个层级/问题在掉。',
      });
    }

    if (prevOwn > 0 && curOwn === 0) {
      alerts.push({
        id: 'own_citation_lost',
        level: 'critical',
        rule: 'own_citation_lost',
        title: '自有站点引用归零',
        detail: `上期自有引用占比 ${(prevOwn * 100).toFixed(1)}%，本期 0%。`,
        action: '检查官网是否可抓取（llms.txt/sitemap/robots），以及内容是否还在被引用。',
      });
    } else if (prevOwn === 0 && curOwn > 0) {
      alerts.push({
        id: 'own_citation_gained',
        level: 'positive',
        rule: 'own_citation_gained',
        title: `自有站点首次被 AI 引用（${(curOwn * 100).toFixed(1)}%）`,
        detail: '这是从 0 到 1 的突破，说明可抓取资产开始生效。',
        action: '继续按同一结构铺同类页面，把占比往上推。',
      });
    }

    const curCompetitors = new Map((current.sov?.competitors ?? []).map((c) => [c.name, num(c.share, 0)]));
    for (const competitor of previous.sov?.competitors ?? []) {
      const now = curCompetitors.get(competitor.name) ?? 0;
      const gain = ptDelta(now, competitor.share);
      if (gain >= thresholds.competitorGainPt) {
        alerts.push({
          id: `competitor_surge:${competitor.name}`,
          level: 'warning',
          rule: 'competitor_surge',
          title: `竞品「${competitor.name}」份额涨了 ${gain}pt`,
          detail: `从 ${(num(competitor.share) * 100).toFixed(1)}% 升到 ${(now * 100).toFixed(1)}%。`,
          action: `针对「${competitor.name}」被引用的那批问题补对比/实测内容。`,
        });
      }
    }

    const curThreats = (current.sameNameThreats ?? []).length;
    if (curThreats > 0) {
      alerts.push({
        id: 'same_name_threat',
        level: 'warning',
        rule: 'same_name_threat',
        title: `仍有 ${curThreats} 处同名实体抢占引用`,
        detail: 'AI 在讲你的品牌名时，可能引的是别家公司。',
        action: '统一「全称+城市+业务词」表述，工商信息挂官网链接。',
      });
    }
  } else if (!previous) {
    alerts.push({
      id: 'baseline_only',
      level: 'info',
      rule: 'baseline',
      title: '首轮基线已建立',
      detail: '还没有上一轮对比，本期只作为基线，不判断涨跌。',
      action: '下周同一时间再跑一轮，就能出异动。',
    });
  }

  const summary = {
    total: alerts.length,
    critical: alerts.filter((a) => a.level === 'critical').length,
    warning: alerts.filter((a) => a.level === 'warning').length,
    positive: alerts.filter((a) => a.level === 'positive').length,
    info: alerts.filter((a) => a.level === 'info').length,
  };
  return { runId, thresholds, alerts, summary };
}

/** 渲染成可推送的 Markdown 简报 */
export function renderAlertsMarkdown(result = {}) {
  const lines = [];
  lines.push(`# 可见度异动简报（run #${result.runId ?? '—'}）`, '');
  const s = result.summary ?? {};
  lines.push(`共 ${s.total ?? 0} 条：严重 ${s.critical ?? 0} · 警告 ${s.warning ?? 0} · 利好 ${s.positive ?? 0} · 提示 ${s.info ?? 0}`, '');
  if (!(result.alerts ?? []).length) {
    lines.push('- 本期无异常。');
    return `${lines.join('\n')}\n`;
  }
  const icon = { critical: '🔴', warning: '🟡', positive: '🟢', info: '⚪' };
  for (const alert of result.alerts) {
    lines.push(`## ${icon[alert.level] ?? '•'} ${alert.title}`);
    lines.push('');
    lines.push(alert.detail);
    lines.push('');
    lines.push(`→ ${alert.action}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/** 是否需要推送（有严重/警告/利好就推，纯提示不打扰） */
export function shouldNotify(result = {}) {
  return (result.alerts ?? []).some((a) => a.level !== 'info');
}
