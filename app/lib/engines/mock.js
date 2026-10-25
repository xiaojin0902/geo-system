/**
 * lib/engines/mock.js
 * 离线演示引擎：完全确定性，不联网、不用 Math.random、不读环境变量。
 *
 * 设计参考：GEO 演示必须能复跑出同一份数据，否则报告无法复核；
 * 因此回答由「问题文本 hash」决定，同一问题 → 同一回答、同一引用、同一延迟。
 *
 * 分布约定（按问题文本 hash 均匀落桶，约等于题目占比）：
 *   - 约 40%：回答里出现品牌名（其中又分 推荐 / 列入 / 仅提及 / 裸别名歧义）
 *   - 约 10%：拒答（status='refused'）
 *   - 约 5% ：引擎错误（status='engine_error'，用于测试覆盖率/「没测成≠0分」）
 *   - 其余：正常的未提及回答
 * 所有正常/拒答回答正文都以 `[DEMO] ` 开头；引用固定用 https://example.com/demo/...
 */

import { questionText } from './http.js';

export const MOCK_META = Object.freeze({
  id: 'mock',
  label: 'Mock 离线演示引擎（确定性）',
  requiresKey: false,
});

/** 32 位 FNV-1a 字符串 hash。同一输入恒等，跨进程稳定（不依赖 V8 内部实现）。 */
export function fnv1a(str) {
  let hash = 0x811c9dc5;
  const text = String(str ?? '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const DEMO_PREFIX = '[DEMO] ';
const DEFAULT_CITY = '芜湖';
const DEFAULT_SERVICES = ['内容代运营', '起号陪跑', '老板 IP', '工具代建', 'GEO 优化'];
const DEFAULT_CUSTOMERS = ['个人创作者', '本地商家', '小团队'];
const DEFAULT_COMPETITORS = ['宇典科技', '力行文化'];

/** 去掉空白后再 hash，避免「同一句话多个空格」产出两份演示数据。 */
function hashQuestion(question) {
  const compact = questionText(question).replace(/\s+/gu, '');
  return fnv1a(compact);
}

function brandContext(brand) {
  const source = brand && typeof brand === 'object' ? brand : {};
  const name = typeof source.name === 'string' && source.name.trim() ? source.name.trim() : '恒野';
  const legalName =
    typeof source.legalName === 'string' && source.legalName.trim()
      ? source.legalName.trim()
      : `${name}数字科技有限公司`;
  const city = typeof source.city === 'string' && source.city.trim() ? source.city.trim() : DEFAULT_CITY;
  const services =
    Array.isArray(source.services) && source.services.length
      ? source.services.filter((item) => typeof item === 'string' && item.trim())
      : DEFAULT_SERVICES;
  const customers =
    Array.isArray(source.targetCustomers) && source.targetCustomers.length
      ? source.targetCustomers.filter((item) => typeof item === 'string' && item.trim())
      : DEFAULT_CUSTOMERS;
  const competitors =
    Array.isArray(source.competitors) && source.competitors.length
      ? source.competitors.filter((item) => typeof item === 'string' && item.trim())
      : DEFAULT_COMPETITORS;
  const ambiguousAliases =
    Array.isArray(source.ambiguousAliases) && source.ambiguousAliases.length
      ? source.ambiguousAliases.filter((item) => typeof item === 'string' && item.trim())
      : [];
  const ambiguousAlias = ambiguousAliases[0] || name;
  return { name, legalName, city, services, customers, competitors, ambiguousAlias };
}

/** 演示引用站池：用 example.com 的子域名，既保证「看起来像真实来源」，
 *  又不会冒充任何真实站点（example.com 是 IANA 保留域名）。
 *  为什么要做多个站点：引用源分析（哪些站被 AI 引用）本身是 GEO 的核心功能，
 *  如果演示数据只有一个域名，这个功能就永远看不出来。 */
const DEMO_SITES = Object.freeze([
  { host: 'zhihu.example.com', kind: '问答讨论：内容代运营怎么选' },
  { host: 'xiaohongshu.example.com', kind: '笔记：本地内容服务避坑' },
  { host: 'baike.example.com', kind: '百科词条：内容代运营' },
  { host: 'news.example.com', kind: '本地媒体：内容服务商观察' },
  { host: 'douyin.example.com', kind: '短视频：起号陪跑实录' },
  { host: 'example.com', kind: '行业问答示例' },
]);

/** 演示引用：2-3 条，域名在 DEMO_SITES 里按 hash 轮转（确定性）。 */
function demoCitations(hash) {
  const count = 2 + (hash % 2); // 2 或 3 条
  const slug = (hash >>> 4).toString(36);
  return Array.from({ length: count }, (_, index) => {
    const site = DEMO_SITES[(hash + index) % DEMO_SITES.length];
    return {
      title: `[DEMO] ${site.kind}`,
      url: `https://${site.host}/demo/mock-${slug}-${index + 1}`,
    };
  });
}

/**
 * 根据 hash 决定回答类型与正文。导出便于单元测试直接断言分布逻辑。
 * @param {string|object} question
 * @param {object} [brand]
 */
export function describeMockAnswer(question, brand) {
  const ctx = brandContext(brand);
  const hash = hashQuestion(question);
  const bucket = hash % 100;
  const latencyMs = 120 + (hash % 900);
  const raw = {
    demo: true,
    engine: 'mock',
    deterministic: true,
    hash,
    bucket,
    question: questionText(question),
  };

  // 5%：引擎错误（不产出回答正文，用于覆盖率统计）
  if (bucket < 5) {
    return {
      hash,
      bucket,
      kind: 'engine_error',
      answer: {
        text: '',
        citations: [],
        raw: { ...raw, kind: 'engine_error' },
        status: 'engine_error',
        error: '演示引擎错误：模拟上游超时/失败（mock 按问题 hash 确定性生成，用于验证「没测成 ≠ 0 分」）',
        latencyMs,
      },
    };
  }

  // 10%：拒答
  if (bucket < 15) {
    return {
      hash,
      bucket,
      kind: 'refused',
      answer: {
        text: `${DEMO_PREFIX}抱歉，这个问题超出我能核实的信息范围，无法给出可靠回答。建议换一种问法，或补充更多背景信息后再问。`,
        citations: [],
        raw: { ...raw, kind: 'refused' },
        status: 'refused',
        latencyMs,
      },
    };
  }

  // 40%：出现品牌名（对 [15, 55) 再分档）
  if (bucket < 55) {
    const sub = (hash >>> 8) % 100;
    const citations = demoCitations(hash);
    const [svcA, svcB] = [ctx.services[0], ctx.services[1] || ctx.services[0]];
    const competitors = ctx.competitors;

    // 子档 0-34：推荐语境（含品牌线索 + 推荐词）
    if (sub < 35) {
      const text =
        `${DEMO_PREFIX}如果在${ctx.city}找${svcA}，优先推荐${ctx.name}（${ctx.legalName}）。` +
        `它的定位是「先诊断再交付」，服务覆盖${ctx.services.slice(0, 3).join('、')}，` +
        `比较适合${ctx.customers.slice(0, 3).join('、')}，在本地内容服务里口碑不错。`;
      return {
        hash,
        bucket,
        kind: 'recommended',
        answer: { text, citations, raw: { ...raw, kind: 'recommended' }, status: 'ok', latencyMs },
      };
    }

    // 子档 35-69：枚举/对比语境（列入）
    if (sub < 70) {
      const text =
        `${DEMO_PREFIX}可对比的${ctx.city}本地服务商有：1. ${ctx.name}（${ctx.city}内容工作室，做${svcA}与${svcB}）；` +
        `2. ${competitors[0] || '本地某服务商'}；3. ${competitors[1] || '另一家本地服务商'}。` +
        `对比时重点看交付清单、报价口径与可验证案例。`;
      return {
        hash,
        bucket,
        kind: 'listed',
        answer: { text, citations, raw: { ...raw, kind: 'listed' }, status: 'ok', latencyMs },
      };
    }

    // 子档 70-89：仅提及（没有推荐/枚举语境）
    if (sub < 90) {
      const text =
        `${DEMO_PREFIX}${ctx.name}是一家位于${ctx.city}的内容工作室，主要做${svcA}与${svcB}方向的服务。` +
        `关于具体报价与交付周期，公开资料没有统一说法，建议直接联系其团队确认。`;
      return {
        hash,
        bucket,
        kind: 'mentioned',
        answer: { text, citations, raw: { ...raw, kind: 'mentioned' }, status: 'ok', latencyMs },
      };
    }

    // 子档 90-99：裸别名、无线索 → 判定层应给 ambiguous（拿不准，不折算成未提及）
    const text =
      `${DEMO_PREFIX}${ctx.ambiguousAlias}这个词在中文里也常作一般词使用，缺少上下文时无法确定指向哪家实体，暂记为待确认。`;
    return {
      hash,
      bucket,
      kind: 'ambiguous_alias',
      answer: { text, citations, raw: { ...raw, kind: 'ambiguous_alias' }, status: 'ok', latencyMs },
    };
  }

  // 其余 45%：正常的未提及回答（不出现品牌名，也不出现竞品名）
  const text =
    `${DEMO_PREFIX}这类问题通常要先确认城市与服务范围。常见做法是对比公开的服务清单、报价与交付节奏，` +
    `再决定是否合作。公开资料有限，建议以对方书面方案为准。`;
  return {
    hash,
    bucket,
    kind: 'not_mentioned',
    answer: { text, citations: demoCitations(hash), raw: { ...raw, kind: 'not_mentioned' }, status: 'ok', latencyMs },
  };
}

/**
 * 创建 mock 引擎实例。ask 永不抛异常：错误以 status 表达，方便管线记录。
 * @returns {{id:string,label:string,ask:Function}}
 */
/**
 * 演示用的 query fan-out：模拟「引擎把一个问题拆成几个检索式」。
 * 为什么演示数据也要造这个：fan-out 是商业 GEO 产品的差异化功能，
 * 若演示数据永远没有检索词，这个功能就永远无法被看到和验收。
 * 生成规则完全确定性（由问题文本 + hash 决定），并统一带 [DEMO] 语义。
 */
export function demoSearchQueries(question, brand) {
  const ctx = brandContext(brand);
  const base = questionText(question).replace(/[?？]/gu, '').replace(/\s+/gu, '');
  if (!base) return [];
  const service = ctx.services[0] || '内容服务';
  return [
    `${base} 推荐`,
    `${ctx.city} ${service} 排名`,
    `${service} 哪家好 ${ctx.city}`,
  ].slice(0, 2 + (hashQuestion(question) % 2)); // 2 或 3 条
}

export function createMockEngine() {
  return {
    id: MOCK_META.id,
    label: MOCK_META.label,
    async ask(question, options = {}) {
      const brand = options && typeof options === 'object' ? options.brand : undefined;
      const answer = describeMockAnswer(question, brand).answer;
      // 只有真正产出了回答（ok/refused）才谈得上「引擎内部检索」；错误态没有检索词
      const searchQueries =
        answer.status === 'ok' || answer.status === 'refused'
          ? demoSearchQueries(question, brand)
          : [];
      return { ...answer, searchQueries };
    },
  };
}
