// bili-reply · 私信拉取
//
// 接口（2026-10-27 实测可用）：
//   会话列表 https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions
//   会话消息 https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs
// 只处理 unread_count > 0 的会话（没未读就不去翻，省请求）。
//
// 返回结构跟 dedupe/queue 约定：
//   { kind:'dm', id, mid(对方uid), nickname, bvid, content, at }

const SESSIONS =
  'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_id=0&build=0&mobi_app=web'
const MSGS = 'https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?session_type=1&build=0&mobi_app=web'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export const DEFAULTS = {
  dmOnlyUnread: true,
  dmMaxSessions: 10,
}

/** cookie 里的 DedeUserID */
export function meIdOf(cookie = '') {
  const m = String(cookie).match(/DedeUserID=(\d+)/)
  return m ? Number(m[1]) : 0
}

/** 一条私信 → 队列条目（分享卡片只有 bvid/title，没有 content） */
export function mapDmMessage(m = {}, talker = 0) {
  let text = ''
  let bvid = ''
  let isCard = false
  try {
    const c = JSON.parse(m.content || '{}')
    if (c.content) text = String(c.content)
    if (c.bvid) bvid = String(c.bvid)
    if (!bvid && c.jump_url) {
      const mm = String(c.jump_url).match(/BV[0-9A-Za-z]{10,}/)
      if (mm) bvid = mm[0]
    }
    if (!text && c.title) {
      text = String(c.title)
      isCard = true
    }
    if (!text && bvid) {
      text = '分享了视频 ' + bvid
      isCard = true
    }
  } catch {
    text = String(m.content || '')
  }
  return {
    kind: 'dm',
    id: String(m.msg_seqno || m.msg_key || m.timestamp || ''),
    rpid: '',
    mid: Number(talker) || 0,
    nickname: '',
    bvid,
    content: String(text).slice(0, 300),
    isCard,
    at: Number(m.timestamp || 0) * 1000 || Date.now(),
  }
}

/**
 * 拉私信。fetchImpl 可替换（自测用）。
 * ⚠ 只对未读会话去翻消息，避免每 3 分钟打 20 次接口。
 */
export function createDmFetcher(cfg = {}, fetchImpl = fetch) {
  const opts = { ...DEFAULTS, ...(cfg || {}) }
  return async function fetchDms({ cookie = '', meId = 0, maxSessions } = {}) {
    const headers = { 'user-agent': UA, cookie, referer: 'https://message.bilibili.com/' }
    const me = Number(meId) || meIdOf(cookie)
    const limit = Math.max(1, Number(maxSessions) || opts.dmMaxSessions)
    const out = []

    const r = await fetchImpl(SESSIONS, { headers })
    const j = await r.json()
    if (!j || j.code !== 0) throw new Error('get_sessions 失败：code=' + (j && j.code))
    const list = ((j.data || {}).session_list) || []

    let handled = 0
    for (const s of list) {
      if (handled >= limit) break
      const unread = Number(s.unread_count || 0)
      if (opts.dmOnlyUnread && unread <= 0) continue
      const talker = Number(s.talker_id || 0)
      if (!talker) continue
      handled++
      try {
        const size = Math.min(20, Math.max(5, unread || 5))
        const u = MSGS + '&talker_id=' + talker + '&size=' + size
        const mr = await fetchImpl(u, { headers })
        const mj = await mr.json()
        for (const m of ((mj.data || {}).messages || [])) {
          if (Number(m.sender_uid) === me) continue
          out.push(mapDmMessage(m, talker))
        }
      } catch {
        // 单个会话失败跳过，不影响其它会话
      }
    }
    return out
  }
}
