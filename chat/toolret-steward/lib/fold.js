// 工具结果的表面节点操作（跟官方 tool-result-pruner / toolret-forget 同一套做法）：
//   1. 记一条 compaction/prune（带被遮蔽节点的 token 估价）
//   2. append 一条同 callId 的 tool/result，surfaceOp=replace 掉原节点
// 这样 tool-call / tool-result 的配对不会断，原文仍留在会话日志里。

export function textOfMessage(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

export function hasImage(message) {
  return Array.isArray(message?.content) && message.content.some((block) => block && block.type === 'image')
}

export function listSurface(session) {
  const out = []
  for (const seq of session.surface?.nodes || []) {
    const event = session.eventAt(seq)
    if (event) out.push({ seq, event })
  }
  return out
}

export function messageOf(session, event) {
  if (event?.data?.message) return event.data.message
  try {
    return session.deriveEventMessage(event)
  } catch (error) {
    return undefined
  }
}

/** 某个 callId 属于哪条 assistant 消息（步骤）——用来判断「这是不是新的一批」。 */
export function assistantSeqOfCall(session, callId) {
  for (const item of listSurface(session)) {
    if (item.event.type !== 'assistant/message') continue
    const message = messageOf(session, item.event)
    for (const block of message?.content || []) {
      if (block && block.type === 'tool-call' && block.id === callId) return item.seq
    }
  }
  return undefined
}

/** callId → 工具名。 */
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

/** 找某个 callId 对应的 tool/result 表面节点。 */
export function resultOfCall(session, callId) {
  for (const item of listSurface(session)) {
    if (item.event.type !== 'tool/result') continue
    const message = messageOf(session, item.event)
    if (message && (message.toolCallId === callId || message.source?.callId === callId)) return item
  }
  return undefined
}

/** 把一条工具结果替换成自定义文本。返回 true 表示真的换了。 */
export function replaceResult(ctx, session, item, text) {
  const message = messageOf(session, item.event)
  if (!message || message.role !== 'tool') return false
  return replaceNode(ctx, session, item, `${text}`, message, 'tool/result')
}

/** 通用：把任意表面节点替换成一段文本（通知、决策这类也要能收掉）。 */
export function replaceNode(ctx, session, item, text, message = messageOf(session, item.event), eventType = item.event.type) {
  if (!message) return false
  const current = textOfMessage(message)
  if (current.startsWith('⟨') && current.includes('⟩')) return false // 已经是占位了

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

  const placeholder = { ...message, content: [{ type: 'text', text }] }
  session.append(
    eventType,
    { ...item.event.data, message: placeholder },
    { surfaceOp: { op: 'replace', startSeq: item.seq, endSeq: item.seq }, sourceEventSeqs: [item.seq] },
  )
  return true
}
