/**
 * Handing a finished CLI turn back to the session's model.
 *
 * WHY THIS EXISTS. `/codebuddy` runs in the Host: the model never sees the line,
 * never sees CodeBuddy's answer, and — worse — never learns that files in its own
 * workspace may have just changed. A model that believes it is looking at an
 * untouched tree will reason confidently about code that is no longer there. So
 * after a successful turn the outcome is queued for the model as ONE message
 * that names CodeBuddy and the directory it ran in (see `composeContinuation`).
 *
 * WHY `inject` AND WHY SOMETIMES `steer`. DSH's public `Agent.inject(message)`
 * queues model-facing context for the next pre-step **without waking the
 * driver** — which is exactly right when a turn is already running (the message
 * lands at the next step boundary, no interruption) and exactly wrong when the
 * session is idle (the message would sit in the inbox forever and the command
 * would look like it silently did nothing). The phase split is therefore:
 * running → `inject()`, idle → `steer()` (same call, one argument different:
 * it wakes the driver and starts the single turn that reads this message).
 *
 * "Accepted by the driver" is NOT "the model has read it": a cancellation or a
 * disposal can still discard pending context. The outcome says which of the two
 * happened and never claims more.
 *
 * @module dsh-connect-workbuddy/cli-bridge/inject
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { redactCliText } from './redact.ts'

/**
 * A second scrubbing pass on the way into the transcript.
 *
 * `runAgent` already scrubbed what it returned, so why twice? Because this is the
 * last point before the text becomes a permanent message in the session history,
 * and the path from the CLI to here goes through a result object that other code
 * (now or later) can populate. Scrubbing at the boundary that matters is cheap;
 * discovering a token in a saved transcript is not.
 */
function redactInjected(text: string): string {
  return redactCliText(text)
}

/** Bound on one injected message. A reply can be long; a runaway one is a bug. */
export const INJECT_TEXT_LIMIT = 200_000

/**
 * The `source.kind` stamped on every message this module writes.
 *
 * This used to be `'user'`, on the reading that `MessageSource` is a closed
 * union and `'user'` is the only slot a plugin-written turn message can occupy.
 * That reading was wrong. `MessageSourceMap` is MERGE-EXTENSIBLE — its own doc
 * comment says "each producer declares its own `kind` in its own module; there
 * is no shared catch-all `plugin` kind", and consumers fall through unknown
 * kinds — so `'user'` was never the only option, it was the dishonest one: the
 * transcript rendered the injected CodeBuddy result as a user bubble, and the
 * UI had no way to label the row as a notification. `dsh-connect-atomcode`
 * stamps `'atomcode-bridge'` for exactly this reason.
 *
 * The declaration that makes the union accept it lives in
 * `src/dsh-llm-augment.d.ts`.
 *
 * `PROVENANCE_LINE` still opens the text: the kind is what the UI and later
 * readers key on, but the text is what the MODEL reads, and a model cannot see
 * `source`.
 */
export const INJECT_SOURCE_KIND = 'codebuddy-bridge'

/** The first line of every injected message. Not decoration: the model never
 * sees `source.kind`, so this line is its only provenance signal. */
export const PROVENANCE_LINE = '[dsh-connect-workbuddy · 由 /codebuddy 自动回注，不是用户输入]'

/**
 * An instruction appended so a model does not turn the result into a loop.
 *
 * The first draft ended with 「据此继续」, which is an instruction to keep going —
 * and the obvious way to "keep going" after a CodeBuddy review is to ask
 * CodeBuddy again. Each lap spends another account quota. The wording below
 * closes that door explicitly: read the result, use it, and do not re-run the
 * same bridge to chase it.
 */
const NO_LOOP_NOTE =
  '这条结论已经完成，不要为了"再确认一次"而重复调用 codebuddy_ask 或 /codebuddy —— ' +
  '每一次调用都会真实消耗一份 CodeBuddy 额度。只有出现新的、不重复的问题时才再发起一轮。'

/**
 * The slice of a live agent this module needs.
 *
 * Structural rather than imported: the bridge must keep mounting on a Host that
 * does not export the agent type, and `inject`/`steer` are the only two calls it
 * makes.
 */
export interface BridgeAgent {
  status?: string
  inject(message: unknown): void
  steer(message: unknown): void
}

/** One tool the turn called, and how many times. */
export interface ToolTally {
  name: string
  count: number
}

/** What the model is told about the turn, besides the reply itself. */
export interface ContinuationMeta {
  dir?: string
  scope?: string
  toolCalls?: number
  tools?: readonly ToolTally[]
}

/** Every refusal this module can produce, by name. */
const REFUSALS = {
  'agent-not-live': '拿不到这个会话的 agent，结论没有交给模型',
  'text-required': '这一轮没有可交给模型的输出',
  'text-too-large': `输出超过 ${String(INJECT_TEXT_LIMIT)} 字符，没有交给模型`,
  'inject-failed': '把结论交给模型时出错',
} as const

export type RefusalCode = keyof typeof REFUSALS

/** A named refusal — never a silent no-op (the failure has to be sayable). */
function refuse(code: RefusalCode, detail?: string): { ok: false; code: RefusalCode; error: string } {
  const base = REFUSALS[code]
  return { ok: false, code, error: detail !== undefined && detail !== '' ? `${base}：${detail}` : base }
}

/** A delivery that was accepted by the driver. */
export interface InjectionAccepted {
  ok: true
  delivered: 'next-step' | 'new-turn'
  woke: boolean
  messageId: string
}

/** A delivery that did not happen, named. */
export interface InjectionRefused {
  ok: false
  code: RefusalCode
  error: string
}

export type InjectionOutcome = InjectionAccepted | InjectionRefused

/**
 * The message handed to the model after a CodeBuddy turn.
 *
 * Two things it must carry and one it must not claim. It carries WHERE the turn
 * ran and WHAT it was asked to do (without them the model reads a conclusion it
 * cannot place), and it says the turn may have changed files — that is the whole
 * reason a model needs to hear about it. It does NOT claim the human asked the
 * model to do anything: the command was human-to-CodeBuddy, so "continue your
 * original task" would be a fiction. The model is told to use the result if it
 * bears on the work and to stay quiet otherwise.
 */
export function composeContinuation(reply: string, meta: ContinuationMeta = {}): string {
  const dir = typeof meta.dir === 'string' && meta.dir.trim() !== '' ? meta.dir.trim() : ''
  const scope = typeof meta.scope === 'string' && meta.scope.trim() !== '' ? meta.scope.trim() : ''
  const tools = Array.isArray(meta.tools) ? meta.tools : []
  const toolList =
    tools.length > 0
      ? tools.map(tool => (tool.count > 1 ? `${tool.name}×${String(tool.count)}` : tool.name)).join('、')
      : '无'
  const toolCalls = typeof meta.toolCalls === 'number' ? meta.toolCalls : 0

  const lines: Array<string | null> = [
    PROVENANCE_LINE,
    'CodeBuddy（另一个独立的 AI 编程助手，跑在本机真实的 CodeBuddy CLI 上）刚完成一次任务。',
    dir === '' ? null : `工作目录：${dir}`,
    scope === '' ? null : `交给它的指令：${scope}`,
    '',
    '--- CodeBuddy 输出开始 ---',
    reply,
    '--- CodeBuddy 输出结束 ---',
    '',
    `这一轮它用了 ${String(toolCalls)} 次工具调用（${toolList}），可能已经改动了工作区里的文件。`,
    '如果这与当前任务有关，就用这些结论继续；如果无关，用一两句话向用户说明即可，不要重复它已经做过的事。',
    NO_LOOP_NOTE,
  ]
  return lines.filter((line): line is string => line !== null).join('\n')
}

/**
 * Deliver the "CodeBuddy finished, here is what it said" message to the agent.
 *
 * An ABSENT status is read as running — the conservative direction. A message
 * that parks is recoverable (the next turn picks it up); an extra model turn
 * costs money and cannot be taken back. Only a positive `'idle'` earns the wake.
 */
export function injectOutcome(agent: BridgeAgent | undefined, input: {
  reply?: unknown
  dir?: unknown
  scope?: unknown
  toolCalls?: unknown
  tools?: unknown
}): InjectionOutcome {
  if (agent === undefined) return refuse('agent-not-live')

  if (typeof input.reply !== 'string' || input.reply.trim() === '') return refuse('text-required')
  if (input.reply.length > INJECT_TEXT_LIMIT) return refuse('text-too-large')

  const scope = typeof input.scope === 'string' ? input.scope : ''
  const text = composeContinuation(redactInjected(input.reply.trim()), {
    ...(typeof input.dir === 'string' ? { dir: input.dir } : {}),
    ...(scope !== '' ? { scope: redactInjected(scope) } : {}),
    ...(typeof input.toolCalls === 'number' ? { toolCalls: input.toolCalls } : {}),
    ...(Array.isArray(input.tools) ? { tools: input.tools as readonly ToolTally[] } : {}),
  })

  try {
    // `content` is `readonly ContentBlock[]`, NOT a string: a bare string has no
    // `.some`, so the step that consumes it dies with `content.some is not a
    // function` and the UI shows one 「未知内容块」 per character. `TextBlock` is
    // exactly `{ type: 'text', text }`.
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: INJECT_SOURCE_KIND },
    })
    const idle = agent.status === 'idle'
    if (idle) agent.steer(message)
    else agent.inject(message)
    return {
      ok: true,
      delivered: idle ? 'new-turn' : 'next-step',
      woke: idle,
      messageId: String((message as { id?: unknown }).id ?? ''),
    }
  } catch (error) {
    return refuse('inject-failed', error instanceof Error ? error.message : String(error))
  }
}

/**
 * Render a delivery outcome as the one line a command result carries.
 *
 * The human pressed enter and must learn whether the model was told — "the
 * command worked" and "the model knows" are different facts, and conflating
 * them is how a silent failure goes unnoticed for a week.
 */
export function formatInjection(outcome: InjectionOutcome): string {
  if (!outcome.ok) return `[未能通知模型继续：${outcome.code} — ${outcome.error}]`
  return outcome.woke
    ? '[已唤醒会话模型：CodeBuddy 的结论已交给它继续]'
    : '[结论已排队交给模型，随这一轮的下一个步骤或下一轮生效]'
}
