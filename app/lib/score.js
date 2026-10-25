/**
 * lib/score.js
 * 漏斗评分层（SPEC §3.5）：三层权重 20/40/40，纯规则可复算。
 *
 * 红线：
 *  - 只统计 answers.status === 'ok' 的回答；
 *  - 判定为 unknown / ambiguous / refused / engine_error 的回答**不进分母**（也不记 0 分），
 *    只计入 coverage.excluded；
 *  - 覆盖率 < 50% 或有效层数 < 2 时不出总分，等级为「样本不足」。
 *
 * 注意口径：coverage.ok 以**采集状态**为准（status==='ok' 的回答条数），
 * 而各层分母是**有效判定**条数（排除 unknown/ambiguous/… 之后），两者不同。
 */

/** 三层权重（合计 100）。 */
export const LAYERS = Object.freeze({
  awareness: 20,
  decision: 40,
  scenario: 40,
});

const LAYER_KEYS = Object.freeze(Object.keys(LAYERS));

/** verdict → 命中分（0-1）。 */
const HIT_SCORE = Object.freeze({
  recommended: 1.0,
  conditionally_recommended: 0.85,
  candidate: 0.55,
  listed: 0.7,
  mentioned: 0.4,
  not_mentioned: 0,
});

/** 这些判定不算「有效题」，不进任何层的分母。 */
const EXCLUDED_VERDICTS = Object.freeze(['unknown', 'ambiguous', 'refused', 'engine_error']);

const MIN_COVERAGE_RATIO = 0.5;
const MIN_LAYERS_FOR_TOTAL = 2;

/**
 * 题目的 tier → 评分层。
 * @param {string} tier
 * @returns {'awareness'|'decision'|'scenario'}
 */
export function tierToLayer(tier) {
  if (tier === 'brand_awareness') return 'awareness';
  if (tier === 'regional_industry') return 'decision';
  if (tier === 'super_tier1') return 'scenario';
  return 'decision';
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function emptyLayerState() {
  return { ok: 0, hits: 0, weighted: 0, score: null };
}

/**
 * 按「等级阈值」把总分映射为等级（SPEC §3.5）。
 * @param {number|null} total
 * @returns {string}
 */
export function totalToLevel(total) {
  if (total === null || total === undefined || Number.isNaN(Number(total))) return '样本不足';
  if (total >= 85) return '领先';
  if (total >= 70) return '良好';
  if (total >= 55) return '中等';
  if (total >= 40) return '偏弱';
  if (total >= 25) return '落后';
  return '隐形';
}

/**
 * 计算一次 run 的三层得分与总分。
 * @param {object} input
 * @param {Array<{question?:{tier?:string}, answer?:{status?:string}, judgment?:{verdict?:string}}>} [input.rows]
 * @param {number} [input.plannedN] 计划样本数（题目数 × 引擎数），缺省用 rows.length
 * @returns {{
 *   layers: Record<'awareness'|'decision'|'scenario', {ok:number,hits:number,weighted:number,score:number|null}>,
 *   total: number|null,
 *   level: string,
 *   coverage: {planned:number, ok:number, ratio:number, excluded:{unknown:number,ambiguous:number,refused:number,engine_error:number,unavailable:number,missing:number,total:number}},
 *   reasons: string[]
 * }}
 */
export function scoreRun({ rows = [], plannedN } = {}) {
  const rowList = Array.isArray(rows) ? rows : [];
  const planned =
    Number.isFinite(Number(plannedN)) && Number(plannedN) > 0 ? Math.floor(Number(plannedN)) : rowList.length;

  const layers = {};
  for (const key of LAYER_KEYS) layers[key] = emptyLayerState();

  const excluded = {
    unknown: 0,
    ambiguous: 0,
    refused: 0,
    engine_error: 0,
    unavailable: 0,
    missing: 0,
    total: 0,
  };

  const coverage = { planned, ok: 0, ratio: 0, excluded };

  for (const row of rowList) {
    const answer = row && row.answer ? row.answer : null;
    const judgment = row && row.judgment ? row.judgment : null;
    const status = answer ? answer.status : undefined;

    // 采集失败/拒答/不可用：不进分母
    if (status !== 'ok') {
      if (status === 'refused') excluded.refused += 1;
      else if (status === 'engine_error') excluded.engine_error += 1;
      else if (status === 'unavailable') excluded.unavailable += 1;
      else excluded.missing += 1;
      continue;
    }

    coverage.ok += 1;

    const verdict = judgment ? judgment.verdict : undefined;

    // 判定层排除项：不进分母，也不记 0 分
    if (verdict === 'unknown' || verdict === 'ambiguous' || verdict === 'refused' || verdict === 'engine_error') {
      excluded[verdict] += 1;
      continue;
    }

    // 判定缺失或非法：按 missing 排除，避免默默记 0 分
    if (!Object.prototype.hasOwnProperty.call(HIT_SCORE, verdict)) {
      excluded.missing += 1;
      continue;
    }

    const tier = (row.question && row.question.tier) || (row && row.tier);
    const layerKey = tierToLayer(tier);
    const layer = layers[layerKey];
    const hit = HIT_SCORE[verdict];
    layer.ok += 1;
    layer.weighted += hit;
    if (hit > 0) layer.hits += 1;
  }

  excluded.total =
    excluded.unknown +
    excluded.ambiguous +
    excluded.refused +
    excluded.engine_error +
    excluded.unavailable +
    excluded.missing;

  const reasons = [];

  // 1) 各层得分
  for (const key of LAYER_KEYS) {
    const layer = layers[key];
    const weight = LAYERS[key];
    if (layer.ok === 0) {
      layer.score = null;
      reasons.push(`${key} 层：无有效样本，不计分（不按 0 分处理）`);
      continue;
    }
    const weighted = round(layer.weighted, 3);
    layer.weighted = weighted;
    layer.score = round(clamp((weighted / layer.ok) * weight, 0, weight), 1);
    reasons.push(
      `${key} 层：命中权重和 ${weighted} / 有效题数 ${layer.ok} × 层权重 ${weight} = ${layer.score}`,
    );
  }

  // 2) 覆盖率（以采集为准）
  const ratio = planned > 0 ? round(clamp(coverage.ok / planned, 0, 1), 3) : 0;
  coverage.ratio = ratio;
  reasons.push(
    `覆盖率：采集成功 ${coverage.ok} 条 / 计划 ${planned} 条 = ${round(ratio * 100, 1)}%（覆盖率口径只看采集是否成功）`,
  );

  if (excluded.total > 0) {
    reasons.push(
      `已排除 ${excluded.total} 条（不进分母，也不记 0 分）：` +
        `unknown ${excluded.unknown}、ambiguous ${excluded.ambiguous}、refused ${excluded.refused}、` +
        `engine_error ${excluded.engine_error}、unavailable ${excluded.unavailable}、missing ${excluded.missing}`,
    );
  }

  // 3) 总分：覆盖率 ≥ 50% 且至少两层有有效样本，才按可用层权重归一到 100 分制
  const available = LAYER_KEYS.filter((key) => layers[key].score !== null);

  let total = null;
  if (ratio < MIN_COVERAGE_RATIO) {
    reasons.push(
      `覆盖率 ${round(ratio * 100, 1)}% < ${MIN_COVERAGE_RATIO * 100}%，不出总分（没测成 ≠ 0 分），等级=样本不足`,
    );
  } else if (available.length < MIN_LAYERS_FOR_TOTAL) {
    reasons.push(
      `仅有 ${available.length} 层有有效样本（至少需 ${MIN_LAYERS_FOR_TOTAL} 层），不出总分，等级=样本不足`,
    );
  } else {
    const sumScores = available.reduce((sum, key) => sum + layers[key].score, 0);
    const sumWeights = available.reduce((sum, key) => sum + LAYERS[key], 0);
    total = round(clamp((sumScores / sumWeights) * 100, 0, 100), 1);
    reasons.push(
      `总分：可用层得分和 ${round(sumScores, 1)} / 可用层权重和 ${sumWeights} × 100 = ${total}（按可用层权重归一）`,
    );
  }

  return {
    layers,
    total,
    level: totalToLevel(total),
    coverage,
    reasons,
  };
}
