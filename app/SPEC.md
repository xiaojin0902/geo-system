# 恒野 GEO 自研版 · 模块契约（SPEC）

> 目标：不复制 OmniRank 代码与提示词，只沿用其**设计结论**，用 Node 22 + SQLite 零依赖重写一套恒野自用的 GEO 流水线。
> 覆盖：诊断（采集→判定→评分→报告）→ 关键词挖掘 → 内容 brief → 发布记录 → 监测对比。
> 运行环境：Node ≥ 22.5（`node:sqlite`），无 npm 依赖，`node --test` 跑测试。
> 目录：`hengye-geo/app/`。本文件是唯一接口约定，各方按此实现，不要私自改签名。

## 0. 设计红线（来自 OmniRank 拆解，必须遵守）

1. **引擎清单唯一常量源**：所有地方（采集/评分/报告）只能从 `lib/engines/index.js` 的 `listEngines()` 取，禁止硬编码引擎名。
2. **判定不交给大模型拍板**：先确定性匹配（正式名/别名/否决名），拿不准就是 `unknown`，绝不折算成 `not_mentioned`。LLM 只在有 key 时做**边界复核**，且必须结构化输出。
3. **"没测成"≠"0 分"**：`engine_error` / `refused` / `unknown` 不进分母，只进覆盖率；覆盖率 < 50% 不出总分。
4. **评分纯规则可复算**：三层权重 20/40/40，`层得分 = 命中权重和 / 有效题数 × 层权重`；中间量必须落库。
5. **证据优先**：内容 brief 里必须列出「必须引用的可验证事实」和「禁用绝对化用语」，没有证据不许编数字/案例/资质。
6. **demo 与 live 分开**：演示数据标记 `kind='demo'`，报告顶部显著标注「DEMO 演示数据」，绝不冒充真实 AI 回答。
7. 许可证：本实现为自研，不复制 OmniRank 源码/提示词原文；引用其设计结论时在注释里注明"设计参考"。

## 1. 目录与文件归属

```
hengye-geo/app/
  SPEC.md                  # 本文件（Lead 维护）
  package.json             # Lead 建
  bin/geo.js               # pipeline-store 负责
  lib/config.js            # pipeline-store 负责
  lib/store.js             # pipeline-store 负责（SQLite schema + DAO）
  lib/engines/index.js     # engine-core 负责
  lib/engines/http.js      # engine-core
  lib/engines/deepseek.js  # engine-core
  lib/engines/dashscope.js # engine-core
  lib/engines/mock.js      # engine-core（离线演示，确定性）
  lib/judge.js             # engine-core
  lib/score.js             # engine-core
  lib/engines/parse.js     # engine-core（各家检索响应的统一解析）
  lib/views.js             # 控制台视图（纯函数）
  lib/server.js            # 本地控制台服务（零依赖 http）
  lib/doctor.js            # 环境自检
  lib/audit-site.js        # 官网 AI 可抓取性体检
  lib/keywords.js          # content-brief 负责
  lib/brief.js             # content-brief
  lib/report.js            # content-brief
  brands/hengye.json       # Lead
  data/                    # 运行时生成（db/reports），不入库
  tests/*.test.js          # 各自负责自己模块的测试
```

## 2. 数据模型（SQLite，`lib/store.js` 实现）

```sql
brands(id INTEGER PK, slug TEXT UNIQUE, name TEXT, legal_name TEXT, aliases_json TEXT,
       rejected_json TEXT, city TEXT, scope TEXT, industry TEXT, competitors_json TEXT,
       services_json TEXT, urls_json TEXT, created_at TEXT)
questions(id INTEGER PK, brand_id INT, text TEXT, intent TEXT, tier TEXT, priority TEXT,
          source TEXT, created_at TEXT, UNIQUE(brand_id, text))
runs(id INTEGER PK, brand_id INT, kind TEXT, engine_set TEXT, planned_n INT, ok_n INT,
     status TEXT, started_at TEXT, finished_at TEXT)
answers(id INTEGER PK, run_id INT, question_id INT, engine TEXT, answer_text TEXT,
        citations_json TEXT, status TEXT, latency_ms INT, created_at TEXT)
judgments(id INTEGER PK, answer_id INT UNIQUE, verdict TEXT, matched_text TEXT, method TEXT,
          confidence REAL, reasons_json TEXT, created_at TEXT)
scores(id INTEGER PK, run_id INT UNIQUE, layers_json TEXT, total REAL, level TEXT,
       coverage_json TEXT, created_at TEXT)
keywords(id INTEGER PK, brand_id INT, term TEXT, cluster TEXT, intent TEXT, difficulty INT,
         priority TEXT, note TEXT, created_at TEXT, UNIQUE(brand_id, term))
contents(id INTEGER PK, brand_id INT, keyword_id INT, question_id INT, title TEXT,
         format TEXT, status TEXT, brief_json TEXT, body_md TEXT, created_at TEXT)
publications(id INTEGER PK, content_id INT, channel TEXT, url TEXT, status TEXT, created_at TEXT)
monitoring(id INTEGER PK, brand_id INT, question_id INT, engine TEXT, verdict TEXT,
           checked_at TEXT, run_id INT)
```

枚举：

- `runs.kind`: `demo` | `live`
- `answers.status`: `ok` | `engine_error` | `refused` | `unavailable`
- `judgments.verdict`: `recommended` | `listed` | `mentioned` | `not_mentioned` | `ambiguous` | `unknown` | `refused` | `engine_error`
- `score.level`: `领先` | `良好` | `中等` | `偏弱` | `落后` | `隐形` | `样本不足`

## 3. 模块接口

### 3.1 `lib/config.js`

```js
export const APP_ROOT;            // <绝对路径>/hengye-geo/app
export const DATA_DIR;            // APP_ROOT/data
export function loadEnv(extra = {});   // 读 app/.env → process.env（不覆盖已有值），返回 {DEEPSEEK_API_KEY?, DASHSCOPE_API_KEY?}
export function dbPath();         // DATA_DIR/geo.db
export function brandPath(slug);  // APP_ROOT/brands/<slug>.json
```

### 3.2 `lib/store.js`

```js
export function openStore(path = dbPath());   // 返回 Store；内部执行 initSchema
Store.initSchema()
Store.close()
Store.upsertBrand(brand) -> brandId          // brand 见 §4
Store.getBrand(slug) -> brand|null           // 反序列化 aliases/rejected/competitors/services/urls
Store.listBrands() -> brand[]
Store.seedQuestions(brandId, questions) -> n // questions: [{text,intent,tier,priority,source}]
Store.listQuestions(brandId, {priority} = {}) -> question[]
Store.createRun({brandId, kind, engineSet, plannedN}) -> runId
Store.finishRun(runId, {status, okN})
Store.saveAnswer({runId, questionId, engine, text, citations, status, latencyMs}) -> answerId
Store.saveJudgment(answerId, judgment)        // judgment: {verdict, matchedText, method, confidence, reasons}
Store.saveScore(runId, score)                 // score: {layers, total, level, coverage}
Store.getRun(runId) -> run|null
Store.getRunDetail(runId) -> {run, brand, rows:[{question, answer, judgment}]}
Store.listRuns(brandId, limit = 20)
Store.upsertKeyword(brandId, kw) -> id        // kw: {term, cluster, intent, difficulty, priority, note}
Store.listKeywords(brandId, {priority} = {})
Store.createContent({brandId, keywordId, questionId, title, format, status, brief, bodyMd}) -> id
Store.listContents(brandId)
Store.updateContentStatus(id, status)
Store.createPublication({contentId, channel, url, status}) -> id
Store.saveMonitoringCheck({brandId, questionId, engine, verdict, runId})
Store.monitoringTrend(brandId, days = 30) -> [{questionText, engine, checks:[{checkedAt, verdict}]}]
```

约定：所有时间用 ISO 字符串；JSON 字段用 `JSON.stringify` 存 TEXT；DAO 不做业务判断。

### 3.3 `lib/engines/*`

```js
// index.js
export function listEngines() -> [{id, label, requiresKey}]   // id: 'mock'|'deepseek'|'dashscope'
export function getEngine(id, {env = {}} = {}) -> {
  id, label,
  async ask(question, {brand, timeoutMs = 60000} = {})
}
export function selectEngines(spec, {env = {}} = {}) -> engine[]
// spec: 'mock' | 'live' | 'all' | 'deepseek,dashscope'
// 'live' 只返回已配置 key 的引擎；一个都没有时抛错提示填 key

// ask 返回：{text, citations:[{title,url}], raw, status:'ok'|'refused'|'engine_error'|'unavailable', error?, latencyMs}
```

实现要求：

- `deepseek.js`：OpenAI 兼容 `POST https://api.deepseek.com/chat/completions`，模型 `deepseek-chat`；`DEEPSEEK_API_KEY`；超时 60s；无 key → `status:'unavailable'`（不抛异常，方便管线记录）。
- `dashscope.js`：`POST https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`，模型 `qwen-plus`；`DASHSCOPE_API_KEY`；可选联网搜索参数 `extra_body:{enable_search:true}`；同样无 key → unavailable。
- `mock.js`：**确定性**演示引擎，不需网络；根据问题文本 hash 产出稳定回答，约 40% 题目里会出现品牌名（部分带「推荐」上下文的推荐位，部分仅提及），10% 题目返回拒答，5% 返回 engine_error（可测覆盖率）；回答正文包含 2-3 条假引用 `{title,url}`，URL 用 `https://example.com/demo/...`。**回答开头必须带 `[DEMO]` 前缀**，方便判定层与报告识别。
- `http.js`：`postJson(url, {headers, body, timeoutMs})` + 重试（网络错误重试 2 次，指数退避）。

### 3.4 `lib/judge.js`

```js
export const VERDICTS = [...];
export function judgeAnswer({text, status, brand, engineId}) -> {
  verdict, matchedText, method:'exact'|'legal_suffix'|'rejected'|'heuristic'|'fallback',
  confidence, reasons:[string]
}
```

规则：

1. `status === 'engine_error'` → `engine_error`；`'refused'` → `refused`；`'unavailable'` → `engine_error`（reason 注明 unavailable）。
2. 空文本 → `unknown`。
3. 归一化（全角→半角、去空白、小写）后按顺序：`rejected` 名单命中 → `not_mentioned`（method='rejected'）；正式名/别名精确命中 → 继续判推荐档位；命中不到 → 若回答含 `[DEMO]` 或无品牌可能则 `not_mentioned`。
4. 推荐档位启发式（明确写进 reasons，便于复核）：
   - 命中位置前后 40 字内出现「推荐/首选/第一/排名 TOP/值得/靠谱/榜单」→ `recommended`
   - 出现在枚举/对比/列表语境（前后 40 字有「、」「1.」「2.」或「对比/类似/也可以」）→ `listed`
   - 其余命中 → `mentioned`
5. 别名本身是常见词（brand.ambiguousAliases 里声明的，如"恒野"这种需要上下文才指品牌的词）且命中处上下文没有任何品牌线索 → `ambiguous`（拿不准就 UNKNOWN，不折算）。

### 3.5 `lib/score.js`

```js
export const LAYERS = { awareness: 20, decision: 40, scenario: 40 };
export function tierToLayer(tier) // 'brand_awareness'→awareness; 'regional_industry'→decision; 'super_tier1'→scenario; 其它→decision
export function scoreRun({rows, plannedN}) -> {
  layers: { awareness:{ok,hits,weighted,score|null}, decision:{...}, scenario:{...} },
  total: number|null, level: string,
  coverage: { planned, ok, ratio },
  reasons: string[]
}
```

规则：

- 只统计 `answers.status === 'ok'` 的行（`ok` 以采集结果为准；判定为 `unknown/ambiguous/refused/engine_error` 的**不进分母**，但计入 `coverage.excluded`）。
- 每条有效回答按 verdict 折算命中分：`recommended=1.0, listed=0.7, mentioned=0.4, not_mentioned=0`。
- `层 score = clamp( sum(命中分)/有效题数 × 层权重 )`，保留 1 位小数；有效题数 0 → `score=null`。
- `total` 仅在 `coverage.ratio >= 0.5` 且至少两层有分时给出，否则 `null` + `level='样本不足'`。
- 等级：`>=85 领先`、`>=70 良好`、`>=55 中等`、`>=40 偏弱`、`>=25 落后`、`<25 隐形`。

### 3.6 `lib/keywords.js`

```js
export function expandKeywords({brand, questions}) -> [{
  term, cluster, intent, difficulty /*1-5*/, priority /*P0|P1|P2*/, note
}]
```

- 输入是 `questions`（来自 questions.csv 的种子；没有时从 brand.services/city 模板生成）。
- 簇：`品牌实体`、`本地推荐`、`价格费用`、`对比选择`、`流程交付`、`避坑风险`、`GEO认知`、`竞品替代`。
- `difficulty` 由启发式估算：含本地地名 +1、含「推荐/排名」+1、含「价格/多少钱」+1、长句（>12 字）+1，clamp 1-5。
- 输出必须稳定（同一输入同输出），不得重复 term。

### 3.7 `lib/brief.js`

```js
export function buildBrief({brand, question, keyword, lastRunStats}) -> {
  title, format:'问答'|'指南'|'对比'|'案例'|'清单',
  targetQuestion, searchIntent,
  mustIncludeFacts: [string],        // 只能来自 brand.evidenceFacts / brand 基础字段
  evidenceRequirements: [string],
  outline: [{h2, points:[string]}],
  banned: [string],                  // 绝对化用语/承诺类词
  factCheckList: [string],
  distribution: [{channel, note}]
}
export function renderBriefMarkdown(brief) -> string
```

硬要求：

- `mustIncludeFacts` 只允许引用 `brand.evidenceFacts` 与基础字段，**不允许凭空生成数字、客户数、案例、资质**；不足时显式写「待补充可验证事实」。
- `banned` 至少包含：`最好/第一/唯一/顶级/保证/100%/稳赚/绝对`。
- `outline` 3-6 个 H2，每个 H2 下 2-4 个要点，且包含「证据与来源」小节。
- `distribution` 给 2-3 个渠道建议（如官网博客、知乎专栏、公众号、小红书），并注明「发布后回填 URL 以便监测归因」。

### 3.8 `lib/report.js`

```js
export function renderReportMarkdown({brand, run, detail, score}) -> string
export function renderReportHtml(markdown, {title, subtitle, demo = false}) -> string  // 自包含单文件，内联 CSS
export function renderIndexHtml({brand, runs}) -> string                              // 运行列表页
```

报告结构（Markdown → HTML 同一份内容）：

1. 顶部横幅：`kind==='demo'` 时显著写「DEMO 演示数据，非真实 AI 回答」
2. 一句话结论（总分/等级/覆盖）
3. 三层评分表 + 覆盖与排除说明（"没测成 ≠ 0 分"）
4. 原话证据：按题目列出每题各引擎的命中判定 + 引用片段（截断到 160 字）
5. 竞品/他者提及统计（从回答里扫 brand.competitors）
6. 机会缺口（按层级列 not_mentioned 的题目）
7. 下一步 7 天动作（3-5 条）
8. 数据说明与免责声明（demo/样本口径）
9. 页脚：`恒野 GEO 自研版`（不要出现 OmniRank 字样）

### 3.10 `lib/writer.js`（Phase 3 追加）

```js
export function buildWritingPrompt({ brand, brief, question }) -> { system, user }
export function factCheckDraft({ text, brief, brand }) -> {
  passed: boolean,
  wordCount: number,
  violations: [{ type: 'banned_word'|'absolute'|'unsourced_number'|'fabricated_case', detail, snippet }]
}
export async function generateDraft({ brand, brief, question, engine = null }) -> {
  text: string, mode: 'llm'|'template', engineId: string|null, warnings: string[]
}
```

规则：

1. `engine` 为 null 或不可用（无 key）→ `mode='template'`：按 `brief.outline` 生成 Markdown 骨架，每个 H2 下留「（待补）」占位，`brief.mustIncludeFacts` 原样列在「事实与来源」小节，**不得生成任何具体数字/客户/资质**。
2. `engine` 可用 → `mode='llm'`：把 `brief` 的 mustIncludeFacts / evidenceRequirements / banned / outline 拼成写作指令，要求「只用给定事实、不编数字案例、不写绝对化用语、每节标注来源」；返回文本不得包含「作为一个 AI」等元话语。
3. `factCheckDraft` 至少检查四类：
   - `banned_word`：命中 `brand.contentRules.bannedWords`；
   - `absolute`：`最好/第一/唯一/顶级/保证/100%/稳赚/绝对` 等；
   - `unsourced_number`：段落含阿拉伯数字+单位（元/月/天/条/篇/倍/%）但同段无「来源/引用/据/官网/公开/价格表/元/月」以外的出处标记 → 记违规（`元/月` 这类价格本身来自 evidenceFacts 时不记）；
   - `fabricated_case`：出现「我们的客户/某客户用了/帮助 XX 做到」等案例式表述但没有授权标记。
4. 生成结果落库前必须跑 `factCheckDraft`；违规 > 0 时内容状态为 `needs_review`，违规清单写进报告/CLI 输出。

### 3.9 `bin/geo.js`（CLI）

**追加命令**：

```
node bin/geo.js write --brand hengye --content <id> [--engines deepseek|none] [--json]
```

- 读 content 的 brief → `generateDraft` → `factCheckDraft` → 存 body_md、状态 `draft`/`needs_review` → 写 `data/drafts/<contentId>.md`；
- `--engines none` 强制模板模式（无 Key 也能跑通）；缺省用已配置的写作引擎（DeepSeek 优先）；
- 输出：contentId、模式（llm/template）、字数、违规条数与类型、草稿路径。


```
node bin/geo.js init --brand hengye            # 建表 + 写入品牌（brands/hengye.json）
node bin/geo.js diagnose --brand hengye [--engines mock|live|all] [--limit 30] [--json]
node bin/geo.js keywords --brand hengye [--json]
node bin/geo.js brief --brand hengye --keyword <term> [--out <file>]
node bin/geo.js publish --brand hengye --content <id> --channel <name> [--url <url>]
node bin/geo.js monitor --brand hengye [--engines mock|live]
node bin/geo.js report --run <id> [--out <dir>]
node bin/geo.js runs --brand hengye
```

- 默认引擎：`--engines` 缺省 `live`；没有 key 时 CLI 给出明确提示并**建议改 `--engines mock` 先跑通流程**，不要静默失败。
- `diagnose` 输出：runId、样本量、总分/等级（或"样本不足"）、报告文件路径。
- 所有命令失败时 `process.exitCode = 1` 并打印可操作的中文错误。


## 3.11 `lib/engines/deepseek.js` 的检索契约（2026-10-26 追加）

**背景**：GEO 测的是「AI 搜索实际怎么回答」，纯 `/chat/completions` 拿到的是模型记忆，
会系统性低估可见度。因此 DeepSeek 引擎默认走联网检索，并按证据强度降级：

| 顺序 | mode | 端点 | 说明 |
|---|---|---|---|
| 1 | `retrieval:responses` | `POST /responses` + `tools:[{type:'web_search'}]`，模型 `deepseek-v4-pro` | 官方文档：`web_search` 仅 v4-pro 生效 |
| 2 | `retrieval:rag` | `POST /v1/tools/search` → `POST /chat/completions` | 检索结果注入上下文，答案非产品面原文 |
| 3 | `memory` | `POST /chat/completions`（`deepseek-chat`） | 仅兜底 |

**硬性要求**：
1. `ask()` 返回值新增 `mode` 与 `searchCalls` 字段，**必须如实上报**；禁止把 `memory` 标成检索。
2. 降级链路每一级失败原因要带进最终 `error`（格式 `responses: …；检索链路失败：rag: …`），供 `doctor` 定位。
3. `retrieval:false` 保留旧行为（只走 chat），供单测与低成本对照使用。
4. `lib/engines/parse.js` 是三家响应解析的唯一实现；引用提取采用递归扫描（只认带 http(s) url 的对象），
   不硬编码厂商字段路径，避免厂商改字段名后静默丢引用。

## 3.12 `lib/views.js`（控制台视图）

纯函数，输入数据 → 完整 HTML 字符串；**所有插值必须转义**（`esc()`）。
导出：`layout`、`dashboardPage`、`diagnosePage`、`questionsPage`、`auditPage`、`doctorPage`、`notFoundPage`。
约束：单文件内联 CSS，无外部资源（离线可用）；`diagnosePage` 里「线上引擎已配置」只能统计
`requiresKey && configured`，**mock 不算**（否则无 Key 时会漏掉"当前是演示数据"警告）。

## 3.13 `lib/server.js`（本地控制台）

- 只监听 `127.0.0.1`，端口占用自动顺延（最多 10 个）；不引入鉴权（本机单用户工具）。
- `startServer({port, host, brand})` → `{url, port, close, server}`。
- 诊断**不重写采集逻辑**，spawn `bin/geo.js diagnose`，保证控制台与命令行结果完全一致。
- 路由：`/`、`/run-diagnose`、`/questions`、`/audit`、`/doctor`、`/run/:id`、`/reports/*`、
  `POST /api/diagnose`、`GET /api/job`、`GET /api/state`、`POST /api/init`、`/health`。
- 静态报告路由必须防路径穿越，且只允许白名单后缀。

## 3.14 `lib/doctor.js`（环境自检）

`runDoctor({env, probe, fetchImpl, brandSlug, timeoutMs})` → `{ok, brandName, checks[], keys[], engines[], probes[], probeNote}`。
- 默认**不发网络请求**；`probe:true` 才真调一次引擎验证凭证，并在 `probes[]` 里记录 `mode` 与延迟。
- 每个 `check` 必须带 `action`（"怎么处理"），不允许只报错不给动作。
- `ok` 的判定只看 `level==='blocker'` 且未通过的项。

## 3.15 `lib/audit-site.js`（官网可抓取体检）

`auditSite(url, {fetchImpl, timeoutMs, userAgent})` → 见该文件顶部 JSDoc。
检查：HTTPS、robots.txt（含 WAF 403 判定）、9 个 AI 爬虫 UA 真实可达性、llms.txt、sitemap、JSON-LD、meta、渲染依赖。
评分扣分口径：noindex / robots 屏蔽 / robots 被 WAF 挡合并为 **-35（只扣一次）**；AI UA 被挡 -30；
JS-only -20；llms/sitemap/jsonld 各 -5；description -3；canonical -2；不可达 0-15 分、仅 http 封顶 20。
`findings[].fix` 必须具体到「在 nginx 加什么配置 / 在 Cloudflare 点哪个菜单」，不许写「优化网站」。

## 3.16 `lib/analytics.js`（可见度分析，2026-10-26 追加）

`analyzeRun({brand, rows})` → `{sample, exposure, citations, sov, sentiment, engines, opportunities}`。
- 输入 `rows` 必须是 **getRunDetail().rows 原始结构**（`{question, answer, judgment}`）；不要传 report.js 的 normalizedRows（字段名已变，会得到 0 有效样本）。
- 四块结论：引用源（域名聚合 + 自有/社媒/媒体/百科/搜索分类）、竞品 SoV（份额加总恒为 1）、曝光质量（篇幅占比 + 位置指数衰减 + 首句命中）、情感（规则词典，判不出记中性）。
- 「没测成」不进分母，与 score.js 口径一致；`renderInsightsMarkdown()` 供报告第五章直接插入。
- 域名分类支持三级：全等 → 后缀 → **首段标签**（覆盖 zhuanlan.zhihu.com、douyin.example.com 这类子域名）。

## 3.17 `lib/aeo-assets.js`（AEO 资产生成，2026-10-26 追加）

`buildLlmsTxt` / `buildRobotsTxt` / `buildJsonLd(kind)` / `validateJsonLd` / `buildAeoBundle`。
- robots.txt 显式放行 9 个 AI 爬虫（与 audit-site.js 名单一致）；`llms.txt` 无落地页的条目输出纯说明行，**禁止把多个服务都指到首页**；JSON-LD **没有的字段一律不生成**（不许编 telephone/email）。

## 3.18 `lib/engines/openai-compatible.js`（通用兼容引擎工厂，2026-10-26 追加）

豆包 / Kimi / 元宝 共用这一个工厂，差异只在 `endpoint + model + tools`。
- 联网工具被服务端拒绝时**自动降级重试一次**（去掉 tools），并如实标 `mode='memory'`；
- 返回 `searchQueries`（query fan-out）、`citations`、`mode`、`searchCalls`；
- 配置不齐（缺 key / 缺模型 ID / 缺中转地址）一律 `unavailable` 并说明缺什么。

## 3.19 `lib/questions-gen.js`（自动出题，2026-10-26 追加）

`generateQuestions({brand,count,seed})` → `{questions,warnings}`。三层（awareness/decision/scenario）× 六意图。
**硬规则：生成的问题里不得出现品牌名/全称/别名**（会引导模型、污染诊断）；同 brand+seed 必须完全一致。

## 3.20 `lib/quote.js`（报价与关键词价值，2026-10-26 追加）

`scoreKeyword` / `buildQuote` / `renderQuoteMarkdown`。按`篇数 × 单价`计价；成本盘子 `UNIT_COST`（写作20+发布30+运营10=60/篇）与售价分离；毛利单独算。

## 3.21 `lib/action-plan.js`（行动清单，2026-10-26 追加）

`buildActionPlan({brand,score,insights,rows,competitors})` → `{top10,days30,risks,generatedFrom}`。
8 条优先级规则（覆盖率→可抓取性→机会域名→竞品差异→负面→最低层→未提及题→baseline）；每条行动必须带**含数字的证据**；30 天计划第 1 周必须修阻塞项、第 4 周必须复测对比。

## 3.22 判定枚举扩展到 10 态（2026-10-26 追加）

`verdict` 新增 `conditionally_recommended`（条件推荐）与 `candidate`（候选），与 OmniRank 的硬轴对齐。
- 权重：recommended 1.0 / conditionally_recommended 0.85 / listed 0.7 / candidate 0.55 / mentioned 0.4 / not_mentioned 0。
- 判定顺序：**前提条件 > 推荐 > 候选 > 列举 > 仅提及**（条件前置，「如果预算有限，可以考虑 X」应判条件推荐而非候选）。
- 未测成类（ambiguous/unknown/refused/engine_error）不进分母。

## 3.23 `lib/article-contracts.js` / `lib/article-review.js` / `lib/publish-channels.js`（2026-10-26 追加）

- `applyContracts`：篇幅合同（1200–4500 字）+ 客户存在感（≥3 次且前 200 字出现）+ 标题治理（长度/承诺词/黑名单/重复/意图）。
- `reviewArticle`：七维加权终审（事实密度/证据可核/结构可摘录/实体清晰/意图对齐/可读性/差异化），硬伤阻断发布。
- `publishTo`：渠道三态 `not_connected / dry_run / api`；默认模拟发回执，配 `PUBLISH_<ID>_WEBHOOK` 升级为 API。

## 3.24 `geo schedule`（定时调度）与 `geo demo`（闭环验收）

- `geo schedule`：生成 crontab（每日 monitor / 每周 diagnose / 每月 audit），只生成不擅自安装；`--write` 产出带备份的安装脚本。
- `geo demo`：**用子进程依次调用本 CLI 的 10 条命令**（init→questions→diagnose→insights→plan→keywords→brief→write→publish→monitor），
  任何一步在命令行下跑不通即失败——专门用来防「库函数能跑、CLI 不能跑」的假绿。
  输出 `data/reports/demo-<时间戳>.md`，控制台 `/pipeline` 可直接一键触发（`POST /api/demo`）。

## 3.26 `geo rejudge`（离线重判，2026-10-26 追加）

`rejudge --run <id>`：用当前判定规则（含实体消歧配置）重判已落库的回答 → 重算评分 → 重建报告。
动机：改判定规则后重新采集既花钱又不可比（引擎有随机性），离线重判才能做「同数据 A/B」。
注意：品牌 JSON 改完必须先跑 `init` 同步进 DB，否则 rejudge 读到的是旧配置。

## 3.27 实体消歧与同名实体识别（2026-10-26 追加，真实数据驱动）

`brand.disambiguation = {requireClues[], rejectClues[]}`、`brand.rejectedNames[]`、`brand.sameNameDomainHints[]`：
- 命中否决名/排除线索且无本品牌线索 → `not_mentioned`（method=rejected / disambiguation）；
- 同时出现本品牌线索 → 不误杀，按正常档位判定；
- `sameNameDomainHints` 命中的域名在引用源分析里标为「同名实体站点（不可用）」，**不进机会缺口**，
  单独输出 `sameNameThreats`，并由 action-plan 转成「做品牌实体区分」的 P0 行动。

## 3.28 引擎扩展到 11 家（2026-10-26 追加，对标摘星AI）

`lib/engines/providers.js` 是「OpenAI 兼容供应商」注册表（端点/密钥/模型/联网工具），
`lib/engines/compat.js` 由注册表生成引擎实例；DeepSeek/通义/豆包/Kimi/元宝因联网方式特殊保留专用适配器。
当前 11 家：DeepSeek、通义千问、豆包、Kimi、元宝、文心一言、智谱GLM、腾讯混元、MiniMax、Gemini、ChatGPT。
**纪律**：只有厂商确实支持服务端联网检索才声明 `tools`，否则 mode 落 `memory`，报告里可区分「搜索」与「记忆」。

## 3.29 `lib/video-script.js` 与 `lib/seo-check.js`（2026-10-26 追加）

- `buildVideoScript`：文章 → 口播稿（时间轴）/分镜/标题备选/话题/封面/合规检查/平台注意（不做视频渲染）。
- `analyzeSeo` / `fetchAndAnalyzeSeo`：传统 SEO（TDK/H 结构/canonical/OG/JSON-LD/alt/内链/词数/robots/sitemap）+ 短视频 SEO 建议。
- 控制台：`/cockpit` 语义份额驾驶舱（零依赖 SVG 图表）。

## 3.30 内容矩阵分发（2026-10-26 追加，对标摘星AI 内容矩阵）

`lib/publish-channels.js` 的 `CHANNELS` 扩到 11 个（知乎/小红书/公众号/搜狐/百家号/Webhook/头条/网易/新浪/抖音/B站）。
`geo distribute` 支持单条或 `--all` 批量投递，默认 dry_run 出回执，`--live` 且渠道为 api 态才真正发布；
`store.listPublications()` 提供矩阵数据，控制台 `/distribution` 渲染「内容 × 渠道」覆盖矩阵与缺口提示。

## 3.31 客户分享链接（2026-10-26 追加）

`shares` 表 + `store.createShare/getShare/revokeShare/listShares`；`geo share` 生成/列出/吊销；
服务端 `/s/<token>` 免 Basic Auth 渲染只读报告（过期或吊销返回 404 页面）。
语义：`days=0` 为长期，负数即已过期；重复吊销返回 false。

## 3.32 多客户 / 鉴权 / 白标 / 配额 / 审计 / 周报（2026-10-26 追加）

- 鉴权：`lib/auth.js`（scrypt 密码、SQLite 会话、角色 admin|client）；`/login` `/logout`；
  client 只能访问白名单页面且强制绑定自己的品牌；Basic Auth 保留作运维兜底。
- 多客户：复用 `brands` 表，`/clients` 列表与新建（`POST /api/clients`）、客户账号（`POST /api/users`）。
- 白标：`settings` 表（app_title/logo_text/primary_color/footer_text），`views.setTheme` 每请求注入。
- 配额：`quota_questions`（0=不限），`/api/diagnose` 按本月已用样本拒绝超额请求（429）。
- 审计：`audit_log` 表；登录、建客户、改设置、诊断、发布、分享、周报均落日志，`/audit-log` 可查。
- 周报：`lib/weekly.js`（buildWeeklyReport/renderWeeklyMarkdown/renderWeeklyHtml）+ `geo weekly` + `/weekly`；
  支持 `--push <webhook>`（企微/钉钉/邮件网关）。

## 3.33 对标 GitHub 开源 GEO 平台的补充（2026-10-26 追加）

参考 `yaojingang/GEORank`、`elmohq/elmo`、`anyin-ai/aperture` 的能力清单，补了四项：
1. 引擎扩到 **13 家**：新增 Perplexity（自带联网与 citations）与 Claude（Messages API + web_search）；
2. `/responses` 回答浏览器：逐条看 AI 原话、判定、命中片段与引用，可按引擎/判定筛选；
3. `buildPhases`：30/60/90 天路线图（认得你 → 引用你 → 份额与防守），渲染在驾驶舱；
4. `/api/providers`：引擎与就绪状态由后端返回，前端不漂移。

## 3.34 服务模式与套餐（2026-10-26 追加）

`lib/plans.js`：两种模式（`self_service` 自助 / `managed` 托管）+ 三档套餐（basic/pro/agency）。
订阅状态存在 `settings`（`service_mode` / `plan` / `quota_questions` / `expire_at`）。
执行：`POST /api/clients/subscription`（管理员）、`geo client`（CLI）、`/clients` 页面开通表单。
门禁：客户角色下——到期未续费 → 只读（动作接口 402）；托管版 → 执行接口 403 且导航隐藏动作页；
配额只约束客户，服务商管理员不受限。

## 3.35 代理层（2026-10-26 追加）

`agents` 表（username/name/quota_total/commission_rate/active）+ `brands.agent` 列（迁移自动加）。
角色 `agent`：登录后进 `/agent` 总览（名下客户、进货配额、本月用量、客户营收与分成估算）；
`/clients` 仅返回自己客户，新建客户自动绑定自己；订阅接口只允许给自己客户开通；`/settings` `/audit-log` 一律 403。
CLI：`geo agent --add/--list/--report`、`geo client ... --agent <代理>`。

## 3.36 托管按效果计费（2026-10-26 追加）

`lib/billing.js`：`BILLING_UNITS`（mention_gain/citation_gain/mention_rate_pt/recommended_count）、
`measureRows`（口径统计，无效样本不进分母）、`computeSettlement`（基线对比 + 保底 + 封顶）、`renderSettlementMarkdown`。
设置键：`billing_mode`（performance/fixed）、`billing_unit`、`billing_price`、`billing_min`、`billing_cap`。
执行：`geo bill`（写 data/reports/bill-<slug>-<month>.md）、`/billing` 看板（服务商/代理）。
开通托管时自动写入 performance 默认口径；效果为负按 0 计。

## 4. 品牌配置 `brands/hengye.json`

```json
{
  "slug": "hengye",
  "name": "恒野",
  "legalName": "芜湖恒野数字科技有限公司",
  "aliases": ["恒野", "芜湖恒野", "恒野数字科技", "恒野工作室"],
  "rejectedNames": ["叁人行", "三人行"],
  "ambiguousAliases": ["恒野"],
  "city": "芜湖",
  "scope": "全国线上交付，芜湖/合肥可面谈",
  "industry": "内容代运营 / GEO 优化服务",
  "services": ["内容代运营", "起号陪跑", "老板 IP", "工具代建", "GEO 优化"],
  "targetCustomers": ["个人创作者", "本地商家", "小团队"],
  "priceRange": "1980-120000 元/年",
  "urls": ["http://sanrenxing.cn"],
  "competitors": ["宇典科技", "力行文化"],
  "differentiators": ["先诊断再交付", "不承诺效果只承诺交付"],
  "evidenceFacts": [],
  "contentRules": { "bannedWords": ["最好", "第一", "唯一", "顶级", "保证", "100%", "稳赚", "绝对"] }
}
```

> `evidenceFacts` 由 Lead 从 `brand/brand-facts.md` 里「[有据]」条目填充；`[待确认]` 的不许写进来。

## 5. 验收标准（Lead 会跑）

1. `node --test` 全绿（各模块自测 + 集成测试）。
2. `node bin/geo.js init --brand hengye` → `data/geo.db` 建表成功、品牌写入。
3. `node bin/geo.js diagnose --brand hengye --engines mock --limit 12` → 产出 run + 判定 + 评分 + `data/reports/run-<id>.html`，HTML 顶部有 DEMO 横幅。
4. 判定单测覆盖：推荐/列入/仅提及/未提及/别名歧义/拒答/引擎错误 7 类；评分单测覆盖：覆盖率不足不出总分、unknown 不进分母。
5. `keywords`/`brief`/`publish`/`monitor` 各至少一条冒烟路径跑通。
6. 报告与 brief 里无 OmniRank 品牌字样（除数据说明中的"设计参考"注释；HTML 页面不出现）。
7. `node bin/geo.js serve --no-open` 起服务，`/`、`/run-diagnose`、`/questions`、`/audit`、`/doctor`、`/api/state` 全部 200；`/api/diagnose` 能跑完一轮并出新报告。
8. `node bin/geo.js doctor` 在无 Key 时 `exit=1` 并明确指向 `DEEPSEEK_API_KEY`；`--probe` 会真调一次并输出 `mode`。
9. `node bin/geo.js audit --url <站点>` 输出评分 + blocker/warn 分级与逐条修复动作；对 `sanrenxing.cn` 应识别出 HTTPS 不通、robots 403、noindex、AI UA 被挡。
