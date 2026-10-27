// qq-adapter · 和 QQ 主进程里的桥说话（HTTP 127.0.0.1:39272）
//
// 桥（qq-bridge-script.js）在 QQ 进程里跑，提供：
//   GET  /status             → { ok, stage, uin, session, ms, inbox, qr, qrAge }
//   GET  /events?since=N     → { ok, next, events: [...] }
//   POST /send               → { chatType, peerUid, text } / { elements }
//   GET  /buddy /recent /diag ...
//
// 这里只做最小封装：拿事件、发消息、看状态。出错一律抛给调用方，由插件记日志。

export function createBridge(baseUrl, opts = {}) {
  const base = String(baseUrl || 'http://127.0.0.1:39272').replace(/\/+$/, '')
  const timeoutMs = Math.max(500, Number(opts.timeoutMs) || 5000)

  async function req(path, init) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetch(base + path, { ...init, signal: ctl.signal })
      const text = await res.text()
      let json = null
      try { json = JSON.parse(text) } catch { json = { ok: false, raw: text.slice(0, 400) } }
      if (!res.ok && json && json.ok !== false) json.ok = false
      return json
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    base,
    status: () => req('/status'),
    events: (since = 0) => req('/events?since=' + (Number(since) || 0)),
    async history(chatType, peerUid, count = 20, seq = '') {
      const q = new URLSearchParams({ chatType: String(Number(chatType) || 1), peerUid: String(peerUid || ''), count: String(Number(count) || 20) })
      if (seq) q.set('seq', String(seq))
      return req('/history?' + q.toString())
    },
    async sendImage(chatType, peerUid, filePath) {
      const q = new URLSearchParams({ chatType: String(Number(chatType) || 1), peerUid: String(peerUid || ''), path: String(filePath || '') })
      return req('/sendpic?' + q.toString())
    },
    async send(chatType, peerUid, text, at = '', atNick = '') {
      const body = JSON.stringify({ chatType: Number(chatType) || 1, peerUid: String(peerUid || ''), text: String(text ?? ''), at: String(at || ''), atNick: String(atNick || '') })
      const r = await req('/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body,
      })
      return r
    },
    async sendFile(chatType, peerUid, filePath) {
      const q = new URLSearchParams({ chatType: String(Number(chatType) || 1), peerUid: String(peerUid || ''), path: String(filePath || '') })
      return req('/sendfile?' + q.toString())
    },
    async sendVoice(chatType, peerUid, filePath, duration = 0) {
      const q = new URLSearchParams({ chatType: String(Number(chatType) || 1), peerUid: String(peerUid || ''), path: String(filePath || '') })
      if (duration) q.set('duration', String(Number(duration) || 0))
      return req('/sendptt?' + q.toString())
    },
    async reply(chatType, peerUid, msgId, text, meta = {}) {
      const q = new URLSearchParams({ chatType: String(Number(chatType) || 1), peerUid: String(peerUid || ''), msgId: String(msgId || ''), text: String(text ?? '') })
      if (meta?.seq) q.set('seq', String(meta.seq))
      if (meta?.time) q.set('time', String(meta.time))
      if (meta?.senderUid) q.set('senderUid', String(meta.senderUid))
      if (meta?.senderUin) q.set('senderUin', String(meta.senderUin))
      return req('/reply?' + q.toString())
    },
  }
}
