# 生图工具：`workbuddy_draw_image`

> 日期：2026-10-21 · 取证与联调时版本：4.13.2（`upstream/main` = `dfe7ab3`）
> 工具名：`workbuddy_draw_image` · 只在国内区账号下注册
> 真实成本：**实测 5.71 积分/张**（一次真实联调已花掉 5.71）

## 结论

1. **WorkBuddy 的生图能力是官方 CLI 的一等能力，不是网页端私有的。** 端点
   `POST {chatBase}/v2/images/generations`，请求体只有 `model` / `prompt` / `size`
   （`n` 仅 hunyuan 系带），响应是 `{code, msg, requestId, data:{created, data:[{url}],
   usage:{credit}}}`。国内区 `chatBase` 是 `https://copilot.tencent.com`
   （`www.workbuddy.cn` 是同集群另一入口，两处都答 200）。
2. **产物是 24 小时有效的 COS 签名 URL，不是 base64。** 实测响应里
   `data.data[0].url` 指向 `ai-corpus-backup-1258344699.cos.ap-beijing.myqcloud.com`，
   带 `q-sign-time`（起止各 24h）。插件把这个 URL 原样交给模型与用户，并在返回值里
   写明「约 24 小时失效，要长期保留请及时下载」。
3. **只有国内区有生图模型。** 国内区 `/v3/config` 的 62 条模型里只有
   `hunyuan-image-alpha` 带 `text-to-image` 标签；国际区**一条都没有**。所以工具
   **只在国内区注册**——国际区注册出来只会是一个每次调用都报「没有生图模型」的按钮。
4. **模型目录要多读一次同一份文档。** 生图工具需要 `data.models` 里的媒体标签，
   而聊天目录投影时会把它们丢掉，所以它**另外发一次只读 GET** `/v3/config`（国内区
   同样走 `/v3` → `/v2` 降级，与聊天目录一致），工具侧对结果做 5 分钟缓存。它只读、
   不花积分，但每次冷缓存确实多一次请求——如实记在这里，不要写成「零新增请求」。
5. **它是「花钱」的工具，所以按花钱的工具对待。** 缺省即**独占执行**
   （`isConcurrencySafe` 不声明），失败后 **30 秒冷却**，并且工具描述里直接写明单价，
   让模型自己知道「不要为了试错连续调用」。**冷却只看「请求是否真的发出去了」**：
   读目录失败、参数写错、未登录都没花钱，不冷却。

## 工具契约

| 项 | 值 |
| --- | --- |
| 名称 | `workbuddy_draw_image` |
| 参数 | `prompt`（必填，非空字符串）、`size`（可选，默认 `1024x1024`）、`model`（可选） |
| 输出 | `url`、`model`、`prompt`、`hint` 必填；`credit`、`path` 可选 |
| 超时 | 180 000 ms（实测单张 12.9–38.7 秒，留足余量） |
| 执行模式 | 独占（不声明 `isConcurrencySafe`） |
| 注册条件 | 国内区启用（`regionEnabled(config, 'cn')`）且有 `tools` 服务 |

`model` 填了但目录里没有时**直接报错**并列出可用模型，不会把不存在的模型 id 发上去
换一个上游 404——那样报错只会是「route config not found」，读者无从知道是名字写错了。

## 上游协议

请求头（`imageHeaders()`，`src/upstream.ts:1026`）：

```
Authorization: Bearer <accessToken>
Accept: application/json, text/plain, */*
Content-Type: application/json
User-Agent: WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0
X-Product: SaaS
X-Requested-With: XMLHttpRequest
X-User-Id / X-No-User-Id: 1
X-Enterprise-Id / X-No-Enterprise-Id: 1
X-Domain / X-No-Department-Info: 1
X-Conversation-Id / X-Conversation-Request-Id / X-Conversation-Message-Id: <每请求新 UUID>
```

**刻意不带 `Origin` / `Referer`**：取证探针就是这套头拿到 200 的，多带两个头只是多一个
可能被网关拒掉的变量，没有收益。

请求体按官方 CLI 的 `buildBaseRequestBody` 分支（`buildImageBody()`）：

- `hunyuan-*`：`{model, prompt, size, n: 1}` —— **只**加 `n`，不加 `response_format`；
- `gemini-*`：`{model, prompt, size}` —— 什么都不加；
- 其它：`{model, prompt, size, response_format: 'b64_json'}`。

响应解析（`parseImageResponse()`）：先看信封 `code`（HTTP 200 也可能 `code !== 0`），
再取 `data.data[0]` 的 `url` 或 `b64_json`，最后从 `data.usage.credit` 读实际扣费。
上游给了 base64 时，插件落盘到系统临时目录下的 `workbuddy-image-gen/`
（`os.tmpdir()` 派生，macOS 是 `$TMPDIR`、Linux 是 `/tmp`、Windows 是 `%TEMP%`）
里的 `<model>-<时间戳>.png`，返回 `file://` URL 与本地绝对路径——不让 2 MB 的
base64 直接灌进对话。

## 失败分类与冷却

| HTTP | code | 说法 |
| --- | --- | --- |
| 401 / 403 | `AUTH` | 提示重新登录 |
| 404 | `NO_ROUTE` | 提示该区没有生图路由 |
| 429 | `RATE_LIMIT` | 提示限流 |
| 其它 | `UPSTREAM` | 抽信封里的 `msg` |

冷却只对**真的发过请求**的失败生效（`AUTH` / `RATE_LIMIT` / `NO_ROUTE` / `UPSTREAM` /
`EMPTY_RESULT`，以及非本模块的异常）。参数写错、未登录、目录里没有模型这三类**不进冷却**
——它们一分钱没花，冷却只会让人以为工具坏了。

## 安全

- **凭据不出宿主进程**：工具在宿主侧执行，token 只用于这一次 `fetch`，不进对话上下文、
  不进页面。与积分读数那条链路的边界一致。
- **桌面 App 的认证文件始终只读**：`WORKBUDDY_AUTH_FILE` 只在测试里用来指向它，
  生产路径读的是插件自己的凭据库。

## 取证与联调记录

- **模型发现**：国内区 `/v3/config` → `selectMediaModels(data.models, 'text-to-image')`
  → `[{"id":"hunyuan-image-alpha","name":"Hunyuan Image Alpha","tags":["text-to-image"]}]`。
- **真实出图**：同一凭据 `POST /v2/images/generations` → HTTP 200、12.9 秒、
  `credit: 5.71`、COS 签名 URL；下载产物 2 065 707 字节、PNG magic
  `89-50-4E-47-0D-0A-1A-0A`、1024×1024，画面与提示词一致（水彩橘猫、窗台、暖光），
  右下角带「AI生成 WorkBuddy」水印。
- **测试**：`tests/image-gen.spec.ts` 33 条，覆盖模型筛选与去重、`pickImageModel`、
  三分支请求体、响应解析（url / b64 / `code !== 0` / 空结果）、失败分类、工具的
  schema 形状与「返回值键严格落在 `output.schema` 里」、冷却只对计费失败生效、
  目录 TTL 只读一次、base64 落盘、`render` 的 markdown。

## 没做的事（如实登记）

- **图生图（`/v2/images/edits`）与视频（`/v2/videos/generations`）没有暴露成工具。**
  两条端点的存在与模型名（`hunyuan-image-alpha-edit`、`minimax-video-h3`、
  `kling-video-v3`）已由探针确认，但**没有跑通一次真实调用**，所以不给用户一个
  「看起来能用」的按钮。要做就单独做一轮联调再开。
- **国际区不支持**：不是没做，是上游目录里没有媒体模型。
- **不做批量**：一次调用一张图、一份积分。没有「一次画四张」的参数——那是一次不可控支出。
