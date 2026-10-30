// dsh-ntfy · ntfy 频道通用组件
//
// 两个能力：
//   push(cfg, { topic, message | filePath, title, tags, priority })
//        → 推一条消息（可带文件附件，比如二维码图片）
//   wait(cfg, { topic, match, timeoutMs, since })
//        → 等一条消息出现，比如等主人发 /post；等到了返回那条消息，超时返回 null
//
// 给别的插件复用：本插件 `ctx.provide('ntfy', service)`，别的插件 `ctx.get('ntfy')` 用
//   const ntfy = ctx.get('ntfy')
//   await ntfy.push({ message: 'hello' })
//   const r = await ntfy.wait({ match: '/post', timeoutMs: 60000 })
//
// 给模型用：ntfy_push / ntfy_wait 两个工具。

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'ntfy'

/** tools 没有也能跑（自测环境），有才注册工具 */
export const inject = ['tools']

export const DEFAULTS = {
  baseUrl: 'https://ntfy.sh',
  defaultTopic: '',
  pollMs: 2000,
  defaultTimeoutSec: 300,
  requestTimeoutMs: 15000,
}

export const Config = Schema.object({
  baseUrl: Schema.string().default(DEFAULTS.baseUrl).description('ntfy 服务地址（自建服务器时改这里）'),
  defaultTopic: Schema.string().default('').description('默认主题；留空则每次调用都要传 topic'),
  pollMs: Schema.number().default(DEFAULTS.pollMs).description('wait 时的轮询间隔（毫秒）'),
  defaultTimeoutSec: Schema.number().default(DEFAULTS.defaultTimeoutSec).description('wait 不给 timeout 时的默认超时（秒）'),
  requestTimeoutMs: Schema.number().default(DEFAULTS.requestTimeoutMs).description('单次 HTTP 请求超时（毫秒）'),
})

const log = (...a) => console.log('[ntfy]', ...a)
const warn = (...a) => console.warn('[ntfy]', ...a)

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
function matcherOf(match) {
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
  // 图片/文件消息：ntfy 用 Message 头带一句说明（正文默认变成 "You received a file: ..."）
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
async function pollOnce(cfg, topic, since) {
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
      // 429：等久一点，别把额度越刷越死；其它网络错误短退避
      const backoff = /429/.test(msg) ? Math.min(15000, Math.max(0, deadline - Date.now())) : Math.min(2000, Math.max(0, deadline - Date.now()))
      if (backoff > 0) await sleep(backoff)
    }
  }
}

/** 供别的插件注入：ctx.get('ntfy') */
export function createService(cfgInput = {}) {
  const cfg = { ...DEFAULTS, ...(cfgInput || {}) }
  return {
    config: cfg,
    push: (opts) => push(cfg, opts),
    wait: (opts) => wait(cfg, opts),
  }
}

const jsonOutput = (description) => ({
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: { text: { type: 'string' } },
    description,
  },
  render(_args, value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
  },
})

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...Config(config) }
  const service = createService(cfg)

  try {
    if (typeof ctx.provide === 'function') ctx.provide('ntfy', service)
    else ctx.ntfy = service
  } catch (err) {
    warn('ctx.provide 不可用：', err?.message || err)
  }

  const unregister = []
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    unregister.push(
      ctx.tools.register(
        defineTool({
          name: 'ntfy_push',
          description:
            '往 ntfy 主题推一条消息；带 filePath 时把本地文件作为附件发出去（发二维码图片就用这个）。' +
            '不填 topic 时用配置里的默认主题。',
          parameters: {
            topic: { type: 'string', description: 'ntfy 主题；不填用配置的默认主题' },
            message: { type: 'string', description: '正文（纯文本）；发附件时作为附带说明' },
            title: { type: 'string', description: '通知标题，可选（支持中文）' },
            tags: { type: 'string', description: '标签，逗号分隔，如 rotating_light,qrcode' },
            priority: { type: 'number', description: '优先级 1-5，5 最急' },
            filePath: { type: 'string', description: '要作为附件发送的本地文件路径（图片/任意文件）' },
          },
          output: jsonOutput('推送结果：ok / topic / id / status'),
          async execute(args = {}) {
            return push(cfg, args)
          },
        }),
      ),
    )

    unregister.push(
      ctx.tools.register(
        defineTool({
          name: 'ntfy_wait',
          description:
            '在 ntfy 主题上等一条消息（比如等主人发 /post）。默认从现在开始等，返回第一条匹配的消息；' +
            '超时返回 { ok:false, timedOut:true }。match 写纯文本表示正文完全相等，写 re:... 表示正则。',
          parameters: {
            topic: { type: 'string', description: 'ntfy 主题；不填用配置的默认主题' },
            match: { type: 'string', description: '匹配规则：纯文本=正文完全相等；re:开头=正则' },
            timeoutSeconds: { type: 'number', description: '最多等多少秒，不填用配置的默认值' },
            since: { type: 'string', description: '从哪个时间点开始等（unix 秒或 all）；不填=从现在' },
          },
          output: jsonOutput('等待结果：ok / timedOut / message'),
          async execute(args = {}) {
            return wait(cfg, args)
          },
        }),
      ),
    )
  } else {
    warn('ctx.tools 不可用，跳过工具注册')
  }

  try {
    ctx.on('dispose', () => {
      for (const off of unregister) {
        try {
          off?.()
        } catch {}
      }
    })
  } catch {}

  log('已加载：默认主题=' + (cfg.defaultTopic || '(空)') + '，baseUrl=' + cfg.baseUrl)
}

// 自测用
export const _internal = { pollOnce, matcherOf, topicOf }
