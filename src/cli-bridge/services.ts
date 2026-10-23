/**
 * The two host services this bridge uses, typed structurally.
 *
 * WHY NOT IMPORT THE REAL TYPES. `@deepseek-ai/dsh-tools` and the commands
 * service are provided by the Host at runtime, but neither package is a
 * dependency of this plugin, and adding one would make the plugin refuse to
 * install on a Host that does not publish it. The bridge touches a very small
 * surface — `register()` and the shape of what it registers — so declaring that
 * surface here keeps the dependency list untouched while still type-checking
 * every field the Host will actually read.
 *
 * These are deliberately MINIMAL: a field the bridge does not read is not
 * declared, so nothing here can drift into a promise the Host never made.
 *
 * @module dsh-connect-workbuddy/cli-bridge/services
 */

/** The per-call context the Host hands to a tool's `execute`. */
export interface BridgeToolExecution {
  /** Cancels the call; the bridge forwards it to the CLI child process. */
  signal?: AbortSignal
  /**
   * Reserved by the Host. As of 4.15.x it is NOT populated with the session's
   * cwd. Kept as an optional read because a future Host may start filling it.
   */
  cwd?: string
  /**
   * The agent that called the tool.
   *
   * THIS IS WHERE THE SESSION CWD COMES FROM. The Host does not put a `cwd` on
   * the execution object, but it does pass the calling agent, and the agent
   * carries the session header — whose `cwd` the session service guarantees is
   * absolute. Reading it here is what lets a turn default to the directory the
   * human is actually looking at instead of demanding one from the model.
   */
  agent?: BridgeAgentRef
}

/** The slice of a live agent both entrances read. */
export interface BridgeAgentRef {
  /** Equal to the session id; used as the per-session budget key. */
  id?: string
  status?: string
  session?: { header?: { cwd?: string } }
}

/** One tool registration, as the Host's `tools.register` accepts it. */
export interface BridgeToolDefinition {
  name: string
  description: string
  timeoutMs?: number
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): unknown
  }
  execute(args: unknown, execution: BridgeToolExecution): Promise<unknown>
}

/** The Host's tool registry. */
export interface BridgeToolsService {
  register(definition: BridgeToolDefinition): () => void
}

/** What a slash-command handler is invoked with. */
export interface BridgeCommandInvocation {
  /** The live agent the command runs against; absent on a Host that cannot supply it. */
  agent?: BridgeCommandAgent
  /** Everything the human typed after the command name, verbatim. */
  rawInput?: string
  signal?: AbortSignal
}

/** The slice of a live agent a command reads. */
export interface BridgeCommandAgent extends BridgeAgentRef {
  inject(message: unknown): void
  steer(message: unknown): void
}

/** What a command handler returns to the composer. */
export interface BridgeCommandResult {
  kind: 'success' | 'error'
  text: string
}

/** One slash-command registration. */
export interface BridgeCommandDefinition {
  name: string
  description: string
  input?: { hint?: string }
  handler(invocation: BridgeCommandInvocation): Promise<BridgeCommandResult>
}

/** The Host's command registry. */
export interface BridgeCommandsService {
  register(definition: BridgeCommandDefinition): () => void
}

/** A logging sink; matches `ctx.logger.warn` after the prefix is baked in. */
export type BridgeLog = (message: string) => void
