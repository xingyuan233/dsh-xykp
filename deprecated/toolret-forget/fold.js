// dsh-xykp · chat/toolret-forget · 纯逻辑（方便离线测）
//
// 工具结果的「折叠」：把某个 tool/result 表面节点替换成一句占位，
// 下一轮模型就看不见原文了；完整原文仍在会话日志里（可回放、可审计）。
//
// 做法跟官方 tool-result-pruner 一样：
//   1. 先记一条 compaction/prune（带被遮蔽节点的 token 估价）
//   2. 再 append 一条同 callId 的 tool/result，surfaceOp=replace 掉原节点
// 这样 tool-call / tool-result 的配对不会断。

export const FOLDED = '⟨已折叠⟩'
export const SELF_MARK = '⟨fold⟩'

export function textOfMessage(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

export function listSurface(session) {
  const out = []
  for (const seq of session.surface?.nodes || []) {
    const event = session.eventAt(seq)
    if (event) out.push({ seq, event })
  }
  return out
}

function messageOf(session, event) {
  if (event?.data?.message) return event.data.message
  try {
    return session.deriveEventMessage(event)
  } catch (error) {
    return undefined
  }
}

/** 最近的几个「带工具调用的步骤」，新的在前。step 从 1 开始。 */
export function toolSteps(session) {
  const steps = []
  for (const item of listSurface(session)) {
    if (item.event.type !== 'assistant/message') continue
    const message = messageOf(session, item.event)
    const calls = (message?.content || []).filter((block) => block && block.type === 'tool-call')
    if (!calls.length) continue
    steps.push({ seq: item.seq, calls })
  }
  return steps.reverse()
}

/** 找某个 callId 对应的 tool/result 表面节点。 */
export function resultOfCall(session, callId) {
  for (const item of listSurface(session)) {
    if (item.event.type !== 'tool/result') continue
    const message = messageOf(session, item.event)
    if (message && (message.toolCallId === callId || message.source?.callId === callId)) return item
  }
  return undefined
}

/** 反查一个 callId 是哪个工具调用的（给「默认不保留」按工具名匹配用）。 */
export function toolNameOfCall(session, callId) {
  for (const item of listSurface(session)) {
    if (item.event.type !== 'assistant/message') continue
    const message = messageOf(session, item.event)
    for (const block of message?.content || []) {
      if (block && block.type === 'tool-call' && block.id === callId) return block.name
    }
  }
  return ''
}

/** 把一条工具结果替换成占位。返回 true 表示真的折叠了。 */
export function foldResult(ctx, session, item, reason = '') {
  const message = messageOf(session, item.event)
  if (!message || message.role !== 'tool') return false
  if (textOfMessage(message).startsWith(FOLDED)) return false

  const placeholder = {
    ...message,
    content: [{ type: 'text', text: `${FOLDED} 这条工具结果没有保留${reason ? `（${reason}）` : ''}` }],
  }

  let tokens = 0
  try {
    const meter = ctx.get ? ctx.get('tokenMeter') : undefined
    if (meter && typeof meter.estimateMessage === 'function') tokens = meter.estimateMessage(message) || 0
  } catch (error) {}

  try {
    session.append('compaction/prune', {
      shadowedRange: { start: item.seq, end: item.seq },
      shadowedSeqs: [item.seq],
      shadowedTokenCount: tokens,
    })
  } catch (error) {}

  session.append(
    'tool/result',
    { ...item.event.data, message: placeholder },
    { surfaceOp: { op: 'replace', startSeq: item.seq, endSeq: item.seq }, sourceEventSeqs: [item.seq] },
  )
  return true
}

/**
 * 按「第几个步骤、其中第几个调用」来折叠。
 * @param opts.step 1 = 最近一次带工具调用的步骤
 * @param opts.forget 1 起的下标数组，或 'all'
 * @param opts.keep 1 起的下标数组（和 forget 二选一）
 * @param opts.tool 只处理这个工具名
 */
export function foldSelection(ctx, session, opts = {}) {
  const step = Number.isInteger(opts.step) && opts.step > 0 ? opts.step : 1
  // 只看「已经有结果」的步骤：模型正在调用的这一步还没结果，不算
  const steps = toolSteps(session).filter((candidate) => candidate.calls.some((call) => resultOfCall(session, call.id)))
  const target = steps[step - 1]
  if (!target) return { folded: [], missing: [], reason: `找不到第 ${step} 个已完成的工具步骤` }

  let calls = target.calls
  if (opts.tool) calls = calls.filter((call) => call.name === opts.tool)
  const total = calls.length
  if (!total) return { folded: [], missing: [], reason: '这个步骤里没有匹配的工具调用' }

  let wanted
  if (opts.forget === 'all') wanted = calls.map((_, index) => index + 1)
  else if (Array.isArray(opts.forget) && opts.forget.length) wanted = opts.forget
  else if (Array.isArray(opts.keep) && opts.keep.length) {
    const keep = new Set(opts.keep)
    wanted = calls.map((_, index) => index + 1).filter((index) => !keep.has(index))
  } else wanted = calls.map((_, index) => index + 1) // 没给就全忘（调用方要显式）

  const folded = []
  const missing = []
  for (const index of wanted) {
    const call = calls[index - 1]
    if (!call) {
      missing.push(index)
      continue
    }
    const item = resultOfCall(session, call.id)
    if (!item) {
      missing.push(index)
      continue
    }
    if (foldResult(ctx, session, item, opts.reason)) folded.push({ index, tool: call.name, callId: call.id })
  }
  return { folded, missing, total, step }
}
