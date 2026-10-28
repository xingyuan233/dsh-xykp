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
    silence: {
      type: 'number',
      description: 'Mute the next N notices (0 = keep them coming).',
    },
  },
}

function makeTool(takeRecall) {
  return {
    name: TOOL_NAME,
    description:
      'Decide the fate of tracked tool results. Nothing = fold them to a ⟨dropped #id⟩ stub.\n' +
      'keep: ids to keep whole; summarize: ids to replace with your text; recall: return old results as this call’s output (treated as a new untagged result, folds next step unless kept); silence: mute the next N notices.',
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
      const recall = (Array.isArray(args?.recall) ? args.recall : []).map(Number).filter((id) => Number.isFinite(id))
      const silence = Number(args?.silence)
      const got = typeof takeRecall === 'function' && recall.length ? takeRecall(recall) : { blocks: [], lost: [] }
      let text =
        `⟨decided⟩ keep ${keep.join(',') || '-'} / summary ${sum.map((s) => s.id).join(',') || '-'}` +
        (recall.length ? ` / recall ${recall.join(',')}` : '') +
        (Number.isFinite(silence) && silence > 0 ? ` / silence ${Math.floor(silence)}` : '')
      if (got.blocks.length) text += '\n\n' + got.blocks.join('\n\n')
      if (got.lost.length) text += `\n未找到：${got.lost.map((id) => '#' + id).join(' ')}`
      return { ok: true, text }
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
  const out = { keep: new Set(), summary: new Map(), recall: new Set(), silence: 0 }
  for (const block of message?.content || []) {
    if (!block || block.type !== 'tool-call' || block.name !== TOOL_NAME) continue
    const input = argsOf(block)
    for (const id of input.keep || []) out.keep.add(Number(id))
    for (const id of input.recall || []) out.recall.add(Number(id))
    const silence = Number(input.silence)
    if (Number.isFinite(silence) && silence > 0) out.silence = Math.floor(silence)
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

    const state = { pending: null, seq: seedSeq(), archive: new Map(), seen: new Set(), silenceLeft: 0, silenceEnded: false, silenceConsumedSeq: undefined }
    watched.set(agent, state)

    /** 档案：丢了原文也能召回；按条数 FIFO。 */
    const remember = (item) => {
      state.archive.set(item.id, { callId: item.callId, tool: item.tool, label: item.label, chars: item.chars, text: item.text })
      while (state.archive.size > archiveEntries) {
        const oldest = state.archive.keys().next().value
        state.archive.delete(oldest)
      }
    }

    /** 档案里没有（比如宿主重启过）→ 扫会话日志：日志保留了被替换前的完整节点。 */
    const recoverFromLog = (ids) => {
      const want = new Set(ids)
      const found = new Map()
      const re = /^\[#(\d+)\] /
      let seq = 0
      for (;;) {
        const event = agent.session.eventAt(seq)
        if (!event) break
        seq++
        if (event.type !== 'tool/result') continue
        const message = messageOf(agent.session, event)
        if (!message || message.role !== 'tool') continue
        const text = textOfMessage(message)
        const m = re.exec(text)
        if (!m) continue
        const id = Number(m[1])
        if (!want.has(id)) continue
        const callId = message.toolCallId || message.source?.callId
        if (!callId) continue
        found.set(id, { callId, tool: '?', label: 'log', chars: text.length, text: text.slice(m[0].length) })
      }
      return found
    }

    /** 召回：原文作为本次工具结果随请求带出去——不动历史节点，老消息前面的前缀缓存不受影响。 */
    const recallText = (ids) => {
      const blocks = []
      const missing = []
      for (const id of ids) {
        const entry = state.archive.get(id)
        if (entry) {
          blocks.push(`⟨#${id} ${entry.tool} · ${entry.chars} chars⟩\n${entry.text}`)
          continue
        }
        missing.push(id)
      }
      const lost = []
      if (missing.length) {
        const found = recoverFromLog(missing)
        for (const [id, entry] of found) {
          state.archive.set(id, entry)
          blocks.push(`⟨#${id} ${entry.tool} · ${entry.chars} chars（日志兜底）⟩\n${entry.text}`)
        }
        for (const id of missing) {
          if (found.has(id)) continue
          lost.push(id)
          warn(`召回 #${id} 失败：档案和日志里都没找到`)
        }
      }
      return { blocks, lost }
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
            // steward 自己的结果（回执/召回正文）以 ⟨ 开头，得 force 覆盖（占位守卫会拦）
            if (replaceResult(ctx, session, surfaceItem, text, item.tool === TOOL_NAME)) folded++
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
            ? { keep: new Set(), summary: new Map(), recall: new Set(), silence: 0 }
            : decisionsOf(message)
          if (decisions.silence > 0) {
            state.silenceLeft = decisions.silence
            state.silenceEnded = false
            state.silenceConsumedSeq = undefined
          }
          // 召回不走这里：由 steward 工具当场把原文作为结果返回（不动历史节点）
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
        if (state.seen.has(callId)) return
        const call = findCall(agent.session, callId)
        const tool = call?.name || '?'
        if (tool === TOOL_NAME) {
          // 召回正文当成「一条新结果」记账：本体不打 [#id]，但照常参与 keep / summarize / 默认折叠
          if (text.length < minChars) return
          const recalled = {
            id: ++state.seq,
            callId,
            tool,
            label: summarizeArgs(call),
            chars: text.length,
            text,
            judged: true,
            hasImage: false,
          }
          state.seen.add(callId)
          remember(recalled)
          state.pending.items.push(recalled)
          return
        }
        // 我们自己 append 的替换节点会再触发一次 tool/result：已打标 / 已是占位 都跳过
        if (text.startsWith('⟨') || /^\[#\d+\]/.test(text)) return
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
      disposers.push(agent.ctx.tools.register(makeTool(recallText)))
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
            if (state.silenceLeft > 0) {
              // 静默按「批次」算：同一批只扣一次，免得一次请求渲染多次多扣
              if (state.silenceConsumedSeq !== pending.originSeq) {
                state.silenceConsumedSeq = pending.originSeq
                state.silenceLeft--
                if (state.silenceLeft === 0) state.silenceEnded = true
              }
              return ''
            }
            const ids = items.map((item) => '#' + item.id).join(' ')
            const tail = state.silenceEnded ? '（silence 已结束）' : ''
            state.silenceEnded = false
            return '[steward] 上一步结果 ' + ids + ' 默认折叠；keep永久保留,summarize概括保留,recall拿回之前' + tail
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
            '工具结果：大结果在你看到的那一步之后会被折叠成一行 ⟨dropped #id⟩（或空结果，不意味着失败）。\n' +            '如果需要一直保留比较重要或者后面还会多次用的消息使用：steward(keep:[ids...])；如果你已经读完不再需要完整内容则进行概括之后会一直保留概括内容：steward(summarize:[{id,text}...])；如果之后想要拿回之前读过的原文：steward(recall:[ids...])。\n' + 
			'这些工具可以和其他工具一起调用，可以一起调用，重要的就保留或概括。',
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
