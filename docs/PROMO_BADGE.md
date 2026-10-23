# 上游活动徽标：数据来源与判定规则

> 日期：2026-10-21 · 取证时版本：4.13.1（`upstream/main` = `2c1626b`）
> 取证对象：上游模型目录响应体（`/v3/config` 的 `data`）里的活动字段
> 复核方式：用本机已有的两个区域账号**只读**拉一次目录配置，不消耗任何积分

## 结论

1. **上游在模型目录的同一次响应里下发活动信息**——`data.modelPromotions`（促销）与
   `data.modelTiers`（权益/等级标记）。两者与 `data.models` **同层**，插件读取模型目录时
   顺手就能拿到，**不需要新增任何一次请求**。
2. **两个区域都下发活动字段**：国内区实测 8 条促销 + 1 条等级标记（中文标签），国际区
   5 条促销 + 1 条等级标记（英文标签）。
3. **「按客户端通道下发」是唯一的关键变量**：同一条凭据、同一个 URL、同一天，
   `/v3/config` 的答案取决于请求头里的**客户端身份**。以 App 身份（`WorkBuddy/… CLI/…`）
   去要，答案里带 `modelPromotions` / `modelTiers`；以纯 CLI 身份去要，答案是它的**严格
   子集**——**两个数组都不在里面**。插件此前用 CLI 身份读国内区的 `/v3/config`，
   于是国内版模型行一个徽标都画不出来（根因见下文「根因」）。
4. 徽标必须按**当前时钟**求值，而不是把解析那一刻的快照冻住；并且要**保留全部候选活动**
   再按优先级挑选——上游会用「同一模型两条互补条目」表达时段，只留一条必然出错。
5. 换身份会让国内区名单多 `auto`、少 `minimax-m2.7`（各 20 个，其余同名同价）。这**不能**
   变成「默默撤下用户正在用的模型」：读名单时把用户的勾选一起带上，名单 = 上游名单 ∪
   （用户已勾选、且同一份文档仍然列出的模型）。仍然**零新增请求**。

## 数据来源

| 区域 | 端点 | 客户端身份（User-Agent） | 结果 |
| --- | --- | --- | --- |
| 国内区 | `GET https://copilot.tencent.com/v3/config` | `WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0` | 22 个键，`modelPromotions` **8 条**、`modelTiers` **1 条**、`models` 62 条 |
| 国内区 | `GET https://www.workbuddy.cn/v3/config` | 同上 | 同上（桌面端自己也是拉这个地址与这个身份） |
| 国内区 | `GET https://www.codebuddy.cn/v3/config` | 同上 | 同上 |
| 国内区 | `GET https://copilot.tencent.com/v3/config` | `CLI/2.63.2 CodeBuddy/2.63.2` | 5 个键，35 个模型，**两个活动数组都没有** |
| 国际区 | `GET https://www.workbuddy.ai/v3/config` | App 身份 | 17 个键，`modelPromotions` **5 条**、`modelTiers` **1 条**、`models` 28 条 |
| 国际区 | `GET https://www.codebuddy.ai/v3/config` | App 身份 | 同上（同一份国际产品配置，换个官方主机） |

主机之间**没有差别**：`www.workbuddy.cn`、`copilot.tencent.com`、`wb.tencentbuddy.com`、
`www.codebuddy.cn` 在同一个身份下答案逐字节一致。所以要改的从来不是「地址」。

插件两个区域都走 `/v3/config`（`GLOBAL_CONFIG_PATH`，`src/upstream.ts`），国内区失败时
回落 `/v2/enterprises/personal/models`——两处读的是同一个 `data`，所以**促销是零新增
请求**的副产品。

## 根因：产品配置按「客户端通道」下发，而不是按主机或账号

上游把「有哪些模型、哪些活动」放在同一份**产品配置文档**里，按请求方声明的**客户端
身份**裁剪出不同形状的答案：

| User-Agent | 国内区 `/v3/config` 的答案 |
| --- | --- |
| `CLI/2.63.2 CodeBuddy/2.63.2`（纯 CLI 身份，插件此前用的） | 5 个键、35 个模型、**无** `modelPromotions` / `modelTiers` |
| `WorkBuddy/5.8.3`（App 身份，缺 CLI 段） | 18 个键、37 个模型、**无**活动数组 |
| `WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0`（App 的真实身份） | 22 个键、62 个模型、**8 条促销 + 1 条等级标记** |

版本号是**惰性**的：`WorkBuddy/1.0.0 CLI/2.63.2 CodeBuddy/2.63.2` 与
`WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0` 答案完全一致。决定答案形状的是**头里声明
的通道**，不是版本。

这个身份不是插件自造的：**它就是上游自己发的头**。桌面端 `app.asar` 里的
`buildVlmGatewayHeaders` 这样拼：

```js
headers['User-Agent'] = [`WorkBuddy/${appVersion}`, `WorkBuddy/${appVersion}`,
  ...(cliVersion ? [`CLI/${cliVersion}`] : [])].join(' ')
```

桌面端自己的日志（`~/.workbuddy/logs/main.log`）实证了这一次请求：

```
[CloudProductManager] fetch cloud product headers: {"user-agent":"WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0","x-product":"SaaS","x-request-id":"<uuid>"}
[CloudProductManager] fetch cloud product from url:https://www.workbuddy.cn/v3/config success
```

即：**CLI 通道继承 IDE 的 UA**（CLI 产物里有 `CLIENT_INFO_USER_AGENT_EXTENSION` 与
`X-Skip-User-Agent-Merge`），所以「CLI 通道带 WorkBuddy 段」是上游自己的客户端身份，
不是伪造。插件以这个身份读产品配置，拿到的是**和桌面端同一份文档**。

### 换身份带来的目录变化（以及为什么可以接受）

国内区 App 身份的 `cli` 名单与 CLI 身份只差一项：**多 `auto`、少 `minimax-m2.7`**，
其余 19 个模型**同名同价**（`hy4-preview` x0.29、`hy3` x0.00、`step-5-preview` x0.00、
`space-bunny` x0.08、`deepseek-v4.1-flash` x0.11、`glm-5.2` x0.79、`glm-5.3` x0.69、
`kimi-k2.8-preview` x0.77 …）。两个模型都**实测可对话**（POST
`https://copilot.tencent.com/v2/chat/completions` 均 HTTP 200；上游把 `auto` 解析成
`hy4-preview`），所以换身份不会让任何模型变得不可用；换来的是与桌面端**同一份名单**——
桌面端的模型选择器里本来就是 `Auto / 快速 / 均衡 / 极致 / Deep / Hy4 / Hy3 / Step-5 …`。
顺带一提，插件自己的**静态兜底名单**（`src/catalog.ts`，2026-08-30 抓的）里第一个模型
就是 `auto`：CLI 通道那份名单才是异类。

**但「同一份名单」不能变成「默默撤下用户正在用的模型」。** 运行时目录是
`deriveCatalog(roster, enabled)`——它用**用户的勾选**去过滤上游名单，所以名单一旦少了
某个 id，用户勾着的那个模型就会**无声消失**（issue #32 那一类故障，只是早了一步）。
因此读名单时把**用户自己的勾选**一起带上：名单 = 上游名单 **∪**（用户已勾选、且**同一份
文档仍然列出**的模型）。`minimax-m2.7` 就在 App 身份文档的 `models` 数组里（`x0.26`、
200K in / 48K out），所以勾过它的用户不会因为换身份而失去它；上游**真正下架**的模型
不会被这条规则凭空复活（文档里没有就不加）。

- 实现：`src/upstream.ts` 的 `selectCliModels(rawModels, agents, keepIds)` 与
  `fetchModels(credential, signal, keepModelIds)`；`src/index.ts` 的 `discoverModels`
  把 `regionStateOf(...).enabledModelIds` 传进去。
- 代价：**零额外请求**（还是那一次 `/v3/config`），只是名单里多保留用户勾选的那几行。


### 国内区的 8 条促销 + 1 条等级标记（真实样本，2026-10-21）

| id | 标签 | 模型 | 时段/生命周期 |
| --- | --- | --- | --- |
| `glm-52-night-discount-202607` | 夜间折扣 | `glm-5.2` | 每日 23:00 → 次日 7:50 |
| `glm-52-night-discount-daytime-badge-202607` | 夜间折扣 | `glm-5.2` | 每日 7:50 → 23:00（常驻徽标） |
| `hy3-free-trial-202608` | 限时免费 | `hy3`（+`hy3-b`/`hy3-c`） | 07-06 → 11-01，`display: activeOnly` |
| `hy4-night-discount-badge-202609` | 夜间免费 | `hy4-preview`（+ctrl/exp） | 每日 23:00 → 次日 8:00 |
| `hy4-night-discount-daytime-badge-202609` | 夜间免费 | 同上 | 每日 0:00 → 8:00 与 23:00 → 23:59 |
| `ds-discount-daytime-badge-202608` | 夜间折扣 | `deepseek-v4.1-flash`、`deepseek-v4-pro`（+ioa 变体） | 每日 0:00 → 23:59 |
| `space-bunny-discount-202610` | 限时折扣 | `space-bunny` | 10-02 → 10-08（已过期，故今日不显示） |
| `step-5-discount-daytime-badge-202610` | 独家限免 | `step-5-preview` | 10-12 → 10-26 |
| `tier-standard-2026q3`（等级标记） | 订阅优先 | `glm-5.3`、`glm-5.3-flash`、`kimi-k2.8-preview` | 无时段 |

20 个模型里有 **10 个**带徽标条目；与桌面端截图里逐个对得上（Hy4 preview「夜间免费」、
Hy3「限时免费」、Step-5-Preview「独家限免」、Deepseek-V4.1-Flash「夜间折扣」、
GLM-5.3「订阅优先」、Space-Bunny 今日无徽标——它的活动 10-08 就到期了）。

## 字段形状（真实样本，2026-10-21 取）

```jsonc
{
  "id": "hy3-free-trial-202608",
  "kind": "discount",
  "enabled": true,
  "priority": 200,
  "modelIds": ["hy3"],
  "badge": { "label": "限时免费", "color": "#009273", "display": "activeOnly",
             "icon": "data:image/svg+xml;base64,…" },
  "discount": { "discountedCredits": "0x", "displayMode": "replace", "factor": 0 },
  "hover": {
    "textZh": "7月6日–10月31日，每日赠送免费额度。",
    "action": { "labelZh": "去使用", "type": "selectModel" }
  },
  "schedule": {
    "timezone": "Asia/Shanghai",
    "validFrom": "2026-07-06T00:00:00+08:00",
    "validUntil": "2026-11-01T00:00:00+08:00"
  }
}
```

国际区同一字段的标签是英文（`Free now` / `Pro Only`），国内区是中文；两边的 `badge`
结构一致，**国内区另有 base64 `icon` 与可选的 `display: 'activeOnly'`**——解析器两者都吃。

等级标记（`modelTiers`）少两个字段：没有 `schedule`（因此**恒定显示**），也没有 `discount`，
但有 `hover.action.type = "upgrade"`：

```jsonc
{
  "id": "gpt-pro-only",
  "badge": { "label": "Pro Only", "labelEn": "Pro Only", "color": "#009273" },
  "hover": {
    "textEn": "Exclusive to Pro subscribers.",
    "textZh": "模型仅面向 Pro 用户开放。",
    "action": { "labelZh": "升级 Pro", "type": "upgrade" }
  },
  "modelIds": ["gpt-6-astra", "gpt-6.1-sol", "…"],
  "priority": 200,
  "requiredUserType": "standard",
  "tier": "standard",
  "trackKey": "gpt_pro_only"
}
```

### 必须丢弃的「污染项」

国际区的 `modelPromotions` 数组里混着**不是活动**的条目：

```jsonc
{ "id": "hy-image-3.5", "name": "HY-Image-3.5", "tags": ["…"] }
{ "id": "kling-video-v3", "name": "kling-video-v3", "videoGeneration": { "…": "…" } }
```

它们**没有 `modelIds` 数组、也没有 `badge`**。判定规则因此很干脆：
**没有 `modelIds` 或没有 `badge` 的条目一律丢弃**（`src/promo.ts` 的
`parseWorkBuddyPromos`）。同理 `enabled === false` 的条目不参与。

## 时间语义

| 字段 | 含义 | 判定 |
| --- | --- | --- |
| `schedule.validFrom` / `validUntil` | 活动绝对生命周期（ISO 8601，带偏移量） | **左闭右开**：`validFrom` 当刻生效，`validUntil` 当刻即失效 |
| `schedule.daily[]` | 每日生效的墙钟时段（`'HH:mm'`，配 `schedule.timezone`） | **起点含、终点不含**；`end < start` 视为**跨零点**（如 `23:00 → 07:50`） |
| `schedule.daily[]` 的两端相等 | 同一时刻既是起点又是终点 | **整天 24 小时**（`[X, X+24h)`）。这是「起点含、终点不含」的唯一例外：半开区间 `[X, X)` 按集合语义是空集，但上游用它表达「全天」，读成空集会把一个真在跑的活动藏起来 |
| `schedule.daily[]` 的终点写成 `24:00` | 当天末尾 | 接受，等价于 `1440`。上游目前把「全天」写成 `0:00 → 23:59`，那会在 23:59 与零点之间留一个 1 分钟的洞；接受 `24:00` 让这种窗口能无洞地表达 |
| `schedule.daily` 存在但**一条都解析不出** | 上游说了有时段，但形状读不懂 | **永不运行**（`dailyUnusable`）。**不能**当作「没有时段 = 全天」——那会把夜间活动变成 24 小时常驻徽标，是这个方向唯一会「说多」的错 |
| `schedule.daily` 缺失或为空数组 | 上游没说时段 | 视为 24 小时活动，跑不跑只看绝对生命周期 |

上游用**两条互补条目**表达一个「夜间活动」：一条带 `discount`、落在夜间时段里；
另一条不带 `discount`、落在白天的互补时段上，只负责把徽标常驻。
所以**必须保留全部候选**再逐条按当前时刻求值——只按「当时选中的那一条」渲染，
夜间加载一次，白天就会继续挂着「夜间折扣」。

## 实现取舍

- **徽标是时钟的函数**：解析只负责结构化，判定发生在渲染时刻（`Date.now()`）。
  卡片展开时每 60s 轮询一次，因此徽标的新鲜度上限是 60s，无需另设定时器。
- **每个模型只画一个徽标**：先取「此刻正在运行」的候选里 `priority` 最高的一条；
  没有正在运行的，再退回「常驻型」（`display !== 'activeOnly'`）里优先级最高的一条。
  同优先级时**促销优先于等级标记**（`source: 'promotion'` 排在 `source: 'tier'` 前面）
  ——这一条写在比较器里，不依赖两个数组的读取顺序。
- **「正在运行」只算有时段声明的条目**：等级标记（`订阅优先`）没有 `schedule`，
  对它的 `promoActiveAt` 恒为 true；若把它算进「正在运行」，一个高 `priority` 的常驻
  等级标记就会盖掉一条 `priority` 更低、但时窗真的开着的夜间促销。所以第一步只在
  **带 `schedule` 的条目**里选，无 `schedule` 的常驻徽标只在第二步参与。
- **常驻徽标仍受绝对窗口约束**：`validUntil` 一到就消失，不做「过期了还挂着」的常驻。
  这条与桌面端一致：`space-bunny-discount-202610` 已经在 10-08 到期，桌面端今日也**不**
  给 Space-Bunny 画徽标。
- **文案与颜色用上游的**：上游按区域自带语言（`label` / `labelEn`、`hover.textZh` /
  `hover.textEn`），插件不翻译、不改写；只在 `hover` 之外补上**有效期区间**与
  **每日时段**（含上游声明的时区），让「为什么现在有这枚徽标」一眼可查。
- **颜色只接受 `#rgb` / `#rrggbb`**：上游给的就是这两种写法，其它一律当作没有颜色，
  避免把任意字符串塞进 CSS。
- **产品配置用 App 身份读，聊天用 CLI 身份发**：这两件事的契约不同，混用会出事——
  聊天那头绑着会话身份三元组，产品配置这头决定拿到哪一份文档。
- **换身份后的名单 = 上游名单 ∪ 用户勾选且文档仍列出的模型**：运行时目录用用户的勾选
  去过滤上游名单，所以名单少一个 id 就等于「默默撤下用户正在用的模型」（issue #32 那一类
  故障）。把勾选一起带进这一次读取，既保住用户正在用的模型，又不额外发请求；上游真正
  下架的模型不会被复活（文档里没有就不加）。

## 未做与边界

- 上游 `hover.action`（`selectModel` / `upgrade`）**没有做成可点击动作**——徽标目前只是
  提示，点它不会替你选模型、也不会跳升级页。
- 上游在**国内版**的产品配置里还会带 **base64 SVG icon**，没有内嵌（体积与安全）；
  徽标用 CSS 胶囊自绘。
- **活动数组完全依赖上游的形状**：上游改了字段名，徽标就整体消失（不会画错，但也不会
  画对）。这是刻意的取舍——插件不猜活动内容，只画上游明确写出来的那一条。

## 取证方式

只读拉取、逐字段比对，脚本与样本落在本机临时目录（不入库）：
`$env:TEMP\wb-cn-isolate.mjs`（国内区**只变 User-Agent** 的隔离矩阵 + 完整响应体）、
`$env:TEMP\wb-cn-ua-roster.mjs`（8 种身份变体 × 键数/模型数/促销数/名单）、
`$env:TEMP\wb-cn-compare-models.mjs`（两种身份下同名模型的价格与上下文字段）、
`$env:TEMP\wb-cn-chat-auto.mjs`（换身份后 `auto` / `minimax-m2.7` 是否仍可对话）、
`$env:TEMP\wb-global-isolate.mjs`（国际区的同一组隔离）、
`$env:TEMP\wb-ua-parity.mjs`（两区「当前身份 vs App 身份」的名单差异）、
`$env:TEMP\wb-e2e-badges.mjs`（直接 import `src/promo.ts` + `src/upstream.ts` 的端到端验证）。
上游桌面端那一侧：`$env:TEMP\wb-asar-scan.mjs`（按字节偏移扫 `app.asar`，
找到 `buildVlmGatewayHeaders` 与 `CloudProductProvider`）、以及本机
`~/.workbuddy/logs/main.log` 里的真实请求头。本机落地快照
`~/.workbuddy/cache/acc-product-config-v3.json` 与
`~/.workbuddy/storage/user-<uid>-personal/scoped/*/wb-product-config.json`
用于**核对**上游确实在发这些数组（它们是桌面端合并后的落地副本）。
凭据取自插件自己的凭据库 `$DSH_HOME/workbuddy-vault/<region>/<accountId>.json`，
**只发 GET**，不触发任何计费动作。
