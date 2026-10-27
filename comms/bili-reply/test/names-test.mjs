// 昵称缓存自测（不联网，mock fetch）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCache, saveCache, remember, isFresh, resolveNames, emptyCache, DEFAULTS } from '../lib/names.js'

let failed = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) failed++
}

// 记一条
const c = emptyCache()
check(remember(c, 501919726, '星鸢233') === true, 'remember 记新昵称')
check(remember(c, 501919726, '星鸢233') === false, '同样的昵称不重复记（只更新时间）')
check(c.uids['501919726'].name === '星鸢233', '缓存里有值')

// 过期判断
const now = Date.now()
check(isFresh({ name: 'x', at: now - 1000 }, 1) === true, '1 小时前的算新鲜')
check(isFresh({ name: 'x', at: now - 2 * 3600000 }, 1) === false, '2 小时前的算过期')
check(isFresh({ name: '', at: now }, 1) === false, '空昵称永远不算新鲜')
check(isFresh({ name: 'x', at: now }, 0) === false, 'ttl=0 等于不过期？不，等于永远过期')

// resolveNames：缓存命中不查、缺的查、受 maxFetch 限制
const cache = { uids: { 111: { name: '老熟人', at: Date.now() } } }
let queries = 0
const fakeFetch = async (url) => {
  queries++
  const mid = url.split('mid=')[1]
  return { json: async () => ({ code: 0, data: { card: { name: '名字' + mid } } }) }
}
const r1 = await resolveNames([111, 222, 333], cache, { namesTtlHours: 168, namesMaxFetchPerRun: 1 }, fakeFetch)
check(r1.names['111'] === '老熟人', '缓存命中的直接用')
check(queries === 1, '一轮最多查 maxFetch 个新 uid', `queries=${queries}`)
check(cache.uids['222'] && cache.uids['222'].name === '名字222', '查到的新昵称进了缓存')

// 过期条目会被重查
const stale = { uids: { 444: { name: '旧名字', at: Date.now() - 30 * 86400000 } } }
const r2 = await resolveNames([444], stale, { namesTtlHours: 24, namesMaxFetchPerRun: 5 }, fakeFetch)
check(r2.expired === 1, '过期条目被计数')
check(r2.names['444'] === '名字444' && stale.uids['444'].name === '名字444', '过期后拿到新昵称并覆盖')

// 落盘往返
const dir = mkdtempSync(join(tmpdir(), 'names-'))
const p = join(dir, 'cache.json')
const c2 = emptyCache()
remember(c2, 999, '测试用户')
await saveCache(p, c2)
const back = await loadCache(p)
check(back.uids['999'] && back.uids['999'].name === '测试用户', '存盘再读回来还在')
rmSync(dir, { recursive: true, force: true })

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exitCode = failed ? 1 : 0
