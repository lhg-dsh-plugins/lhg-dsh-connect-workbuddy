/**
 * The model queue: which upstream answers are a queue at all, and what the
 * plugin says about them.
 *
 * The three codes and the polling tiers are the WorkBuddy client's own
 * (`QueuePollingManager`, 5.8.3): `6020` waiting, `6021` full, `6022` this user
 * already holds the maximum, polled every 2/5/10/15 s by position tier. The
 * `<status>` shape is the live answer measured 2026-10-21 on `/v2/chat/queue/status`
 * — including its `message`, which is an i18n KEY (`queue.expired.title`), not a
 * sentence. The plugin therefore never renders that field, and one test below
 * pins exactly that.
 */
import { describe, expect, it } from 'vitest'
import { classifyUpstreamError } from '../src/upstream.ts'
import {
  isQueueCode,
  parseQueueAnswer,
  queueNoticeText,
  WORKBUDDY_QUEUE_FULL,
  WORKBUDDY_QUEUE_USER_LIMIT,
  WORKBUDDY_QUEUE_WAITING,
} from '../src/queue.ts'

/** What the app's own bundle answers for one waiting request. */
const waitingEnvelope = JSON.stringify({
  code: WORKBUDDY_QUEUE_WAITING,
  message: 'queue.waiting',
  data: { code: WORKBUDDY_QUEUE_WAITING, queue_position: 8777, queue_size: 9021, retry_after: 7 },
})

/** The live status answer, whose `message` is a key. */
const statusAnswer = JSON.stringify({
  code: 0,
  msg: 'OK',
  requestId: '8b0bd3ee',
  data: { status: 'expired', message: 'queue.expired.title' },
})

describe('the three queue codes', () => {
  it('recognises exactly the app’s enum', () => {
    expect(isQueueCode(WORKBUDDY_QUEUE_WAITING)).toBe(true)
    expect(isQueueCode(WORKBUDDY_QUEUE_FULL)).toBe(true)
    expect(isQueueCode(WORKBUDDY_QUEUE_USER_LIMIT)).toBe(true)
    expect(isQueueCode(14003)).toBe(false)
    expect(isQueueCode('6020')).toBe(false)
    expect(isQueueCode(undefined)).toBe(false)
  })
})

describe('parseQueueAnswer', () => {
  it('reads position, size and retry_after out of a waiting answer', () => {
    expect(parseQueueAnswer(waitingEnvelope)).toEqual({
      code: WORKBUDDY_QUEUE_WAITING,
      position: 8777,
      size: 9021,
    })
  })

  it('does not carry a retry countdown, because nothing retries', () => {
    // `retry_after` used to be parsed into `retryAfterSec` and rendered as
    // 「约 N 秒后自动重试」. Nothing polls the queue and nothing resends (see the
    // module note), so the field is removed rather than parsed and dropped.
    const body = JSON.stringify({ code: 6020, data: { queue_position: 3, retry_after: 7 } })
    expect(Object.keys(parseQueueAnswer(body) ?? {}).sort()).toEqual(['code', 'position'])
  })

  it('reads a code nested one level down', () => {
    const body = JSON.stringify({ code: 0, data: { code: 6021, queue_size: 500 } })
    expect(parseQueueAnswer(body)).toEqual({ code: WORKBUDDY_QUEUE_FULL, size: 500 })
  })

  it('reads the app’s agent-protocol envelope, where the condition is a JSON string', () => {
    const body = JSON.stringify({
      _meta: {
        'codebuddy.ai/errorMessage': JSON.stringify({
          code: 0,
          data: { code: 6020, queue_position: 12, queue_size: 40 },
          message: 'queue.waiting',
        }),
      },
    })
    expect(parseQueueAnswer(body)?.position).toBe(12)
  })

  it('is NOT a queue for a throttle, a quota refusal or a truncated body', () => {
    expect(parseQueueAnswer(JSON.stringify({ code: 14003, msg: 'model busy' }))).toBeUndefined()
    expect(parseQueueAnswer(JSON.stringify({ code: 14018, extError: { code: 14018 } }))).toBeUndefined()
    expect(parseQueueAnswer('{"code":6020,"data":{"queue_pos')).toBeUndefined()
    expect(parseQueueAnswer('')).toBeUndefined()
  })

  it('does not mistake the live status answer for a queue condition', () => {
    // `{status:'expired', message:'queue.expired.title'}` is a STATUS read, not
    // a queue event: nothing to report, and the key must never be printed.
    expect(parseQueueAnswer(statusAnswer)).toBeUndefined()
  })
})

// The app's position-tiered poll cadence (2/5/10/15 s, 12-minute cap) is
// recorded as upstream FACT in `src/queue.ts`, not implemented: the resend loop
// it belongs to does not exist yet, and shipping its constants as tested-but-
// unexported API is the thing this project keeps refusing to do. When the loop
// is built — against a real queue sample — those tier tests come back with it.

describe('queueNoticeText', () => {
  it('names the position AND the queue size for a waiting request', () => {
    const text = queueNoticeText({ code: WORKBUDDY_QUEUE_WAITING, position: 8777, size: 9021 })
    expect(text).toContain('排队中')
    expect(text).toContain('8777')
    expect(text).toContain('9021')
  })

  it('says the queue is full, and does not pretend a position exists', () => {
    const text = queueNoticeText({ code: WORKBUDDY_QUEUE_FULL, size: 500 })
    expect(text).toContain('队列已满')
    expect(text).not.toContain('第 ')
  })

  it('says the user already holds the maximum, for 6022', () => {
    expect(queueNoticeText({ code: WORKBUDDY_QUEUE_USER_LIMIT })).toContain('排队任务已达上限')
  })

  it('never prints an untranslated upstream message key', () => {
    const text = queueNoticeText({ code: WORKBUDDY_QUEUE_WAITING, position: 2 })
    expect(text).not.toContain('queue.')
  })
})

describe('a queue is its OWN failure class', () => {
  // These pin the two things that made a queued request walk the whole account
  // pool before the user was told their position: the code was unclassified (so
  // it fell through to a status-shaped kind) and those kinds fail over.
  it('classifies 6020/6021/6022 as model_queue, whatever status carries them', () => {
    // The status is incidental — measured on the OpenAI-compatible channel the
    // same condition arrives under 200-, 429- and 500-shaped envelopes.
    for (const status of [200, 400, 429, 500]) {
      for (const code of [WORKBUDDY_QUEUE_WAITING, WORKBUDDY_QUEUE_FULL, WORKBUDDY_QUEUE_USER_LIMIT]) {
        const body = JSON.stringify({ code, msg: 'waiting', data: { queue_position: 8777, queue_size: 9021 } })
        expect(classifyUpstreamError(status, body)).toBe('model_queue')
      }
    }
  })

  it('does not turn an unrelated failure into a queue', () => {
    // A throttle, a credit refusal and a plain server error keep their own kinds:
    // the queue branch must be narrow enough not to swallow them.
    expect(classifyUpstreamError(429, '{"code":14003,"msg":"model busy"}')).toBe('model_busy')
    expect(classifyUpstreamError(402, '{"msg":"Credits exhausted."}')).toBe('hard_credit')
    expect(classifyUpstreamError(500, '{"msg":"internal"}')).toBe('server')
    expect(classifyUpstreamError(400, '{"code":6023,"msg":"unknown"}')).toBe('client')
  })

  it('reads a queue answer out of a 500 envelope, which is what used to fail over', () => {
    // The regression this whole change is about: a queue rode on a 500, so it
    // was classified `server` — a failover-worthy kind — and the pool was walked.
    expect(classifyUpstreamError(500, waitingEnvelope)).toBe('model_queue')
    expect(classifyUpstreamError(429, waitingEnvelope)).toBe('model_queue')
  })
})
