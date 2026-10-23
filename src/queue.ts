/**
 * WorkBuddy model queue — the "你排在 8777 位" state the WorkBuddy client shows
 * instead of failing a request, recognised at the point this plugin would
 * otherwise hand the user a raw upstream error.
 *
 * WHAT THE APP DOES (main bundle `QueuePollingManager`, WorkBuddy 5.8.3, offsets
 * ~152600 in `renderer/assets/workbuddy-provider-*.js`), and what this module
 * keeps of it:
 *
 *   | business code | the app's state | the app's next move                    |
 *   | ---           | ---             | ---                                    |
 *   | 6020          | `waiting`       | poll `/v2/chat/queue/status`, resend   |
 *   | 6021          | `full`          | stop: the queue itself is full          |
 *   | 6022          | `user_limit`    | stop: this user already holds the max   |
 *
 * The poll cadence is the app's, tiered by the position it is told it holds:
 *
 *   | position | interval |
 *   | ---      | ---      |
 *   | ≤ 5      | 2 s      |
 *   | ≤ 20     | 5 s      |
 *   | ≤ 50     | 10 s     |
 *   | > 50     | 15 s     |
 *
 * and the whole wait is bounded at 12 minutes (`mi=12e5`), after which the app
 * gives up rather than polling behind a stalled queue forever.
 *
 * NONE OF THAT CADENCE IS IMPLEMENTED HERE, and it is recorded as upstream
 * FACT rather than as constants this module uses: the loop it belongs to does
 * not exist yet (see "WHAT THIS MODULE DOES NOT DO YET" below). An earlier
 * revision exported `queuePollIntervalMs` and `WORKBUDDY_QUEUE_MAX_WAIT_MS` for
 * it; both were removed rather than left as API that only its own test called —
 * this project's rule is that unmeasured, unreachable code is not a feature.
 *
 * WHAT THE GATEWAY ACTUALLY ANSWERS, measured 2026-10-21 (CN credential, the
 * chat host): `POST /v2/chat/queue/status {model}` with an `X-Conversation-Request-ID`
 * answers HTTP 200
 *
 *   {"code":0,"msg":"OK","requestId":"…","data":{"status":"expired",
 *    "message":"queue.expired.title"}}
 *
 * — note that `message` is an i18n KEY, not a sentence. The `queue.*` keys are
 * not shipped in either WorkBuddy bundle (0 hits across 2513 unpacked + 1986
 * packed files), so a client that shows it verbatim would show the key. This
 * module therefore NEVER renders the upstream's `message`: the status enum is the
 * machine fact, and the sentence is the plugin's own.
 *
 * WHAT THIS MODULE DOES NOT DO YET. It recognises a queue answer and words it;
 * it does not hold the request open and resend it the way the app's
 * `QueuePollingManager` does. That loop needs the queue answer's shape as it
 * arrives on the OpenAI-compatible chat endpoint, which no measurement has
 * produced yet — inventing one would mean code that never runs. Recognition is
 * the part that can be honest today, and it is also the part that turns
 * "上游 500" into "你排在 8777 位".
 *
 * @module dsh-connect-workbuddy/queue
 */

/** The app's `di` enum: `WAITING` / `FULL` / `USER_LIMIT`. */
export const WORKBUDDY_QUEUE_WAITING = 6020
export const WORKBUDDY_QUEUE_FULL = 6021
export const WORKBUDDY_QUEUE_USER_LIMIT = 6022

/** Everything the app treats as a queue condition (`isQueueError`). */
const WORKBUDDY_QUEUE_CODES: readonly number[] = [
  WORKBUDDY_QUEUE_WAITING,
  WORKBUDDY_QUEUE_FULL,
  WORKBUDDY_QUEUE_USER_LIMIT,
]

/** True when a business code is one of the app's three queue codes. */
export function isQueueCode(value: unknown): boolean {
  return typeof value === 'number' && WORKBUDDY_QUEUE_CODES.includes(value)
}

/**
 * One recognised queue condition, as the upstream stated it.
 *
 * NO `retryAfterSec` FIELD (removed 2026-10-22 with the sentence it fed). It
 * existed only to render 「约 N 秒后自动重试」, and nothing retries — see
 * {@link queueNoticeText}. A parsed-but-unused countdown would invite the
 * promise back, and this project's rule is that unreachable data is not a
 * feature.
 */
export interface WorkBuddyQueueReport {
  /** `6020` / `6021` / `6022`. */
  code: number
  /** Where this request sits, when the upstream said (`6020` only). */
  position?: number
  /** How many requests are beyond it, when the upstream said. */
  size?: number
}

/** Read one queue condition out of a `data`-shaped object, or `undefined`. */
function reportFrom(code: number, data: unknown): WorkBuddyQueueReport | undefined {
  if (!isQueueCode(code)) return undefined
  const body = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {}
  const numberField = (key: string): number | undefined =>
    typeof body[key] === 'number' && Number.isFinite(body[key] as number) ? body[key] as number : undefined
  const position = numberField('queue_position')
  const size = numberField('queue_size')
  // `retry_after` is deliberately NOT read any more: the countdown it fed
  // promised a retry this plugin does not perform (see `queueNoticeText`).
  return {
    code,
    ...position === undefined ? {} : { position },
    ...size === undefined ? {} : { size },
  }
}

/**
 * Read a queue condition out of one upstream body.
 *
 * Three shapes are accepted, because the gateway wraps the same fact three ways
 * depending on which channel answered:
 *
 *   1. the chat endpoint's own error envelope — `{"code":6020,"data":{…}}`;
 *   2. the app's agent-protocol envelope, where the condition rides as a JSON
 *      STRING inside `_meta['codebuddy.ai/errorMessage']`
 *      (`{"code":6020,"data":{…},"message":"…"}` — see the app's
 *      `extractQueueInfoFromPromptResult`);
 *   3. a nested `data.code`, for a gateway that wraps one envelope in another.
 *
 * Anything else — a 14003 throttle, a quota refusal, a 500 — is NOT a queue and
 * returns `undefined`, so this can sit in the error path without changing it.
 */
export function parseQueueAnswer(text: string): WorkBuddyQueueReport | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const direct = readEnvelope(parsed)
  if (direct !== undefined) return direct
  if (typeof parsed === 'object' && parsed !== null) {
    const meta = (parsed as Record<string, unknown>)['_meta']
    if (typeof meta === 'object' && meta !== null) {
      const message = (meta as Record<string, unknown>)['codebuddy.ai/errorMessage']
      if (typeof message === 'string') {
        try {
          return readEnvelope(JSON.parse(message))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/** `{code, data}` at the top level, or one `data` level down. */
function readEnvelope(value: unknown): WorkBuddyQueueReport | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const envelope = value as Record<string, unknown>
  const top = reportFrom(envelope['code'] as number, envelope['data'])
  if (top !== undefined) return top
  const data = envelope['data']
  if (typeof data === 'object' && data !== null) {
    const inner = data as Record<string, unknown>
    return reportFrom(inner['code'] as number, inner['data'] ?? inner)
  }
  return undefined
}

/**
 * The sentence a queue condition is reported with — the app's own vocabulary
 * ("排队", "位"), and never the upstream's untranslated `message` key.
 *
 * `waiting` names both numbers because they answer different questions: the
 * POSITION is how long the wait is, the SIZE is whether it is moving at all.
 *
 * IT NO LONGER PROMISES "自动重试" (removed 2026-10-22, at the maintainer's
 * request). The sentence used to end with 「约 N 秒后自动重试」, and nothing
 * retried: this plugin does not poll `/v2/chat/queue/status` and does not resend
 * (see "WHAT THIS MODULE DOES NOT DO YET" above). The only retry that ever
 * happened was the HOST's own bounded in-place retry on a 429 — two attempts,
 * 0.5s then 1s, about 1.5 seconds — which is not "N seconds" and gives up long
 * before a real queue of thousands moves.
 *
 * So the sentence now states the WAIT and leaves the next move to the reader.
 * Reporting the position stays honest and useful — knowing you are 8,777th is
 * the answer to "wait or switch" — but claiming a recovery the plugin does not
 * perform turned a diagnostic into a promise it could not keep.
 */
export function queueNoticeText(report: WorkBuddyQueueReport): string {
  if (report.code === WORKBUDDY_QUEUE_WAITING) {
    const position = report.position === undefined ? '未知' : `${report.position}`
    const size = report.size === undefined ? '' : `，队列共 ${report.size} 个请求`
    return `模型排队中：你排在第 ${position} 位${size}。请稍后重新发送这条消息，或换一个模型`
  }
  if (report.code === WORKBUDDY_QUEUE_FULL) {
    const size = report.size === undefined ? '' : `（共 ${report.size} 个请求排队）`
    return `模型队列已满${size}，现在无法排队；请稍后重试或换一个模型`
  }
  const size = report.size === undefined ? '' : `（共 ${report.size} 个请求排队）`
  return `你的排队任务已达上限${size}，请等待已排队请求完成后再试`
}
