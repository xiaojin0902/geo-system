# GEO 代运营交付系统（v2）

围绕「客户 → 月度交付周期 → 六步流程 → 交付物」重建，不再是功能大杂烩。

## 六步流程

诊断 → 方案 → 内容 → 发布 → 复测 → 交付

## 页面（只有三个）

| 页面 | 作用 |
| --- | --- |
| `/` 工作台 | 客户卡片 + 六步进度 + 今日待办 + 平均分 |
| `/client/<slug>` 客户 | 单客户：指标、待办、内容、发布、交付物、动作按钮 |
| `/settings` 设置 | 引擎状态、白标（系统名/主色） |
| `/s/<token>` 分享 | 客户免登录看报告（30 天） |

## 命令（只有 7 个）

```bash
node bin/geo.js init --slug demo --name 演示家政 --industry 家政 --city 芜湖 --competitors "同行A,同行B"
node bin/geo.js diagnose --slug demo --engine mock --limit 5
node bin/geo.js content --slug demo
node bin/geo.js deliver --slug demo
node bin/geo.js list
node bin/geo.js report --slug demo
node bin/geo.js serve
```

## 口径（可复算）

- 判定 6 态：推荐 / 列入 / 仅提及 / 未提及 / 歧义 / 采集失败（歧义与失败不进分母）
- 评分 0–100 = 提及 60 + 判定质量 25 + 引用多样性 15
- 没有有效样本时不出分（没测成 ≠ 0 分）

## 测试

```bash
node --test
```
