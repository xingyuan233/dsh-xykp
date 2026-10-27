// bili-rove backend 自测（不联网，用假 provider / 假 fetch）
//
// 覆盖：action → 接口映射、参数校验、写操作的 csrf、未登录报错、provider 缓存
import { createBackend } from '../lib/backend.js'

let failed = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) failed++
}

const calls = []
const fakeProvider = {
  opts: null,
  async search(r) { calls.push(['search', r]); return { items: [{ bvid: 'BV1aa411c7mD', title: 'T', author: 'A', play: 1, comment: 2, publishAt: '2026-10-01T00:00:00.000Z' }], total: 1, hasMore: false } },
  async video(r) { calls.push(['video', r]); return { bvid: r.bvid, aid: 123, cid: 456, title: '标题', duration: 100, coverUrl: 'https://i0.hdslb.com/x.jpg' } },
  async subtitles(r) { calls.push(['subtitles', r]); return { cues: [], transcript: '' } },
  async resolveWbiKeys() { return { imgKey: 'a'.repeat(32), subKey: 'b'.repeat(32) } },
  async requestJson(path, params) {
    calls.push(['requestJson', path, params])
    if (path === '/x/v2/reply') return { replies: [{ rpid: 1, member: { uname: 'u', mid: 2 }, content: { message: 'hi' }, like: 3, rcount: 0, ctime: 1 }] }
    if (path === '/x/space/wbi/acc/info') return { name: '某人' }
    if (path === '/x/space/wbi/arc/search') return { list: { vlist: [] } }
    if (path === '/x/v3/fav/folder/created/list-all') return { list: [{ id: 7 }] }
    if (path === '/x/v3/fav/resource/ids') return []
    if (path === '/x/msgfeed/at') return { items: [{ id: 1, user: { mid: 9, nickname: 'n' }, item: { business_id: 1, subject_id: 555, source_id: 66, root_id: 0, source_content: '说了句啥' }, at_time: 1700000000 }] }
    if (path === '/x/msgfeed/reply') return { items: [] }
    if (path === '/x/web-interface/archive/has/like') return { like: 0 }
    return {}
  },
}

let made = 0
const backend = createBackend({}, (opts) => { made++; fakeProvider.opts = opts; return fakeProvider })
const COOKIE = 'SESSDATA=s1; bili_jct=j1; DedeUserID=42'

// ── 读 ──
const r1 = await backend.call({ action: 'search', args: { keyword: ' 测试 ', page: 2, pageSize: 99 }, cookie: COOKIE })
check(calls[0][0] === 'search' && calls[0][1].keyword === '测试', 'search 参数映射（去空格）', JSON.stringify(calls[0][1]))
check(calls[0][1].page === 2 && calls[0][1].pageSize === 20, 'page / pageSize 会被钳制')
check(fakeProvider.opts.cookie === COOKIE, 'cookie 传给了 provider')

const r2 = await backend.call({ action: 'video', args: { bvid: 'BV1aa411c7mD' }, cookie: COOKIE })
check(r2.aid === 123 && r2.cid === 456, 'video 返回 aid/cid')

const r3 = await backend.call({ action: 'comments', args: { bvid: 'BV1aa411c7mD', num: 5 }, cookie: COOKIE })
check(r3.count >= 1 && r3.comments[0].rpid === 1, 'comments 归一化', JSON.stringify(r3.comments[0]))

const r4 = await backend.call({ action: 'user', args: { uid: 42 }, cookie: COOKIE })
check(r4.name === '某人', 'user 走 wbi 签名接口')

const r5 = await backend.call({ action: 'received_at', args: {}, cookie: COOKIE })
check(r5.items.length === 1 && r5.items[0].aid === 555 && r5.items[0].rpid === 66, 'received_at 归一化')

const r6 = await backend.call({ action: 'favorites', args: { uid: 42 }, cookie: COOKIE })
check(r6.list[0].id === 7, 'favorites 列表')

// ── 写（mock 全局 fetch 抓 POST 表单） ──
check(made === 1, '同一 cookie 复用 provider 实例', `made=${made}`)
const posts = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  posts.push({ url: String(url), body: String(init?.body || ''), headers: init?.headers || {} })
  const u = String(url)
  if (u.includes('/x/v2/reply/add')) return new Response(JSON.stringify({ code: 0, data: { rpid: 99, rpid_str: '99' } }))
  if (u.includes('/web_im/v1/web_im/send_msg')) return new Response(JSON.stringify({ code: 0, data: { msg_key: 'k1' } }))
  if (u.includes('/archive/like')) return new Response(JSON.stringify({ code: 0, data: {} }))
  if (u.includes('/fav/resource/deal')) return new Response(JSON.stringify({ code: 0, data: {} }))
  return new Response(JSON.stringify({ code: 0, data: {} }))
}
try {
  const w1 = await backend.call({ action: 'reply', args: { bvid: 'BV1aa411c7mD', text: '好' }, cookie: COOKIE })
  const p1 = posts.find((p) => p.url.includes('/x/v2/reply/add'))
  check(w1.ok && w1.rpid === 99, 'reply 返回 rpid')
  check(p1 && p1.body.includes('csrf=j1') && p1.body.includes('oid=123') && p1.body.includes('message='), 'reply 带 csrf/oid/message')

  const w2 = await backend.call({ action: 'dm', args: { uid: 7, text: '在吗' }, cookie: COOKIE })
  const p2 = posts.find((p) => p.url.includes('send_msg'))
  check(w2.ok && w2.msg_key === 'k1', 'dm 发送返回 msg_key')
  check(p2 && p2.body.includes('msg%5Breceiver_id%5D=7') && p2.body.includes('csrf=j1'), 'dm 带 receiver/csrf')

  const w3 = await backend.call({ action: 'triple', args: { bvid: 'BV1aa411c7mD', mode: 'like' }, cookie: COOKIE })
  check(w3.ok && w3.did.includes('点赞'), 'triple like 做了点赞')

  // 写操作缺 csrf → 明确报 NO_CREDENTIAL
  let e1 = ''
  try { await backend.call({ action: 'reply', args: { bvid: 'BV1aa411c7mD', text: 'x' }, cookie: 'SESSDATA=only' }) } catch (e) { e1 = e.message }
  check(/NO_CREDENTIAL/.test(e1), '缺 bili_jct 的写操作报 NO_CREDENTIAL')
} finally {
  globalThis.fetch = realFetch
}

// ── 参数校验 ──
let e2 = ''
try { await backend.call({ action: 'search', args: {}, cookie: '' }) } catch (e) { e2 = e.message }
check(/BAD_ARGS/.test(e2), 'search 缺 keyword 报 BAD_ARGS')

let e3 = ''
try { await backend.call({ action: 'nope', args: {}, cookie: '' }) } catch (e) { e3 = e.message }
check(/BAD_ACTION/.test(e3), '未知 action 报 BAD_ACTION')

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exitCode = failed ? 1 : 0
