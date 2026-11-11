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
import { configFor } from '../../ui/store.js'

export const name = 'senses-screenshot'
export const inject = ['tools']

// fmt=auto 的判定阈值；home/xykp/senses-screenshot/config.yml 的 senses-screenshot.auto 会覆盖这里的默认值。
const CONFIG_FALLBACK = {
  auto: {
    png_max_uniq: 0.12,
    jpg_min_uniq: 0.55,
    flat_text: 0.45,
    edge_dense: 0.02,
    uniq_mid: 0.35,
    thumb: 256,
  },
}

const PYTHON = process.env.DSH_SENSES_PYTHON || 'D:\\Program-Files\\Python\\312\\python.exe'
const SERVER = fileURLToPath(new URL('./server.py', import.meta.url))
const HOME = process.env.DSH_HOME || 'D:\\AI\\DeepseekHarness\\home'
// 子进程的 cwd 落在这里：驱动/库往 cwd 写的日志（NVIDIA umdlogs 等）不会再污染插件目录。
const DATA_DIR = join(HOME, 'xykp', 'senses-screenshot')

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
  window: { type: 'string', description: '标题子串或 hwnd；缺省=整屏' },
  region: { type: 'string', description: '"x,y,w,h" 物理像素' },
  capture: {
    type: 'string',
    enum: ['auto', 'desktop', 'window'],
    default: 'auto',
    description: '先窗口后退桌面',
  },
  client: { type: 'boolean', default: true, description: '只取客户区' },
  child: { type: 'boolean', default: false, description: '抓最大子窗口' },
  fmt: {
    type: 'string',
    enum: ['png', 'jpg', 'auto'],
    default: 'auto',
    description: 'png 文字/UI，jpg 照片',
  },
  quality: { type: 'number', default: 95, description: 'jpg 质量 1-100' },
  max_side: { type: 'integer', default: 1568, description: '长边上限，<=0 不缩' },
  list_windows: { type: 'boolean', default: false, description: '只列窗口，不截图' },
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
        '截屏返回图片，不落盘。window=标题/hwnd，region="x,y,w,h"，都不给=整屏。' +
        '图上坐标 × 1/scale + region 原点 = 屏幕坐标。',
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
        else {
          // 不传 fmt 就走 auto：按画面内容自选，阈值来自配置
          call.fmt = 'auto'
          call.auto = JSON.stringify(configFor('senses-screenshot', CONFIG_FALLBACK).auto)
        }
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
