// 工具结果的去留管家（toolret-steward）
//
// 目标：每步的工具结果，模型当步已经看过了；下一步要不要留着由它自己说。
//   - 结果一落地就在最前面打上 [#id] 标签，id 是全局单调的
//   - 默认：下一条 assistant 消息之后，没表态的结果就被折叠成一行 ⟨dropped #id⟩
//   - 保留：steward(keep: [7])                —— id 来自结果本体的 [#7] 标签
//   - 概括：steward(summarize: [{ id: 7, text: '...' }])
//   - 召回：steward(recall: [7])              —— 从内存档案把原文铺回 surface
//
// 哪些工具参与决策由 mode 决定：
//   mode: blacklist（默认）—— tools 里列的工具不参与决策，只保留头尾
//   mode: whitelist       —— 只有 tools 里列的工具参与决策，其余原样不动
//
// 时机：
//   工具结果落地 → 记进 pending 与 archive（先不动，模型这一步还要看）
//   下一条 assistant 消息出现 → 解析它里面的 steward 调用 → 按决定处理 pending / 召回
//
// 配置（profile 那一行的 config）：
//   presets    哪些预设生效（空数组 = 全部）
//   mode       blacklist（默认）| whitelist
//   tools      见 mode
//   minChars   小于这个长度的结果不打扰也不折叠（default 2000）
//   headChars / tailChars  不参与决策的工具保留的长度（default 1200 / 400）
//   emptyStub  丢弃时换成空串（default false；留 ⟨dropped #id⟩ 线索）
//   archiveEntries  召回档案保留多少条（default 80，按条数 FIFO）
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
      description: 'Result ids to keep as-is (from the steward notice).',
    },
    summarize: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'number', description: 'Result id from the steward notice.' },
          text: { type: 'string', description: 'Your summary to keep instead of the raw result.' },
        },
        required: ['id', 'text'],
      },
      description: 'Replace these results with your own summary.',
    },
    recall: {
      type: 'array',
      items: { type: 'number' },
      description: 'Bring dropped results back by id (older steps included).',
    },
  },
}

function makeTool() {
  return {
    name: TOOL_NAME,
    description:
      'Decide the fate of tracked tool results. Nothing = fold them to a ⟨dropped #id⟩ stub.\n' +
      'keep: ids to keep whole; summarize: ids to replace with your text; recall: ids to re-inflate.',
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
      const recall = Array.isArray(args?.recall) ? args.recall : []
      return {
        ok: true,
        text: `⟨decided⟩ keep ${keep.join(',') || '-'} / summary ${sum.map((s) => s.id).join(',') || '-'} / recall ${recall.join(',') || '-'}`,
      }
    },
  }
}

function clip(text, max) {
  if (typeof text !== 'string') return ''
  if (text.length <= max) return text
  return text.slice(0, max) + '\n…'
}

/** 结果本体上的 id 标签（不能用 ⟨…⟩，否则 fold 的占位守卫会拒绝后续替换）。 */
const tag = (id) => '[#' + id + '] '

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
  const out = { keep: new Set(), summary: new Map(), recall: new Set() }
  for (const block of message?.content || []) {
    if (!block || block.type !== 'tool-call' || block.name !== TOOL_NAME) continue
    const input = argsOf(block)
    for (const id of input.keep || []) out.keep.add(Number(id))
    for (const id of input.recall || []) out.recall.add(Number(id))
    for (const entry of input.summarize || []) {
      if (entry && Number.isInteger(Number(entry.id)) && typeof entry.text === 'string') out.summary.set(Number(entry.id), entry.text)
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
  const emptyStub = config.emptyStub === true
  const archiveEntries = Number.isFinite(config.archiveEntries) ? config.archiveEntries : 80
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

    // 续号：同一会话重启后 seq 从 0 会撞历史里的旧 [#id]，先扫 surface 取最大值
    const seedSeq = () => {
      let max = 0
      try {
        for (const item of listSurface(agent.session)) {
          if (item.event.type !== 'tool/result') continue
          const head = textOfMessage(messageOf(agent.session, item.event)).slice(0, 40)
          const tagged = /^\[#(\d+)\]/.exec(head)
          if (tagged) {
            max = Math.max(max, Number(tagged[1]))
            continue
          }
          const stub = /^⟨(?:dropped|summary) #(\d+)/.exec(head)
          if (stub) max = Math.max(max, Number(stub[1]))
        }
      } catch (error) {}
      return max
    }

    const state = { pending: null, seq: seedSeq(), archive: new Map(), seen: new Set() }
    watched.set(agent, state)

    /** 档案：丢了原文也能召回；按条数 FIFO。 */
    const remember = (item) => {
      state.archive.set(item.id, { callId: item.callId, tool: item.tool, label: item.label, chars: item.chars, text: item.text })
      while (state.archive.size > archiveEntries) {
        const oldest = state.archive.keys().next().value
        state.archive.delete(oldest)
      }
    }

    const applyRecall = (ids) => {
      for (const id of ids) {
        const entry = state.archive.get(id)
        if (!entry) continue
        const surfaceItem = resultOfCall(agent.session, entry.callId)
        if (!surfaceItem) continue
        const current = textOfMessage(messageOf(agent.session, surfaceItem.event))
        if (!current.startsWith('⟨')) continue // 还完整着，不用召回
        try {
          replaceResult(ctx, agent.session, surfaceItem, tag(id) + entry.text, true)
        } catch (error) {
          warn('召回失败：', error?.message || error)
        }
      }
    }

    const finalize = (decisions) => {
      const pending = state.pending
      state.pending = null
      if (!pending || pending.items.length === 0) return
      queueMicrotask(() => {
        const session = agent.session
        let folded = 0
        for (const item of pending.items) {
          const surfaceItem = resultOfCall(session, item.callId)
          if (!surfaceItem) continue
          let text
          if (!item.judged) {
            // 不参与决策的工具：只留头尾
            text = clip(item.text, headChars) + '\n…\n' + (item.text || '').slice(-tailChars)
          } else if (decisions.keep.has(item.id)) {
            continue
          } else if (decisions.summary.has(item.id)) {
            text = `⟨summary #${item.id}⟩ ${clip(decisions.summary.get(item.id), 4000)}\n(raw #${item.id}: ${item.tool} ${item.label}, ${item.chars} chars — steward(recall:[${item.id}]) 取原文)`
          } else if (emptyStub) {
            text = ''
          } else {
            text = `⟨dropped #${item.id} ${item.tool} ${item.label} · ${item.chars} chars⟩`
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
          const decisions = calls.length === 0
            ? { keep: new Set(), summary: new Map(), recall: new Set() }
            : decisionsOf(message)
          if (decisions.recall.size) applyRecall(decisions.recall)
          finalize(decisions)
          return
        }
        if (event.type !== 'tool/result') return
        const message = event.data?.message
        if (!message || message.role !== 'tool') return
        const callId = message.toolCallId || message.source?.callId
        if (!callId) return
        const originSeq = assistantSeqOfCall(agent.session, callId)
        if (state.pending && originSeq !== state.pending.originSeq) {
          finalize({ keep: new Set(), summary: new Map(), recall: new Set() })
        }
        if (!state.pending) state.pending = { originSeq, items: [] }
        const text = textOfMessage(message)
        // 我们自己 append 的替换节点会再触发一次 tool/result：已打标 / 已是占位 / 处理过的 call 都跳过
        if (text.startsWith('⟨') || /^\[#\d+\]/.test(text)) return
        if (state.seen.has(callId)) return
        const call = findCall(agent.session, callId)
        const tool = call?.name || '?'
        const judged = decides(tool)
        if (!judged && !trims(tool)) return
        const item = {
          id: 0,
          callId,
          tool,
          label: summarizeArgs(call),
          chars: text.length,
          text,
          judged,
          hasImage: hasImage(message),
        }
        if (item.chars < minChars && !item.hasImage) return
        item.id = ++state.seq
        state.seen.add(callId)
        remember(item)
        state.pending.items.push(item)
        // 结果本体打标：id 跟着结果走，不是只在末尾通知里出现
        if (!item.hasImage) {
          queueMicrotask(() => {
            const surfaceItem = resultOfCall(agent.session, callId)
            if (!surfaceItem) return
            try {
              replaceResult(ctx, agent.session, surfaceItem, tag(item.id) + text, false, true)
            } catch (error) {
              warn('打标失败：', error?.message || error)
            }
          })
        }
      } catch (error) {
        warn('处理会话事件失败：', error?.message || error)
      }
    }

    const disposers = []
    try {
      disposers.push(agent.ctx.tools.register(makeTool()))
    } catch (error) {
      // 同一个 agent 只挂一次；失败也不再重试，避免每 3 秒刷屏
      warn('挂载失败（tools）：', error?.message || error)
      return
    }
    try {
      disposers.push(
        agent.ctx.systemPrompt.context({
          name: 'toolret-steward',
          order: 950,
          text: () => {
            const pending = state.pending
            const items = (pending?.items || []).filter((item) => item.judged)
            if (items.length === 0) return ''
            const ids = items.map((item) => '#' + item.id).join(' ')
            return '[steward] 上一步结果 ' + ids + ' 默认折叠；keep:[#id] 留，summarize:[{id,text}] 概括'
          },
        }),
      )
    } catch (error) {
      warn('context 注册失败：', error?.message || error)
    }
    try {
      disposers.push(
        agent.ctx.systemPrompt.section({
          name: 'toolret-steward:howto',
          order: 1,
          text:
            '工具结果：大结果在你看到的那一步之后会被折叠成一行 ⟨dropped #id⟩（空结果同理，不等于失败，失败会带错误码）。\n' +
            '想留：steward(keep:[#id])；想概括：steward(summarize:[{id,text}])；事后要原文：steward(recall:[#id])。',
        }),
      )
    } catch (error) {
      warn('section 注册失败：', error?.message || error)
    }
    try {
      agent.ctx.on('session/event', (_subject, event) => onEvent(event))
      agent.ctx.on('dispose', () => {
        watched.delete(agent)
        for (const off of disposers) {
          try {
            if (typeof off === 'function') off()
          } catch (error) {}
        }
      })
    } catch (error) {
      warn('事件监听失败：', error?.message || error)
    }
    log(`已挂到会话 ${agent.session?.id || agent.id}`)
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
      `不碰的工具 ${[...listed].join('/') || '(无)'}，阈值 ${minChars}，emptyStub ${emptyStub}，档案 ${archiveEntries} 条`,
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
