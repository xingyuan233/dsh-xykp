// bili-rove · backend（action → B站接口）
//
// 读接口走 vendor/ 里的官方 provider（带请求节奏 / 风控退避 / 字幕串号校验）；
// 写接口（评论、私信、三连、动态）直接打 B站表单接口，csrf 从 bili_jct 来。
//
// 设计要点：
//   · 读：cookie → 匿名都行（provider 自己处理匿名 cookie）
//   · 写：必须带 cookies 且 bili_jct 有效；失败**不重试**（避免重复发评论/私信）
//   · 所有 action 失败都抛 Error，由 index.js 决定要不要走「推二维码 → 匿名」回退
import { BilibiliOfficialProvider, BILIBILI_DEFAULT_BASE_URL, BILIBILI_DEFAULT_USER_AGENT } from './vendor/provider.js'
import { wbiSign } from './vendor/wbi.js'
import { credentialOfCookie, uidOf } from './account.js'

export const DEFAULT_TIMEOUT_MS = 30_000
const UA = BILIBILI_DEFAULT_USER_AGENT
const REFERER = 'https://www.bilibili.com/'

/** 是不是写操作（失败绝不能盲目重试） */
export const WRITE_ACTIONS = new Set(['reply', 'dm', 'triple', 'dynamic'])

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function form(obj) {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue
    u.set(k, String(v))
  }
  return u
}

/**
 * @param {object} cfg - { baseUrl, userAgent, timeoutMs }
 * @param {(opts:object)=>object} [factory] - 方便自测替换
 */
export function createBackend(cfg = {}, factory) {
  const make = factory || ((opts) => new BilibiliOfficialProvider(opts))
  const cache = new Map()

  function providerFor(cookie) {
    const key = String(cookie || '')
    if (cache.has(key)) return cache.get(key)
    const p = make({
      baseUrl: cfg.baseUrl || BILIBILI_DEFAULT_BASE_URL,
      userAgent: cfg.userAgent || BILIBILI_DEFAULT_USER_AGENT,
      requestTimeoutMs: Number(cfg.timeoutMs) || DEFAULT_TIMEOUT_MS,
      ...(key ? { cookie: key } : {}),
    })
    cache.set(key, p)
    return p
  }

  async function signed(p, extra = {}) {
    const keys = await p.resolveWbiKeys()
    return wbiSign({ build: 0, mobi_app: 'web', ...extra }, keys.imgKey, keys.subKey, Math.floor(Date.now() / 1000))
  }

  /** 普通 GET（带 cookie，解析 envelope，code≠0 抛错） */
  async function getJson(url, cookie, extraHeaders = {}) {
    const headers = {
      accept: 'application/json',
      'user-agent': UA,
      referer: REFERER,
      ...(cookie ? { cookie } : {}),
      ...extraHeaders,
    }
    const r = await fetch(url, { headers })
    const text = await r.text()
    let j
    try {
      j = JSON.parse(text)
    } catch {
      throw new Error('B站返回的不是 JSON（HTTP ' + r.status + '）：' + text.slice(0, 120))
    }
    if (j && j.code !== 0) throw new Error((j.message || 'B站接口报错') + '（code=' + j.code + '）')
    return j ? j.data : undefined
  }

  /** 写接口 POST（表单 + csrf），返回 envelope.data */
  async function postForm(url, body, cookie, extraHeaders = {}) {
    const headers = {
      accept: 'application/json',
      'user-agent': UA,
      referer: REFERER,
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookie ? { cookie } : {}),
      ...extraHeaders,
    }
    const r = await fetch(url, { method: 'POST', headers, body: form(body).toString() })
    const text = await r.text()
    let j
    try {
      j = JSON.parse(text)
    } catch {
      throw new Error('B站返回的不是 JSON（HTTP ' + r.status + '）：' + text.slice(0, 120))
    }
    if (j && j.code !== 0) throw new Error((j.message || 'B站接口报错') + '（code=' + j.code + '）')
    return j ? j.data : undefined
  }

  function needCred(cookie) {
    const cred = credentialOfCookie(cookie)
    if (!cred || !cred.bili_jct) {
      throw new Error('BILI_ROVE_NO_CREDENTIAL：这个操作需要登录（缺 SESSDATA / bili_jct），先跑 bili_login 扫码')
    }
    return cred
  }

  /** 纯查询：视频 aid / cid / 标题 */
  async function detailOf(p, bvid) {
    const clean = String(bvid || '').trim()
    if (!clean) throw new Error('BILI_ROVE_BAD_ARGS：需要 bvid')
    if (/^\d+$/.test(clean)) {
      const data = await p.requestJson('/x/web-interface/view', { aid: clean })
      return { aid: Number(clean), cid: Number(data?.cid || 0), title: String(data?.title || ''), duration: Number(data?.duration || 0) }
    }
    const v = await p.video({ bvid: clean })
    return { aid: v.aid, cid: v.cid, title: v.title, duration: v.duration }
  }

  /** 评论列表 */
  async function commentsOf(p, bvid, num = 30, signal) {
    const detail = await detailOf(p, bvid)
    const limit = Math.max(1, Math.min(100, Number(num) || 30))
    const out = []
    let error
    for (let page = 1; out.length < limit && page <= 10; page += 1) {
      let data
      try {
        data = await p.requestJson('/x/v2/reply', { type: 1, oid: detail.aid, sort: 2, pn: page, ps: 20 }, signal)
      } catch (e) {
        // 评论区第一次经常吃风控，隔 1.5s 重试一次（实测有效）
        await sleep(1500)
        try {
          data = await p.requestJson('/x/v2/reply', { type: 1, oid: detail.aid, sort: 2, pn: page, ps: 20 }, signal)
        } catch (e2) {
          error = String(e2?.message || e2)
          break
        }
      }
      const replies = (data && data.replies) || []
      if (!replies.length) break
      for (const r of replies) {
        if (out.length >= limit) break
        const member = r.member || {}
        const content = r.content || {}
        const c = {
          rpid: r.rpid,
          user: member.uname || '',
          uid: member.mid || 0,
          content: content.message || '',
          like: r.like || 0,
          reply_count: r.rcount || 0,
          time: r.ctime || 0,
        }
        const tops = []
        for (const sub of (r.replies || []).slice(0, 2)) {
          tops.push({ user: (sub.member || {}).uname || '', content: (sub.content || {}).message || '', like: sub.like || 0 })
        }
        if (tops.length) c.top_replies = tops
        out.push(c)
      }
      await sleep(400)
    }
    const res = { bvid: String(bvid).trim(), count: out.length, comments: out }
    if (error) res.error = error
    return res
  }

  /** 弹幕 */
  async function danmakuOf(p, bvid, num = 100, signal) {
    const detail = await detailOf(p, bvid)
    if (!detail.cid) throw new Error('拿不到 cid，读不了弹幕')
    const r = await fetch('https://api.bilibili.com/x/v1/dm/list.so?oid=' + encodeURIComponent(detail.cid), {
      headers: { 'user-agent': UA, referer: REFERER },
      signal,
    })
    const xml = await r.text()
    const items = []
    const re = /<d p="([^"]*)">([^<]*)<\/d>/g
    let m
    while ((m = re.exec(xml)) !== null && items.length < Math.max(1, Math.min(1000, Number(num) || 100))) {
      const bits = m[1].split(',')
      items.push({
        time: Number(bits[0] || 0),
        mode: Number(bits[1] || 1),
        color: Number(bits[3] || 16777215),
        text: m[2] || '',
      })
    }
    return { bvid: String(bvid).trim(), cid: detail.cid, count: items.length, danmaku: items }
  }

  /** 私信会话列表 */
  async function dmSessionsOf(p, cookie, size = 10) {
    const n = Math.max(1, Math.min(20, Number(size) || 10))
    const data = await getJson(
      'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_id=0&build=0&mobi_app=web',
      cookie,
      { referer: 'https://message.bilibili.com/' },
    )
    const me = uidOf(credentialOfCookie(cookie))
    const items = []
    for (const it of ((data || {}).session_list || []).slice(0, n)) {
      const uid = Number(it.talker_id || 0)
      if (!uid || uid === me) continue
      const last = it.last_msg || {}
      const mt = Number(last.msg_type || 1)
      let c = {}
      try {
        c = JSON.parse(last.content || '{}')
      } catch {
        c = {}
      }
      const isCard = mt === 7 || mt === 8
      const text = isCard ? '[分享视频] ' + String(c.title || c.headline || '').slice(0, 80) : String(c.content || c.text || '')
      let nick = ''
      for (const ai of [(last.account_info || {}), (it.account_info || {})]) {
        if (ai && ai.name) {
          nick = String(ai.name)
          break
        }
      }
      items.push({
        talker_uid: uid,
        nick,
        unread: Number(it.unread_count || 0),
        ts: Number(last.timestamp || it.session_ts || 0),
        last_from: Number(last.sender_uid || 0),
        last_text: text.slice(0, 150),
        is_card: isCard,
      })
    }
    return { ok: true, me, count: items.length, items }
  }

  /** 读一个私信会话（0 = 发给自己那条会话） */
  async function dmRecentOf(p, cookie, { size = 20, talkerId = 0, pages = 1 } = {}) {
    const me = uidOf(credentialOfCookie(cookie))
    const n = Math.max(1, Math.min(30, Number(size) || 20))
    let talker = Number(talkerId || 0) || me
    const base = 'https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs'
      + '?talker_id=' + encodeURIComponent(talker) + '&session_type=1&size=' + n + '&build=0&mobi_app=web'
    const pageCount = Math.max(1, Math.min(5, Number(pages) || 1))
    const raw = []
    let endSeqno = null
    for (let i = 0; i < pageCount; i += 1) {
      const url = base + (endSeqno ? '&end_seqno=' + encodeURIComponent(endSeqno) : '')
      let data
      try {
        data = await getJson(url, cookie, { referer: 'https://message.bilibili.com/' })
      } catch (e) {
        if (i === 0) throw e
        break
      }
      const batch = (data || {}).messages || []
      if (!batch.length) break
      raw.push(...batch)
      endSeqno = Math.min(...batch.map((m) => Number(m.msg_seqno || 0)).filter((x) => x > 0))
      if (!endSeqno) break
    }
    const seen = new Set()
    const msgs = []
    for (const m of raw) {
      const k = String(m.msg_key || m.msg_seqno || m.timestamp)
      if (seen.has(k)) continue
      seen.add(k)
      msgs.push(m)
    }
    msgs.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
    const out = []
    for (const m of msgs) {
      const mt = Number(m.msg_type || 1)
      let c = {}
      try {
        c = JSON.parse(m.content || '{}')
      } catch {
        c = {}
      }
      let bv = ''
      let isCard = false
      if (mt === 7 || mt === 8) {
        isCard = true
        bv = String(c.bvid || '')
        const mm = String(c.jump_url || '').match(/BV[0-9A-Za-z]{10,}/)
        if (!bv && mm) bv = mm[0]
        const text = '[分享视频] ' + String(c.title || c.headline || '').slice(0, 80)
          + (c.author ? ' / ' + String(c.author) : '')
          + (bv ? ' ' + bv : '')
        out.push({ key: String(m.msg_key || m.msg_seqno || m.timestamp), ts: Number(m.timestamp || 0), from_uid: Number(m.sender_uid || 0), bv, text: text.slice(0, 300), is_card: true })
        continue
      }
      const text = String(c.content || c.text || '')
      const mm = text.match(/BV[0-9A-Za-z]{10,}/)
      if (mm) bv = mm[0]
      if (!text && !bv) continue
      out.push({ key: String(m.msg_key || m.msg_seqno || m.timestamp), ts: Number(m.timestamp || 0), from_uid: Number(m.sender_uid || 0), bv, text: text.slice(0, 300), is_card: isCard })
    }
    return { ok: true, me, talker, count: out.length, items: out }
  }

  /** msgfeed 归一化（@ / 回复） */
  function normFeed(kind, raw) {
    const out = []
    for (const it of ((raw || {}).items || [])) {
      const user = it.user || {}
      const inner = it.item || {}
      const bid = Number(inner.business_id || 0)
      const subject = inner.subject_id || 0
      let bvid = ''
      if (bid === 1 && subject) {
        // 通知里只有 aid；这里用旧的 aid→bvid 接口不值得，留空让调用方按 aid 处理
        bvid = ''
      }
      out.push({
        kind,
        id: it.id,
        mid: Number(user.mid || 0),
        nickname: String(user.nickname || '').trim(),
        business_id: bid,
        bvid,
        aid: bid === 1 ? Number(subject) || 0 : 0,
        title: String(inner.title || '').trim(),
        content: String(inner.source_content || '').trim(),
        rpid: inner.source_id || 0,
        root: inner.root_id || 0,
        at: it.at_time || it.reply_time || 0,
      })
    }
    return out
  }

  return {
    async call({ action, args = {}, cookie = '', signal } = {}) {
      const p = providerFor(cookie)
      const a = args || {}
      const bvid = String(a.bvid || '').trim()

      switch (action) {
        case 'search': {
          const keyword = String(a.keyword || '').trim()
          if (!keyword) throw new Error('BILI_ROVE_BAD_ARGS：search 需要 keyword')
          return p.search({
            keyword,
            page: Math.max(1, Number(a.page) || 1),
            pageSize: Math.min(20, Math.max(1, Number(a.pageSize) || 10)),
            ...(a.order ? { order: String(a.order) } : {}),
          }, signal)
        }

        case 'video': {
          if (!bvid) throw new Error('BILI_ROVE_BAD_ARGS：video 需要 bvid')
          return p.video({ bvid }, signal)
        }

        case 'subtitles': {
          if (!bvid) throw new Error('BILI_ROVE_BAD_ARGS：subtitles 需要 bvid')
          return p.subtitles({ bvid, ...(a.language ? { language: String(a.language) } : {}) }, signal)
        }

        case 'comments':
          return commentsOf(p, bvid, a.num, signal)

        case 'danmaku':
          return danmakuOf(p, bvid, a.num, signal)

        case 'user': {
          const uid = Number(a.uid || 0)
          if (!uid) throw new Error('BILI_ROVE_BAD_ARGS：user 需要 uid')
          return signed(p, { mid: uid }).then((q) => p.requestJson('/x/space/wbi/acc/info', q, signal))
        }

        case 'user_videos': {
          const uid = Number(a.uid || 0)
          if (!uid) throw new Error('BILI_ROVE_BAD_ARGS：user_videos 需要 uid')
          const q = await signed(p, {
            mid: uid,
            pn: Math.max(1, Number(a.page) || 1),
            ps: Math.min(50, Math.max(1, Number(a.pageSize) || 30)),
            order: String(a.order || 'pubdate'),
          })
          return p.requestJson('/x/space/wbi/arc/search', q, signal)
        }

        case 'favorites': {
          const uid = Number(a.uid || 0) || uidOf(credentialOfCookie(cookie))
          if (a.mediaId) {
            return p.requestJson('/x/v3/fav/resource/list', {
              media_id: Number(a.mediaId),
              pn: Math.max(1, Number(a.page) || 1),
              ps: Math.min(40, Math.max(1, Number(a.pageSize) || 20)),
              platform: 'web',
            }, signal)
          }
          if (!uid) throw new Error('BILI_ROVE_BAD_ARGS：favorites 需要 uid（或先登录）')
          return p.requestJson('/x/v3/fav/folder/created/list-all', { up_mid: uid }, signal)
        }

        case 'hot': {
          const data = await p.requestJson('/x/web-interface/ranking/v2', { rid: 0, type: 'all' }, signal)
          return { list: (data && data.list) || [] }
        }

        case 'rank': {
          const rid = Number(a.rid || a.category || 0)
          const data = await p.requestJson('/x/web-interface/ranking/v2', { rid: Number.isFinite(rid) ? rid : 0, type: 'all' }, signal)
          return { rid: Number.isFinite(rid) ? rid : 0, list: (data && data.list) || [] }
        }

        case 'dm_sessions':
          return dmSessionsOf(p, cookie, a.size)

        case 'dm_recent':
          return dmRecentOf(p, cookie, { size: a.size, talkerId: a.uid || a.talkerId, pages: a.pages })

        case 'dm': {
          // 带 text = 发私信；不带 text = 读会话（等价 dm_recent）
          const text = String(a.text || '').trim()
          if (!text) return dmRecentOf(p, cookie, { size: a.size, talkerId: a.uid || a.talkerId, pages: a.pages })
          const cred = needCred(cookie)
          const receiver = Number(a.uid || a.receiverUid || 0)
          if (!receiver) throw new Error('BILI_ROVE_BAD_ARGS：发私信需要 uid')
          const body = {
            'msg[sender_uid]': cred.dedeuserid || uidOf(cred),
            'msg[receiver_id]': receiver,
            'msg[receiver_type]': 1,
            'msg[msg_type]': 1,
            'msg[msg_status]': 0,
            'msg[content]': JSON.stringify({ content: text }),
            'msg[dev_id]': 'A6716E9A-7CE3-47AF-994B-F0B34178D28D',
            'msg[new_face_version]': 0,
            'msg[timestamp]': Math.floor(Date.now() / 1000),
            csrf: cred.bili_jct,
            w_receiver_id: receiver,
          }
          const data = await postForm('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', body, cookie, { referer: 'https://message.bilibili.com/' })
          const msgKey = data?.msg_key || data?.msg_seqno
          if (!msgKey) {
            return { ok: false, error: '接口没报错，但回执里没有 msg_key —— 这条私信大概率没真发出去', data }
          }
          return { ok: true, receiver_uid: receiver, msg_key: msgKey, data }
        }

        case 'reply': {
          const cred = needCred(cookie)
          const detail = await detailOf(p, bvid)
          const text = String(a.text || '').trim()
          if (!text) throw new Error('BILI_ROVE_BAD_ARGS：reply 需要 text')
          const body = {
            type: 1,
            oid: detail.aid,
            message: text,
            root: Number(a.root || 0),
            parent: Number(a.rpid || 0),
            plat: 1,
            csrf: cred.bili_jct,
          }
          const data = await postForm('https://api.bilibili.com/x/v2/reply/add', body, cookie)
          return { ok: true, bvid: String(bvid).trim(), aid: detail.aid, rpid: data?.rpid, rpid_str: data?.rpid_str, root: body.root, parent: body.parent, title: detail.title }
        }

        case 'triple': {
          const cred = needCred(cookie)
          const detail = await detailOf(p, bvid)
          const mode = String(a.mode || 'like').trim().toLowerCase()
          const coinNum = Math.max(1, Math.min(2, Number(a.coinNum || a.coin_num || 1)))
          const did = []
          const skipped = []
          const like = async () => {
            const has = await p.requestJson('/x/web-interface/archive/has/like', { bvid: String(bvid).trim() }).catch(() => ({}))
            if (has && Number(has.like) === 1) return skipped.push('点赞（之前点过）')
            await postForm('https://api.bilibili.com/x/web-interface/archive/like', { bvid: String(bvid).trim(), like: 1, csrf: cred.bili_jct }, cookie)
            did.push('点赞')
          }
          const coin = async () => {
            await postForm('https://api.bilibili.com/x/web-interface/coin/add', { bvid: String(bvid).trim(), multiply: coinNum, select_like: 0, csrf: cred.bili_jct }, cookie)
            did.push('投币 ' + coinNum + ' 枚')
          }
          const fav = async () => {
            const ids = await p.requestJson('/x/v3/fav/resource/ids', { bvid: String(bvid).trim() }).catch(() => [])
            if (Array.isArray(ids) && ids.length) return skipped.push('收藏（之前收过）')
            const folders = await p.requestJson('/x/v3/fav/folder/created/list-all', { up_mid: uidOf(cred) })
            const first = ((folders && folders.list) || []).find((x) => x && x.id)
            if (!first) throw new Error('账号里没有可用的收藏夹')
            await postForm('https://api.bilibili.com/x/v3/fav/resource/deal', {
              rid: detail.aid,
              type: 2,
              add_media_ids: first.id,
              del_media_ids: '',
              csrf: cred.bili_jct,
            }, cookie)
            did.push('收藏（收藏夹 ' + first.id + '）')
          }
          const steps = mode === 'triple' ? [like, fav] : mode === 'like' ? [like] : mode === 'coin' ? [coin] : mode === 'fav' ? [fav] : mode === 'like_fav' ? [like, fav] : null
          if (!steps) throw new Error('不认识的 mode：' + mode)
          for (const step of steps) {
            try {
              await step()
            } catch (e) {
              skipped.push((step.name || '步骤') + '失败：' + String(e?.message || e).slice(0, 80))
            }
          }
          return { ok: true, bvid: String(bvid).trim(), aid: detail.aid, title: detail.title, mode, did, skipped }
        }

        case 'dynamic': {
          const cred = needCred(cookie)
          const text = String(a.text || '').trim()
          if (!text) throw new Error('BILI_ROVE_BAD_ARGS：dynamic 需要 text')
          const dynReq = {
            content: { contents: [{ raw_text: text, type: 1, biz_id: '' }] },
            scene: 1,
            attach_card: {},
          }
          const data = await postForm('https://api.bilibili.com/x/dynamic/feed/create/dyn', {
            dyn_req: JSON.stringify(dynReq),
            csrf: cred.bili_jct,
          }, cookie)
          return { ok: true, data }
        }

        case 'received_at': {
          const q = await signed(p)
          return { items: normFeed('at', await p.requestJson('/x/msgfeed/at', q, signal)) }
        }

        case 'received_replies': {
          const q = await signed(p)
          return { items: normFeed('reply', await p.requestJson('/x/msgfeed/reply', q, signal)) }
        }

        case 'whoami': {
          const cred = credentialOfCookie(cookie)
          if (!cred) throw new Error('BILI_ROVE_NO_CREDENTIAL：没有登录')
          const data = await getJson('https://api.bilibili.com/x/web-interface/nav', cookie)
          return { ok: true, uid: Number(data?.mid || 0), uname: data?.uname || '', vip: Boolean(data?.vipStatus), level: data?.level_info?.current_level ?? 0 }
        }

        case 'crawl': {
          const keyword = String(a.keyword || '').trim()
          if (!keyword) throw new Error('BILI_ROVE_BAD_ARGS：crawl 需要 keyword')
          const maxVideos = Math.max(1, Math.min(10, Number(a.maxVideos) || 3))
          const search = await p.search({ keyword, page: 1, pageSize: Math.min(20, Math.max(1, Number(a.pageSize) || 10)), ...(a.order ? { order: String(a.order) } : {}) }, signal)
          const picked = (search.items || []).slice(0, maxVideos)
          const out = []
          for (const v of picked) {
            const row = { bvid: v.bvid, title: v.title, author: v.author, play: v.play, comment: v.comment, publishAt: v.publishAt }
            try {
              row.comments = await commentsOf(p, v.bvid, Math.max(1, Math.min(30, Number(a.commentsPerVideo) || 10)), signal)
            } catch (e) {
              row.comments_error = String(e?.message || e)
            }
            if (a.getSubtitles !== false) {
              try {
                row.subtitles = await p.subtitles({ bvid: v.bvid }, signal)
              } catch (e) {
                row.subtitles_error = String(e?.message || e)
              }
            }
            out.push(row)
            await sleep(1200)
          }
          return { keyword, count: out.length, videos: out }
        }

        default:
          throw new Error('BILI_ROVE_BAD_ACTION：' + action)
      }
    },
  }
}
