// finch · DSH 宿主半边
//
// 干的事：
//   1. 长轮询本地 Finch 桥（默认 127.0.0.1:8710）的 /v1/inbound，把新消息注入目标会话
//   2. 一轮回复结束后，把最终回复自动发回来源聊天（除非回的是 [[SILENT]]）
//   3. 提供 finch_send / finch_read / finch_status 三个工具
//
// 所有异常只记日志，绝不拖死宿主；没配 bridgeToken 时插件保持静默。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { configFor } from '../../../ui/store.js'

export const name = 'finch'

/** agents 必须有；tools / systemPrompt 缺失时降级 */
export const inject = ['agents', 'tools', 'systemPrompt']

export const SOURCE_KIND = 'plugin:finch'

const log = (...args) => console.log('[finch]', ...args)
const warn = (...args) => console.warn('[finch]', ...args)

const DEFAULTS = {
  bridgeUrl: 'http://127.0.0.1:8710',
  bridgeToken: '',
  target: 'p-alive',
  deliverMode: 'steer',
  pollWait: 20,
  autoReply: true,
  silentMarker: '[[SILENT]]',
  maxReplyChars: 3200,
  seenLimit: 500,
}

export const Config = Schema.object({
  bridgeUrl: Schema.string().default(DEFAULTS.bridgeUrl)
    .description('本地 Finch 桥地址（默认 http://127.0.0.1:8710）'),
  bridgeToken: Schema.string().default(DEFAULTS.bridgeToken)
    .description('桥的 API token（和 bridge.json 里的 api_token 一致）'),
  target: Schema.string().default(DEFAULTS.target)
    .description('消息投到哪个会话：p-<预设名>（跟随预设绑定）或 session-<id> 或裸 id'),
  deliverMode: Schema.union([Schema.const('steer'), Schema.const('followup')])
    .default(DEFAULTS.deliverMode)
    .description('steer=插队（这轮就跑）/ followup=排队（下一轮）'),
  pollWait: Schema.number().default(DEFAULTS.pollWait)
    .description('长轮询等待秒数（0-30）'),
  autoReply: Schema.boolean().default(DEFAULTS.autoReply)
    .description('这一轮的回复自动发回来源聊天（[[SILENT]] 除外）'),
  silentMarker: Schema.string().default(DEFAULTS.silentMarker)
    .description('回复这个标记表示不说话'),
  maxReplyChars: Schema.number().default(DEFAULTS.maxReplyChars)
    .description('单条回复最大字符数，超了自动分段'),
  seenLimit: Schema.number().default(DEFAULTS.seenLimit)
    .description('记住多少个聊天已投递到的最大消息 id（去重用）'),
})

function home() {
  return process.env.DSH_HOME || 'D:\\AI\\DeepseekHarness\\home'
}

function statePath() {
  return join(home(), 'xykp', 'finch', 'state.json')
}

function canonSessionId(value) {
  let id = String(value || '')
  for (let i = 0; i < 2; i += 1) {
    if (id.startsWith('session-')) id = id.slice('session-'.length)
    else if (id.startsWith('s-')) id = id.slice(2)
  }
  return id
}

function sessionCandidates(value) {
  const raw = String(value || '').trim()
  const bare = canonSessionId(raw)
  const out = new Set()
  for (const candidate of [raw, bare, `session-${bare}`, `s-session-${bare}`, `s-${bare}`]) {
    if (candidate) out.add(candidate)
  }
  return [...out]
}

function extractText(message) {
  if (!message) return ''
  if (typeof message === 'string') return message.trim()
  const blocks = Array.isArray(message.content) ? message.content : []
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function splitChunks(text, maxChars) {
  const limit = Math.max(200, Number(maxChars) || 3200)
  if (text.length <= limit) return [text]
  const chunks = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit)
    if (cut < limit * 0.5) cut = limit
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) chunks.push(rest)
  return chunks.filter(Boolean)
}

async function readJsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJsonFile(path, value) {
  await mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, path)
}

export async function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...Config(configFor('finch', config)) }
  if (!cfg.bridgeToken) {
    warn('没有配置 bridgeToken，finch 通道不启动')
    return
  }
  const base = cfg.bridgeUrl.replace(/\/+$/, '')
  const headers = {
    Authorization: `Bearer ${cfg.bridgeToken}`,
    'Content-Type': 'application/json',
  }

  const state = await readJsonFile(statePath(), {})
  let cursor = Number(state.cursor) || 0
  const delivered = new Map(Object.entries(state.delivered || {}).map(([k, v]) => [k, Number(v) || 0]))
  const pending = new Map()          // canonSessionId -> { conversationId, lastMessageId, armed, sawOutput, at }
  const recentSends = []             // { conversationId, text, at }
  const lastInboundConv = { id: '' }

  const saveState = async () => {
    const entries = [...delivered.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(20, cfg.seenLimit))
    try {
      await writeJsonFile(statePath(), { cursor, delivered: Object.fromEntries(entries), updatedAt: Date.now() })
    } catch (err) {
      warn('保存状态失败：', err?.message || err)
    }
  }

  const api = async (path, { method = 'GET', body, timeoutMs = 25000 } = {}) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(base + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      const text = await res.text()
      let data = null
      try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
      if (!res.ok) {
        const message = data?.error?.message || `bridge HTTP ${res.status}`
        throw new Error(message)
      }
      return data
    } finally {
      clearTimeout(timer)
    }
  }

  // ── 目标解析 ──────────────────────────────────────────────
  const resolveTarget = async () => {
    const ref = String(cfg.target || '').trim()
    if (!ref) return ''
    if (ref.startsWith('p-')) {
      const binder = await readJsonFile(
        join(home(), 'xykp', 'preset-binder', 'preset-binder.json'), null)
      const active = binder?.presets?.[ref.slice(2)]?.active
      if (!active) throw new Error(`预设 ${ref} 没有绑定会话`)
      return String(active)
    }
    return ref
  }

  const findAgent = (sessionId) => {
    for (const id of sessionCandidates(sessionId)) {
      try {
        const agent = ctx.agents.get(id)
        if (agent) return agent
      } catch { /* 当没有 */ }
    }
    return null
  }

  const ensureAgent = async (sessionId) => {
    let agent = findAgent(sessionId)
    if (agent) return { agent, sessionId }
    const candidates = sessionCandidates(sessionId)
    let lastError = null
    for (const candidate of candidates) {
      try {
        const handle = await ctx.agents.resume({ resumeSessionId: candidate })
        agent = (handle && handle.agent) || findAgent(candidate) || findAgent(sessionId)
        if (agent) {
          // resume 出来的 agent 可能没挂预设，这一轮就跑不起来 —— 补挂
          try {
            const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : null
            const header = agent.session && agent.session.header
            const want = String((header && (header.agentPreset || header.preset)) || '')
            const has = presets && typeof presets.composedPreset === 'function'
              ? presets.composedPreset(agent.ctx) : ''
            if (presets && want && !has && typeof presets.mount === 'function') {
              await presets.mount(agent.ctx, want)
              log(`resume 后补挂预设 ${want}`)
            }
          } catch (err) {
            warn('补挂预设失败：', err?.message || err)
          }
          return { agent, sessionId: candidate }
        }
      } catch (err) {
        lastError = err
      }
    }
    throw new Error(`找不到会话 ${sessionId}${lastError ? `：${lastError.message}` : ''}`)
  }

  const deliverText = async (text) => {
    const sessionId = await resolveTarget()
    if (!sessionId) throw new Error('finch target 为空')
    const { agent, sessionId: actual } = await ensureAgent(sessionId)
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: SOURCE_KIND },
    })
    if (cfg.deliverMode === 'followup') await agent.followup(message)
    else await agent.steer(message)
    return { sessionId: actual }
  }

  // ── 收消息 ────────────────────────────────────────────────
  const formatIncoming = (event) => {
    const who = event?.sender?.display_name || event?.sender?.username || '?'
    const head = event?.is_group
      ? `[雀语·群「${event.conversation_title || '群聊'}」]`
      : '[雀语]'
    const attachments = (event?.attachments || []).map((att) => {
      const mime = String(att?.mime || '')
      return mime.startsWith('image/') ? `[图片:${att.name}]` : `[文件:${att.name}]`
    }).join(' ')
    const body = [event?.text || '', attachments].filter(Boolean).join(' ')
    return body ? `${head} ${who}: ${body}` : ''
  }

  const handleConversation = async (conversationId, events) => {
    const lastId = events[events.length - 1].id
    if ((delivered.get(conversationId) || 0) >= lastId) return
    const text = events.map(formatIncoming).filter(Boolean).join('\n')
    if (!text) {
      delivered.set(conversationId, lastId)
      await saveState()
      return
    }
    let result = null
    try {
      result = await deliverText(text)
    } catch (err) {
      warn('注入失败：', err?.message || err)
      throw err
    }
    pending.set(canonSessionId(result.sessionId), {
      conversationId,
      lastMessageId: lastId,
      armed: false,
      sawOutput: false,
      at: Date.now(),
    })
    lastInboundConv.id = conversationId
    delivered.set(conversationId, lastId)
    await saveState()
    log(`注入 ${conversationId} → ${result.sessionId}（${events.length} 条，id ${lastId}）`)
  }

  const handleEvents = async (events) => {
    const groups = new Map()
    for (const event of events) {
      if (!event || !event.id) continue
      if ((delivered.get(event.conversation_id) || 0) >= event.id) continue
      const list = groups.get(event.conversation_id) || []
      list.push(event)
      groups.set(event.conversation_id, list)
    }
    for (const [conversationId, list] of groups) {
      try {
        await handleConversation(conversationId, list)
      } catch {
        // 这一路失败就停在这儿，下一轮从同一个 cursor 重试
        return false
      }
    }
    return true
  }

  let disposed = false
  const controller = new AbortController()
  const cleanup = () => {
    disposed = true
    try { controller.abort() } catch { /* ignore */ }
  }
  try { ctx.on('dispose', cleanup) } catch { /* older host */ }

  const pollLoop = async () => {
    let backoff = 2000
    while (!disposed) {
      try {
        const wait = Math.max(0, Math.min(30, Number(cfg.pollWait) || 20))
        const data = await api(
          `/v1/inbound?after=${cursor}&wait=${wait}`,
          { timeoutMs: (wait + 15) * 1000 },
        )
        const events = Array.isArray(data?.events) ? data.events : []
        if (events.length) {
          const advanced = await handleEvents(events)
          const maxId = Math.max(...events.map((e) => Number(e.id) || 0))
          if (advanced || maxId > cursor) {
            if (advanced) cursor = maxId
            await saveState()
          }
          backoff = 2000
        }
      } catch (err) {
        if (disposed) break
        warn('轮询失败：', err?.message || err)
        await new Promise((resolve) => setTimeout(resolve, backoff))
        backoff = Math.min(backoff * 2, 30000)
      }
    }
  }
  setTimeout(() => { void pollLoop() }, 800)

  // ── 自动回发 ──────────────────────────────────────────────
  const rememberSend = (conversationId, text) => {
    recentSends.push({ conversationId, text, at: Date.now() })
    while (recentSends.length > 200) recentSends.shift()
    const cutoff = Date.now() - 5 * 60_000
    while (recentSends.length && recentSends[0].at < cutoff) recentSends.shift()
  }

  const sendToChat = async (conversationId, text, replyToId = 0) => {
    for (const chunk of splitChunks(text, cfg.maxReplyChars)) {
      await api('/v1/send', {
        method: 'POST',
        body: { conversation_id: conversationId, text: chunk, reply_to_id: replyToId || 0 },
      })
      rememberSend(conversationId, chunk)
    }
  }

  const replyFor = async (info, text) => {
    if (!info?.conversationId || !text) return
    if (/^\[\[SILENT\]\]$/i.test(text.trim())) return
    const duplicate = recentSends.some((item) =>
      item.conversationId === info.conversationId && item.text === text
      && Date.now() - item.at < 90_000)
    if (duplicate) {
      log('这条已经用工具发过，跳过自动回发')
      return
    }
    try {
      await sendToChat(info.conversationId, text, cfg.autoReply ? info.lastMessageId : 0)
      log(`自动回发 ${info.conversationId}（${text.length} 字）`)
    } catch (err) {
      warn('自动回发失败：', err?.message || err)
    }
  }

  const onSessionEvent = async (session, event) => {
    if (!cfg.autoReply) return
    const key = canonSessionId(session && session.id)
    const info = pending.get(key)
    if (!info) return
    if (Date.now() - info.at > 15 * 60_000) { pending.delete(key); return }
    if (!event || typeof event !== 'object') return
    if (event.type === 'user/message') {
      if (event?.data?.source?.kind === SOURCE_KIND) {
        info.armed = true
        info.sawOutput = false
      }
      return
    }
    if (!info.armed) return
    if (event.type === 'assistant/message') {
      const text = extractText(event?.data?.message)
      if (!text) return
      info.sawOutput = true
      if (text.trim() === cfg.silentMarker) return
      await replyFor(info, text)
      return
    }
    if (event.type === 'turn/end') {
      pending.delete(key)
    }
  }
  try {
    ctx.on('session/event', (session, event) => {
      void onSessionEvent(session, event).catch((err) => warn('处理会话事件失败：', err?.message || err))
    })
  } catch (err) {
    warn('挂 session/event 失败：', err?.message || err)
  }

  // ── 系统提示词 ────────────────────────────────────────────
  try {
    if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
      ctx.systemPrompt.section({
        name: 'finch:channel',
        order: 10400,
        text: () => [
          '## 雀语通道',
          '你有一个自建 IM「雀语」（Finch）通道。好友发来的消息会以 `[雀语] 名字: …` / `[雀语·群「群名」] …` 的形式出现在对话里。',
          '- 直接回复即可，这一轮的回复会自动发回来源聊天；不想说话就只回复 [[SILENT]]。',
          '- 想主动发消息、翻聊天记录、查桥状态时用 finch_send / finch_read / finch_status。',
        ].join('\n'),
      })
    }
  } catch (err) {
    warn('注入系统提示词失败：', err?.message || err)
  }

  // ── 工具 ──────────────────────────────────────────────────
  let defineTool = (spec) => spec
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (mod && typeof mod.defineTool === 'function') defineTool = mod.defineTool
  } catch { /* 自测环境没有宿主包 */ }

  const resolveConversation = async (args) => {
    const explicit = String(args.conversation_id || '').trim()
    if (explicit) return explicit
    const to = String(args.to || '').trim()
    const chats = (await api('/v1/chats'))?.chats || []
    if (to) {
      const name = to.replace(/^@/, '').toLowerCase()
      const hit = chats.find((chat) =>
        (chat.type === 'dm' && String(chat.peer?.username || '').toLowerCase() === name)
        || String(chat.title || '').toLowerCase() === name)
      if (hit) return hit.id
      throw new Error(`找不到聊天：${to}`)
    }
    if (lastInboundConv.id) return lastInboundConv.id
    throw new Error('需要 conversation_id 或 to（也可以先收到一条消息）')
  }

  const toolOutput = (result) => ({
    content: [{ type: 'text', text: JSON.stringify(result) }],
  })

  try {
    if (ctx.tools && typeof ctx.tools.register === 'function') {
      ctx.tools.register(defineTool({
        name: 'finch_send',
        description: '用「雀语」发一条消息。chat 可以写 conversation_id，或 to=@用户名 / 群名；text 必填。',
        parameters: {
          conversation_id: { type: 'string', description: '会话 id（可选）' },
          to: { type: 'string', description: '@用户名 或 群名（可选）' },
          text: { type: 'string', description: '消息正文', required: true },
          reply_to_id: { type: 'number', description: '引用哪条消息（可选）' },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
        },
        async execute(args) {
          const conversationId = await resolveConversation(args)
          const text = String(args.text ?? '').trim()
          if (!text) throw new Error('text 不能为空')
          const data = await api('/v1/send', {
            method: 'POST',
            body: {
              conversation_id: conversationId,
              text,
              reply_to_id: Number(args.reply_to_id) || 0,
            },
          })
          const message = data?.message || {}
          rememberSend(conversationId, text)
          return toolOutput({ ok: true, conversation_id: conversationId, message_id: message.id })
        },
      }))

      ctx.tools.register(defineTool({
        name: 'finch_read',
        description: '读「雀语」：不带 conversation_id 时列出聊天和未读数；带了就读最近消息。',
        parameters: {
          conversation_id: { type: 'string', description: '会话 id（可选）' },
          limit: { type: 'number', description: '条数，默认 20' },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
        },
        async execute(args) {
          const limit = Math.max(1, Math.min(100, Number(args.limit) || 20))
          const conversationId = String(args.conversation_id || '').trim()
          if (!conversationId) {
            const data = await api('/v1/chats')
            const chats = (data?.chats || []).map((chat) => ({
              id: chat.id,
              type: chat.type,
              title: chat.title,
              unread: chat.unread,
              last: chat.last_message?.text || '',
              at: chat.last_message?.created_at || 0,
            }))
            return toolOutput({ ok: true, chats })
          }
          const data = await api(`/v1/messages?conversation_id=${encodeURIComponent(conversationId)}&limit=${limit}`)
          const messages = (data?.messages || []).map((msg) => ({
            id: msg.id,
            from: msg.sender?.display_name || msg.sender?.username || '?',
            text: msg.text,
            attachments: (msg.attachments || []).map((att) => att.name),
            at: msg.created_at,
          }))
          return toolOutput({ ok: true, conversation_id: conversationId, messages })
        },
      }))

      ctx.tools.register(defineTool({
        name: 'finch_status',
        description: '看「雀语」桥的连接状态、当前账号、排队的消息数和插件游标。',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
        },
        async execute() {
          const status = await api('/v1/status')
          return toolOutput({
            ok: true,
            connected: status?.connected,
            user: status?.user?.username,
            queued: status?.queued,
            cursor,
            pending: [...pending.entries()].map(([key, info]) => ({ session: key, ...info })),
          })
        },
      }))
    }
  } catch (err) {
    warn('注册工具失败：', err?.message || err)
  }

  log(`通道已启动：${base}，目标 ${cfg.target}，游标 ${cursor}`)
}

export const _internal = { canonSessionId, sessionCandidates, extractText, splitChunks }
