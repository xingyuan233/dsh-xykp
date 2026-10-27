// bili-rove backend 自测（不联网，用假 provider）
//
// 覆盖：action → provider 方法的参数映射、参数校验、未接能力的报错、provider 缓存
import { createBackend } from '../lib/backend.js'

let failed = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) failed++
}

const calls = []
const fakeProvider = {
  async search(r) { calls.push(['search', r]); return { rows: [] } },
  async video(r) { calls.push(['video', r]); return { bvid: r.bvid } },
  async subtitles(r) { calls.push(['subtitles', r]); return { cues: [] } },
}
let made = 0
const backend = createBackend({}, (opts) => { made++; fakeProvider.opts = opts; return fakeProvider })

const r1 = await backend.call({ action: 'search', args: { keyword: ' 测试 ', page: 2, pageSize: 99 }, cookie: 'C1' })
check(calls[0][0] === 'search' && calls[0][1].keyword === '测试', 'search 参数映射（去空格）', JSON.stringify(calls[0][1]))
check(calls[0][1].page === 2 && calls[0][1].pageSize === 20, 'page / pageSize 会被钳制')
check(fakeProvider.opts.cookie === 'C1', 'cookie 传给了 provider')

const r2 = await backend.call({ action: 'video', args: { bvid: 'BV1xx411c7mD' }, cookie: 'C1' })
check(r2.bvid === 'BV1xx41c7mD' || r2.bvid === 'BV1xx411c7mD', 'video 返回 bvid')

await backend.call({ action: 'video', args: { bvid: 'BV2' }, cookie: 'C1' })
check(made === 1, '同一 cookie 复用 provider 实例', `made=${made}`)
await backend.call({ action: 'video', args: { bvid: 'BV3' }, cookie: 'C2' })
check(made === 2, '换了 cookie 建新实例', `made=${made}`)

let err1 = ''
try { await backend.call({ action: 'search', args: {}, cookie: '' }) } catch (e) { err1 = e.message }
check(/BAD_ARGS/.test(err1), 'search 缺 keyword 报 BAD_ARGS')

let err2 = ''
try { await backend.call({ action: 'reply', args: {}, cookie: '' }) } catch (e) { err2 = e.message }
check(/NOT_WIRED/.test(err2), '未接能力报 NOT_WIRED', err2)

let err3 = ''
try { await backend.call({ action: 'nope', args: {}, cookie: '' }) } catch (e) { err3 = e.message }
check(/BAD_ACTION/.test(err3), '未知 action 报 BAD_ACTION')

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exitCode = failed ? 1 : 0
