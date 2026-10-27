// bili-reply 拉取映射自测（不联网）
//
// 用真实 msgfeed 返回的形状做样本，验证：
//   1. BV 号能从 uri / native_uri 里抽出来
//   2. at / reply 两种条目都能映射成收件结构
//   3. createFetcher 会给两个接口都带上 wbi 签名参数
import { bvidOf, mapMsgfeed, createFetcher } from '../lib/fetch.js'

let failed = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) failed++
}

// 真实样本（2026-10-27 从 /x/msgfeed/at 拿到的手感）
const atSample = {
  id: 1188001015267330,
  user: { mid: 501919726, nickname: '星鸢233' },
  item: {
    type: 'reply',
    business: '评论',
    title: '大肥鱼吃醋了！',
    uri: 'https://www.bilibili.com/video/BV1f8HG6dEZA',
    subject_id: 117500138227692,
    source_id: 321893461488,
    source_content: '@鲸鱼娘摸鱼中 这鱼好像会视监诶🤔',
    native_uri: 'bilibili://video/117500138227692?page=0&comment_root_id=321893461488',
  },
  at_time: 1792955149,
}
const replySample = {
  id: 1164736083763224,
  user: { mid: 3493138626775865, nickname: '布莉吖' },
  item: {
    type: 'reply',
    business: '评论',
    title: '某个视频',
    uri: 'https://www.bilibili.com/video/BV1xx411c7mD',
    source_id: 999,
    source_content: '你说得对',
  },
  at_time: 1792950000,
}

check(bvidOf(atSample) === 'BV1f8HG6dEZA', 'BV 号从 uri 抽出来', bvidOf(atSample))
const m1 = mapMsgfeed(atSample, 'at')
check(m1.kind === 'at' && m1.mid === 501919726 && m1.rpid === '321893461488', 'at 映射基本字段')
check(m1.bvid === 'BV1f8HG6dEZA' && /视监/.test(m1.content), 'at 映射内容与 BV')
check(m1.at === 1792955149000, '时间从秒转毫秒')
const m2 = mapMsgfeed(replySample, 'reply')
check(m2.kind === 'reply' && m2.bvid === 'BV1xx411c7mD', 'reply 映射')

// 假 provider：验证两条接口都带上 wbi（有 w_rid / wts）
const signedPaths = []
const fake = {
  async resolveWbiKeys() { return { imgKey: 'a'.repeat(64), subKey: 'b'.repeat(64) } },
  async requestJson(path, params) {
    signedPaths.push([path, params])
    return { items: [atSample, replySample] }
  },
}
const fetchItems = createFetcher({}, () => fake)
const got = await fetchItems({ cookie: 'C', kinds: ['at', 'reply'] })
check(got.length === 4, '两路各 2 条 → 4 条', `got=${got.length}`)
check(signedPaths.map(([p]) => p).join(',') === '/x/msgfeed/at,/x/msgfeed/reply', '两条接口都请求了')
check(signedPaths.length === 2 && signedPaths.every(([, p]) => p.w_rid && p.wts && String(p.build) === '0' && p.mobi_app === 'web'), 'wbi 签名参数齐全', JSON.stringify(signedPaths[0] && signedPaths[0][1]).slice(0, 80))

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exitCode = failed ? 1 : 0


