// bili-reply · uid → 昵称 本地缓存
//
// 需求（2026-10-27 10:50）：缓存 uid 到昵称，每条记时间；过了 TTL 可以更新；
// 再给一个「手动重置缓存（重读一遍）」的接口。
//
// 缓存文件默认 <DSH_HOME>/xykp/bilibili/names-cache.json：
//   { "501919726": { "name": "星鸢233", "at": 1793068800000 } }
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const DEFAULTS = {
  namesCachePath: '',
  // 昵称多久算过期（小时），默认 7 天
  namesTtlHours: 168,
  // 一轮最多去查几个新 uid（别一上来刷一堆接口）
  namesMaxFetchPerRun: 5,
}

const CARD_URL = 'https://api.bilibili.com/x/web-interface/card?mid='
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export const emptyCache = () => ({ uids: {} })

export async function loadCache(path) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'))
    const uids = raw && typeof raw.uids === 'object' && raw.uids ? raw.uids : {}
    return { uids }
  } catch {
    return emptyCache()
  }
}

export async function saveCache(path, cache) {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ uids: cache.uids || {} }, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

export function isFresh(entry, ttlHours, now = Date.now()) {
  if (!entry || !entry.name) return false
  const ttl = Math.max(0, Number(ttlHours) || 0)
  if (!ttl) return false
  return now - Number(entry.at || 0) < ttl * 3600000
}

/** 记一条（at/reply 里拿到的昵称也能顺手写进来） */
export function remember(cache, mid, name, now = Date.now()) {
  const key = String(mid || '')
  const v = String(name || '').trim()
  if (!key || !v || key === '0') return false
  const cur = cache.uids[key]
  if (cur && cur.name === v) {
    cur.at = now
    return false
  }
  cache.uids[key] = { name: v, at: now }
  return true
}

/**
 * 把一批 uid 补成昵称：先查缓存（未过期直接用），过期的/没有的按需去接口查（一次最多 maxFetch 个）。
 * @returns {{ names: Record<string,string>, fetched: number, expired: number }}
 */
export async function resolveNames(mids = [], cache, cfg = {}, fetchImpl = fetch, cookie = '') {
  const opts = { ...DEFAULTS, ...(cfg || {}) }
  const now = Date.now()
  const names = {}
  const need = []
  let expired = 0
  for (const raw of mids) {
    const mid = String(raw || '')
    if (!mid || mid === '0' || names[mid]) continue
    const hit = cache.uids[mid]
    if (isFresh(hit, opts.namesTtlHours, now)) {
      names[mid] = hit.name
      continue
    }
    if (hit && hit.name) expired++
    need.push(mid)
  }

  const maxFetch = Math.max(0, Number(opts.namesMaxFetchPerRun) || 0)
  let fetched = 0
  for (const mid of need) {
    if (fetched >= maxFetch) break
    try {
      const r = await fetchImpl(CARD_URL + encodeURIComponent(mid), {
        headers: { 'user-agent': UA, ...(cookie ? { cookie } : {}) },
      })
      const j = await r.json()
      const name = j && j.code === 0 && j.data && j.data.card ? String(j.data.card.name || '') : ''
      if (!name) continue
      names[mid] = name
      cache.uids[mid] = { name, at: now }
      fetched++
    } catch {
      // 单个失败不影响别人
    }
  }
  return { names, fetched, expired }
}
