// dsh-xykp · senses/screenshot
//
// 原生工具 screenshot_acquire：
//   - desktop 抓法走 dxcam（DXGI 桌面复制），裁剪出 region / 窗口所在区域；
//   - window 抓法直接读窗口自己的画面（PrintWindow → BitBlt 兜底），被遮挡也能截。
// 图片以 attachment 形式直接进对话，不落盘、不需要 read_image。

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { McpBridge, contentToText, firstImage } from '../lib/mcp-bridge.mjs'

export const name = 'senses-screenshot'
export const inject = ['tools']

const PYTHON = process.env.DSH_SENSES_PYTHON || 'D:\\Program-Files\\Python\\312\\python.exe'
const SERVER = fileURLToPath(new URL('./server.py', import.meta.url))
const HOME = process.env.DSH_HOME || 'D:\\AI\\DeepseekHarness\\home'
// 子进程的 cwd 落在这里：驱动/库往 cwd 写的日志（NVIDIA umdlogs 等）不会再污染插件目录。
const DATA_DIR = join(HOME, 'xykp', 'senses', 'screenshot')

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
  window: {
    type: 'string',
    description: '窗口标题子串（不分大小写；纯数字当 hwnd）。留空且无 region = 整屏',
  },
  region: {
    type: 'string',
    description: '"x,y,w,h"，物理像素，相对主屏左上角。与 window 二选一',
  },
  capture: {
    type: 'string',
    enum: ['auto', 'desktop', 'window'],
    description:
      'desktop 裁桌面（被遮挡就截到遮挡物）；window 直接读窗口画面（被遮挡/在后台也能截）；' +
      'auto 有 window 时先试 window，失败退回 desktop。默认 auto',
  },
  client: { type: 'boolean', description: 'window 模式只取客户区（游戏内容区），默认 true' },
  child: {
    type: 'boolean',
    description: 'window 模式直接抓最大的子窗口（模拟器、内嵌画面）；默认 false = 先顶层，读不到再试子窗口',
  },
  fmt: {
    type: 'string',
    enum: ['png', 'jpg'],
    description: 'png 无损，适合文字/UI（默认）；jpg 体积小，适合连续追帧',
  },
  quality: { type: 'number', description: 'jpg 质量 1-100，默认 95；png 忽略' },
  max_side: { type: 'integer', description: '长边上限，超过就等比缩小，默认 1568；<=0 表示不缩' },
  list_windows: { type: 'boolean', description: 'true 时只列可见窗口（标题/hwnd/位置/大小），不截图' },
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
  try {
    mkdirSync(DATA_DIR, { recursive: true })
  } catch (err) {
    log(`建数据目录失败（继续用进程 cwd）：${err.message}`)
  }

  const bridge = new McpBridge({
    command: PYTHON,
    args: [SERVER],
    cwd: DATA_DIR,
    clientName: 'dsh-senses-screenshot',
    log,
  })

  const unregister = ctx.tools.register(
    defineTool({
      name: 'screenshot_acquire',
      description:
        '截屏并直接把图片返回（不落盘）。window=标题子串（或 hwnd）抓窗口，region="x,y,w,h" 裁区域，都不给是整屏。' +
        'capture=window 读窗口自身画面，被遮挡也能截；独占全屏/GPU 合成窗口可能空白，auto 会退回桌面裁剪。' +
        '返回文本带 region 和 scale：图上坐标 × 1/scale + region 原点 = 屏幕坐标；client 模式下就是 mouse_input(window=…) 的客户区坐标。',
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
        if (args.capture === 'auto' || args.capture === 'desktop' || args.capture === 'window') {
          call.capture = args.capture
        }
        if (args.child === true) call.child = true
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
    }),
  )

  const teardown = () => {
    try {
      unregister?.()
    } catch {}
    bridge.dispose()
  }
  if (typeof ctx.on === 'function') ctx.on('dispose', teardown)
  log('已注册 screenshot_acquire')
}
