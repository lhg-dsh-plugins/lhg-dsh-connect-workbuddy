# 推理强度（Reasoning Effort）调查记录

> 记录日期：2026-08-30
> 状态：**已修复**（2026-09-17，issue #7，随 2.0.10 发布）
> 触发：用户报告 DSH 中「思考开关只有 deepseek 有，其他都没有」；进一步指出 deepseek 实际支持多档位，「只有一个强度是不对的」。

> **本文件是调查当时的快照（2026-08-30），部分结论已被后续实测推翻。**
> 修复见 `4c39645`「解析单数 effort 形态的推理声明，单数模型不再注册为非推理」：
> `parseReasoning` 现同时解析两态，单数形态经 `singularEffortLadder` 折叠为复数
> （`supportedEfforts` 展开全阶梯 `low/medium/high/xhigh/max`、单数值折入
> `defaultEffort`、`canDisableThinking` 视为 `true`），adapter / 卡片 / 持久化零改动即生效。
> **下文凡与「已修复」冲突处，均已就地标注「⚠️ 已过期」——保留原文以存证当时的推理路径。**

---

## 一、问题现象

DSH 模型选择器里，各 WorkBuddy 模型的推理强度档位表现不一致，大量模型没有可选档位。用户观察到：

- deepseek 有一个「思考」相关状态
- glm 系模型「没开关但有三个选项」
- 其他模型（kimi / minimax / hy3 等）完全没有档位

---

## 二、上游 `/models` 端点数据（纯上游，实测 16 个 cli 模型）

上游 `reasoning` 字段有两种形态，且每个模型都带顶层 `supportsReasoning` / `onlyReasoning`：

### 形态 A：`supportedEfforts` 数组（可选手动档位）

| 模型 | supportedEfforts | defaultEffort | canDisableThinking |
|---|---|---|---|
| glm-5.3 | low, high, xhigh | high | true |
| glm-5.3-flash | low, high, max | high | true |
| hy3-x | low, high | high | false |
| hy4-preview | high | high | false |
| hy4-preview-x | high | high | false |

### 形态 B：`effort` 单值（固定档位，无 supportedEfforts）

| 模型 | effort | 备注 |
|---|---|---|
| deepseek-v4-flash | high | 仅推理（onlyReasoning:true） |
| deepseek-v4-pro | high | 仅推理 |
| hy3 | high | 仅推理 |
| auto | high | 仅推理，默认模型 |
| glm-5.2 | medium | 仅推理 |
| glm-5.1 | medium | 仅推理 |
| glm-5v-turbo | medium | 仅推理 |
| kimi-k3-1 | medium | 仅推理 |
| kimi-k2.7 | medium | 仅推理 |
| kimi-k2.6 | medium | 仅推理 |
| minimax-m3 | medium | 仅推理 |

> 所有 16 个 cli 模型 `supportsReasoning` 与 `onlyReasoning` 均为 `true`。

---

## 三、当前代码问题（根因）

> ⚠️ **已过期（2026-09-17 修复）**：以下是当时（2.0.9 及以前）的代码形态，现已是两态解析。保留以说明问题成因。

`src/upstream.ts` 的 `parseReasoning` 当时**只解析形态 A**：

```ts
const supportedEfforts = Array.isArray(raw['supportedEfforts']) ? ... : undefined
const defaultEffort = typeof raw['defaultEffort'] === 'string' ? ... : undefined
const canDisableThinking = typeof raw['canDisableThinking'] === 'boolean' ? ... : undefined
if (supportedEfforts === undefined && defaultEffort === undefined && canDisableThinking === undefined) {
  return undefined   // ← 形态 B（只有 effort）走到这里，返回 undefined
}
```

**后果**：形态 B 的 11 个 cli 模型（deepseek-v4-flash/pro、hy3、auto、glm-5.1/5.2、glm-5v-turbo、kimi-k3-1/k2.7/k2.6、minimax-m3）的 `reasoning` 被整体丢弃，`WorkBuddyModelInfo.reasoning` 为 `undefined`。

---

## 四、DSH 链路：无档位时强度怎么定

> ⚠️ **本节末尾的推断已被推翻（2026-09-17 实测）**：原文推断「上游收到无 `reasoning_effort` 的请求时按模型默认 `effort` 运行，即这些模型一直以 high/medium 在思考」。修复时的两网关实测结论相反——**不发 `reasoning_effort` 时上游返回 0 思考字符，默认即思考关闭**。因此当时这些模型的真实症状不是「一直以默认强度思考」，而是**根本没有思考**。保留下文原文以存证当时的推断路径。

当模型 `reasoning` 为 falsy（当时 deepseek 等）时，DSH 侧（`@deepseek-ai/dsh-llm-pi-ai` 的 `reasoningInfo`）返回**空对象**——不显示任何档位；请求时 `resolveReasoningLevel` 返回 `undefined`，**请求体不含 `reasoning_effort`**。

shim 原样透传（`prepareChatBody` 不处理 effort）。当时**推断**：WorkBuddy 上游收到无 `reasoning_effort` 的请求时，按模型默认 `reasoning.effort` 运行：

- deepseek → 固定用 **high**，且无法调整
- kimi / minimax / glm-5.1/5.2 / hy3 → 固定用 **medium**，且无法调整

即（原推断）：这些模型**实际一直在思考，但用户无法选择强度**。这解释了用户「deepseek 有思考但只有 fixed」的观察。

> 上述两条推断**均已被推翻**，见本节顶部提示。

---

## 五、实测 chat 接口：模型实际接受的档位

> 注意：以下是通过向 `/v2/chat/completions` 发带不同 `reasoning_effort` 的请求实测（HTTP 200 = 被接受）。**「被接受」不等同于「档位产生不同行为」**，且此探测会消耗积分，未覆盖全部模型×全部档位组合。

> ✅ **本节结论被修复采用**（第五节是本文件中被实证采纳的一节）。2026-09-17 的修复复测追加了两条关键事实：单数形态模型对全阶梯档位返回各异的 `reasoning_content`，且**不发 `reasoning_effort` 时零思考**——后者正是「单数 `effort` 是默认档而非唯一档」的直接依据。

| 模型 | 实测接受档位 |
|---|---|
| deepseek-v4-flash | low, medium, high, max |
| deepseek-v4-pro | minimal, low, medium, high, xhigh, max（全部） |
| hy3 / auto / hy3-x / hy4-preview | minimal, low, medium, high, xhigh, max（全部，前 4 个模型完整探测） |
| kimi-k3-1 | low, medium, high, max |
| minimax-m3 | low, medium, high |

> 关键结论：**上游 `/models` 端点只标了 `effort` 默认档位，但模型实际接受多个甚至全部档位。** 上游端点数据不完整。

未完整实测：glm-5.3 / glm-5.3-flash / glm-5.2 / glm-5.1 / glm-5v-turbo / kimi-k2.7 / kimi-k2.6 / hy4-preview-x / deepseek 是否接受 minimal/xhigh。

---

## 六、DSH 侧档位契约（pi-ai）

`@earendil-works/pi-ai` 的 `ThinkingLevel`：`minimal | low | medium | high | xhigh | max`；`ModelThinkingLevel` 追加 `off`。

- `getSupportedThinkingLevels(model)`：`!model.reasoning` → 返回 `["off"]`
- `thinkingLevelMap`：`Partial<Record<ModelThinkingLevel, string | null>>`；缺失键用 provider 默认，`null` 表示该档位不支持
- `workBuddyThinkingLevelMap`（`src/adapter.ts`）：**未改动**——只从 `supportedEfforts` 建档位，且 `canDisableThinking !== true` 时 `off` 置 `null`。修复选择在**解析层**折叠而非改 adapter，因此这里照旧即可自动生效；`minimal` 不在 `SINGULAR_EFFORT_LADDER` 内（两网关复数载荷从未出现该档），故未被展开。

---

## 七、待决策（修复方向）

> ✅ **已决策（2026-09-17）**：采纳「结合实测」一路。修复把单数形态在解析层折叠为全阶梯（`low/medium/high/xhigh/max`），**不是**只显示声明的那一档。理由是实测证据：`effort` 是默认档、且各档 `reasoning_content` 确有差异。`minimal` 因从未在任何复数载荷中出现而不予展开。

用户要求**只依据上游 `/models` 端点**的信息梳理。基于该端点：

- **严格按上游**：形态 B 模型修复后是「固定档位」（deepseek=high，kimi=medium…），DSH 只显示该档位或标为 fixed，不开放其他档位。
- **结合实测**：deepseek 等实际接受多档位，可补一组档位（需用户确认每个模型真实档位）。← **最终采纳**

**当时的讨论状态：未决定。** 后由 issue #7 的实测结论定案。

---

## 八、按纯上游数据的信息增强清单（对应 `parseUpstreamModel`）

| 字段 | 当前 | 修复后 | 影响模型 | 落地情况 |
|---|---|---|---|---|
| `reasoning.effort` | 不解析（丢弃） | 解析并保留 | 11 个形态 B 模型 | ✅ 已落地（折叠为全阶梯 + 默认档） |
| `supportsReasoning` | 不解析 | 解析 | 全部 16 个 | ❌ 未落地（`thinkingLevelMap` 已够用，未采纳） |
| `onlyReasoning` | 不解析 | 解析 | 全部 16 个 | ❌ 未落地（同上） |
| `disabledMultimodal` | 不解析（图片已改手动） | 作为 `supportsImages` 的一票否决 | 见下（实测无矛盾条目） | ✅ 已落地（2.2.0，随图片默认勾选一起解析） |

> 后三行是**当时拟议的增强**，非缺陷——`reasoning` 档位已由 `parseReasoning` 全权决定，`supportsReasoning` / `onlyReasoning` 至今确实未被解析（全库 grep 无引用），这不影响档位呈现。
>
> **更正注（2.2.0）**：末行的「未采纳」已过期。图片输入改为「刷新时用上游 `supportsImages` 覆盖默认勾选」后，`disabledMultimodal` 已被解析为**一票否决**。该否决是**防御性**的：2026-09-29 只读实测 CN 的 30 个条目，仅 12 个带该字段、6 个为 `true`（均为不在 CLI 名册内的旧模型如 `glm-5.0` / `glm-4.7` / `hunyuan-*`），而 `supportsImages: true && disabledMultimodal: true` 的矛盾条目为 **0**——即「两个标记矛盾」并非实测结论，只是冲突时的取向。

---

## 九、影响文件

- `src/upstream.ts`：`WorkBuddyReasoning` 接口 + `parseReasoning` + `parseUpstreamModel` —— ✅ **已修改**（新增 `SINGULAR_EFFORT_LADDER` 与 `singularEffortLadder`，`parseReasoning` 改为两态）
- `src/adapter.ts`：`workBuddyThinkingLevelMap` —— ⬜ **未修改**（刻意：解析层折叠后自动生效）
- `src/client/WorkBuddyCard.tsx` + `locales.ts` —— ⬜ **未修改**（同上）
- `src/catalog.ts`：fallback 静态目录 —— ⬜ **未修改**（同上）

> 本文件记录的调查结论已由 `4c39645` 落地（随 **2.0.10** 发布），测试新增 6 例覆盖单数折叠、混合形态优先级与线上载荷集成。

---

## 十、issue #59 追问：「reasoning 在不在 body 里」与「上游忽不忽略它」是两回事（2026-10-16）

> 本节**不改动**上面任何历史结论，只回答一个被混为一谈的问题。触发：#59 的 body 报告探针实际跑完（本机 `~/.dsh/body-reports/cn.jsonl`，**685 条**真实捕获）后，出现两种互相矛盾的自测结论。

### 10.1 两个命题必须分开

| 命题 | 判据 | 实测 |
| --- | --- | --- |
| (i) `reasoning` **在不在** body 里 | 报告里的 `reasoning` 桶是否非空 | **在**（本机 77/685 条含 reasoning 块） |
| (ii) 上游**忽不忽略**它 | 同一份 body 在两个网关的计费/行为对照 | **2026-10-18 晚已可定案：不计费**（报告者同区增量实测 + 本仓库系数复算，见 §11.7；原记「尚未测定」） |

**这两条互不蕴含。** 一条 body 里有 reasoning 块，既不能推出上游会按它计费，也不能推出上游会忽略它 —— 后者要拿**同一份 body**去两个网关各发一次才知道。(i) 为真**不构成**对 (ii) 的任何证据。

### 10.2 为什么「77/685」与「0/35」都对

同一个文件、同一个探针，两个人都没错 —— 他们量的是**两个不同的群体**：

- 报告者那一版的汇总（`cn-summary.json`）覆盖**一次会话窗的 35 条**记录，该窗内 `reasoningBucket: "ABSENT (0 occurrences)"`；
- 全文件 **685 条**跨**多个会话**，其中 **77 条**含 reasoning。

**原因不是随机，而是一条与历史长度挂钩的阈值**（见 10.3）：reasoning 只在 `messageCount ≥ 901` 时出现，低于它一律为 0。按「全部 685 条」统计得 77/685，按「一次会话的 35 条」统计得 0/35 —— **分母不同，不是矛盾**。

### 10.3 真正区分它们的是一条**干净的阈值**：`messageCount ≥ 901`

本机 685 条按 `messageCount` 分桶后（桶宽 100），reasoning 的出现**不是渐变，而是开关**：

| `messageCount` 桶 | 条数 | 含 reasoning | 平均字符 |
| --- | --- | --- | --- |
| 100–199 | 70 | 0 | 363,821 |
| 200–299 | 61 | 0 | 409,583 |
| 300–399 | 89 | 0 | 484,553 |
| 400–499 | 53 | 0 | 571,364 |
| 500–599 | 93 | 0 | 700,786 |
| 600–699 | 98 | 0 | 782,050 |
| 700–799 | 95 | 0 | 888,560 |
| 800–899 | 49 | 0 | 868,367 |
| **900–999** | **48** | **48** | 944,262 |
| **1000–1099** | **29** | **29** | 1,006,304 |

**阈值精确且完全可分**：含 reasoning 的 77 条，`messageCount` 最小 **901**、最大 1057；不含 reasoning 的记录里，`messageCount` 最大 **899**。**901 与 899 之间没有任何重叠** —— 即 `messageCount ≥ 901 ⇔ 出现 reasoning`，在这份样本上无一例外。

**⚠️ 前一版的两次误读，均在此更正**：

1. 初版把「同一轮对话被送了两次」当作解释 —— **错**。复核后其依据（大/小两群各自增长、并行存活 29.2 分钟、家族内中位间隔 4.3s / 3.4s 不同步）反而说明那是**两条独立的请求流**，而不是一次请求被复制。**该说法已作废。**
2. 第二版改用「>700 vs <250」两分并报出字符比 2.011 / 2.446 —— **也是错的**。真实分布是**连续**的（桶表可见），在 700 处并无断点；那个「两群」是我自己切的刀口造成的假象。**两个比值都作废**，本节的结论只依赖上表的阈值，不依赖任何字符比。

**900 这个数不来自本插件**：全库 grep 无 900 / 上下文条数上限一类的常量（`src/` 无匹配）。因此它更可能是**上游（pi-ai 或网关侧）对历史长度的一条隐式规则**：低于它时 reasoning 被剥掉、达到它之后被原样带上。**这是推测，尚未定案**，也是 #59 真正值得追的方向。

> **⚠️ 2026-10-18 更正：上面这条「阈值」是统计假象，不是上游规则。已作废。**
>
> 复算全部 685 条后发现：含 reasoning 的 77 条里，**第一条 reasoning 块所在的 message 索引恒为 899**（min = max = 899，77/77 无例外）；而不含 reasoning 的记录，`messageCount` 最大恰为 **899** —— 因为只有长度 ≥ 900 的请求才**可能**包含索引 899 这条消息。于是「`messageCount ≥ 901 ⇔ 出现 reasoning`」只是「索引 899 那条消息带 reasoning」的一条推论（tautology），「901 与 899 无重叠」是它的必然结果，**不构成独立证据**。
>
> 决定性反例：`messageCount = 1057` 那条里，501 条 assistant 消息**只有 14 条**带 reasoning（索引 899、904、906、915、937、939、941、943、991、1017、1019、1025、1027、1035），899 之前一条都没有。如果真是「历史达到一定数量就整段原样重放」，这个数应当是 501，而不是 14。
>
> 真正决定某条 assistant 消息能否以 thinking 形态重放的是 pi-ai 的 `isSameModel`（见 §10.6）。边界落在转写的**一个固定位置**上，与请求长度无关。

**reasoning 块只出现在阈值之上**，且全部挂在 `role: "assistant"` 上（`reasoning: {assistant: 644}`，无其它角色）。这与第 4 节的代码追踪**一致而非冲突**：pi-ai 不把 `thinking` 当**新**内容发出去，但**历史里已有的** assistant 消息在超过某个体量后会被原样重放 —— 于是它出现在 body 里，却**不是本次请求新增的计费内容**。

### 10.4 对 #59 的结论

- **判据 (a)「两份 body 是否本来就不同」：成立，但所依据的机制在 2026-10-18 更正。** 本节原先把 `messageCount ≥ 901` 当作「干净的阈值」，现已证明那是统计假象（见 10.3 的更正框）：真正的判据是 pi-ai 的 `isSameModel`（§10.6）。
- **本节回答的是「reasoning 为什么一会儿在一会儿不在」，不是「区域差异从哪来」。** 那条边界与区域无关（本样本全为 `cn`）。它**支持**「body 的结构差异可以很大」这个更弱的事实，但**不构成**对「区域切换差异源于结构」的直接证明。§10.6 才把这条边与区域切换接到同一个判据上。
- **不要用本节的数去解释报告者的 1.94×。** 本机的边界现象是**同一区域内、转写位置上**出现的，而报告者的 1.94× 是**同一会话跨区域**的。**两者不是同一个量**，初版把二者等同是主要风险。跨区域那笔账由 §10.6 的机制与报告者自己的守恒算术回答。
- **「上游忽略 reasoning」—— 2026-10-18 晚已定案为「不计费」**，见 §11.7。本节自身仍**不回答**它：这里只说明 reasoning **何时进入 body**，没测上游**如何计费**它。
- **下一步**：~~查 `901` 这个疑似上游阈值~~ —— **已结案，见 10.3 更正框**。全库无该常量是对的，但原因不是上游有这条规则，而是这个数根本不是规则。

### 10.5 方法学教训（写给后人）

**「同一个数字、两个分母」比「两个人算错」常见得多。** 探针输出的是 JSON Lines，天然是「全文件」与「当前会话窗」两个群体的混合；报数时必须连**分母及其构成**一起报（这里：`77/685` 与 `0/35` 分别是全库与会话窗），否则两个人会各自确信对方在拿另一个群体说事，而真相是两句话都对。这与本仓库在 `docs/WINDOWS.md` §2 反复强调的证据分级是同一件事：**先钉住样本边界，再谈结论。**

---

## 十一、#59 已定案：判据是 pi-ai 的 `isSameModel`，不是历史长度（2026-10-18）

> 本节是 §10 的**定案与更正**。§10 的三次自我更正（两次误读 + 一次假阈值）都停在同一处：它把「reasoning 什么时候出现」当成了一个**与历史长度有关的上游规则**。它其实是**一条代码判据**，而这条判据同时解释了报告者的跨区域 1.94×。报告者 raphael-y7 在 2026-10-18 的回复里给出了它，本机已独立核对（宿主打包的 `@earendil-works/pi-ai` 版本为 **1.1.0**，路径 `node_modules/@earendil-works/pi-ai`）。

### 11.1 判据本身

`dist/api/transform-messages.js:68`：

```js
const isSameModel = assistantMsg.provider === model.provider
                 && assistantMsg.api      === model.api
                 && assistantMsg.model    === model.id;
```

`buildParams` 在装配请求体之前调用它（`dist/api/openai-completions.js:896`），于是每条历史 assistant 消息按三种结果分流：

| 情况 | 行号 | 结果 |
| --- | --- | --- |
| thinking 为空 | `:85–87` | 丢弃 |
| `isSameModel` 为真 | `:88–91` | **原样保留为 thinking 块** |
| `isSameModel` 为假 | `:92–96` | **降级为 `{ type: "text", text: block.thinking }`** |

`isSameModel` 为假时还会：丢掉被 redact 的 thinking（`:76`）、不保留签名（`:80`）、删掉 tool-call 的 `thoughtSignature`（`:103`）。

**降级不是丢弃** —— 这条最要紧。thinking 文本没消失，它变成了**普通正文**。

### 11.2 于是桶的分歧出在哪里

保留下来的 thinking 块走原始字段路线：`:1002–1008` 写 `assistantMsg[signature] = <thinking>`，`signature` 是**上游流实际用的字段名**，在 `:399–416` 逐块记录（本厂商恒为 `reasoning_content`；本机真实会话里 790 条重放记录全为该值，无第二种）。被降级的块此时**已经是 text 块**，于是 `:964–971` 收集 `assistantText` 时把它并进 `assistantMsg.content`。

本插件只设了 `compat.supportsReasoningEffort`（`src/adapter.ts:200`），`requiresThinkingAsText` 保持 `false` 默认（`:1270`），所以走的是**原始字段**这条分支，而不是 `:983` 的「折进 content」。

净效果：**同一个 thinking 文本，只因那条消息记在哪个 provider/model 名下，就被放进不同的桶。**

### 11.3 这与区域切换是同一件事

`src/adapter.ts:36,39` 把两个区域注册成**两个 provider id**（`workbuddy` / `workbuddy-global`），`toPiModel`（`src/adapter.ts:193–199`）把它们写进 `model.provider`。本机会话日志核对：同一次会话里 `workbuddy/deepseek-v4.1-flash` 与 `workbuddy-global/deepseek-v4.1-flash` **model id 完全相同**，`api` 也相同 —— `isSameModel` 的三条腿里，**只有 `provider` 不同**。

所以一次区域切换，会把**另一侧的全部历史 thinking 一次性降级为正文**，而正文是网关会数的。这就是 1.94×；反方向就是同一公式的 0.696×。

**`model` 那条腿同理**：在一个区域内换模型，也会触发同样的降级。这正是本机 `cn.jsonl`（全为 `cn`）也能看到 reasoning 桶忽有忽无的原因 —— 不需要区域参与。

### 11.4 本机数据怎样印证了它

- 685 条中 77 条含 reasoning；**这 77 条的 reasoning 全部位于转写索引 899 之后**（min = max = 899）。边界是一条**固定位置**，不是长度阈值 —— 长度只是「能不能够到 899」的必要条件，所以 §10.3 的分桶表看起来才像开关。
- `messageCount = 1057` 那条：501 条 assistant 里只有 14 条带 reasoning，且全在 899 之后。若按「达到数量就整段重放」，应为 501 条。
- 签名恒为 `reasoning_content`（790 处，557 个可见 reasoning 块全部不带签名 —— 签名存在于重放元数据里，不在 content 块上）。这条**排除了**「字段名因网关而异」的旧解释：两个网关都叫 `reasoning_content`，按名字分桶预测不出任何差异。
- 结论：本机这份「同区域内」的捕获，与报告者「跨区域」的捕获，是**同一条判据**的两种表现。

### 11.5 归属分层（回应报告者的分层）

1. **设计层 —— 不是 bug。** 不跨 provider/model 重放 thinking 是对的：别家模型的思考过程对当前模型没有上下文价值，还可能被当成正文污染回复。
2. **实现层 —— 这是 DSH 与 pi-ai 之间的一处错配。** `isSameModel` 把 `provider` 当作「是否同一个模型」的**必要条件**，而 DSH 用**两个 provider id 表示同一个模型的两个接入区域**。可修的方向是把判据改成「同 `api` + 同 model id」，`provider` 改为等价组。这一段已写进 `src/body-report.ts` 头注释与 README 已知限制。
3. **后果层 —— 已被 4.8.0 的 `src/context-rescue.ts` 兜住。** 切换区域必然带来计费口径的 ±30%~94% 跳变，相对宿主的压缩阈值（`min(0.8×窗口, 窗口−128000−65536)`）就会表现为「一换区就超限」。rescue 块状折叠因此是必要的，不是权宜。

### 11.6 可证伪的预测（供进一步核对）

1. 只在**单一区域**跑完的会话，切区时应看到接近 0 的跳变（因为没有「另一侧」的 thinking 可供降级）。
2. 跳变量 ≈ **另一侧 thinking 字符数 × 该内容的 token 密度**，而不是「历史总长 × 常数」。

### 11.7 第二轮：计费前提已可定案，但定的是「报告者实测 + 本仓库复算」，不是「本机实测」（2026-10-18 晚）

§10.1 的 (ii)「上游忽不忽略 reasoning」原本记**尚未测定**，`docs/audit/ISSUE59-VERIFY.md` 的 C7 也记 UNVERIFIABLE-LOCALLY。报告者 2026-10-18T09:40 的回复把它推到可定案，同时撤回了他自己两个数、并纠正了我们一个说法。三件事分开记。

**① 报告者撤回的两个数，我们已同步改掉。**

| 数 | 原值 | 更正 | 我们的处理 |
| --- | --- | --- | --- |
| `text`（CN） | 741,952 | **741,687**（= user 69,431 + assistant 672,256） | `src/body-report.ts:16`、`tests/issue59-body-report.spec.ts:27`、`docs/audit/ISSUE59-OPTIONS.md` 三处已改 |
| 隐含系数 0.3518 tok/char | 报过 | **作废**：分母串了，真分母是 555,724（两区 reasoning 之差），不是 812,815 | 从未进过任何公开文档；C7 当初「无法复现」的疑问至此解释完毕 —— 它不是错数，是**口径写错** |

**② 我们那个「密度判别」的说法作废。** 我们曾说「若 reasoning 计费，预测比值 0.697」。这是**量纲串了**：0.697 是两边非 reasoning 密度的比值，不是计费假设下的预测。计费假设下两区计费字符几乎相等（1,815,142 vs 1,812,398，差 0.15%），预测比值应当**≈1.00**，而实测是 **1.4370**（642,800/447,306）—— 计费假设因此**预测失败**，不是「吻合」。

**③ 真正钉住它的是两条互不依赖的算式**（细节见 `docs/audit/ISSUE59-BILLING.md`）：

- **同区同模型增量**（报告者实测，我们只能复核算术）：国际侧 06:06:40 → 06:06:55，`promptTokens` +416，`reasoning` 字符 +1,290，其余块 +892。计费读法 → 416/(892+1290) = **0.1907** tok/char；不计费读法 → 416/892 = **0.4664**。后者与我们实测的 `tool-result` 系数 **455.5 tok/1k（0.4555）** 只差 2.4%，而这一步新增的正是 `assistant(tool-call)` + `tool(result)` 两条消息。
- **国际侧自己的账**（纯本仓库系数）：tool-call 284,466 + tool-result 674,817 = 959,283 字符 × 0.4555 = **436,953 tok**，占它 `promptTokens` 447,306 的 **97.7%**。剩下 10,353 tok 要分给另外 822,343 字符（system + text + reasoning）→ 密度 0.0126，比任何实测类别低一个数量级。**只要 reasoning 也计费，国际侧这笔账在物理上凑不出来**；不计费时剩余字符落在 0.2955（介于 code 0.287 与 tool 0.4555 之间），是合理区间。

**所以写文档时必须带归属**：这是「**报告者在本机实测**（400 系字段齐全的 4.6.6+ 捕获）+ **本仓库系数复算佐证**」，不是「本插件实测」。本机没有 `global.jsonl`、`cn.jsonl` 685 条里 `promptTokens` 命中数为 **0**（4.6.6 之前写的），所以那两条原始记录在这里复现不了。要升级成「本机独立复现」，需要一份独立账号的 `global.jsonl` 式捕获，或一次受控的 reasoning 开关 A/B —— 这两样都还没有。

**④ 由此带来的措辞变化（已改）**：README 已知限制里的「thinking 走的是另一个字段」不再是推测语气；`docs/audit/ISSUE59-OPTIONS.md` 里「计费前提仍未被任何人直接测量」的段落已改写为「前提已可定案，剩下的阻塞是注册语义，不是计费问题」。

**⑤ 仍未定的两条**（别当成已解决）：

- 报告者预测「单区跑完再切区，跳变接近 0」——**本机验不了**（无 `global.jsonl`、无 `promptTokens`），仍只是预测。
- 他的字符总数（1,815,142 / 1,742,872）比我们分块表多出恒定 30,507 / 30,772 —— 差一个我们没采集的桶（大概是 tools 定义本身），不影响比值，但**不要当成本仓库的数引用**。
