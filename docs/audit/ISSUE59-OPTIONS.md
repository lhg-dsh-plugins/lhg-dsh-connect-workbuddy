# Issue #59 — Options for the region-switch counting jump

**Author:** options (decision analyst) · **Task:** task-2 · **Date:** 2026-10-18
**Scope rule:** analysis only. No `src/` edits — this file is advice for the maintainer (lead owns code changes).

---

## 1. Recommendation (read this first)

**Primary: O1 — make pi-ai see one model identity across both regions by stamping `model.provider` with a shared value, while the two DSH routes/profiles stay per-region.** This is the only plugin-side option that *removes* the counting jump rather than papering over it, and the evidence shows it is safe with one narrow, testable caveat.

**Fallbacks, in order of preference:**
1. **O4** — keep 4.8.0 `context-rescue` as the liveness mitigation **and** document the mechanism now. Ship this in parallel with any bigger change; it is the zero-risk floor.
2. **O5** — take the fix upstream: pi-ai's issue tracker is real (`github.com/earendil-works/pi/issues`). File a provider-equivalence request. Long cycle, outside the plugin's release cadence, so it is a soapbox, not a ship.
3. **O3** — *not feasible* (provenance is destroyed before the shim sees the body). Do not invest here.
4. **O2** — *wrong direction*: forcing thinking to text makes OWN-region thinking billed too. This is a regression, not a fix. Do not ship.

---

## 2. The mechanism, verified against code

The chain that produces the jump (each link confirmed):

1. **Produce:** `@earendil-works/pi-ai@1.1.0` `dist/api/openai-completions.js:159` stamps `output.provider = model.provider` on every assistant message it streams.
2. **Persist:** the DSH host stores that provider into each assistant message's replay state — `@deepseek-ai/dsh-llm-pi-ai/lib/index.js:60-64` `toPiReplayState` copies `provider: message.provider` (`:63`).
3. **Replay:** on a later request, `pi-ai/dist/api/transform-messages.js:68` computes
   `isSameModel = assistantMsg.provider === model.provider && assistantMsg.api === model.api && assistantMsg.model === model.id`,
   and at `:88-96` a replayed non-empty thinking block is returned **as-is when `isSameModel`** and otherwise **flattened to `{type:"text", text: block.thinking}`** (billed text).
4. **Disparity:** the plugin registers **two** provider ids (`workbuddy` CN, `workbuddy-global` intl — `src/adapter.ts:36,39`, registered as two adapters at `src/index.ts:2049-2050`) that serve the **same** model id `deepseek-v4.1-flash`. So for that model the **only differing leg** of `isSameModel` is `assistantMsg.provider !== model.provider` when the history was produced on the other region.

Result: thinking produced on the other region is replayed as **plain text**, landing in the billed `text` bucket. Body-composition evidence (`docs` + `src/body-report.ts:7-15`, paired same-session capture) shows the same history being counted `CN reasoning 72,270 / text 741,687` vs `GL reasoning 627,994 / text 184,821` — a ~0.9995 body-byte ratio but a large bucket drift. The 4.8.0 `context-rescue` only prevents the *overflow/deadlock* symptom; it does not touch the counting jump.

---

## 3. Option-by-option assessment

### O1 — Shared `model.provider`, per-region routes  ✅ PRIMARY

**What it is:** make both regions' model descriptors report the same `model.provider`, while the DSH route/provider-profile id and the model picker stay per-region.

**Candidate edit (lead's; noted, not applied):** `src/adapter.ts:193-199` `toPiModel(info, baseUrl, providerId)` currently sets `provider: providerId`. Change that one line to a shared constant (e.g. `'workbuddy'`) for both regions. `providerId` is still passed in and drives the route id — `src/adapter.ts:568` `const providerId = options.provider ?? WORKBUDDY_PROVIDER`, profiled at `:584,607`, adapter registration at `src/index.ts:2049-2050`.

**Verification that it is safe — flat-out clear:**

- **The DSH container keys on the *argument* provider, not on `model.provider`.** `@deepseek-ai/dsh-llm-pi-ai/lib/index.js: 1856` `models.setProvider(profile.piProvider)` keys on `provider.id` (the route id from `createProvider` `src/adapter.ts:606`). `modelOf(snapshot, provider, model)` `:1870-1877` → `snapshot.models.getModel(provider, model)` → `pi-ai/dist/models.js:116-118`
  `getModel(provider, id) = this.getModels(provider).find(m => m.id === id)`,
  and `getModels(provider)` `:67-91` filters by **`this.providers.get(provider)`** — the map key = the route provider id, not the model's `.provider` field. Routing is intact.
- **The model picker/logic never exposes `model.provider`.** `listModels` `:1893-1904` and `modelInfo` `:1908-1920` report `provider` = the *argument* (route id); neither reads the model's `.provider`. The UI keeps showing `WorkBuddy` / `WorkBuddy Global` (`src/adapter.ts:56-59`).
- **pi-ai auth never keys on `model.provider`.** `getClientApiKey(model.provider, …)` (`openai-completions.js:34-39, 181, 518`) returns `apiKey` when present and only uses `model.provider` in the *error string* if no key. The plugin resolves the shim token via `resolveApiKey: () => shim.token()` (`src/adapter.ts:618`), so `apiKey` is always present; the value is inert.
- **`detectCompat` treats a shared custom name as a *known-unknown*.** `openai-completions.js:1215-1307` matches explicit provider/baseUrl names (`deepseek`, `zai`, `together`, `moonshotai`, `openrouter`, `opencode-go`, `github-copilot`, …). `'workbuddy'` matches none, and `baseUrl` is the loopback shim, so the **same default compat set is returned for both regions** as today. Use the existing `'workbuddy'` value or a new `'workbuddy-common'` — either is inert.
- **Producer side self-consistent.** A CN-produced message gets `provider = shared`; a GL-produced one also `provider = shared`. On replay in *either* region, `assistantMsg.provider === model.provider → isSameModel = true`, so thinking stays in the reasoning bucket (not billed) regardless of region. **This is exactly what removes the ±30–94% jump.**

**What it fixes:** the counting jump at its root — cross-region thinking is no longer downgraded to billed text.

**Risk / caveats (must be tested, not assumed):**
- **Cross-region field spelling.** The body-report confirms both spellings occur (`reasoning` and `reasoning_content`, /tmp/issue59/big.jsonl: 2820 `reasoning`, 790 `reasoning_content`). `openai-completions.js:1003-1010` writes thinking back under the *original* field name (`thinkingSignature`) — so a CN-shaped history replayed through GL would send `reasoning` where GL may expect `reasoning_content`. **Needs one cross-region wire test** to confirm both gateways accept the foreign spelling. The plugin's body-report + `probe` infrastructure can observe this directly.
- **DSH replay validation stays green.** `dsh-llm-pi-ai` `:186` `replayedAssistant` rejects `state.response.provider !== source.provider`. Both values are the *persisted shared* value, so it passes — but **only for history produced after the change ships.** Old history stamped `workbuddy-global`/`workbuddy` before the change will still carry the old, differing provider and will briefly continue to downgrade until that history is consumed/rewritten. Net: the fix is not retroactive for already-persisted sessions; test on a fresh session.
- **Effort: small.** One constant + one line in `toPiModel`, plus the `model.provider` field. Add a cross-region replay unit test.
- **What would falsify it:** a cross-region wire capture showing the foreign gateway rejects or re-bills a replayed `reasoning`/`reasoning_content` field; or DSH `profileOf`/`modelOf` failing to resolve after the stamp. Neither is suggested by the code, but both are cheap to test.

**Verdict:** **doable safely**, with the field-spelling caveat as the only gate before release.

### O2 — Compat flags  ❌ NOT A FIX

Pi-ai's openai-completions `compat` set (all honored via `getCompat`, `openai-completions.js:1309-1352`, detected defaults `:1245-1307`): `supportsStore`, `supportsDeveloperRole`, `supportsReasoningEffort`, `supportsUsageInStreaming`, `supportsFinishReason`, `maxTokensField`, `requiresToolResultName`, `requiresAssistantAfterToolResult`, **`requiresThinkingAsText`**, **`requiresReasoningContentOnAssistantMessages`**, `thinkingFormat`, `openRouterRouting`, `vercelGatewayRouting`, `chatTemplateKwargs`, `chatTemplateArgs`, `zaiToolStream`, `supportsThinkingTokenBudget`, `thinkingTokenBudgetField`, `supportsStrictMode`, `supportsOpenAIGrammarTools`, `supportsMidConvoSystemMessages`, `supportsMidConvoToolAdditions`, `cacheControlFormat`, `sendSessionAffinityHeaders`, `sessionAffinityFormat`, `supportsLongCacheRetention`, `vllmPriority`.

- **`requiresThinkingAsText`** (`:983`): converts *every* non-empty thinking block to plain `content` text on the **request-serialization** side. **This makes OWN-region thinking billed too** — a straight regression. Do not set.
- **`requiresReasoningContentOnAssistantMessages`** (`:1046`): forces an empty `reasoning_content` field on assistant messages. Only meaningful once `model.provider === "deepseek"` (isDeepSeek) is true; setting it on a `workbuddy` provider has no effect on the downgrade path, because the flatten already happened inside `transform-messages` before this serialization branch runs.
- **`thinkingFormat`, `requiresAssistantAfterToolResult`, `supportsMidConvo*`** etc.: wire-shape knobs with no bearing on whether a *replayed foreign* thinking block is flattened. Inert for this bug.

**Verdict:** none of the flags can move the `transform-messages.js:88-96` isSameModel flatten (that runs before the send layer). O2 cannot fix the jump and the one flag that touches thinking goes the wrong way.

### O3 — Plugin-side re-tagging of foreign thinking  ❌ NOT FEASIBLE

**The hope:** at the point the body is serialized/sent (the loopback shim `src/shim.ts` → `src/upstream.ts prepareChatBody`), move foreign-region text blocks that were originally thinking back into `reasoning_content`. The shim already rewrites request bodies (`prepareChatBody` `:756-775` rewrites `stream`, `developer→system`, system head, `tool_choice`).

**Why it does not work — decisive, evidence-based:**
1. **The thinking was already flattened before the shim sees it.** `transformMessages(context.messages, model, …)` runs inside `openai-completions.js:896` (send/serialize layer), *before* the body is handed to the shim. At `:88-96` a cross-region thinking block is converted to `{type:"text", text}` and then merged into a plain assistant content string (`:997`, `:1012-1019`). By the time `prepareChatBody` parses `messages`, **flattened thinking is byte-indistinguishable from genuine text** — there is no marker left to move.
2. **Per-message region provenance is stripped in serialization.** The OpenAI body carries only `role`/`content`/`tool_calls`; the `provider` field (which pi-ai used for `isSameModel`) is not serialized onto messages. The shim has no way to know which region produced which assistant message.
3. **The replay assembly is host-internal.** The context/message replay is assembled by pi-ai inside the DSH host, not by the plugin. The plugin only owns the loopback endpoint and the upstream client; it cannot reach into pi-ai's `transform-messages` before it runs.

The only way to intervene before flattening would be to **wrap/replace `openAICompletionsApi().stream`** with a fork that re-implements pi-ai's transform — but that de-syncs the plugin from pi-ai's internal behavior and is exactly the fragility the generation gate (`src/pi-ai-runtime.ts`) exists to avoid. High effort, high maintenance load, and still untestable against the foreign gateway's acceptance rules.

**What would falsify it:** evidence of a serialized body that ever carries a thinking-origin marker or per-message provider — neither exists in the code. (Checked the send path end-to-end.)

**Verdict:** not doable at the wire layer because provenance is destroyed before the plugin can see it. This option is closed.

### O4 — Do nothing in code; document + keep 4.8.0 rescue  ✅ FALLBACK (zero-risk floor)

Keep `src/context-rescue.ts` (4.8.0 chunked fold on confirmed overflow) as the liveness fix. Nothing else changes.

**What the documentation must say (for DSH-0.2.x RELEASE notes / README troubleshooting):**
- The user-visible symptom verbatim: **「切个区，余额掉一半」** — switching WorkBuddy region re-bills prior thinking as plain text because pi-ai treats the two workbuddy provider ids as different models, so cross-region history thinking leaves the (unbilled) reasoning bucket and enters the billed text bucket.
- It is a **counting/display behavior change, not a leak or a lost-credit bug**: the same bytes are re-labelled, not double-spent. Bridge it to the body-report numbers (CN text 741,687 vs GL 184,821; reasoning 72,270 vs 627,994).
- The 30–94% is **direction-dependent**: whichever region produced the bulk of the history, switching to the other region down-replays its thinking to text.
- Guidance: avoid toggling region on history-heavy sessions; if you must, expect a one-off number jump and that `/compact` may need a fresh pass; 4.8.0's rescue keeps the session alive through the overflow so a deadlock is no longer expected.
- Clearly flag it as a pi-ai-level behavioral artifact, with the O1 proposal as the intended fix.

**What would falsify it:** a counter-capture showing the gateways bill `reasoning`/`reasoning_content` identically (which would remove the premise entirely — but body-report already refutes that).

**Verdict:** safe to ship today; the correct thing to do **while** O1 is validated.

### O5 — Upstream  ✅ REAL, WORTH FILING (soapbox, not a ship)

- `@earendil-works/pi-ai` is **publicly available** with a real tracker. npm metadata: `homepage = https://github.com/earendil-works/pi#readme`, `bugs = https://github.com/earendil-works/pi/issues`, `repository = git+https://github.com/earendil-works/pi.git` (`directory: packages/ai`). `dist-tags`: `latest = 1.3.0`, `legacy-node20 = 0.74.2`. The host currently bundles **1.1.0**, and the plugin runtime detections pin the peer range `>=0.85.0 <2.0.0` (`src/pi-ai-runtime.ts:151-167`).
- Newer versions exist (1.0.0, 1.0.1, up to 1.3.0), but **there is no evidence any of them changes `isSameModel` into a provider-equivalence check** — the `transform-messages.js:68` three-way equality (provider AND api AND model) is the same in the code we ship against; the npm record gives no changelog on this. Do not assume an upgrade fixes it; the plugin cannot choose the host-bundled version anyway.
- **Suggested issue text** (would file at `https://github.com/earendil-works/pi/issues`):

  > **Subject:** `transformMessages` treats two provider ids of the same upstream model as "different model", downgrading cross-provider thinking to billed text.
  > In `dist/api/transform-messages.js:68`, `isSameModel` requires `assistantMsg.provider === model.provider` alongside api/model equality. When two DSH provider routes (`workbuddy` CN, `workbuddy-global` intl) map the same vendor model id `deepseek-v4.1-flash`, thinking produced on the other route is flattened at `:88-96` to `{type:"text", text: block.thinking}` and re-billed as ordinary text. IsSameModel is a strict provider-string equality, with no notion of provider equivalence/a group, and `assistantApi msg` carries no alias. Symptom: switching region re-bills prior reasoning (±30-94% jump), overflowing context budgets. Request: a provider-equivalence group (or `model.provider` normalization to a canonical vendor) so the same vendor/model is treated as same-model across route aliases, while preserving per-route auth/catalog.

- **If no fix will be shipped upstream in any relevant window:** the alternative is the **vendor patch via O1** (plugin-side normalization) rather than a DSH change — DSH's provider model (dsh-llm-pi-ai) is already provider-correct and only honors what pi-ai gives it; there is no DSH-side knob that decouples `model.provider` from the isSameModel branch without a pi-ai or plugin change.

**Verdict:** tracker is real; file it for the record; do not block the plugin release on it.

---

## 4. What we should tell the issue reporter

> The "切个区，余额掉一半" symptom is now fully explained and it is **not** double-billing or a leak — the same body bytes are simply **re-bucketed**. WorkBuddy registers two region routes (`workbuddy` CN, `workbuddy-global` intl) for the **same** model `deepseek-v4.1-flash`. pi-ai decides whether prior thinking stays in the (unbilled) `reasoning/*reasoning_content*` bucket by strict provider-id equality; switch regions and the history's thinking is re-labelled from "reasoning" to "plain text", which the gateway counts. That is your ±30–94% jump, and it is direction-dependent on which region dominates the history. 4.8.0's context-rescue already prevents the consequent overflow deadlock. The proper fix is to make pi-ai see one model identity across both routes (O1) — in the plugin's queue — and we've also filed it upstream. If you cannot wait, keep region switches off history-heavy sessions and expect a one-off number jump when you do.

---

## 5. Effort and falsification summary

| Option | Fixes the jump? | Plugin-side feasible? | Effort | Primary risk | What would falsify it |
|--------|----------------|----------------------|--------|--------------|------------------------|
| **O1** | Yes (root) | Yes | Small (1 line + constant + cross-region test) | Cross-region reasoning field-spelling acceptance | Foreign gateway rejects/re-bills replayed `reasoning`/`reasoning_content` |
| **O2** | No | N/A | — | RequiresThinkingAsText is a regression (bills own thinking) | — |
| **O3** | No | **No** (provenance destroyed pre-shim) | Large (fork of pi-ai transform) | Sync/regression vs host pi-ai | Any serialized body carrying a thinking-origin marker (none exists) |
| **O4** | No | Yes (docs + existing rescue) | Tiny | None | Gateways shown billing reasoning == text (refuted by body-report) |
| **O5** | Yes (upstream) | No | Small (file issue) | Long cycle, plugin cannot pick host version | A published 1.x that ships provider-equivalence (not observed) |

**Bottom line for the maintainer:** primary = **O1** (ship as the real fix, gate on a cross-region wire test); ship **O4** documentation immediately as the zero-risk floor and the reporter-facing answer; file **O5** upstream; skip **O2** and **O3**.

---

## 6. Lead review: O1 as specified does NOT ship (blocker found after this report)

**Verdict on §3 O1: the safety argument is incomplete. Do not implement the one-line version.**

O1 proposed changing `src/adapter.ts:193–199 toPiModel` so both regions stamp the same `model.provider`. The report verified that *lookup by argument* is intact — `getModel(provider, id)` / `getModels(provider)` / `listModels` / `modelInfo` all key on the route id passed in. That part is correct and was re-checked.

It misses the one path that resolves **by `model.provider`**, and that path is the live chat path:

- `/private/tmp/asar-full/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1983` streams through `snapshot.models.streamSimple(model, context, …)` — not through the api directly.
- `@earendil-works/pi-ai/dist/models.js:454–458` `streamSimple` first calls `requireChatProvider(model)`.
- `models.js:411–416` `requireProvider(model)` does `this.providers.get(model.provider)` and throws `ModelsError("provider", \`Unknown provider: ${model.provider}\`)` when absent. `models.js:429` similarly: `Provider is not configured: ${model.provider}`.
- Each region has its **own** registry: `src/index.ts:2049–2050` registers two separate adapters (`createWorkBuddyAdapter` at `:2026`, once per region), and each `PiAiAdapter.current()` builds a fresh `Models` (`dsh-llm-pi-ai lib/index.js:1855`) that contains **only its own** `piProvider` (`:1856`).

Consequence: stamping a GL model with `provider: "workbuddy"` makes the GL adapter look up `providers.get("workbuddy")` in a registry that only ever registered `workbuddy-global` → `undefined` → **every GL request throws `Unknown provider: workbuddy` before it is sent.** Not a counting jump: a hard outage of one region.

A shared id that is registered in *neither* registry (`workbuddy-common`) fails the same way, for both regions.

Reproduced with the real class, not read off the source — `node docs/audit/issue59-o1-provider-probe.mjs`:

```
own id (today)
   events: error | stopReason: error | error: WOULD-STREAM        <- reached the provider
stamped "workbuddy" (O1)
   events: error | stopReason: error | error: Unknown provider: workbuddy
```

(The `WOULD-STREAM` line is the probe's own stub throwing *after* auth resolved and `provider.streamSimple` was entered, so the failure there is the sentinel, not a lookup miss; the second line is the lookup miss itself. Note `lazyStream` (`pi-ai/dist/api/lazy.js:36–53`) never throws: a setup failure is pushed into the stream as an `error` event and surfaces as `stopReason: "error"`, which is why a `try/catch` around `streamSimple` alone observes nothing.)

**What a real O1 would take (O1′)**, and why it is not "1 line":

1. Each adapter must register **two** provider entries: its route id, plus a shared id (e.g. `workbuddy-common`) whose `api`/auth/`getModels` are that **region's** — so `requireProvider` resolves inside each region's own registry while the stamped string is equal across regions.
2. Models must be stamped with that shared id, so `transform-messages.js:68` sees `assistantMsg.provider === model.provider` across regions.
3. The host must not surface the extra id as a second selectable route: `registerAdapter([...])` ownership (`profileOf` throws `NO_ADAPTER` for ids absent from the adapter's own profiles map, `lib/index.js:1864`) and `registerConfigurableProviders` (`src/index.ts:2050–2056`) currently describe exactly two routes; an extra adapter id has to be proven not to duplicate the picker entry.
4. The **field-spelling** caveat this report already raised still applies on top.

That is a feature-sized change with a region-outage failure mode, needing its own tests (both regions still route to their own baseUrl/credentials; picker unchanged; cross-region replay keeps thinking). It is not a patch to smuggle into a documentation release.

**The premise, now updated (2026-10-18 evening).** `docs/audit/ISSUE59-VERIFY.md` C7 originally recorded "the gateway bills downgraded text but not `reasoning_content`" as unmeasurable from this machine, and `docs/reasoning-investigation.md` still marked it 尚未测定. The reporter has since measured it with a same-region same-model increment (see `docs/reasoning-investigation.md` §11.7 and `docs/audit/ISSUE59-BILLING.md`), and this repo's own coefficient arithmetic corroborates it: the international side's tool blocks alone account for 97.7% of its `promptTokens`, which leaves no budget at all for 628K reasoning characters. So the step is no longer a guess — but it is still **his measurement plus our arithmetic**, not a controlled A/B run on this machine. O1′ remains a designed-but-unstarted change: the blocker is now the registration semantics (`models.js`'s one-id-one-provider assumption), not the billing question.

**Revised recommendation:** ship **O4** (documentation + the existing 4.8.0 `context-rescue`) now; record O1′ as a designed-but-unstarted change with the blocker above; file **O5** upstream. O2 and O3 remain closed for the reasons this report gives.

## O1′ SHIPPED (2026-10-18 late) — and steps 1–3 above turned out to be unnecessary

The design above assumed the shared id has to be a **second registered provider entry** whose models get stamped with it. Two probes showed that assumption was wrong, and the shipped change is one constant plus the stamp:

- `Models.getModel(provider, id)` is `getModels(provider).find(model => model.id === id)` (`models.js:116–118`), i.e. it calls `providers.get(KEY).getModels()`. The **registry key** and the **`provider` field stamped on the returned object** are therefore independent: a route registered as `workbuddy` may serve models whose `provider` is anything at all, and `getModel('workbuddy', 'hy3')` still returns the object with ITS baseUrl intact.
- So step 1 (a second provider entry per region) is not needed, and step 3 (the picker gaining a duplicate route) never arises: the route set is untouched. Step 2 is the whole change — `WORKBUDDY_MODEL_IDENTITY` in `src/adapter.ts`, stamped by `toPiModel`.
- The failure mode this report warned about (`Unknown provider: workbuddy`, a hard region outage) was dismissed here as belonging to the O1 shape that **replaces** the route id. **That dismissal was wrong, and issue #75 is what it cost.** The sentence "step 1 is not needed" rests on the assumption that nothing resolves a provider by the stamped field — but `requireProvider` does exactly that on the live chat path, and §6 of this very report says so three paragraphs earlier:

  ```
  models.js:351  requireProvider(model) { this.providers.get(model.provider) … }
  models.js:355  → throw ModelsError("provider", `Unknown provider: ${model.provider}`)
  host dsh-llm-pi-ai lib/index.js:1984  snapshot.models.streamSimple(model, …)
  host lib/index.js:1855-1857           createModels(auth); profiles→ models.setProvider(piProvider)
  ```

  Each region's adapter publishes only its own route key, so the GL registry holds `workbuddy-global` while GL models stamp `workbuddy` → **every GL request fails before it is sent**. CN survives only because its route string happens to equal the shared identity. The guard tests written for this section asserted `getModel(provider, id)` by ARGUMENT — the one lookup shape that does not consult the stamp — so they passed while the chat path was dead. That is the lesson worth keeping: a test written against the lookup path you reasoned about cannot falsify a conclusion drawn from that same path.
- The same equality note that motivated the check still holds: with the shared identity equal to the CN route string, a CN-stamped message and a GL request compare equal, which is only reachable if two different models shared an id — the catalog does not produce that, and a separate test pins that **different model ids still degrade**.

Executable proof, run against the real `transformMessages`: `tests/issue59-cross-region-thinking.spec.ts`. The old per-region stamps reproduce `[text, text]` (the reported defect); the shared identity reproduces `[thinking, text]`. Verified on both pi-ai copies this project meets — the repo's 0.85.1 and the host's 1.1.0.

Still true and still open: the **genuine** fix is upstream (let `isSameModel` read a provider-equivalence declaration rather than having a plugin disguise its identity), tracked at `earendil-works/pi#6167`.

## #75 CORRECTION (2026-10-19) — O1′ needed step 1 after all; `Unknown provider: workbuddy` was live since 4.9.0

The region outage this section dismissed is not hypothetical. `dsh-connect-workbuddy` 4.9.0/4.9.1 shipped O1′ exactly as described above and **the international region was completely unusable**: every request failed with `Unknown provider: workbuddy` before any bytes went upstream, in every new session, for every model. Issue #75 is that report; its diagnosis is confirmed against the installed host source, and so is the shape of the fix.

- **Step 1 is not optional.** Each region's `PiAiAdapter` must publish the shared identity as a registry key ALONGSIDE its route id, so `requireProvider` resolves inside each region's own registry while the stamp stays shared across regions. The `Models.providers` map is a plain `Map` (`models.js:37`), so publishing the same `piProvider` object under two keys is what the registry already does — no fake provider, no second route, no picker entry. Global ends up with keys `['workbuddy-global', 'workbuddy']` (route first, so the route stays the primary profile); CN deduplicates to a single `['workbuddy']`.
- **Step 3 really is unnecessary**, for the reason given above: the picker and route set are driven by `registerAdapter(routes, …)` / `registerConfigurableProviders`, not by a `profiles()` map, so an extra registry key is invisible to the user. #75 needs only step 1 plus the stamp step 2 already did.
- **The `invalidate()` path was the second trap.** Adapters rebuild `profiles` on catalog refresh; a rebuild that restores the single-key map silently re-breaks global after the first refresh, so the regression test asserts the post-`invalidate()` shape too, not just startup.
- **What the tests must look like next time.** `tests/issue75-global-provider-dispatch.spec.ts` drives the REAL `createModels(...)` + `setProvider(...)` + `streamSimple(...)` path that the host uses, and keeps a control case asserting that a registry holding only `workbuddy-global` still throws `Unknown provider: workbuddy` for a `workbuddy`-stamped model — so the test fails loudly if someone reverts to the 4.9.0 shape instead of passing vacuously.

Deliberately NOT adopted from the reporter's proposal: their one-line fix (`modelIdentity = options.modelIdentity ?? providerId`) revives #59 by re-splitting the stamp per region. The reporter's own prose acknowledges the tension; the minimal fix is minimal but it is not that line.
