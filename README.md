# 恒野 GEO 监测系统

独立部署的 GEO（生成式引擎优化）监测系统，与官网完全分离。

**工作方式**：GitHub Actions 每天 07:12（北京时间）自动跑一轮 AI 可见度诊断 → 构建静态系统页面 → 部署到 GitHub Pages。
不需要服务器，永久免费；历史报告按 run 归档。

## 页面

- `index.html` 总览：评分、提及率、自有引用占比、竞品份额、判定分布、引用源、fan-out、Top10 行动、30 天计划
- `runs.html` 历史运行（点进去看每轮报告）
- `report.html` 最新诊断报告
- `systems.html` 引擎状态与全部计算口径

## 配置真实引擎

仓库 Settings → Secrets and variables → Actions，添加：

| Secret | 用途 |
| --- | --- |
| `DEEPSEEK_API_KEY` | DeepSeek 联网检索（推荐，一次 12 题约 0.3 元） |
| `DASHSCOPE_API_KEY` | 通义千问（百炼） |
| `DOUBAO_API_KEY` + `DOUBAO_MODEL` | 豆包（方舟推理接入点 ID） |
| `KIMI_API_KEY` | Kimi |
| `YUANBAO_BASE_URL` + `YUANBAO_API_KEY` | 元宝（OpenAI 兼容中转） |

没配任何密钥时自动用演示引擎（数据带 DEMO 标记，不冒充真实）。

## 本地运行

```bash
cd app
node bin/geo.js init --brand hengye
node bin/geo.js diagnose --brand hengye --engines deepseek --limit 12
node scripts/build-site.mjs --out ../dist-site
cd .. && python3 -m http.server 8000 --directory dist-site
```

## 注意

系统对搜索引擎封闭（`robots.txt` Disallow），只有拿到地址的人能访问；如需客户可见，把仓库设为 Private 并改用带访问控制的托管。
