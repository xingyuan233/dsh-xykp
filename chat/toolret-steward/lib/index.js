// 工具结果的去留管家（toolret-steward）
//
// 目标：每步的工具结果，模型当步已经看过了；下一步要不要留着由它自己说。
//   - 默认：下一条 assistant 消息之后，没表态的结果就被丢掉（emptyStub 时是空串）
//   - 保留：steward(keep: [1,3])
//   - 概括：steward(summarize: [{ index: 2, text: '...' }])
//
// 哪些工具参与决策由 mode 决定：
//   mode: blacklist（默认）—— tools 里列的工具不参与决策，只保留头尾
//   mode: whitelist       —— 只有 tools 里列的工具参与决策，其余原样不动
//
// 时机：
//   工具结果落地 → 记进 pending（先不动，模型这一步还要看）
//   下一条 assistant 消息出现 → 解析它里面的 steward 调用 → 按决定处理 pending
//
// 配置（profile 那一行的 config）：
//   presets    哪些预设生效（default ['standard']；空数组 = 全部）
//   mode       blacklist（默认）| whitelist
//   tools      见 mode
//   minChars   小于这个长度的结果不打扰也不折叠（default 2000）
//   headChars / tailChars  不参与决策的工具保留的长度（default 1200 / 400）
//   emptyStub  丢弃时换成空串（default true；false 时留一句 ⟨dropped⟩ 线索）
import { listSurface, messageOf, textOfMessage, hasImage, assistantSeqOfCall, resultOfCall, replaceResult } from './fold.js'

export const name = 'toolret-steward'
export const inject = ['agents', 'agentPresets', 'tools']

const PREFIX = '[toolret-steward]'
const log = (...args) => console.log(PREFIX, ...args)
const warn = (...args) => console.warn(PREFIX, ...args)

const TOOL_NAME = 'steward'

const parameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    keep: {
      type: 'array',
      items: { type: 'number' },
      description: 'Indices to keep as-is (1-based, from the steward notice).',
    },
    summarize: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'number', description: 'Index from the steward notice.' },
          text: { type: 'string', description: 'Your summary to keep instead of the raw result.' },
        },
        required: ['index', 'text'],
      },
      description: 'Replace these results with your own summary.',
    },
  },
}

function makeTool() {
  return {
    name: TOOL_NAME,
    description:
      'Decide what happens to the previous step’s tool results. Nothing here = drop them next round.\n' +
      'keep: indices to keep whole. summarize: indices to replace with your own text.\n' +
      'Indices come from the steward notice that follows the tool results.',
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, text: { type: 'string' } } },
      render(_args, value) {
        return [{ type: 'text', text: String(value?.text ?? '') }]
      },
    },
    async execute(args) {
      const keep = Array.isArray(args?.keep) ? args.keep : []
      const sum = Array.isArray(args?.summarize) ? args.summarize : []
      return { ok: true, text: `⟨decided⟩ keep ${keep.join(',') || '-'} / summary ${sum.map((s) => s.index).join(',') || '-'}` }
    },
  }
}

function clip(text, max) {
  if (typeof text !== 'string') return ''
  if (text.length <= max) return text
  return text.slice(0, max) + '\n…'
}

/** tool-call 的参数是 JSON 字符串（不是对象，也不是 input 字段）。 */
function argsOf(block) {
  if (!block) return {}
  if (block.input && typeof block.input === 'object') return block.input
  const raw = block.arguments
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    return {}
  }
}

/** 从一条 assistant 消息里读出 steward 调用的参数。 */
function decisionsOf(message) {
  const out = { keep: new Set(), summary: new Map() }
  for (const block of message?.content || []) {
    if (!block || block.type !== 'tool-call' || block.name !== TOOL_NAME) continue
    const input = argsOf(block)
    for (const index of input.keep || []) out.keep.add(Number(index))
    for (const entry of input.summarize || []) {
      if (entry && Number.isInteger(Number(entry.index)) && typeof entry.text === 'string') out.summary.set(Number(entry.index), entry.text)
    }
  }
  return out
}

export function apply(ctx, config = {}) {
  // mode/presets 管「哪些预设生效」；tools 永远是「不碰的名单」（只留头尾）
  const blacklist = String(config.mode ?? 'blacklist').toLowerCase() !== 'whitelist'
  const presets = new Set(Array.isArray(config.presets) ? config.presets : [])
  const minChars = Number.isFinite(config.minChars) ? config.minChars : 2000
  const headChars = Number.isFinite(config.headChars) ? config.headChars : 1200
  const tailChars = Number.isFinite(config.tailChars) ? config.tailChars : 400
  const emptyStub = config.emptyStub !== false
  const listed = new Set(Array.isArray(config.tools) ? config.tools : [])
  const refreshMs = Number.isFinite(config.refreshMs) ? config.refreshMs : 3000

  /** 这个工具的结果要不要进决策流程（tools 里的一律不碰）。 */
  const decides = (tool) => !listed.has(tool)
  /** 这个工具的结果要不要做「头尾保留」。 */
  const trims = (tool) => listed.has(tool)

  const watched = new Map()

  const allowed = (agent) => {
    if (!presets.size) return true // 名单为空 = 全部预设
    try {
      const id = ctx.agentPresets?.composedPreset?.(agent.ctx)
      if (!id) return blacklist
      return blacklist ? !presets.has(id) : presets.has(id)
    } catch (error) {
      return false
    }
  }

  const watch = (agent) => {
    if (!agent || watched.has(agent)) return
    if (!allowed(agent)) return

    const state = { pending: null, counter: 0 }
    watched.set(agent, state)

    const finalize = (decisions) => {
      const pending = state.pending
      state.pending = null
      state.counter = 0
      if (!pending || pending.items.length === 0) return
      queueMicrotask(() => {
        const session = agent.session
        let folded = 0
        for (const item of pending.items) {
          const surfaceItem = resultOfCall(session, item.callId)
          if (!surfaceItem) continue
          let text
          if (item.index === 0) {
            // 不参与决策的工具：只留头尾
            text = clip(item.text, headChars) + '\n…\n' + (item.text || '').slice(-tailChars)
          } else if (decisions.keep.has(item.index)) {
            continue
          } else if (decisions.summary.has(item.index)) {
            text = `⟨summary⟩ ${clip(decisions.summary.get(item.index), 4000)}\n(original: ${item.tool} ${item.label}, ${item.chars} chars — re-run/read if you need the raw text)`
          } else if (emptyStub) {
            text = ''
          } else {
            text = `⟨dropped⟩ ${item.tool} ${item.label} (${item.chars} chars) — re-read/rerun if you need it`
          }
          try {
            if (replaceResult(ctx, session, surfaceItem, text)) folded++
          } catch (error) {
            warn('替换失败：', error?.message || error)
          }
        }
        if (folded) log(`处理上一步 ${folded} 条结果`)
      })
    }

    const onEvent = (event) => {
      try {
        if (!event) return
        if (event.type === 'assistant/message') {
          const message = event.data?.message
          if (!message || message.role !== 'assistant') return
          const calls = (message.content || []).filter((b) => b && b.type === 'tool-call')
          finalize(calls.length === 0 ? { keep: new Set(), summary: new Map() } : decisionsOf(message))
          return
        }
        if (event.type !== 'tool/result') return
        const message = event.data?.message
        if (!message || message.role !== 'tool') return
        const callId = message.toolCallId || message.source?.callId
        if (!callId) return
        const originSeq = assistantSeqOfCall(agent.session, callId)
        if (state.pending && originSeq !== state.pending.originSeq) {
          finalize({ keep: new Set(), summary: new Map() })
        }
        if (!state.pending) state.pending = { originSeq, items: [] }
        const text = textOfMessage(message)
        const call = findCall(agent.session, callId)
        const tool = call?.name || '?'
        const judge = decides(tool)
        if (!judge && !trims(tool)) return
        const item = {
          index: 0,
          callId,
          tool,
          label: summarizeArgs(call),
          chars: text.length,
          text,
          hasImage: hasImage(message),
        }
        if (item.chars < minChars && !item.hasImage) return
        if (judge) item.index = ++state.counter
        state.pending.items.push(item)
      } catch (error) {
        warn('处理会话事件失败：', error?.message || error)
      }
    }

    const disposers = []
    try {
      disposers.push(agent.ctx.tools.register(makeTool()))
      disposers.push(
        agent.ctx.systemPrompt.context({
          name: 'toolret-steward',
          order: 950,
          text: () => {
            const pending = state.pending
            const items = (pending?.items || []).filter((item) => item.index > 0)
            if (items.length === 0) return ''
            const lines = items.map(
              (item) => `${item.index}. ${item.tool} ${item.label} — ${item.hasImage ? 'image' : item.chars + ' chars'}`,
            )
            return (
              '[steward] 上一步的大结果，默认下一轮丢弃（原文你已经看过）：\n' +
              lines.join('\n') +
              '\n每条独立决定：保留写 steward(keep:[序号])；换成你的概括写 steward(summarize:[{index,text}])；没表态的那条下一轮就丢。'
            )
          },
        }),
      )
      agent.ctx.on('session/event', (_subject, event) => onEvent(event))
      agent.ctx.on('dispose', () => {
        watched.delete(agent)
        for (const off of disposers) {
          try {
            if (typeof off === 'function') off()
          } catch (error) {}
        }
      })
      log(`已挂到会话 ${agent.session?.id || agent.id}`)
    } catch (error) {
      watched.delete(agent)
      warn('挂载失败：', error?.message || error)
    }
  }

  try {
    ctx.on('agent/created', (payload) => watch(payload?.agent))
  } catch (error) {}
  try {
    for (const agent of ctx.agents.list()) watch(agent)
  } catch (error) {}
  const timer = setInterval(() => {
    try {
      for (const agent of ctx.agents.list()) watch(agent)
    } catch (error) {}
  }, refreshMs)
  if (typeof timer.unref === 'function') timer.unref()
  ctx.on('dispose', () => clearInterval(timer))

  log(
    `就绪：预设名单 ${[...presets].join('/') || '(空=全部)'}，模式 ${blacklist ? 'blacklist（名单外的预设都生效）' : 'whitelist（只有名单内的生效）'}，` +
      `不碰的工具 ${[...listed].join('/') || '(无)'}，阈值 ${minChars}，emptyStub ${emptyStub}`,
  )
}

/** 从 surface 里找到一次调用的 name/input。 */
function findCall(session, callId) {
  for (const item of listSurface(session)) {
    if (item.event.type !== 'assistant/message') continue
    const message = messageOf(session, item.event)
    for (const block of message?.content || []) {
      if (block && block.type === 'tool-call' && block.id === callId) return block
    }
  }
  return undefined
}

/** 参数压成一行短标签，塞进占位里方便回查。 */
function summarizeArgs(block) {
  const input = argsOf(block)
  const keys = ['file_path', 'path', 'pattern', 'command', 'url', 'bvid', 'job_id', 'agent_id', 'description']
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.length > 0) return clip(value.replace(/\s+/g, ' '), 80)
  }
  return ''
}
