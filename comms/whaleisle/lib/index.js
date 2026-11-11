// whaleisle · DSH 宿主半边
//
// 干的事：
//   1. 长轮询本地 WhaleIsle 桥（默认 127.0.0.1:8710）的 /v1/inbound，把新消息注入目标会话
//   2. 一轮回复结束后，把最终回复自动发回来源聊天（除非回的是 [[SILENT]]）
//   3. 提供 whaleisle_send / whaleisle_read / whaleisle_status / whaleisle_bind 工具
//   4. 分流：名单（黑/白）+ 绑定（bindings.json / config.mappings）+ 默认目标（预设/会话）
//
// 所有异常只记日志，绝不拖死宿主；没配 bridgeToken 时插件保持静默。

import { access, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import Schema from '@deepseek-ai/schemastery'
import yaml from 'js-yaml'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { configFor } from '../../../ui/store.js'
import {
  DEFAULTS as ROUTE_DEFAULTS, chatKeyOf, normalizeKey, parseTargetRef, resolveRoute,
} from './routing.js'
import {
  ago, archiveSession, archivedIds, homeDir, listSessions, newSessionId, presetActive, presetPools,
  readBindings, useConfigAsBindings,
  readJson, readSessionModel, readSessionTitle, writeBinding, writeJson,
} from './bindings.js'

export const name = 'whaleisle'

/** agents 必须有；tools / systemPrompt 缺失时降级 */
export const inject = ['agents', 'tools', 'systemPrompt']

export const SOURCE_KIND = 'plugin:whaleisle'

const log = (...args) => console.log('[whaleisle]', ...args)
const warn = (...args) => console.warn('[whaleisle]', ...args)

const VERSION = '0.2.0'

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
  accounts: [],
  defaultAccount: '',
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
    .description('允许发指令的用户名（留空=不限制）'),
  accounts: Schema.array(Schema.object({
    name: Schema.string().description('账号名（唯一）'),
    username: Schema.string().default('')
      .description('鲸屿登录名（启动器按它生成桥配置；插件本身只读名字）'),
    password: Schema.string().default('')
      .description('鲸屿登录密码（同上，只给启动器用）'),
    bridgeUrl: Schema.string().description('这个账号的桥地址，例如 http://127.0.0.1:8711'),
    bridgeToken: Schema.string().description('这个账号的桥 token'),
    target: Schema.string().default('')
      .description('这个账号默认投到哪：p-<预设名> 或 s-<会话id>；留空=用默认账号/全局 defaultTarget'),
    workspace: Schema.string().default('')
      .description('这个账号 /new 新建会话时挂哪个工作区（空=不挂）'),
    preset: Schema.string().default('')
      .description('这个账号 /new 新建会话时默认用哪个预设（空=用对话当前的）'),
    admin: Schema.boolean().default(true)
      .description('false=这个号的聊天不能发指令（只收发消息）'),
  })).default([])
    .description('多账号：一块桥一个账号（留空就用上面单账号的 bridgeUrl/bridgeToken）'),
  defaultAccount: Schema.string().default('')
    .description('默认/回退账号名（留空=第一个）；没单独配置的账号回落它'),
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

/** 工作区根目录：正常是 DSH_HOME 旁边那个 workspaces（不是 home 里的） */
async function workspacesRoot() {
  const top = join(home(), '..', 'workspaces')
  try {
    await access(top)
    return top
  } catch {
    return join(home(), 'workspaces')
  }
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

/**
 * 这条群消息有没有 @ 到本账号。认得：
 * - @账号名（桥接账号的 username，比如 @isle_work）
 * - @all / @everyone / @所有人 / @大家
 * 别的（比如 @别人）不算 —— 群里闲聊不该灌进会话。
 */
function mentionedMe(event, acct) {
  const text = String((event && event.text) || '')
  if (!text.includes('@')) return false
  if (/@\s*(all|everyone|所有人|大家)/i.test(text)) return true
  // 账号对象上的字段是 acct.me（/v1/status 里拿的），acct.user/username 只是兜底
  const user = acct && (acct.me || acct.user || acct.username)
  // 账号名还没拿到时宁可放行，别把「@ 我」的消息吞了
  if (!user) return true
  return text.includes('@' + user)
}

export async function apply(ctx, config = {}) {
  // 先掐掉旧实例（热重载可能留下还在轮询的旧副本 → 同一消息投好几次）
  try {
    const runtimes = globalThis.__whaleisleRuntimes || (globalThis.__whaleisleRuntimes = new Set())
    for (const stop of [...runtimes]) {
      try { stop() } catch { /* ignore */ }
    }
    runtimes.clear()
  } catch { /* ignore */ }
  const cfg = { ...DEFAULTS, ...Config(rawConfig(config)) }
  // 绑定信息就在 config.yml 的 accounts 里，喂给 bindings 模块当唯一来源
  useConfigAsBindings(cfg)
  const accountsConfigured = Array.isArray(cfg.accounts)
    && cfg.accounts.some((a) => a && (a.bridgeToken || a.bridgeUrl))
  if (!cfg.bridgeToken && !accountsConfigured) {
    warn('没有配置 bridgeToken，whaleisle 通道不启动')
    return
  }
  // ── 账号：一块桥 = 一个账号；没配 accounts 就退回单账号老配置 ──
  const rawAccounts = Array.isArray(cfg.accounts) && cfg.accounts.length
    ? cfg.accounts
    : [{ name: 'main', bridgeUrl: cfg.bridgeUrl, bridgeToken: cfg.bridgeToken, target: cfg.target || '' }]
  const accounts = []
  for (const [i, item] of rawAccounts.entries()) {
    const name = String(item?.name || (i === 0 ? 'main' : `acct${i + 1}`)).trim()
    const url = String(item?.bridgeUrl || '').replace(/\/+$/, '')
    const token = String(item?.bridgeToken || '')
    if (!url || !token) { warn(`账号 ${name} 缺 bridgeUrl/bridgeToken，跳过`); continue }
    accounts.push({
      name,
      base: url,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      target: String(item?.target || ''),
      admin: item?.admin !== false,
      cursor: 0,
      delivered: new Map(),
      me: '',
    })
  }
  if (!accounts.length) {
    warn('没有可用账号（bridgeUrl/bridgeToken 缺失），whaleisle 通道不启动')
    return
  }
  const accountByName = (name) => accounts.find((a) => a.name === String(name || '').trim()) || null
  const defaultAccount = () => accountByName(cfg.defaultAccount) || accounts[0]

  /** 账号实际去的会话：bindings 里的 acct:<名> > 配置里的 target > 默认账号 > 全局 defaultTarget */
  // 当前账号实际指向的会话（绑预设=预设的活跃会话；绑会话=那个会话）
  const findSessionDir = async (root, sid) => {
    try {
      const dirs = await readdir(root)
      for (const d of dirs) {
        const full = join(root, d, sid)
        try {
          await access(full)
          return full
        } catch { /* not here */ }
      }
    } catch { /* ignore */ }
    return ''
  }

  // 会话元信息（cwd / 预设 / 模型），直接读宿主投影缓存
  const readSessionMeta = async (sid) => {
    try {
      const f = join(homeDir(), 'storages', 'session_projcache', 'sessions', sid + '.json')
      const j = JSON.parse(await readFile(f, 'utf8'))
      const rows = j?.record?.rows || {}
      return {
        cwd: j?.record?.identity?.cwd || '',
        preset: rows?.agentPreset?.val || '',
        model: rows?.modelSelection?.val?.lastUsed || null,
      }
    } catch {
      return { cwd: '', preset: '', model: null }
    }
  }

  const activeSessionForAccount = async () => {
    const target = await accountTarget(cur)
    if (String(target || '').startsWith('s-')) return String(target).slice(2)
    if (String(target || '').startsWith('p-')) {
      const pools = await presetPools()
      return pools.get(String(target).slice(2))?.active || ''
    }
    return ''
  }

  const accountTarget = async (acct) => {
    const bindings = await readBindings()
    const own = (bindings[`acct:${acct.name}`] || {}).target
    if (own) return String(own).trim()
    if (acct.target) return String(acct.target).trim()
    const dflt = defaultAccount()
    if (dflt && dflt.name !== acct.name) {
      const other = (bindings[`acct:${dflt.name}`] || {}).target
      if (other) return String(other).trim()
      if (dflt.target) return String(dflt.target).trim()
    }
    return String(cfg.defaultTarget || cfg.target || '').trim()
  }

  const state = await readJsonFile(statePath(),
    await readJsonFile(join(home(), 'xykp', 'finch', 'state.json'), {}))

  // 状态格式 { accounts: { 名: {cursor, delivered} } }；老的单账号状态继承给第一个账号
  const savedAccounts = (state && state.accounts) || null
  accounts.forEach((acct, i) => {
    const row = savedAccounts ? savedAccounts[acct.name] : (i === 0 ? state : null)
    if (!row) return
    acct.cursor = Number(row.cursor) || 0
    acct.delivered = new Map(Object.entries(row.delivered || {}).map(([k, v]) => [k, Number(v) || 0]))
  })

  const pending = new Map()          // canonSessionId -> { account, conversationId, lastMessageId, armed, sawOutput, at }
  /** 账号 -> 最近一次投递的聊天（回程兜底：/new 之后会话 id 对不上时用） */
  const lastChatOf = new Map()
  const recentSends = []             // { conversationId, text, at }
  const lastInboundConv = { id: '' }
  const lastSessionList = []        // /session 列出来的会话 id，/use <编号> 用

  // 现有代码都直接读 base/headers/cursor/delivered，用「当前账号视图」+ enter() 切换，
  // 免得把几十个调用点全改成显式参数；处理逻辑用 withLock 串行，避免交叉污染。
  let cur = accounts[0]
  let base = cur.base
  let headers = cur.headers
  let cursor = cur.cursor
  let delivered = cur.delivered
  let meUsername = cur.me

  const enter = (acct) => {
    cur = acct
    base = acct.base
    headers = acct.headers
    cursor = acct.cursor
    delivered = acct.delivered
    meUsername = acct.me || ''
  }

  const saveState = async () => {
    cur.cursor = cursor
    cur.delivered = delivered
    cur.me = meUsername
    const payload = { accounts: {}, updatedAt: Date.now() }
    for (const acct of accounts) {
      const entries = [...acct.delivered.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.max(20, cfg.seenLimit))
      payload.accounts[acct.name] = { cursor: acct.cursor, delivered: Object.fromEntries(entries) }
    }
    try {
      await writeJsonFile(statePath(), payload)
    } catch (err) {
      warn('保存状态失败：', err?.message || err)
    }
  }

  const apiOn = async (acct, path, { method = 'GET', body, timeoutMs = 25000 } = {}) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(acct.base + path, {
        method,
        headers: acct.headers,
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

  const api = (path, opts) => apiOn(cur, path, opts)

  let chain = Promise.resolve()
  const withLock = (fn) => {
    const run = chain.then(fn, fn)
    chain = run.then(() => {}, () => {})
    return run
  }

  // 桥登录的账号（自己发的指令要按会话反过来算 chat key）
  for (const acct of accounts) {
    try {
      const status = await apiOn(acct, '/v1/status')
      acct.me = String(status?.user?.username || '')
    } catch { /* 桥没起来就先空着 */ }
  }
  meUsername = cur.me || ''

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

  /** resume/create 要自己带上 provider/model
   *  宿主只在 GUI 的 agent/request 里给「日志里没有 model 头」的会话兜底，
   *  插件这边用 ctx.agents.resume() 直接起出来的 agent 是空的 → 整轮报
   *  「has no provider/model」或「prompt variable "{{model}}" 没有值」。 */
  const modelOptionsFor = async (sessionId) => {
    try {
      const own = await readSessionModel(sessionId)
      if (own) return own
    } catch { /* ignore */ }
    try {
      const svc = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null
      const cur = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : null
      if (cur && cur.provider && cur.model) {
        const out = { provider: String(cur.provider), model: String(cur.model) }
        if (cur.reasoningEffort) out.reasoningEffort = String(cur.reasoningEffort)
        return out
      }
    } catch { /* ignore */ }
    return null
  }

  const ensureAgent = async (sessionId) => {
    let agent = findAgent(sessionId)
    if (agent) return { agent, sessionId }
    const candidates = sessionCandidates(sessionId)
    let lastError = null
    for (const candidate of candidates) {
      try {
        const agentOptions = await modelOptionsFor(candidate)
        const handle = await ctx.agents.resume({
          resumeSessionId: candidate,
          ...(agentOptions ? { agentOptions } : {}),
        })
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
    if (cfg.deliverMode === 'followup' || agent.status !== 'running') {
      // idle 的会话必须 followup 才会起一轮；steer 在空闲时只是排队，回合永远不开始
      await agent.followup(message)
    } else {
      await agent.steer(message)
    }
    return { sessionId: actual }
  }

  // ── 收消息 ────────────────────────────────────────────────
  /** 附件落到 home/cache/whaleisle/attachments/<账号>-<聊天>/ 下（失败就算了，至少留文字占位） */
  const attachmentDir = (acct, event) => join(
    homeDir(), 'cache', 'whaleisle', 'attachments',
    `${acct.name}-${String(chatKeyOf(event)).replace(/[^\w.-]+/g, '_')}`,
  )

  const downloadAttachments = async (acct, event) => {
    const list = Array.isArray(event?.attachments) ? event.attachments : []
    if (!list.length) return
    let dir = ''
    for (const att of list) {
      if (!att || !att.id) continue
      const name = String(att.name || att.id).replace(/[\\/:*?"<>|]/g, '_')
      try {
        const resp = await fetch(`${acct.base}/v1/media?id=${encodeURIComponent(att.id)}`,
          { headers: acct.headers })
        if (!resp.ok) continue
        if (!dir) {
          dir = attachmentDir(acct, event)
          await mkdir(dir, { recursive: true })
        }
        const target = join(dir, name)
        await writeFile(target, Buffer.from(await resp.arrayBuffer()))
        att.localPath = target
      } catch { /* 取不下来就保留占位文字 */ }
    }
  }

  const formatIncoming = (event) => {
    const who = event?.sender?.display_name || event?.sender?.username || '?'
    const key = chatKeyOf(event)
    const head = event?.is_group
      ? `[鲸屿·群「${event.conversation_title || '群聊'}」 ${key}]`
      : `[鲸屿 ${key}]`
    const attachments = (event?.attachments || []).map((att) => {
      const mime = String(att?.mime || '')
      const label = mime.startsWith('image/') ? `[图片:${att.name}]` : `[文件:${att.name}]`
      // 落盘成功就把本地路径附上，会话里能直接读/看
      return att?.localPath ? `${label}(${att.localPath})` : label
    }).join(' ')
    const body = [event?.text || '', attachments].filter(Boolean).join(' ')
    return body ? `${head} ${who}: ${body}` : ''
  }

  // 跨账号去重 + 自己发出的消息不回流
  const seenIds = new Set()
  const selfSentIds = new Set()

  const handleConversation = async (conversationId, events) => {
    const lastId = events[events.length - 1].id
    if ((delivered.get(conversationId) || 0) >= lastId) return
    // 自己账号发出的消息会从另一块桥再看到一遍，直接用消息 id 掐掉
    if (selfSentIds.has(lastId) || seenIds.has(lastId)) {
      delivered.set(conversationId, lastId)
      await saveState()
      return
    }
    seenIds.add(lastId)
    while (seenIds.size > 1000) seenIds.delete(seenIds.values().next().value)
    // 群聊默认只在被 @ 时才投递（@本账号 / @all / @所有人），群里其他闲聊只推进游标，不灌进会话
    const hasGroup = events.some((e) => e && e.is_group)
    // / 开头的指令在群里也放行，不然管理员还得先 @ 一下才能用
    const usable = hasGroup
      ? events.filter((e) => !e || !e.is_group || mentionedMe(e, cur)
        || String(e.text || '').trim().startsWith('/'))
      : events
    // 附件（图片/文件/语音）先从桥上取下来落盘，这样会话里能直接打开
    for (const e of usable) await downloadAttachments(cur, e)
    const text = usable.map((e) => formatIncoming(e)).filter(Boolean).join('\n')
    if (!text) {
      delivered.set(conversationId, lastId)
      await saveState()
      return
    }
    // 分流：只看「这个账号绑到哪」（预设/会话），聊天级映射和黑白名单不再使用
    const chatKey = chatKeyOf(events[events.length - 1])
    // 指令：单条消息以 / 开头就交给 runCommand，不注入会话
    const commandEvent = events.length === 1 ? events[0] : null
    const commandText = commandEvent ? String(commandEvent.text || '').trim() : ''
    if (commandText.startsWith('/')) {
      const cmd = commandText.slice(1).split(/\s+/)[0]
      const allowed = new Set(['help', 'ver', 'status', 'check', 'stop', 'workspace', 'preset', 'model', 'level', 'permission', 'new', 'session', 'rename'])
      const queryCmd = ['ver', 'status', 'help'].includes(cmd)
      let reply = ''
      if (!allowed.has(cmd)) {
        reply = '未知或不完整的命令'
      } else if (!queryCmd && !adminOk(commandEvent)) {
        reply = '未知或不完整的命令'
      } else {
        try {
          reply = await runCommand(await commandChatKey(commandEvent), commandText, commandEvent)
        } catch (err) {
          warn('指令失败：', err?.message || err)
          reply = `指令执行失败：${err?.message || err}`
        }
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
    let route = { target: '', via: 'none', reason: '账号没有绑定目标', chatKey }
    try {
      const byAccount = await accountTarget(cur)
      if (byAccount) route = { target: byAccount, via: `account:${cur.name}`, chatKey }
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
      account: cur.name,
      conversationId,
      chatKey,
      route: route.via,
      lastMessageId: lastId,
      armed: false,
      sawOutput: false,
      at: Date.now(),
    })
    // 兜底用：这个账号最近一次是往哪个聊天投的（回程按会话 id 对不上时靠它找回来）
    lastChatOf.set(cur.name, { conversationId, chatKey, at: Date.now() })
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
  // 进程级单例：热重载会再 apply 一次，旧实例的轮询不一定被 dispose 掉，
  // 两个实例各轮询一遍 → 同一个聊天看到同一条消息两三次（👀 x3 就是这么来的）
  try {
    const runtimes = globalThis.__whaleisleRuntimes || (globalThis.__whaleisleRuntimes = new Set())
    for (const stop of [...runtimes]) {
      if (stop !== cleanup) {
        try { stop() } catch { /* ignore */ }
      }
    }
    runtimes.clear()
    runtimes.add(cleanup)
  } catch { /* ignore */ }

  const pollOne = async (acct) => {
    const wait = Math.max(0, Math.min(30, Number(cfg.pollWait) || 20))
    // 拉消息并发（只读 acct），处理放进 withLock 串行，避免切账号的全局视图被交叉污染
    const data = await apiOn(acct, `/v1/inbound?after=${acct.cursor}&wait=${wait}&consume=1`,
      { timeoutMs: (wait + 15) * 1000 })
    const events = Array.isArray(data?.events) ? data.events : []
    if (!events.length) return
    await withLock(async () => {
      enter(acct)
      const advanced = await handleEvents(events)
      const maxId = Math.max(...events.map((e) => Number(e.id) || 0))
      if (advanced || maxId > cursor) {
        if (advanced) cursor = maxId
        await saveState()
      }
    })
  }

  const pollLoop = async (acct) => {
    let backoff = 2000
    while (!disposed) {
      try {
        await pollOne(acct)
        backoff = 2000
      } catch (err) {
        if (disposed) break
        warn(`[${acct.name}] 轮询失败：`, err?.message || err)
        await new Promise((resolve) => setTimeout(resolve, backoff))
        backoff = Math.min(backoff * 2, 30000)
      }
    }
  }
  setTimeout(() => { for (const acct of accounts) void pollLoop(acct) }, 800)

  // ── 自动回发 ──────────────────────────────────────────────
  const rememberSend = (conversationId, text) => {
    recentSends.push({ conversationId, text, at: Date.now() })
    while (recentSends.length > 200) recentSends.shift()
    const cutoff = Date.now() - 5 * 60_000
    while (recentSends.length && recentSends[0].at < cutoff) recentSends.shift()
  }

  const sendToChat = async (conversationId, text, replyToId = 0) => {
    for (const chunk of splitChunks(text, cfg.maxReplyChars)) {
      const res = await api('/v1/send', {
        method: 'POST',
        body: { conversation_id: conversationId, text: chunk, reply_to_id: replyToId || 0 },
      })
      // 记下自己发出去的消息 id：另一块桥会在群里再看到它一次，按 id 掐掉
      const mid = Number(res?.message?.id || res?.message_id || res?.id || 0)
      if (mid) {
        selfSentIds.add(mid)
        while (selfSentIds.size > 1000) selfSentIds.delete(selfSentIds.values().next().value)
      }
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

  // ── 配置写回（只写 xykp/whaleisle/config.yml）──────────────
  const configPath = () => join(home(), 'xykp', 'whaleisle', 'config.yml')

  // 控制台管理的字段；accounts 等其它字段原样保留。
  const managedConfig = () => ({
    bridgeUrl: cfg.bridgeUrl ?? null,
    bridgeToken: cfg.bridgeToken ?? null,
    defaultTarget: cfg.defaultTarget || cfg.target || '',
    mode: cfg.mode,
    blocked: cfg.blocked ?? [],
    allowed: cfg.allowed ?? [],
    mappings: (cfg.mappings || []).map((row) => ({ chat: row.chat, target: row.target })),
    adminUsers: cfg.adminUsers ?? [],
    autoReply: !!cfg.autoReply,
    pollWait: Number(cfg.pollWait) || 20,
  })

  const persistConfig = async () => {
    const path = configPath()
    let prev = {}
    try {
      const parsed = yaml.load(await readFile(path, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) prev = parsed
    } catch { /* 文件不存在就从头写 */ }
    await mkdir(dirname(path), { recursive: true })
    const tmp = path + '.tmp'
    await writeFile(tmp, yaml.dump({ ...prev, ...managedConfig() }, { lineWidth: 120, noRefs: true }), 'utf8')
    await rename(tmp, path)
    return '已写入 whaleisle/config.yml'
  }

  // ── 新建会话 ───────────────────────────────────────────────
  const createSession = async (preset, workspace, sessionId = '', inheritFrom = '') => {
    const cwd = workspace ? String(workspace) : join(await workspacesRoot(), 'default-workspace')
    try { await mkdir(cwd, { recursive: true }) } catch { /* ignore */ }
    const id = sessionId || newSessionId('isle')
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
    const createOptions = await modelOptionsFor(inheritFrom || id)
    const handle = await ctx.agents.create({
      sessionId: id, meta, ...(setup ? { setup } : {}), ...(createOptions ? { agentOptions: createOptions } : {}),
    })
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
    return { id: real, preset: preset || '', cwd, agent: handle.agent }
  }

  /** 这个聊天当前指向的会话 id（不抛错） */
  const sessionForChat = async (chatKey) => {
    const bound = (await readBindings())[chatKey]
    // target 现在存在账号级（accounts[].target），频道级 cfg.target 只是老配置的回落
    const target = bound?.target || (cur && cur.target) || cfg.defaultTarget || cfg.target
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
    const bindings = await readBindings()
    switch (cmd) {
      case 'help': {
        const isAdmin = adminOk(event)
        const out = []
        if (isAdmin) {
          out.push('$对话')
          out.push('/workspace 切换工作区')
          out.push('/preset 切换预设')
          out.push('/model 切换模型')
          out.push('/level 切换思考强度')
          out.push('/permission 切换权限')
          out.push('/new 开启新对话')
          out.push('/session 切换对话')
          out.push('/rename 重命名当前对话')
          out.push('')
        }
        out.push('$查询')
        out.push('/ver 获取插件版本')
        out.push('/status 查看当前对话信息')
        out.push('/help 获取帮助信息')
        if (isAdmin) {
          out.push('')
          out.push('$操作')
          out.push('/check 检查当前对话状态')
          out.push('/stop 停止当前对话')
        }
        return out.join('\n')
      }
      case 'status': {
        const target = await accountTarget(cur)
        const boundPreset = String(target || '').startsWith('p-') ? String(target).slice(2) : ''
        const boundSession = String(target || '').startsWith('s-') ? String(target).slice(2) : ''
        const pools = await presetPools()
        let sid = boundSession
        if (boundPreset) sid = pools.get(boundPreset)?.active || ''
        const smeta = sid ? await readSessionMeta(sid) : { preset: '', cwd: '' }
        const curPreset = smeta.preset || ''
        const own = sid ? await readSessionModel(sid) : null
        let def = null
        try { def = ctx.get('agentDefaultModel')?.currentSelection?.() || null } catch { def = null }
        const model = own ? `${own.provider}/${own.model}` : def ? `${def.provider}/${def.model}` : '未知'
        const dir = String(smeta.cwd || '').split(/[\\/]/).filter(Boolean).pop() || 'default-workspace'
        let perm = ''
        if (sid) {
          try {
            const handle = await ensureAgent(sid)
            const pp = ctx.get('permissionPresets')
            perm = pp?.current?.(handle.agent?.session) || pp?.current?.(handle.session) || ''
          } catch { perm = '' }
        }
        const lines = []
        if (boundPreset) {
          lines.push(`绑定预设: ${boundPreset}`)
          lines.push(`当前对话: ${sid || '（无）'}`)
        } else {
          lines.push(`绑定对话: ${boundSession || '（未绑定）'}`)
          lines.push(`当前预设: ${curPreset || '（无）'}`)
        }
        lines.push(`工作目录: ${dir}`)
        lines.push(`下轮模型: ${model}`)
        lines.push(`下轮权限: ${perm || '未知'}`)
        return lines.join('\n')
      }
      case 'new': {
        try {
          const target = await accountTarget(cur)
          const boundPreset = String(target || '').startsWith('p-') ? String(target).slice(2) : ''
          const boundSession = String(target || '').startsWith('s-') ? String(target).slice(2) : ''
          const pools = await presetPools()
          let curPreset = ''
          if (boundSession) {
            const meta = await readSessionMeta(boundSession)
            curPreset = meta.preset || ''
          }
          const base = boundSession || (boundPreset ? pools.get(boundPreset)?.active || '' : '')
          const bindings = await readBindings()
          const wsName = bindings[`ws:${cur.name}`]?.target || ''
          const newPreset = boundPreset || bindings[`newpreset:${cur.name}`]?.target || curPreset || 'standard'
          let wsPath = ''
          if (wsName) {
            wsPath = /^[A-Za-z]:[\\/]/.test(String(wsName)) ? String(wsName) : join(await workspacesRoot(), String(wsName))
          } else if (base) {
            // 没单独指定就复制当前对话的工作区；slug 目录名是单向编码（盘符冒号会丢），直接读会话头里的 cwd
            try {
              const meta = await readSessionMeta(base)
              const c = String(meta?.cwd || '')
              if (/^[A-Za-z]:[\\/]/.test(c) || c.startsWith('/') || c.startsWith('\\\\')) wsPath = c
            } catch { /* ignore */ }
          }
          const d = new Date()
          const pad = (n) => String(n).padStart(2, '0')
          const abc = 'abcdefghijkmnpqrstuvwxyz23456789'
          let tail = ''
          for (let i = 0; i < 4; i += 1) tail += abc[Math.floor(Math.random() * abc.length)]
          const sid = `whaleisle-${cur.name}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${tail}`
          const wantedName = String(arg || '').trim() || sid
          const created = await createSession(newPreset, wsPath, sid, base)
          const real = String(created?.id || '')
          if (!real) throw new Error('没有拿到会话 id')
          try {
            const titles = ctx.get('sessionTitle')
            if (titles && created?.agent) await titles.rename(created.agent.session, wantedName)
          } catch (err) { warn('设置会话标题失败：', err?.message || err) }
          // 挂到工作区（不挂 GUI 侧栏里不显示）
          try {
            const wr = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null
            if (wr && typeof wr.resolveByPath === 'function') {
              const ws = await wr.resolveByPath(String(created?.cwd || ''))
              if (ws && typeof ws.attachSession === 'function') await ws.attachSession(real)
            }
          } catch (err) { warn('挂工作区失败：', err?.message || err) }
          // 继承当前对话的权限档位
          try {
            const pp = ctx.get('permissionPresets')
            if (pp && base) {
              const curHandle = await ensureAgent(base)
              const perm = pp.current(curHandle.agent.session)
              if (perm) {
                const newHandle = await ensureAgent(real)
                pp.set(newHandle.agent.session, perm)
              }
            }
          } catch (err) { warn('继承权限失败：', err?.message || err) }
          if (boundPreset) {
            const file = join(homeDir(), 'xykp', 'preset-binder', 'preset-binder.json')
            const data = (await readJson(file, {})) || {}
            data.presets = data.presets || {}
            data.presets[boundPreset] = { ...(data.presets[boundPreset] || {}), active: real }
            await writeJson(file, data)
          } else {
            await writeBinding(`acct:${cur.name}`, `s-${real}`)
          }
          return wantedName === sid
            ? `已新建对话 ${real}`
            : `已新建对话 ${real}（${wantedName}）`
        } catch (err) {
          return `新建对话失败：${err?.message || err}`
        }
      }
      case 'permission': {
        const pp = typeof ctx.get === 'function' ? ctx.get('permissionPresets') : null
        if (!pp) return '宿主没有 permissionPresets，改不了权限'
        const target = await accountTarget(cur)
        const sid = (target ? await resolveTarget(target) : '') || (await activeSessionForAccount())
        if (!sid) return '当前账号没有目标会话'
        let agent = null
        try { agent = (await ensureAgent(sid)).agent } catch (err) { return `拿不到会话：${err?.message || err}` }
        const names = Array.isArray(pp.names) ? pp.names : []
        const now = pp.current(agent.session)
        if (!arg) {
          return names.map((n, i) => `${i + 1}.${n === now ? '[当前]' : ''}${n}`).join('\n')
        }
        const raw = String(arg).trim()
        const alias = { c: 'read-only', w: 'workspace-write', f: 'danger-full-access' }
        let chosen = alias[raw.toLowerCase()] || raw
        const num = Number(raw)
        if (Number.isInteger(num) && num >= 1 && num <= names.length) chosen = names[num - 1]
        if (!names.includes(chosen)) return `找不到权限：${raw}`
        try {
          await pp.set(agent.session, chosen)
          return `已将权限改为 ${chosen}`
        } catch (err) {
          return `改权限失败：${err?.message || err}`
        }
      }
      case 'workspace': {
        const bindings = await readBindings()
        const nextWs = bindings[`ws:${cur.name}`]?.target || ''
        const activeSid = await activeSessionForAccount()
        const meta = activeSid ? await readSessionMeta(activeSid) : { cwd: '' }
        const curWs = String(meta.cwd || '').split(/[\\/]/).filter(Boolean).pop() || ''
        let dirs = []
        try {
          const root = await workspacesRoot()
          dirs = (await readdir(root, { withFileTypes: true }))
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort()
        } catch { dirs = [] }
        if (!arg) {
          return dirs.map((name, i) => {
            const marks = []
            if (name === curWs) marks.push('[当前]')
            if (name !== curWs && name === nextWs) marks.push('[新建]')
            return `${i + 1}.${marks.join('')}${name}`
          }).join('\n') || '（没有工作区）'
        }
        let chosen = String(arg).trim()
        if (/^\d+$/.test(chosen)) {
          const n = Number(chosen)
          chosen = n >= 1 && n <= dirs.length ? dirs[n - 1] : ''
          if (!chosen) return `找不到工作区：${arg}`
        }
        await writeBinding(`ws:${cur.name}`, chosen)
        return `已将新建工作目录改为 ${chosen}`
      }
      case 'model': {
        const sid = await activeSessionForAccount()
        const own = sid ? await readSessionModel(sid) : null
        let def = null
        try { def = ctx.get('agentDefaultModel')?.currentSelection?.() || null } catch { def = null }
        const cur = own ? `${own.provider}/${own.model}` : def ? `${def.provider}/${def.model}` : ''
        const collect = async () => {
          const found = new Set()
          try {
            const pc = join(homeDir(), 'storages', 'session_projcache', 'sessions')
            const files = await readdir(pc)
            for (const f of files) {
              try {
                const j = JSON.parse(await readFile(join(pc, f), 'utf8'))
                const sel = j?.record?.rows?.modelSelection?.val?.lastUsed
                if (sel?.provider && sel?.model) found.add(`${sel.provider}/${sel.model}`)
              } catch { /* skip */ }
            }
          } catch { /* skip */ }
          if (def?.provider && def?.model) found.add(`${def.provider}/${def.model}`)
          if (cur) found.add(cur)
          return [...found].sort()
        }
        if (!arg) {
          const list = await collect()
          return list.map((u, i) => `${i + 1}.${u === cur ? '[当前]' : ''}${u}`).join('\n')
        }
        const raw = String(arg).trim()
        const list = await collect()
        let chosen = /^\d+$/.test(raw) ? (list[Number(raw) - 1] || '') : raw
        if (!/^[\w.-]+\/[\w.:/-]+$/.test(chosen)) return `找不到模型：${raw}`
        const slash = chosen.indexOf('/')
        const provider = chosen.slice(0, slash)
        const model = chosen.slice(slash + 1)
        if (!sid) return '当前账号没有目标会话，改不了模型'
        const file = join(homeDir(), 'storages', 'session_projcache', 'sessions', sid + '.json')
        try {
          const j = JSON.parse(await readFile(file, 'utf8'))
          const rows = j.record.rows
          const prev = rows.modelSelection?.val?.lastUsed || {}
          rows.modelSelection = rows.modelSelection || { val: {} }
          rows.modelSelection.val = rows.modelSelection.val || {}
          rows.modelSelection.val.lastUsed = { ...prev, provider, model }
          await writeFile(file, JSON.stringify(j), 'utf8')
          return `已将模型改为 ${provider}/${model}（下一轮生效）`
        } catch (err) {
          return `改模型失败：${err?.message || err}`
        }
      }
      case 'level': {
        const sid = await activeSessionForAccount()
        if (!sid) return '当前账号没有目标会话'
        const own = await readSessionModel(sid)
        let def = null
        try { def = ctx.get('agentDefaultModel')?.currentSelection?.() || null } catch { def = null }
        const curModel = own ? `${own.provider}/${own.model}` : def ? `${def.provider}/${def.model}` : ''
        const curLevel = own?.reasoningEffort || def?.reasoningEffort || ''
        if (!curModel) return '当前账号没有目标会话'
        if (!arg) {
          return [['low', '低'], ['medium', '中'], ['high', '高']]
            .map(([k], i) => `${i + 1}.${k === curLevel ? '[当前]' : ''}${k}`).join('\n')
        }
        const raw = String(arg).trim().toLowerCase()
        const alias = { '1': 'low', '2': 'medium', '3': 'high', 低: 'low', 中: 'medium', 高: 'high' }
        const chosen = alias[raw] || raw
        if (!['low', 'medium', 'high'].includes(chosen)) return `找不到档位：${raw}`
        const file = join(homeDir(), 'storages', 'session_projcache', 'sessions', sid + '.json')
        try {
          const j = JSON.parse(await readFile(file, 'utf8'))
          const rows = j.record.rows
          const prev = rows.modelSelection?.val?.lastUsed || {}
          rows.modelSelection = rows.modelSelection || { val: {} }
          rows.modelSelection.val = rows.modelSelection.val || {}
          rows.modelSelection.val.lastUsed = { ...prev, reasoningEffort: chosen }
          await writeFile(file, JSON.stringify(j), 'utf8')
          return `已将思考强度改为 ${chosen}（下一轮生效）`
        } catch (err) {
          return `改思考强度失败：${err?.message || err}`
        }
      }
      case 'stop': {
        const sid = await sessionForChat(chatKey)
        const agent = sid ? findAgent(sid) : null
        if (!agent) return `${sid || '（无对话）'} 未在运行`
        await agent.cancel()
        return `${sid} 已停止运行`
      }
      case 'check': {
        const sid = await sessionForChat(chatKey)
        const agent = sid ? findAgent(sid) : null
        const running = !!agent && (agent.running === true || agent.status === 'running')
        return `${sid || '（无对话）'} ${running ? '正在运行' : '未在运行'}`
      }
      case 'preset': {
        const bindings = await readBindings()
        const active = await activeSessionForAccount()
        const meta = active ? await readSessionMeta(active) : { preset: '' }
        const curPreset = meta.preset || ''
        const target = await accountTarget(cur)
        const boundPreset = String(target || '').startsWith('p-') ? String(target).slice(2) : ''
        const newPreset = boundPreset || bindings[`newpreset:${cur.name}`]?.target || curPreset || ''
        // 预设列表以宿主注册表为准：内置（standard / ptc / minimal / cordis）+ 用户预设（alive / neko…）。
        // 不能只看 preset-binder.json 里已经有会话的那几个，否则会漏掉一大半，还会冒出已经不存在的旧名字。
        const pools = await presetPools()
        const registry = ctx.get('agentPresets')
        let allPresets = []
        try {
          allPresets = registry && typeof registry.list === 'function' ? await registry.list() : []
        } catch {
          allPresets = []
        }
        allPresets = [...allPresets].sort((a, b) =>
          ((a.order ?? 999) - (b.order ?? 999)) || String(a.id).localeCompare(String(b.id)))
        const names = allPresets.map((p) => p.id)
        if (!arg) {
          if (!names.length) return '没有可用预设'
          return names.map((name, i) => {
            const info = allPresets.find((p) => p.id === name) || { id: name }
            const marks = []
            if (info.broken) marks.push('[损坏]')
            if (name === curPreset) marks.push('[当前]')
            else if (name === newPreset) marks.push('[新建]')
            const pool = pools.get(name) || []
            if (pool.length) marks.push(`[${pool.length}会话]`)
            const label = info.name && info.name !== name ? `${name}（${info.name}）` : name
            const desc = info.description ? ` ${info.description}` : ''
            return `${i + 1}.${marks.join('')}${label}${desc}`
          }).join('\n')
        }
        if (boundPreset) return '无法修改已绑定预设'
        const ref = String(arg).trim()
        const num = Number(ref)
        let chosen = ''
        if (Number.isInteger(num) && num >= 1) chosen = names[num - 1] || ''
        if (!chosen && names.includes(ref)) chosen = ref
        if (!chosen) return `找不到预设：${ref}`
        await writeBinding(`newpreset:${cur.name}`, chosen)
        return `已将新建预设改为 ${chosen}`
      }
      case 'session': {
        const args = String(arg || '').trim().split(/\s+/).filter(Boolean)
        const del = args.includes('-del')
        const rest = args.filter((x) => x !== '-del')
        let archived = []
        try { archived = (await archivedIds()) || [] } catch { archived = [] }
        const archivedSet = new Set((archived && archived.has) ? [...archived] : archived.map((x) => (typeof x === 'string' ? x : x.id)))
        const target = await accountTarget(cur)
        const boundPreset = String(target || '').startsWith('p-') ? String(target).slice(2) : ''
        const activeSid = await activeSessionForAccount()
        // 和 GUI 一致：磁盘上所有未归档、有标题的会话，按标题去重（保留最新）
        const sessionsRoot = join(homeDir(), 'sessions')
        const matches = []
        try {
          const dirs = await readdir(sessionsRoot)
          for (const d of dirs) {
            let subs = []
            try { subs = await readdir(join(sessionsRoot, d)) } catch { continue }
            for (const sid of subs) {
              if (archivedSet.has(sid)) continue
              const full = join(sessionsRoot, d, sid)
              let st = null
              try { st = await stat(full) } catch { continue }
              const t = ((await readSessionTitle(sid)) || '').trim()
              if (!t) continue
              matches.push({ id: sid, title: t, ts: st.mtimeMs })
            }
          }
        } catch { /* ignore */ }
        if (boundPreset) {
          const pool = (await presetPools()).get(boundPreset)
          const own = new Set()
          if (pool?.active) own.add(pool.active)
          if (pool?.sessions && pool.sessions !== true) {
            for (const k of pool.sessions) own.add(k)
          }
          // 池子可能过期（只记过 /new 建的那些），再以会话实际挂的预设为准兜底
          const kept = []
          for (const item of matches) {
            if (own.has(item.id)) { kept.push(item); continue }
            try {
              const meta = await readSessionMeta(item.id)
              if (String(meta?.preset || '') === boundPreset) kept.push(item)
            } catch { /* ignore */ }
          }
          matches.length = 0
          for (const item of kept) matches.push(item)
        }
        matches.sort((a, b) => b.ts - a.ts)
        const seenTitles = new Set()
        const list = []
        for (const item of matches) {
          if (seenTitles.has(item.title)) continue
          seenTitles.add(item.title)
          list.push({ id: item.id, title: item.title, updatedAt: item.ts })
        }
        if (!rest.length || /^-\d/.test(rest[0])) {
          const m = /^-(\d+)(?:\.(\d+))?$/.exec(rest[0] || '-1.6')
          const offset = m ? Math.max(1, Number(m[1])) : 1
          const limit = m && m[2] ? Math.max(1, Number(m[2])) : 6
          const slice = list.slice(offset - 1, offset - 1 + limit)
          const rows = []
          for (let i = 0; i < slice.length; i += 1) {
            const item = slice[i]
            const title = item.title || item.id
            rows.push(`${offset + i}.${title} ${ago(item.updatedAt || item.createdAt || 0)}`)
          }
          const end = Math.min(offset + limit - 1, list.length)
          return [`对话 (共 ${list.length}, 当前显示 ${offset} - ${end} 条)`, ...rows].join('\n')
        }
        const ref = rest[0]
        let found = null
        // 支持列表里显示的编号（1 起）
        if (/^\d+$/.test(ref)) {
          const n = Number(ref)
          if (n >= 1 && n <= list.length) found = list[n - 1]
        }
        if (!found) for (const item of list) {
          if (item.id === ref || item.id === `s-${ref}`) { found = item; break }
        }
        if (!found) {
          for (const item of list) {
            if ((await readSessionTitle(item.id)) === ref) { found = item; break }
          }
        }
        if (!found) return `找不到对话：${ref}`
        if (del) {
          if (found.id === active) return '该对话正在被使用，无法删除'
          try {
            await archiveSession(found.id)
            return `已删除对话 ${found.id}`
          } catch (err) {
            return `删除失败：${(err && err.message) || err}`
          }
        }
        if (boundPreset) {
          const file = join(homeDir(), 'xykp', 'preset-binder', 'preset-binder.json')
          const data = (await readJson(file, {})) || {}
          data.presets = data.presets || {}
          data.presets[boundPreset] = { ...(data.presets[boundPreset] || {}), active: found.id }
          await writeJson(file, data)
        } else {
          await writeBinding(`acct:${cur.name}`, `s-${found.id}`)
        }
        return `已切换到对话 ${found.id}`
      }
      case 'rename': {
        const name = String(arg || '').trim()
        if (!name) return '用法：/rename <名称>'
        const sid = (await activeSessionForAccount()) || (await sessionForChat(chatKey))
        if (!sid) return '当前没有对话'
        const titles = ctx.get('sessionTitle')
        if (!titles || typeof titles.rename !== 'function') return '宿主没有挂载 session-title 服务'
        try {
          const handle = await ensureAgent(sid)
          const agent = handle?.agent || handle
          const accepted = await titles.rename(agent.session, name)
          return `已将对话重命名为 ${accepted?.title || name}`
        } catch (err) {
          return `重命名失败：${err?.message || err}`
        }
      }
      case 'ver':
        return `whaleisle v${VERSION}`
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
      const acct = accountByName(info.account) || defaultAccount()
      await withLock(async () => {
        enter(acct)
        // 引用要显式：自动回复不再默认引用用户最后一条消息
        await sendToChat(info.conversationId, text, 0)
      })
      log(`自动回发 ${info.conversationId}（${text.length} 字，${acct.name}）`)
    } catch (err) {
      warn('自动回发失败：', err?.message || err)
    }
  }

  const onSessionEvent = async (session, event) => {
    if (!cfg.autoReply) return
    const key = canonSessionId(session && session.id)
    let info = pending.get(key)
    if (!info) {
      // 兜底：/new 之后投递记下的 session id 有时和事件里带的对不上，
      // 这时按「账号当前绑定的会话」反查，再用这个账号最近一次投递的聊天把回复发出去
      const rawId = String((session && session.id) || '')
      const targets = [`s-${rawId}`, rawId]
      const bind = await readBindings().catch(() => ({}))
      const hit = Object.entries(bind || {}).find(([k, v]) => k.startsWith('acct:')
        && targets.includes(String(v?.target || '')))
      const acctName = hit ? hit[0].slice(5) : ''
      const last = acctName ? lastChatOf.get(acctName) : null
      if (!last || Date.now() - last.at > 15 * 60_000) return
      info = {
        account: acctName,
        conversationId: last.conversationId,
        chatKey: last.chatKey,
        lastMessageId: 0,
        armed: true,
        sawOutput: false,
        at: Date.now(),
      }
      pending.set(key, info)
    }
    if (Date.now() - info.at > 15 * 60_000) { pending.delete(key); return }
    if (!event || typeof event !== 'object') return
    if (event.type === 'user/message') {
      if (event?.data?.source?.kind === SOURCE_KIND) {
        info.armed = true
        info.sawOutput = false
      }
      return
    }
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

  /** 工具里按账号名切到对应桥再跑（不传就用默认账号） */
  const asAccount = (name, fn) => withLock(async () => {
    enter(accountByName(name) || defaultAccount())
    return fn()
  })

  try {
    if (ctx.tools && typeof ctx.tools.register === 'function') {
      ctx.tools.register(defineTool({
        name: 'whaleisle_send',
        description: '用「鲸屿」发一条消息。chat 可以写 conversation_id，或 to=@用户名 / 群名；text 必填。多账号时用 account 指定走哪个号（默认账号可省略）。',
        parameters: {
          account: { type: 'string', description: '账号名（可选，默认账号）' },
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
          return asAccount(args.account, async () => {
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
            return toolOutput({
              ok: true, account: cur.name, conversation_id: conversationId, message_id: message.id,
            })
          })
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
          return asAccount(args.account, async () => {
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
            return toolOutput({ ok: true, account: cur.name, chats })
          }
          const data = await api(`/v1/messages?conversation_id=${encodeURIComponent(conversationId)}&limit=${limit}`)
          const messages = (data?.messages || []).map((msg) => ({
            id: msg.id,
            from: msg.sender?.display_name || msg.sender?.username || '?',
            text: msg.text,
            attachments: (msg.attachments || []).map((att) => att.name),
            at: msg.created_at,
          }))
          return toolOutput({ ok: true, account: cur.name, conversation_id: conversationId, messages })
          })
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
          const rows = []
          for (const acct of accounts) {
            let st = null
            let error = ''
            try { st = await apiOn(acct, '/v1/status') } catch (err) { error = err?.message || String(err) }
            rows.push({
              name: acct.name,
              isDefault: acct.name === defaultAccount().name,
              connected: Boolean(st?.connected),
              user: st?.user?.username || acct.me || '',
              queued: Number(st?.queued) || 0,
              cursor: acct.cursor,
              target: await accountTarget(acct),
              error,
            })
          }
          const bindings = await readBindings()
          return toolOutput({
            ok: true,
            accounts: rows,
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
        description: '把某个聊天绑到预设/会话，或解绑。chat 可以写 u-用户名 / g-会话id / 群名 / 账号名（acct:<账号>，直接改账号目标）；不带 chat 就列出当前绑定。',
        parameters: {
          account: { type: 'string', description: '用哪个账号查聊天名（可选，默认账号）' },
          chat: { type: 'string', description: 'u-用户名 / g-会话id / 群名 / acct:<账号名>（可选）' },
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
          if (/^acct:/i.test(rawChat)) {
            const name = rawChat.slice(5).trim()
            if (!accountByName(name)) throw new Error(`没有账号 ${name}`)
            const acctTarget = String(args.target || '').trim()
            await writeBinding(`acct:${name}`, acctTarget)
            return toolOutput({ ok: true, account: name, target: acctTarget || null, bindings: await readBindings() })
          }
          if (/^[ug]-/i.test(rawChat)) {
            key = normalizeKey(rawChat)
          } else {
            // 允许直接写名字：群名 / 用户名（不用记 id）
            const chats = (await apiOn(accountByName(args.account) || defaultAccount(), '/v1/chats'))?.chats || []
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
