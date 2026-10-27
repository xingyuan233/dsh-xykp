// bili-rove 真实请求冒烟（需要本机 cookie，**只跑读接口**）
//
// 用法：
//   node test/real-smoke.mjs                # 读接口全跑
//   node test/real-smoke.mjs --with-write   # 额外测三连（会真的点赞！慎用）
//
// 数据目录默认 D:\AI\DeepseekHarness\home\bili-duty，可用 BILI_ROVE_DATA_DIR 覆盖。
import { createBackend } from '../lib/backend.js'
import { resolveCookie, credentialOfCookie, uidOf } from '../lib/account.js'
import { checkLogin } from '../lib/login.js'

const DATA_DIR = process.env.BILI_ROVE_DATA_DIR || 'D:\\AI\\DeepseekHarness\\home\\bili-duty'
const cfg = { dataDir: DATA_DIR }
const withWrite = process.argv.includes('--with-write')

let failed = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) failed++
}

const cookie = await resolveCookie(cfg)
check(Boolean(cookie), '从 bili-duty 读到 cookie')
if (!cookie) process.exit(1)
const cred = credentialOfCookie(cookie)
check(Boolean(cred?.bili_jct), 'cookie 里有 bili_jct（能写）')

const st = await checkLogin(cookie)
check(st.ok, 'nav 登录有效', st.ok ? st.uname + ' / ' + st.mid : st.reason)
const me = uidOf(cred) || st.mid

const backend = createBackend({})

async function run(label, action, args = {}) {
  const t0 = Date.now()
  try {
    const r = await backend.call({ action, args, cookie })
    const ms = Date.now() - t0
    console.log(`OK    ${label}  (${ms}ms)`)
    return r
  } catch (e) {
    console.log(`ERR   ${label}  ${String(e?.message || e).slice(0, 160)}`)
    return null
  }
}

// ── 搜索 ──
const search = await run('search', 'search', { keyword: '深海 未知生物', pageSize: 3 })
check(search && Array.isArray(search.items), 'search 返回 items', search ? search.items.length + ' 条' : '')

const bvid = search?.items?.[0]?.bvid
if (bvid) {
  const video = await run('video', 'video', { bvid })
  check(video && video.aid > 0, 'video 拿到 aid/cid', bvid)

  const comments = await run('comments', 'comments', { bvid, num: 5 })
  check(comments && comments.count >= 0, 'comments 能读', comments ? comments.count + ' 条' + (comments.error ? '（有 error）' : '') : '')

  const danmaku = await run('danmaku', 'danmaku', { bvid, num: 10 })
  check(danmaku && danmaku.count >= 0, 'danmaku 能读', danmaku ? danmaku.count + ' 条' : '')

  const subtitles = await run('subtitles', 'subtitles', { bvid })
  if (subtitles && Array.isArray(subtitles.cues)) {
    console.log('OK    subtitles（' + subtitles.cues.length + ' 条字幕）')
  } else {
    console.log('NOTE  subtitles 这条视频没有可用字幕（正常）')
  }
}

// ── 用户 / 收藏 / 热榜 ──
const user = await run('user', 'user', { uid: me })
check(user && user.name, 'user 资料', user?.name || '')
const uv = await run('user_videos', 'user_videos', { uid: me, pageSize: 3 })
check(uv && uv.list, 'user_videos 投稿列表')
const fav = await run('favorites', 'favorites', { uid: me })
check(fav && Array.isArray(fav.list), 'favorites 收藏夹列表', fav ? fav.list.length + ' 个' : '')
const hot = await run('hot', 'hot')
check(hot && Array.isArray(hot.list), 'hot 热门', hot ? hot.list.length + ' 条' : '')
const rank = await run('rank', 'rank', { rid: 1 })
check(rank && Array.isArray(rank.list), 'rank 排行', rank ? rank.list.length + ' 条' : '')

// ── 消息 ──
const at = await run('received_at', 'received_at')
check(at && Array.isArray(at.items), 'received_at', at ? at.items.length + ' 条' : '')
const replies = await run('received_replies', 'received_replies')
check(replies && Array.isArray(replies.items), 'received_replies', replies ? replies.items.length + ' 条' : '')
const sessions = await run('dm_sessions', 'dm_sessions', { size: 5 })
check(sessions && Array.isArray(sessions.items), 'dm_sessions', sessions ? sessions.items.length + ' 个会话' : '')
const recent = await run('dm_recent', 'dm_recent', { size: 5 })
check(recent && Array.isArray(recent.items), 'dm_recent', recent ? recent.items.length + ' 条' : '')

if (withWrite && bvid) {
  // ⚠️ 会真的点赞
  const tri = await run('triple(like)', 'triple', { bvid, mode: 'like' })
  check(tri && tri.ok, 'triple like 成功', JSON.stringify(tri?.did || tri?.error || ''))
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exitCode = failed ? 1 : 0
