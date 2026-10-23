/**
 * WorkBuddy 生图的纯逻辑层：媒体模型筛选、请求体构造、响应解析、失败描述。
 *
 * 这一层刻意不做任何网络 I/O、不引用宿主的任何包。`src/upstream.ts` 会被
 * `src/bin.ts` 静态可达（见 tests/host-peers.spec.ts 对 lib/bin.js 可达图的断言：
 * 除 `node:` 外不得出现任何裸说明符），所以任何被它引用的模块都必须保持零外部依赖。
 *
 * 上游契约照抄官方 CLI `codebuddy-lite-wb.mjs` 的 ImageService（实测 2026-10-21，
 * 国内区 `copilot.tencent.com` 与 `www.workbuddy.cn` 两个入口逐字段同答）：
 *
 *   POST {endpoint}/v2/images/generations
 *   body = { model, prompt, size, ...按 model 前缀分支的字段 }
 *   resp = { code, msg, request_id?, data: { created, data: [{ url } | { b64_json }],
 *            usage: { credit } } }
 *
 * 前缀分支（`buildBaseRequestBody` 原文行为）：
 *   - `hunyuan-*`：额外只带 `n`（默认 1）/ `footnote` / `revise`
 *   - `gemini-*`  ：什么都不加
 *   - 其它        ：`response_format: 'b64_json'` + 可选 `n` / `quality` / `style` / `background`
 *
 * 国内区产品配置里带 `text-to-image` 标签的只有 `hunyuan-image-alpha`，
 * 带 `image-to-image` 的只有 `hunyuan-image-alpha-edit`，因此实际走的就是
 * hunyuan 分支、响应里是 COS 签名 URL（24h 有效），单张约 5.71 credits。
 *
 * @module dsh-connect-workbuddy/image-gen
 */

/** 产品配置里「文生图」模型的标签。 */
export const IMAGE_TAG_TEXT_TO_IMAGE = 'text-to-image'
/** 产品配置里「图生图 / 改图」模型的标签。 */
export const IMAGE_TAG_IMAGE_TO_IMAGE = 'image-to-image'
/** 官方 CLI 的默认尺寸。 */
export const DEFAULT_IMAGE_SIZE = '1024x1024'
/** 生图路由。 */
export const IMAGE_GENERATIONS_PATH = '/v2/images/generations'
/** 改图路由（本版未接进工具，先把常量放在这里，供二期使用）。 */
export const IMAGE_EDITS_PATH = '/v2/images/edits'

/**
 * 产品配置 `data.models` 里的一个媒体模型条目。
 *
 * 实测上游只给三个字段（`{"id":"hunyuan-image-alpha","name":"Hunyuan Image Alpha",
 * "tags":["text-to-image"]}`），没有 credits、没有上下文长度。不要在这里补
 * 上游没有的字段——那正是「不猜」红线的反面。
 */
export interface WorkBuddyMediaModel {
  readonly id: string
  readonly name: string
  readonly tags: readonly string[]
}

/** 一次生图请求的可变部分。 */
export interface WorkBuddyImageRequest {
  readonly model: string
  readonly prompt: string
  readonly size?: string
  readonly n?: number
}

/** 上游成功响应的归一化结果。`url` 与 `b64` 至少有一个。 */
export interface WorkBuddyImageOutcome {
  readonly url?: string
  readonly b64?: string
  readonly created?: number
  readonly credit?: number
}

/** 生图链路的错误码。调用方据此决定是提示登录、提示换模型还是原样透传。 */
export type WorkBuddyImageErrorCode =
  | 'INVALID_ARGS'
  | 'NOT_LOGGED_IN'
  | 'NO_IMAGE_MODEL'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'NO_ROUTE'
  | 'UPSTREAM'
  | 'EMPTY_RESULT'
  | 'COOLDOWN'

/** 生图链路的错误。带一个稳定的 `code`，避免调用方去匹配文案。 */
export class WorkBuddyImageError extends Error {
  readonly code: WorkBuddyImageErrorCode

  constructor(message: string, code: WorkBuddyImageErrorCode) {
    super(message)
    this.name = 'WorkBuddyImageError'
    this.code = code
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const text = asString(item)
    if (text !== undefined) out.push(text)
  }
  return out
}

/**
 * 从产品配置的 `data.models` 里挑出带指定 tag 的媒体模型。
 *
 * 去重按 `id`：上游目录里同一个 id 只应出现一次，但目录是外部数据，
 * 重复条目不该让卡片或工具参数里出现两个同名选项。
 */
export function selectMediaModels(
  rawModels: unknown,
  tag: string = IMAGE_TAG_TEXT_TO_IMAGE,
): WorkBuddyMediaModel[] {
  if (!Array.isArray(rawModels)) return []
  const out: WorkBuddyMediaModel[] = []
  const seen = new Set<string>()
  for (const entry of rawModels) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const id = asString(record['id'])
    if (id === undefined || seen.has(id)) continue
    const tags = stringList(record['tags'])
    if (!tags.includes(tag)) continue
    seen.add(id)
    out.push({ id, name: asString(record['name']) ?? id, tags })
  }
  return out
}

/**
 * 选出生图模型：优先用调用方点名的那个，否则用目录里的第一个。
 *
 * 点名的模型必须在目录里——不在目录里就直接报错，而不是把它发上去让上游
 * 回一个「route config not found」。这样报错信息能指出真正的问题（模型名写错
 * 或该区没有这个模型），而不是一句上游 404。
 */
export function pickImageModel(
  models: readonly WorkBuddyMediaModel[],
  requested: string | undefined,
): WorkBuddyMediaModel {
  if (requested !== undefined && requested !== '') {
    const found = models.find(model => model.id === requested)
    if (found === undefined) {
      const known = models.map(model => model.id).join(', ')
      throw new WorkBuddyImageError(
        `workbuddy image: 目录里没有生图模型「${requested}」。可用：${known === '' ? '（空）' : known}`,
        'NO_IMAGE_MODEL',
      )
    }
    return found
  }
  const first = models[0]
  if (first === undefined) {
    throw new WorkBuddyImageError(
      'workbuddy image: 该区账号的产品配置里没有任何带 text-to-image 标签的模型。'
      + '国内区应有 hunyuan-image-alpha；国际区当前没有生图模型。',
      'NO_IMAGE_MODEL',
    )
  }
  return first
}

/** 按官方 CLI 的 `buildBaseRequestBody` 分支规则拼请求体。 */
export function buildImageBody(request: WorkBuddyImageRequest): Record<string, unknown> {
  const model = request.model
  const body: Record<string, unknown> = {
    model,
    prompt: request.prompt,
    size: request.size ?? DEFAULT_IMAGE_SIZE,
  }
  if (model.startsWith('hunyuan-')) {
    body['n'] = request.n ?? 1
    return body
  }
  if (model.startsWith('gemini-')) return body
  body['response_format'] = 'b64_json'
  if (request.n !== undefined) body['n'] = request.n
  return body
}

/**
 * 解析生图响应。
 *
 * 信封是 `{code, msg, request_id, data}`；`code !== 0` 是业务失败（与 HTTP 状态
 * 无关，上游可能 HTTP 200 但 code 非 0）。`data.data` 是数组，元素要么带 `url`
 * 要么带 `b64_json`；`data.usage.credit` 是本次实际扣的积分。
 */
export function parseImageResponse(payload: unknown): WorkBuddyImageOutcome {
  if (typeof payload !== 'object' || payload === null) {
    throw new WorkBuddyImageError('workbuddy image: 上游返回的不是 JSON 对象', 'UPSTREAM')
  }
  const envelope = payload as Record<string, unknown>
  const code = typeof envelope['code'] === 'number' ? envelope['code'] : undefined
  if (code !== undefined && code !== 0) {
    const message = asString(envelope['msg']) ?? 'unknown error'
    const requestId = asString(envelope['request_id'])
    throw new WorkBuddyImageError(
      `workbuddy image: 上游拒绝（code ${code}）: ${message}`
      + (requestId === undefined ? '' : `（request_id ${requestId}）`),
      'UPSTREAM',
    )
  }
  const data = envelope['data']
  if (typeof data !== 'object' || data === null) {
    throw new WorkBuddyImageError('workbuddy image: 响应缺少 data 字段', 'UPSTREAM')
  }
  const record = data as Record<string, unknown>
  const items = Array.isArray(record['data']) ? record['data'] : []
  const first = items.length > 0 ? items[0] : undefined
  let url: string | undefined
  let b64: string | undefined
  if (typeof first === 'object' && first !== null) {
    const item = first as Record<string, unknown>
    url = asString(item['url'])
    b64 = asString(item['b64_json'])
  }
  if (url === undefined && b64 === undefined) {
    throw new WorkBuddyImageError(
      'workbuddy image: 上游返回成功但 data.data 里既没有 url 也没有 b64_json',
      'EMPTY_RESULT',
    )
  }
  const usage = typeof record['usage'] === 'object' && record['usage'] !== null
    ? record['usage'] as Record<string, unknown>
    : {}
  const credit = typeof usage['credit'] === 'number' && Number.isFinite(usage['credit'])
    ? usage['credit'] as number
    : undefined
  const created = typeof record['created'] === 'number' ? record['created'] as number : undefined
  return {
    ...url === undefined ? {} : { url },
    ...b64 === undefined ? {} : { b64 },
    ...created === undefined ? {} : { created },
    ...credit === undefined ? {} : { credit },
  }
}

/** 把一次非 2xx 的响应翻成带 `code` 的错误，好让上层决定怎么提示。 */
export function describeImageFailure(status: number, bodyText: string): WorkBuddyImageError {
  const text = bodyText.trim()
  let detail = text.slice(0, 240)
  // 上游错误体通常是 JSON 信封；能把 msg 抽出来就用 msg，抽不出就原样截断。
  if (text.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        const message = asString(record['msg'])
        const code = typeof record['code'] === 'number' ? record['code'] : undefined
        if (message !== undefined) detail = code === undefined ? message : `code ${code}: ${message}`
      }
    } catch {
      // 保留截断后的原文
    }
  }
  if (status === 401 || status === 403) {
    return new WorkBuddyImageError(
      `workbuddy image: 凭据被上游拒绝（HTTP ${status}），请在插件设置里重新登录 WorkBuddy。${detail === '' ? '' : ` ${detail}`}`,
      'AUTH',
    )
  }
  if (status === 429) {
    return new WorkBuddyImageError(
      `workbuddy image: 触发上游限流（HTTP 429），稍后再试。${detail === '' ? '' : ` ${detail}`}`,
      'RATE_LIMIT',
    )
  }
  if (status === 404) {
    return new WorkBuddyImageError(
      `workbuddy image: 上游没有这条生图路由（HTTP 404）。全球区没有生图模型，请用国内区账号。${detail === '' ? '' : ` ${detail}`}`,
      'NO_ROUTE',
    )
  }
  return new WorkBuddyImageError(
    `workbuddy image: 上游失败（HTTP ${status}）${detail === '' ? '' : `: ${detail}`}`,
    'UPSTREAM',
  )
}
