# DSH 0.2.1-rc.1 升级跟进调研

> 调研日期：2026-10-17
> 宿主：DSH Desktop `0.2.1-rc.1`（`desktopVersion` 见 `runtime/primary-runtime/runtime.json`）
> 插件：`dsh-connect-workbuddy` 4.7.0（调研时基线 4.6.7）
> 基线：本机 0.1.7-rc.1 依赖树上 **1346 用例全绿**（`npx vitest run`，80 passed / 1 skipped）。
> 因此下文所有问题都来自**版本漂移**，不是既有缺陷。

---

## 零、结论摘要

| 层 | 结论 | 所需动作 |
|---|---|---|
| **宿主 API**（dsh-llm / dsh-settings / dsh-host-webserver / dsh-llm-pi-ai / cordis / schemastery） | ✅ **无破坏性变更**，插件调用的每个符号签名一致 | 无 |
| **客户端外壳**（slots / configForms / locale / 槽位名 / 主题令牌 / 模块注册表） | ✅ **全部仍在**，`plugins.*`、`conversation.*`、`shell.quota-notice` 均未改名 | 无 |
| **pi-ai 0.85.1 → 1.1.0** | 🔴 **静默故障**：请求体丢失 system prompt 与全部工具声明 | **必须改代码**（P0） |
| **peer 版本范围** | 🔴 `0.2.1-rc.1` 不满足现声明（semver 预发布悬崖）；且守卫测试的比较器是错的，永远发现不了。**注意：没有任何静态范围能覆盖任意 `0.2.x` 预发布**（见 §2.2，我实测否证了多组候选写法） | pi-ai 那一条**改**；`dsh-*` 建议**等 GA**，并把偏差写进测试（P1） |

一句话：**宿主没坏，坏在插件自己身上的两处——一个是 pi-ai 上下文契约，一个是版本声明。**

---

## 一、P0：pi-ai 1.1.0 下请求静默丢失 system prompt 与工具

### 1.1 现象（已实测，非推断）

用真实 `createProvider` + 真实 `openAICompletionsApi()` + 本地 SSE 服务器捕获线上请求体，
喂入 `dsh-llm-pi-ai` 实际产出的**原始**上下文 `{systemPrompt, tools, messages}`：

| pi-ai 版本 | 线上 `messages[].role` | 线上 system 文本 | 线上 `body.tools` |
|---|---|---|---|
| 0.85.1 | `["system","user"]` | `SYS-PROMPT-MARKER` | `1` ✅ |
| **1.1.0（现状）** | **`["user"]`** | **`null`（prompt 丢了）** | **`0`（工具全丢）** |
| 1.1.0（归一化后） | `["system","user"]` | `SYS-PROMPT-MARKER` | `1` ✅ |
| 1.1.0（已归一化再归一化） | `["system","user"]` | `SYS-PROMPT-MARKER` | `1` ✅（幂等） |

复现脚本：`/tmp/dsh021/probe/ctx-shape.mjs`

### 1.2 根因链（三环叠加）

1. **`dsh-llm-pi-ai` 从不归一化上下文**：0.1.7-rc.1 与 0.2.1-rc.1 的 `piContext()`
   都直接返回 `{systemPrompt, messages, tools}`（`lib/index.js:1287-1294`），
   两版里 `normalizeContext` 出现次数均为 **0**。
2. **pi-ai 0.85.1 读顶层字段**：`dist/api/openai-completions.js:909` `if (context.systemPrompt)`。
3. **pi-ai 1.1.0 只读 `messages`**：走 `resolveTranscript(context)` → `collapseSystemMessages`，
   顶层 `systemPrompt` / `tools` **从不读取**。

### 1.3 为什么插件会走错分支

`src/pi-ai-runtime.ts:169-175` 的 `generationOf()` 把主版本 `1` 判为 `modern`（4.4.2 修的，正确），
于是 `src/adapter.ts:346-348` 的 `withLegacyContext()`：

```ts
if (generation === 'modern') return api   // ← 原样透传，什么都不做
```

**门判定是对的，但 modern 分支是空的。** 而 modern 分支的注释假设「由宿主负责归一化」——
宿主从未如此，pi-ai 0.85 时代由 pi-ai 自己兜底，1.1.0 不再兜底。

> ⚠️ 这与 4.4.2 修的是**同一失效模式的反面**：那次是「1.x 被判成 legacy → 折成旧形状 → 工具丢」，
> 这次是「1.x 判成 modern → 不折 → 工具与 prompt 一样丢」。两次症状相同（无工具、无报错）。

### 1.4 修法（**已实施**）

`src/adapter.ts` 的 modern 分支改为**归一化**而非透传，新增 `foldModernContext()`：

```ts
function withLegacyContext(api, generation) {
  if (generation === 'modern') {
    return {
      ...api,
      stream: (model, context, options) => api.stream(model, foldModernContext(context), options),
      streamSimple: (model, context, options) => api.streamSimple(model, foldModernContext(context), options),
    }
  }
  return { /* legacy 折法不变 */ }
}
```

**为什么内联折叠、而不是直接调 `normalizeContext`**：该函数在 0.85.1 里不存在，
静态 import 会在那里变成 `undefined`；而插件教条是「绝不静态 import pi-ai」
（`pi-ai-runtime.ts` 头部，为让 `bin` 在无 pi-ai 的 profile 下可跑）。内联折叠零新依赖。

`foldModernContext` 的行为：
1. 输入若**已归一化**（顶层两字段都不存在）→ 原样返回（幂等，避免前置一条**空的** system 消息）；
2. 否则把 `systemPrompt` 折进首条 system 消息的 `content`、`tools` 折进 `toolsAdded`，`timestamp: 0`；
3. **删掉**顶层两字段 —— 与官方 `normalizeContext` 一致，使两种输入收敛到同一对象。

**实测（构建产物 `lib/index.js` + 真实 pi-ai 1.1.0 + 本地 SSE 服务器抓线上 body）**：

| 对象 | roles | system | tools |
|---|---|---|---|
| 修复后的构建产物 | `system,user` | `SYS-PROMPT-MARKER` | 1 |
| 把该分支改回 `return api` 的同一构建 | `user` | `null` | 0 |

即：**同一份构建产物只差这一个分支，线上请求体就从「有 prompt 有工具」变成「两样全空」**，
且两条路径都**无任何报错**。

### 1.5 为什么现有测试抓不到（**已修复**）

- `tests/adapter-outgoing-body.spec.ts:61` 是唯一断言「线上 body 真有 tools 和 system」的用例，
  却被 `it.skipIf(piAiRuntimeInfo().generation !== 'legacy')` 限死 —— **modern 分支零覆盖**。
- 本机 checkout 解析到 pi-ai **0.85.1**（`legacy`），所以它一直跑着，且一直是绿的。
- `tests/adapter.spec.ts` mock 了 `openAICompletionsApi`，只断言「交给 wrapper 的 context」——
  这个断言恰好会**认证**该缺陷（wrapper 收到原始 context 是对的，错在之后没人归一化）。

**已实施的守卫**：`adapter-outgoing-body.spec.ts` 去掉 `skipIf`，改为 2×2 矩阵
（{legacy, modern} × {原始信封, 已归一化}），每格都断言 `body.tools` 与首条 system 文本；
新增幂等用例与「只有 tools、没有 systemPrompt」用例。

**代际的硬约束**（写在用例注释里，按已安装版本选格，不会让哪一代完全无人看管）：
legacy 两格只能在 0.85 checkout 跑（1.x 的 api 读不了扁平形状）；
modern 两格只能在 0.87+/1.x 跑（0.85 的 `estimateMessageTokens` 会对 system 消息的**字符串**
逐字符迭代并读 `block.name.length` 而崩溃，即 #24）。

**变异验证**：把 modern 分支改回 `return api` → 新增的「FOLDS a raw seam envelope」用例变红。

---

## 二、P0/P1：peer 范围不满足新宿主，且守卫测试的比较器是错的

### 2.1 semver 事实（用 npm 自家 semver 7.8.5 实算）

```
satisfies('0.2.1-rc.1', '>=0.1.7-rc.1 <0.3.0-0')  →  false
satisfies('0.2.0-rc.1', '>=0.1.7-rc.1 <0.3.0-0')  →  false
satisfies('0.1.7-rc.1', '>=0.1.7-rc.1 <0.3.0-0')  →  true
```

原因：semver 的「预发布悬崖」——预发布版本**只有**当同一比较器集合里存在
**同一 `major.minor.patch` 元组**上的预发布比较符时才被放行。
`>=0.1.7-rc.1` 只对 `0.1.7-x` 开口；`<0.3.0-0` 排除整个 `0.3.0` 预发布元组。
`0.2.1-rc.1` 的元组 `0.2.1` 两边都不匹配 → 两条比较符都判 false。

**不满足的 10 条 peer**：9 个 `@deepseek-ai/dsh-*`（均 0.2.1-rc.1）+ `@earendil-works/pi-ai`（1.1.0）。
**满足的**：cordis 4.0.5 ✓、schemastery 3.18.5 ✓、react ✓。

> 这是**既有缺陷**在 0.2.1 上继续暴露（0.2.0-rc.1 时已经如此），不是本次升级引入。

### 2.2 ⚠️ 一个重要结论：**没有任何静态范围能覆盖「任意 0.2.x 预发布」**

我把候选写法逐个用 npm `semver@7.8.5` 实算过，**全部失败**，记录在此以免后人重走：

| 候选写法 | 结果 |
|---|---|
| `>=0.1.7-rc.1 <0.3.0-0 \|\| >=0.2.0-rc.1 <0.2.99` | ❌ MISS `0.2.1-rc.1`（我最初凭直觉写的，是错的） |
| `>=0.1.7-rc.1 <0.3.0-0 \|\| >=0.3.0-0 <0.3.0` | ❌ LEAK `0.3.0-0` 且 MISS `0.2.x` 预发布 |
| `>=0.1.7-rc.1-0 <0.3.0-0` | ❌ 连 `0.1.7-rc.1` 都 MISS |
| `>=0.1.7-rc.1 <0.3.0`（去掉预发布上界） | ❌ MISS 所有 `0.2.x` 预发布 |
| `0.2.x` / `0.2.0-0.x` / `>0.2.0-alpha <0.3.0-0` | ❌ 通配符不继承预发布比较符 |
| 逐补丁号枚举 `\|\| >=0.2.0-rc.1 \|\| >=0.2.1-rc.1 …` | ✅ 能过，但**新补丁号的 rc 需手工追加**，等于埋同样的坑 |

**根因**：semver 只对**出现预发布比较符的那个 `major.minor.patch` 元组**放行预发布版本。
`0.2.1-rc.1`、`0.2.5-alpha.3` 这些元组不在任何比较符里，就永远进不来。
这是规范行为，不是 bug。

**因此正确的做法不是硬凑范围，而是选一种「不依赖范围」的路**。按推荐度：

1. **跟进到 GA 再放行（最省事）**：若宿主不久出 `0.2.1`（GA），`>=0.1.7-rc.1 <0.3.0-0` 对 GA **是判 true 的**
   （已实测 `satisfies('0.2.1','>=0.1.7-rc.1 <0.3.0-0') === true`）。即 rc 阶段用 `link:` 本地开发不受影响，
   不必为一个 rc 版本扭曲声明。
2. **接受「rc 不在声明内」的现实，但让它在测试里可见**：保留现范围，把 §2.3 的测试修对，
   并新增一条**已知-偏差**断言 —— 「`0.2.1-rc.1` 在当前声明下被判 false」，附注释说明为何可接受
   （宿主只校验 `@deepseek-ai/dsh*`，且 profile 用 `link:` + `autoInstallPeers:false`）。
   这样偏差是**被记录、被解释**的，而不是被一个错比较器掩盖。
3. **若要严格声明 rc**：只能逐补丁枚举 `|| >=0.2.N-rc.1 <0.3.0-0`，并**在 RELEASING.md 写入「每遇新 rc 需追加一条」**的
   维护动作。不推荐，但它是唯一既能进 rc 又挡住 `0.3.0-0` 的写法。

**我的建议：走 1 + 2。** 即名单暂不改（或等 GA），但把测试修对并显式记录这个已知偏差。

pi-ai 是**唯一例外**，因为它换了主版本、且范围里没有预发布元组问题：

```jsonc
// 实测通过：0.85.0/0.85.1/0.87.1/1.0.0/1.0.2/1.1.0 → true；2.0.0、1.1.0-beta.1 → false
"@earendil-works/pi-ai": ">=0.85.0 <0.88.0 || >=1.0.0-0 <2.0.0"
```

> 保留 `1.1.0-beta.1 → false` 是**有意**的：`generationOf()` 对预发布串的解析未经验证，
> 不如只承诺已实测的 GA 版本。

> 注：`dsh-app-boot` 的 `evaluatePluginCompatibility()` **只校验 `@deepseek-ai/dsh*` 命名空间**，
> 所以 pi-ai 那条 peer 从不参与宿主校验（4.4.2 已记录）。改它主要是**文档与 npm 安装行为的正确性**，
> 真正保护用户的是 §1 的代码修复。

### 2.3 守卫测试为何全绿：比较器写错了

`tests/dsh-line.spec.ts:137-145` 自行实现了 `satisfiesRange()`，用朴素 `>=` / `<` 比较：

```
该比较器判 '0.2.1-rc.1' 落在 '>=0.1.7-rc.1 <0.3.0-0' → true
npm semver 判同一问题                          → false
```

**而且它的夹具是 `['0.1.7-rc.1','0.1.7-rc.2','0.2.0-rc.1','0.2.0-rc.9','0.2.0','0.2.1','0.2.99']`——
恰好跳过了 0.2.1-rc.1 与 0.2.0-rc.2…这些真实存在的版本。** 测试名还写着「pre­releases included」，
但它从未对任何 `0.2.x` 预发布求值。

修法：改用 npm `semver` 包（或完整实现悬崖规则），夹具加入 `0.2.1-rc.1`、`0.2.1-rc.2`、`0.2.2-rc.1`，
并断言它们是 **admitted** —— 这条断言在**当前清单上会红**，正是它该红的时刻。

---

## 三、P2：类型层面的隐性断裂

`src/adapter.ts:241` `adaptLegacyPiAiContext(context: Context): Context` 返回 0.85 形状，
`src/adapter.ts:351-352` 又把它喂给 pi-ai 1.1.0 的 `stream()`，后者第二参已改为 **`TranscriptContext`**。
用真实 `tsc 5.9.3` 对 1.1.0 的 `.d.ts` 求值会得到：

```
TS2353: Object literal may only specify known properties, and 'systemPrompt'
        does not exist in type 'TranscriptContext'.
```

运行时不可达（`generation === 'modern'` 时提前返回），所以**不会崩**。
但若按 §1 改成在 modern 分支归一化，这个类型冲突会**恰好在正确的位置被消解**——
建议与 §1 一起改，顺带在 `adaptLegacyPiAiContext` 上注明「仅供 legacy(0.85) 分支，不可对 1.x 求值」。

---

## 四、已核对确认「无需改动」的项（留档，避免重复排查）

### 4.1 宿主侧

| 包 | 0.1.7 → 0.2.1 | 插件使用点 | 结论 |
|---|---|---|---|
| `dsh-llm` | `AdapterRegistrationHandle` / `DirectoryRegistrationHandle` / `registerAdapter` / `registerConfigurableProviders` / `registerModelDiscovery` 签名全同 | `src/index.ts:30, 2033-2035, 2079` | 无需改 |
| `dsh-settings` | 全部 `.d.ts` 逐字节相同（md5 一致）；`configure({auto}, owner)` 仍在 | `src/index.ts:29, 287-289, 1958-1960` | 无需改 |
| `dsh-host-webserver` | `register(WebRoute)` / `WebRouteKind` / `registerUpgrade` / `registerFallback` 全同 | `src/web-status.ts` 10 处 `kind:'exact'` | 无需改（`port` getter 变 `number \| undefined`，插件不读） |
| `dsh-llm-pi-ai` | `PiAiAdapter` 构造、`ResolvedPiAiProviderProfile` **逐字节相同** | `src/adapter.ts:401-425` | 无需改 |
| `dsh-atomic-write` / `dsh-home-paths` | 仅新增可选能力 | `src/host-peers.ts:84, 288-322` | 无需改（可选用 `signal`） |
| `cordis` 4.0.2→4.0.5 | 仅 `Fiber.update()` 返回值收窄 | 插件未调用 | 无需改 |
| `schemastery` 3.18.4→3.18.5 | `.d.ts` 逐字节相同 | `src/index.ts:28` | 无需改 |

### 4.2 客户端侧

- **模块注册表（`staticModules`）**：新外壳为
  `react, react/jsx-runtime, react-dom, react-dom/client, @deepseek-ai/cordis, zod, @tanstack/react-virtual, @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-primitives, @deepseek-ai/dsh-client-ui-dockkit`。
  插件产物 `lib/client.js` 实际只 `require` **react / react/jsx-runtime / react-dom**，全部在册 ✅
- **槽位名全部存活**（在新外壳 bundle 内逐个确认）：
  `conversation.input.left`（`dsh-client-ui-conversation`）、`conversation.composer.dock`（conversation + chat）、
  `shell.quota-notice`（`dsh-client-ui-chat`）、`plugins.item` / `plugins.bundle.config` / `plugins.row.config`
  （`dsh-client-ui-plugin-manager`，仍是 `renderSlot('plugins.item', {view:'page', form})` + `{entryKey}` 分发）
- **`{view, form}` 契约不变**：`WorkBuddyCard` 的 `view === 'page'` 分支仍匹配。
- **`configForms` 服务**仍在（`ConfigForms extends Service`，`super(ctx,'configForms')`）；
  `whileServed(ns, register)` 与 `describe().getSnapshot().view.namespaces` 语义未变。
- **`settingsScope` 服务**自 2.1.0 起就无回退，插件本就走 `configForms` 优雅降级路径 ✅
- **locale**：`register` / `bind` / `getSnapshot` 三者均在 ✅
- **slots 类型面**：`index.d.ts` / `renderer.d.ts` 仅**新增** `inline?: true` 与 `KeyedStandardSource` 的第 2 参，均向后兼容。
- **主题令牌**：插件用的 22 个 `--dsw-*` 中 20 个仍在新外壳 CSS 中；
  `--dsw-alias-bg-secondary`、`--dsw-state-success` 在外壳与插件里**都不存在**，
  但插件两处都写了回退值（`styles.ts:347` `,transparent`；`styles.ts:537` `,#22a06b`），属既有瑕疵，非本次回归。

---

## 五、建议执行顺序

1. **P0-a 代码**：`src/adapter.ts` modern 分支改为折叠（§1.4 方案 A）。
2. **P0-b 测试**：去掉 `adapter-outgoing-body.spec.ts` 的 `skipIf`，新增 4 格矩阵（§1.5）；
   在 pi-ai **1.1.0** 下跑通整套。
3. **P1 测试**：`tests/dsh-line.spec.ts` 换用真 semver，夹具补 `0.2.1-rc.1`，并**显式记录**该 rc 不在声明内（§2.2 路 2 / §2.3）。
4. **P1 清单**：pi-ai 按 §2.2 改；9 条 `dsh-*` **建议等宿主出 GA `0.2.1` 再评估**，理由见 §2.2 —— 任何为 rc 硬凑的范围都会有漏。
5. **P2**：`adaptLegacyPiAiContext` 加 legacy-only 注记，随 §1 一并消除 `TS2353`。
6. **文档**：`src/pi-ai-runtime.ts` 头部仍写「npm currently publishes 1.1.0」并称 1.x 未发布，
   与 `package.json` 的 `>=0.85.0 <0.88.0` 自相矛盾，需一并更正。
7. **发布**：本次属**行为修复**，建议 **minor**（4.7.0）而非 patch —— 它改变了发往上游的请求体。

---

## 六、附：一处顺带发现的既有缺陷（与本次升级无关）

`src/adapter.ts:160`：

```ts
if (info.reasoning?.canDisableThinking !== true) map.off = null
```

配合 `src/off-thinking.ts` 的语义（`withEffectiveOff` 会把 `canDisableThinking` **覆写**成
「用户是否勾选 off」，且**声明为 `true` 的模型默认勾上**、`REFUSES_OFF_MODEL_IDS` 里的除外），
实际效果为：

- 上游声明 `canDisableThinking: true`、用户**未**取消勾选 → `map.off = null` → pi-ai 认为 **off 不受支持**。
- 上游声明 `false` / 未声明 → 不置 null → `map.off` 落成字符串 `'off'` → **off 反而可用**。

即与 `tests/adapter.spec.ts:74-80` 的名称和意图相反（该测试只探了 `false` 那半边，所以是绿的）。
1.x 的 `getSupportedThinkingLevels`（`models.js:679-690`）确认 `mapped === null → 不支持`，
`openai-completions.js:672` 亦以 `thinkingLevelMap?.off !== null` 作为「能否关思考」的判据。
**修法**：`if (info.reasoning?.canDisableThinking === true) { /* 保留 off */ } else map.off = null`
—— 即把条件反过来，并同时补一条 `canDisableThinking: true` 的用例。

> **2026-10-20 补记（issue #83）**：上面这条已修，但只修了一半。条件反过来了，
> 而 `withEffectiveOff` 仍会把「用户勾选」写进 `canDisableThinking`，于是
> `REFUSES_OFF_MODEL_IDS` 里那 9 个**实测拒绝 `off`** 的模型只要被勾上，
> `map.off` 就落成 `'off'`。更关键的是 pi-ai 在**调用方没传 `reasoningEffort`** 时会用
> 这个值兜底（`openai-completions.js` 的 `!options?.reasoningEffort && model.reasoning`
> 分支），而压缩摘要请求恰好不传档位——结果是勾一次就等于让该模型每一次 `/compact`
> 都 400 / 11133。现在名单是**硬墙**，另加请求体兜底与 profile 显式默认档位两道防线，
> 详见 CHANGELOG 4.11.0 与 `tests/issue83-off-refusal.spec.ts`。

---

## 六之二、2026-10-20 补记（issue #84）：宿主「按文本正则分类」还有第三个后果

§1 与本文其他地方都只把宿主的 `classifyPiAiError()` 当作「决定要不要原地重试」的判据。**它还会决定用户看到哪句话**，这一点是 issue #84 才查清的：

- 分类器读的是 `type + " " + code + " " + message` 这段**文本**（`@deepseek-ai/dsh-llm-pi-ai` 的 `classifyPiAiError`），宿主的 pi-ai 客户端在失败时把 HTTP 状态与响应体拼成 `"<status>: <body>"` 挂到 `errorMessage` 上，所以文本里**总有**状态码。
- 判定顺序：`401`/`403` → `AUTH`；**quota 措辞 → `QUOTA`**；`429`/rate-limit → `RATE_LIMIT`；`400` → `INVALID_REQUEST`；`5xx` → `SERVER`；……
- `@deepseek-ai/dsh-client-ui-chat` 的 `failureMessage(message, code, t)` **对 `QUOTA`/`ACCOUNT_QUOTA` 直接返回写死的 `message.failure.quota`（「当前请求的额度已用尽」/「Request quota exhausted.」）并丢弃传入的 message**；其他类别才把 message 原样显示。

因此插件写回宿主的 `error.code` 不是日志字段，而是**用户可见文案的开关**。本插件原来的 `KIND_HOST_CODE` 把 `model_busy` 也译成 `quota_exceeded`（issue #56/#63 为「挡在重试集合外」而做），恰好被那条 quota 正则命中——于是模型繁忙被显示成额度耗尽，并且因为 `QUOTA` 不在重试集合里一次就失败。4.12.0 起 `model_busy` 不再翻译；`soft_rate` 保留翻译（6004 的重置在几小时后，重试无意义）。详见 CHANGELOG 4.12.0 与 `tests/issue84-model-busy-not-quota.spec.ts`。

> 写这段是为了让下一个读 §1 的人不要只记住「影响重试」——**这条文本还影响措辞**，而且措辞那一层连 `error.code` 都没机会参与：分类器只看文本，不看 code 字段。

---

## 七、证据来源

- 宿主版本：`runtime/primary-runtime/runtime.json` → `desktopVersion: 0.2.1-rc.1`
- 随包版本：app.asar 内 `@deepseek-ai/dsh-*@0.2.1-rc.1`、`cordis@4.0.5`、`schemastery@3.18.5`、
  `@earendil-works/pi-ai@1.1.0`
- pi-ai 上下文契约：`probe/ctx-shape.mjs`（真实 SSE 服务器捕获线上 body），见 §1.1 表
- semver 悬崖：npm `semver@7.8.5` 实算，见 §2.1
- 客户端外壳：`dsh-web-frontend/dist/assets/index-*.js` 的 `staticModules`，
  `dsh-client-ui-{conversation,chat,settings,settings-plugins,plugin-manager,locale}` 的 `lib/client.js`
