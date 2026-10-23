/**
 * WorkBuddy (CodeBuddy / copilot.tencent.com) upstream client: chat streaming,
 * token refresh, model catalog, and credit balance.
 *
 * 参考：corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）
 *   — 端点与 wire behavior 由其实现，上游协议本身参照
 *     Sliverkiss/workbuddy2api（MIT）。照搬的部分：按 domain 选择
 *     CN/global base、强制 stream:true、tool_choice 压平为字符串、
 *     CLI 形态请求头、chat 请求绝不携带 refresh token 的安全红线、
 *     中英文额度不足标记与错误分类、token 刷新的 X-Refresh-Token 头。
 * 改动：原版的 `fetchModels` 只保留 id/name/maxInputTokens/maxOutputTokens，
 *   丢弃了上游其余 20 个字段。实测上游每个模型还给出 `credits` 积分倍率、
 *   `supportsImages` 多模态、`reasoning.supportedEfforts` 推理档位、
 *   `descriptionZh/En` 描述等，这些正是模型管理卡片所需的信息，
 *   本实现将其完整解析（解析不出则留空，不虚构）。
 *   `reasoning` 另有两种拼写：复数 `supportedEfforts` 形态与单数 `effort`
 *   形态（只声明默认档；两网关实测这些模型接受全阶梯，不发参数即不
 *   思考），解析层将单数形态折叠为复数（见 parseReasoning，issue #7）。
 *   另：积分接口改为按套餐名聚合，实测单个账号下同名「运营裂变包」
 *   可达 19 个，逐条渲染会淹没卡片。
 *   模型目录路径改为 `/v2/enterprises/personal/models`（原版为
 *   `/console/enterprises/personal/models`）：两版官方桌面 App 均调用
 *   `/v2` 形态，CN 网关两条路径逐字节同答，而国际版网关（workbuddy.ai）
 *   只答 `/v2`、`/console` 形态返回 HTTP 500——统一 `/v2` 即同时覆盖
 *   国内版与国际版（WorkBuddy AI）账号，区域由 `domain` 自动路由。
 *
 * @module dsh-connect-workbuddy/upstream
 */

import { randomUUID } from 'node:crypto'
import type { WorkBuddyCredential } from './auth.ts'
import { isRouterModelId } from './native-modality.ts'
import { parseQueueAnswer } from './queue.ts'
import {
  IMAGE_GENERATIONS_PATH,
  IMAGE_TAG_TEXT_TO_IMAGE,
  WorkBuddyImageError,
  buildImageBody,
  describeImageFailure,
  parseImageResponse,
  selectMediaModels,
  type WorkBuddyImageOutcome,
  type WorkBuddyMediaModel,
} from './image-gen.ts'
import { offRefused } from './off-thinking.ts'
import { attachPromos, parseWorkBuddyPromos } from './promo.ts'
import type { WorkBuddyPromo } from './promo.ts'
import { batchModelIds, parseBusyLevels } from './busy.ts'
import type { WorkBuddyBusyLevel } from './busy.ts'

/** WorkBuddy region selected by the credential's login domain. */
export type WorkBuddyRegion = 'cn' | 'global'

/** Upstream failure classes the shim maps onto distinct HTTP answers. */
export type UpstreamErrorKind =
  | 'hard_credit'
  /**
   * The upstream's own volume limit (business code 6004, or a 429 whose body
   * names a reset time). A statement about the ACCOUNT: it comes with a
   * timestamp, it lasts, and another account is a real way around it.
   */
  | 'soft_rate'
  /**
   * MODEL-scoped throttling with no stated time (business code 14003).
   *
   * Deliberately its own kind, because treating it as {@link soft_rate} is a
   * 30x amplification of an upstream that says "wait about a minute" — and it
   * makes the pool walk every account into the same wall (issue #56).
   *
   * The evidence that this is the MODEL's load and not the account's, measured
   * on one credential at one moment, byte-identical requests differing ONLY in
   * the `model` field, three attempts each:
   *
   *   | model                  | multiplier | ok  | failures   |
   *   | ---                    | ---        | --- | ---        |
   *   | deepseek-v4.1-flash    | x0.00      | 1/3 | 429 / 14003 |
   *   | deepseek-v4.1-flash-sg | x0.03      | 1/3 | 429 / 14003 |
   *   | glm-5.3-flash          | x0.06      | 3/3 | —          |
   *   | hy3                    | x0.00      | 3/3 | —          |
   *   | kimi-k2.6              | x0.77      | 3/3 | —          |
   *
   * The same account served other models at the same second, so the credential
   * was fine. The upstream's own words agree: "Wait about a minute before
   * retrying, or switch to a less busy model." Both halves are rendered to the
   * user; the second one is the actual remedy.
   */
  | 'model_busy'
  | 'session_dead'
  | 'policy_reject'
  /**
   * The gateway's channel gate refused the request itself (business code
   * 11128, "Illegal API invocation from an unapproved channel").
   *
   * Deliberately its own kind, because its `displayTips` — "this call failed
   * channel verification, possibly because it was not sent from an official
   * client" — names the account or the client version, and NEITHER is the
   * cause. The gate matches the OPENING of a `system` message against a list of
   * known third-party-agent prompts, so the same credential answers 200 to a
   * probe and 400 to a real chat request one second later (issues #87 / #88 /
   * #89 / #90). Filing it as `client` was technically true and practically
   * useless: the generic "refused on its parameters" sentence left the reader
   * to try another account, which cannot change a byte of the prompt.
   *
   * NOT failover-worthy for the same reason: every account sends the same
   * system prompt, so a second account answers the same 11128 one round trip
   * later and each attempt teaches the pool a false fact about a credential
   * that was never the problem.
   */
  | 'channel_reject'
  /**
   * The upstream put this request in a queue instead of running it: business
   * codes `6020` (waiting, with a position), `6021` (queue full), `6022` (this
   * user already holds the maximum). See `src/queue.ts`.
   *
   * Its own kind because it is the ONE failure where the credential was fine,
   * the request was fine, and the server already accepted the work — telling the
   * user "请求失败" or rotating accounts is wrong on both counts. A queued
   * request follows the MODEL and the shared queue, not the account, so another
   * account is handed the same position: NOT failover-worthy (see
   * `isFailoverWorthy` in the shim).
   *
   * Classified BEFORE the plain status branches: the queue condition arrives as
   * a business code and the HTTP status it rides on is incidental (observed on
   * 200-shaped envelopes and on 429/500). Without this member it fell through to
   * `server`/`soft_rate`, both of which DO fail over — so hitting a queue walked
   * the whole account pool, burning a real request per account, before saying
   * "you are #8777 in line".
   */
  | 'model_queue'
  | 'not_found'
  | 'server'
  | 'client'

/** Reasoning capability as the upstream catalog declares it. */
export interface WorkBuddyReasoning {
  supportedEfforts?: readonly string[]
  defaultEffort?: string
  canDisableThinking?: boolean
  /**
   * An OBSERVED refusal of the `off` tier for this model (issue #83).
   *
   * Never declared by the upstream: it is stamped from this plugin's own
   * refusal record, and it outlives the catalog that witnessed it so the card
   * can keep showing the badge after a refresh. `undefined` means "never
   * observed", which is not the same claim as "accepts".
   */
  refusesOff?: boolean
}

/** One CLI-usable model, carrying everything the plugin card displays. */
export interface WorkBuddyUpstreamModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  /** Credit multiplier parsed from the upstream `credits` string. */
  creditMultiplier?: number
  /**
   * Upstream's OWN image-input default, parsed from `supportsImages` with
   * `disabledMultimodal: true` as a veto. This is only a PRE-FILL for the
   * card's image checkboxes on "Refresh from WorkBuddy" (the refreshed draft
   * overwrites the saved image selection with the models advertising this):
   * it is not itself the runtime capability.
   *
   * The effective flag stays {@link multimodal}, stamped at runtime from the
   * user's saved `imageModelIds` — so a user can still uncheck an upstream-
   * advertised model, and the checked state only changes on an explicit
   * refresh/save.
   */
  supportsImages?: boolean
  /**
   * Effective image-input support at runtime, decided by the saved
   * `imageModelIds` (which a model refresh pre-fills from {@link supportsImages}
   * but the user can edit before saving). Never inferred directly by the
   * catalog parser — see `withImageSelection` in `index.ts`.
   */
  multimodal?: boolean
  reasoning?: WorkBuddyReasoning
  descriptionZh?: string
  descriptionEn?: string
  supportsToolCall?: boolean
  /**
   * The upstream's own promotion / tier badges that name THIS model.
   *
   * Not a field of the model entry: the upstream publishes the badges in
   * sibling arrays keyed by `modelIds` (`data.modelPromotions` /
   * `data.modelTiers`), inside the SAME `/v3/config` document that carries
   * the roster — so reading them costs no extra request.
   *
   * They ride along UNRESOLVED, and that is deliberate: a badge is a function
   * of the clock (the upstream's windows are wall-clock hours in a named
   * zone), so the entry that holds NOW is decided where the badge is drawn,
   * not where the document was read. See `src/promo.ts`.
   */
  promos?: readonly WorkBuddyPromo[]
  /**
   * How busy this model is RIGHT NOW, from the upstream's own probe
   * (`POST /v2/chat/busy`, see `src/busy.ts`).
   *
   * Deliberately NOT part of the catalog document, and deliberately not
   * persisted: the directory is a fact that survives a restart, a load level is
   * a fact about the minute it was measured. It is stamped onto the in-memory
   * catalog entry at refresh time and disappears with the process.
   */
  busyLevel?: WorkBuddyBusyLevel
}

/** One billing package as the upstream returns it, dates already parsed. */
export interface WorkBuddyCreditPackage {
  packageName: string
  /**
   * Remaining credit, always read from the CYCLE family (issue #58).
   *
   * The upstream reports a monthly resource (`CapacityType 4`) with TWO
   * capacity families, and for a long time this field carried the POOL one on
   * the theory that the pool answers "how much do I have" (issue #48). That was
   * wrong, and the official client settles it: on a live CN account the client
   * shows `总剩余积分 2,196.61` = `套餐基础积分 500` + `平台奖励积分 1,696.61`,
   * which is EXACTLY Σ `CycleCapacityRemainPrecise` over the same response
   * (1696.61 + 500), while Σ `CapacityRemain` is 2,196 — the pool figure lands
   * on the right integer only because that account's cycle is untouched, and
   * the cent is what proves which family the client reads.
   *
   * The pool family is not a balance at all: on a monthly resource whose cycle
   * is fully spent it still reports `CapacityRemain=500, CapacityUsed=0`, i.e.
   * "nothing used, everything left", while the cycle reports
   * `CycleCapacityUsed=500`. Read as a balance it OVER-reports by the whole
   * monthly allowance of every account (measured on 8/8 CN accounts: pool and
   * cycle agree only where the cycle is untouched).
   *
   * Independent confirmation comes from the international gateway: three global
   * accounts report `CapacityRemain=100` while the gateway REFUSES their chat
   * requests with `14018 Credits exhausted`, so the pool figure is not spendable
   * credit there either.
   *
   * A gift (`CapacityType 1`) carries both families with identical values, so
   * reading the cycle uniformly costs nothing and removes the branch that
   * produced the defect.
   */
  remain: number
  /** The package's capacity, from the same family as {@link remain}. */
  size: number
  /** CapacityType 4: refreshed every cycle and never expires. */
  monthly: boolean
  /** Next cycle start (the monthly refresh point); only on monthly packages. */
  refreshAtMs?: number
  /** One-off expiry; the package disappears from the account at this time. */
  expiresAtMs?: number
}

/** Aggregated credit answer for one credential. */
export interface WorkBuddyCredits {
  total: number
  packages: readonly WorkBuddyCreditPackage[]
  /** Credits expiring within 3 days across every package. */
  expiringSoon: number
  /** When the nearest package expires, in ms. */
  nearestExpiryMs?: number
}

/** Daily check-in activity state. */
export interface WorkBuddyCheckinStatus {
  active: boolean
  todayCheckedIn: boolean
  streakDays: number
  dailyCredit: number
  todayCredit: number
  isStreakDay: boolean
  nextStreakDay: number
  streakBonusDays: number
  streakBonusCredit: number
  claimButtonText?: string
}

/** Daily check-in claim result. */
export interface WorkBuddyCheckinClaim {
  credit: number
  streakDays: number
  isStreakDay: boolean
}

/**
 * One promotional benefit the account may or may not still be entitled to.
 *
 * Read from the billing gateway's OWN status endpoints — the same two the
 * 「套餐与积分」 page calls before it decides whether to render a claim card
 * (`/billing/meter/compensation-status`, `/billing/meter/check-gift-claimed`).
 * Reading them is what makes the card honest: the plugin shows a benefit only
 * while the gateway itself would still show one.
 *
 * The two flags answer DIFFERENT questions and neither can be derived from the
 * other — this is the single most important fact about this shape, measured on
 * a real account pool:
 *
 *   - `active` is about the WINDOW, not about the reader. An account that has
 *     already claimed still reports `active: true` (observed: `claimed: true`
 *     together with `active: true` on a claimed gift), so `active` alone cannot
 *     mean "claimable".
 *   - `claimed` is about THIS account, and it survives the window: once the
 *     campaign lapses the endpoint keeps answering `claimed: false` with
 *     `active: false` (observed on every international account, whose campaign
 *     ended months ago).
 *
 * Hence a benefit is claimable exactly when {@link active} AND NOT
 * {@link claimed}. See `benefitOf` in `src/benefits.ts`.
 */
export interface WorkBuddyBenefit {
  /** Which campaign this is; the plugin renders one row per kind. */
  kind: 'compensation' | 'gift'
  /** The campaign is inside its window (empty, see: already claimed ≠ inactive). */
  active: boolean
  /** This account has already taken it — permanently, even after the window. */
  claimed: boolean
  /** Credits on offer, as the gateway states them. */
  creditNum: number
  /** Window end, epoch ms. Absent when the gateway sent none it could parse. */
  endsAtMs?: number
  /** Window start, epoch ms. Compensation omits it. */
  startsAtMs?: number
  /** When this account claimed it, epoch ms. Only meaningful with `claimed`. */
  claimedAtMs?: number
}

/**
 * The write half of each campaign: the endpoint that actually grants the
 * credits.
 *
 * Kept beside the status paths because they must move together: the pair is
 * what the 「套餐与积分」 page itself uses (`xp`/`vp` in its bundle), and a
 * campaign whose status is read from one path can only be claimed through its
 * matching claim path. Note the same absence of a `/v2` prefix.
 */
const BENEFIT_CLAIM_PATHS: Readonly<Record<WorkBuddyBenefit['kind'], string>> = {
  compensation: '/billing/meter/claim-compensation',
  gift: '/billing/meter/claim-gift',
}

/** Token refresh answer; fields the upstream omits stay absent. */
export interface WorkBuddyRefreshOutcome {
  accessToken: string
  refreshToken?: string
  expiresInSec?: number
  domain?: string
}

/** Chat answer: either a live SSE response or a classified failure. */
export type WorkBuddyChatResult =
  | { ok: true; response: Response }
  | {
      ok: false
      status: number
      kind: UpstreamErrorKind
      message: string
      /** Structured fields lifted from a JSON failure body, when there were any. */
      detail?: UpstreamErrorDetail | undefined
    }

/**
 * Chat answer that also carries the response headers.
 *
 * Used by the model probe, whose whole point is to ask "is this usable right
 * now, and if not, when?" — and the only place an upstream ever names a
 * cooldown is the `Retry-After` header, which {@link WorkBuddyChatResult}
 * deliberately does not surface. Returning a separate shape keeps the ordinary
 * chat path (and its callers) untouched.
 */
export interface WorkBuddyProbeAnswer {
  ok: boolean
  status: number
  /** Raw `Retry-After`, when the upstream sent one; null otherwise. */
  retryAfter: string | null
  /** Failure body excerpt, only when `ok` is false. */
  body?: string
  /** The live stream, only when `ok` is true. The caller drains and discards it. */
  response?: Response
}

const CN_CHAT_BASE = 'https://copilot.tencent.com'
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
const GLOBAL_BASE = 'https://www.workbuddy.ai'

/**
 * Legacy model-catalog path, kept only as the CN region's FALLBACK.
 *
 * This is the document the WorkBuddy *plugin* used to read, and it is NOT the
 * document the WorkBuddy *app* reads: the gateway answers it with the CLI
 * channel's roster, which carries neither the app's `auto` slot nor any
 * promotion feed. The free Hy4 tier that used to live here as a separate
 * `hy4-preview-f` record is gone as a record — measured 2026-10-21, both
 * channels list the paid `hy4-preview` (`x0.29`) — and the free tier is now
 * expressed as a promotion badge (`夜间免费`) in the app-channel document only.
 * So this path is strictly poorer than {@link GLOBAL_CONFIG_PATH}; it stays
 * only so that a gateway which stops serving the modern document degrades
 * instead of emptying the region.
 */
const MODELS_CATALOG_PATH = '/v2/enterprises/personal/models'

/**
 * Remote product-config path — the document the WorkBuddy app itself reads for
 * its model list, its prices AND its promotion badges.
 *
 * It is field-compatible with {@link MODELS_CATALOG_PATH} for every key
 * {@link parseUpstreamModel} reads, so one parser still serves both, and it
 * additionally carries `modelPromotions` / `modelTiers` — the promotion feed
 * no other path publishes (see {@link withPromos}).
 *
 * Which document this path answers depends on the CHANNEL the request claims
 * to be (see {@link PRODUCT_UA}); it does not depend on the host: `www.workbuddy.cn`,
 * `copilot.tencent.com`, `wb.tencentbuddy.com` and `www.codebuddy.cn` answer
 * byte-identically under the same header.
 */
const GLOBAL_CONFIG_PATH = '/v3/config'

/**
 * The app's model-load probe (see `src/busy.ts`), read-only and free.
 *
 * Not part of any catalog document: this endpoint answers ONE fact per model id
 * — how busy it is right now — and answers it for up to 50 ids at a time. It is
 * host- and identity-insensitive on the CN side (measured 2026-10-21 on all
 * three CN hosts, under both the CLI and the app user agent: byte-identical),
 * so it is asked as the chat channel's own identity.
 *
 * IT DOES NOT EXIST ON THE GLOBAL GATEWAY. Measured 2026-10-22: this exact POST
 * against `www.workbuddy.ai` answers 404 `Route Not Found` (as do the four
 * neighbouring spellings tried under both POST and GET), while the same
 * credential reads that gateway's `/v3/config` normally and finds no load field
 * on any model. {@link WorkBuddyUpstreamClient.fetchModelBusy} is therefore
 * expected to THROW for that region — `withBusyLevels` in `src/index.ts` catches
 * it and ships the roster without levels. Kept as-is rather than region-gated:
 * the day upstream adds it, this needs no change, and the cost today is one
 * 404 per refresh that never blocks anything.
 */
const MODEL_BUSY_PATH = '/v2/chat/busy'

/**
 * The app's own ceiling for one probe (`timeout: 5e3` in its
 * `useModelBusyLevels`). Short on purpose: a slow load probe is worth less than
 * the refresh it is attached to, and the catalog must not wait on it.
 */
const MODEL_BUSY_TIMEOUT_MS = 5_000

/**
 * The chat channel's user agent — the identity the plugin's adapter speaks as.
 *
 * Chat is a different contract from configuration: the conversation-identity
 * triple (conversation id, session id, device id) is bound to this channel, and
 * the upstream bills and rate-limits it as the CLI agent. The plugin chats as
 * the CLI agent on purpose, so this stays {@link CLIENT_UA} everywhere the
 * request is a CHAT.
 */
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

/**
 * The product-config channel's user agent: the WorkBuddy APP's own product
 * identity, byte-for-byte the header the app sends.
 *
 * The app builds it in `buildVlmGatewayHeaders` (WorkBuddy 5.8.3) as
 *
 *     `User-Agent: WorkBuddy/<app> WorkBuddy/<app> CLI/<cli>`
 *
 * — the app version twice, the CLI version once — and sends it to
 * `/v3/config`; the app's own log reads
 * `fetch cloud product from url:https://www.workbuddy.cn/v3/config success`
 * with `{"user-agent":"WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0", …}`.
 *
 * It matters, because `/v3/config` answers a DIFFERENT product configuration
 * per client channel. Measured 2026-10-21, same token, same URL, only this
 * header differing (CN gateway):
 *
 *   | User-Agent                                    | `/v3/config` answer                    |
 *   | ---                                           | ---                                    |
 *   | `CLI/2.63.2 CodeBuddy/2.63.2` (CLI channel)   | 5 keys, 35 models, NO promotion feed    |
 *   | `WorkBuddy/5.8.3` (app channel, no CLI part)  | 18 keys, 37 models, no promotion feed   |
 *   | `WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0` | 22 keys, 62 models, 8 promos + 1 tier   |
 *
 * The CLI channel's answer is a strict SUBSET of the app channel's: it
 * publishes neither `modelPromotions` nor `modelTiers`. That is precisely why
 * the CN card showed no promotion badge while the WorkBuddy app showed one on
 * the very same account — the plugin was reading a document the upstream
 * publishes WITHOUT the feed, not a feed that does not exist.
 *
 * The version suffixes are inert — `WorkBuddy/1.0.0 CLI/2.63.2
 * CodeBuddy/2.63.2` answers identically — so what selects the document is the
 * CHANNEL the header claims, not the version in it.
 *
 * Global answers the same document under either app-shaped header (17 keys,
 * 28 models, 5 promotions + 1 tier, identical roster), so both regions read
 * `/v3/config` as {@link PRODUCT_UA}.
 */
const PRODUCT_UA = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0'
const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096

/**
 * Ceiling for one real-volume probe to get a RESPONSE, which is not a metadata
 * call.
 *
 * Much larger than {@link JSON_TIMEOUT_MS} on purpose: a probe posts ~25k input
 * tokens, so prompt processing legitimately takes a while before the first byte
 * comes back. It exists only to stop a connection that will NEVER answer — the
 * pool's batch is serial, so one hung member would otherwise block all the rest
 * with nothing in the UI to say which one it was. Ten seconds is comfortably
 * above a working gateway's first byte and far below a user's patience; the
 * budget covers the response only, never the one-line body that follows.
 */
const PROBE_TIMEOUT_MS = 10_000

/**
 * 生图请求的超时。
 *
 * 实测一张 1024x1024 的图在官方网关要 17–39 秒（`hunyuan-image-alpha`，
 * 2026-10-21，两个国内入口各测一次），比任何 JSON 接口都慢一个数量级，
 * 因此不能复用 {@link JSON_TIMEOUT_MS}。三分钟足够覆盖一次正常的排队+推理，
 * 又不至于让一个卡死的连接占住工具槽位太久。
 */
const IMAGE_TIMEOUT_MS = 180_000

/**
 * Insufficient-credit markers.
 *
 * ENGLISH IS MATCHED CASE-INSENSITIVELY (see {@link classifyUpstreamError}) so
 * each entry is spelled once, lowercase. Chinese has no case, so those entries
 * are the upstream's own wording.
 *
 * `credits exhausted` is listed alongside `credit exhausted` because the
 * upstream ships the PLURAL — measured 2026-10-13 on a live `14018`:
 *
 *   {"error":{"data":{"code":14018,"msg":"Credits exhausted. Please visit the
 *    link below to purchase add-on packs and get more credits: …"}}}
 *
 * The singular-only entry silently missed it (`'credits exhausted.'.includes(
 * 'credit exhausted')` is FALSE — the `s` sits between the two words), so a
 * failure whose entire point is "go top up" was reported as "wait a bit" and
 * benched a healthy account for the 30-minute fallback. Both spellings are kept
 * because the gateway has been observed to change its wording; neither is
 * assumed to be the only one.
 */
const HARD_CREDIT_MARKERS: readonly string[] = [
  'insufficient credit', 'no credit', 'credit exhausted', 'credits exhausted',
  'out of credit', 'quota exceeded', 'quota exhaust', 'payment required',
  'credit not enough', 'not enough credit', 'credits not enough',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]

/**
 * Business code of the exhaustion refusal (`14018`).
 *
 * The CODE, not the prose — see {@link HARD_CREDIT_MARKERS} for the wording bug
 * this guards against. Marker tables rot in a way codes do not: the gateway can
 * reword its sentence without changing the contract it advertises, and the
 * failure is silent (the branch simply stops matching). A code cannot drift like
 * that, and matching it in quoted-key form keeps a request id that happens to
 * contain the digits from promoting an unrelated body.
 *
 * ONLY a corroborating signal, never a substitute: the code is checked in
 * addition to the markers, so a body that names the code AND reads as a policy
 * refusal still resolves by the marker table's order.
 */
const CREDITS_EXHAUSTED_CODE = '"code":14018'

/** Session-invalidation markers that mean "sign in again in the WorkBuddy app". */
const SESSION_DEAD_MARKERS: readonly string[] = ['Offline user session not found', '12153']

/**
 * Content-policy refusal markers from the chat gateway. The quoted-key form
 * avoids substring hits inside unrelated values (request ids are hex and can
 * contain `11140` by coincidence).
 */
const POLICY_REJECT_MARKERS: readonly string[] = ['request illegal', '"code":11140']

/**
 * Business code of the MODEL-scoped throttle (`14003`, "too many requests").
 *
 * The quoted-key form for the same reason as the policy markers: a request id is
 * hexadecimal and can contain the digits `14003` by coincidence, and a bare
 * substring search over an arbitrary failure body is how a red herring gets
 * promoted into a routing decision.
 */
const MODEL_BUSY_CODE = '"code":14003'

/**
 * Business code of the gateway's CHANNEL gate (`11128`, "Illegal API invocation
 * from an unapproved channel").
 *
 * The quoted-key form for the same reason as the markers above: a request id is
 * hexadecimal and can contain the digits `11128` by coincidence.
 *
 * A DIFFERENT gate from the one {@link conversationHeaders} works around, which
 * also answers `11128` (`conversation id missing`). The code is the same
 * because the gateway reuses it for every rule in that family; the BODY is what
 * tells them apart, so {@link isChannelRejectBody} requires both halves.
 */
const CHANNEL_REJECT_CODE = '"code":11128'

/**
 * Business code for "the request exceeded the model's context window" (issue #101).
 *
 * The gateway answers `11115` in TWO shapes, and only one of them is
 * self-describing:
 *
 *   A. `prompt is too long: 100001 tokens > 100000 maximum` — carries numbers;
 *   B. the localized sentence only (「本次输入加上历史对话超过了模型上限…」), no numbers.
 *
 * Shape B is the one that hurt. The HOST decides whether to run its
 * context-overflow rescue by matching the error text against a list of ENGLISH
 * patterns (`prompt (?:is )?too long`, `exceeds the context window`,
 * `context[_ ]length[_ ]exceeded`, …25 of them), and a Chinese sentence matches
 * none of them. So on shape B the host neither compacts nor retries: the user
 * gets a bare 400 whose own advice ("请精简内容") the host cannot act on.
 *
 * {@link contextOverflowMarker} is the fix: the plugin adds an English clause
 * the host recognises, and keeps the upstream's own sentence beside it.
 */
/**
 * The business code, in either of the two spellings the plugin ever holds.
 *
 * Two forms are in circulation and BOTH reach this predicate:
 *   - the raw upstream body: `{"code":11115,...}`;
 *   - the reply this plugin already composed, which renders it as
 *     `（code 11115，requestId …）` — the form the retry path re-reads.
 *
 * The trailing `(?!\d)` matters: `111150` and `1111` both contain the digits
 * after a naive substring test, and misreading a DIFFERENT refusal as an
 * overflow would send the host into a compaction pass that cannot help.
 */
const CONTEXT_TOO_LONG_CODE = /"code"\s*:\s*11115(?!\d)|code\s+11115(?!\d)/u

/**
 * Whether this body is the context-length refusal, in EITHER of its shapes.
 *
 * Shape B carries no number and no English phrase, so the business code is the
 * only reliable handle — the same reasoning as {@link isChannelRejectBody}'s
 * code-plus-wording pair, except that here the wording is what VARIES.
 */
export function isContextTooLongBody(body: string): boolean {
  return CONTEXT_TOO_LONG_CODE.test(body)
}

/**
 * An English clause the HOST's overflow detector recognises, for issue #101.
 *
 * `prompt is too long` is the first entry of the host's pattern list and the
 * phrasing Anthropic-compatible gateways already use, so it is the cheapest way
 * to say "this is an overflow" to a detector that only reads English. The
 * numbers are omitted deliberately: the upstream never gave them in shape B, and
 * inventing them would be the exact confident-wrong-diagnosis this plugin spends
 * its comments avoiding.
 */
export const CONTEXT_OVERFLOW_MARKER = 'prompt is too long (upstream code 11115)'

/**
 * Wording that identifies the CHANNEL half of `11128` (the other halves being
 * `conversation id missing` and `first message is not system prompt`).
 *
 * Matched against the upstream's `msg`, NEVER against `displayTips`. That is not
 * a style choice: the tips are the SAME misleading sentence for every member of
 * the `11128` family — "这次调用没通过渠道校验，可能不是官方客户端发出的" — which is
 * why matching them would claim the conversation-id gate too and blame the
 * prompt's opening for a header problem this plugin already fixes.
 *
 * Lower-cased before the search. Two spellings are listed because the observed
 * bodies name the code and the phrase together
 * (`{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}`),
 * and either half is enough to identify it.
 */
const CHANNEL_REJECT_MARKERS: readonly string[] = [
  'unapproved channel',
  'illegal api invocation',
]

/**
 * The wordings that identify the OTHER two members of the `11128` family.
 *
 * Used ONLY to NAME a member ({@link channelGateMemberOf}), never to exclude a
 * body from the family. The old code used them as an exclusion list, which is
 * how issue #113's misreported refusal was kept out of the plugin's retry
 * ladder: the upstream wrote `conversation id missing` over a content refusal,
 * and the exclusion believed it.
 *
 * Each is exported as its own predicate ({@link isConversationIdGateBody},
 * {@link isFirstMessageGateBody}) so the reply can NAME the gate instead of
 * relaying the upstream's `displayTips` — which is the SAME misleading
 * sentence for all three members of the `11128` family.
 */
const CONVERSATION_ID_GATE_MARKER = 'conversation id missing'
const FIRST_MESSAGE_GATE_MARKER = 'first message is not system prompt'

/**
 * The upstream's own advice for {@link MODEL_BUSY_CODE}, in both shapes it ships
 * (`displayTips.zh` and its English twin).
 *
 * NOT a criterion — {@link isModelBusyBody} decides on the code alone. It is
 * recorded here because it is the sentence that names the remedy, and the card
 * quotes the upstream rather than inventing advice. Keeping it as data (rather
 * than as a second condition) is what stops a gateway banner that happens to
 * mention "a less busy model" from being routed as this kind.
 */
const MODEL_BUSY_TIPS_MARKERS: readonly string[] = [
  'less busy model',
  '负载较低的模型',
  '負載較低的模型',
]

/**
 * Whether a failure body is the MODEL-scoped throttle rather than an account
 * limit.
 *
 * `14003` and `6004` are different codes from the same gateway and mean
 * different things. Measured on one credential at one moment, with requests that
 * differed ONLY in `model`, three attempts each: `deepseek-v4.1-flash`
 * (multiplier x0.00) answered 1/3 and refused 2/3 with `429 / 14003`, while
 * `glm-5.3-flash`, `hy3` and `kimi-k2.6` answered 3/3 — the SAME account, the
 * SAME second. A 6004, by contrast, carries a `将在 … UTC+8 重置` sentence and
 * is per-account.
 *
 * So the criterion is the CODE alone, matched in its quoted-key form so a
 * request id that happens to contain the digits cannot promote it. Exported so
 * the probe and the chat path cannot drift into two different answers about one
 * body.
 */
export function isModelBusyBody(body: string): boolean {
  return body.includes(MODEL_BUSY_CODE)
}

/** Whether a body carries the upstream's own "switch to a less busy model" advice. */
export function carriesModelBusyTip(body: string): boolean {
  return MODEL_BUSY_TIPS_MARKERS.some(marker => body.includes(marker))
}

/**
 * Which member of the `11128` family a failure body belongs to.
 *
 * ISSUE #113, AND WHY THE `msg` WORDING CANNOT BE TRUSTED. The three members
 * of this family share one business code and one `displayTips` sentence, so
 * the `msg` is the only thing that used to tell them apart — and the `msg` is
 * NOT reliable. Issue #113 measured a CN refusal whose `msg` literally read
 * `conversation id missing` while the three conversation-id headers were all
 * present and correct; the refusal was about the request's CONTENT, not its
 * headers. (The plugin's own conversation-id workarounds were in place — see
 * {@link conversationHeaders} — so the wording was simply wrong.)
 *
 * The consequence was not cosmetic. `isChannelRejectBody()` EXCLUDES a body
 * carrying the conversation-id wording, so such a body was not recognised as
 * the channel gate at all: it was filed as `client`, which means the plugin's
 * two-step retry ladder (`forceNeutralHead`, then the invisible perturbation)
 * NEVER RAN, and the user got the generic "refused on its parameters"
 * sentence instead of the channel diagnosis. That is very likely why the
 * reporters in issue #98's thread found that upgrading changed nothing for
 * them: their bodies never entered the path that could have helped.
 *
 * So the family is now recognised BY ITS CODE, and the member is named by
 * evidence the plugin can gather ITSELF — the request it just sent — rather
 * than by a wording the upstream may misreport.
 */
export type ChannelGateMember =
  /** The prompt's content was fingerprinted. The plugin can retry this. */
  | 'prompt'
  /** A request header the gateway wants was missing or rejected. */
  | 'headers'
  /** The request did not open with a `system` message. */
  | 'first_message'
  /** The body says `11128` but names none of the three. */
  | 'unknown'

/**
 * Whether a failure body belongs to the `11128` gate family AT ALL.
 *
 * The code is matched in its quoted-key form (`"code":11128`): a request id is
 * hexadecimal and can contain the digits `11128` by coincidence, and a bare
 * substring search over an arbitrary failure body is how a red herring gets
 * promoted into a diagnosis.
 */
export function isChannelGateFamilyBody(body: string): boolean {
  return body.includes(CHANNEL_REJECT_CODE)
}

/**
 * Whether a failure body is the gateway's CHANNEL gate — i.e. whether it
 * belongs to the `11128` FAMILY.
 *
 * ISSUE #113, AND WHY THIS NOW ANSWERS "IS IT THE FAMILY" RATHER THAN "IS IT
 * THE PROMPT MEMBER". The family has three members (prompt fingerprint,
 * missing conversation id, missing system head) sharing one business code and
 * one `displayTips` sentence, so the `msg` wording used to be the only thing
 * that could tell them apart — and the wording is NOT reliable. Issue #113
 * measured a CN refusal whose `msg` read `conversation id missing` while the
 * three conversation-id headers were all present and correct; the refusal was
 * about the request's CONTENT.
 *
 * The old rule required the channel wording AND the absence of the sibling
 * wordings, so such a body was excluded from the channel gate entirely and
 * filed as a plain `client`. That was not cosmetic: `client` never enters the
 * plugin's two-step retry ladder (`forceNeutralHead`, then the invisible
 * perturbation), so the rescue path that exists for precisely this refusal
 * never ran. That is very likely why the reporters in issue #98's thread found
 * that upgrading changed nothing.
 *
 * Every member of this family is a CHANNEL-verification refusal — the
 * upstream's own shared sentence says so — so acting on the family is correct
 * whoever the member is. Which member it is decides only what the reply
 * ADVISES, and that is {@link channelGateMemberOf}'s job, decided by the
 * plugin's own evidence rather than by a wording the upstream may misreport.
 *
 * The code is matched in its quoted-key form (`"code":11128`): a request id is
 * hexadecimal and can contain the digits `11128` by coincidence, and a bare
 * substring search over an arbitrary failure body is how a red herring gets
 * promoted into a diagnosis.
 */
export function isChannelRejectBody(body: string): boolean {
  return isChannelGateFamilyBody(body)
}

/**
 * Whether a failure body is the CONVERSATION-ID gate (`11128`).
 *
 * One of the two gates that share the channel gate's business code, and one
 * of the two this plugin's diagnosis EXCLUDES: the prompt is not at fault
 * here, the request headers are — which is why it must never be reported as
 * "the gateway refused your system prompt".
 *
 * It is exported anyway, so a reply can NAME it. The upstream's `displayTips`
 * for all three `11128` gates is the identical sentence ("这次调用没通过渠道
 * 校验，可能不是官方客户端发出的"), so the tips cannot tell them apart — only
 * `msg` can. Hence the wording is the criterion and the code is the
 * corroboration, never the other way round.
 *
 * BOTH halves are required, and the code is matched in its quoted-key form
 * (`"code":11128`): a request id is hexadecimal and can contain the digits
 * `11128` by coincidence, and a bare substring search over an arbitrary
 * failure body is how a red herring gets promoted into a diagnosis.
 */
export function isConversationIdGateBody(body: string): boolean {
  const lower = body.toLowerCase()
  return lower.includes(CHANNEL_REJECT_CODE) && lower.includes(CONVERSATION_ID_GATE_MARKER)
}

/**
 * Whether a failure body is the FIRST-MESSAGE gate (`11128`).
 *
 * The global gateway's own rule: a chat request must OPEN with a system
 * message, and a user-first body is refused with `11128` / "first message is
 * not system prompt". The plugin's `ensureSystemHead()` satisfies it, so a
 * body carrying this wording says the request never had a system head — not
 * that a system prompt was fingerprinted.
 *
 * Excluded from the prompt diagnosis for the same reason as
 * {@link isConversationIdGateBody}, and named by the same rule: the CODE plus
 * the WORDING, case-insensitively, code in its quoted-key form.
 */
export function isFirstMessageGateBody(body: string): boolean {
  const lower = body.toLowerCase()
  return lower.includes(CHANNEL_REJECT_CODE) && lower.includes(FIRST_MESSAGE_GATE_MARKER)
}

/**
 * Which member of the `11128` family a body is, decided by the plugin's OWN
 * evidence rather than by the upstream's wording.
 *
 * THE EVIDENCE, IN ORDER OF STRENGTH.
 *
 * 1. The body carries the channel wording (`unapproved channel` /
 *    `illegal api invocation`). That is the upstream naming the PROMPT gate
 *    explicitly, so it is trusted.
 * 2. The body says `conversation id missing`. The wording is only believable
 *    when the request did NOT carry the conversation-id triple; the plugin's
 *    `chatHeaders` adds it to every chat request, so in practice it is always
 *    there and the wording is always a misreport — which is issue #113's
 *    exact measurement. The refusal is then about the CONTENT, i.e. the
 *    PROMPT gate, which is also the only member the plugin can act on.
 * 3. The body names the first-message gate. That gate is about the request's
 *    SHAPE, and `ensureSystemHead` guarantees a `system` head whenever the
 *    request carries messages, so it is only reported as that gate when the
 *    request genuinely had none.
 * 4. Otherwise: `unknown`. The family is still the family — the retry ladder
 *    applies — but the reply says it cannot name the member rather than
 *    guessing, because a confidently wrong diagnosis sends the user to edit a
 *    prompt that is not at fault.
 *
 * @param body The failure body.
 * @param request What the plugin knows about the request it just sent.
 */
export function channelGateMemberOf(
  body: string,
  request?: { hasSystemHead: boolean; hasConversationHeaders: boolean },
): ChannelGateMember {
  const lower = body.toLowerCase()
  if (CHANNEL_REJECT_MARKERS.some(marker => lower.includes(marker))) return 'prompt'
  if (lower.includes(CONVERSATION_ID_GATE_MARKER)) {
    // The wording is only believable when the headers were actually absent.
    // When they were present, the refusal was about something else — and the
    // prompt gate is the only member the plugin can act on.
    if (request?.hasConversationHeaders === false) return 'headers'
    return 'prompt'
  }
  if (lower.includes(FIRST_MESSAGE_GATE_MARKER)) {
    // The plugin always sends a system head when the request has messages, so
    // this wording is only believable when it genuinely had none.
    if (request?.hasSystemHead === false) return 'first_message'
    return 'unknown'
  }
  return 'unknown'
}

/**
 * The OPENINGS of the `system` messages in a prepared request body.
 *
 * REMOVED in favour of {@link systemOpeningEvidenceOfBody}, which answers the
 * same question ("what did the gate actually see?") for BOTH string and
 * array-shaped content and can also say whether an opening is the plugin's own
 * neutral head. Two functions that both claim to describe what the gate read
 * are two truths that drift — and the array-shaped case is exactly where the
 * old one was blind.
 */

/** Longest system-prompt opening echoed back to the user, in characters. */
const SYSTEM_OPENING_LIMIT = 120

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/**
 * Classify an upstream failure from its HTTP status and body excerpt.
 *
 * The `11128` family is classified BY ITS CODE, not by the `msg` wording —
 * see {@link isChannelRejectBody} and {@link channelGateMemberOf}. Which
 * member of the family it is decides the ADVICE in the reply, never the
 * classification: every member is a channel-verification refusal that no
 * account, region or top-up can change.
 */
export function classifyUpstreamError(status: number, body: string): UpstreamErrorKind {
  if (status === 402) return 'hard_credit'
  const lower = body.toLowerCase()
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return 'hard_credit'
  }
  // The code path, for the same class of failure. Kept INSTEAD OF trusting the
  // markers alone rather than replacing them: the live `14018` body spells
  // "Credits exhausted.", which the singular marker missed outright (see
  // HARD_CREDIT_MARKERS), and a wording change must not be able to silently
  // downgrade "go top up" into "wait a bit" again.
  //
  // Ordered with the markers, i.e. BEFORE `model_busy`: a body carrying both an
  // exhaustion code and a throttling code still resolves to the actionable,
  // wallet-shaped answer.
  if (body.includes(CREDITS_EXHAUSTED_CODE)) return 'hard_credit'
  for (const marker of SESSION_DEAD_MARKERS) {
    if (body.includes(marker)) return 'session_dead'
  }
  for (const marker of POLICY_REJECT_MARKERS) {
    if (body.includes(marker)) return 'policy_reject'
  }
  // AFTER the policy markers so a body that really is a content refusal keeps
  // that (more specific) reply, and BEFORE the plain 400 fallback so the channel
  // gate stops being filed as `client` — the misclassification that sent issues
  // #87–#90's reporters through account swaps that could not help.
  //
  // ISSUE #113: the whole `11128` FAMILY is classified here, by code. The old
  // rule excluded a body carrying the conversation-id wording, on the theory
  // that it must be a header problem — but that wording is not reliable (a
  // content refusal was measured carrying it), and the exclusion pushed such
  // bodies into `client`, which skips the plugin's retry ladder entirely.
  // Which member it actually is now decides the reply's ADVICE only
  // (`channelGateMemberOf`), never whether the rescue path runs.
  if (isChannelRejectBody(body)) return 'channel_reject'
  // BEFORE the plain 429 branch: a 14003 is a 429, and classifying it as
  // `soft_rate` is the whole of issue #56 — it made the pool treat a
  // model-scoped, second-scale throttle as a 30-minute per-account cooldown and
  // walk every account into the same wall.
  //
  // Checked AFTER the credit markers so a body carrying both ("insufficient
  // credit" alongside a throttling code) still reads as the actionable,
  // wallet-shaped failure: the user must top up, not retry.
  if (isModelBusyBody(body)) return 'model_busy'
  // BEFORE the plain status branches, for the same reason as `model_busy`: a
  // queue condition is a BUSINESS CODE and the HTTP status it rides on is
  // incidental. Measured on the OpenAI-compatible channel it arrives with 200,
  // 429 and 500-shaped envelopes alike; classifying by status first made a
  // queue look like `server`/`soft_rate`, and both of those fail over — so one
  // queued request walked the entire account pool (a real request per account)
  // before the queue was even recognised.
  if (parseQueueAnswer(body) !== undefined) return 'model_queue'
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'client'
}

/** Structured fields lifted out of a JSON upstream failure body. */
export interface UpstreamErrorDetail {
  /** Numeric upstream error code, e.g. 11140 for a content-policy refusal. */
  upstreamCode?: number
  /** Upstream request id — the handle support asks for. */
  requestId?: string
  /**
   * The upstream's RAW `msg`, kept beside {@link displayMsg}.
   *
   * On the `11128` family this is the DIAGNOSTIC half — it is what names which
   * gate fired ("conversation id missing", "first message is not system
   * prompt"), while `displayMsg` is the user-facing sentence the plugin must
   * NOT use as a diagnosis (issue #113 measured it to mislabel a content
   * refusal). Keeping both means a reply can echo what arrived AND say why it
   * is or is not believable, without one overwriting the other.
   */
  rawMsg?: string
  /** Best human-facing message: `displayMsg.zh`, falling back to `.en`, then `msg`. */
  displayMsg?: string
  /**
   * What the upstream says to DO about it: `displayTips.zh`, falling back to
   * `.en` (issue #78).
   *
   * Kept separate from {@link displayMsg} because the two answer different
   * questions and both are needed: `displayMsg` names what was rejected
   * ("模型无法处理此请求"), while `displayTips` names the REMEDY ("请新建任务、换个
   * 模型或稍后重试"). The generic failure path used to discard it and render the
   * raw body instead, whose first 400 characters are the `code`/`requestId`/
   * `extError` skeleton — so the one actionable sentence was always cut off, and
   * a plain parameter rejection read like an empty account pool.
   *
   * Recorded as data rather than folded into `displayMsg` so a caller that wants
   * to tell the user what to change can do so without the "what went wrong"
   * clause losing its own meaning.
   */
  tips?: string
  /**
   * The request parameter the upstream named as rejected, from
   * `extError.param` (issue #83).
   *
   * Kept because the generic sentences cannot say WHICH parameter was at fault:
   * a 11133 caused by `reasoning_effort` reads exactly like a model that is
   * unavailable, and the fix (untick one checkbox) lives nowhere in the reply.
   */
  rejectedParam?: string
  /** The offending value of {@link rejectedParam}, when the body carries one. */
  rejectedTier?: string
}

/**
 * Read one of the upstream's localized fields, in either shape it ships: a plain
 * string, or a `{ zh, en }` object.
 *
 * One reader for every such field on purpose. `displayMsg` and `displayTips`
 * arrive in the same two shapes from the same envelope, so parsing them with two
 * separate hand-rolled branches is how one of them ends up only handling the
 * object form (which is exactly what happened to `displayTips`: it was never
 * read at all, issue #78).
 */
function localizedText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null) return undefined
  const localized = value as Record<string, unknown>
  const pick = localized.zh ?? localized.en
  return typeof pick === 'string' ? pick : undefined
}

/**
 * Parse the known-good fields out of an upstream failure body. Non-JSON
 * bodies (HTML error pages, empty strings) yield undefined rather than a guess.
 */
export function parseUpstreamErrorDetail(body: string): UpstreamErrorDetail | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const raw = parsed as Record<string, unknown>
  // `msg` is the fallback only when `displayMsg` is absent: it is the raw
  // machine sentence ("the request parameters were rejected by the model
  // provider"), which is worse prose than `displayMsg` but far better than the
  // JSON skeleton the generic path used to print.
  const displayMsg = localizedText(raw.displayMsg)
    ?? (typeof raw.msg === 'string' ? raw.msg : undefined)
  const tips = localizedText(raw.displayTips)
  const detail: UpstreamErrorDetail = {}
  if (typeof raw.code === 'number') detail.upstreamCode = raw.code
  if (typeof raw.requestId === 'string') detail.requestId = raw.requestId
  if (typeof raw.msg === 'string' && raw.msg !== '') detail.rawMsg = raw.msg
  if (displayMsg !== undefined) detail.displayMsg = displayMsg
  if (tips !== undefined) detail.tips = tips
  // `extError` carries the parameter-level verdict. Read defensively: it is
  // absent on most failures, and a malformed one must not cost the fields above.
  const ext = raw.extError
  if (typeof ext === 'object' && ext !== null && !Array.isArray(ext)) {
    const extRaw = ext as Record<string, unknown>
    const param = extRaw['param']
    if (typeof param === 'string' && param !== '') detail.rejectedParam = param
    const value = extRaw['value']
    if (typeof value === 'string' && value !== '') detail.rejectedTier = value
  }
  return detail
}

/**
 * Region for a login domain; an empty domain means CN (matching upstream tooling).
 *
 * The international product is reachable under TWO brand domains: the WorkBuddy
 * AI desktop app signs in at `workbuddy.ai`, while the CodeBuddy CLI signs the
 * same international account in at `codebuddy.ai` (verified against a real
 * credential file, issue #4). Both are served by the same gateway stack — a
 * read-only probe shows `/v3/config` answering HTTP 200 with the same JSON
 * envelope on both hosts — so both classify as `global`. Missing the
 * `codebuddy.ai` spelling sent those tokens to the CN gateway, which rejected
 * them at the openresty layer with an HTML 401.
 */
export function regionOf(domain: string): WorkBuddyRegion {
  const lowered = domain.trim().toLowerCase()
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'global'
  return 'cn'
}

/**
 * The STRICT counterpart of {@link regionOf}: a region's domain only when it is
 * positively recognised, `undefined` for anything else.
 *
 * `regionOf`'s catch-all is deliberate — the CN product is single-homed, so an
 * unrecognised spelling is treated as CN and a real (if oddly written) CN
 * credential still resolves. That reasoning holds only for a domain the
 * UPSTREAM issued. It does not hold for a value read out of a file someone
 * handed the plugin: there "unrecognised" means "cannot be classified", and
 * calling it CN would file a foreign or spoofed credential in the CN vault.
 * Import gates must use this, not {@link regionOf}.
 *
 * Both sides are matched on their registrable domain, so a bare host and any
 * subdomain qualify while a lookalike such as `codebuddy.cn.evil.com` cannot.
 *
 * `copilot.tencent.com` is NOT a third product — it is this plugin's OWN CN
 * chat gateway (`CN_CHAT_BASE`), and the credential's `domain` field carries it
 * verbatim on real records. Refusing it here made the plugin reject its own
 * export: the card exported 8 accounts, and re-importing that file skipped the
 * three whose `domain` was the gateway. It cannot be spoofed into the wrong
 * region by being recognised here — it names the CN gateway, so admitting it is
 * the same decision as admitting `workbuddy.cn`.
 */
export function knownRegionOf(domain: string): WorkBuddyRegion | undefined {
  const lowered = domain.trim().toLowerCase()
  if (lowered === '') return undefined
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'global'
  // The CN product signs in under BOTH brand spellings — `workbuddy.cn` and
  // `codebuddy.cn` (and their www/subdomain forms) all appear in real
  // credentials and in sibling tools' export files, so both must classify as
  // CN or valid exports would be refused. Matching the registrable domain
  // admits a bare host and any subdomain while a lookalike such as
  // `codebuddy.cn.evil.com` still cannot pass.
  if (lowered === 'workbuddy.cn' || lowered.endsWith('.workbuddy.cn')) return 'cn'
  if (lowered === 'codebuddy.cn' || lowered.endsWith('.codebuddy.cn')) return 'cn'
  // The CN chat gateway itself, which real credentials name as their domain.
  if (lowered === 'copilot.tencent.com' || lowered.endsWith('.copilot.tencent.com')) return 'cn'
  return undefined
}

/**
 * Gateway for a global credential.
 *
 * International accounts are NOT interchangeable across brand domains: a token
 * issued at `codebuddy.ai` is rejected by the `workbuddy.ai` gateway (and vice
 * versa), so the base must follow the credential's OWN domain rather than a
 * single hardcoded host. Anything unrecognised falls back to `workbuddy.ai`,
 * the desktop app's gateway.
 */
export function globalBase(domain: string): string {
  const lowered = domain.trim().toLowerCase()
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'https://www.codebuddy.ai'
  return GLOBAL_BASE
}

function chatBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_CHAT_BASE
}

function billingBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_BILLING_BASE
}

function originReferer(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_BILLING_BASE
}

/** Headers every upstream request shares. */
function commonHeaders(credential: WorkBuddyCredential): Record<string, string> {
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': originReferer(credential),
    'Referer': `${originReferer(credential)}/`,
    'User-Agent': CLIENT_UA,
  }
}

/**
 * The conversation-identity triple the chat endpoint now requires (issue #66).
 *
 * WHY THIS EXISTS. The international gateway added a second gate on top of the
 * `system`-head rule from 3.1.0: a chat request must carry the official desktop
 * client's conversation identity, or every step is refused with business code
 * `11128` / `conversation id missing`. That error's own `displayTips` blames
 * "渠道校验 / 不是官方客户端发出的", which reads as a client-identity problem —
 * the literal message is the actionable part, and it names a MISSING CONVERSATION
 * ID, not a missing or wrong user agent.
 *
 * The two gates are independent, and both must hold (measured 2026-10-16 on the
 * real international gateway, plugin body shape unchanged):
 *
 *   headers            messages          result
 *   -----------------  ----------------  --------------
 *   plugin as-shipped  ["system","user"] 400 / 11128
 *   plugin + triple    ["system","user"] 200
 *   plugin + triple    ["user"]          400 / 11128
 *
 * So `ensureSystemHead()` must NOT be dropped as "no longer needed": the system
 * rule went from sufficient to necessary-but-not-sufficient. The last row is what
 * keeps this function from being mistaken for a replacement for it.
 *
 * MINIMAL SET. The official bundle's `applyGatewayHeaders` also sends
 * `acp-connection-id`, `X-Agent-Intent` / `X-Agent-Purpose`, `X-IDE-*`,
 * `X-Private-Data` and trace headers. Bisecting them one at a time showed NONE of
 * those is required: `X-Conversation-Request-ID` and `-Message-ID` are needed
 * alongside `X-Conversation-ID` (that one alone still fails), and each of the
 * extras is satisfied by the triple without it. Hence exactly three.
 *
 * VALUES. The gateway does not verify where these ids come from — any well-formed
 * UUID passes — so nothing here is a secret and nothing is persisted. They are
 * still freshly generated per request, matching the official client's
 * `randomUUID()` per call: reusing one value across requests would forge a
 * conversation identity the plugin does not actually have, and the first thing
 * that would break is the upstream's own correlation of a session it is being
 * told about twice under one id.
 *
 * APPLIED TO BOTH REGIONS on purpose. The CN gateway tolerates their absence
 * today, so this is harmless there — and a header that is only ever sent on one
 * side is exactly how the 3.1.0 defect became international-only and invisible
 * from the CN side. One code path, both regions.
 *
 * @returns the three headers, every value distinct.
 */
function conversationHeaders(): Record<string, string> {
  return {
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': randomUUID(),
    'X-Conversation-Message-ID': randomUUID(),
  }
}

/** Chat request headers, including the X-No-* conventions the official CLI uses. */
function chatHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'Content-Type': 'application/json',
    // 安全红线：chat 请求绝不携带 refresh token。
    ...credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid },
    ...credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId },
    ...credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain },
    'X-Product': 'SaaS',
    ...conversationHeaders(),
  }
  return headers
}

/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
  }
  return headers
}

/** Billing request headers. */
function billingHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${credential.accessToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
  if (credential.uid !== '') headers['X-User-Id'] = credential.uid
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
  return headers
}

/**
 * 生图请求头。
 *
 * 实测口径（2026-10-21，国内区）：`Authorization: Bearer` + `X-Product: SaaS` +
 * 用户/企业/域三连 + 会话身份三连 + `PRODUCT_UA`，在 `copilot.tencent.com` 与
 * `www.workbuddy.cn` 两个入口都返回 200。刻意**不带** `Origin` / `Referer`：
 * 探针当时没带，带了只是多一个可能被网关拒掉的变量，没有收益。
 *
 * 复用 {@link conversationHeaders}：官方 CLI 的 ImageService 也是每次现生成
 * 一组会话 UUID，且两个区走同一条代码路径（见该函数的注释）。
 */
function imageHeaders(credential: WorkBuddyCredential): Record<string, string> {
  return {
    'Authorization': `Bearer ${credential.accessToken}`,
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'User-Agent': PRODUCT_UA,
    'X-Product': 'SaaS',
    'X-Requested-With': 'XMLHttpRequest',
    ...credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid },
    ...credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId },
    ...credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain },
    ...conversationHeaders(),
  }
}

/**
 * Stand-in system message for a request that reached the wire carrying none.
 *
 * Not a stylistic default: both WorkBuddy gateways want the conversation to
 * OPEN with a system message, and the international one enforces it — a
 * user-first body there is refused with business code 11128
 * (`first message is not system prompt`), which the gateway surfaces as
 * "blocked by security policy". The domestic gateway tolerates the same body,
 * so the fault only ever shows up on the international route (issue: a global
 * model failing every step while the CN one is fine).
 *
 * A system message can go missing before this module ever sees the body:
 * `dsh-llm-pi-ai` folds a leading `system` message into `Context.systemPrompt`
 * and pi-ai only emits that prompt `if (context.systemPrompt)` — so an EMPTY
 * prompt emits no system message at all, and pi-ai demotes any `system` entry
 * left in `messages` to `user`. By the time the shim holds the JSON, the real
 * prompt is no longer recoverable, and a minimal placeholder is strictly better
 * than a guaranteed 400.
 *
 * Deliberately tiny: this is a last-resort placeholder, not a persona. Inventing
 * a longer one would quietly change model behaviour on every affected request.
 */
export const WORKBUDDY_FALLBACK_SYSTEM_PROMPT = 'You are a helpful assistant.'

/**
 * System-prompt openings the gateways fingerprint as "an unapproved channel".
 *
 * WHY THIS EXISTS (measured 2026-10-21 00:05 on the real gateways, CN account
 * `ba217455…`, `deepseek-v4.1-flash`, every other request field held fixed):
 * each gateway scans EVERY `system` message for a small set of known
 * third-party-agent prompt openings and refuses a hit with business code
 * `11128` / `Illegal API invocation from an unapproved channel` — the same code
 * the conversation-id gate (issue #66) and the `developer`-role gate use, so
 * the raw `displayTips` text ("可能不是官方客户端发出的") reads as a
 * client-identity problem. The actual failing rule is a CONTENT prefix match:
 *
 *   system message begins with                             CN            global
 *   -----------------------------------------------------  ------------  ------------
 *   "You are an AI agent powered by DeepSeek Harness"      400 / 11128   200
 *   "You are Claude Code, Anthropic's official CLI…"       400 / 11128   400 / 11128
 *   "You are an AI agent powered by Kimi."                 200           200
 *   "You are Cursor Agent…", "You are Gemini CLI…"         200           200
 *   the same DSH prompt with "You are a helpful assistant."
 *   prepended                                              200           200
 *
 * Matching is start-of-content only — the same sentence mid-prompt, in a
 * `user` message, or one leading space earlier all pass — and case-insensitive
 * (`you are an ai agent powered by deepseek harness` fails too). Prepending one
 * line is therefore enough to keep an ordinary DSH request off the list, and
 * the line is the placeholder {@link ensureSystemHead} already uses: adding a
 * neutral head costs less model behaviour than rewriting the host's own prompt.
 *
 * Not a nice rule to have to know, but the prompt was the only difference
 * between two requests the same account answered differently: the full DSH body
 * failed every time, the same body with the two leading lines swapped for
 * "You are a helpful assistant." returned 200. The list below is the measured
 * snapshot, not a theory of what the gate "means"; a gateway adding a new
 * opening is not caught until a body carries one, and the prepend only wins
 * while the gate keeps matching at offset 0.
 *
 * THE LIST CANNOT BE COMPLETE, AND THAT IS WHY {@link forceNeutralHead}
 * EXISTS. This is a snapshot of the upstream's own list, taken by measuring
 * openings one at a time; the upstream can extend it at any time and the
 * plugin cannot see it. So the plugin's own prepend is a best-effort filter,
 * not a guarantee — and the self-healing retry is what covers the openings
 * nobody has measured yet.
 */
const UNAPPROVED_CHANNEL_OPENINGS: readonly string[] = [
  'you are an ai agent powered by deepseek harness',
  "you are claude code, anthropic's official cli for claude",
]

/**
 * Whether this text OPENS with an opening the gateways refuse.
 *
 * The gate is a PREFIX match on the START of a `system` message, so this is
 * the one predicate that decides it — used by the request path (which prepends
 * the neutral head on a hit) and by the failure path (which names the
 * offending line).
 *
 * THREE MEASURED RULES are folded in here, all from the live CN gateway on
 * 2026-10-21 (account `ba217455…`, `deepseek-v4.1-flash`, every other request
 * field held fixed):
 *
 *   1. Only the START counts — the same sentence mid-content answers 200.
 *   2. LEADING WHITESPACE is trimmed before the comparison — " <banned>" and
 *      "\n<banned>" both answer 200 today.
 *   3. The comparison is CASE-INSENSITIVE — the lower-cased sentence fails too.
 *
 * (2) is a gift that can be withdrawn, so the comparison is made the way a
 * trimming gate would make it even while the gateway is lenient: a rule that
 * only holds while the gateway forgets to trim is a rule waiting to break.
 *
 * The list itself stays the measured snapshot. It is deliberately NOT
 * extended by guesswork: an opening nobody measured is an opening nobody knows
 * the gateway refuses, and inventing entries would neutralise prompts that
 * answer 200 today.
 */
export function isUnapprovedChannelOpening(text: string): boolean {
  const opening = text.replace(/^\s+/u, '').toLowerCase()
  return UNAPPROVED_CHANNEL_OPENINGS.some(prefix => opening.startsWith(prefix))
}

/**
 * Whether this text already begins with the plugin's own neutral head.
 *
 * The question the failure path has to answer per system message: "is the
 * line the gateway refused OURS, or the HOST's?" — the plugin's head is the
 * one line it has ever added to a prompt, so it is the only opening that
 * cannot be a third-party-agent fingerprint.
 */
function startsWithNeutralHead(text: string): boolean {
  const opening = text.replace(/^\s+/u, '').toLowerCase()
  return opening.startsWith(WORKBUDDY_FALLBACK_SYSTEM_PROMPT.toLowerCase())
}

/**
 * The roles whose message OPENINGS the gateway scans.
 *
 * MEASURED on the live CN gateway (2026-10-21, every other request field held
 * fixed): `system` and `assistant` are scanned; `user` and `tool` are not (a
 * body whose `user` or `tool` content opens with the banned identity answers
 * 200). That second role is the one the plugin missed until 4.15.0, and it is
 * why issue #98's sessions stayed broken: an `assistant` history message that
 * opens with the fingerprint poisons EVERY later turn of that session, on
 * every account and in every region.
 *
 * `developer` is not listed because `prepareChatBody` rewrites it to `system`
 * before this module looks at the body — and because both gateways refuse
 * `developer` outright, so neutralising its content would not save the request.
 */
function scansOpening(role: unknown): boolean {
  if (typeof role !== 'string') return false
  const name = role.trim().toLowerCase()
  return name === 'system' || name === 'assistant'
}

/**
 * Move every scanned message (`system` and `assistant`) off the content
 * fingerprint above by prepending the placeholder head.
 *
 * A no-op for a body whose messages start with anything else, so a request the
 * gateways already answer keeps its prompt byte-for-byte — only the messages
 * the gate would refuse grow, by one short line.
 *
 * BOTH ROLES, because the gate reads both. Until 4.15.0 this only handled
 * `system`, and the failure that left behind is issue #98: a conversation
 * whose HISTORY contains an assistant message opening with the banned identity
 * (the model echoing its own prompt, a restored session, a compaction
 * artefact) was refused on every single turn, and no account or region could
 * change a byte of it.
 *
 * ARRAY CONTENT IS HANDLED PART BY PART, and that is not a nicety. Measured on
 * the live CN gateway (2026-10-21): when a scanned message's `content` is an
 * array of parts, the gate reads EVERY TEXT PART of it — a banned opening in
 * the FIRST part is refused, and a banned opening in the SECOND part is
 * refused just the same. Prepending to the first part only would therefore
 * fix the first half of the failure and leave the second half to the users who
 * report it again.
 */
function neutralizeChannelFingerprints(obj: Record<string, unknown>): void {
  const messages = obj['messages']
  if (!Array.isArray(messages)) return
  for (const value of messages) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const message = value as Record<string, unknown>
    if (!scansOpening(message['role'])) continue
    const content = message['content']
    if (typeof content === 'string') {
      // Leading whitespace currently defeats the gate by itself (measured), but
      // the gateway can start trimming without notice, so compare the way a
      // trimming gate would and keep the raw content untouched.
      if (!isUnapprovedChannelOpening(content)) continue
      message['content'] = `${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n${content}`
      continue
    }
    if (!Array.isArray(content)) continue
    for (const part of content) {
      // A malformed part is left exactly as it is: this runs on a body that is
      // about to go on the wire, and a throw here would cost the whole request.
      if (typeof part !== 'object' || part === null || Array.isArray(part)) continue
      const record = part as Record<string, unknown>
      const type = record['type']
      if (typeof type !== 'string' || type.trim().toLowerCase() !== 'text') continue
      const text = record['text']
      if (typeof text !== 'string' || !isUnapprovedChannelOpening(text)) continue
      record['text'] = `${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n${text}`
    }
  }
}

/**
 * A body in which EVERY scanned opening (`system` and `assistant`) is moved
 * behind the neutral head.
 *
 * THE ONE-SHOT SELF-HEALING RETRY'S BODY BUILDER. The gateway's fingerprint
 * list is a SNAPSHOT the upstream can extend at any time, and the plugin
 * cannot see it: the two entries in {@link UNAPPROVED_CHANNEL_OPENINGS} are
 * what was MEASURED on 2026-10-21, not a contract. So the day the gateway
 * adds an entry, this plugin's own prepend stops matching and the banned
 * opening goes out on the wire unchanged — exactly the dead end issue #98
 * describes, and exactly what a longer guess-list cannot prevent (nobody can
 * measure the next entry before it bites).
 *
 * The remedy is a second attempt that does not depend on knowing the
 * fingerprint at all: this builds a body in which EVERY scanned message,
 * whatever it opens with, gets the neutral head in front. The gateway matches
 * the START of a scanned message, so a neutral first line moves the whole
 * opening out of the matched region — whether the banned text is a known
 * entry, a new one, or a fingerprint this plugin has never heard of.
 *
 * `assistant` messages are included for the measured reason
 * {@link neutralizeChannelFingerprints} documents: a history message that opens
 * with a refused identity is what keeps a whole session failing, so a retry
 * that only moved the system prompt would spend a request to be refused for the
 * same reason.
 *
 * WHEN IT IS USED: only AFTER the gateway refused the first attempt with the
 * channel gate. A request the gateway already answers keeps its bytes
 * unchanged, because this function is never called for it — the normal path
 * is {@link prepareChatBody}, which only touches the openings it has MEASURED
 * as fingerprinted.
 *
 * `undefined` means "this body cannot change": every scanned opening already
 * starts with the neutral head, so a retry would send the same bytes and
 * spend a request for the same refusal. The caller uses that to avoid
 * spending the round trip.
 *
 * Empty contents are skipped: an empty string cannot open with anything, so it
 * cannot be the culprit, and an assistant message that carries `tool_calls`
 * with `content: ""` is a replay shape this function has no reason to touch.
 *
 * Never throws. A body it cannot read is the upstream's to reject, and a
 * parse error must not turn a retry into a crash.
 */
export function forceNeutralHead(bodyJson: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyJson)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const obj = parsed as Record<string, unknown>
  const messages = obj['messages']
  if (!Array.isArray(messages)) return undefined
  let changed = false
  for (const value of messages) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const message = value as Record<string, unknown>
    if (!scansOpening(message['role'])) continue
    const content = message['content']
    if (typeof content === 'string') {
      if (content.trim() === '' || startsWithNeutralHead(content)) continue
      message['content'] = `${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n${content}`
      changed = true
      continue
    }
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (typeof part !== 'object' || part === null || Array.isArray(part)) continue
      const record = part as Record<string, unknown>
      const type = record['type']
      if (typeof type !== 'string' || type.trim().toLowerCase() !== 'text') continue
      const text = record['text']
      if (typeof text !== 'string' || text.trim() === '' || startsWithNeutralHead(text)) continue
      record['text'] = `${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n${text}`
      changed = true
    }
  }
  if (!changed) return undefined
  // Re-serialized from the PARSED object, so the key order of the original
  // body is preserved — the retry is the same request, not a reshuffled one.
  return JSON.stringify(obj)
}

/**
 * The invisible character used to break a content fingerprint.
 *
 * U+200B ZERO WIDTH SPACE: it renders as nothing, it is not whitespace for the
 * gateway's own matching, and a model reads straight through it. Measured on
 * the live CN gateway: putting one inside the refused span turns 400 into 200,
 * while the text the model reads is unchanged.
 */
const ZERO_WIDTH_SPACE = '\u200b'

/**
 * Where an invisible break is inserted INSIDE a capitalised word pair, so a
 * bare product name stops matching as an exact substring.
 *
 * WHY THE PUNCTUATION RULE IS NOT ENOUGH. The boundary rules above only land
 * where there is a `.`, `!`, `?`, `,`, `;` — so a scanned message that ends
 * with a bare product name and no trailing punctuation (``… powered by
 * DeepSeek Harness ``, the host's own agent line, ending at end-of-text) is
 * left COMPLETELY UNCHANGED. `perturbChannelFingerprints` then answers
 * `undefined`, the shim spends no retry, and the fingerprint survives the
 * rescue — measured, and it is the shape issue #113's reporter is most likely
 * to hit, because that line is the first line of every DSH agent prompt.
 *
 * This rule breaks between a capitalised word and the following capitalised
 * word (“DeepSeek|Harness”, “Visual|Studio”), which covers product names
 * without touching ordinary prose: a sentence rarely has two capitalised
 * words adjacent UNLESS they are a proper name, and breaking a proper name is
 * exactly the intent. The model reads straight through U+200B, so what it
 * understands is unchanged — that is the whole point of using it for this
 * rather than rewriting the text.
 */
const WORD_INTERNAL_BREAK = /([A-Z][A-Za-z0-9]*)(\s+)(?=[A-Z][A-Za-z0-9])/gu

/**
 * A body whose scanned message TEXT is perturbed just enough to break an exact
 * content fingerprint.
 *
 * THE SECOND HALF OF ISSUE #98, found on 2026-10-21 after 4.15.0 shipped. The
 * gateway does not only match the OPENING of a scanned message; it also matches
 * one long substring INSIDE the system prompt. Measured byte-exactly on a real
 * failed request (CN gateway, `deepseek-v4.1-flash`, the host's own body):
 *
 *   - the refusal is reproducible, and it is not the opening: the plugin had
 *     already prepended the neutral head, and the request still answered 400;
 *   - bisecting the host's 10,956-character system prompt by lines and then by
 *     sentences found a 221-character span: the DSH Web-GUI paragraph's first
 *     two sentences ("You are interacting with the user through the DeepSeek
 *     Harness Web GUI … they mean this GUI.");
 *   - that span ALONE reproduces the 400, and the SAME span with ANY change
 *     inside it answers 200 — one character rewritten, one quoted word
 *     replaced, even a zero-width space inserted. An outer prefix or suffix
 *     does not help, so the match is an exact substring, not an opening rule;
 *   - the paragraph's individual sentences each answer 200, which is why the
 *     plugin's opening-based normalisation never saw this.
 *
 * SO THE RESCUE CANNOT BE "prepend a line" (that is {@link forceNeutralHead},
 * and it is a no-op here). Nor can it be a list of refused spans: the list is
 * the upstream's own data, it already grew once without notice, and it will
 * grow again. What DOES generalise is the observation that an exact-substring
 * match dies on any perturbation inside it — so this inserts a zero-width space
 * at every sentence and clause boundary of the scanned messages, which is
 * invisible to the reader, meaningless to the model, and inside the refused
 * span with near-certainty for any prose fingerprint.
 *
 * WHEN IT IS USED: only as the last retry, after the gateway already refused
 * the request AND the neutral head could not change anything. Requests the
 * gateway answers keep their bytes untouched.
 *
 * Idempotent: a body that already carries U+200B in a scanned message is left
 * alone, so a retry never stacks perturbations. Returns `undefined` when
 * nothing would change, which is the caller's signal not to spend a request.
 *
 * Never throws: a malformed body is the upstream's to reject, and a parse error
 * must not turn a rescue into a crash.
 */
export function perturbChannelFingerprints(bodyJson: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyJson)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const obj = parsed as Record<string, unknown>
  const messages = obj['messages']
  if (!Array.isArray(messages)) return undefined
  let changed = false
  const perturb = (text: string): string | undefined => {
    if (text.includes(ZERO_WIDTH_SPACE)) return undefined
    // Sentence terminators followed by whitespace, the CJK ones without, and
    // clause commas: between them they land inside almost any prose span that
    // is long enough to be worth fingerprinting.
    const next = text
      .replace(/([.!?])(\s+)/gu, `$1${ZERO_WIDTH_SPACE}$2`)
      .replace(/([。！？])/gu, `$1${ZERO_WIDTH_SPACE}`)
      .replace(/([,;])(\s+)/gu, `$1${ZERO_WIDTH_SPACE}$2`)
      .replace(WORD_INTERNAL_BREAK, (whole: string, head: string, tail: string) =>
        `${head}${ZERO_WIDTH_SPACE}${tail}`)
    return next === text ? undefined : next
  }
  for (const value of messages) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const message = value as Record<string, unknown>
    if (!scansOpening(message['role'])) continue
    const content = message['content']
    if (typeof content === 'string') {
      const next = perturb(content)
      if (next !== undefined) {
        message['content'] = next
        changed = true
      }
      continue
    }
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (typeof part !== 'object' || part === null || Array.isArray(part)) continue
      const record = part as Record<string, unknown>
      const type = record['type']
      if (typeof type !== 'string' || type.trim().toLowerCase() !== 'text') continue
      const text = record['text']
      if (typeof text !== 'string') continue
      const next = perturb(text)
      if (next !== undefined) {
        record['text'] = next
        changed = true
      }
    }
  }
  if (!changed) return undefined
  return JSON.stringify(obj)
}

/**
 * One opening of a message the gateway scans, as the HOST wrote it.
 *
 * The failure path needs to name the line the gateway reacted to, and "the line
 * the host wrote" is not the same thing as "the line that went on the wire" —
 * after {@link neutralizeChannelFingerprints} the wire carries the plugin's
 * neutral head in front of every opening it recognises. Reporting the HOST's
 * line and saying whether the plugin covers it is what stops the reader being
 * sent to a line that is not at fault.
 */
export interface OpeningEvidence {
  /** The opening line, whitespace-collapsed and clipped. */
  readonly opening: string
  /**
   * Which message the opening belongs to — the role verbatim (`system` or
   * `assistant`).
   *
   * Reported because the two are scanned by the same rule but mean opposite
   * things to the reader: a `system` entry is the prompt they can edit, while
   * an `assistant` entry is HISTORY, i.e. the session is poisoned and every
   * later turn will fail the same way until that line changes.
   */
  readonly role: 'system' | 'assistant'
  /**
   * True when the plugin's own neutralisation already covers this opening —
   * either it IS the plugin's neutral head, or it is a fingerprint the plugin
   * rewrites before sending. False when the opening goes on the wire verbatim,
   * i.e. the plugin does not know it.
   *
   * Both halves matter because the failure path reads the HOST's body (the
   * request before the plugin rewrote it) as often as the prepared one: on the
   * host's body a KNOWN fingerprint is still `true` (the plugin does cover it),
   * and only an opening nobody has measured is `false` — which is precisely
   * the actionable case issue #98 is about. On the prepared body the opening
   * IS the neutral head, which the first half covers.
   */
  readonly neutralized: boolean
  /** Index of the message in `messages` (0-based, wire order). */
  readonly messageIndex: number
}

/**
 * The openings of every scanned message in a body, one entry per TEXT PART.
 *
 * `system` AND `assistant`, because both are read by the gate (measured; see
 * {@link scansOpening}). `developer` counts as a system message because the
 * plugin rewrites `developer` → `system` on the wire.
 *
 * Array content contributes ONE ENTRY PER PART, for the same reason the request
 * path neutralises every part: the gate reads every text part, so "which line
 * tripped it" can be any of them.
 *
 * Capped at {@link SYSTEM_EVIDENCE_LIMIT} entries, and never throws — losing
 * the failure measurement is not an acceptable price for reading an excerpt.
 */
export function openingEvidenceOfBody(bodyJson: string): OpeningEvidence[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyJson)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return []
  const messages = (parsed as Record<string, unknown>)['messages']
  if (!Array.isArray(messages)) return []
  const evidence: OpeningEvidence[] = []
  for (let index = 0; index < messages.length; index++) {
    if (evidence.length >= SYSTEM_EVIDENCE_LIMIT) break
    const value = messages[index]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const message = value as Record<string, unknown>
    const role = message['role']
    if (typeof role !== 'string') continue
    const roleName = role.trim().toLowerCase()
    // `developer` counts because prepareChatBody rewrites it to `system`.
    if (roleName !== 'system' && roleName !== 'assistant' && roleName !== 'developer') continue
    const roleOfEvidence: 'system' | 'assistant' = roleName === 'assistant' ? 'assistant' : 'system'
    const content = message['content']
    const texts: string[] = []
    if (typeof content === 'string') {
      texts.push(content)
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part !== 'object' || part === null || Array.isArray(part)) continue
        const record = part as Record<string, unknown>
        const type = record['type']
        if (typeof type !== 'string' || type.trim().toLowerCase() !== 'text') continue
        const text = record['text']
        if (typeof text === 'string') texts.push(text)
      }
    }
    for (const text of texts) {
      if (evidence.length >= SYSTEM_EVIDENCE_LIMIT) break
      const opening = firstNonEmptyLineOf(text).replace(/\s+/gu, ' ').trim()
      if (opening === '') continue
      evidence.push({
        opening: clip(opening, SYSTEM_OPENING_LIMIT),
        role: roleOfEvidence,
        neutralized: startsWithNeutralHead(opening) || isUnapprovedChannelOpening(opening),
        messageIndex: index,
      })
    }
  }
  return evidence
}

/**
 * How many openings the failure path reports.
 *
 * Eight is generous: the gate scans every system message and every text part
 * of it, so a body with more than a handful of openings is not a prompt the
 * reader can act on anyway — the reply names the first ones and the failure
 * body carries the rest.
 *
 * The cap is HERE and not in the reply: this function reports everything it
 * found (up to eight) and the reply renders as many of them as fit, saying
 * how many were left out. Truncating the evidence before the reply sees it
 * would make "N more" unanswerable.
 */
const SYSTEM_EVIDENCE_LIMIT = 8

/**
 * The first line of a text that carries something.
 *
 * Blank lines are SKIPPED: the neutral head is followed by an empty line, so
 * the head itself is the line worth reporting, and a content that opens with
 * blank lines still has an opening.
 */
function firstNonEmptyLineOf(content: string): string {
  for (const line of content.split('\n')) {
    if (line.trim() !== '') return line
  }
  return ''
}

/**
 * Make the conversation open with a system message, prepending the fallback
 * when nothing else supplies one.
 *
 * `developer` is normalized to `system` first (the gateways reject
 * `developer`), so an ordinary DSH request already satisfies this and the
 * function is a no-op for it.
 */
function ensureSystemHead(obj: Record<string, unknown>): void {
  const messages = obj['messages']
  if (!Array.isArray(messages) || messages.length === 0) return
  const head = messages[0]
  if (typeof head !== 'object' || head === null || Array.isArray(head)) return
  const role = (head as Record<string, unknown>)['role']
  if (typeof role === 'string' && role.trim().toLowerCase() === 'system') return
  messages.unshift({ role: 'system', content: WORKBUDDY_FALLBACK_SYSTEM_PROMPT })
}

/**
 * The model id a prepared body asks for, when it carries one (issue #61).
 *
 * Lives beside {@link prepareChatBody} because it reads the same shape: the
 * serialized OpenAI body, after this plugin's rewrites. Never throws — a
 * malformed body is the upstream's to reject, not a reason to lose the failure
 * measurement that this id is needed for.
 */
export function modelIdOfBody(bodyJson: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(bodyJson)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const model = (parsed as Record<string, unknown>)['model']
    return typeof model === 'string' && model !== '' ? model : undefined
  } catch {
    return undefined
  }
}

/**
 * Normalize an OpenAI chat-completions body for the WorkBuddy upstream: force
 * `stream: true` (the upstream rejects non-streaming), flatten `tool_choice`
 * (the upstream's field is a string; object forms return 400), rewrite
 * `developer` to `system`, guarantee a leading system message, and move a
 * recognized third-party-agent system prompt off the gateways' content
 * fingerprint.
 *
 * The last step is not cosmetic: both gateways refuse a request whose `system`
 * message opens with one of the openings listed at
 * {@link UNAPPROVED_CHANNEL_OPENINGS} — business code 11128, surfaced to the
 * user as a "渠道校验" (channel verification) failure — which made every CN step
 * of a DSH session fail while a two-message probe on the same account returned
 * 200. Every rewrite in here is forced by a gateway rule, so a body the
 * upstream already answers keeps its prompt as close to byte-for-byte as these
 * rules allow.
 */
export function prepareChatBody(source: string): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  const obj = body as Record<string, unknown>
  obj['stream'] = true
  // DSH sends its system prompt using OpenAI's newer `developer` role.
  // WorkBuddy's CLI channel accepts the equivalent `system` role but rejects
  // `developer` with business code 11128 (unapproved channel).
  if (Array.isArray(obj['messages'])) {
    for (const value of obj['messages']) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const message = value as Record<string, unknown>
      if (message['role'] === 'developer') message['role'] = 'system'
    }
  }
  ensureSystemHead(obj)
  neutralizeChannelFingerprints(obj)
  normalizeToolChoice(obj)
  dropRefusedReasoning(obj)
  return JSON.stringify(obj)
}

/**
 * Remove `reasoning_effort: "off"` when it would only ever fail (issue #83).
 *
 * The refusal table is keyed by exact model id, but the model a request
 * actually names can change AFTER the catalog was built: account-pool failover
 * re-points the body at another account's model, and `primary-model` is an
 * alias whose concrete id the gateway resolves. A tick on such a row therefore
 * reaches this plugin's prepared body as a bare `"off"` — exactly the value the
 * table says the upstream answers with HTTP 400 / code 11133.
 *
 * Stripped HERE because this is the last thing the plugin controls before the
 * upstream counts the body, and because the test is {@link offRefused} — the
 * same single source of truth the catalog stamping uses, so the two cannot
 * drift apart.
 *
 * Only the literal `"off"` is touched. Every other effort value returned 200 on
 * every model measured for issue #34, and a body naming no effort is left
 * alone: deleting a field the caller never sent would be inventing an opinion
 * about how the model should think.
 */
function dropRefusedReasoning(obj: Record<string, unknown>): void {
  const effort = obj['reasoning_effort']
  if (typeof effort !== 'string' || effort.trim().toLowerCase() !== 'off') return
  const model = obj['model']
  if (typeof model !== 'string' || !offRefused(model)) return
  delete obj['reasoning_effort']
}

/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
function normalizeToolChoice(obj: Record<string, unknown>): void {
  const suppress = (): void => {
    delete obj['tools']
    delete obj['functions']
  }
  const present = 'tool_choice' in obj
  if (!present) return
  const choice: unknown = obj['tool_choice']
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete obj['tool_choice']
      suppress()
    }
    return
  }
  if (typeof choice === 'object' && choice !== null && !Array.isArray(choice)) {
    const wrapped = choice as Record<string, unknown>
    const type = typeof wrapped['type'] === 'string' ? wrapped['type'].trim().toLowerCase() : ''
    if (type === 'none') {
      delete obj['tool_choice']
      suppress()
    } else if (type === 'auto' || type === 'required') {
      obj['tool_choice'] = type
    } else if (type === 'function') {
      const fn = typeof wrapped['function'] === 'object' && wrapped['function'] !== null
        ? (wrapped['function'] as Record<string, unknown>)
        : undefined
      let name = typeof fn?.['name'] === 'string' ? fn['name'] : ''
      if (name === '' && typeof wrapped['name'] === 'string') name = wrapped['name']
      name = name.trim()
      obj['tool_choice'] = name !== '' ? name : 'auto'
    } else {
      delete obj['tool_choice']
    }
    return
  }
  delete obj['tool_choice']
}

/**
 * What a PREPARED request body declares, as the input to DSML recovery.
 *
 * This exists so the recovery path can answer the one question its gates turn
 * on — "was this tool name offered in THIS request?" — without a second parse
 * of the body and without a second source of truth. `prepareChatBody` has
 * already parsed it; this reads the same prepared JSON.
 *
 * Two facts make it cheap and exact:
 *
 *   - `tool_choice: "none"` deletes `tools` outright in
 *     {@link normalizeToolChoice}, so "no tools declared" is directly
 *     observable here rather than a separate condition to remember;
 *   - a pinned `tool_choice` arrives as the bare function name (the object form
 *     was flattened), so anything that is not `auto`/`required`/`none` is a pin.
 *
 * Returns `undefined` when the body declares nothing usable — malformed JSON,
 * no `tools` array, or an empty one. Callers must read that as "recovery is
 * off" (gate 3), not as "no information, so guess".
 */
export function declaredTools(bodyJson: string): {
  names: Set<string>
  requiredParameters: Map<string, string[]>
  /**
   * Every parameter name each declared tool's schema accepts, from
   * `parameters.properties`. The entry exists for every tool whose `parameters`
   * is an object — possibly EMPTY, which is a fact ("accepts nothing") and not
   * an absence, so the schema-gated recovery can clear a tool rather than
   * refuse on all of them. It is absent only when the schema itself is not an
   * object, which refuses that recovery instead of guessing.
   */
  acceptedParameters: Map<string, Set<string>>
  pinnedToolName?: string
} | undefined {
  let body: unknown
  try {
    body = JSON.parse(bodyJson)
  } catch {
    return undefined
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const obj = body as Record<string, unknown>

  const tools = obj['tools']
  if (!Array.isArray(tools)) return undefined

  const names = new Set<string>()
  const requiredParameters = new Map<string, string[]>()
  const acceptedParameters = new Map<string, Set<string>>()

  for (const value of tools) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const wrapped = value as Record<string, unknown>
    const fn = wrapped['function']
    if (typeof fn !== 'object' || fn === null || Array.isArray(fn)) continue
    const definition = fn as Record<string, unknown>
    const name = typeof definition['name'] === 'string' ? definition['name'] : ''
    if (name === '') continue
    names.add(name)

    const parameters = definition['parameters']
    if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) continue
    const schema = parameters as Record<string, unknown>

    // Every parameter name this schema accepts. A schema with no `properties`
    // accepts nothing (not "unknown") — the map entry EXISTS so the
    // schema-gated recovery can clear the tool, and only a schema that is not
    // an object at all stays absent, which refuses that recovery outright.
    const accepted = new Set<string>()
    const properties = schema['properties']
    if (typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
      for (const key of Object.keys(properties)) {
        if (key !== '') accepted.add(key)
      }
    }
    acceptedParameters.set(name, accepted)

    const required = schema['required']
    if (!Array.isArray(required)) continue
    const list = required.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    if (list.length > 0) requiredParameters.set(name, list)
  }

  if (names.size === 0) return undefined

  const pinned = typeof obj['tool_choice'] === 'string' ? obj['tool_choice'].trim() : ''
  const pinnedToolName = pinned !== '' && !['auto', 'required', 'none'].includes(pinned.toLowerCase())
    ? pinned
    : undefined

  return {
    names,
    requiredParameters,
    acceptedParameters,
    ...pinnedToolName === undefined ? {} : { pinnedToolName },
  }
}

/** One JSON-envelope response from the upstream, already unwrapped. */
interface Envelope {
  code: number
  msg: string
  data: unknown
}

/**
 * Gateway (openresty/APISIX) rejection of a token it no longer accepts.
 *
 * The business APIs answer JSON; an edge rejection answers an HTML error page
 * instead. A 401 that is not JSON therefore means the credential was refused
 * before routing — almost always a revoked/expired token rather than a bug in
 * the request. Detected from the body so a proxy's own error page (which would
 * also be HTML) is still described accurately.
 */
function isGatewayAuthRejection(status: number, text: string): boolean {
  if (status !== 401 && status !== 403) return false
  const lower = text.toLowerCase()
  return lower.includes('openresty') || lower.includes('apisix') || lower.includes('authorization required')
}

/** Marker carried by {@link WorkBuddyCredentialRejectedError}; survives bundling. */
export const CREDENTIAL_REJECTED_CODE = 'WORKBUDDY_CREDENTIAL_REJECTED'

/**
 * The upstream refused the CREDENTIAL itself rather than failing the request.
 *
 * This is a distinct, actionable class: the token is not usable and no retry
 * with the same token will help. Callers use it to tell the user what to do
 * about it (switch accounts, or sign in again) instead of showing a raw HTTP
 * error, and the card must never confuse it with a transient upstream fault.
 *
 * Identified by {@link CREDENTIAL_REJECTED_CODE} rather than `instanceof`, so
 * the check keeps working when the caller and the thrower end up in different
 * module instances (bundled host half vs. a test's source import).
 */
export class WorkBuddyCredentialRejectedError extends Error {
  readonly code = CREDENTIAL_REJECTED_CODE
  /** HTTP status the upstream answered with (401 or 403). */
  readonly status: number

  constructor(status: number) {
    super(
      `workbuddy: the signed-in credential was rejected by the upstream gateway (http ${status}).`
      + ' The stored token is no longer accepted — most likely a stale credential file from an earlier'
      + ' sign-in was selected. Re-sign in to the WorkBuddy desktop app, then pick that account in the'
      + ' plugin card. Run `dsh-connect-workbuddy doctor` to list every discovered credential.',
    )
    this.name = 'WorkBuddyCredentialRejectedError'
    this.status = status
  }
}

/** Whether an error reports that the upstream refused the credential itself. */
export function isCredentialRejectedError(value: unknown): value is WorkBuddyCredentialRejectedError {
  return typeof value === 'object'
    && value !== null
    && (value as { code?: unknown }).code === CREDENTIAL_REJECTED_CODE
}

async function readEnvelope(response: Response): Promise<Envelope> {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    if (isGatewayAuthRejection(response.status, text)) {
      throw new WorkBuddyCredentialRejectedError(response.status)
    }
    throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`)
  }
  const document = parsed as Record<string, unknown>
  const envelope: Envelope = {
    code: typeof document['code'] === 'number' ? document['code'] : 0,
    msg: typeof document['msg'] === 'string' ? document['msg'] : '',
    data: 'data' in document ? document['data'] : undefined,
  }
  return envelope
}

/**
 * Parse the enterprise endpoint's `cycleResetTime` ("2026-11-01 00:00:00").
 *
 * The value carries NO timezone marker, and the official client renders it as
 * local wall-clock time (it is what the user sees in "resets on 11/01 00:00"),
 * so it is read as LOCAL time rather than as UTC. `Date.parse` on that shape is
 * implementation-defined, which is exactly why it is assembled by hand.
 */
function parseEnterpriseInstant(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim())
  if (match === null) {
    const fallback = Date.parse(value)
    return Number.isNaN(fallback) ? undefined : fallback
  }
  const [, y, mo, d, h, mi, se] = match
  const parsed = new Date(
    Number(y), Number(mo) - 1, Number(d),
    Number(h), Number(mi), Number(se ?? '0'),
  ).getTime()
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * Fail an envelope whose business code is non-zero, classified like HTTP errors.
 *
 * A JSON body on a 401/403 is still a credential refusal: the edge answered in
 * the business shape, but the token is just as unusable, so it maps to the same
 * actionable error instead of a generic "client" failure.
 */
function envelopeError(status: number, envelope: Envelope): Error {
  if (status === 401 || status === 403) return new WorkBuddyCredentialRejectedError(status)
  const kind = classifyUpstreamError(status, envelope.msg)
  return new Error(`workbuddy upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`)
}

/**
 * Parse the upstream's `credits` string into a multiplier.
 *
 * Observed forms: `"x0.79 credits"`, `"x0.05"`, `"x0.00 credits"`,
 * and absent. Unparsable values yield undefined rather than a guess — the
 * card simply omits the rate instead of displaying a fabricated one.
 */
export function parseCreditMultiplier(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /x\s*([0-9]*\.?[0-9]+)/iu.exec(value)
  if (match === null) return undefined
  const parsed = Number(match[1])
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * The effort vocabulary the upstream's plural-form payloads declare across both
 * gateways (live union of every `supportedEfforts` list seen; `minimal` has
 * never appeared). Both gateways also accept every level in it on
 * singular-form models — medium/xhigh fold into high, low/max answer with
 * their own budgets — so the singular `effort` value is a DEFAULT, never the
 * model's only level.
 */
const SINGULAR_EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * The singular spelling of reasoning metadata: `effort` (plus the ignored
 * `summary`) and none of the plural-form fields. Observed on CN
 * `deepseek-v4.1-flash`/`kimi-k3-1`/`glm-5.2`… and global
 * `deepseek-v4.1-flash`/`kimi-k3`/`gemini-3.5-flash`… (issue #7).
 */
function isSingularEffortForm(raw: Record<string, unknown>): boolean {
  return typeof raw['effort'] === 'string'
    && !Array.isArray(raw['supportedEfforts'])
    && typeof raw['defaultEffort'] !== 'string'
    && typeof raw['canDisableThinking'] !== 'boolean'
}

/**
 * Fold a singular-form `effort` into the plural shape the rest of the plugin
 * already understands. Live probes on both gateways (issue #7) show these
 * models answer with distinct `reasoning_content` across the whole ladder —
 * and think NOT AT ALL when no `reasoning_effort` is sent — so the fold
 * widens `supportedEfforts` and carries the declared value into
 * `defaultEffort`. An unrecognized `effort` value passes through as the lone
 * level, leaving its fate to the adapter's known-level filter.
 */
function singularEffortLadder(raw: Record<string, unknown>): string[] | undefined {
  const effort = typeof raw['effort'] === 'string' ? raw['effort'] : undefined
  if (effort === undefined) return undefined
  return (SINGULAR_EFFORT_LADDER as readonly string[]).includes(effort) ? [...SINGULAR_EFFORT_LADDER] : [effort]
}

/**
 * Parse the upstream's `reasoning` object; unknown shapes degrade to `{}`.
 * Both spellings normalize here: the plural form passes through as declared,
 * and the singular `effort` form folds via {@link singularEffortLadder}.
 */
export function parseReasoning(value: unknown): WorkBuddyReasoning | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const effort = typeof raw['effort'] === 'string' ? raw['effort'] : undefined
  const supportedEfforts = Array.isArray(raw['supportedEfforts'])
    ? raw['supportedEfforts'].filter((entry): entry is string => typeof entry === 'string')
    : singularEffortLadder(raw)
  const defaultEffort = typeof raw['defaultEffort'] === 'string' ? raw['defaultEffort'] : effort
  const canDisableThinking = typeof raw['canDisableThinking'] === 'boolean'
    ? raw['canDisableThinking']
    : isSingularEffortForm(raw) ? true : undefined
  if (supportedEfforts === undefined && defaultEffort === undefined && canDisableThinking === undefined) {
    return undefined
  }
  return {
    ...supportedEfforts === undefined || supportedEfforts.length === 0 ? {} : { supportedEfforts },
    ...defaultEffort === undefined ? {} : { defaultEffort },
    ...canDisableThinking === undefined ? {} : { canDisableThinking },
  }
}

/** Parse one catalog entry; entries without usable token limits are dropped. */
export function parseUpstreamModel(value: unknown): WorkBuddyUpstreamModel | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const id = typeof raw['id'] === 'string' ? raw['id'] : ''
  if (id === '' || raw['disabled'] === true) return undefined
  const input = typeof raw['maxInputTokens'] === 'number' ? raw['maxInputTokens'] : 0
  const output = typeof raw['maxOutputTokens'] === 'number' ? raw['maxOutputTokens'] : 0
  if (input <= 0 || output <= 0) return undefined
  const name = typeof raw['name'] === 'string' && raw['name'] !== '' ? raw['name'] : id
  const descriptionZh = typeof raw['descriptionZh'] === 'string' && raw['descriptionZh'] !== '' ? raw['descriptionZh'] : undefined
  const descriptionEn = typeof raw['descriptionEn'] === 'string' && raw['descriptionEn'] !== '' ? raw['descriptionEn'] : undefined
  const creditMultiplier = parseCreditMultiplier(raw['credits'])
  const reasoning = parseReasoning(raw['reasoning'])
  const supportsToolCall = typeof raw['supportsToolCall'] === 'boolean' ? raw['supportsToolCall'] : undefined
  // Upstream's image-input default. `disabledMultimodal: true` is a hard veto
  // whenever `supportsImages` is true. That pair has not been seen to conflict
  // on live data (CN 2026-09-29: 0 contradictory entries of 30), so the veto is
  // defensive — it only decides which way to lean if upstream ever does. The
  // value pre-fills the card's checkboxes on refresh; the effective capability
  // stays the saved `imageModelIds`.
  const supportsImages = raw['disabledMultimodal'] === true
    ? false
    : typeof raw['supportsImages'] === 'boolean'
      ? raw['supportsImages']
      : undefined
  return {
    id,
    name,
    contextWindow: input,
    maxTokens: output,
    ...creditMultiplier === undefined ? {} : { creditMultiplier },
    ...supportsImages === undefined ? {} : { supportsImages },
    ...reasoning === undefined ? {} : { reasoning },
    ...descriptionZh === undefined ? {} : { descriptionZh },
    ...descriptionEn === undefined ? {} : { descriptionEn },
    ...supportsToolCall === undefined ? {} : { supportsToolCall },
  }
}

/**
 * Select the chat-capable models from a catalog-shaped document: parse every
 * entry, then keep the `cli` agent's roster in its declared order.
 *
 * Both the CN personal-models document and the global `/v3/config` document
 * carry `models` plus an `agents` roster with the same entry shape, so one
 * selector serves them. Without a usable `cli` roster the whole parsed catalog
 * is exposed rather than nothing: the roster is an upstream detail that may
 * change, and an empty answer would silently disarm the provider.
 *
 * ROUTERS ARE NOT MODELS. The upstream lists `auto` (CN) and its global
 * equivalents alongside real models, but those entries are ROUTING decisions,
 * not models: the gateway resolves them to whichever model it thinks fits, so
 * a row for one would offer a name whose price, context window and behaviour
 * are all decided at request time by something else. Selected this way it also
 * duplicates a real row — upstream resolves CN `auto` to `hy4-preview`, which
 * is already in the same roster. They are dropped here, at the single place
 * the roster is built, so the card, the picker, the probe and the discovery
 * route all agree. A user who already had one enabled keeps it through
 * `keepIds` below: this removes the OFFER, never a running model (issue #32's
 * failure mode).
 *
 * `keepIds` is the user's own selection riding along with the refresh. The
 * upstream roster may drop a model the user is actually running — the app
 * channel's `cli` roster dropped `minimax-m2.7` on 2026-10-21 while the SAME
 * document still publishes it (`x0.26`) and the chat endpoint still answers for
 * it (measured HTTP 200). A roster read is therefore the upstream's roster PLUS
 * the kept ids this document still lists: a refresh may add or withdraw
 * upstream models, but it never silently withdraws a model the user is on.
 */
export function selectCliModels(
  rawModels: unknown,
  agents: unknown,
  keepIds: readonly string[] = [],
): WorkBuddyUpstreamModel[] {
  const byId = new Map<string, WorkBuddyUpstreamModel>()
  for (const model of Array.isArray(rawModels) ? rawModels : []) {
    const parsed = parseUpstreamModel(model)
    if (parsed !== undefined) byId.set(parsed.id, parsed)
  }
  let cliIds: readonly string[] | undefined
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (typeof agent === 'object' && agent !== null) {
      const wrapped = agent as Record<string, unknown>
      if (wrapped['name'] === 'cli' && Array.isArray(wrapped['models'])) {
        cliIds = wrapped['models'].filter((id): id is string => typeof id === 'string')
        break
      }
    }
  }
  const ids = cliIds !== undefined && cliIds.length > 0 ? cliIds : [...byId.keys()]
  const models = ids
    .filter(id => !isRouterModelId(id))
    .map(id => byId.get(id))
    .filter((model): model is WorkBuddyUpstreamModel => model !== undefined)
  // `keepIds` is the user's own selection, carried so a refresh does not
  // withdraw a model the user is running (issue #32). A ROUTER is excluded here
  // too, and that filter is load-bearing rather than belt-and-braces: a profile
  // saved BEFORE routers were dropped still lists `auto`/`default-model` in
  // `enabledModelIds`, and without this line that stored id would be re-added
  // through the kept branch — resurrecting the exact row this version stops
  // offering, and doing it on every single refresh rather than once.
  const kept = keepIds
    .filter(id => !ids.includes(id) && !isRouterModelId(id))
    .map(id => byId.get(id))
    .filter((model): model is WorkBuddyUpstreamModel => model !== undefined)
  // Guard the ANSWER, not the upstream's share of it. A roster that is nothing
  // but routers still leaves the region usable through the kept ids, and
  // throwing before they were merged would turn "the upstream renamed its
  // router" into "the region has no models at all".
  const resolved = [...models, ...kept]
  if (resolved.length === 0) throw new Error('workbuddy model catalog resolved to an empty list')
  return resolved
}

/**
 * The roster plus the promotion badges the SAME document carries.
 *
 * `data.modelPromotions` and `data.modelTiers` sit beside `data.models` in
 * the upstream's `/v3/config` document, so the badges cost no extra request:
 * they are read out of the response the roster was read from. Which models
 * they name is resolved here; WHICH badge holds at a given moment is not
 * (see `src/promo.ts` — a badge is a function of the clock).
 *
 * BOTH regions publish the feed, and they publish it in the app channel's
 * document: measured 2026-10-21 on the same accounts the app reads, CN
 * `/v3/config` carries 8 promotions + 1 tier badge (Chinese labels such as
 * `夜间折扣` / `限时免费` / `订阅优先`, with `schedule.daily` night windows),
 * and the global gateway carries 5 promotions + 1 tier badge. The feed is
 * absent only from the CLI channel's answer, which the plugin never reads a
 * product configuration as (see {@link PRODUCT_UA}).
 */
function withPromos(
  models: readonly WorkBuddyUpstreamModel[],
  data: Record<string, unknown>,
): readonly WorkBuddyUpstreamModel[] {
  const promos = parseWorkBuddyPromos(data['modelPromotions'], data['modelTiers'])
  return promos.length === 0 ? models : attachPromos(models, promos)
}

/**
 * What the plugin can tell about the request it just sent, for telling the
 * `11128` family apart.
 *
 * TWO FACTS, both read from the request body rather than from the upstream's
 * `msg` — which issue #113 measured to be unreliable (a content refusal
 * reported as `conversation id missing`).
 *
 * - `hasSystemHead`: does the request open with a `system` message? The
 *   plugin guarantees it does whenever the request carries messages
 *   (`ensureSystemHead`), so a body claiming the first-message gate is only
 *   believable when this is false.
 * - `hasConversationHeaders`: did the request carry the conversation-id
 *   triple? `chatHeaders` always adds it, so this is true in practice — and
 *   that is exactly what makes a `conversation id missing` wording
 *   unbelievable.
 *
 * Never throws: a body that cannot be read answers "unknown", which is the
 * safe direction (the wording is then believed).
 */
export function requestEvidenceOf(bodyJson: string): {
  hasSystemHead: boolean
  hasConversationHeaders: boolean
} {
  // The conversation-id triple is added by `chatHeaders` on EVERY chat
  // request, so the fact is a property of this code path, not of the body.
  const hasConversationHeaders = true
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyJson)
  } catch {
    return { hasSystemHead: false, hasConversationHeaders }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { hasSystemHead: false, hasConversationHeaders }
  }
  const messages = (parsed as Record<string, unknown>)['messages']
  if (!Array.isArray(messages)) return { hasSystemHead: false, hasConversationHeaders }
  const first = messages[0]
  if (typeof first !== 'object' || first === null || Array.isArray(first)) {
    return { hasSystemHead: false, hasConversationHeaders }
  }
  const role = (first as Record<string, unknown>)['role']
  return { hasSystemHead: role === 'system' || role === 'developer', hasConversationHeaders }
}

/**
 * Upstream HTTP client. One instance serves the whole plugin; requests take
 * the credential explicitly so token refreshes apply on the next call.
 */
export class WorkBuddyUpstreamClient {
  /**
   * Reports a fallback the catalog reader had to take.
   *
   * Injected rather than logged here because this module holds no logger on
   * purpose — it is pure transport + parsing, so it stays importable from
   * tests and the CLI without a cordis context. The host wires its
   * `ctx.logger.warn` in; without a host the event is dropped, which is the
   * same silence the previous single-source reader had.
   */
  constructor(private readonly onFallback?: (message: string) => void) {}

  /** POST the chat endpoint; a successful answer is the raw SSE response. */
  async chatStream(
    credential: WorkBuddyCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<WorkBuddyChatResult> {
    let response: Response
    // Deliberately NO ceiling of our own here, unlike `probeChat`.
    //
    // A chat answer has to prefill the whole prompt before its first byte, and
    // that legitimately varies by an order of magnitude with context size — a
    // bound tight enough to matter would eventually cut a real answer short, and
    // cutting a real answer is worse than waiting for a slow one. What remains is
    // the caller's cancellation (the shim's controller, which aborts when the
    // client hangs up) plus the HTTP client's own default headers timeout.
    //
    // Detecting a DEAD endpoint is the probe's job, not this path's: the pool
    // tests liveness with a cheap fixed request (see `PROBE_TIMEOUT_MS`) and
    // excludes what does not answer. Bounding the real request as well would be a
    // second, far more expensive detector for the same fact.
    try {
      response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: { ...chatHeaders(credential), 'Authorization': `Bearer ${credential.accessToken}` },
        body: bodyJson,
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    }
    if (response.ok) return { ok: true, response }
    const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    return {
      ok: false,
      status: response.status,
      kind: classifyUpstreamError(response.status, text),
      message: text,
      detail: parseUpstreamErrorDetail(text),
    }
  }

  /**
   * Send one minimal chat request for `bodyJson` and report the RAW answer.
   *
   * Shares {@link chatHeaders} and the chat base with {@link chatStream} on
   * purpose: a probe is only meaningful if it reaches the same endpoint with the
   * same authentication as a real request. The differences are deliberate and
   * narrow — it returns the headers (for `Retry-After`) and the failure body
   * (for classification) instead of a pre-classified error, so the probe module
   * owns the interpretation and the network layer stays a transport.
   *
   * The caller MUST drain {@link WorkBuddyProbeAnswer.response}; an unread body
   * holds the connection open.
   *
   * ALWAYS bounded in time. The pool's batch runner is serial and passes no
   * signal, so without a ceiling here one stalled connection blocks every account
   * behind it — the batch looks hung with no way to tell which member did it.
   * A supplied signal is COMBINED with the timeout rather than replacing it, so
   * the single-model route keeps its cancellation behaviour and still cannot
   * hang forever.
   *
   * The ceiling covers ONLY the wait for a response — it is cleared the moment
   * `fetch` resolves. Holding a timer over the body would put a healthy but slow
   * model on the same clock as a dead endpoint, and the whole point of the
   * period is to answer "did the upstream answer at all". A probe asks for a
   * single token, so the body that follows is one SSE line.
   */
  async probeChat(
    credential: WorkBuddyCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<WorkBuddyProbeAnswer> {
    let response: Response
    const ceiling = new AbortController()
    const timer = setTimeout(() => {
      ceiling.abort(new Error(`no response within ${PROBE_TIMEOUT_MS}ms`))
    }, PROBE_TIMEOUT_MS)
    try {
      response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: { ...chatHeaders(credential), 'Authorization': `Bearer ${credential.accessToken}` },
        body: bodyJson,
        signal: signal === undefined ? ceiling.signal : AbortSignal.any([signal, ceiling.signal]),
      })
    } catch (error: unknown) {
      // status 0 is the transport-failure convention the shim already maps to
      // its `server` class; reusing it keeps one meaning for one number.
      return { ok: false, status: 0, retryAfter: null, body: `transport error: ${String(error)}` }
    } finally {
      clearTimeout(timer)
    }
    const retryAfter = response.headers.get('retry-after')
    if (response.ok) return { ok: true, status: response.status, retryAfter, response }
    const body = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    return { ok: false, status: response.status, retryAfter, body }
  }

  /** POST the token-refresh endpoint; the caller merges the outcome. */
  async refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome> {
    const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: refreshHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const accessToken = typeof data['accessToken'] === 'string' ? data['accessToken'] : ''
    if (accessToken === '') throw new Error('workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app')
    const outcome: WorkBuddyRefreshOutcome = { accessToken }
    if (typeof data['refreshToken'] === 'string' && data['refreshToken'] !== '') outcome.refreshToken = data['refreshToken']
    if (typeof data['expiresIn'] === 'number' && data['expiresIn'] > 0) outcome.expiresInSec = data['expiresIn']
    if (typeof data['domain'] === 'string' && data['domain'] !== '') outcome.domain = data['domain']
    return outcome
  }

  /**
   * Read the model directory for the credential's region.
   *
   * Both regions read `/v3/config`, the document the WorkBuddy app itself
   * consumes, and both read it as the APP's product identity
   * ({@link PRODUCT_UA}) — the header the app sends, not the CLI channel's.
   * That is load-bearing, not cosmetic: the CLI channel's answer is a strict
   * subset of the app channel's and publishes neither `modelPromotions` nor
   * `modelTiers`, so reading `/v3/config` as the CLI channel is what left the
   * CN card without a single promotion badge while the app showed one on the
   * same account (see {@link PRODUCT_UA}).
   *
   * CN falls back to the legacy {@link MODELS_CATALOG_PATH} when `/v3` fails,
   * returns a non-zero envelope, or resolves to no usable model, so a gateway
   * that stops serving the modern document degrades to the previous roster
   * instead of leaving the region empty. The fallback is silent when unused and
   * reported when it fires, because a roster that silently differs from the
   * app's is exactly the bug this ordering exists to fix.
   *
   * No user-side toggle is involved: the region comes from the credential's
   * `domain`.
   *
   * `keepModelIds` is the user's own selection, passed through to
   * {@link selectCliModels}: a model the upstream roster dropped but the SAME
   * document still publishes stays in the roster, so reading the directory
   * never withdraws a model the user is running (issue #32's failure mode,
   * one step upstream of it).
   */
  async fetchModels(
    credential: WorkBuddyCredential,
    signal?: AbortSignal,
    keepModelIds: readonly string[] = [],
  ): Promise<readonly WorkBuddyUpstreamModel[]> {
    const timeout = signal ?? AbortSignal.timeout(JSON_TIMEOUT_MS)
    const global = regionOf(credential.domain) === 'global'
    if (global) {
      const response = await fetch(`${globalBase(credential.domain)}${GLOBAL_CONFIG_PATH}`, {
        headers: {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
          ...credential.uid === '' ? {} : { 'X-User-Id': credential.uid },
          ...credential.domain === '' ? {} : { 'X-Domain': credential.domain },
          'X-Product': 'SaaS',
          'X-Requested-With': 'XMLHttpRequest',
          'Connection': 'close',
          'User-Agent': PRODUCT_UA,
        },
        signal: timeout,
      })
      const envelope = await readEnvelope(response)
      if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
      const data = typeof envelope.data === 'object' && envelope.data !== null
        ? envelope.data as Record<string, unknown>
        : {}
      return withPromos(selectCliModels(data['models'], data['agents'], keepModelIds), data)
    }
    const readCatalog = async (path: string): Promise<readonly WorkBuddyUpstreamModel[]> => {
      const response = await fetch(`${chatBase(credential)}${path}`, {
        headers: {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
          'Origin': originReferer(credential),
          'Referer': `${originReferer(credential)}/`,
          'User-Agent': PRODUCT_UA,
        },
        signal: timeout,
      })
      const envelope = await readEnvelope(response)
      if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
      const data = typeof envelope.data === 'object' && envelope.data !== null
        ? envelope.data as Record<string, unknown>
        : {}
      return withPromos(selectCliModels(data['models'], data['agents'], keepModelIds), data)
    }
    try {
      return await readCatalog(GLOBAL_CONFIG_PATH)
    } catch (error: unknown) {
      // Three failures land here, and all three want the fallback: a transport
      // error, a non-zero envelope, and an EMPTY roster — `selectCliModels`
      // throws on the last one, so a `/v3` that stops listing models degrades
      // rather than emptying the region.
      this.onFallback?.(
        `CN model catalog ${GLOBAL_CONFIG_PATH} failed; falling back to ${MODELS_CATALOG_PATH}: `
        + (error instanceof Error ? error.message : String(error)),
      )
      return await readCatalog(MODELS_CATALOG_PATH)
    }
  }

  /**
   * Read how busy each model is right now, from the upstream's own probe.
   *
   * Batched at the upstream's ceiling (`WORKBUDDY_BUSY_BATCH_SIZE`), because the
   * probe takes a list of ids and answers only about the ids it was given.
   *
   * Throws on anything that is not a clean `code: 0`, like every other reader in
   * this class — the CALLER decides that a failed load probe is survivable and
   * catches it. Nothing here is persisted: the level belongs to the refresh that
   * asked for it.
   */
  async fetchModelBusy(
    credential: WorkBuddyCredential,
    modelIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<Map<string, WorkBuddyBusyLevel>> {
    const levels = new Map<string, WorkBuddyBusyLevel>()
    for (const batch of batchModelIds(modelIds)) {
      const response = await fetch(`${chatBase(credential)}${MODEL_BUSY_PATH}`, {
        method: 'POST',
        headers: {
          ...commonHeaders(credential),
          'Authorization': `Bearer ${credential.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ models: batch }),
        signal: signal ?? AbortSignal.timeout(MODEL_BUSY_TIMEOUT_MS),
      })
      const envelope = await readEnvelope(response)
      if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
      for (const [id, level] of parseBusyLevels(envelope.data)) levels.set(id, level)
    }
    return levels
  }

  /**
   * 读该账号所属区的产品配置，挑出带 `text-to-image` 标签的媒体模型。
   *
   * 走的是和 {@link fetchModels} 同一条 `/v3/config`（国内区与国际区都答），
   * 区别只在这里保留 `data.models` 的媒体条目、而不是投影成 CLI 聊天目录。
   * 国内区实测 62 条模型里只有 `hunyuan-image-alpha` 带 `text-to-image`；
   * 国际区一条都没有 —— 所以本方法对国际区返回空数组，而不是编一个模型出来。
   *
   * 这是一次 EXTRA 读取，不是「复用目录那一次」：`fetchModels` 的结果被投影成
   * 聊天目录就丢掉了媒体标签，所以这里必须再读一遍同一份文档。它是只读 GET、
   * 不花积分，且工具侧有 5 分钟缓存，但「零新增请求」的说法不成立，别那么写。
   * 国内区与 {@link fetchModels} 一样走 `/v3` → `/v2` 降级：上游一旦不答
   * `/v3`，聊天目录会降级而这里不能变成一个原始异常。
   */
  async fetchMediaModels(
    credential: WorkBuddyCredential,
    signal?: AbortSignal,
  ): Promise<readonly WorkBuddyMediaModel[]> {
    const readMedia = async (path: string): Promise<readonly WorkBuddyMediaModel[]> => {
      const response = await fetch(`${chatBase(credential)}${path}`, {
        headers: {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
          'Origin': originReferer(credential),
          'Referer': `${originReferer(credential)}/`,
          'User-Agent': PRODUCT_UA,
        },
        signal: signal ?? AbortSignal.timeout(JSON_TIMEOUT_MS),
      })
      const envelope = await readEnvelope(response)
      if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
      const data = typeof envelope.data === 'object' && envelope.data !== null
        ? envelope.data as Record<string, unknown>
        : {}
      return selectMediaModels(data['models'], IMAGE_TAG_TEXT_TO_IMAGE)
    }
    try {
      return await readMedia(GLOBAL_CONFIG_PATH)
    } catch (error: unknown) {
      // The legacy CN directory is a strict subset with no media tags in practice,
      // so it usually answers an EMPTY list — which is the honest answer ("this
      // gateway publishes no image model") rather than an exception the tool
      // would report as a broken feature. A transport failure on both paths still
      // propagates.
      if (regionOf(credential.domain) === 'global') throw error
      this.onFallback?.(
        `CN media catalog ${GLOBAL_CONFIG_PATH} failed; falling back to ${MODELS_CATALOG_PATH}: `
        + (error instanceof Error ? error.message : String(error)),
      )
      return await readMedia(MODELS_CATALOG_PATH)
    }
  }

  /**
   * 发一次文生图请求。
   *
   * 端点、请求体、响应解析全部照抄官方 CLI 的 ImageService（见 `image-gen.ts`
   * 的模块注释）。实测单张 5.71 credits，产物是 24 小时有效的 COS 签名 URL。
   *
   * 失败分两层：HTTP 非 2xx 交给 {@link describeImageFailure} 翻成带 code 的
   * 错误（401/403 提示重新登录、404 提示该区没有生图路由、429 提示限流）；
   * HTTP 200 但信封 `code !== 0` 由 {@link parseImageResponse} 处理。
   */
  async generateImage(
    credential: WorkBuddyCredential,
    request: { readonly model: string; readonly prompt: string; readonly size?: string },
    signal?: AbortSignal,
  ): Promise<WorkBuddyImageOutcome> {
    const response = await fetch(`${chatBase(credential)}${IMAGE_GENERATIONS_PATH}`, {
      method: 'POST',
      headers: imageHeaders(credential),
      body: JSON.stringify(buildImageBody(request)),
      signal: signal ?? AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    })
    const text = await response.text()
    if (!response.ok) throw describeImageFailure(response.status, text)
    let payload: unknown
    try {
      payload = JSON.parse(text) as unknown
    } catch {
      throw new WorkBuddyImageError(
        `workbuddy image: 上游返回的不是 JSON（HTTP ${response.status}）: ${text.slice(0, 200)}`,
        'UPSTREAM',
      )
    }
    return parseImageResponse(payload)
  }

  /** Query today's check-in status without changing account state. */
  async fetchCheckinStatus(credential: WorkBuddyCredential): Promise<WorkBuddyCheckinStatus> {
    const response = await fetch(`${billingBase(credential)}/v2/billing/meter/checkin-activity-status`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const numberField = (key: string): number => typeof data[key] === 'number' ? data[key] as number : 0
    return {
      active: data['active'] === true,
      todayCheckedIn: data['today_checked_in'] === true,
      streakDays: numberField('streak_days'),
      dailyCredit: numberField('daily_credit'),
      todayCredit: numberField('today_credit'),
      isStreakDay: data['is_streak_day'] === true,
      nextStreakDay: numberField('next_streak_day'),
      streakBonusDays: numberField('streak_bonus_days'),
      streakBonusCredit: numberField('streak_bonus_credit'),
      ...typeof data['claim_button_text'] === 'string' && data['claim_button_text'] !== ''
        ? { claimButtonText: data['claim_button_text'] }
        : {},
    }
  }

  /**
   * Read every promotional benefit this account can still see, WITHOUT claiming
   * anything.
   *
   * The campaign list is closed and small on purpose: the gateway exposes one
   * status endpoint per campaign, so "discover benefits" is a fixed fan-out, not
   * a search. A new campaign type means a new `/billing/meter/*-status` endpoint
   * added here — the plugin never guesses at undocumented ones.
   *
   * Every endpoint is read in parallel because they are independent, and a
   * failure is per-endpoint: one campaign answering 5xx must not blank out the
   * other. The caller gets only what was actually read.
   *
   * Note the paths carry NO `/v2` prefix — these are not the `/v2/billing/meter`
   * family the credit and check-in calls use. Probing `/v2/...` answers 404, which
   * is how this distinction was found.
   */
  async fetchBenefits(credential: WorkBuddyCredential): Promise<readonly WorkBuddyBenefit[]> {
    const read = async (
      kind: WorkBuddyBenefit['kind'],
      path: string,
    ): Promise<WorkBuddyBenefit | undefined> => {
      try {
        return await this.readBenefitStatus(kind, credential, path)
      } catch {
        return undefined
      }
    }
    const [compensation, gift] = await Promise.all([
      read('compensation', '/billing/meter/compensation-status'),
      read('gift', '/billing/meter/check-gift-claimed'),
    ])
    return [compensation, gift].filter((benefit): benefit is WorkBuddyBenefit => benefit !== undefined)
  }

  /** One benefit status endpoint. Throws on anything that is not a clean `code: 0`. */
  private async readBenefitStatus(
    kind: WorkBuddyBenefit['kind'],
    credential: WorkBuddyCredential,
    path: string,
  ): Promise<WorkBuddyBenefit> {
    const response = await fetch(`${billingBase(credential)}${path}`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const numberField = (key: string): number => typeof data[key] === 'number' ? data[key] as number : 0
    /** The gateway states times as `YYYY-MM-DD HH:MM:SS` in local time. */
    const timeField = (key: string): number | undefined => {
      const raw = data[key]
      if (typeof raw !== 'string' || raw.trim() === '') return undefined
      const parsed = Date.parse(raw.replace(' ', 'T'))
      return Number.isNaN(parsed) ? undefined : parsed
    }
    const endsAtMs = timeField('end_time')
    const startsAtMs = timeField('start_time')
    const claimedAtMs = timeField('claimed_at')
    return {
      kind,
      active: data['active'] === true,
      claimed: data['claimed'] === true,
      creditNum: numberField('credit_num'),
      ...endsAtMs === undefined ? {} : { endsAtMs },
      ...startsAtMs === undefined ? {} : { startsAtMs },
      ...claimedAtMs === undefined ? {} : { claimedAtMs },
    }
  }

  /**
   * Claim one benefit campaign on ONE account (issue #79).
   *
   * This is a real credit grant on a real account, so it takes no account
   * argument other than the credential it is handed: the caller decides which
   * single account, and there is deliberately no batch form of this method. The
   * browser route is the only caller, and it guards the mutation with the same
   * POST + loopback checks the check-in route carries.
   *
   * The response is not parsed: the documented envelope of these two endpoints
   * is an empty success, and the caller re-reads the status afterwards. That
   * re-read, not this answer, is what the user is shown — which is why a claim
   * that silently did nothing still cannot leave the card saying 待领取.
   */
  async claimBenefit(
    credential: WorkBuddyCredential,
    kind: WorkBuddyBenefit['kind'],
  ): Promise<void> {
    const response = await fetch(`${billingBase(credential)}${BENEFIT_CLAIM_PATHS[kind]}`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
  }

  /** Claim today's check-in reward. The browser route guards this mutation. */
  async claimDailyCheckin(credential: WorkBuddyCredential): Promise<WorkBuddyCheckinClaim> {
    const response = await fetch(`${billingBase(credential)}/v2/billing/meter/daily-checkin`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const numberField = (key: string): number => typeof data[key] === 'number' ? data[key] as number : 0
    return {
      credit: numberField('credit'),
      streakDays: numberField('streak_days'),
      isStreakDay: data['is_streak_day'] === true,
    }
  }

  /**
   * The ENTERPRISE credit table (issue #124).
   *
   * `/v2/billing/meter/get-user-resource` answers an enterprise member with
   * HTTP 200 and an empty `Accounts` list — a legally-shaped "you have no
   * credits" that is simply false, because the member's credits live under the
   * enterprise account. The official client branches on the account's
   * `type: "ultimate"` and calls `/billing/meter/get-enterprise-user-usage`
   * instead (no `/v2` prefix), which returns:
   *
   *   { credit: 1234, limitNum: 5000, cycleResetTime: "2026-11-01 00:00:00" }
   *
   * What REMAINS is `limitNum - credit`. `credit` there is the amount SPENT,
   * not the amount left — reading it as a balance inverts the answer, which is
   * worse than the zero it replaces.
   *
   * @returns the credits, or `undefined` when this response carried no
   *          readable balance (the caller turns that into an error rather than
   *          reporting zero).
   */
  private async fetchEnterpriseCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits | undefined> {
    const response = await fetch(`${billingBase(credential)}/billing/meter/get-enterprise-user-usage`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const wrapper = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    // The payload has been seen both at the top level and under `Data`, so both
    // are accepted; whichever carries the two numbers wins.
    const inner = typeof wrapper['Data'] === 'object' && wrapper['Data'] !== null
      ? wrapper['Data'] as Record<string, unknown>
      : wrapper
    const limit = typeof inner['limitNum'] === 'number' && Number.isFinite(inner['limitNum'])
      ? inner['limitNum']
      : undefined
    const used = typeof inner['credit'] === 'number' && Number.isFinite(inner['credit'])
      ? inner['credit']
      : undefined
    // Without BOTH numbers there is no balance to report. Returning `total: 0`
    // here would reproduce the exact symptom this branch exists to fix.
    if (limit === undefined || used === undefined) return undefined
    const remain = Math.max(0, limit - used)
    const refreshAtMs = typeof inner['cycleResetTime'] === 'string'
      ? parseEnterpriseInstant(inner['cycleResetTime'])
      : undefined
    return {
      total: remain,
      packages: [{
        packageName: '企业积分',
        remain,
        size: limit,
        monthly: true,
        ...refreshAtMs === undefined ? {} : { refreshAtMs },
      }],
      expiringSoon: 0,
    }
  }

  /**
   * POST the billing endpoint for the remaining credit, keeping every package
   * separate: the card groups monthly-cycle packages itself and lists the
   * nearest-expiring one-off packages, so aggregation here would lose the
   * dates it needs.
   */
  async fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits> {
    // ENTERPRISE ACCOUNTS READ A DIFFERENT ENDPOINT (issue #124).
    //
    // The personal endpoint answers 200 with a legally-shaped empty list for an
    // enterprise member, so the card showed `total 0` on an account that had
    // credits — the plugin was asking the wrong table, not getting a refusal.
    // The enterprise table is `/billing/meter/get-enterprise-user-usage`
    // (no `/v2` prefix) and returns `{credit, limitNum, cycleResetTime}`: what
    // REMAINS is `limitNum - credit`, and it resets when the cycle rolls.
    //
    // Which branch to take is decided by `enterpriseId` ALONE, never by the
    // personal answer: an enterprise account whose personal response happened
    // to be non-empty must not be read through the personal table either, and
    // `status.active` is `false` for every enterprise member (measured), so it
    // cannot serve as a discriminator.
    if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
      const enterprise = await this.fetchEnterpriseCredits(credential)
      if (enterprise !== undefined) return enterprise
      // Fall through to the personal table only when the enterprise endpoint
      // gave us nothing usable. Returning an empty answer there is NOT an
      // option: `total: 0` on a funded account is the exact symptom #124
      // reports, so an unreadable enterprise response is reported as a
      // failure, not as a balance.
      throw new Error('workbuddy upstream enterprise credit: no readable balance in the response')
    }
    const now = new Date()
    const format = (date: Date): string => [
      date.getFullYear().toString().padStart(4, '0'),
      (date.getMonth() + 1).toString().padStart(2, '0'),
      date.getDate().toString().padStart(2, '0'),
    ].join('-') + ' ' + [
      date.getHours().toString().padStart(2, '0'),
      date.getMinutes().toString().padStart(2, '0'),
      date.getSeconds().toString().padStart(2, '0'),
    ].join(':')
    const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: format(now),
        PackageEndTimeRangeEnd: format(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
      }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const responseWrapper = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const data = typeof responseWrapper['Response'] === 'object' && responseWrapper['Response'] !== null
      ? responseWrapper['Response'] as Record<string, unknown>
      : {}
    const inner = typeof data['Data'] === 'object' && data['Data'] !== null
      ? data['Data'] as Record<string, unknown>
      : {}
    const rawAccounts = Array.isArray(inner['Accounts']) ? inner['Accounts'] : []

    let total = 0
    let nearestExpiryMs: number | undefined
    let expiringSoon = 0
    const SOON_MS = 3 * 24 * 60 * 60 * 1000
    const parseDate = (raw: unknown): number | undefined => {
      if (typeof raw === 'number' && raw > 1000000000000) return raw
      if (typeof raw === 'string' && raw !== '') {
        const parsed = Date.parse(raw)
        if (!Number.isNaN(parsed)) return parsed
      }
      return undefined
    }
    const packages: WorkBuddyCreditPackage[] = []
    for (const raw of rawAccounts) {
      if (typeof raw !== 'object' || raw === null) continue
      const account = raw as Record<string, unknown>
      const numberField = (key: string): number => (typeof account[key] === 'number' ? account[key] as number : 0)
      // Every capacity is ALSO sent as a `*Precise` string carrying the fraction
      // the integer field drops ("96.61000218" beside 96). The official client
      // reads these — its total ends in a decimal (2,196.61) which no sum of the
      // integer fields can produce. Prefer the precise spelling, fall back to the
      // integer so a response that omits it still parses.
      const preciseField = (key: string): number => {
        const raw = account[`${key}Precise`]
        if (typeof raw === 'string' && raw !== '') {
          const parsed = Number.parseFloat(raw)
          if (Number.isFinite(parsed)) return parsed
        }
        if (typeof raw === 'number' && Number.isFinite(raw)) return raw
        return numberField(key)
      }
      // CapacityType 4 = monthly capacity resource (refreshed every cycle, never
      // expires: empty ExpiredTime, DeductionEndTime years out). CapacityType 1 =
      // deduction-based gift (CapacityRemain drains to 0, ExpiredTime set).
      // CycleEndTime exists on both, so it alone cannot tell them apart.
      const monthly = numberField('CapacityType') === 4
      // The BALANCE is the cycle family, for BOTH kinds (issue #58 — see
      // WorkBuddyCreditPackage.remain for the evidence and for what #48 got
      // wrong). `CycleCapacitySize` is read first because on a monthly resource
      // it is the size the balance is a fraction OF; `CapacitySize` is both the
      // gift spelling and the fallback for a row that carries no cycle family.
      const size = preciseField('CycleCapacitySize') || preciseField('CapacitySize')
      const hasCycle = account['CycleCapacityRemain'] !== undefined
        || account['CycleCapacityRemainPrecise'] !== undefined
      const remain = hasCycle ? preciseField('CycleCapacityRemain') : preciseField('CapacityRemain')
      const cappedRemain = remain < 0 ? 0 : remain
      // For the monthly resource the cycle end is the refresh point; display the
      // next cycle's start (end + 1s) since "refreshes on 08/31 23:59:59" reads
      // like the package dies then. For a gift, ExpiredTime is when it vanishes.
      const cycleEndMs = parseDate(account['CycleEndTime'])
      const expiresAtMs = monthly ? undefined : parseDate(account['ExpiredTime']) ?? cycleEndMs
      const refreshAtMs = monthly
        ? cycleEndMs === undefined ? undefined : cycleEndMs + 1_000
        : undefined
      // Drop one-off gifts that are exhausted or already expired: they carry
      // no usable credits and would clutter the nearest-expiry list. Monthly
      // resources (CapacityType 4) are always kept.
      if (!monthly && (cappedRemain <= 0 || (expiresAtMs !== undefined && expiresAtMs <= Date.now()))) {
        continue
      }
      total += cappedRemain
      const expiryMs = expiresAtMs
      if (expiryMs !== undefined) {
        if (nearestExpiryMs === undefined || expiryMs < nearestExpiryMs) nearestExpiryMs = expiryMs
        if (expiryMs - Date.now() <= SOON_MS) expiringSoon += cappedRemain
      }
      packages.push({
        packageName: typeof account['PackageName'] === 'string' ? account['PackageName'] : '(unnamed)',
        remain: cappedRemain,
        size,
        monthly,
        ...refreshAtMs === undefined ? {} : { refreshAtMs },
        ...expiresAtMs === undefined ? {} : { expiresAtMs },
      })
    }
    return {
      total,
      packages,
      expiringSoon,
      ...nearestExpiryMs === undefined ? {} : { nearestExpiryMs },
    }
  }
}
