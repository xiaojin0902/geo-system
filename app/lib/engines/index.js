/**
 * lib/engines/index.js
 * 引擎清单的**唯一常量源**（SPEC §0.1）：采集、评分、报告都只能从这里取引擎。
 *
 * 契约（SPEC §3.3）：
 *   listEngines() -> [{id,label,requiresKey}]
 *   getEngine(id, {env}) -> {id,label,ask(question,{brand,timeoutMs})}
 *   selectEngines(spec, {env}) -> engine[]
 * spec: 'mock' | 'live' | 'all' | 'deepseek,dashscope'
 *   - 'live' 只返回已配置 key 的引擎；一个都没有时抛错并提示填 key / 改用 mock。
 */

import { createMockEngine, MOCK_META } from './mock.js';
import { createDeepseekEngine, DEEPSEEK_META } from './deepseek.js';
import { createDashscopeEngine, DASHSCOPE_META } from './dashscope.js';
import { createDoubaoEngine, DOUBAO_META, doubaoReadiness } from './doubao.js';
import { createKimiEngine, KIMI_META, kimiReadiness } from './kimi.js';
import { createYuanbaoEngine, YUANBAO_META, yuanbaoReadiness } from './yuanbao.js';
import { createCompatEngine } from './compat.js';
import { createAnthropicEngine } from './anthropic.js';
import { PROVIDERS, providerOf, providerReadiness } from './providers.js';
import { pickKey } from './http.js';

/**
 * 引擎清单（唯一常量源）。顺序即报告/控制台的稳定展示顺序。
 * 五个中文引擎 + mock，对应 OmniRank 的通义/DeepSeek/豆包/Kimi/元宝。
 */
const CLAUDE_META = { id: 'claude', label: 'Claude · 联网', requiresKey: true };
const SPECIAL_META = [DEEPSEEK_META, DASHSCOPE_META, DOUBAO_META, KIMI_META, YUANBAO_META, CLAUDE_META];
const specialIds = new Set(SPECIAL_META.map((meta) => meta.id));

/** 兼容供应商的展示名：标注是否支持服务端联网（对话模式 ≠ 搜索可见度） */
function compatLabel(meta) {
  const hasTools = Array.isArray(meta.tools) && meta.tools.length > 0;
  return `${meta.label}${hasTools ? ' · 联网' : ' · 对话'}`;
}

/**
 * 引擎清单（唯一常量源）：mock + 11 家真实引擎。
 * 五家（DeepSeek/通义/豆包/Kimi/元宝）走专用适配器（联网方式各不相同），
 * 其余六家（文心/智谱/混元/MiniMax/Gemini/ChatGPT）走 OpenAI 兼容工厂。
 */
const ENGINE_META = [
  MOCK_META,
  ...SPECIAL_META,
  ...PROVIDERS.filter((meta) => !specialIds.has(meta.id)).map((meta) => ({
    id: meta.id,
    label: compatLabel(meta),
    requiresKey: true,
  })),
];

const SPECIAL_KEY_NAMES = Object.freeze({
  mock: null,
  deepseek: 'DEEPSEEK_API_KEY',
  dashscope: 'DASHSCOPE_API_KEY',
  doubao: 'DOUBAO_API_KEY',
  kimi: 'KIMI_API_KEY',
  yuanbao: 'YUANBAO_API_KEY',
  claude: 'CLAUDE_API_KEY',
});

/** 需要额外配置（模型 ID / 端点）的引擎，给 doctor 与控制台用 */
const EXTRA_READINESS = {
  doubao: doubaoReadiness,
  kimi: kimiReadiness,
  yuanbao: yuanbaoReadiness,
};

/**
 * 引擎是否「配置齐全」——不只是有 Key，豆包还要模型 ID、元宝还要中转地址。
 * @param {string} id
 * @param {Record<string,string|undefined>} [env]
 * @returns {{ready:boolean, reason:string}}
 */
export function engineReadiness(id, env = {}) {
  const check = EXTRA_READINESS[id];
  if (check) return check(env);
  if (id === 'mock') return { ready: true, reason: '' };
  const compatMeta = providerOf(id);
  if (compatMeta) return providerReadiness(compatMeta, env);
  const keyName = SPECIAL_KEY_NAMES[id];
  if (!keyName) return { ready: false, reason: `未知引擎「${id}」` };
  return pickKey(env, keyName)
    ? { ready: true, reason: '' }
    : { ready: false, reason: `未配置 ${keyName}` };
}

function engineIds() {
  return ENGINE_META.map((meta) => meta.id);
}

/**
 * @returns {{id:string,label:string,requiresKey:boolean}[]} 引擎清单（副本，防外部改常量）
 */
export function listEngines() {
  return ENGINE_META.map(({ id, label, requiresKey }) => ({ id, label, requiresKey }));
}

/**
 * 该引擎当前是否已配置 key。mock 永远视为可用。
 * @param {string} id
 * @param {Record<string,string|undefined>} [env]
 */
export function engineHasKey(id, env = {}) {
  return engineReadiness(id, env).ready;
}

/**
 * 取单个引擎实例。未知 id 抛中文错误。
 * @param {string} id
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {Function} [options.fetchImpl] 测试注入（透传给线上引擎）
 */
export function getEngine(id, { env = {}, fetchImpl } = {}) {
  switch (id) {
    case 'mock':
      return createMockEngine();
    case 'deepseek':
      return createDeepseekEngine({ env, fetchImpl });
    case 'dashscope':
      return createDashscopeEngine({ env, fetchImpl });
    case 'doubao':
      return createDoubaoEngine({ env, fetchImpl });
    case 'kimi':
      return createKimiEngine({ env, fetchImpl });
    case 'yuanbao':
      return createYuanbaoEngine({ env, fetchImpl });
    case 'claude': {
      const key = pickKey(env, 'CLAUDE_API_KEY') || pickKey(env, 'ANTHROPIC_API_KEY');
      return createAnthropicEngine({
        meta: CLAUDE_META,
        apiKey: key,
        model: pickKey(env, 'CLAUDE_MODEL') || 'claude-sonnet-4-5',
        fetchImpl,
      });
    }
    default: {
      if (providerOf(id)) return createCompatEngine(id, { env, fetchImpl });
    }
      throw new Error(`未知引擎「${id}」。可用引擎：${engineIds().join('、')}`);
  }
}

/**
 * 按 spec 选引擎。
 * @param {'mock'|'live'|'all'|'demo'|string} spec
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {Function} [options.fetchImpl]
 * @returns {Array<{id:string,label:string,ask:Function}>}
 */
export function selectEngines(spec = 'live', { env = {}, fetchImpl } = {}) {
  const raw = String(spec ?? '').trim().toLowerCase();

  // 缺省按 live（与 CLI --engines 默认值一致）
  if (!raw || raw === 'live') {
    const live = listEngines()
      .filter((meta) => meta.requiresKey && engineHasKey(meta.id, env))
      .map((meta) => getEngine(meta.id, { env, fetchImpl }));
    if (!live.length) {
      throw new Error(
        '没有可用的线上引擎：未配置 DEEPSEEK_API_KEY / DASHSCOPE_API_KEY。' +
          '请在 app/.env 填写密钥后重试，或改用 --engines mock 先跑通流程。',
      );
    }
    return live;
  }

  if (raw === 'mock' || raw === 'demo') {
    return [getEngine('mock', { env, fetchImpl })];
  }

  // all = mock + 已配置 key 的线上引擎（没 key 时不报错，保证流程可跑）
  if (raw === 'all') {
    const engines = [getEngine('mock', { env, fetchImpl })];
    for (const meta of listEngines()) {
      if (!meta.requiresKey) continue;
      if (!engineHasKey(meta.id, env)) continue;
      engines.push(getEngine(meta.id, { env, fetchImpl }));
    }
    return engines;
  }

  // 逗号分隔的显式列表：'deepseek,dashscope'（顺序即返回顺序）
  const requested = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!requested.length) {
    throw new Error('--engines 未提供有效引擎。可用取值：mock、live、all 或逗号分隔的引擎 id。');
  }

  const valid = new Set(engineIds());
  const engines = [];
  for (const id of requested) {
    if (!valid.has(id)) {
      throw new Error(`未知引擎「${id}」。可用引擎：${engineIds().join('、')}`);
    }
    if (engines.some((engine) => engine.id === id)) continue; // 去重，保留首次顺序
    engines.push(getEngine(id, { env, fetchImpl }));
  }
  return engines;
}

export { MOCK_META, DEEPSEEK_META, DASHSCOPE_META, DOUBAO_META, KIMI_META, YUANBAO_META };
