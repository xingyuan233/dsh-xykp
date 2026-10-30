// dsh-ntfy · 纯客户端（不依赖宿主）
//
// 这里只依赖 node 内置模块，别的进程（比如 prosecutor 守护进程）也能直接 import：
//   const { push, wait } = await import('dsh-xykp/comms/ntfy/client')
// 插件入口（lib/index.js）在这个基础上加 Config / apply / 工具。

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

export const DEFAULTS = {
  baseUrl: 'https://ntfy.sh',
  defaultTopic: '',
  pollMs: 2000,
  defaultTimeoutSec: 300,
  requestTimeoutMs: 15000,
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const baseOf = (cfg) => String(cfg.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '')

/** ntfy 的 Header 只认 latin1：中文标题要按字节塞进去才不会乱码 */
const latin1 = (s) => Buffer.from(String(s), 'utf8').toString('latin1')

function topicOf(cfg, opts = {}) {
  const topic = String(opts.topic || cfg.defaultTopic || '').trim()
  if (!topic) throw new Error('ntfy：没给 topic，配置里也没有 defaultTopic')
  return topic
}

/** match：函数 → 直接用；纯文本 → 正文完全相等（去首尾空白）；`re:...` → 正则 */
export function matcherOf(match) {
  if (typeof match === 'function') return match
  if (match === undefined || match === null || match === '') return null
  const s = String(match)
  if (s.startsWith('re:')) {
    const re = new RegExp(s.slice(3))
    return (m) => re.test(String(m.message ?? ''))
  }
  const want = s.trim()
  return (m) => String(m.message ?? '').trim() === want
}

const reqInit = (cfg) => ({ signal: AbortSignal.timeout(Math.max(1000, Number(cfg.requestTimeoutMs) || DEFAULTS.requestTimeoutMs)) })

/** 推一条消息；带 filePath 或 body（Buffer）时作为文件附件发出去 */
export async function push(cfgInput, opts = {}) {
  const cfg = { ...DEFAULTS, ...(cfgInput || {}) }
  if (opts.baseUrl) cfg.baseUrl = opts.baseUrl
  const topic = topicOf(cfg, opts)
  const headers = {}
  if (opts.title) headers.Title = latin1(opts.title)
  if (opts.tags) headers.Tags = Array.isArray(opts.tags) ? opts.tags.join(',') : String(opts.tags)
  if (opts.priority !== undefined && opts.priority !== null && opts.priority !== '') headers.Priority = String(opts.priority)
  if (opts.click) headers.Click = String(opts.click)

  let body = opts.message ?? opts.text ?? ''
  let binary = false
  if (opts.filePath) {
    body = await readFile(String(opts.filePath))
    headers.Filename = String(opts.filename || basename(String(opts.filePath)))
    binary = true
  } else if (opts.body !== undefined && opts.body !== null) {
    body = opts.body
    headers.Filename = String(opts.filename || 'attachment.bin')
    binary = true
  }
  if (binary && opts.message) headers.Message = latin1(opts.message)

  const res = await fetch(`${baseOf(cfg)}/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers,
    body,
    ...reqInit(cfg),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* ntfy 出错时回的可能是纯文本 */
  }
  if (!res.ok) throw new Error(`ntfy 推送失败 HTTP ${res.status}：${text.slice(0, 200)}`)
  return { ok: true, topic, id: json?.id ?? null, time: json?.time ?? null, status: res.status, response: json }
}

/** 拉一次（非流式），since 可以是 unix 秒或 'all' */
export async function pollOnce(cfg, topic, since) {
  const url = `${baseOf(cfg)}/${encodeURIComponent(topic)}/json?poll=1&since=${encodeURIComponent(String(since))}`
  const res = await fetch(url, reqInit(cfg))
  const text = await res.text()
  if (!res.ok) throw new Error(`ntfy 拉取失败 HTTP ${res.status}：${text.slice(0, 200)}`)
  const out = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s))
    } catch {
      /* 坏行忽略 */
    }
  }
  return out
}

/**
 * 开一条 ntfy 的流式订阅（不是 poll），读到一条匹配的消息就返回；
 * 到预算时间还没等到就返回 null（不抛）。
 *
 * 为什么用流：ntfy.sh 免费额度按请求数算，2 秒一次 poll = 30 请求/分钟，
 * 一会儿就把额度刷成 429，连二维码都发不出去。流是一条长连接，几乎不占。
 */
async function streamOnce(cfg, topic, since, match, seen, budgetMs) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), Math.max(1000, budgetMs))
  try {
    const url = `${baseOf(cfg)}/${encodeURIComponent(topic)}/json?since=${encodeURIComponent(String(since))}`
    const res = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/x-ndjson' } })
    if (!res.ok) throw new Error(`ntfy 订阅失败 HTTP ${res.status}`)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) return null
      buf += dec.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        let m
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        if (m.event && m.event !== 'message') continue
        if (m.id) {
          if (seen.has(m.id)) continue
          seen.add(m.id)
        }
        if (match && !match(m)) continue
        return m
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError') return null
    throw err
  } finally {
    clearTimeout(timer)
    try {
      ac.abort()
    } catch {}
  }
}

/**
 * 等一条消息。默认从「现在」开始等，返回第一条匹配的 message 事件；
 * 超时返回 { ok:false, timedOut:true, message:null }，不抛。
 * 内部用流式订阅，不轮询。
 */
export async function wait(cfgInput, opts = {}) {
  const cfg = { ...DEFAULTS, ...(cfgInput || {}) }
  const topic = topicOf(cfg, opts)
  const timeoutMs = Math.max(
    0,
    Number(
      opts.timeoutMs !== undefined && opts.timeoutMs !== null
        ? opts.timeoutMs
        : (Number(opts.timeoutSeconds !== undefined ? opts.timeoutSeconds : cfg.defaultTimeoutSec) || 0) * 1000,
    ) || 0,
  )
  const match = matcherOf(opts.match)
  const deadline = Date.now() + timeoutMs
  const since = opts.since !== undefined && opts.since !== null && opts.since !== '' ? opts.since : Math.floor(Date.now() / 1000)
  const seen = new Set()
  let lastError = null

  while (true) {
    const left = deadline - Date.now()
    if (left <= 0) {
      return { ok: false, topic, message: null, timedOut: true, error: lastError ? String(lastError.message || lastError) : null }
    }
    try {
      const m = await streamOnce(cfg, topic, since, match, seen, left)
      if (m) return { ok: true, topic, message: m, timedOut: false }
      lastError = null
    } catch (err) {
      lastError = err
      const msg = String(err?.message || err)
      const backoff = /429/.test(msg) ? Math.min(15000, Math.max(0, deadline - Date.now())) : Math.min(2000, Math.max(0, deadline - Date.now()))
      if (backoff > 0) await sleep(backoff)
    }
  }
}

/** 供插件注入：ctx.get('ntfy') */
export function createService(cfgInput = {}) {
  const cfg = { ...DEFAULTS, ...(cfgInput || {}) }
  return {
    config: cfg,
    push: (opts) => push(cfg, opts),
    wait: (opts) => wait(cfg, opts),
  }
}
