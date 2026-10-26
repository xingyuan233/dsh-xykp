// dsh-xykp · senses/screenshot
//
// 原生工具 screenshot_acquire：DXGI 抓屏，图片以 attachment 形式直接进对话，
// 不落盘、不需要 read_image。
//
// 后端沿用同目录的 server.py（原来的 MCP server，dxcam 抓帧逻辑没变），
// 这里用 lib/mcp-bridge.mjs 以 stdio 调它，然后把结果重新包装成「原生工具」。
// 这样模型看到的工具名就是 screenshot_acquire，而不是 mcp__screen__screenshot。

import { fileURLToPath } from 'node:url' // eslint-disable-line
import { McpBridge, contentToText, firstImage } from '../lib/mcp-bridge.mjs'

export const name = 'senses-screenshot'
export const inject = ['tools']

const PYTHON = process.env.DSH_SENSES_PYTHON || 'D:\\Program-Files\\Python\\312\\python.exe'
const SERVER = fileURLToPath(new URL('./server.py', import.meta.url))
const DIR = fileURLToPath(new URL('./', import.meta.url))

const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
}

const parameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    window: {
      type: 'string',
      description: '窗口标题子串，抓这个窗口（例如 "记事本"）。留空 = 整屏。',
    },
    region: {
      type: 'string',
      description: '裁剪区域 "x,y,w,h"，物理像素，相对主屏左上角；例如 "0,0,640,360"。',
    },
    client: {
      type: 'boolean',
      description: 'window 模式下只抓客户区（游戏内容区，不含标题栏），默认 true。',
    },
    fmt: {
      type: 'string',
      enum: ['png', 'jpg'],
      description: 'png 无损，适合文字/UI（默认）；jpg 体积小，适合连续追帧。',
    },
    quality: {
      type: 'integer',
      description: 'jpg 质量 1-100，默认 95。png 忽略。',
    },
    max_side: {
      type: 'integer',
      description: '长边上限，超过就等比缩小，默认 1568；<=0 表示不缩。返回文本里带 scale。',
    },
    list_windows: {
      type: 'boolean',
      description: 'true 时只列当前可见窗口（标题/位置/大小），不截图——用它挑 window 参数。',
    },
  },
}

const output = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string' },
      image: IMAGE_VALUE_SCHEMA,
    },
  },
  render(_args, value) {
    const blocks = [{ type: 'text', text: String(value?.text ?? '') }]
    if (value?.image) blocks.push({ type: 'image', attachment: value.image })
    return blocks
  },
}

function log(msg) {
  console.error(`[senses-screenshot] ${msg}`)
}

/** 只有图片输入被模型声明支持时才把图塞进结果。 */
async function imageCapable(ctx, exec) {
  try {
    const llm = ctx.get?.('llm')
    const routed = exec?.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec?.agent?.options?.provider
    const model = routed?.model ?? exec?.agent?.options?.model
    if (!llm || !provider || !model) return false
    const info = await llm.resolveModelInfo(provider, model, exec?.signal)
    return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
  } catch {
    return false
  }
}

export function apply(ctx) {
  const bridge = new McpBridge({
    command: PYTHON,
    args: [SERVER],
    cwd: DIR,
    clientName: 'dsh-senses-screenshot',
    log,
  })

  const unregister = ctx.tools.register({
    name: 'screenshot_acquire',
    description:
      '截屏并直接把图片返回给你（DXGI 抓屏，不落盘）。' +
      '可以整屏、指定窗口（window=标题子串）、或裁剪区域（region="x,y,w,h"）。' +
      '想先知道有哪些窗口，用 list_windows=true 只列窗口。' +
      '返回文本里带 capture region 和 scale：图上量到的坐标乘以 1/scale、再加 region 原点，' +
      '就是屏幕坐标，可以直接交给 mouse_input。',
    parameters,
    output,
    isConcurrencySafe: () => true,
    async execute(args = {}, exec) {
      if (args.list_windows) {
        const result = await bridge.callTool('screen_info')
        return { text: contentToText(result) || '(没有可见窗口)' }
      }

      const call = { client: args.client !== false }
      if (typeof args.window === 'string' && args.window.trim()) call.window = args.window.trim()
      if (typeof args.region === 'string' && args.region.trim()) call.region = args.region.trim()
      if (args.fmt === 'png' || args.fmt === 'jpg') call.fmt = args.fmt
      if (Number.isFinite(args.quality)) call.quality = Math.max(1, Math.min(100, Math.trunc(args.quality)))
      if (Number.isFinite(args.max_side)) call.max_side = Math.trunc(args.max_side)

      const result = await bridge.callTool('screenshot', call)
      const text = contentToText(result) || '(截图完成，但后端没有返回文本说明)'
      const image = firstImage(result)
      if (!image) return { text }

      if (!(await imageCapable(ctx, exec))) {
        return { text: `${text}\n（当前模型没有声明图片输入，这次只返回文字信息）` }
      }

      const attachments = ctx.get?.('attachments')
      if (!attachments) return { text: `${text}\n（没有挂载 attachments 服务，图片无法进入对话）` }

      const mediaType = image.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png'
      const data = Buffer.from(image.data, 'base64')
      const [ref] = await attachments.saveImages([
        { data, mediaType, name: mediaType === 'image/jpeg' ? 'screenshot.jpg' : 'screenshot.png' },
      ])
      return {
        text,
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
        },
      }
    },
  })

  const teardown = () => {
    try {
      unregister?.()
    } catch {}
    bridge.dispose()
  }
  if (typeof ctx.on === 'function') ctx.on('dispose', teardown)
  log('已注册 screenshot_acquire')
}
