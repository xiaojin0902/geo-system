/**
 * lib/engines/providers.js
 * 「OpenAI 兼容协议」供应商注册表：一次配置，接出多家 AI 引擎。
 *
 * 为什么用注册表而不是每家大写一个适配器：
 * 摘星AI 宣称覆盖 11 大模型，这类覆盖本质是「同一套采集逻辑 + 不同的端点/模型/联网开关」。
 * 把差异收敛成配置，新增一家只要加一行，采集、判定、分析、报告全部自动继承。
 *
 * 诚实原则（重要）：
 *   tools 只在厂商确实支持服务端联网检索时才声明；不支持的引擎 mode 会落成 memory，
 *   报告里能看出「这一家是模型记忆，不是搜索可见度」，绝不冒充。
 */

export const PROVIDERS = Object.freeze([
  {
    id: 'deepseek',
    label: 'DeepSeek',
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com/chat/completions',
    keyEnv: 'DEEPSEEK_API_KEY',
    modelEnv: 'DEEPSEEK_MODEL',
    defaultModel: 'deepseek-chat',
    note: '深度求索；联网检索走专用适配器（Responses API）',
    custom: 'deepseek',
  },
  {
    id: 'dashscope',
    label: '通义千问',
    provider: 'dashscope',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    keyEnv: 'DASHSCOPE_API_KEY',
    modelEnv: 'DASHSCOPE_MODEL',
    defaultModel: 'qwen-plus',
    note: '阿里百炼；联网走 enable_search',
    custom: 'dashscope',
  },
  {
    id: 'doubao',
    label: '豆包',
    provider: 'doubao',
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    keyEnv: 'DOUBAO_API_KEY',
    altKeyEnv: 'ARK_API_KEY',
    modelEnv: 'DOUBAO_MODEL',
    requiresModel: true,
    defaultModel: '',
    tools: [{ type: 'web_search' }],
    note: '火山方舟；DOUBAO_MODEL 填推理接入点 ID',
    custom: 'doubao',
  },
  {
    id: 'kimi',
    label: 'Kimi',
    provider: 'kimi',
    endpoint: 'https://api.moonshot.cn/v1/chat/completions',
    keyEnv: 'KIMI_API_KEY',
    altKeyEnv: 'MOONSHOT_API_KEY',
    modelEnv: 'KIMI_MODEL',
    defaultModel: 'kimi-k2-0905-preview',
    tools: [{ type: 'builtin_function', function: { name: '$web_search' } }],
    note: '月之暗面；内置 $web_search',
    custom: 'kimi',
  },
  {
    id: 'yuanbao',
    label: '腾讯元宝',
    provider: 'yuanbao',
    endpoint: '',
    keyEnv: 'YUANBAO_API_KEY',
    baseUrlEnv: 'YUANBAO_BASE_URL',
    modelEnv: 'YUANBAO_MODEL',
    defaultModel: 'yuanbao',
    note: '无官方对话 API，需 OpenAI 兼容中转地址',
    custom: 'yuanbao',
  },
  {
    id: 'wenxin',
    label: '文心一言',
    provider: 'wenxin',
    endpoint: 'https://qianfan.baidubce.com/v2/chat/completions',
    keyEnv: 'QIANFAN_API_KEY',
    modelEnv: 'QIANFAN_MODEL',
    defaultModel: 'ernie-4.5-turbo-128k',
    tools: [{ type: 'web_search' }],
    note: '百度千帆 v2（OpenAI 兼容）；支持 web_search 工具',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    provider: 'zhipu',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    keyEnv: 'ZHIPU_API_KEY',
    modelEnv: 'ZHIPU_MODEL',
    defaultModel: 'glm-4-plus',
    tools: [{ type: 'web_search', web_search: { enable: true } }],
    note: '智谱开放平台；支持 web_search 工具',
  },
  {
    id: 'hunyuan',
    label: '腾讯混元',
    provider: 'hunyuan',
    endpoint: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions',
    keyEnv: 'HUNYUAN_API_KEY',
    modelEnv: 'HUNYUAN_MODEL',
    defaultModel: 'hunyuan-turbos-latest',
    note: '腾讯混元（OpenAI 兼容）；联网能力按账号开通情况',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    provider: 'minimax',
    endpoint: 'https://api.minimax.chat/v1/text/chatcompletion_v2',
    keyEnv: 'MINIMAX_API_KEY',
    modelEnv: 'MINIMAX_MODEL',
    defaultModel: 'MiniMax-Text-01',
    note: 'MiniMax（OpenAI 兼容）',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    provider: 'google',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    keyEnv: 'GEMINI_API_KEY',
    modelEnv: 'GEMINI_MODEL',
    defaultModel: 'gemini-2.5-flash',
    note: 'Google（OpenAI 兼容端点）；搜索接地需另走原生 API',
  },
  {
    id: 'openai',
    label: 'ChatGPT',
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    defaultModel: 'gpt-4o-mini',
    note: 'OpenAI；真实联网检索需 Responses API（本适配器为对话模式）',
  },
]);

/** 按 id 取配置 */
export function providerOf(id) {
  return PROVIDERS.find((item) => item.id === id) ?? null;
}

/** 某家是否配置齐全（key + 必要模型/中转地址） */
export function providerReadiness(meta, env = {}) {
  const pick = (name) => (name ? String(env?.[name] ?? '').trim() : '');
  const key = pick(meta.keyEnv) || pick(meta.altKeyEnv);
  if (!key) return { ready: false, reason: `未配置 ${meta.keyEnv}${meta.altKeyEnv ? '（或 ' + meta.altKeyEnv + '）' : ''}` };
  if (meta.baseUrlEnv && !pick(meta.baseUrlEnv)) {
    return { ready: false, reason: `未配置 ${meta.baseUrlEnv}（该引擎无官方 API，需要中转地址）` };
  }
  if (meta.requiresModel && !pick(meta.modelEnv)) {
    return { ready: false, reason: `未配置 ${meta.modelEnv}（需要填模型 ID / 推理接入点 ID）` };
  }
  return { ready: true, reason: '' };
}
