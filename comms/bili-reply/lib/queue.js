// bili-reply · 本地收件队列
//
// 需求（2026-10-27 09:39 主人补充）：
//   · 一次把信息全拉到本地文件，再慢慢处理；本地处理完了才再去接口拉
//   · 每次最多处理 maxPerTick 条（默认 2），最短间隔 tickMinutes（默认 3 分钟）
//   · 本地最多保留 maxQueue 条（默认 120），超了随机删
//   · keepUids 里的 uid（默认主人自己）的条目**不会被随机删**
//   · 每条带昵称，方便认人
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const DEFAULTS = {
  maxPerTick: 2,
  tickMinutes: 3,
  maxQueue: 120,
  // B站 uid，这些人的条目不会被随机淘汰（默认是主人 3546798887013093）
  keepUids: [3546798887013093],
  // 队列文件自带的说明，免得认不出来
  name: 'B站收件箱（bili-reply 本地队列）',
}

const empty = () => ({ name: DEFAULTS.name, items: [], seen: {}, lastPullAt: 0, updatedAt: '' })

export async function loadQueue(path, fallbackName) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'))
    return {
      name: String(raw.name || fallbackName || DEFAULTS.name),
      items: Array.isArray(raw.items) ? raw.items : [],
      seen: raw.seen && typeof raw.seen === 'object' ? raw.seen : {},
      lastPullAt: Number(raw.lastPullAt) || 0,
      updatedAt: String(raw.updatedAt || ''),
    }
  } catch {
    return { ...empty(), name: fallbackName || DEFAULTS.name }
  }
}

export async function saveQueue(path, q) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    JSON.stringify({ name: q.name, items: q.items, seen: q.seen, lastPullAt: q.lastPullAt, updatedAt: new Date().toISOString() }, null, 2),
    'utf8',
  )
}

/** 入队：已经在队列里或处理过的跳过 */
export function enqueue(q, items = []) {
  const have = new Set(q.items.map((x) => x.key))
  let added = 0
  for (const it of items) {
    const key = it.key || `${it.kind}:${it.id || it.rpid || it.at}`
    if (have.has(key) || q.seen[key]) continue
    q.items.push({ ...it, key, addedAt: Date.now() })
    have.add(key)
    added++
  }
  return added
}

/**
 * 裁剪：超过 maxQueue 时随机删（保留 keepUids 的人 + 最新的几条）。
 * 删掉的记进 seen，避免下次拉回来又进队。
 */
export function trim(q, cfg = {}) {
  const opts = { ...DEFAULTS, ...(cfg || {}) }
  const max = Math.max(1, Number(opts.maxQueue) || DEFAULTS.maxQueue)
  if (q.items.length <= max) return 0
  const keep = new Set((opts.keepUids || []).map((x) => String(x)))
  const keepItems = []
  const pool = []
  for (const it of q.items) {
    if (keep.has(String(it.mid || ''))) keepItems.push(it)
    else pool.push(it)
  }
  // 保留列表里的全留，剩下的池子里随机删到够数
  const room = Math.max(0, max - keepItems.length)
  const shuffled = pool.map((v) => ({ v, r: Math.random() })).sort((a, b) => a.r - b.r).map((x) => x.v)
  const keepFromPool = shuffled.slice(0, room)
  const dropped = shuffled.slice(room)
  for (const d of dropped) q.seen[d.key] = { at: Date.now(), dropped: true }
  q.items = [...keepItems, ...keepFromPool].sort((a, b) => (a.at || 0) - (b.at || 0))
  return dropped.length
}

/** 退避阶梯（分钟）：10 / 20 / 30 / 40，之后每小时一次 */
export const BACKOFF_MINUTES = [10, 20, 30, 40, 60]

export function backoffOf(tries) {
  const i = Math.min(Math.max(1, Number(tries) || 1) - 1, BACKOFF_MINUTES.length - 1)
  return BACKOFF_MINUTES[i]
}

/**
 * 推送失败：不丢数据，只是记一次失败 + 排下次重试时间。
 * ⚠ 2026-10-27 主人要求：不要 3 次就丢，崩一下数据就废几条。
 */
export function failItem(item, now = Date.now()) {
  item.tries = Number(item.tries || 0) + 1
  item.lastFailAt = now
  item.nextTryAt = now + backoffOf(item.tries) * 60000
  return item
}

/** 取下一批要处理的（最早、且已经到重试时间的） */
export function take(q, maxPerTick, now = Date.now()) {
  const n = Math.max(1, Number(maxPerTick) || DEFAULTS.maxPerTick)
  return q.items.filter((x) => !x.nextTryAt || x.nextTryAt <= now).slice(0, n)
}

/** 处理完从队列里去掉，并记进 seen */
export function consume(q, batch = []) {
  const keys = new Set(batch.map((b) => b.key))
  q.items = q.items.filter((x) => !keys.has(x.key))
  for (const k of keys) q.seen[k] = { at: Date.now(), done: true }
  // seen 别无限长：只留最近 500 条
  const entries = Object.entries(q.seen)
  if (entries.length > 500) {
    q.seen = Object.fromEntries(entries.sort((a, b) => Number(b[1].at || 0) - Number(a[1].at || 0)).slice(0, 500))
  }
}

