/**
 * `workbuddy_draw_image`：把 WorkBuddy 国内区的文生图能力暴露成一个 DSH agent 工具。
 *
 * 为什么手写 ToolDefinition 而不 import `@deepseek-ai/dsh-tools` 的 `defineTool`：
 * 宿主 `Tools.register` 只校验两件事——`output.render` 是函数、`output.schema` 是
 * 受支持的 JSON Schema；`schemaOf()` 把 `parameters` **原样**投影给模型。也就是说
 * raw JSON Schema 完全够用，而 `defineTool` 额外提供的只有「按 spec 编译 schema +
 * 代校验参数」这一层包装。手写换来的是：零新 peer 依赖、不需要动态 import 兜底、
 * 不会碰到 tests/host-peers.spec.ts 对 `lib/bin.js` 可达图的断言（那里禁止除
 * `node:` 外的任何裸说明符）。
 *
 * 代价是参数校验要自己做——见 {@link createImageTool} 的 execute。
 *
 * @module dsh-connect-workbuddy/image-tool
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { WorkBuddyCredential } from './auth.ts'
import {
  DEFAULT_IMAGE_SIZE,
  WorkBuddyImageError,
  pickImageModel,
  type WorkBuddyImageOutcome,
  type WorkBuddyMediaModel,
} from './image-gen.ts'

/** 工具名。宿主禁止 `run_code`，这个名字与其它 connect 插件的命名习惯一致。 */
export const WORKBUDDY_IMAGE_TOOL_NAME = 'workbuddy_draw_image'

/** 工具单次执行的上限。实测一张图 17–39 秒，留足余量。 */
const IMAGE_TOOL_TIMEOUT_MS = 180_000
/** 媒体模型目录的缓存时长：目录变化很慢，不必每张图都重新读一遍。 */
const MEDIA_MODEL_TTL_MS = 5 * 60_000
/** 失败后的冷却：生图按张扣积分，连续重试会在几秒内烧掉几十积分。 */
const FAILURE_COOLDOWN_MS = 30_000

/** 宿主 ContentBlock 的最小结构（只需要文本块）。 */
export interface ImageToolContentBlock {
  readonly type: 'text'
  readonly text: string
}

/**
 * 宿主 `ToolDefinition` 的结构子集。
 *
 * 刻意不 import 宿主的类型：`@deepseek-ai/dsh-tools` 在运行期由宿主提供，
 * 这里只描述「宿主会读哪些字段」，避免把插件绑死在某个宿主版本的类型上。
 */
export interface ImageToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): ImageToolContentBlock[]
  }
  readonly timeoutMs: number
  execute(args: unknown, exec: ImageToolExec): Promise<Record<string, unknown>>
}

/** 宿主传给 execute 的执行上下文里本工具用得到的部分。 */
export interface ImageToolExec {
  readonly signal?: AbortSignal
}

/** 工具运行所需的外部能力，全部由 `src/index.ts` 注入，便于单测替换。 */
export interface ImageToolDeps {
  /** 解析国内区凭据；未登录返回 undefined（不要抛异常）。 */
  readonly resolveCredential: () => Promise<WorkBuddyCredential | undefined>
  /** 读该凭据所属区的产品配置，返回带 text-to-image 标签的媒体模型。 */
  readonly listMediaModels: (
    credential: WorkBuddyCredential,
    signal?: AbortSignal,
  ) => Promise<readonly WorkBuddyMediaModel[]>
  /** 真正发一次生图请求。 */
  readonly generateImage: (
    credential: WorkBuddyCredential,
    request: { readonly model: string; readonly prompt: string; readonly size: string },
    signal?: AbortSignal,
  ) => Promise<WorkBuddyImageOutcome>
  readonly logger: { warn(message: string): void }
  /** 区域名，只用于报错文案（默认「国内区」）。 */
  readonly regionLabel?: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * 这些失败说明请求真的打到了上游、可能已经扣了积分，才值得进冷却。
 * 参数写错 / 未登录 / 目录里没有模型都还没花钱。
 */
/**
 * 这些失败码都发生在「请求已经发出去」之后——上游可能已经扣了积分或排了队，
 * 连续重试只会把它们再花一遍，所以进冷却。
 */
const BILLABLE_FAILURE_CODES: ReadonlySet<string> = new Set([
  'AUTH',
  'RATE_LIMIT',
  'NO_ROUTE',
  'UPSTREAM',
  'EMPTY_RESULT',
])

/**
 * 是否该进冷却——由「这一次到底有没有把生图请求发出去」决定，而不是由异常
 * 的类型反推。
 *
 * 早先的写法是「不是 WorkBuddyImageError 就算花过钱」，方向正好错了两头：
 * 读目录（`fetchMediaModels` 的那次只读 GET）失败抛的是 upstream.ts 的
 * `envelopeError`/网络错误，一分钱没花却把工具冷却 30 秒；而参数写错这类真正
 * 免费的失败又因为带着 `INVALID_ARGS` 才被放行——判据和事实不在一根轴上。
 *
 * 现在由调用点显式置位：请求发出去了才置 `sent`，冷却只看它。
 */
function isBillableFailure(error: unknown, sent: boolean): boolean {
  if (!sent) return false
  if (error instanceof WorkBuddyImageError) return BILLABLE_FAILURE_CODES.has(error.code)
  // 请求已发出之后的意外异常（读响应体时连接断了等）同样算一次真实尝试。
  return true
}

/** 把 b64 图片落成一个临时文件，返回绝对路径。 */
async function writeTempImage(b64: string, model: string): Promise<string> {
  const dir = join(tmpdir(), 'workbuddy-image-gen')
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safeModel = model.replace(/[^A-Za-z0-9._-]+/g, '_')
  const path = join(dir, `${safeModel}-${stamp}.png`)
  await writeFile(path, Buffer.from(b64, 'base64'))
  return path
}

/**
 * 造出工具定义。
 *
 * 每次 `apply()` 只造一个实例，所以冷却状态与目录缓存都挂在闭包里，
 * 生命周期跟着插件走。
 */
export function createImageTool(deps: ImageToolDeps): ImageToolDefinition {
  const regionLabel = deps.regionLabel ?? '国内区'
  let mediaCache: { readonly at: number; readonly models: readonly WorkBuddyMediaModel[] } | undefined
  let cooldownUntil = 0

  const listModels = async (
    credential: WorkBuddyCredential,
    signal?: AbortSignal,
  ): Promise<readonly WorkBuddyMediaModel[]> => {
    const now = Date.now()
    if (mediaCache !== undefined && now - mediaCache.at < MEDIA_MODEL_TTL_MS) return mediaCache.models
    const models = await deps.listMediaModels(credential, signal)
    mediaCache = { at: now, models }
    return models
  }

  return {
    name: WORKBUDDY_IMAGE_TOOL_NAME,
    description:
      '用当前账号的 WorkBuddy 生图能力画一张图（文生图）。'
      + '只在国内区账号下可用；国际区没有生图模型。'
      + '每张图会真实消耗 WorkBuddy 积分（实测约 5.71 积分/张），不要在没必要时调用，'
      + '也不要为了试错连续调用。返回的是 COS 签名 URL，约 24 小时后失效；'
      + '需要展示给用户时，用 markdown 图片语法引用该 URL。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '画面描述（中文或英文都可以）。写清楚主体、风格、构图、光线。',
        },
        size: {
          type: 'string',
          description: `图片尺寸，形如 1024x1024。默认 ${DEFAULT_IMAGE_SIZE}。`,
        },
        model: {
          type: 'string',
          description:
            '生图模型 id，可选。不填就用产品配置里第一个带 text-to-image 标签的模型'
            + '（国内区即 hunyuan-image-alpha）。填了但目录里没有会直接报错，不会盲发。',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '图片地址（COS 签名 URL，或本地 file:// 地址）。' },
          model: { type: 'string', description: '实际使用的生图模型 id。' },
          prompt: { type: 'string', description: '实际提交的画面描述。' },
          hint: { type: 'string', description: '给模型的后续提示（如何展示、链接时效）。' },
          credit: { type: 'number', description: '本次实际消耗的 WorkBuddy 积分。' },
          path: { type: 'string', description: '上游返回 base64 时，落盘的本地绝对路径。' },
        },
        required: ['url', 'model', 'prompt', 'hint'],
        additionalProperties: false,
      },
      render(_args: unknown, value: unknown): ImageToolContentBlock[] {
        const record = asRecord(value)
        const url = asNonEmptyString(record['url']) ?? ''
        const model = asNonEmptyString(record['model']) ?? 'unknown'
        const credit = typeof record['credit'] === 'number' ? record['credit'] as number : undefined
        const path = asNonEmptyString(record['path'])
        const hint = asNonEmptyString(record['hint']) ?? ''
        const lines = [
          `![WorkBuddy 生图](${url})`,
          '',
          `模型：\`${model}\`${credit === undefined ? '' : ` · 消耗 ${credit} 积分`}`,
        ]
        if (path !== undefined) lines.push(`本地文件：${path}`)
        if (hint !== '') lines.push('', hint)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: IMAGE_TOOL_TIMEOUT_MS,
    async execute(args: unknown, exec: ImageToolExec): Promise<Record<string, unknown>> {
      const record = asRecord(args)
      const prompt = asNonEmptyString(record['prompt'])
      if (prompt === undefined) {
        throw new WorkBuddyImageError(
          `${WORKBUDDY_IMAGE_TOOL_NAME}: 参数 prompt 必填，且必须是非空字符串。`,
          'INVALID_ARGS',
        )
      }
      const size = asNonEmptyString(record['size']) ?? DEFAULT_IMAGE_SIZE
      const requestedModel = asNonEmptyString(record['model'])

      const now = Date.now()
      if (now < cooldownUntil) {
        const seconds = Math.ceil((cooldownUntil - now) / 1000)
        throw new WorkBuddyImageError(
          `workbuddy image: 上一次生图刚失败过，请 ${seconds} 秒后再试`
          + '（失败冷却是为了避免连续重试白白烧积分）。',
          'COOLDOWN',
        )
      }

      const credential = await deps.resolveCredential()
      if (credential === undefined) {
        throw new WorkBuddyImageError(
          `workbuddy image: ${regionLabel}未登录 WorkBuddy。`
          + '请先在插件设置里登录国内区账号，再调用生图工具。',
          'NOT_LOGGED_IN',
        )
      }

      const signal = exec.signal === undefined
        ? AbortSignal.timeout(IMAGE_TOOL_TIMEOUT_MS)
        : AbortSignal.any([exec.signal, AbortSignal.timeout(IMAGE_TOOL_TIMEOUT_MS)])

      // 这一次到底有没有把生图请求发出去。冷却的唯一判据——见
      // `isBillableFailure` 的注释：读目录的失败一分钱没花，不该冷却。
      let sent = false
      try {
        const models = await listModels(credential, signal)
        const model = pickImageModel(models, requestedModel)
        sent = true
        const outcome = await deps.generateImage(
          credential,
          { model: model.id, prompt, size },
          signal,
        )
        const value: Record<string, unknown> = {
          model: model.id,
          prompt,
          hint:
            `这张图来自 WorkBuddy（模型 ${model.id}），每张约消耗 5.71 积分。`
            + 'COS 签名 URL 约 24 小时失效；要长期保留请及时下载。'
            + (outcome.credit === undefined ? '' : `本次实际扣费 ${outcome.credit} 积分。`),
        }
        if (outcome.url !== undefined) {
          value['url'] = outcome.url
        } else if (outcome.b64 !== undefined) {
          const path = await writeTempImage(outcome.b64, model.id)
          value['url'] = pathToFileURL(path).href
          value['path'] = path
          value['hint'] = `${value['hint'] as string} 上游返回的是内联 base64，已落盘到本地。`
        } else {
          throw new WorkBuddyImageError(
            'workbuddy image: 上游既没有返回 url 也没有返回 b64_json。',
            'EMPTY_RESULT',
          )
        }
        if (outcome.credit !== undefined) value['credit'] = outcome.credit
        return value
      } catch (error: unknown) {
        // 只有「真的发过请求」的失败才进冷却。参数写错、没登录、目录里没有模型、
        // 读目录时网络抖了一下——这些都还没花钱，冷却它们只会让用户以为工具坏了。
        if (isBillableFailure(error, sent)) cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
        throw error
      }
    },
  }
}

/** 宿主 tools 服务里本工具用到的那一个方法。 */
export interface ToolsServiceLike {
  register(definition: unknown): () => void
}

/**
 * 把工具注册进宿主。返回 disposer；调用方负责在插件卸载时调用它。
 *
 * 注册本身是同步的；`tools` 服务由宿主提供，拿不到就直接返回 undefined
 * 并记一条警告——生图工具缺失不该让整个插件起不来。
 */
export function registerWorkBuddyImageTool(
  tools: ToolsServiceLike,
  deps: ImageToolDeps,
): (() => void) | undefined {
  try {
    return tools.register(createImageTool(deps))
  } catch (error: unknown) {
    deps.logger.warn(
      `dsh-connect-workbuddy: 注册 ${WORKBUDDY_IMAGE_TOOL_NAME} 失败: `
      + (error instanceof Error ? error.message : String(error)),
    )
    return undefined
  }
}
