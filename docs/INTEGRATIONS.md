# 怎么把「真实发布」和「数字人出片」接上

> 调研时间：2026-10-26 ｜ 结论先行：**大多数平台的官方发文 API 拿不到，能接的路只有三条。**

## 一、三条接法（按可行性排序）

| 路线 | 适用平台 | 需要什么 | 成本 | 我们已实现 |
| --- | --- | --- | --- | --- |
| **A. 官方 API** | 微信公众号（唯一完整）、抖音开放平台、小红书开放平台 | 企业资质 / 认证账号 / 应用审核 | 0（需资质） | 公众号：`lib/publishers/wechat.js` ✅ |
| **B. 浏览器半自动** | 知乎、今日头条、百家号、小红书、抖音、公众号后台 | 你本机已登录的 Chrome | 0 | `lib/publishers/browser.js` ✅ |
| **C. 数字人服务商** | 出视频（不是发文） | 服务商账号 + 形象/音色 ID | ¥0.5–3/分钟 | `lib/digital-human.js` ✅ |

---

## 二、路线 A：微信公众号官方 API（推荐先接这个）

公众号是**唯一**有完整官方发布能力的中文平台：建草稿 → 群发。

### 前置条件（缺一不可）

1. **认证的服务号或订阅号**（个人号没有发布接口权限；认证费 ¥300/年）
2. 公众号后台 → 设置与开发 → 基本配置 → 拿 **AppID / AppSecret**
3. 同一页面 → **IP 白名单** → 加入运行本系统的机器出口 IP（否则报 `errcode 40164`）
4. 草稿需要封面图 `thumb_media_id`（没有也能建草稿，群发会失败）

### 配置

```bash
# app/.env
WECHAT_APPID=wx1234567890abcdef
WECHAT_SECRET=your_app_secret
WECHAT_AUTO_PUBLISH=0        # 1 = 建完草稿直接群发（谨慎）
WECHAT_SOURCE_URL=https://sanrenxing.cn   # 可选，原文链接
```

### 用法

```bash
# 只建草稿（安全默认）
node bin/geo.js publish --content 3 --channel 公众号

# 建草稿并群发（需要 WECHAT_AUTO_PUBLISH=1 且 --status published）
node bin/geo.js publish --content 3 --channel 公众号 --status published
```

返回里会有 `media:xxx` 作为回执；群发成功还会有 `publish_id`。

---

## 三、路线 B：浏览器半自动（知乎/头条/百家号/小红书/抖音/公众号后台）

这些平台**没有可用的第三方发文 API**（或要企业资质+审核）。现实做法是复用你已登录的浏览器：
程序只做「打开编辑器 → 填标题 → 填正文」，**最后一步发布按钮永远留给人点**。

这也是 MultiPost（[Chrome 插件](https://chromewebstore.google.com/detail/multipost/dhohkaclnjgcikfoaacfgijgjgceofih)）、
[unified-publish-mcp](https://github.com/Lesleyshi1015/unified-publish-mcp)、
[xiaohongshu-mcp](https://github.com/vmxmy/xiaohongshu-mcp) 这类工具的共同思路。

### 步骤

```bash
# 1) 退出 Chrome，带调试端口重启（会沿用你的登录态）
open -na "Google Chrome" --args --remote-debugging-port=9222

# 2) 让系统把稿子填进编辑器
node bin/geo.js publish --content 3 --channel 知乎专栏 --browser
node bin/geo.js publish --content 3 --channel 今日头条 --browser
node bin/geo.js publish --content 3 --channel 小红书 --browser
```

输出会告诉你标题/正文是否填上；失败会提示是端口没开还是平台选择器变了。

### 能接的平台与编辑器地址

| id | 平台 | 编辑器 |
| --- | --- | --- |
| `zhihu` | 知乎 | https://zhuanlan.zhihu.com/write |
| `toutiao` | 今日头条 | https://mp.toutiao.com/profile_v4/graphic/publish |
| `baijiahao` | 百家号 | https://baijiahao.baidu.com/builder/rc/edit?type=news |
| `xiaohongshu` | 小红书 | https://creator.xiaohongshu.com/publish/publish |
| `douyin` | 抖音 | https://creator.douyin.com/creator-micro/content/upload |
| `wechat_mp` | 公众号后台 | https://mp.weixin.qq.com/ |

平台改版只需改 `lib/publishers/browser.js` 里的选择器数组。

### 风险与边界

- 平台可能把自动化浏览判定为异常操作，**建议低频、人工确认后再发**；
- 本模块**不点发布、不读 Cookie、不传凭据**，只填内容；
- 不承诺 100% 填成功，平台改版会失败并明确报错。

---

## 四、路线 C：数字人视频（出片，不是发文）

### 已实现

- `lib/digital-human.js`：服务商适配（HeyGen / 硅基智能 / 火山数字人 / 自建中转）
- `exportShootPackage()`：**零配置也能用**——导出 SRT 字幕 + 分镜 CSV，直接丢进剪映/人工拍摄
- `node bin/geo.js video --content 3 --render`：提交任务 → 轮询 → 拿视频 URL

### 配置（以 HeyGen 为例）

```bash
# app/.env
DH_PROVIDER=heygen
HEYGEN_API_KEY=your_key
HEYGEN_AVATAR_ID=your_avatar_id
HEYGEN_VOICE_ID=your_voice_id
```

### 各路线成本对比

| 方案 | 价格 | 说明 |
| --- | --- | --- |
| HeyGen | 约 $0.5–1/分钟 | 海外，口型自然 |
| 硅基智能 / 火山数字人 | 约 ¥1–3/分钟 | 国内合规，需企业认证 |
| 腾讯智影 / 剪映数字人 | 按套餐 | 便宜，模板化 |
| **开源自托管**（LivePortrait / Wav2Lip / SadTalker） | 仅算力 | 要 GPU，效果与稳定性需自己扛 |
| **只出脚本 + 剪映人工拍** | 0 元 | 就是我们现在默认给的：`.srt` + 分镜 `.csv` |

---

## 五、推荐落地顺序

1. **先接公众号**（成本最低、官方支持、发出去就是被 AI 抓取的信源）
2. **再开浏览器半自动**（知乎/头条/百家号，覆盖 AI 最常引用的问答与资讯源）
3. **数字人最后做**（它不影响 GEO 效果，只影响内容形态）

> 一句话：GEO 的胜负手是**信源被 AI 引用**，不是发得多。公众号 + 知乎 + 头条这三个源覆盖了中文 AI 回答里最常见的引用域名。
