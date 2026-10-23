/**
 * Output-speed measurement (issue #92).
 *
 * THE QUESTION. The reporter measured four models at the same x0.08 credit
 * multiplier whose median output speed differed by 3.8x, and pointed out that DSH
 * dispatches models as parallel sub-agents — so a slow model costs wall-clock
 * time across a whole run. Credit multiplier alone cannot answer "which model
 * should I use".
 *
 * WHY THE EXISTING PROBE COULD NOT ANSWER IT. That probe sends 25,000 input
 * tokens and caps output at ONE (`PROBE_MAX_TOKENS = 1`), so its `elapsedMs` is
 * time-to-first-token: there is no generation span to divide by. Measuring speed
 * needs the opposite request shape — tiny input, long output — which is why this
 * is a second route rather than a field on the first.
 *
 * WHAT THESE TESTS PIN. The measurement is only worth anything if it times the
 * RIGHT interval, so the stream reader is driven with chunks that arrive on a
 * known schedule and the result is checked against that schedule. A reader that
 * buffered the body would report the parse duration and still look plausible;
 * that is the specific defect these cases are written to catch.
 */
import { describe, expect, it } from 'vitest'
import {
  TPS_PROBE_MAX_TOKENS,
  TPS_PROBE_RUNS,
  measureTps,
  readTimedStream,
  summarizeTps,
  timingsOfLine,
  tpsProbeRequestBody,
} from '../src/tps.ts'

/** A stream that delivers each frame after a fixed delay, so timing is known. */
function streamOf(frames: readonly string[], gapMs: number): ReadableStream<Uint8Array> {
  let index = 0
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= frames.length) {
        controller.close()
        return
      }
      if (index > 0) await new Promise(resolve => setTimeout(resolve, gapMs))
      controller.enqueue(encoder.encode(frames[index] as string))
      index += 1
    },
  })
}

const frame = (content: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`

const usageFrame = (completionTokens: number, credit?: number): string =>
  `data: ${JSON.stringify({ usage: { completion_tokens: completionTokens, ...credit === undefined ? {} : { credit } } })}\n\n`

describe('the request shape', () => {
  it('caps output well above 1 token, so there is a generation span to time', () => {
    // The whole reason this is not the availability probe: `max_tokens: 1` has
    // no generation to measure.
    expect(TPS_PROBE_MAX_TOKENS).toBeGreaterThan(100)
    const body = JSON.parse(tpsProbeRequestBody('hy3')) as Record<string, unknown>
    expect(body['max_tokens']).toBe(TPS_PROBE_MAX_TOKENS)
  })

  it('sends a TINY prompt, because this gateway bills by input', () => {
    // Measured: the availability probe's 25,000 input tokens cost 0.72 credit,
    // while this shape costs 0.01–0.15. A long prompt here would cost 30x more
    // to learn the same thing.
    const body = JSON.parse(tpsProbeRequestBody('hy3')) as { messages: { content: string }[] }
    const inputChars = body.messages.reduce((total, message) => total + message.content.length, 0)
    expect(inputChars).toBeLessThan(400)
  })

  it('asks for output volume without asking for reasoning', () => {
    // A reasoning model would spend its budget thinking and the stream would
    // carry reasoning deltas rather than content, so the run would either time
    // the wrong thing or report no speed at all.
    const body = JSON.parse(tpsProbeRequestBody('hy3')) as Record<string, unknown>
    expect(body['reasoning_effort']).toBe('none')
    expect(body['stream']).toBe(true)
  })
})

describe('the stream reader times the interval it is given', () => {
  it('measures the gap between the FIRST and LAST content chunk', async () => {
    // Three content frames 60ms apart: the span between the FIRST and the LAST is
    // TWO gaps = ~120ms, not three. (Getting this wrong in the test is how a
    // reader that counted chunk COUNT as duration would slip through.)
    const stream = streamOf([frame('a'), frame('b'), frame('c'), usageFrame(3)], 60)
    const reading = await readTimedStream(stream, Date.now())
    expect(reading.outputTokens).toBe(3)
    expect(reading.generationMs).toBeGreaterThanOrEqual(100)
    expect(reading.generationMs).toBeLessThan(160)
  })

  it('derives tokens/second from that span, not from the whole request', async () => {
    const stream = streamOf([frame('a'), frame('b'), frame('c'), frame('d'), usageFrame(40)], 50)
    const sample = summarizeTps('hy3', [await readTimedStream(stream, Date.now())], 1)
    // 40 tokens over ~150ms of generation ≈ 267 tok/s. If the reader timed the
    // whole request instead, the generation span would still be the same — the
    // point is that it EXCLUDES the connect phase, so the number is a rate and
    // not an average that includes waiting.
    expect(sample.tokensPerSecond).toBeGreaterThan(200)
    expect(sample.tokensPerSecond).toBeLessThan(400)
    expect(sample.complete).toBe(true)
  })

  it('ignores reasoning deltas, so a thinking model is not reported as fast', async () => {
    // A reasoning delta is not output. Counting it would make exactly the models
    // whose speed matters most look fastest.
    const reasoningOnly = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'think think think' } }] })}\n\n`
    const stream = streamOf([reasoningOnly, reasoningOnly, usageFrame(0)], 30)
    const reading = await readTimedStream(stream, Date.now())
    expect(reading.firstContentMs).toBeUndefined()
    expect(reading.generationMs).toBeUndefined()
  })

  it('survives comments, blank lines and split frames without throwing', async () => {
    // The upstream is allowed to send keep-alive comments, and a chunk may end
    // mid-line. A reader that threw here would lose the whole measurement.
    const split = frame('half').slice(0, 20)
    const rest = frame('half').slice(20)
    const stream = streamOf([`: keep-alive\n\n`, split, rest, usageFrame(1)], 10)
    const reading = await readTimedStream(stream, Date.now())
    // The split frame reassembles into one content frame; the token count comes
    // from the usage frame, which is what the rate is computed against.
    expect(reading.outputTokens).toBe(1)
    expect(reading.firstContentMs).toBeDefined()
  })

  it('reports no speed when the whole answer arrived in ONE chunk', async () => {
    // One chunk means the stream said nothing about the RATE. Dividing by a
    // zero-length span would invent a number; the sample must omit it.
    const stream = streamOf([frame('everything at once'), usageFrame(9)], 10)
    const sample = summarizeTps('hy3', [await readTimedStream(stream, Date.now())], 1)
    expect(sample.tokensPerSecond).toBeUndefined()
    expect(sample.reason).toBe('few-chunks')
  })
})

describe('the median is what makes a single run trustworthy', () => {
  it('takes the MEDIAN, so one outlier cannot become the reported speed', () => {
    // Measured on glm-5.3-flash 2026-10-22: 110 / 105 / 177 / 103 / 109 tok/s.
    // The MEAN is 121 — inflated by the 177 outlier, and wrong: four of the five
    // runs sat at 103–110. The median of the three below is 110, and the mean of
    // the same three is 131. The test asserts the median, because the mean is
    // exactly what an outlier moves.
    const runs = [
      { outputTokens: 100, generationMs: 909 },  // ~110
      { outputTokens: 100, generationMs: 952 },  // ~105
      { outputTokens: 100, generationMs: 565 },  // ~177  <- outlier
    ]
    const sample = summarizeTps('glm-5.3-flash', runs, 3)
    expect(sample.tokensPerSecond).toBe(110)
    expect(sample.samples).toBe(3)
    expect(sample.complete).toBe(true)
  })

  it('uses an ODD run count, so the median is a real measurement', () => {
    // An even count averages the two middle values, reintroducing exactly the
    // outlier influence the median exists to remove.
    expect(TPS_PROBE_RUNS % 2).toBe(1)
  })

  it('drops a failed run instead of counting it as zero', () => {
    // A model that answered twice at 100 tok/s did not get slower because the
    // third request timed out. The shortfall shows in `samples`, not in the rate.
    const sample = summarizeTps('hy3', [
      { outputTokens: 100, generationMs: 1000 },
      { outputTokens: 100, generationMs: 1000 },
    ], 3)
    expect(sample.tokensPerSecond).toBe(100)
    expect(sample.samples).toBe(2)
    expect(sample.complete).toBe(false)
  })

  it('reports "all failed" rather than a zero when nothing answered', () => {
    const sample = summarizeTps('hy3', [], 3)
    expect(sample.tokensPerSecond).toBeUndefined()
    expect(sample.samples).toBe(0)
    expect(sample.reason).toBe('all-failed')
    expect(sample.complete).toBe(false)
  })

  it('distinguishes "no token count" from "too few chunks"', () => {
    // Two different upstream behaviours, two different things to tell the user:
    // one means the usage frame never arrived, the other means it did but the
    // stream was delivered in a single burst.
    const noUsage = summarizeTps('hy3', [{ generationMs: 500 }], 1)
    expect(noUsage.reason).toBe('no-usage')
    const fewChunks = summarizeTps('hy3', [{ outputTokens: 5, generationMs: 0 }], 1)
    expect(fewChunks.reason).toBe('few-chunks')
  })

  it('sums the credit across runs, rounded to 2dp', () => {
    // The card shows what the measurement cost, so a fractional sum must not
    // render as 0.30000000000000004.
    const sample = summarizeTps('hy3', [
      { outputTokens: 100, generationMs: 500, credit: 0.01 },
      { outputTokens: 100, generationMs: 500, credit: 0.02 },
    ], 2)
    expect(sample.credit).toBe(0.03)
  })
})

describe('measureTps drives the real loop', () => {
  it('runs the planned number of times and medians what came back', async () => {
    let calls = 0
    const client = {
      probeChat: async () => {
        calls += 1
        // 100 tokens over ~50ms of generation per run.
        const frames = [frame('x'), frame('y'), frame('z'), usageFrame(100)]
        return { ok: true, status: 200, response: new Response(streamOf(frames, 25)) }
      },
    }
    const sample = await measureTps({ client, credential: {}, modelId: 'hy3' })
    expect(calls).toBe(TPS_PROBE_RUNS)
    expect(sample.samples).toBe(TPS_PROBE_RUNS)
    expect(sample.tokensPerSecond).toBeGreaterThan(0)
  })

  it('keeps going when one run fails, and says so', async () => {
    let calls = 0
    const client = {
      probeChat: async () => {
        calls += 1
        if (calls === 1) throw new Error('transport died')
        const frames = [frame('x'), frame('y'), frame('z'), usageFrame(50)]
        return { ok: true, status: 200, response: new Response(streamOf(frames, 25)) }
      },
    }
    const sample = await measureTps({ client, credential: {}, modelId: 'hy3' })
    expect(sample.samples).toBe(TPS_PROBE_RUNS - 1)
    expect(sample.complete).toBe(false)
    expect(sample.tokensPerSecond).toBeGreaterThan(0)
  })

  it('never throws, even when every run does', async () => {
    const client = { probeChat: async (): Promise<never> => { throw new Error('nope') } }
    const sample = await measureTps({ client, credential: {}, modelId: 'hy3' })
    expect(sample.tokensPerSecond).toBeUndefined()
    expect(sample.reason).toBe('all-failed')
  })
})

describe('timingsOfLine, the frame grammar on its own', () => {
  it('reads content and usage from one frame', () => {
    const { content, usage } = timingsOfLine(frame('hello').trim(), 0)
    expect(content).toBe('hello')
    expect(usage).toBeUndefined()
    expect(timingsOfLine(usageFrame(7, 0.02).trim(), 0).usage).toEqual({ completion_tokens: 7, credit: 0.02 })
  })

  it('ignores everything that is not a JSON data frame', () => {
    for (const line of ['', 'event: ping', 'data: [DONE]', 'data: not json', 'data: 42', ':comment']) {
      expect(timingsOfLine(line, 0), line).toEqual({})
    }
  })

  it('treats an empty-string delta as no content', () => {
    // Several gateways open with a role-only frame carrying `content: ""`.
    // Counting it would start the clock before any token was written.
    expect(timingsOfLine(frame('').trim(), 0).content).toBeUndefined()
  })
})

describe('the clock starts before the request, not after the headers', () => {
  it('reports a real time-to-first-token, not the gap from headers', async () => {
    // MEASURED DEFECT, 2026-10-22. The first version took its `startedAt` after
    // `probeChat` resolved — i.e. when the response HEADERS arrived — so the
    // reported TTFT was "headers to first content chunk". Live, that produced
    // `timeToFirstTokenMs: 0` for two of three models: by the time the headers
    // were read, the first chunk was already buffered.
    //
    // The RATE stayed correct throughout, because it is measured first→last
    // content chunk and never uses `startedAt`. That is exactly why the bug was
    // easy to miss, and why this case exists: it fails loudly if the clock ever
    // moves back to the post-header position.
    const client = {
      probeChat: async () => {
        // The "server" takes 120ms to even start answering. A reader whose
        // clock began at the headers would report ~0 for TTFT.
        await new Promise(resolve => setTimeout(resolve, 120))
        const frames = [frame('x'), frame('y'), frame('z'), usageFrame(30)]
        return { ok: true, status: 200, response: new Response(streamOf(frames, 20)) }
      },
    }
    const sample = await measureTps({ client, credential: {}, modelId: 'hy3', runs: 1 })
    expect(sample.timeToFirstTokenMs).toBeGreaterThanOrEqual(100)
    // And the rate is still a rate: 30 tokens over ~40ms of generation.
    expect(sample.tokensPerSecond).toBeGreaterThan(0)
  })
})
