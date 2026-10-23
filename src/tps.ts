/**
 * Output-speed measurement: how fast does this model actually write tokens?
 *
 * WHY IT EXISTS (issue #92). Credit multiplier alone is not enough to pick a
 * model any more. DSH runs models as sub-agents, dispatched in parallel and each
 * with several round trips, so OUTPUT SPEED multiplies into wall-clock time: a
 * cheap+s low model can cost more in total than an expensive+fast one. The
 * reporter measured four models at the same x0.08 multiplier whose median output
 * speed differed by 3.8x.
 *
 * WHY IT IS A SEPARATE PROBE FROM THE AVAILABILITY ONE. The existing probe sends
 * 25,000 input tokens and caps output at ONE token: its whole job is to discover
 * the input-size rate limit, and one token says nothing about throughput — its
 * `elapsedMs` is time-to-first-byte, which is a different quantity. Measuring
 * speed needs the opposite shape: tiny input, long output.
 *
 * WHAT IT COSTS. Measured on this machine 2026-10-22 with `max_tokens: 256` and
 * ~35 input tokens: `credit 0.01`–`0.15` per run depending on the model's
 * multiplier. That is an order of magnitude BELOW the availability probe
 * (measured `credit 0.72` at 25k input), because cost scale s with input on this
 * gateway.
 *
 * WHY THREE RUNS AND A MEDIAN. Measured 2026-10-22 on `deepseek-v4.1-flash`:
 * five runs gave 406 / 405 / 419 / 423 / 411 tok/s (4% spread) — but
 * `glm-5.3-flash` gave 110 / 105 / **177** / 103 / 109 (72% spread), one clear
 * outlier. A single run would have reported that outlier as the truth. The
 * median of three discards it while still costing about a third of a cent.
 *
 * NEVER EXTRAPOLATED. A sample count is carried beside the number, and a run
 * that lost samples reports the ones it kept rather than pretending to be
 * complete.
 *
 * @module dsh-connect-workbuddy/tps
 */

/** Output tokens each speed run asks for. */
export const TPS_PROBE_MAX_TOKENS = 256

/**
 * Runs per model. Median of three, not mean: see the outlier above.
 *
 * Odd on purpose — a median of an even count is an average of two middle values,
 * which reintroduces the outlier's influence this is here to remove.
 */
export const TPS_PROBE_RUNS = 3

/**
 * Smallest spacing between content chunks, in milliseconds, that still counts
 * as generation.
 *
 * Guards the divide-by-zero case where a fast model delivers every token in a
 * single burst: `chunks === 1` means the stream told us nothing about the RATE,
 * and the run reports no speed rather than an invented one. The same applies
 * when the first and last content chunk land in the same millisecond.
 */
const MIN_GENERATION_MS = 1

/** One model's measured speed, as the card renders it. */
export interface WorkBuddyTpsSample {
  readonly modelId: string
  /**
   * Output tokens per second, measured over the generation span only.
   *
   * Omitted — never zero, never guessed — when the stream produced too few
   * chunks to time, or when the upstream never reported a completion count.
   */
  readonly tokensPerSecond?: number
  /** How many content chunks produced the number; 1 means it could not be timed. */
  readonly outputTokens?: number
  /** Median time-to-first-content-chunk across the usable runs, in milliseconds. */
  readonly timeToFirstTokenMs?: number
  /** How many runs contributed. Below {@link TPS_PROBE_RUNS} when a run failed. */
  readonly samples: number
  /** Total credit the runs reported, when the upstream said. */
  readonly credit?: number
  /** Whether every run answered; a partial run is reported as such. */
  readonly complete: boolean
  /** Why the speed is absent, when it is. */
  readonly reason?: 'few-chunks' | 'no-usage' | 'all-failed'
}

/** Build the request body for one speed run. */
export function tpsProbeRequestBody(modelId: string): string {
  return JSON.stringify({
    model: modelId,
    messages: [
      {
        role: 'system',
        content: 'You are a throughput benchmark. Output a long, uninterrupted sequence of short words separated by spaces. No preamble, no explanation, no code block.',
      },
      // The prompt asks for VOLUME, not quality, and it must be answerable
      // without thinking: a model that spends 3 seconds reasoning before writing
      // would report a slow generation rate that has nothing to do with how fast
      // it writes. Long output also pushes past any model that would otherwise
      // answer in one chunk.
      { role: 'user', content: 'List the numbers from 1 to 400 in words, separated by single spaces.' },
    ],
    max_tokens: TPS_PROBE_MAX_TOKENS,
    // Reasoning models would otherwise burn the budget on thinking and report a
    // rate for a stream that never produced content.
    ...OFF_REASONING_FIELDS,
    stream: true,
  })
}

/**
 * Ask for the lowest reasoning effort available.
 *
 * A reasoning model asked to count spends its `max_tokens` inside the reasoning
 * channel; the stream then carries thinking deltas and little or no content, and
 * timing it would measure the wrong thing. `none` is the widest supported
 * spelling; gateways that do not know it ignore the field (measured: the CN
 * gateway answers 200 with it).
 */
const OFF_REASONING_FIELDS = { reasoning_effort: 'none' } as const

/** One parsed run: what the stream told us about its own timing. */
interface RunReading {
  readonly outputTokens?: number
  readonly firstContentMs?: number
  readonly generationMs?: number
  readonly credit?: number
}

/**
 * Read one SSE stream INCREMENTALLY, timing each content deltas arrival.
 *
 * The incremental read is the measurement. `response.text()` buffers the whole
 * body and hands it over once, which erases the only signal a throughput number
 * is made of: the interval between the first and last content chunk. A version of
 * this file that parsed a buffered string reported the PARSING time, not the
 * generation time, and looked entirely plausible — which is why the reader takes
 * the response body and not a string.
 *
 * Only `choices[0].delta.content` is timed. A reasoning delta is not output:
 * counting it would report a reasoning model as fast because it produced a lot of
 * private thinking, and reasoning models are precisely the ones where the
 * distinction matters.
 *
 * `startedAt` is the caller's clock reading taken BEFORE the request went out.
 * Defaulting it to "now" would turn time-to-first-token into "time to start
 * reading" — a plausible-looking number wrong by the whole connect+TTFB.
 *
 * Never throws on a malformed frame: the upstream is allowed to send comments,
 * blank lines and `[DONE]`, and a stream that ends early still reports what it
 * timed.
 */
export async function readTimedStream(
  body: ReadableStream<Uint8Array>,
  startedAt: number,
): Promise<RunReading> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let firstAt: number | undefined
  let lastAt: number | undefined
  let usage: Record<string, unknown> | undefined
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const arrival = Date.now()
      pending += decoder.decode(value, { stream: true })
      // A chunk may hold several lines, or half of one: split on newlines and
      // KEEP the trailing partial for the next read.
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const reading = timingsOfLine(line, arrival)
        if (reading.usage !== undefined) usage = reading.usage
        if (reading.content !== undefined) {
          if (firstAt === undefined) firstAt = arrival
          lastAt = arrival
        }
      }
    }
  } catch {
    // A truncated stream still tells us what it managed to send; the caller
    // decides whether that is enough to report a number for.
  } finally {
    void reader.cancel().catch(() => {})
  }
  const outputTokens = typeof usage?.['completion_tokens'] === 'number'
    ? usage['completion_tokens'] as number
    : undefined
  const credit = typeof usage?.['credit'] === 'number' ? usage['credit'] as number : undefined
  return {
    ...outputTokens === undefined ? {} : { outputTokens },
    ...firstAt === undefined ? {} : { firstContentMs: firstAt - startedAt },
    ...firstAt === undefined || lastAt === undefined ? {} : { generationMs: lastAt - firstAt },
    ...credit === undefined ? {} : { credit },
  }
}

/**
 * What one SSE line says: whether it carried content, and any usage frame.
 *
 * Split out so the frame grammar is testable without a stream. The `arrival`
 * timestamp is threaded in by the reader, because a parser that read the clock
 * itself would be timing the parse, not the arrival.
 */
export function timingsOfLine(
  line: string,
  _arrival: number,
): { readonly content?: string, readonly usage?: Record<string, unknown> } {
  if (!line.startsWith('data:')) return {}
  const payload = line.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return {}
  let frame: unknown
  try {
    frame = JSON.parse(payload)
  } catch {
    return {}
  }
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) return {}
  const record = frame as Record<string, unknown>
  const usageField = record['usage']
  const usage = typeof usageField === 'object' && usageField !== null && !Array.isArray(usageField)
    ? usageField as Record<string, unknown>
    : undefined
  const choices = record['choices']
  const first = Array.isArray(choices) ? choices[0] : undefined
  const delta = typeof first === 'object' && first !== null
    ? (first as Record<string, unknown>)['delta']
    : undefined
  const content = typeof delta === 'object' && delta !== null
    ? (delta as Record<string, unknown>)['content']
    : undefined
  return {
    ...typeof content === 'string' && content !== '' ? { content } : {},
    ...usage === undefined ? {} : { usage },
  }
}

/** The middle value; undefined for an empty list. */
function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2)
}

/**
 * Reduce several run readings to one sample.
 *
 * The median per quantity is taken SEPARATELY rather than picking one "winner"
 * run: a run whose stream was truncated may still have timed its first chunk
 * honestly, and throwing that away would lose information for no reason. A
 * quantity with no usable reading is omitted, never filled in.
 */
export function summarizeTps(
  modelId: string,
  runs: readonly RunReading[],
  attempted: number,
): WorkBuddyTpsSample {
  const complete = runs.length === attempted && attempted > 0
  const speeds: number[] = []
  const firsts: number[] = []
  let outputTokens: number | undefined
  let credit: number | undefined
  for (const run of runs) {
    if (run.firstContentMs !== undefined) firsts.push(run.firstContentMs)
    if (run.generationMs !== undefined && run.generationMs >= MIN_GENERATION_MS
      && run.outputTokens !== undefined && run.outputTokens > 0) {
      speeds.push(run.outputTokens / (run.generationMs / 1000))
    }
    if (run.outputTokens !== undefined) outputTokens = run.outputTokens
    if (run.credit !== undefined) credit = (credit ?? 0) + run.credit
  }
  const tokensPerSecond = median(speeds.map(speed => Math.round(speed)))
  const reason: WorkBuddyTpsSample['reason'] | undefined = tokensPerSecond !== undefined
    ? undefined
    : runs.length === 0
      ? 'all-failed'
      : outputTokens === undefined
        ? 'no-usage'
        : 'few-chunks'
  return {
    modelId,
    ...tokensPerSecond === undefined ? {} : { tokensPerSecond },
    ...outputTokens === undefined ? {} : { outputTokens },
    ...median(firsts) === undefined ? {} : { timeToFirstTokenMs: median(firsts) as number },
    samples: runs.length,
    ...credit === undefined ? {} : { credit: Math.round(credit * 100) / 100 },
    complete,
    ...reason === undefined ? {} : { reason },
  }
}

/** What one speed measurement needs from the upstream client. */
export interface WorkBuddyTpsClient {
  /**
   * The same call the availability probe uses.
   *
   * Reused rather than a new transport method on purpose: the two probes differ
   * only in their BODY (tiny input + long output vs. 25k input + 1 output), and
   * a second method would duplicate credential handling, base-URL selection and
   * error classification for no benefit.
   */
  probeChat(
    credential: unknown,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean
    status: number
    body?: string
    response?: Response
  }>
}

/**
 * Measure one model's output speed.
 *
 * Runs {@link TPS_PROBE_RUNS} times and takes per-quantity medians (see
 * {@link summarizeTps} for why a median and not a mean). A failed run is dropped
 * rather than counted as zero — a model that answered twice at 400 tok/s did not
 * get slower because the third request timed out — but the sample count records
 * the shortfall so the card can say "n/3".
 *
 * Never throws: this is a diagnostic the user asked for, and a dead model must
 * produce a result row, not an exception.
 */
export async function measureTps(input: {
  client: WorkBuddyTpsClient
  credential: unknown
  modelId: string
  runs?: number
  signal?: AbortSignal
}): Promise<WorkBuddyTpsSample> {
  const runs = input.runs ?? TPS_PROBE_RUNS
  const readings: RunReading[] = []
  for (let index = 0; index < runs; index++) {
    if (input.signal?.aborted === true) break
    // The clock starts BEFORE the request goes out, which is what makes
    // time-to-first-token mean what it says. Taking it after `probeChat`
    // resolves (i.e. when the response HEADERS arrived) measured only the gap
    // from headers to first content chunk — measured live 2026-10-22, that
    // reported `timeToFirstTokenMs: 0` for two of three models, which is the
    // signature of this exact mistake: the first chunk was already buffered
    // when the clock was read.
    //
    // The RATE is unaffected either way (it is first→last content chunk), which
    // is precisely why the mistake is easy to miss: the headline number stays
    // right while the secondary one is garbage.
    const startedAt = Date.now()
    try {
      const answer = await input.client.probeChat(
        input.credential,
        tpsProbeRequestBody(input.modelId),
        input.signal,
      )
      if (!answer.ok || answer.response === undefined) continue
      readings.push(await readTimedStream(answer.response.body as ReadableStream<Uint8Array>, startedAt))
    } catch {
      // One lost run is a lost sample, not a failed measurement: the remaining
      // runs still say what the model's speed is.
      continue
    }
  }
  return summarizeTps(input.modelId, readings, runs)
}
