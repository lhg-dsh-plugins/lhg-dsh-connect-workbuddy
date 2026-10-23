/**
 * WorkBuddy 生图：纯逻辑层 + 工具定义层。
 *
 * 这份测试守的是三件事：
 *  1. **模型筛选**只认产品配置里真实的 `tags`，不猜、不补字段。夹具是 2026-10-21
 *     国内区 `/v3/config` 的 `data.models` 真实片段（62 条里只有一条
 *     `hunyuan-image-alpha` 带 `text-to-image`）。
 *  2. **请求体分支**照抄官方 CLI 的 `buildBaseRequestBody`：hunyuan 分支只加
 *     `n`，其它分支加 `response_format: 'b64_json'`。这是与上游协议对齐的关键，
 *     写错不会报错、只会静默拿到不同形状的响应。
 *  3. **工具定义**能被宿主 `Tools.register` 接受（output.render 是函数、
 *     output.schema 是 object），且 execute 的返回值严格落在 output.schema 里
 *     —— 宿主会用 `validateJsonSchemaValue(output.schema, value)` 校验，
 *     多一个字段就抛 ToolOutputError。
 */
import { describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { WorkBuddyCredential } from '../src/auth.ts'
import {
  DEFAULT_IMAGE_SIZE,
  IMAGE_TAG_IMAGE_TO_IMAGE,
  IMAGE_TAG_TEXT_TO_IMAGE,
  WorkBuddyImageError,
  buildImageBody,
  describeImageFailure,
  parseImageResponse,
  pickImageModel,
  selectMediaModels,
  type WorkBuddyMediaModel,
} from '../src/image-gen.ts'
import {
  WORKBUDDY_IMAGE_TOOL_NAME,
  createImageTool,
  registerWorkBuddyImageTool,
  type ImageToolDeps,
} from '../src/image-tool.ts'

/** 国内区 `/v3/config` 的真实片段：媒体条目只有 id/name/tags。 */
const cnModels = [
  { id: 'auto', name: 'Auto', tags: ['craft'] },
  { id: 'hunyuan-image-alpha', name: 'Hunyuan Image Alpha', tags: ['text-to-image'] },
  { id: 'hunyuan-image-alpha-edit', name: 'Hunyuan Image Alpha Edit', tags: ['image-to-image'] },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', tags: ['craft'] },
]

/** 国际区 `/v3/config` 的真实形状：一条媒体模型都没有。 */
const globalModels = [
  { id: 'hy3', name: 'Hy3', tags: ['craft'] },
  { id: 'gpt-5.5', name: 'GPT-5.5', tags: ['craft'] },
]

function credential(overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
  return {
    accessToken: 'token',
    refreshToken: 'refresh',
    expiresAtMs: Date.now() + 60_000,
    domain: 'www.codebuddy.cn',
    uid: 'u-1',
    enterpriseId: 'e-1',
    source: 'desktop',
    filePath: 'C:/tmp/workbuddy.info',
    ...overrides,
  }
}

function mediaModel(id = 'hunyuan-image-alpha'): WorkBuddyMediaModel {
  return { id, name: id, tags: [IMAGE_TAG_TEXT_TO_IMAGE] }
}

describe('selectMediaModels', () => {
  it('只挑带指定 tag 的条目，其余一律忽略', () => {
    const text = selectMediaModels(cnModels, IMAGE_TAG_TEXT_TO_IMAGE)
    expect(text.map(model => model.id)).toEqual(['hunyuan-image-alpha'])

    const edit = selectMediaModels(cnModels, IMAGE_TAG_IMAGE_TO_IMAGE)
    expect(edit.map(model => model.id)).toEqual(['hunyuan-image-alpha-edit'])
  })

  it('国际区目录没有任何生图模型', () => {
    expect(selectMediaModels(globalModels, IMAGE_TAG_TEXT_TO_IMAGE)).toEqual([])
  })

  it('按 id 去重，且 name 缺失时回退成 id', () => {
    const models = selectMediaModels([
      { id: 'a', tags: ['text-to-image'] },
      { id: 'a', name: 'dup', tags: ['text-to-image'] },
    ], IMAGE_TAG_TEXT_TO_IMAGE)
    expect(models).toHaveLength(1)
    expect(models[0]?.name).toBe('a')
  })

  it('非数组 / 非对象 / 缺 id 的条目不会让它崩', () => {
    expect(selectMediaModels(undefined, IMAGE_TAG_TEXT_TO_IMAGE)).toEqual([])
    expect(selectMediaModels([null, 42, 'x', { tags: ['text-to-image'] }], IMAGE_TAG_TEXT_TO_IMAGE)).toEqual([])
  })
})

describe('pickImageModel', () => {
  it('点名一个存在的模型就用它', () => {
    const models = [mediaModel('a'), mediaModel('b')]
    expect(pickImageModel(models, 'b').id).toBe('b')
  })

  it('不点名就用目录里的第一个', () => {
    expect(pickImageModel([mediaModel('first'), mediaModel('second')], undefined).id).toBe('first')
  })

  it('点名一个不存在的模型直接报错，并列出可用的', () => {
    try {
      pickImageModel([mediaModel('a'), mediaModel('b')], 'nope')
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(WorkBuddyImageError)
      expect((error as WorkBuddyImageError).code).toBe('NO_IMAGE_MODEL')
      expect((error as Error).message).toContain('nope')
      expect((error as Error).message).toContain('a, b')
    }
  })

  it('目录为空时报「该区没有生图模型」', () => {
    try {
      pickImageModel([], undefined)
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect((error as WorkBuddyImageError).code).toBe('NO_IMAGE_MODEL')
    }
  })
})

describe('buildImageBody', () => {
  it('hunyuan 分支只加 n，默认 1', () => {
    expect(buildImageBody({ model: 'hunyuan-image-alpha', prompt: '猫' })).toEqual({
      model: 'hunyuan-image-alpha',
      prompt: '猫',
      size: DEFAULT_IMAGE_SIZE,
      n: 1,
    })
  })

  it('hunyuan 分支透传 n，且不带 response_format', () => {
    const body = buildImageBody({ model: 'hunyuan-image-alpha', prompt: '猫', size: '512x512', n: 3 })
    expect(body).toEqual({ model: 'hunyuan-image-alpha', prompt: '猫', size: '512x512', n: 3 })
    expect(body).not.toHaveProperty('response_format')
  })

  it('gemini 分支什么都不加', () => {
    expect(buildImageBody({ model: 'gemini-3-pro-image', prompt: '猫' })).toEqual({
      model: 'gemini-3-pro-image',
      prompt: '猫',
      size: DEFAULT_IMAGE_SIZE,
    })
  })

  it('其它分支加 response_format: b64_json', () => {
    const body = buildImageBody({ model: 'openai-image-1', prompt: '猫' })
    expect(body['response_format']).toBe('b64_json')
    expect(body).not.toHaveProperty('n')
    expect(buildImageBody({ model: 'openai-image-1', prompt: '猫', n: 2 })['n']).toBe(2)
  })
})

describe('parseImageResponse', () => {
  it('取出 url / credit / created', () => {
    const outcome = parseImageResponse({
      code: 0,
      msg: 'OK',
      request_id: 'r-1',
      data: {
        created: 1750000000,
        data: [{ url: 'https://cos.example/a.png' }],
        usage: { credit: 5.71 },
      },
    })
    expect(outcome).toEqual({ url: 'https://cos.example/a.png', created: 1750000000, credit: 5.71 })
  })

  it('支持 b64_json 形态', () => {
    const outcome = parseImageResponse({
      code: 0,
      data: { data: [{ b64_json: 'AAAA' }] },
    })
    expect(outcome.b64).toBe('AAAA')
    expect(outcome.url).toBeUndefined()
  })

  it('code 非 0 是业务失败，带 msg 与 request_id', () => {
    try {
      parseImageResponse({ code: 14018, msg: 'Credits exhausted.', request_id: 'r-9' })
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect((error as WorkBuddyImageError).code).toBe('UPSTREAM')
      expect((error as Error).message).toContain('14018')
      expect((error as Error).message).toContain('Credits exhausted.')
      expect((error as Error).message).toContain('r-9')
    }
  })

  it('缺 data / data.data 为空 / 元素没有 url 与 b64 都算空结果', () => {
    expect(() => parseImageResponse({ code: 0 })).toThrow(WorkBuddyImageError)
    expect(() => parseImageResponse({ code: 0, data: { data: [] } })).toThrow(WorkBuddyImageError)
    expect(() => parseImageResponse({ code: 0, data: { data: [{}] } })).toThrow(WorkBuddyImageError)
  })
})

describe('describeImageFailure', () => {
  it('401/403 归为 AUTH 并提示重新登录', () => {
    for (const status of [401, 403]) {
      const error = describeImageFailure(status, '')
      expect(error.code).toBe('AUTH')
      expect(error.message).toContain('重新登录')
    }
  })

  it('404 归为 NO_ROUTE，并指出全球区没有生图模型', () => {
    const error = describeImageFailure(404, '')
    expect(error.code).toBe('NO_ROUTE')
    expect(error.message).toContain('全球区')
  })

  it('429 归为 RATE_LIMIT', () => {
    expect(describeImageFailure(429, '').code).toBe('RATE_LIMIT')
  })

  it('从 JSON 信封里抽出 code 与 msg', () => {
    const error = describeImageFailure(500, JSON.stringify({ code: 50001, msg: 'boom' }))
    expect(error.code).toBe('UPSTREAM')
    expect(error.message).toContain('50001')
    expect(error.message).toContain('boom')
  })

  it('非 JSON 的响应体截断后原样带上', () => {
    const error = describeImageFailure(502, '<html>bad gateway</html>')
    expect(error.message).toContain('bad gateway')
  })
})

describe('createImageTool', () => {
  function deps(overrides: Partial<ImageToolDeps> = {}): ImageToolDeps {
    return {
      resolveCredential: async () => credential(),
      listMediaModels: async () => [mediaModel()],
      generateImage: async () => ({ url: 'https://cos.example/a.png', credit: 5.71 }),
      logger: { warn: () => {} },
      ...overrides,
    }
  }

  it('形状满足宿主 Tools.register 的硬性要求', () => {
    const tool = createImageTool(deps())
    expect(tool.name).toBe(WORKBUDDY_IMAGE_TOOL_NAME)
    expect(tool.description).toContain('积分')
    expect(typeof tool.output.render).toBe('function')
    expect(tool.output.schema['type']).toBe('object')
    expect(tool.parameters['type']).toBe('object')
    expect(tool.parameters['required']).toEqual(['prompt'])
    expect(Number.isFinite(tool.timeoutMs)).toBe(true)
    expect(tool.timeoutMs).toBeGreaterThan(0)
  })

  it('execute 返回的键严格落在 output.schema 里（宿主会校验）', async () => {
    const tool = createImageTool(deps())
    const value = await tool.execute({ prompt: '一只猫' }, {})
    const schema = tool.output.schema as {
      properties: Record<string, unknown>
      required: string[]
      additionalProperties: boolean
    }
    expect(schema.additionalProperties).toBe(false)
    for (const key of Object.keys(value)) expect(schema.properties).toHaveProperty(key)
    for (const key of schema.required) expect(value).toHaveProperty(key)
    expect(value['url']).toBe('https://cos.example/a.png')
    expect(value['model']).toBe('hunyuan-image-alpha')
    expect(value['prompt']).toBe('一只猫')
    expect(value['credit']).toBe(5.71)
  })

  it('prompt 缺失或为空白 → INVALID_ARGS，且不进冷却', async () => {
    const tool = createImageTool(deps())
    await expect(tool.execute({}, {})).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    await expect(tool.execute({ prompt: '   ' }, {})).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    // 未登录/参数错误不该冷却：紧接着一次正常调用应当成功
    const value = await tool.execute({ prompt: '猫' }, {})
    expect(value['url']).toBe('https://cos.example/a.png')
  })

  it('未登录 → NOT_LOGGED_IN，并说明是国内区', async () => {
    const tool = createImageTool(deps({ resolveCredential: async () => undefined }))
    await expect(tool.execute({ prompt: '猫' }, {})).rejects.toMatchObject({ code: 'NOT_LOGGED_IN' })
  })

  it('目录里没有生图模型 → NO_IMAGE_MODEL', async () => {
    const tool = createImageTool(deps({ listMediaModels: async () => [] }))
    await expect(tool.execute({ prompt: '猫' }, {})).rejects.toMatchObject({ code: 'NO_IMAGE_MODEL' })
  })

  it('点名不存在的模型 → NO_IMAGE_MODEL，且不会发请求', async () => {
    const generateImage = vi.fn()
    const tool = createImageTool(deps({ generateImage }))
    await expect(tool.execute({ prompt: '猫', model: 'nope' }, {}))
      .rejects.toMatchObject({ code: 'NO_IMAGE_MODEL' })
    expect(generateImage).not.toHaveBeenCalled()
  })

  it('上游失败后进入冷却，第二次调用直接 COOLDOWN', async () => {
    const tool = createImageTool(deps({
      generateImage: async () => {
        throw describeImageFailure(500, 'boom')
      },
    }))
    await expect(tool.execute({ prompt: '猫' }, {})).rejects.toMatchObject({ code: 'UPSTREAM' })
    await expect(tool.execute({ prompt: '猫' }, {})).rejects.toMatchObject({ code: 'COOLDOWN' })
  })

  it('读目录时网络抖了一下 → 一分钱没花，不进冷却', async () => {
    // The cooldown must follow "did a generation request actually leave", not
    // "what type was the exception". Reading the catalog is a read-only GET that
    // spends nothing and throws a plain error (not a WorkBuddyImageError) — the
    // old rule cooled the tool for 30s on a free failure.
    let fail = true
    const tool = createImageTool(deps({
      listMediaModels: async () => {
        if (fail) throw new Error('socket hang up')
        return [mediaModel()]
      },
    }))
    await expect(tool.execute({ prompt: '猫' }, {})).rejects.toThrow(/socket hang up/)
    // Immediately retry: a free failure must not be cooling anything.
    fail = false
    const value = await tool.execute({ prompt: '猫' }, {})
    expect(value['url']).toBe('https://cos.example/a.png')
  })

  it('目录读取失败不缓存，下一次仍然真的去读', async () => {
    const listMediaModels = vi.fn(async () => {
      throw new Error('boom')
    })
    const tool = createImageTool(deps({ listMediaModels }))
    await expect(tool.execute({ prompt: '猫' }, {})).rejects.toThrow(/boom/)
    await expect(tool.execute({ prompt: '猫' }, {})).rejects.toThrow(/boom/)
    // A failed read is not cached, so both attempts really reached the reader.
    expect(listMediaModels).toHaveBeenCalledTimes(2)
  })

  it('媒体目录在 TTL 内只读一次', async () => {
    const listMediaModels = vi.fn(async () => [mediaModel()])
    const tool = createImageTool(deps({ listMediaModels }))
    await tool.execute({ prompt: '一' }, {})
    await tool.execute({ prompt: '二' }, {})
    expect(listMediaModels).toHaveBeenCalledTimes(1)
  })

  it('上游只给 b64 时落盘并返回 file:// 地址', async () => {
    const tool = createImageTool(deps({
      generateImage: async () => ({ b64: Buffer.from('hello').toString('base64') }),
    }))
    const value = await tool.execute({ prompt: '猫' }, {})
    const path = value['path'] as string
    expect(path).toBeTruthy()
    expect(existsSync(path)).toBe(true)
    expect(String(value['url'])).toContain('file://')
    expect(fileURLToPath(String(value['url']))).toBe(path)
    rmSync(path, { force: true })
  })

  it('render 输出 markdown 图片与积分说明', () => {
    const tool = createImageTool(deps())
    const blocks = tool.output.render({}, {
      url: 'https://cos.example/a.png',
      model: 'hunyuan-image-alpha',
      prompt: '猫',
      hint: '提示',
      credit: 5.71,
    })
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('text')
    expect(blocks[0]?.text).toContain('![WorkBuddy 生图](https://cos.example/a.png)')
    expect(blocks[0]?.text).toContain('5.71 积分')
  })
})

describe('registerWorkBuddyImageTool', () => {
  it('把工具交给宿主，并返回 disposer', () => {
    const register = vi.fn((_definition: unknown) => () => {})
    const dispose = registerWorkBuddyImageTool({ register }, {
      resolveCredential: async () => credential(),
      listMediaModels: async () => [mediaModel()],
      generateImage: async () => ({ url: 'u' }),
      logger: { warn: () => {} },
    })
    expect(register).toHaveBeenCalledTimes(1)
    expect(register.mock.calls[0]?.[0]).toMatchObject({ name: WORKBUDDY_IMAGE_TOOL_NAME })
    expect(typeof dispose).toBe('function')
  })

  it('宿主拒绝注册时记一条警告，不抛异常', () => {
    const warn = vi.fn()
    const dispose = registerWorkBuddyImageTool({
      register: () => {
        throw new Error('reserved name')
      },
    }, {
      resolveCredential: async () => credential(),
      listMediaModels: async () => [mediaModel()],
      generateImage: async () => ({ url: 'u' }),
      logger: { warn },
    })
    expect(dispose).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('reserved name')
  })
})
