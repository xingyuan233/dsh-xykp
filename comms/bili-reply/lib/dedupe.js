// bili-reply · 去重与消息构造（纯逻辑，方便自测）

/** 一条收件在 seen 表里的键：有 rpid 用 rpid，没有就用来源 id */
export function keyOf(item = {}) {
  const kind = String(item.kind || 'x')
  if (item.rpid) return `${kind}:${item.rpid}`
  if (item.id) return `${kind}:${item.id}`
  return `${kind}:${item.at || 0}:${String(item.content || '').slice(0, 24)}`
}

/**
 * 从拉到的列表里挑出「还没推过」的。
 * @param {Array} items
 * @param {Record<string, {n:number, replied?:boolean, lastAt?:number}>} seen
 * @param {{maxPerPoll?:number}} [cfg]
 */
export function pickFresh(items = [], seen = {}, cfg = {}) {
  const max = Math.max(1, Number(cfg.maxPerPoll) || 10)
  const fresh = []
  const skipped = []
  for (const it of items) {
    const k = keyOf(it)
    const rec = seen[k]
    if (rec) {
      skipped.push({ key: k, reason: rec.replied ? 'replied' : 'already-seen' })
      continue
    }
    fresh.push({ ...it, key: k })
    if (fresh.length >= max) break
  }
  return { fresh, skipped }
}

/** 把一条收件渲染成推给会话的文本 */
export function render(item = {}) {
  const who = item.nickname ? String(item.nickname) : (item.mid ? 'B站用户 ' + item.mid : '有人')
  const kind = item.kind === 'at' ? '@ 了你' : item.kind === 'reply' ? '回复了你' : '给你发了私信'
  const where = item.bvid ? `（${item.bvid}）` : ''
  const text = String(item.content || '').replace(/\s+/g, ' ').slice(0, 160)
  return `[B站] ${who} ${kind}${where}：${text}`
}

