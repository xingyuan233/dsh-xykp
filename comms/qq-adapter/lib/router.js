// qq-adapter · 分流规则（纯函数，不碰 IO，方便单测）
//
// 规则（主人 2026-10-27 定的）：
//   1. 自定义映射优先：u-<uid> / g-<群号> → p-<预设> 或 s-<会话id>
//   2. 没命中映射就看名单：
//      - blacklist（默认）：名单里的**不转发**，其余走默认目标
//      - whitelist：只有名单里的转发（走默认目标），其余丢掉
//   3. 默认目标也支持 p-<预设> / s-<会话id>

/** 事件 → 聊天标识：私聊 u-<peerUid>，群聊 g-<peerUid>（NTQQ 里群聊 peerUid 就是群号） */
export function chatKeyOf(evt) {
  if (!evt) return ''
  const peer = String(evt.peerUid || '')
  if (!peer) return ''
  const isGroup = Number(evt.chatType) === 2
  return (isGroup ? 'g-' : 'u-') + peer
}

/** 规范化一条名单/映射里的 key（去空格、小写前缀） */
export function normalizeKey(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  const m = /^([ugUG])[-_:]?(.+)$/.exec(s)
  if (!m) return 'u-' + s
  return m[1].toLowerCase() + '-' + m[2].trim()
}

/** 目标引用：p-<预设> / s-<会话id> / 裸写按会话 id 处理 */
export function parseTargetRef(raw) {
  const s = String(raw || '').trim()
  if (!s) return { kind: 'none', value: '' }
  if (s.startsWith('p-') || s.startsWith('P-')) return { kind: 'preset', value: s.slice(2).trim() }
  if (s.startsWith('s-') || s.startsWith('S-')) return { kind: 'session', value: s.slice(2).trim() }
  return { kind: 'session', value: s }
}

/**
 * 决定一条消息该去哪。
 * @returns {{ target: string, via: 'mapping'|'default'|'whitelist'|'none', reason?: string, chatKey: string }}
 */
export function resolveRoute(cfg, chatKey) {
  const key = normalizeKey(chatKey)
  if (!key) return { target: '', via: 'none', reason: '没有聊天标识', chatKey: key }

  const mappings = Array.isArray(cfg?.mappings) ? cfg.mappings : []
  for (const row of mappings) {
    if (!row) continue
    if (normalizeKey(row.chat) === key) {
      const target = String(row.target || '').trim()
      if (!target) continue
      return { target, via: 'mapping', chatKey: key }
    }
  }

  const defaultTarget = String(cfg?.defaultTarget || '').trim()
  const mode = String(cfg?.mode || 'blacklist')

  if (mode === 'whitelist') {
    const allowed = (cfg?.allowed || []).map(normalizeKey)
    if (!allowed.includes(key)) return { target: '', via: 'whitelist', reason: '不在白名单', chatKey: key }
    if (!defaultTarget) return { target: '', via: 'none', reason: '白名单命中但没配默认目标', chatKey: key }
    return { target: defaultTarget, via: 'whitelist', chatKey: key }
  }

  const blocked = (cfg?.blocked || []).map(normalizeKey)
  if (blocked.includes(key)) return { target: '', via: 'none', reason: '在黑名单', chatKey: key }
  if (!defaultTarget) return { target: '', via: 'none', reason: '没配默认目标', chatKey: key }
  return { target: defaultTarget, via: 'default', chatKey: key }
}

/** 把一条 bridge 事件写成给会话看的文本 */
export function formatIncoming(evt, opts = {}) {
  const key = chatKeyOf(evt)
  const isGroup = Number(evt.chatType) === 2
  const who = String(evt.senderName || evt.senderUid || '').trim()
  const when = new Date(Number(evt.time) || Date.now())
  const hh = String(when.getHours()).padStart(2, '0')
  const mm = String(when.getMinutes()).padStart(2, '0')

  const parts = []
  for (const el of evt.elements || []) {
    if (el.type === 1) parts.push(el.text || el.textElement?.content || '')
    else if (el.type === 2) parts.push(`[图片 ${el.pic?.fileName || ''}${el.pic?.sourcePath ? ' → ' + el.pic.sourcePath : '（未落盘）'}]`)
    else if (el.type === 3) parts.push(`[文件 ${el.file?.fileName || ''} ${el.file?.fileSize || ''}字节]`)
    else if (el.type === 4) parts.push(`[语音 ${el.ptt?.duration || '?'}秒${el.ptt?.filePath ? ' → ' + el.ptt.filePath : ''}]`)
    else if (el.type === 5) parts.push('[视频]')
    else if (el.type === 6) parts.push(`[表情 ${el.face?.faceText || el.face?.faceIndex || ''}]`)
    else if (el.type === 7) parts.push('[回复]')
    else if (el.at) parts.push(`@${el.at.atUid || el.at.atNtUid || ''}`)
    else parts.push(`[元素${el.type}]`)
  }

  const body = parts.join('').trim() || '（空消息）'
  const head = isGroup ? `[QQ群 ${key}]` : `[QQ私聊 ${key}]`
  return `${head} ${hh}:${mm}${who ? ' ' + who : ''}\n${body}`
}

export const DEFAULTS = {
  enabled: true,
  bridgeUrl: 'http://127.0.0.1:39272',
  defaultTarget: 'p-alive',
  mode: 'blacklist',
  blocked: [],
  allowed: [],
  mappings: [],
  pollMs: 1500,
}
