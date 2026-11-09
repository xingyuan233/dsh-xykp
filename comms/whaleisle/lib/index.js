// whaleisle · DSH 宿主半边
//
// 干的事：
//   1. 长轮询本地 WhaleIsle 桥（默认 127.0.0.1:8710）的 /v1/inbound，把新消息注入目标会话
//   2. 一轮回复结束后，把最终回复自动发回来源聊天（除非回的是 [[SILENT]]）
//   3. 提供 whaleisle_send / whaleisle_read / whaleisle_status / whaleisle_bind 工具
//   4. 分流：名单（黑/白）+ 绑定（bindings.json / config.mappings）+ 默认目标（预设/会话）
//
// 所有异常只记日志，绝不拖死宿主；没配 bridgeToken 时插件保持静默。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { configFor } from '../../../ui/store.js'
import {
  DEFAULTS as ROUTE_DEFAULTS, chatKeyOf, normalizeKey, parseTargetRef, resolveRoute,
} from './routing.js'
import {
  ago, listSessions, newSessionId, presetActive, presetPools, readBindings, readSessionTitle,
  writeBinding,
} from './bindings.js'

export const name = 'whaleisle'

/** agents 必须有；tools / systemPrompt 缺失时降级 */
export const inject = ['agents', 'tools', 'systemPrompt']

export const SOURCE_KIND = 'plugin:whaleisle'

const log = (...args) => console.log('[whaleisle]', ...args)
const warn = (...args) => console.warn('[whaleisle]', ...args)

const DEFAULTS = {
  ...ROUTE_DEFAULTS,
  bridgeUrl: 'http://127.0.0.1:8710',
  bridgeToken: '',
  // 留空表示「没配就要求显式 target」；config.yml 里一般写 p-alive
  defaultTarget: '',
  target: '',
  deliverMode: 'steer',
  pollWait: 20,
  autoReply: true,
  silentMarker: '[[SILENT]]',
  maxReplyChars: 3200,
  seenLimit: 500,
}

export const Config = Schema.object({
  bridgeUrl: Schema.string().default(DEFAULTS.bridgeUrl)
    .description('本地 WhaleIsle 桥地址（默认 http://127.0.0.1:8710）'),
  bridgeToken: Schema.string().default(DEFAULTS.bridgeToken)
    .description('桥的 API token（和 bridge.json 里的 api_token 一致）'),
  defaultTarget: Schema.string().default('')
    .description('没命中映射/绑定/名单时投到哪：p-<预设名> 或 s-<会话id>'),
  target: Schema.string().default('')
    .description('旧字段（等同 defaultTarget），保留兼容'),
  mode: Schema.union([Schema.const('blacklist'), Schema.const('whitelist'), Schema.const('off')])
    .default(DEFAULTS.mode)
    .description('名单模式：blacklist=名单里的不转发 / whitelist=只转发名单里的 / off=全放行'),
  blocked: Schema.array(Schema.string()).default([])
    .description('黑名单聊天：u-<用户名> 或 g-<会话id>'),
  allowed: Schema.array(Schema.string()).default([])
    .description('白名单聊天：u-<用户名> 或 g-<会话id>'),
  mappings: Schema.array(Schema.object({
    chat: Schema.string(),
    target: Schema.string(),
  })).default([])
    .description('聊天 → 目标 的固定映射（比运行期绑定优先）'),
  adminUsers: Schema.array(Schema.string()).default([])
    .description('允许发指令的用户名（留空=不限制；指令功能下一轮再加）'),
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

/**
 * 读配置：优先 whaleisle 行，取不到 token 时退回旧 finch 行（老配置直接能用）。
 */
function rawConfig(loaderConfig) {
  let row = {}
  try {
    row = configFor('whaleisle', loaderConfig) || {}
  } catch {
    row = loaderConfig || {}
  }
  if (!row || !row.bridgeToken) {
    try {
      row = { ...(configFor('finch', {}) || {}), ...row }
    } catch { /* 没有旧配置就算了 */ }
  }
  return row
}

function home() {
  return process.env.DSH_HOME || 'D:\\AI\\DeepseekHarness\\home'
}

function statePath() {
  return join(home(), 'xykp', 'whaleisle', 'state.json')
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
  const cfg = { ...DEFAULTS, ...Config(rawConfig(config)) }
  if (!cfg.bridgeToken) {
    warn('没有配置 bridgeToken，whaleisle 通道不启动')
    return
  }
  const base = cfg.bridgeUrl.replace(/\/+$/, '')
  const headers = {
    Authorization: `Bearer ${cfg.bridgeToken}`,
    'Content-Type': 'application/json',
  }

  const state = await readJsonFile(statePath(),
    await readJsonFile(join(home(), 'xykp', 'finch', 'state.json'), {}))

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

  // 桥登录的账号（自己发的指令要按会话反过来算 chat key）
  let meUsername = ''
  try {
    const status = await api('/v1/status')
    meUsername = String(status?.user?.username || '')
  } catch { /* 桥没起来就先空着 */ }

  /** 指令用的 chat key：别人发的按发送者算；自己发的按会话查（不然会算成 u-自己） */
  const commandChatKey = async (event) => {
    const sender = String(event?.sender?.username || '')
    if (!meUsername || sender !== meUsername) return chatKeyOf(event)
    try {
      const chats = (await api('/v1/chats'))?.chats || []
      const chat = chats.find((item) => item.id === event?.conversation_id)
      if (!chat) return chatKeyOf(event)
      return chat.type === 'group'
        ? `g-${chat.id}`
        : `u-${chat.peer?.username || chat.id}`
    } catch {
      return chatKeyOf(event)
    }
  }

  // ── 目标解析 ──────────────────────────────────────────────
  // p-<预设名> → preset-binder 里该预设当前活跃的会话；s-<id> / 裸 id → 原样
  const resolveTarget = async (ref) => {
    const parsed = parseTargetRef(ref)
    if (parsed.kind === 'none') return ''
    if (parsed.kind === 'preset') {
      const active = await presetActive(parsed.value)
      if (!active) throw new Error(`预设 ${parsed.value} 没有绑定会话`)
      return String(active)
    }
    return parsed.value
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

  const deliverText = async (text, route = {}) => {
    const sessionId = await resolveTarget(route.target)
    if (!sessionId) throw new Error('鲸屿分流目标为空')
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
    const key = chatKeyOf(event)
    const head = event?.is_group
      ? `[鲸屿·群「${event.conversation_title || '群聊'}」 ${key}]`
      : `[鲸屿 ${key}]`
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
    // 分流：名单（黑/白）+ 绑定 + 默认目标
    const chatKey = chatKeyOf(events[events.length - 1])
    // 指令：单条消息以 / 开头就交给 runCommand，不注入会话
    const commandEvent = events.length === 1 ? events[0] : null
    const commandText = commandEvent ? String(commandEvent.text || '').trim() : ''
    if (commandText.startsWith('/')) {
      let reply = ''
      try {
        reply = await runCommand(await commandChatKey(commandEvent), commandText, commandEvent)
      } catch (err) {
        warn('指令失败：', err?.message || err)
        reply = `指令执行失败：${err?.message || err}`
      }
      if (reply) {
        try {
          await sendToChat(conversationId, reply)
        } catch (err) {
          warn('指令回复失败：', err?.message || err)
        }
      }
      delivered.set(conversationId, lastId)
      await saveState()
      return
    }
    let route = { target: '', via: 'none', reason: '分流失败', chatKey }
    try {
      route = resolveRoute(cfg, chatKey, await readBindings())
    } catch (err) {
      warn('分流失败：', err?.message || err)
    }
    if (!route.target) {
      log(`跳过 ${chatKey || conversationId}：${route.reason || '没有目标'}`)
      delivered.set(conversationId, lastId)
      await saveState()
      return
    }
    let result = null
    try {
      result = await deliverText(text, route)
    } catch (err) {
      warn('注入失败：', err?.message || err)
      throw err
    }
    pending.set(canonSessionId(result.sessionId), {
      conversationId,
      chatKey,
      route: route.via,
      lastMessageId: lastId,
      armed: false,
      sawOutput: false,
      at: Date.now(),
    })
    lastInboundConv.id = conversationId
    delivered.set(conversationId, lastId)
    await saveState()
    log(`注入 ${chatKey || conversationId} → ${result.sessionId}（${route.via}，${events.length} 条，id ${lastId}）`)
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

  // ── 指令（在聊天里直接发 / 开头）──────────────────────────
  const adminOk = (event) => {
    const list = (cfg.adminUsers || [])
      .map((x) => String(x).replace(/^u-/, '').toLowerCase())
      .filter(Boolean)
    if (!list.length) return true
    return list.includes(String(event?.sender?.username || '').toLowerCase())
  }

  const presetTable = async () => {
    const pools = await presetPools()
    if (!pools.size) return '（没有预设绑过会话）'
    return [...pools.entries()]
      .map(([name, pool]) => `${name}${pool.active ? ` → ${pool.active}` : '（未绑定）'}`)
      .join('\n')
  }

  const resolveChatRef = async (ref) => {
    const raw = String(ref || '').trim()
    if (!raw) return ''
    if (/^[ug]-/i.test(raw)) return normalizeKey(raw)
    const chats = (await api('/v1/chats'))?.chats || []
    const name = raw.replace(/^@/, '').toLowerCase()
    const hit = chats.find((chat) => String(chat.title || '').toLowerCase() === name
      || String(chat.peer?.username || '').toLowerCase() === name)
    if (!hit) return ''
    return hit.type === 'group' ? `g-${hit.id}` : `u-${hit.peer?.username || hit.id}`
  }

  // ── 配置写回（只改 config.yml 的 whaleisle 段）──────────────
  const configPath = () => join(home(), 'xykp', 'config.yml')

  const yamlValue = (value) => {
    const s = String(value ?? '')
    return /^[\w./:@-]+$/.test(s) ? s : JSON.stringify(s)
  }

  const serializeConfig = () => {
    const out = ['whaleisle:']
    out.push(`  bridgeUrl: ${yamlValue(cfg.bridgeUrl)}`)
    out.push(`  bridgeToken: ${yamlValue(cfg.bridgeToken)}`)
    out.push(`  defaultTarget: ${yamlValue(cfg.defaultTarget || cfg.target || '')}`)
    out.push(`  mode: ${cfg.mode}`)
    const list = (name, values) => {
      if (!values.length) { out.push(`  ${name}: []`); return }
      out.push(`  ${name}:`)
      values.forEach((item) => out.push(`    - ${yamlValue(item)}`))
    }
    list('blocked', cfg.blocked || [])
    list('allowed', cfg.allowed || [])
    if ((cfg.mappings || []).length) {
      out.push('  mappings:')
      cfg.mappings.forEach((row) => {
        out.push(`    - chat: ${yamlValue(row.chat)}`)
        out.push(`      target: ${yamlValue(row.target)}`)
      })
    } else {
      out.push('  mappings: []')
    }
    list('adminUsers', cfg.adminUsers || [])
    out.push(`  autoReply: ${cfg.autoReply ? 'true' : 'false'}`)
    out.push(`  pollWait: ${Number(cfg.pollWait) || 20}`)
    return out.join('\n')
  }

  const persistConfig = async () => {
    const path = configPath()
    let text = ''
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return 'config.yml 读不到，没保存（内存里已生效）'
    }
    const block = serializeConfig()
    const start = text.indexOf('\nwhaleisle:')
    if (start < 0) {
      await writeFile(path, `${text.replace(/\s*$/, '')}\n${block}\n`, 'utf8')
      return '已写入 config.yml'
    }
    const afterKey = text.slice(start + 1 + 'whaleisle:'.length)
    const next = /\n(?=\S)/.exec(afterKey)
    const tailStart = next ? start + 1 + 'whaleisle:'.length + next.index + 1 : text.length
    await writeFile(path, text.slice(0, start + 1) + block + '\n' + text.slice(tailStart), 'utf8')
    return '已写入 config.yml'
  }

  // ── 新建会话 ───────────────────────────────────────────────
  const createSession = async (preset, workspace) => {
    const cwd = workspace ? String(workspace) : join(home(), 'workspaces', 'default-workspace')
    try { await mkdir(cwd, { recursive: true }) } catch { /* ignore */ }
    const id = newSessionId('isle')
    const meta = { cwd }
    let setup
    if (preset) {
      const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : null
      if (presets && typeof presets.resolve === 'function') {
        const resolved = await presets.resolve(preset)
        const presetId = typeof resolved === 'string' ? resolved : (resolved && resolved.id)
        if (!presetId) throw new Error(`找不到预设 ${preset}`)
        meta.agentPreset = presetId
        if (typeof presets.mount === 'function') {
          setup = async (agentCtx) => { await presets.mount(agentCtx, presetId) }
        }
      }
    }
    const handle = await ctx.agents.create({ sessionId: id, meta, ...(setup ? { setup } : {}) })
    const real = String((handle && handle.agent && handle.agent.session
      && handle.agent.session.id) || id)
    if (preset) {
      try {
        const path = join(home(), 'xykp', 'preset-binder', 'preset-binder.json')
        const json = (await readJsonFile(path, null)) || { presets: {} }
        json.presets = json.presets || {}
        const pool = json.presets[preset] || { sessions: {} }
        pool.sessions = pool.sessions || {}
        pool.sessions[real] = pool.sessions[real] || true
        pool.active = real
        json.presets[preset] = pool
        await writeJsonFile(path, json)
      } catch (err) {
        warn('更新预设活跃会话失败：', err?.message || err)
      }
    }
    return { id: real, preset: preset || '', cwd }
  }

  /** 这个聊天当前指向的会话 id（不抛错） */
  const sessionForChat = async (chatKey) => {
    const bound = (await readBindings())[chatKey]
    const target = bound?.target || cfg.defaultTarget || cfg.target
    try {
      return await resolveTarget(target)
    } catch {
      return ''
    }
  }

  const runCommand = async (chatKey, raw, event) => {
    const match = /^\/([a-zA-Z-]+)\s*([\s\S]*)$/.exec(raw)
    const cmd = String(match?.[1] || '').toLowerCase()
    const arg = String(match?.[2] || '').trim()
    if (!adminOk(event)) return '没有权限用指令'
    const bindings = await readBindings()
    switch (cmd) {
      case 'help':
        return [
          '鲸屿通道指令：',
          '/status                看模式和当前绑定',
          '/bind [聊天] <目标>      绑任意聊天；聊天=g-会话id / u-用户名 / 群名（省略=当前聊天）',
          '/unbind [聊天]          解除绑定（省略=当前聊天）',
          '/preset [名字]          列预设；带名字=绑到该预设',
          '/session [数量]         最近会话（带 id，可 /bind s-<id>）',
          '/new [预设] [工作区]    新建会话并把这个聊天绑过去',
          '/stop                  停止当前会话这一轮',
          '/free                  释放/停止当前会话',
          '/compact               压缩当前会话上下文',
          '/cfg-default <目标>     改默认目标（写 config.yml）',
          '/cfg-mode blacklist|whitelist|off',
          '/cfg-list blocked|allowed [add|del] [聊天]',
          '/cfg-table             看当前配置',
          '/ver                   通道信息',
        ].join('\n')
      case 'status': {
        const bound = bindings[chatKey]
        return [
          `chat: ${chatKey}`,
          `mode: ${cfg.mode}`,
          `defaultTarget: ${cfg.defaultTarget || cfg.target || '（未配置）'}`,
          `当前绑定: ${bound ? bound.target : '（无，走默认目标/映射）'}`,
          `映射数: ${(cfg.mappings || []).length}`,
        ].join('\n')
      }
      case 'bind': {
        if (!arg) {
          return [
            '用法：/bind [聊天] <目标>',
            '  聊天：g-<会话id> / u-<用户名> / 群名，省略=当前聊天',
            '  目标：p-<预设名> / s-<会话id>，也可以只写预设名',
          ].join('\n')
        }
        const parts = arg.split(/\s+/).filter(Boolean)
        let chatRef = ''
        let targetRef = parts[0]
        if (parts.length >= 2) {
          chatRef = parts[0]
          targetRef = parts[1]
        }
        const target = /^(p|s)-/i.test(targetRef) ? targetRef : `p-${targetRef}`
        const parsed = parseTargetRef(target)
        if (parsed.kind === 'preset') {
          const active = await presetActive(parsed.value)
          if (!active) return `预设 ${parsed.value} 没有绑定会话`
        }
        const bindChat = chatRef ? await resolveChatRef(chatRef) : chatKey
        if (!bindChat) return `找不到聊天：${chatRef}`
        await writeBinding(bindChat, target)
        return `已把 ${bindChat} 绑到 ${target}`
      }
      case 'unbind': {
        const bindChat = arg ? await resolveChatRef(arg) : chatKey
        if (!bindChat) return `找不到聊天：${arg}`
        await writeBinding(bindChat, '')
        return `已解除 ${bindChat} 的绑定`
      }
      case 'new': {
        const [presetArg, workspaceArg] = arg.split(/\s+/).filter(Boolean)
        try {
          const created = await createSession(presetArg || '', workspaceArg || '')
          await writeBinding(chatKey, `s-${created.id}`)
          return `已新建会话 ${created.id}${created.preset ? `（预设 ${created.preset}）` : ''}`
            + `\n已把这个聊天绑过去（${chatKey}）`
        } catch (err) {
          return `新建失败：${err?.message || err}`
        }
      }
      case 'stop': {
        const sessionId = await sessionForChat(chatKey)
        const agent = sessionId ? findAgent(sessionId) : null
        if (!agent) return '这个聊天还没有在跑的会话'
        await agent.cancel({ kind: 'user' })
        return `已请求停止 ${sessionId}`
      }
      case 'free': {
        const sessionId = await sessionForChat(chatKey)
        const agent = sessionId ? findAgent(sessionId) : null
        if (!agent) return '没有可释放的会话'
        if (typeof agent.free === 'function') {
          await agent.free()
          return `已释放 ${sessionId}`
        }
        if (agent.status && agent.status !== 'idle') {
          await agent.cancel({ kind: 'user' })
          return `已停止 ${sessionId}`
        }
        return `${sessionId} 现在空闲`
      }
      case 'compact': {
        const sessionId = await sessionForChat(chatKey)
        const agent = sessionId ? findAgent(sessionId) : null
        if (!agent) return '没有可压缩的会话'
        if (typeof agent.compact !== 'function') return '宿主没暴露 compact 接口'
        await agent.compact()
        return `已请求压缩 ${sessionId}`
      }
      case 'cfg-default': {
        if (!arg) return '用法：/cfg-default p-alive'
        cfg.defaultTarget = arg
        return persistConfig()
      }
      case 'cfg-mode': {
        const mode = arg.toLowerCase()
        if (!['blacklist', 'whitelist', 'off'].includes(mode)) {
          return '用法：/cfg-mode blacklist|whitelist|off'
        }
        cfg.mode = mode
        return persistConfig()
      }
      case 'cfg-list': {
        const [which, action, value] = arg.split(/\s+/).filter(Boolean)
        const name = which === 'blocked' || which === 'allowed' ? which : ''
        if (!name) return '用法：/cfg-list blocked|allowed [add|del] [聊天]'
        const list = (cfg[name] || []).map(normalizeKey)
        if (!action) return `${name}: ${list.length ? list.join(', ') : '（空）'}`
        const chat = await resolveChatRef(value || '')
        if (!chat) return `找不到聊天：${value}`
        if (action === 'add' && !list.includes(chat)) list.push(chat)
        if (action === 'del') {
          const index = list.indexOf(chat)
          if (index >= 0) list.splice(index, 1)
        }
        cfg[name] = list
        return persistConfig()
      }
      case 'cfg-table':
        return serializeConfig()
      case 'preset': {
        if (!arg) return `预设：\n${await presetTable()}`
        const active = await presetActive(arg)
        if (!active) return `预设 ${arg} 没有绑定会话`
        await writeBinding(chatKey, `p-${arg}`)
        return `已把 ${chatKey} 绑到预设 ${arg}（当前活跃会话 ${active}）`
      }
      case 'session': {
        const limit = Math.max(1, Math.min(20, Number(arg) || 8))
        const list = (await listSessions()).slice(0, limit)
        if (!list.length) return '没有会话'
        const rows = []
        for (const item of list) {
          const title = (await readSessionTitle(item.id)) || '（无标题）'
          rows.push(`${title} · ${ago(item.updatedAt)}\n  ${item.id}`)
        }
        return `最近会话（/bind s-<id> 绑定）：\n${rows.join('\n')}`
      }
      case 'ver':
        return `whaleisle 通道\nbridge: ${base}\n游标: ${cursor}`
      default:
        return `不认识的指令：/${cmd}，发 /help 看列表`
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
        name: 'whaleisle:channel',
        order: 10400,
        text: () => [
          '## 鲸屿通道',
          '你有一个自建 IM「鲸屿」（WhaleIsle）通道。好友发来的消息会以 `[鲸屿 u-用户名] 名字: …` / `[鲸屿·群「群名」 g-会话id] 名字: …` 的形式出现，方括号里的就是绑定用的 chat key。',
          '- 直接回复即可，这一轮的回复会自动发回来源聊天；不想说话就只回复 [[SILENT]]。',
          '- 想主动发消息、翻聊天记录、查桥状态时用 whaleisle_send / whaleisle_read / whaleisle_status。',
          '- 想把某个聊天改投到别的预设/会话，用 whaleisle_bind（chat 形如 u-用户名 / g-会话id，target 形如 p-预设名 / s-会话id）。',
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
        name: 'whaleisle_send',
        description: '用「鲸屿」发一条消息。chat 可以写 conversation_id，或 to=@用户名 / 群名；text 必填。',
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
        name: 'whaleisle_read',
        description: '读「鲸屿」：不带 conversation_id 时列出聊天和未读数；带了就读最近消息。',
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
              chat: chat.type === 'group' ? `g-${chat.id}` : `u-${chat.peer?.username || chat.id}`,
              id: chat.id,
              type: chat.type,
              title: chat.title,
              peer: chat.peer?.username || '',
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
        name: 'whaleisle_status',
        description: '看「鲸屿」桥的连接状态、当前账号、排队的消息数和插件游标。',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
        },
        async execute() {
          const status = await api('/v1/status')
          const bindings = await readBindings()
          return toolOutput({
            ok: true,
            connected: status?.connected,
            user: status?.user?.username,
            queued: status?.queued,
            cursor,
            mode: cfg.mode,
            defaultTarget: cfg.defaultTarget || cfg.target,
            mappings: (cfg.mappings || []).length,
            bindings,
            pending: [...pending.entries()].map(([key, info]) => ({ session: key, ...info })),
          })
        },
      }))

      ctx.tools.register(defineTool({
        name: 'whaleisle_bind',
        description: '把某个聊天绑到预设/会话，或解绑。不带 chat 就列出当前绑定。',
        parameters: {
          chat: { type: 'string', description: 'u-用户名 或 g-会话id（可选）' },
          target: { type: 'string', description: 'p-<预设名> / s-<会话id>；留空=解绑' },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
        },
        async execute(args) {
          const rawChat = String(args.chat || '').trim()
          if (!rawChat) {
            return toolOutput({ ok: true, bindings: await readBindings() })
          }
          let key = ''
          if (/^[ug]-/i.test(rawChat)) {
            key = normalizeKey(rawChat)
          } else {
            // 允许直接写名字：群名 / 用户名（不用记 id）
            const chats = (await api('/v1/chats'))?.chats || []
            const name = rawChat.replace(/^@/, '').toLowerCase()
            const hit = chats.find((chat) => String(chat.title || '').toLowerCase() === name
              || String(chat.peer?.username || '').toLowerCase() === name)
            if (!hit) throw new Error(`找不到聊天：${rawChat}（可以先用 whaleisle_read 看列表）`)
            key = hit.type === 'group' ? `g-${hit.id}` : `u-${hit.peer?.username || hit.id}`
          }
          const target = String(args.target || '').trim()
          if (target) {
            const parsed = parseTargetRef(target)
            if (parsed.kind === 'preset') {
              const active = await presetActive(parsed.value)
              if (!active) throw new Error(`预设 ${parsed.value} 没有绑定会话`)
            }
          }
          const all = await writeBinding(key, target)
          return toolOutput({
            ok: true, chat: key, target: target || '(已解绑)', total: Object.keys(all).length,
          })
        },
      }))
    }
  } catch (err) {
    warn('注册工具失败：', err?.message || err)
  }

  log(`通道已启动：${base}，默认目标 ${cfg.defaultTarget || cfg.target}，模式 ${cfg.mode}，游标 ${cursor}`)
}

export const _internal = { canonSessionId, sessionCandidates, extractText, splitChunks }
