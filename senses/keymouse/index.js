// dsh-xykp · senses/keymouse
//
// 两个原生工具：
//   mouse_input    —— 移动/点击/连点/长按/拖曳/滚轮/窗口聚焦/查光标
//   keyboard_input —— 组合键、输入文本
//
// 后端沿用同目录 server.py（ctypes 调 SendInput），
// 通过 lib/mcp-bridge.mjs 走 stdio，工具名对外是干净的 mouse_input / keyboard_input。

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { McpBridge, contentToText } from '../lib/mcp-bridge.mjs'

export const name = 'senses-keymouse'
export const inject = ['tools']

const PYTHON = process.env.DSH_SENSES_PYTHON || 'D:\\Program-Files\\Python\\312\\python.exe'
const SERVER = fileURLToPath(new URL('./server.py', import.meta.url))
const HOME = process.env.DSH_HOME || 'D:\\AI\\DeepseekHarness\\home'
// 子进程 cwd 固定在 home 下，插件目录保持干净（更新插件不丢数据）。
const DATA_DIR = join(HOME, 'xykp', 'senses', 'keymouse')

function log(msg) {
  console.error(`[senses-keymouse] ${msg}`)
}

const MOUSE_ACTIONS = ['move', 'click', 'multi_click', 'long_press', 'drag', 'scroll', 'focus_window', 'info']

const mouseParameters = {
  action: {
    type: 'string',
    enum: MOUSE_ACTIONS,
    required: true,
    description:
      'move 移动 / click 点击（count>1 即连点）/ multi_click 连点 / long_press 长按 / drag 拖曳 / ' +
      'scroll 滚轮 / focus_window 窗口切前台 / info 查光标与前台窗口',
  },
  x: { type: 'number', description: '目标点 x；传 window 时是客户区坐标，否则虚拟桌面物理像素' },
  y: { type: 'number' },
  x1: { type: 'number' },
  y1: { type: 'number' },
  x2: { type: 'number' },
  y2: { type: 'number' },
  button: { type: 'string', enum: ['left', 'right', 'middle'], description: '默认 left' },
  count: { type: 'number', description: '点击次数，默认 1；multi_click 默认 3' },
  interval: { type: 'number', description: '连点间隔秒，默认 0.08' },
  hold: { type: 'number', description: '每次按下保持秒数，默认 0（立即松开）' },
  duration: { type: 'number', description: 'long_press 按住秒数（默认 0.6）/ drag 拖曳总时长秒（默认 0.4）' },
  steps: { type: 'number', description: 'drag 中间移动步数，默认 24' },
  amount: { type: 'number', description: '滚轮格数，正数向上/向右，负数向下/向左' },
  horizontal: { type: 'boolean', description: '滚轮是否横向' },
  window: {
    type: 'string',
    description: '窗口标题子串（纯数字当 hwnd）：按该窗口客户区坐标算，且发送前不强制切前台',
  },
}

const mouseOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
  },
  render(_args, value) {
    return [{ type: 'text', text: String(value?.text ?? '') }]
  },
}

const keyboardParameters = {
  action: {
    type: 'string',
    enum: ['key', 'type_text'],
    required: true,
    description: 'key 按组合键（如 ctrl+c、alt+tab、enter）/ type_text 输入一段文本（支持中文）',
  },
  keys: { type: 'string', description: 'key 动作的键，组合键用 + 连接，如 "ctrl+shift+s"；默认 enter' },
  hold: { type: 'number', description: '每个键按住秒数，默认 0.05' },
  text: { type: 'string', description: 'type_text 要输入的文本' },
  interval: { type: 'number', description: 'type_text 每个字符的间隔秒，默认 0.02' },
}

const keyboardOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
  },
  render(_args, value) {
    return [{ type: 'text', text: String(value?.text ?? '') }]
  },
}

/** 有值才写进调用参数，避免把 undefined 发给后端。 */
function pick(args, keys) {
  const out = {}
  for (const key of keys) {
    if (args[key] !== undefined && args[key] !== null) out[key] = args[key]
  }
  return out
}

function need(args, names, action) {
  const missing = names.filter((key) => args[key] === undefined || args[key] === null)
  if (missing.length) throw new Error(`mouse_input(action="${action}") 缺少参数：${missing.join(', ')}`)
}

function describe(action, args) {
  const at = args.x !== undefined && args.y !== undefined ? `(${args.x}, ${args.y})` : ''
  switch (action) {
    case 'move':
      return `鼠标移到 ${at}`
    case 'click':
      return `点击 ${at}${args.button && args.button !== 'left' ? `（${args.button}）` : ''}${args.count > 1 ? ` ×${args.count}` : ''}`
    case 'multi_click':
      return `连点 ${at} ×${args.count ?? 3}`
    case 'long_press':
      return `长按 ${at} ${args.duration ?? 0.6}s`
    case 'drag':
      return `拖曳 (${args.x1}, ${args.y1}) → (${args.x2}, ${args.y2})`
    case 'scroll':
      return `滚轮 ${args.amount ?? 1} 格${args.horizontal ? '（横向）' : ''}`
    case 'focus_window':
      return `窗口切前台：${args.window}`
    case 'info':
      return '输入状态'
    default:
      return action
  }
}

async function runMouse(bridge, args) {
  const action = args.action
  let raw
  switch (action) {
    case 'move':
      need(args, ['x', 'y'], action)
      raw = ['move', pick(args, ['x', 'y', 'window'])]
      break
    case 'click':
      need(args, ['x', 'y'], action)
      raw = ['click', pick(args, ['x', 'y', 'button', 'count', 'interval', 'hold', 'window'])]
      break
    case 'multi_click':
      need(args, ['x', 'y'], action)
      raw = ['multi_click', pick(args, ['x', 'y', 'count', 'interval', 'button', 'window'])]
      break
    case 'long_press':
      need(args, ['x', 'y'], action)
      raw = ['long_press', pick(args, ['x', 'y', 'duration', 'button', 'window'])]
      break
    case 'drag':
      need(args, ['x1', 'y1', 'x2', 'y2'], action)
      raw = ['drag', pick(args, ['x1', 'y1', 'x2', 'y2', 'duration', 'steps', 'button', 'window'])]
      break
    case 'scroll':
      raw = ['scroll', pick(args, ['amount', 'x', 'y', 'horizontal', 'window'])]
      break
    case 'focus_window':
      need(args, ['window'], action)
      raw = ['focus_window', pick(args, ['window'])]
      break
    case 'info':
      raw = ['input_info', {}]
      break
    default:
      throw new Error(`未知的 mouse_input 动作：${action}`)
  }
  const result = await bridge.callTool(raw[0], raw[1])
  return { text: `${describe(action, args)}\n${contentToText(result)}`.trim() }
}

async function runKeyboard(bridge, args) {
  const action = args.action
  let raw
  if (action === 'key') {
    raw = ['key', pick(args, ['keys', 'hold'])]
    if (!raw[1].keys) raw[1].keys = 'enter'
  } else if (action === 'type_text') {
    need(args, ['text'], action)
    raw = ['type_text', pick(args, ['text', 'interval'])]
  } else {
    throw new Error(`未知的 keyboard_input 动作：${action}`)
  }
  const result = await bridge.callTool(raw[0], raw[1])
  const summary = action === 'key' ? `按键 ${raw[1].keys}` : `输入文本（${String(args.text).length} 字）`
  return { text: `${summary}\n${contentToText(result)}`.trim() }
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
    clientName: 'dsh-senses-keymouse',
    log,
  })

  const unregisterMouse = ctx.tools.register(
    defineTool({
      name: 'mouse_input',
      description:
        '操作鼠标：move 移动 / click 点击（count 即连点）/ long_press 长按 / drag 拖曳 / scroll 滚轮 / ' +
        'focus_window 窗口切前台 / info 查光标与前台窗口。坐标默认虚拟桌面物理像素，' +
        '传 window 时是该窗口客户区坐标。截图缩小过就用返回的 scale 换算；没有撤销，先 move 确认再 click。',
      parameters: mouseParameters,
      output: mouseOutput,
      async execute(args = {}) {
        return runMouse(bridge, args)
      },
    }),
  )

  const unregisterKeyboard = ctx.tools.register(
    defineTool({
      name: 'keyboard_input',
      description:
        '操作键盘：key 按单个键或组合键（"ctrl+c"、"alt+tab"、"enter"），' +
        'type_text 输入一段文本（Unicode，支持中文）。要激活目标窗口先用 mouse_input(action="focus_window")。',
      parameters: keyboardParameters,
      output: keyboardOutput,
      async execute(args = {}) {
        return runKeyboard(bridge, args)
      },
    }),
  )

  const teardown = () => {
    for (const unregister of [unregisterMouse, unregisterKeyboard]) {
      try {
        unregister?.()
      } catch {}
    }
    bridge.dispose()
  }
  if (typeof ctx.on === 'function') ctx.on('dispose', teardown)
  log('已注册 mouse_input / keyboard_input')
}
