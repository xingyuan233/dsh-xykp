// whaleisle · 分流规则（纯函数，不碰 IO，方便单测）
//
// 规则（沿用 qq-adapter 那套）：
//   1. 配置里的 mappings 优先：chat → p-<预设> / s-<会话id> / 裸会话 id
//   2. 运行期绑定 bindings.json 次之（工具 / 后续指令写进去）
//   3. 名单：blacklist（默认，名单里的不转发）/ whitelist（只转发名单里的）/ off（全放行）
//   4. 都没命中走 defaultTarget

/** 事件 → 聊天标识：私聊 u-<用户名>，群聊 g-<会话 id> */
export function chatKeyOf(event) {
  if (!event) return ''
  const conv = String(event.conversation_id || '').trim()
  if (event.is_group) return conv ? `g-${conv}` : ''
  const sender = event.sender || {}
  const who = String(sender.username || sender.id || '').trim()
  if (who) return `u-${who}`
  return conv ? `u-${conv}` : ''
}

/** 规范化名单/映射里的 key：u-xxx / g-xxx，裸写按用户处理 */
export function normalizeKey(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  const m = /^([ugUG])[-_:]?(.+)$/.exec(s)
  if (!m) return `u-${s}`
  return `${m[1].toLowerCase()}-${m[2].trim()}`
}

/** 目标引用：p-<预设> / s-<会话id> / 裸写按会话 id */
export function parseTargetRef(raw) {
  const s = String(raw || '').trim()
  if (!s) return { kind: 'none', value: '' }
  if (/^p-/i.test(s)) return { kind: 'preset', value: s.slice(2).trim() }
  if (/^s-/i.test(s)) return { kind: 'session', value: s.slice(2).trim() }
  return { kind: 'session', value: s }
}

function listOf(value) {
  return Array.isArray(value) ? value : []
}

/**
 * 决定一条消息该去哪。
 * @returns {{ target: string, via: 'mapping'|'binding'|'default'|'whitelist'|'none', reason?: string, chatKey: string }}
 */
export function resolveRoute(cfg, chatKey, bindings = {}) {
  const key = normalizeKey(chatKey)
  if (!key) return { target: '', via: 'none', reason: '没有聊天标识', chatKey: '' }

  for (const row of listOf(cfg?.mappings)) {
    if (!row) continue
    if (normalizeKey(row.chat) === key && String(row.target || '').trim()) {
      return { target: String(row.target).trim(), via: 'mapping', chatKey: key }
    }
  }

  const bound = bindings && typeof bindings === 'object' ? bindings[key] : null
  if (bound && typeof bound === 'object' && String(bound.target || '').trim()) {
    return { target: String(bound.target).trim(), via: 'binding', chatKey: key }
  }

  const defaultTarget = String(cfg?.defaultTarget || cfg?.target || '').trim()
  const mode = String(cfg?.mode || 'blacklist').toLowerCase()

  if (mode === 'whitelist') {
    const allowed = listOf(cfg?.allowed).map(normalizeKey)
    if (!allowed.includes(key)) {
      return { target: '', via: 'whitelist', reason: '不在白名单', chatKey: key }
    }
    if (!defaultTarget) return { target: '', via: 'none', reason: '没配默认目标', chatKey: key }
    return { target: defaultTarget, via: 'whitelist', chatKey: key }
  }

  if (mode === 'off') {
    if (!defaultTarget) return { target: '', via: 'none', reason: '没配默认目标', chatKey: key }
    return { target: defaultTarget, via: 'default', chatKey: key }
  }

  const blocked = listOf(cfg?.blocked).map(normalizeKey)
  if (blocked.includes(key)) return { target: '', via: 'none', reason: '在黑名单', chatKey: key }
  if (!defaultTarget) return { target: '', via: 'none', reason: '没配默认目标', chatKey: key }
  return { target: defaultTarget, via: 'default', chatKey: key }
}

/** 给会话看的文本：把同一会话的一批消息拼起来 */
export function formatIncoming(event) {
  const who = event?.sender?.display_name || event?.sender?.username || '?'
  const head = event?.is_group
    ? `[鲸屿·群「${event.conversation_title || '群聊'}」]`
    : '[鲸屿]'
  const attachments = (event?.attachments || []).map((att) => {
    const mime = String(att?.mime || '')
    return mime.startsWith('image/') ? `[图片:${att.name}]` : `[文件:${att.name}]`
  }).join(' ')
  const body = [event?.text || '', attachments].filter(Boolean).join(' ')
  return body ? `${head} ${who}: ${body}` : ''
}

export const DEFAULTS = {
  bridgeUrl: 'http://127.0.0.1:8710',
  bridgeToken: '',
  defaultTarget: 'p-alive',
  target: '',
  deliverMode: 'steer',
  pollWait: 20,
  autoReply: true,
  silentMarker: '[[SILENT]]',
  maxReplyChars: 3200,
  seenLimit: 500,
  mode: 'blacklist',
  blocked: [],
  allowed: [],
  mappings: [],
  adminUsers: [],
}
