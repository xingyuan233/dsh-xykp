// bili-reply 私信拉取自测（不联网，mock fetch）
import { meIdOf, mapDmMessage, createDmFetcher } from '../lib/dm.js'

let failed = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) failed++
}

// cookie 里解析自己的 uid
check(meIdOf('SESSDATA=x; DedeUserID=3546798887013093; bili_jct=y') === 3546798887013093, 'meIdOf 能解析')
check(meIdOf('SESSDATA=x') === 0, '没有 DedeUserID 时返回 0')

// 普通文本
const m1 = mapDmMessage({ sender_uid: 501919726, msg_type: 1, timestamp: 1793068544, msg_seqno: 123, content: JSON.stringify({ content: '测试一下，能看到消息吗' }) }, 501919726)
check(m1.kind === 'dm' && m1.mid === 501919726 && m1.content === '测试一下，能看到消息吗', '普通文本私信')
check(m1.at === 1793068544000, '时间秒转毫秒')

// 分享卡片（没有 content，只有 bvid/title）
const m2 = mapDmMessage({ sender_uid: 1, timestamp: 1793000000, msg_seqno: 456, content: JSON.stringify({ bvid: 'BV1f8HG6dEZA', title: '某个视频', jump_url: 'https://www.bilibili.com/video/BV1f8HG6dEZA' }) }, 501919726)
check(m2.bvid === 'BV1f8HG6dEZA' && m2.isCard === true, '分享卡片抽出 bvid')

// mock fetch：两个会话，一个 unread=1
const calls = []
const fakeFetch = async (url) => {
  calls.push(url)
  if (url.includes('get_sessions')) {
    return { json: async () => ({ code: 0, data: { session_list: [
      { talker_id: 501919726, unread_count: 1, session_ts: 1, last_msg: {} },
      { talker_id: 222222, unread_count: 0, session_ts: 2, last_msg: {} },
    ] } }) }
  }
  return { json: async () => ({ code: 0, data: { messages: [
    { sender_uid: 501919726, msg_seqno: 1, timestamp: 1793068544, content: JSON.stringify({ content: '你好呀' }) },
    { sender_uid: 3546798887013093, msg_seqno: 2, timestamp: 1793068554, content: JSON.stringify({ content: '我自己发的' }) },
  ] } }) }
}
const fetchDms = createDmFetcher({}, fakeFetch)
const dmItems = await fetchDms({ cookie: 'DedeUserID=3546798887013093', meId: 3546798887013093 })
check(dmItems.length === 1, '只拿到对方发的（自己的过滤掉）', `len=${dmItems.length}`)
check(dmItems[0] && dmItems[0].content === '你好呀' && dmItems[0].mid === 501919726, '内容与对方 uid 正确')
check(calls.filter((u) => u.includes('get_sessions')).length === 1, '会话列表只请求一次')
check(calls.filter((u) => u.includes('fetch_session_msgs')).length === 1, '没未读的会话不去翻消息')

// 接口报错要抛
let threw = false
try {
  await createDmFetcher({}, async () => ({ json: async () => ({ code: -101, message: '未登录' }) }))({ cookie: '', meId: 1 })
} catch {
  threw = true
}
check(threw, 'get_sessions 失败时抛错')

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exitCode = failed ? 1 : 0
