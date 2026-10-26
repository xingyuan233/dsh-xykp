// dsh-xykp · chat/token-reporter/usage.js
//
// 从 DSH 自己的会话日志里聚合「某时间段的 token 用量」。
//
// 数据源：$DSH_HOME/sessions/<workspace>/<session>/session*.jsonl[.zstd]
// 每个 assistant/message 事件的 data.usage 就是 provider 上报的精确用量
// （inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens / totalTokens），
// 事件 time 是毫秒时间戳，message.source 带 provider/model。
//
// 为什么不用 preset-binder 的表：那张表只记配置里列出的预设（standard/ptc/minimal/cordis
// 明确被 ignore），而且 maxSessions 只留最近 5 个，覆盖不全。日志才是全量。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as zlib from 'node:zlib'

const zstd = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : undefined

/** path -> { mtimeMs, events } 解析缓存；同一个文件没变就不重复解压。 */
const cache = new Map()

function parseSessionFile(path) {
  const stat = statSync(path)
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.events

  const raw = path.endsWith('.zstd') ? zstd(readFileSync(path)) : readFileSync(path)
  const events = []
  for (const line of raw.toString('utf8').split('\n')) {
    if (!line.includes('"usage"')) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event?.type !== 'assistant/message') continue
    const usage = event.data?.usage
    if (!usage) continue
    const source = event.data?.message?.source
    events.push({
      t: Number(event.time) || 0,
      provider: source?.provider ?? '',
      model: source?.model ?? '',
      input: Number(usage.inputTokens) || 0,
      output: Number(usage.outputTokens) || 0,
      cacheRead: Number(usage.cacheReadTokens) || 0,
      cacheWrite: Number(usage.cacheWriteTokens) || 0,
      total: Number(usage.totalTokens) || 0,
    })
  }
  cache.set(path, { mtimeMs: stat.mtimeMs, events })
  return events
}

/** 列出结算时间晚于 sinceMs 的会话文件（mtime 更早的文件不可能有新事件）。 */
function listSessionFiles(root, sinceMs) {
  const out = []
  let workspaces = []
  try {
    workspaces = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return out
  }
  for (const ws of workspaces) {
    const wsDir = join(root, ws.name)
    let sessions = []
    try {
      sessions = readdirSync(wsDir, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch {
      continue
    }
    for (const session of sessions) {
      let files = []
      try {
        files = readdirSync(join(wsDir, session.name)).filter((f) => f.includes('.jsonl'))
      } catch {
        continue
      }
      for (const file of files) {
        const full = join(wsDir, session.name, file)
        try {
          const stat = statSync(full)
          if (stat.mtimeMs >= sinceMs) out.push({ path: full, mtimeMs: stat.mtimeMs })
        } catch {}
      }
    }
  }
  return out
}

function emptyBucket() {
  return { attempts: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

function addTo(bucket, event) {
  bucket.attempts += 1
  bucket.input += event.input
  bucket.output += event.output
  bucket.cacheRead += event.cacheRead
  bucket.cacheWrite += event.cacheWrite
  bucket.total += event.total || event.input + event.output + event.cacheRead + event.cacheWrite
}

function localDay(ms) {
  const date = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 聚合一个时间窗口内的用量。
 * @param {object} opts
 * @param {string} opts.root 会话根目录（$DSH_HOME/sessions）
 * @param {number} opts.sinceMs 起始毫秒
 * @param {number} [opts.untilMs] 结束毫秒，默认现在
 * @param {string} [opts.provider] provider 子串过滤（大小写不敏感）
 * @param {string} [opts.model] model 子串过滤
 * @returns {{attempts:number, sessions:number, totals:object, days:object[], models:object[], skipped:number}}
 */
export function scanUsage({ root, sinceMs, untilMs = Date.now(), provider, model }) {
  const providerNeedle = (provider ?? '').toLowerCase()
  const modelNeedle = (model ?? '').toLowerCase()
  const files = listSessionFiles(root, sinceMs)
  const totals = emptyBucket()
  const days = new Map()
  const models = new Map()
  let sessionsHit = new Set()
  let skipped = 0

  for (const file of files) {
    let events
    try {
      events = parseSessionFile(file.path)
    } catch {
      skipped += 1
      continue
    }
    for (const event of events) {
      if (event.t < sinceMs || event.t > untilMs) continue
      if (providerNeedle && !event.provider.toLowerCase().includes(providerNeedle)) continue
      if (modelNeedle && !event.model.toLowerCase().includes(modelNeedle)) continue
      addTo(totals, event)
      sessionsHit.add(file.path)

      const day = localDay(event.t)
      if (!days.has(day)) days.set(day, emptyBucket())
      addTo(days.get(day), event)

      const key = `${event.provider}/${event.model}`
      if (!models.has(key)) models.set(key, { provider: event.provider, model: event.model, ...emptyBucket() })
      addTo(models.get(key), event)
    }
  }

  const byDate = [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  return {
    attempts: totals.attempts,
    sessions: sessionsHit.size,
    filesScanned: files.length,
    skipped,
    totals,
    days: byDate.map(([date, bucket]) => ({ date, ...bucket })),
    models: [...models.values()].sort((a, b) => b.total - a.total),
  }
}
