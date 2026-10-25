# 恒野 GEO 自研版（app/）

自研的 GEO 流水线，覆盖「诊断 → 关键词 → 内容 brief → 发布记录 → 效果监测」。
**Node 22 + SQLite，零 npm 依赖**，一行命令跑完，不依赖 Docker、不依赖 OmniRank 代码。

设计结论参考了 [OmniRank 开源版的逻辑拆解](../docs/omnirank-logic.md)（判定架构、评分口径、数据契约），
但实现、提示词与文案全部是自己重写的——不复制其源码/提示词，报告与页面里也不出现 OmniRank 字样（见 [SPEC.md](SPEC.md) §0）。

---

## 一、快速开始（推荐：网页控制台）

```bash
cd hengye-geo
./geo serve              # 自动开浏览器；万一没开，手动访问 http://127.0.0.1:8787
```

控制台五个页面：

| 页面 | 你在这里做什么 |
|---|---|
| **总览** | 看最近评分、历史运行、密钥是否配好，点进任何一轮报告 |
| **跑诊断** | 选引擎 + 题数，点一下就跑，输出实时滚动 |
| **闭环验收** | 一键跑完 10 步（建库→出题→诊断→分析→行动→关键词→brief→写稿→发布→监测），看哪一步断了 |
| **工具箱** | 报价 / 自动出题 / 发布渠道状态，不敲命令也能用 |
| **可见度分析** | 引用源 / 竞品 SoV / 曝光质量 / 情感倾向（与报告第五章同源） |
| **问题库** | 看 99 条「用户会问 AI 的问题」 |
| **官网体检** | 检查网站能不能被 AI 爬虫抓到（不需要 Key，立刻可用） |
| **环境自检** | 告诉你「离跑真实数据还差什么」，每项带处理动作 |

命令行同样可用（适合定时任务/脚本）：

```bash
cd hengye-geo/app
node bin/geo.js init --brand hengye                       # 建库 + 品牌 + 99 条种子问题
node bin/geo.js diagnose --brand hengye --engines mock --limit 12   # DEMO 数据，只验证流程
node bin/geo.js audit --url https://sanrenxing.cn         # 官网可抓取性体检
node bin/geo.js insights --run <id>                       # 引用源/竞品SoV/曝光质量/情感
node bin/geo.js aeo --base-url https://sanrenxing.cn      # 生成 llms.txt / robots.txt / JSON-LD
node bin/geo.js doctor                                    # 环境自检
open data/reports/index.html                               # 所有运行记录
```

演示引擎是确定性的（同一问题永远同回答），报告顶部有红色 DEMO 横幅，不会冒充真实数据。

## 二、要真实数据时：填一个 Key

```bash
cp .env.example .env
# 编辑 .env，填 DEEPSEEK_API_KEY 或 DASHSCOPE_API_KEY（任意一个即可）
node bin/geo.js diagnose --brand hengye --engines live --limit 30
```

- `--engines live`：用所有已配置 Key 的线上引擎（DeepSeek / 通义千问）
- `--engines deepseek,dashscope`：指定引擎
- `--engines all`：演示 + 线上一起跑（对照用）
- 没有 Key 时命令会明确报错并提示改用 mock，不会静默失败
- 填完 Key 先跑 `node bin/geo.js doctor --probe`：它会真调一次 API，告诉你通没通、走的哪条检索路径

**引擎覆盖（与 OmniRank 对齐的 5 个中文引擎）**：

| 引擎 | 需要配置 | 联网方式 |
|---|---|---|
| 通义千问 | `DASHSCOPE_API_KEY` | `extra_body.enable_search` |
| DeepSeek | `DEEPSEEK_API_KEY` | Responses API + `web_search`（三级降级） |
| 豆包 | `DOUBAO_API_KEY` + `DOUBAO_MODEL`（方舟接入点 ID） | 服务端 `web_search` 工具 |
| Kimi | `KIMI_API_KEY` | 内置 `$web_search` 工具 |
| 元宝 | `YUANBAO_BASE_URL` + `YUANBAO_API_KEY` | OpenAI 兼容中转（元宝无官方 API） |

配置是否齐全跑 `node bin/geo.js doctor` 看，它会逐引擎告诉你缺什么。

**DeepSeek 的三条取数路径（重要）**：GEO 要的是「AI 搜索实际怎么回答」，
所以引擎默认走**联网检索**而不是纯对话。实现上按证据强度降级，并在每轮结果里如实标注 `mode`：

| mode | 含义 | 说明 |
|---|---|---|
| `retrieval:responses` | Responses API + 服务端 `web_search`（模型 `deepseek-v4-pro`） | 最接近产品面真实回答 |
| `retrieval:rag` | 官方 `/v1/tools/search` 检索 → 注入上下文 → 生成 | 检索结果可溯源，但答案不是产品面原文 |
| `memory` | 纯 `deepseek-chat`，无检索 | 仅兜底。**报告里出现 memory 就说明这一轮不是搜索可见度**，不能用它下结论 |

成本参考：`deepseek-v4-pro` 带检索一次问答约 1-2 分钱人民币；30 题 ≈ 3-6 毛。
`deepseek-chat` 无检索更便宜，但那不是 GEO 要测的东西。

## 三、命令清单

| 命令 | 作用 |
|---|---|
| `node bin/geo.js init --brand hengye` | 建表 + 写品牌 + 种子问题（幂等） |
| `node bin/geo.js diagnose --brand hengye [--engines mock\|live\|all\|deepseek,dashscope] [--limit 30] [--priority P0]` | 采集 → 判定 → 评分 → 报告 |
| `node bin/geo.js keywords --brand hengye` | 从 99 条问题挖出关键词簇（8 类）并落库 |
| `node bin/geo.js brief --brand hengye --keyword "<词>" [--question <id>]` | 生成证据优先的内容 brief（Markdown） |
| `node bin/geo.js write --brand hengye --content <id> [--engines deepseek\|dashscope\|none]` | 按 brief 生成草稿：有 Key 走 LLM，无 Key 走模板骨架；必过事实核查 |
| `node bin/geo.js publish --brand hengye --content <id> --channel "知乎专栏" [--url ...] [--status published]` | 登记发布（默认 dry_run 模拟） |
| `node bin/geo.js monitor --brand hengye [--engines mock\|live] [--limit 10]` | 复跑并和上一轮对比 |
| `node bin/geo.js report --run <id>` | 按 run 重建报告 |
| `node bin/geo.js runs --brand hengye` | 历史运行列表 |
| `node bin/geo.js serve [--port 8787] [--no-open]` | 启动网页控制台（本文第一节） |
| `node bin/geo.js doctor [--probe]` | 环境自检；`--probe` 会真调一次引擎验证凭证 |
| `node bin/geo.js audit [--url <网址>] [--out <文件>]` | 官网 AI 可抓取性体检（robots / AI 爬虫 UA / llms.txt / sitemap / JSON-LD） |
| `node bin/geo.js insights [--run <id>]` | 可见度分析：引用源、竞品 SoV、位置加权曝光、情感 |
| `node bin/geo.js aeo [--base-url <站点根>] [--out <目录>]` | 生成 AEO 资产：llms.txt、robots.txt（放行 9 个 AI 爬虫）、Organization/Service/FAQ JSON-LD |
| `node bin/geo.js questions [--count 24] [--seed 1] [--write]` | 自动出题：三层 × 六意图，**题目里不含品牌名**（防引导性污染），`--write` 写进问题库 |
| `node bin/geo.js quote --keywords "词:难度,..." [--band lite\|standard\|deep] [--tax 0.06]` | 报价：关键词价值分 → 篇数 × 单价 → 成本构成与毛利 |
| `node bin/geo.js plan [--run <id>]` | Top10 行动 + 30 天计划（每行动带证据、owner、时限） |
| `node bin/geo.js schedule [--write]` | 生成 crontab 定时任务（每日监测 / 每周诊断 / 每月体检），`--write` 出安装脚本 |
| `node bin/geo.js demo [--limit 12] [--questions 24]` | **端到端闭环验收**：10 步真实调用 CLI 跑一遍，产出 `data/reports/demo-*.md` |
| `node bin/geo.js rejudge --run <id>` | **离线重判**：判定规则改完后重算（不重新采集、不花钱），并重建报告 |
| `node bin/geo.js publish --list` | 查看发布渠道三态（未接入 / 模拟发布 / 已接入 API） |

所有命令支持 `--json`，方便后续接自己的界面或定时任务。

## 四、产出物在哪

```
app/data/
  geo.db                     # SQLite：品牌/问题/运行/回答/判定/评分/关键词/内容/发布/监测
  reports/run-<id>.md|.html  # 单轮诊断报告
  reports/index.html         # 运行列表
  briefs/hengye-<id>.md      # 内容 brief
  drafts/<contentId>.md      # 草稿（模板/LLM 生成 + 事实核查结论）
  （可选）audit-<域名>.md    # 官网体检报告，用 --out 指定路径
```

报告结构：一句话结论 → 三层评分与覆盖说明 → 原话证据（按题目）→ 竞品/他者提及 → **引用源 · 竞品份额 · 曝光质量** → 机会缺口 → 未来 7 天动作 → 数据说明。
手机可读、单文件、零外链、零 JS。

## 五、判定与评分口径（决定报告可不可信）

**判定是 10 态硬轴**（与 OmniRank 对齐）：推荐 / 条件推荐 / 候选 / 列入 / 仅提及 / 未提及 / 歧义 / 未知 / 拒答 / 引擎错误。
权重：推荐 1.0 · 条件推荐 0.85 · 列入 0.7 · 候选 0.55 · 仅提及 0.4 · 未提及 0。
「歧义/未知/拒答/引擎错误」**不进分母**，只进覆盖率——这是「没测成 ≠ 0 分」的实现。


**判定（`lib/judge.js`）**

1. 先按「否决名 → 正式名/别名 → 法律后缀扩展」做**确定性匹配**；
2. 命中后按上下文判档位：推荐（`recommended`）> 列入（`listed`）> 仅提及（`mentioned`）；
3. 别名是常见词且上下文没有品牌线索 → `ambiguous`（拿不准就存疑，**不折算成未提及**）；
4. 引擎失败、拒答 → `engine_error` / `refused`，同样不等于「没提到你」。

**评分（`lib/score.js`）**

- 三层权重：品牌认知 20 / 区域决策 40 / 场景拓展 40；
- 命中折算：推荐 1.0、列入 0.7、仅提及 0.4、未提及 0；
- `unknown / ambiguous / refused / engine_error` **不进分母**，只进覆盖率；
- 覆盖率 < 50% 或不足两层有分 → **不出总分**，标「样本不足」；
- 等级：≥85 领先 / ≥70 良好 / ≥55 中等 / ≥40 偏弱 / ≥25 落后 / <25 隐形。

一句话：**没测成 ≠ 0 分**，也不让大模型凭感觉打分。

**生成与事实核查（`lib/writer.js`）**

- 有写作引擎：把 brief 的「必须引用事实 / 证据要求 / 禁用词 / 大纲」拼成写作指令，生成后立刻跑事实核查；
- 没 Key：生成模板骨架，每节留「（待补）」，事实集中列在「事实与来源」，**不产生任何编造数字/案例**；
- 事实核查四类：禁用词、绝对化用语、无来源数字、编造客户案例；违规 > 0 → 内容状态 `needs_review`，不会静默通过。

## 六、内容 brief 的证据优先规则

`brief` 的「必须引用的可验证事实」只允许来自 `brands/hengye.json` 的 `evidenceFacts` 与品牌基础字段；
没有证据时显式写「待补充可验证事实」，不编客户案例、数字、资质、排名。
禁用词（最好/第一/唯一/顶级/保证/100%/稳赚/绝对…）会列进 brief，写作后可用 `factCheckList` 自查。

## 六点五、实体消歧（真实数据暴露的头号问题）

品牌名撞车时（「恒野」这种常见字号），AI 回答里的「恒野」很可能是河南恒野农牧、苏州恒野仓储等**同名公司**。
不做消歧，报告会把别人的可见度算到你头上——实测中 12 题里 6 条假提及、1 条假「推荐」。

在 `brands/<slug>.json` 里配置（`node bin/geo.js init` 后生效）：

```json
{
  "rejectedNames": ["河南恒野农牧", "石家庄恒野科技", "恒野仓储"],
  "ambiguousAliases": ["恒野"],
  "disambiguation": {
    "requireClues": ["芜湖", "数字科技", "内容代运营"],
    "rejectClues": ["河南", "洛阳", "苏州", "农牧", "仓储", "服装"]
  },
  "sameNameDomainHints": ["hengye"]
}
```

判定逻辑：命中否决名或排除线索且**没有**本品牌线索 → 判 `not_mentioned`（是别家的可见度）；
有本品牌线索 → 按正常档位判定；都没有 → `ambiguous`（拿不准不算未提及）。
`sameNameDomainHints` 让引用源分析把「同名实体站点」标出来：它们不是机会（你发不了稿），是威胁。

改完规则跑 `node bin/geo.js rejudge --run <id>` 就能同数据重算，不用再花钱重新采集。

## 七、发布前的交付纪律（write / publish）

`write` 生成草稿后会依次过四道闸（模块都在 `lib/` 下，全部规则化、可复算）：

| 闸门 | 模块 | 阻断条件 |
|---|---|---|
| 篇幅合同 | `article-contracts.js` | 正文 <1200 字或 >4500 字 |
| 客户存在感 | 同上 | 品牌全文提及 <3 次，或前 200 字没出现 |
| 标题治理 | 同上 | 超 30 字、含承诺词/黑名单、与历史标题重复、意图不对齐 |
| 七维终审 | `article-review.js` | 有硬伤（绝对化用语/无来源数字/虚构案例/篇幅不足）或总分 <60 |

不通过 → 内容状态记为 `needs_review`，不会静默放行；`--json` 能看到每一条 blocker 与修复建议。
`publish` 走渠道三态：默认 `dry_run` 出模拟回执；配置 `PUBLISH_<渠道ID>_WEBHOOK` 后升级为真实 API 发布。

## 八、测试

```bash
cd hengye-geo/app
node --test          # 123 条，覆盖引擎/判定/评分/存储/CLI/关键词/brief/写稿/报告
```

## 八、常见问题

- `ExperimentalWarning: SQLite is an experimental feature` —— Node 22 的正常提示，不影响使用。
- `brief` 报「关键词不在 keywords 表中」—— 先跑一次 `keywords`，`brief` 只接受表里已有的词。
- 切换 `--engines` 后想对比趋势：用 `monitor`，它只比较两轮共同覆盖的题目，避免把「首次覆盖」误报成涨跌。
- 想换品牌：复制 `brands/hengye.json` 改 slug/名称/别名/证据，再 `init --brand <新slug>`。
- 数据库想重置：删掉 `app/data/geo.db` 后重新 `init`（会丢历史，建议先备份）。
