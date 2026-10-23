# BUGFIX — 声明档位不含路线默认档 `high` 的模型，无档位请求必死于 UNSUPPORTED_REASONING_EFFORT

- 上游：dingminhua/dsh-connect-workbuddy @ `4cdba8a37b277a465b754328737f580254552d34`（5.6.2，MIT）
- 本版：5.6.3
- 定性：静态实锤缺陷 + 最小复现（前失败后通过）。上游 open issue 中已知的 [Bug] 条目在该 HEAD 上均已修复（#114/#115/#118/#120/#124 逐条核对过修复提交）；issue #123 是同领域的另一诉求（global 区请求被钉 `high` 的推理洪水），**本缺陷不是 #123 的诉求，不冒用其编号**。

## 症状

上游目录给某模型声明了推理档位、但档位表**不含路线默认档 `high`**（例如 `supportedEfforts: ['low', 'max']`）时，所有**不带档位**的请求（典型如宿主的压缩类请求）都会在本地直接失败，请求体根本发不出去：

```
pi-ai provider "workbuddy" model "partial-model" does not support reasoning effort "high"
```

## 证据链

复现 spec 的搭法与上游自带 `tests/issue90-unsupported-reasoning-effort.spec.ts` 相同：挂载真实插件 + 假宿主 settings + fetch 桩，目录中放一个 `supportedEfforts: ['low', 'max']`、`defaultEffort: 'low'` 的模型，发一条不带档位的请求。

- **修复前**（日志 `repro-before.log`，存于修复工作区）：
  `PARTIAL tier-less outcome: {"ok":false,"code":"UNSUPPORTED_REASONING_EFFORT","message":"pi-ai provider \"workbuddy\" model \"partial-model\" does not support reasoning effort \"high\""}`，且抓到的请求体为空——请求没上线。对照组（同模型显式带 `low`、含 `high` 的模型无档位）在修复前即通过，证明缺陷只落在「有元数据但不含 `high` + 无档位」这一格。
- **修复后**（日志 `repro-after.log`）：同一请求成功，且线上请求体实测 `"reasoning_effort":"low"`（模型自声明的默认档生效）。

## 根因（三段叠加）

1. `src/adapter.ts` 的 `profileFor()` 按路线钉死 `reasoning: WORKBUDDY_DEFAULT_EFFORT`（= `high`，这是 issue #83 的修法：无档位请求必须落一个确定档位）。
2. 宿主包 `@deepseek-ai/dsh-llm-pi-ai` 以 `options.reasoningEffort ?? profile.reasoning` 解析档位，`resolveReasoningLevel` 对不在 `getSupportedThinkingLevels(model)` 内的档位直接抛 `UNSUPPORTED_REASONING_EFFORT`（已读其发布产物源码核对：`lib/index.js` 解析与抛错点；pi-ai `getSupportedThinkingLevels` 中 xhigh/max 需映射非 undefined、其余档位映射 `null` 即不支持）。
3. issue #90 的修法 `EffortNormalizingAdapter` 只兜「模型**完全没有** reasoning 元数据」的情形（钉 `off`）。**有元数据但不含 `high` 的模型两头落空**：不触发 #90 的兜底，又被 #83 的路线默认档撞死。`src/upstream.ts` 的 `parseReasoning` 对任意 `supportedEfforts` 列表原样放行，全仓没有任何一处保证档位表含 `high`；上游现有 fixture 的档位表恰好都含 `high`，故未被测出。

## 改动文件（仅 1 个产品文件 + 1 个新增测试）

- `src/adapter.ts`：
  - `EffortNormalizingAdapter` 新增第二个实时回调 `defaultTierFor(model)`，构造点（全仓仅 `createWorkBuddyAdapter` 一处）同步更新。`pinEffort` 改写：无元数据模型维持原逻辑（钉 `off`）；有元数据模型——请求已显式带档位则原样放行（支持的透传、不支持的仍由宿主拒绝，契约不变）；无档位时查 `defaultTierFor`，有值则钉入、无值（路线默认可用）则不动。
  - `defaultTierFor` 实现：每次请求读实时目录 → 由模型的 `workBuddyThinkingLevelMap` 求已声明档位集 → 含 `high` 返回 `undefined`（不钉）；否则优先模型自声明且在集内的 `defaultEffort`；再否则按 pi-ai 的 clamp 顺序（档位梯 `minimal < low < medium < high < xhigh < max`，自 `high` 先向上、后向下）取最近的已声明档。
  - 类文档注释扩展「THE SIBLING CASE」段，记录该同源缺陷与修复口径。
- `tests/adapter-unusable-route-default.spec.ts`（新增，5 条）：①声明 `['low','max']` 的模型无档位请求成功且线上档位为其自声明默认 `low`；②自声明默认不在档位表内时 clamp 到最近档（`['medium','max']`、默认 `low` → `max`）；③显式点名的已支持档位原样透传；④显式点名的未支持档位仍被宿主拒绝且零上线请求体；⑤含 `high` 的模型无档位请求保持路线默认 `high`（#83 对照不回归）。

另按发布契约同步：`package.json` 版本 5.6.2 → 5.6.3、`repository.url` 改指落点仓；`CHANGELOG.md` 增 5.6.3 条目；`README.md` 顶部加 fork 头（上游原文一字未删）；新增 `UPSTREAM.md` 与本文件。

## 复验结果

- `typecheck`：exit 0。`build`：exit 0（Build complete）。
- 新增回归测试：5/5 通过。
- 改动相关既有套件（adapter、adapter-outgoing-body、issue83 两件、issue90、off-thinking 两件、catalog 三件、persisted-model，共 12 文件）：151/151 通过。
- 全量测试（2133 条 = 基线 2128 + 新增 5）：2120 通过、11 失败、2 跳过。失败集合与基线（10 条）逐条比对：基线的 10 条（pool-e2e 9 条 30 秒超时 + settings-integration 1 条 30 秒超时）在修复后原样出现，均为沙箱性能伪影（同一 pool-e2e 文件在基线下单独跑、放宽超时仍有 3 条超时）；多出的 1 条为 pool-e2e 的 `M-5: caches check-in state across polls`（51ms 快速失败，断言两次轮询间 fetch 增量 ≤1、实测 3）——该用例在修复后代码上**单独跑通过（84ms）、整文件单独跑亦通过**，判定为全量并行负载下的计数竞态，与本修复（推理档位分发）无关。

## 验证边界（如实）

- 全部验证为离线进行：假宿主 settings + fetch 桩模拟网关，未连接真实 WorkBuddy 服务、未用真实账号。
- 「目录中途教会模型 `high` 后自动停止回退」一条未写成自动化用例：本仓测试夹具里，设置重读时运行时目录会按 #114/#115 的「已存目录只作名单、实时目录作能力」规则用旧运行时条目覆盖能力字段，夹具内无法经设置通道送达新档位表（已实测确认该覆盖行为）。本修复的回退值与 #90 的能力判定共用同一接缝、每次请求读实时目录计算，该接缝的中途到达属性已由上游 issue90 套件覆盖；真实目录刷新（上游 `/v3/config` 拉取后 `catalog.set`）送达新档位表时，回退即按同一逻辑停止。
- pool-e2e / settings-integration 的超时型失败为修复前既有基线问题（沙箱性能），不在本版处理范围。
