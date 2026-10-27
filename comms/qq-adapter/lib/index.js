// qq-adapter · 宿主半边
//
// 干的事：
//   1. 轮询 QQ 桥（127.0.0.1:39272）的 /events，把新消息按分流规则送进对应的会话/预设
//   2. 提供 qq_send / qq_status 两个工具，让我能回消息、看桥的状态
//
// 分流规则写在插件的 Config 里 —— 也就是 Web 设置页那一层（cordis.patch.yml），
// 改完是 **live 生效**，不用重启宿主。
//
// 任何异常只记日志，绝不拖死宿主。

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { chatKeyOf, resolveRoute, parseTargetRef, formatIncoming, DEFAULTS as ROUTER_DEFAULTS } from './router.js'
import { createBridge } from './bridge.js'
import { toSilk, cleanupSilk } from './silk.js'
import { readOverride, pickRouting } from './overrides.js'
import { COMMANDS, COMMAND_INDEX, helpText, parseCommand, parseSessionArgs, isOwner } from './commands.js'
import { readChats, writeChats, newSessionId, listSessions, deleteSessionDir, ago } from './session-store.js'

export const name = 'qq-adapter'

/** 必须先拿到 agents（推消息进会话）；tools 没有也能跑（自测环境） */
export const inject = ['agents', 'tools']

/** 这条 user/message 的来源（宿主要求每条消息都有 source.kind） */
export const SOURCE_KIND = 'plugin:qq-adapter'

/** /ver 里显示的版本（改代码时顺手改一下） */
const PKG_VERSION = '0.2.0'

const log = (...a) => console.log('[qq-adapter]', ...a)
const warn = (...a) => console.warn('[qq-adapter]', ...a)

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('总开关（关掉就只保留工具，不再自动转发）'),
  bridgeUrl: Schema.string().default('http://127.0.0.1:39272').description('QQ 桥的 HTTP 地址'),
  selfUid: Schema.string().default('u_BsJrCaYeH77_OZ78H5pEXA').description('机器人自己的 uid（自己的消息不转发）'),
  defaultTarget: Schema.string().default('p-alive').description('默认目标：p-<预设名> 或 s-<会话id>'),
  mode: Schema.union([Schema.const('blacklist'), Schema.const('whitelist')]).default('blacklist')
    .description('名单模式：blacklist=名单里的不转，whitelist=只转名单里的'),
  blocked: Schema.array(Schema.string()).default([]).description('黑名单：u-<uid> / g-<群号>'),
  allowed: Schema.array(Schema.string()).default([]).description('白名单：u-<uid> / g-<群号>'),
  mappings: Schema.array(Schema.object({
    chat: Schema.string().description('u-<uid> 或 g-<群号>'),
    target: Schema.string().description('p-<预设名> 或 s-<会话id>'),
  })).default([]).description('自定义映射（优先于名单）'),
  deliverMode: Schema.union([Schema.const('steer'), Schema.const('followup')]).default('steer')
    .description('转发方式：steer=插队（这轮就能看到）/ followup=排队（下轮才看到）'),
  pollMs: Schema.number().default(1500).description('轮询间隔（毫秒）'),
  maxPerTick: Schema.number().default(10).description('一次最多转发几条'),
  coalesceSeconds: Schema.number().default(10).description('合并窗口（秒）：同一个聊天里的消息攒到「静默这么久」再一次性发；0 = 不合并，来一条转一条'),
  fastUids: Schema.array(Schema.string()).default([]).description('不受限的聊天（u-<uid> / g-<群号>），这些来一条转一条'),
  ownerUids: Schema.array(Schema.string()).default([]).description('能发管理类指令的人（写 uid 或 u-<uid> 都行）；私聊切换不需要，群聊/预设相关才要'),
  workspaceRoot: Schema.string().default('D:\\\\AI\\\\DeepseekHarness\\\\workspaces\\\\alive-workspace').description('新会话默认挂哪个工作区'),
  commandsEnabled: Schema.boolean().default(true).description('QQ 侧指令开关（关掉就全当普通消息）'),
  instanceId: Schema.string().default('default').description('实例名：同一个宿主跑多个账号时用来隔开去重文件/内部状态'),
  toolPrefix: Schema.string().default('').description('工具名前缀（同一个宿主跑两个 QQ 账号时，第二个实例用 qq2_ 之类，免得多实例抢同名工具）'),
  seenPath: Schema.string().default('').description('去重记录文件（空 = <DSH_HOME>/qq-adapter/seen-<instanceId>.json）'),
  skipBacklog: Schema.boolean().default(true).description('启动时不补发桥里积压的旧消息'),
  notifyTopic: Schema.string().default('whale-qq-shell-channel').description('登录失效时把二维码推到哪个 ntfy 主题（空 = 不推）'),
  notifyEveryMinutes: Schema.number().default(3).description('两次推码之间至少隔几分钟'),
  notifyMax: Schema.number().default(3).description('一次掉线最多推几张码'),
  qrFile: Schema.string().default('D:\\\\AI\\\\DeepseekHarness\\\\workspaces\\\\alive-workspace\\\\qq-qr-fresh.png').description('桥写出来的二维码图片路径'),
  autoStartShell: Schema.boolean().default(true).description('桥没在跑时自动拉起 QQ shell'),
  shellBootPath: Schema.string().default('D:\\\\Program-Files\\\\QQ-shell\\\\NapCatWinBootMain.exe').description('shell 启动器路径'),
  shellDir: Schema.string().default('D:\\\\Program-Files\\\\QQ-shell').description('shell 工作目录'),
  ffmpegPath: Schema.string().default('ffmpeg').description('发语音时转 PCM 用的 ffmpeg（PATH 里没有就给绝对路径）'),
  silkEncoderPath: Schema.string().default('D:\\\\AI\\\\DeepseekHarness\\\\tools\\\\silk\\\\silk_encode.exe').description('silk 编码器路径（自编的 silk_encode.exe）'),
})

const home = () => process.env.DSH_HOME || join(homedir(), '.dsh')

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
}

async function writeJson(path, data) {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(data, null, 2), 'utf8')
  } catch (err) { warn('写 ' + path + ' 失败：', err?.message || err) }
}

async function loadBinder() {
  return readJson(join(home(), 'storages', 'preset-binder.json'), null)
}

/** p-<预设> / s-<会话id> → 真正的会话 id */
async function resolveTarget(targetRef) {
  const ref = parseTargetRef(targetRef)
  if (ref.kind === 'none') return { sessionId: '', reason: '目标为空' }
  if (ref.kind === 'session') return { sessionId: ref.value, via: 'session' }
  const binder = await loadBinder()
  const active = binder && binder.presets && binder.presets[ref.value] && binder.presets[ref.value].active
  if (active && String(active).trim()) return { sessionId: String(active).trim(), via: 'preset', preset: ref.value }
  return { sessionId: '', reason: '预设 ' + ref.value + ' 没有活跃会话' }
}

/** 找 agent（会话 id 有带/不带 session- 前缀两种写法） */
function findAgent(agents, sessionId) {
  const cands = [String(sessionId)]
  if (String(sessionId).startsWith('session-')) cands.push(String(sessionId).slice('session-'.length))
  else cands.push('session-' + sessionId)
  for (const id of cands) {
    try {
      const a = agents.get(id)
      if (a) return a
    } catch { /* 查不到当没有 */ }
  }
  return null
}

async function deliver(agentsSvc, sessionId, text, mode = 'steer') {
  const agent = findAgent(agentsSvc, sessionId)
  if (!agent) throw new Error('会话 ' + sessionId + ' 找不到了（可能被归档/删了）')
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND },
  })
  if (mode === 'steer' && typeof agent.steer === 'function') {
    await agent.steer(message)
    return { delivered: true, via: 'steer' }
  }
  await agent.followup(message)
  return { delivered: true, via: 'followup' }
}

export async function apply(ctx, config = {}) {
  const cfg = { ...ROUTER_DEFAULTS, ...Config(config) }
  const bridge = createBridge(cfg.bridgeUrl, { timeoutMs: 4000 })
  // 在 apply（还活着）的时候就把 agents 抓住，定时器里不再碰 ctx
  const agentsSvc = ctx.agents
  const INST = String(cfg.instanceId || 'default')
  const TP = (n) => String(cfg.toolPrefix || '') + n
  const seenFile = () => cfg.seenPath || join(home(), 'qq-adapter', 'seen-' + INST + '.json')

  let seen = await readJson(seenFile(), { ids: [], cursor: 0 })
  if (!Array.isArray(seen.ids)) seen.ids = []
  const seenSet = new Set(seen.ids)
  let cursor = Number(seen.cursor) || 0
  let started = false
  let running = false

  async function saveSeen() {
    seen.ids = Array.from(seenSet).slice(-2000)
    seen.cursor = cursor
    await writeJson(seenFile(), seen)
  }

  /** 桥没在跑就把 QQ shell 拉起来（DSH 重启后 shell 会跟着死，这条兜住） */
  let lastSpawnAt = 0
  async function ensureShell() {
    // 先看桥：活着就看登录态，挂了才去拉
    let st = null
    try { st = await bridge.status() } catch { st = null }
    if (st && st.ok) {
      const ready = st.stage === 'ready' && st.ms === true
      if (ready) {
        if (!wasReady) { log('桥已就绪（uin=' + st.uin + '）') ; wasReady = true }
        notifyCount = 0
        return
      }
      wasReady = false
      await pushQrToNtfy(st)
      return
    }
    if (cfg.autoStartShell === false) return
    // 冷却：壳正在启动时 /status 还没起来，别每 15 秒又拉一个（两个实例会互相踢登录）
    if (Date.now() - lastSpawnAt < 120000) return
    // 同一套安装目录里只要有 QQ.exe 在跑，就绝不能再拉一个：
    // QQ.exe 是单实例的，后来的那个会把先跑的顶掉（2026-10-27 半夜就这么把樱和鲸鱼娘各顶掉一次）
    try {
      const { execFileSync } = await import('node:child_process')
      const dirPrefix = String(cfg.shellDir || 'D:\\Program-Files\\QQ-shell')
      const psCmd = "Get-Process -Name QQ -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '" + dirPrefix + "*' } | Select-Object -First 1 -ExpandProperty Id"
      const alive = String(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { encoding: 'utf8', windowsHide: true }) || '').trim()
      if (alive) { log('壳的 QQ 进程还在（pid=' + alive + '），不重复拉'); return }
    } catch { /* 查不到就按原来的走 */ }
    lastSpawnAt = Date.now()
    try {
      // 用 WMI 拉，进程挂在 WmiPrvSE 下面 —— 这样宿主重启（杀进程树）不会把 QQ shell 一起带走
      const { execFile } = await import('node:child_process')
      const boot = cfg.shellBootPath || 'D:\\Program-Files\\QQ-shell\\NapCatWinBootMain.exe'
      const dir = cfg.shellDir || 'D:\\Program-Files\\QQ-shell'
      const ps = 'powershell.exe'
      const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"
      const script =
        'Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ' +
        q(boot) + '; CurrentDirectory = ' + q(dir) + ' } | Out-Null'
      execFile(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err) => {
        if (err) warn('拉起 QQ shell 失败：', err.message)
        else log('桥没在跑，已用 WMI 拉起 QQ shell：' + boot)
      })
    } catch (err) { warn('拉起 QQ shell 失败：', err?.message || err) }
  }
  // ── 哨兵：桥没起来就去拉；起来了但没登录就把二维码推到 ntfy ──
  let lastNotifyAt = 0
  let notifyCount = 0
  let wasReady = false

  async function pushQrToNtfy(st) {
    if (!cfg.notifyTopic) return
    const everyMs = Math.max(30_000, (Number(cfg.notifyEveryMinutes) || 3) * 60_000)
    if (Date.now() - lastNotifyAt < everyMs) return
    if (notifyCount >= (Number(cfg.notifyMax) || 3)) return
    lastNotifyAt = Date.now()
    notifyCount++
    try {
      const { readFile } = await import('node:fs/promises')
      const png = await readFile(cfg.qrFile || '')
      const res = await fetch('https://ntfy.sh/' + encodeURIComponent(cfg.notifyTopic), {
        method: 'PUT',
        headers: {
          Title: 'QQ shell needs a QR scan (' + notifyCount + '/' + (cfg.notifyMax || 3) + ')',
          Tags: 'rotating_light,qrcode',
          Priority: '4',
          Filename: 'qq-qr.png',
        },
        body: png,
      })
      log('已把二维码推到 ntfy（' + cfg.notifyTopic + '）HTTP ' + res.status + ' · uin=' + (st?.uin ?? '?') + ' stage=' + (st?.stage ?? '?'))
    } catch (err) { warn('推二维码到 ntfy 失败：', err?.message || err) }
  }
  // ────────── QQ 侧指令系统 ──────────
  // 规矩（主人 2026-10-28 定）：不做伪群组；一个会话就是一个会话；id 自己起；
  // 私聊切绑定不用权限，群聊 / 预设相关要权限；配置类带 -d 顺手改部署默认。
  const chatCache = { data: null, at: 0 }

  async function chatsNow(force) {
    if (!force && chatCache.data && Date.now() - chatCache.at < 1000) return chatCache.data
    chatCache.data = await readChats()
    chatCache.at = Date.now()
    return chatCache.data
  }

  async function setChatSession(key, sessionId, extra) {
    const all = await chatsNow(true)
    all[key] = { ...(all[key] || {}), sessionId, updatedAt: Date.now(), ...(extra || {}) }
    await writeChats(all)
    chatCache.data = all
    chatCache.at = Date.now()
  }

  function splitKey(key) {
    const g = /^g-(.+)$/.exec(String(key || ''))
    if (g) return { chatType: 2, peerUid: g[1] }
    const u = /^u-(.+)$/.exec(String(key || ''))
    if (u) return { chatType: 1, peerUid: u[1] }
    return null
  }

  async function replyTo(key, text) {
    const p = splitKey(key)
    if (!p) return
    try { await bridge.send(p.chatType, p.peerUid, text) } catch (err) { warn('指令回复发送失败：', err?.message || err) }
  }

  async function chatSessionId(key) {
    const all = await chatsNow()
    const bound = all[key] && all[key].sessionId
    if (bound && findAgent(agentsSvc, bound)) return bound
    const route = resolveRoute(cfg, key)
    if (!route.target) return ''
    const t = await resolveTarget(route.target)
    return t.sessionId || ''
  }

  function presetOfTarget(target) {
    const ref = parseTargetRef(target)
    return ref.kind === 'preset' ? ref.value : ''
  }

  /** 建会话：先按聊天偏好临时改部署默认（模型/等级/预设），建完立刻改回去 */
  async function createSessionFor(key) {
    const route = resolveRoute(cfg, key)
    const all = await chatsNow(true)
    const prefs = (all[key] && all[key].prefs) || {}
    const preset = prefs.preset || (route.target ? presetOfTarget(route.target) : '')
    const cwd = prefs.workspace || cfg.workspaceRoot
    const editor = (() => { try { return ctx.get('configEditor') } catch { return null } })()
    const overrideOf = (id) => {
      try {
        const row = editor.configuration().find((r) => r.entry.options.id === id)
        return row ? { ...(row.override || {}) } : null
      } catch { return null }
    }
    const entryOf = (id) => {
      try { return editor.entries().find((e) => e.options.id === id) } catch { return null }
    }
    const saved = {}
    let patched = false
    try {
      if (editor && prefs.model) {
        const entry = entryOf('agent-default-model')
        const orig = overrideOf('agent-default-model')
        if (entry && orig) {
          saved.model = orig
          await editor.edit(entry, (c) => ({
            ...(c || {}), provider: prefs.model.provider, model: prefs.model.model,
            ...(prefs.level ? { reasoningEffort: prefs.level } : {}),
          }))
          patched = true
        }
      }
      if (editor && prefs.preset) {
        const entry = entryOf('agent-preset-registry')
        const orig = overrideOf('agent-preset-registry')
        if (entry && orig) {
          saved.preset = orig
          await editor.edit(entry, (c) => ({ ...(c || {}), selectedDefault: prefs.preset }))
          patched = true
        }
      }
      const id = newSessionId('qq')
      const meta = { cwd }
      if (preset) meta.agentPreset = preset
      const handle = await agentsSvc.create({ sessionId: id, meta })
      const real = handle?.agent?.session?.id || id
      await setChatSession(key, real, { preset })
      return { id: real, preset }
    } finally {
      // 临时改的部署默认，不管建没建成都改回去
      if (patched) {
        try {
          if (saved.model) {
            const entry = entryOf('agent-default-model')
            if (entry) await editor.edit(entry, () => saved.model)
          }
          if (saved.preset) {
            const entry = entryOf('agent-preset-registry')
            if (entry) await editor.edit(entry, () => saved.preset)
          }
        } catch (err) { warn('恢复部署默认失败：', err?.message || err) }
      }
    }
  }

  async function runCommand(evt, key, parsed) {
    const spec = COMMAND_INDEX.get(parsed.name)
    const chatType = Number(evt.chatType) || 1
    const owner = isOwner(evt.senderUid, cfg)
    if (!spec) {
      await replyTo(key, '未知指令 /' + parsed.name + '。发 /help 看列表；想让模型处理就去掉开头的 / 重发')
      return
    }
    // 权限：群聊里所有「会改状态」的指令要主人；私聊里只放行 会话类
    const stateChanging = ['model', 'level', 'workspace', 'preset', 'permission', 'cfg-default', 'cfg-mode', 'cfg-list', 'cfg-table', 'stop'].includes(spec.name)
    if (stateChanging && !owner) {
      await replyTo(key, '这条指令只有主人能用' + (chatType === 2 ? '（群里）' : ''))
      return
    }
    if (chatType === 2 && ['new', 'session', 'compact'].includes(spec.name) && !owner) {
      await replyTo(key, '群聊里切会话只有主人能用')
      return
    }

    if (spec.name === 'help') { await replyTo(key, helpText()); return }
    if (spec.name === 'ver') {
      // 能收到回复就说明插件活着，多余的状态不啰嗦
      await replyTo(key, 'qq-adapter ' + INST + ' v' + PKG_VERSION)
      return
    }
    if (spec.name === 'status') {
      const sid = await chatSessionId(key)
      const agent = sid ? findAgent(agentsSvc, sid) : null
      const all = await chatsNow()
      const bound = all[key] || {}
      await replyTo(key, [
        '聊天 ' + key,
        '绑定会话 ' + (sid || '（没有）') + (bound.sessionId ? '（来自 chats.json）' : '（来自默认/映射）'),
        '预设 ' + (bound.preset || presetOfTarget(resolveRoute(cfg, key).target) || '—'),
        '状态 ' + (agent ? agent.status : '（找不到这个会话）'),
        '指令 ' + (cfg.commandsEnabled === false ? '关' : '开') + ' · 限流 ' + (cfg.coalesceSeconds > 0 ? cfg.coalesceSeconds + 's' : '关'),
      ].join('\n'))
      return
    }
    if (spec.name === 'free') {
      const sid = await chatSessionId(key)
      const agent = sid ? findAgent(agentsSvc, sid) : null
      if (!agent) { await replyTo(key, '这个聊天没有可用的会话'); return }
      await replyTo(key, agent.status === 'running'
        ? '这条会话在跑（running）。要是它是卡在等审批上，用 /stop 才停得掉，/free 只看不动'
        : '空闲（idle），没在跑')
      return
    }
    if (spec.name === 'stop') {
      const sid = await chatSessionId(key)
      const agent = sid ? findAgent(agentsSvc, sid) : null
      if (!agent) { await replyTo(key, '没有可停的会话'); return }
      if (agent.status !== 'running') { await replyTo(key, '它本来就没在跑'); return }
      try { agent.cancel('user') } catch (err) { await replyTo(key, '停不下来：' + (err?.message || err)); return }
      await replyTo(key, '⏹ 已经叫停了')
      return
    }
    if (spec.name === 'new') {
      const { id, preset } = await createSessionFor(key)
      await replyTo(key, '新会话开好了：' + id + (preset ? '（预设 ' + preset + '）' : '') + '\n这个聊天已经绑过去')
      return
    }
    if (spec.name === 'session') {
      const args = parseSessionArgs(parsed.arg)
      if (args.bad) { await replyTo(key, '看不懂这个参数：' + args.bad + '\n用法 /session [-[[offset,]n]] [-del]'); return }
      const current = await chatSessionId(key)
      const all = await listSessions()
      // 绑预设 → 看这个预设池里的会话；绑会话 → 全都列出来（主人 2026-10-28 的规矩）
      const routeNow = resolveRoute(cfg, key)
      const refNow = parseTargetRef(routeNow.target)
      let mine = all
      if (refNow.kind === 'preset') {
        try {
          const binder = await readJson(join(home(), 'storages', 'preset-binder.json'), null)
          const pool = binder && binder.presets && binder.presets[refNow.value]
          const ids = new Set(Object.keys((pool && pool.sessions) || {}))
          if (pool && pool.active) ids.add(String(pool.active))
          if (ids.size) mine = all.filter((s) => ids.has(s.id))
        } catch { /* 拿不到池子就都列出来 */ }
      }
      if (!mine.length) { await replyTo(key, '还没有自己的会话，发 /new 开一个'); return }
      if (args.index !== null) {
        const rows = mine.slice(args.offset, args.offset + args.count)
        const picked = rows[args.index - 1]
        if (!picked) { await replyTo(key, '序号越界：现在只显示 ' + rows.length + ' 条'); return }
        if (args.del) {
          if (picked.id === current) { await replyTo(key, '不能删正在用的这条，先 /new 或切走'); return }
          await deleteSessionDir(picked.workspace, picked.id)
          const chats = await chatsNow(true)
          for (const k of Object.keys(chats)) if (chats[k] && chats[k].sessionId === picked.id) delete chats[k]
          await writeChats(chats)
          chatCache.data = chats
          await replyTo(key, '删了：' + picked.id)
          return
        }
        if (!findAgent(agentsSvc, picked.id)) { await replyTo(key, picked.id + ' 现在没有活着的 agent（下次发消息会自动起）') }
        await setChatSession(key, picked.id)
        await replyTo(key, '切到：' + picked.id)
        return
      }
      const rows = mine.slice(args.offset, args.offset + args.count)
      const lines = rows.map((s, i) => (i + 1) + '. ' + s.id + (s.id === current ? '  ← 当前' : '') + '  ' + ago(s.updatedAt))
      await replyTo(key, '会话（共 ' + mine.length + '，从第 ' + (args.offset + 1) + ' 条起 ' + rows.length + ' 条）\n' +
        lines.join('\n') + '\n\n/session <序号> 切换 · /session <序号> -del 删除')
      return
    }
    if (spec.name === 'compact') {
      // 走 memory-refine 自带的 memory_movctx：它自己把对话压成交接、开新对话接着聊
      // （同一份逻辑宿主里早就有了，别自己再造一遍）
      const old = await chatSessionId(key)
      const agent = old ? findAgent(agentsSvc, old) : null
      if (!agent) { await replyTo(key, '这个聊天没有活着的会话，没法压缩'); return }
      const before = new Set((await listSessions()).map((s) => s.id))
      const say = '（系统指令）请调用 memory_movctx 工具：把我和你这段对话压成交接摘要、开一个新对话接着聊，extra 不用填。做完回我一句「已交接」。'
      try { await deliver(agentsSvc, old, say, cfg.deliverMode) } catch (err) { await replyTo(key, '叫不动它：' + (err?.message || err)); return }
      await replyTo(key, '已让它自己压缩并开新对话（memory_movctx），我盯着新会话切绑定…')
      // 盯 60 秒，看有没有新会话冒出来，有就把这个聊天绑过去
      let hits = 0
      const timer = setInterval(async () => {
        hits++
        try {
          const now = await listSessions()
          const fresh = now.find((s) => !before.has(s.id))
          if (fresh) {
            clearInterval(timer)
            await setChatSession(key, fresh.id, { preset: '' })
            await replyTo(key, '新会话接上了：' + fresh.id + '\n这个聊天已经绑过去')
            return
          }
        } catch { /* 继续等 */ }
        if (hits > 20) { clearInterval(timer); warn('compact 没等到新会话（' + key + '）') }
      }, 3000)
      if (typeof timer.unref === 'function') timer.unref()
      return
    }

    // ── 适配层配置类：改的是 ui-config.json（运行时覆盖）──
    if (spec.name.startsWith('cfg-')) {
      const cur = (await bridge.getConfig()) || {}
      const mineCfg = cur[INST] || {}
      const tokens = String(parsed.arg || '').split(/\s+/).filter(Boolean)
      if (spec.name === 'cfg-default') {
        if (!tokens.length) { await replyTo(key, '当前默认目标：' + (mineCfg.defaultTarget || cfg.defaultTarget)); return }
        const v = tokens[0]
        await bridge.saveConfig(INST, { defaultTarget: v })
        await replyTo(key, '默认目标改成 ' + v + '（下一轮生效）')
        return
      }
      if (spec.name === 'cfg-mode') {
        if (!tokens.length) { await replyTo(key, '当前模式：' + (mineCfg.mode || cfg.mode)); return }
        if (!['blacklist', 'whitelist'].includes(tokens[0])) { await replyTo(key, '只有 blacklist / whitelist'); return }
        await bridge.saveConfig(INST, { mode: tokens[0] })
        await replyTo(key, '名单模式改成 ' + tokens[0])
        return
      }
      if (spec.name === 'cfg-list') {
        const listName = { blocked: 'blocked', allowed: 'allowed', fast: 'fastUids', fastUids: 'fastUids' }
        const which = tokens.find((t) => listName[t]) || 'blocked'
        const field = listName[which]
        const arr = Array.isArray(mineCfg[field]) ? mineCfg[field].slice() : []
        const add = tokens.indexOf('-add')
        const del = tokens.indexOf('-del')
        if (add >= 0 && tokens[add + 1]) {
          if (!arr.includes(tokens[add + 1])) arr.push(tokens[add + 1])
          await bridge.saveConfig(INST, { [field]: arr })
          await replyTo(key, which + ' 加了 ' + tokens[add + 1])
          return
        }
        if (del >= 0 && tokens[del + 1]) {
          const t = tokens[del + 1]
          const idx = arr.indexOf(t)
          let removed = ''
          if (idx >= 0) removed = arr.splice(idx, 1)[0]
          else if (/^\d+$/.test(t)) removed = arr.splice(Number(t) - 1, 1)[0] || ''
          await bridge.saveConfig(INST, { [field]: arr })
          await replyTo(key, removed ? which + ' 删了 ' + removed : '没找到要删的')
          return
        }
        await replyTo(key, which + '（' + arr.length + '）\n' + (arr.length ? arr.map((x, i) => (i + 1) + '. ' + x).join('\n') : '（空）'))
        return
      }
      if (spec.name === 'cfg-table') {
        const maps = Array.isArray(mineCfg.mappings) ? mineCfg.mappings.slice() : []
        const setAt = tokens.indexOf('-set')
        const delAt = tokens.indexOf('-del')
        if (setAt >= 0 && tokens[setAt + 1] && tokens[setAt + 2]) {
          const chat = tokens[setAt + 1]
          const target = tokens[setAt + 2]
          const i = maps.findIndex((m) => m.chat === chat)
          if (i >= 0) maps[i] = { chat, target }
          else maps.push({ chat, target })
          await bridge.saveConfig(INST, { mappings: maps })
          await replyTo(key, '映射：' + chat + ' → ' + target)
          return
        }
        if (delAt >= 0 && tokens[delAt + 1]) {
          const t = tokens[delAt + 1]
          const i = maps.findIndex((m) => m.chat === t)
          const removed = i >= 0 ? maps.splice(i, 1)[0] : null
          await bridge.saveConfig(INST, { mappings: maps })
          await replyTo(key, removed ? '删了映射 ' + removed.chat : '没找到这条映射')
          return
        }
        await replyTo(key, '映射（' + maps.length + '）\n' + (maps.length ? maps.map((m) => m.chat + ' → ' + m.target).join('\n') : '（空）') + '\n\n/cfg-table -set u-xxx p-alive · /cfg-table -del u-xxx')
        return
      }
    }

    // ── 配置类：直接改「部署默认」，或者先存偏好等下次 /new 用 ──
    if (['model', 'level', 'workspace', 'preset', 'permission'].includes(spec.name)) {
      const editor = (() => { try { return ctx.get('configEditor') } catch { return null } })()
      if (!editor) { await replyTo(key, '这个宿主没给 configEditor，改不了配置'); return }
      const entryOf = (id) => { try { return editor.entries().find((e) => e.options.id === id) } catch { return null } }
      const wantDefault = /(^|\s)-d(\s|$)/.test(String(parsed.arg || ''))
      const body = String(parsed.arg || '').replace(/(^|\s)-d(\s|$)/g, ' ').trim()

      if (spec.name === 'model' || spec.name === 'level') {
        const cur = (() => { try { return (editor.configuration().find((r) => r.entry.options.id === 'agent-default-model') || {}).override || {} } catch { return {} } })()
        const chat = (await chatsNow(true))[key] || {}
        const pref = chat.prefs || {}
        const show = () => replyTo(key, '当前部署默认：' + (cur.provider || '?') + ' / ' + (cur.model || '?') + (cur.reasoningEffort ? ' / ' + cur.reasoningEffort : '') +
          (pref.model ? '\n这个聊天的偏好：' + pref.model.provider + ' / ' + pref.model.model + '（下次 /new 生效）' : '') +
          (pref.level ? '\n等级偏好：' + pref.level : ''))
        if (!body) { await show(); return }
        if (spec.name === 'level') {
          if (wantDefault) {
            const entry = entryOf('agent-default-model')
            if (!entry) { await replyTo(key, '找不到 agent-default-model'); return }
            await editor.edit(entry, (c) => ({ ...(c || {}), reasoningEffort: body }))
            await replyTo(key, '部署默认推理等级 → ' + body)
          } else {
            const all = await chatsNow(true)
            all[key] = { ...(all[key] || {}), prefs: { ...(all[key]?.prefs || {}), level: body } }
            await writeChats(all); chatCache.data = all
            await replyTo(key, '记下了：下次 /new 用 ' + body + ' 等级')
          }
          return
        }
        const parts = body.split(/\s+/).filter(Boolean)
        if (parts.length < 2 && !parts[0]?.includes('/')) { await replyTo(key, '用法 /model <provider> <model> [-d]\n（或者 /model 看当前）'); return }
        const provider = parts[0]
        const model = parts[1] || parts[0]
        if (wantDefault) {
          const entry = entryOf('agent-default-model')
          if (!entry) { await replyTo(key, '找不到 agent-default-model'); return }
          await editor.edit(entry, (c) => ({ ...(c || {}), provider, model }))
          await replyTo(key, '部署默认模型 → ' + provider + ' / ' + model)
        } else {
          const all = await chatsNow(true)
          all[key] = { ...(all[key] || {}), prefs: { ...(all[key]?.prefs || {}), model: { provider, model } } }
          await writeChats(all); chatCache.data = all
          await replyTo(key, '记下了：下次 /new 用 ' + provider + ' / ' + model)
        }
        return
      }

      if (spec.name === 'preset') {
        const reg = (() => { try { return (editor.configuration().find((r) => r.entry.options.id === 'agent-preset-registry') || {}).override || {} } catch { return {} } })()
        if (!body) {
          const chat = (await chatsNow(true))[key] || {}
          await replyTo(key, '部署默认预设：' + (reg.selectedDefault || reg.default || '?') +
            (chat.prefs && chat.prefs.preset ? '\n这个聊天的偏好：' + chat.prefs.preset + '（下次 /new 生效）' : ''))
          return
        }
        if (wantDefault) {
          const entry = entryOf('agent-preset-registry')
          if (!entry) { await replyTo(key, '找不到 agent-preset-registry'); return }
          await editor.edit(entry, (c) => ({ ...(c || {}), selectedDefault: body }))
          await replyTo(key, '部署默认预设 → ' + body)
        } else {
          const all = await chatsNow(true)
          all[key] = { ...(all[key] || {}), prefs: { ...(all[key]?.prefs || {}), preset: body } }
          await writeChats(all); chatCache.data = all
          await replyTo(key, '记下了：下次 /new 用预设 ' + body)
        }
        return
      }

      if (spec.name === 'workspace') {
        const chat = (await chatsNow(true))[key] || {}
        if (!body) {
          await replyTo(key, '部署工作区根：' + cfg.workspaceRoot +
            (chat.prefs && chat.prefs.workspace ? '\n这个聊天的偏好：' + chat.prefs.workspace : ''))
          return
        }
        if (wantDefault) {
          const entry = entryOf('workspace-controller')
          if (!entry) { await replyTo(key, '找不到 workspace-controller'); return }
          await editor.edit(entry, (c) => ({ ...(c || {}), documentsDirectory: body }))
          cfg.workspaceRoot = body
          await replyTo(key, '部署工作区根 → ' + body)
        } else {
          const all = await chatsNow(true)
          all[key] = { ...(all[key] || {}), prefs: { ...(all[key]?.prefs || {}), workspace: body } }
          await writeChats(all); chatCache.data = all
          await replyTo(key, '记下了：下次 /new 在这个工作区开\n' + body)
        }
        return
      }

      if (spec.name === 'permission') {
        await replyTo(key, '/permission 还在接（权限预设那条 entry 我还没定位到），先别依赖它')
        return
      }
    }
    await replyTo(key, '这条指令还没实现：/' + spec.name)
  }
  // ── 允许配置里直接写 QQ 号（u-3041632789），这里统一换成内核用的 uid ──
  const uinCache = new Map()
  async function normChatKey(key) {
    const s = String(key || '').trim()
    if (!/^u-\d{5,}$/.test(s)) return s
    if (uinCache.has(s)) return uinCache.get(s)
    try {
      const r = await bridge.uid(s.slice(2))
      if (r && r.ok && r.uid) { const v = 'u-' + r.uid; uinCache.set(s, v); return v }
    } catch { /* 转不了就按原样，最多匹配不上 */ }
    return s
  }

  // ── 流量控制：同一个聊天太频繁就暂存，攒够「静默窗口」再合并成一条发 ──
  // 主人定的语义（2026-10-28）：只用一个数 `coalesceSeconds`。
  //   · 同一个聊天里的消息，谁先来就先攒着，每次攒到新的就重新计时
  //   · 静默够 coalesceSeconds 就把攒的 + 最新这条一起发出去（一次发送 = 清空缓存）
  //   · 所以「最短间隔」和「静默多久」本来就是一件事，拆成两个参数只会互相打架
  //   · fastUids 里的聊天不受限（来一条转一条）
  // 防呆：一直有人刷屏时不至于永远发不出去，攒最久的那条超过 3 个窗口就强制发。
  const pendingBatch = new Map() // key -> { parts: [{sender,text}], timer, firstAt }
  const lastDeliveredAt = new Map() // key -> ms

  function coalesceMs() {
    return Math.max(0, (Number(cfg.coalesceSeconds) || 0) * 1000)
  }

  function trafficLimited(key) {
    if (coalesceMs() <= 0) return false
    const fast = Array.isArray(cfg.fastUids) ? cfg.fastUids : []
    return !fast.includes(key)
  }

  function queueBatch(key, evt, text) {
    let st = pendingBatch.get(key)
    if (!st) { st = { parts: [], timer: null, firstAt: Date.now() }; pendingBatch.set(key, st) }
    st.parts.push({ sender: String(evt.senderName || evt.senderUid || ''), text })
    const win = coalesceMs()
    const starved = Date.now() - st.firstAt > win * 3
    const wait = starved ? 0 : win
    if (st.timer) clearTimeout(st.timer)
    st.timer = setTimeout(() => { void flushBatch(key) }, Math.max(wait, 100))
    if (typeof st.timer.unref === 'function') st.timer.unref()
  }

  async function flushBatch(key) {
    const st = pendingBatch.get(key)
    if (!st || !st.parts.length) return
    pendingBatch.delete(key)
    const parts = st.parts
    const route = resolveRoute(cfg, key)
    if (!route.target) { log(`合并的 ${parts.length} 条丢了：${key} 没有目标（${route.reason || route.via}）`); return }
    const target = await resolveTarget(route.target)
    if (!target.sessionId) { warn(`合并的 ${parts.length} 条留在原地：目标 ${route.target} 解析不到会话`); return }
    const text = parts.length === 1
      ? parts[0].text
      : `（${parts.length} 条连着来的，合并成一条）\n` + parts.map((p) => (p.sender ? `[${p.sender}] ` : '') + p.text).join('\n')
    try {
      await deliver(agentsSvc, target.sessionId, text, cfg.deliverMode)
      lastDeliveredAt.set(key, Date.now())
      log(`转发${parts.length > 1 ? `(${parts.length} 条合并)` : ''} ${key} → ${target.sessionId}`)
    } catch (err) {
      warn('合并转发失败（下轮再说）：', err?.message || err)
    }
  }

  // ── 「自己号」判定（2026-10-28，主人：指令执行完就该结束，别把结果又当消息转发出去）──
  // 症状：樱那边执行 /model -d，回复「部署默认模型 → …」；这条回复从桥上回来，
  //   鲸鱼娘那个实例把它当成「陌生人发来的消息」转发进了会话，模型只好回 [[SILENT]]。
  // 原因：两个实例互相把对方的号当普通用户。本机所有实例的号都登记进同一个全局集合，
  //   谁发的消息只要是自己号，一律不转发（连 fastUids 也不管）。
  function 自己号集合() {
    const set = (globalThis.__qqAdapterSelfUids ||= new Set())
    const add = (v) => {
      const s = String(v || '').trim()
      if (!s) return
      set.add(s)
      set.add(s.replace(/^u-/, ''))
    }
    try { add(cfg.selfUid) } catch { /* 没有就算了 */ }
    return set
  }
  自己号集合()

  function 是自己号(evt) {
    if (!evt) return false
    if (evt.isSelf === true) return true // 桥直接标了（自己发出去又被内核回调回来的回执）
    const uid = String(evt.senderUid || '').trim()
    if (!uid) return false
    const set = 自己号集合()
    return set.has(uid) || set.has(uid.replace(/^u-/, ''))
  }

  async function tick(reason) {
    if (!cfg.enabled || running) return
    // 运行时覆盖：设置页写到 home\qq-adapter\ui-config.json 的分流配置，每轮读一次（很便宜）
    try { Object.assign(cfg, pickRouting((await readOverride())[INST] || {})) } catch { /* 读不到就用原配置 */ }
    // 名单/映射/白名单里允许写 QQ 号，统一换成 uid 再比（幂等，转换结果会缓存）
    try {
      cfg.blocked = await Promise.all((cfg.blocked || []).map(normChatKey))
      cfg.allowed = await Promise.all((cfg.allowed || []).map(normChatKey))
      cfg.fastUids = await Promise.all((cfg.fastUids || []).map(normChatKey))
      cfg.mappings = await Promise.all((cfg.mappings || []).map(async (m) => ({ ...m, chat: await normChatKey(m.chat) })))
    } catch { /* 转不了就按原样 */ }
    running = true
    try {
      const r = await bridge.events(cursor)
      if (!r || r.ok === false) { warn('桥没回话：', r?.err || r?.raw || '空响应'); return }
      const next = Number(r.next) || 0
      const events = Array.isArray(r.events) ? r.events : []
      if (!started) {
        started = true
        if (cursor === 0 && next > 0 && cfg.skipBacklog !== false) {
          cursor = next
          log('启动跳过积压的 ' + next + ' 条（skipBacklog）')
          await saveSeen()
          return
        }
      }
      if (next < cursor) { cursor = 0; log('桥的收件箱被重启过，游标归零') }
      cursor = next

      let handled = 0
      for (const evt of events) {
        if (handled >= cfg.maxPerTick) break
        const msgId = String(evt?.msgId || '')
        if (!msgId || seenSet.has(msgId)) continue
        const key = chatKeyOf(evt)
        // 记住「每个聊天最近一条进来的消息」——qq_reply 不传 msgId 时就用它，
        // 别去翻历史挑一条（翻出来的可能是自己刚发的）
        try {
          const box = (globalThis.__qqLastInbound ||= new Map())
          box.set(key, { msgId, msgSeq: String(evt.msgSeq ?? ''), time: Number(evt.time) || Date.now(), senderUid: String(evt.senderUid || '') })
        } catch { /* 记不住就算了 */ }
        // 指令：以 / 开头的行**一律**由插件自己处理，绝不透传给会话。
        //   认识的执行、不认识的回「未知指令」——反正不进会话（主人 2026-10-28 的原话）
        // ⚠ 这一步必须排在「路由」和「自己号过滤」前面：
        //   · 排在路由后面时，聊天没配目标 / 目标解析不到会话 → 指令被悄悄跳过不执行 ✗
        //   · 排在自己号后面时，从另一个号（樱 ↔ 鲸鱼娘）发来的指令会被当成「自己人」丢掉 ✗
        if (cfg.commandsEnabled !== false) {
          const parsed = parseCommand(evt.text)
          if (parsed) {
            seenSet.add(msgId)
            handled++
            try { await runCommand(evt, key, parsed) } catch (err) { warn('指令 ' + parsed.name + ' 执行失败：', err?.message || err) }
            continue
          }
        }
        // 自己号发的**普通消息**（包括刚发出去又被内核回调回来的回执）→ 丢掉，不转发。
        // 2026-10-28 主人：「指令执行完就结束了，不应该真的转发给对方」
        //   樱执行 /model -d 的回复就是这么绕回鲸鱼娘会话里的，模型只好回 [[SILENT]] ✗
        if (是自己号(evt) || (cfg.selfUid && String(evt.senderUid || '') === cfg.selfUid)) {
          seenSet.add(msgId)
          handled++
          log(`跳过自己号发的消息（${key || '?'}${evt?.isSelf ? ' · 桥标了 isSelf' : ''}）`)
          continue
        }
        const route = resolveRoute(cfg, key)
        if (!route.target) {
          log(`跳过 ${key || '?'}（${route.reason || route.via}）`)
          seenSet.add(msgId)
          continue
        }
        const target = await resolveTarget(route.target)
        if (!target.sessionId) {
          warn(`转发目标 ${route.target} 解析不到会话（${target.reason || '未知'}），这条留在原地`)
          continue
        }
        const text = formatIncoming(evt)
        // 流量控制：太频繁就先攒着，别一条一条砸进会话
        if (trafficLimited(key)) {
          queueBatch(key, evt, text)
          seenSet.add(msgId)
          handled++
          log(`暂存 ${key}（静默 ${cfg.coalesceSeconds}s 后合并发）`)
          continue
        }
        try {
          await deliver(agentsSvc, target.sessionId, text, cfg.deliverMode)
          seenSet.add(msgId)
          handled++
          lastDeliveredAt.set(key, Date.now())
          log(`转发 ${key} → ${target.sessionId}（${route.via}${target.via === 'preset' ? ':预设 ' + target.preset : ''}）`)
        } catch (err) {
          warn('转发 ' + key + ' 失败（下轮再试）：', err?.message || err)
        }
      }
      if (handled || events.length) await saveSeen()
    } catch (err) {
      warn('轮询失败（' + reason + '）：', err?.message || err)
    } finally {
      running = false
    }
  }

  // 同一份插件可能被 loader 重复 apply（配置改动时），把上一个实例的定时器掐掉，
  // 否则会出现「两个实例各转一份、还用着旧配置」的怪现象。
  const g = globalThis
  if (typeof g.__qqAdapterCleanup === 'function') {
    try { g.__qqAdapterCleanup() } catch { /* 清理失败无所谓 */ }
  }
  const every = Math.max(500, Number(cfg.pollMs) || 1500)
  const timer = setInterval(() => void tick('定时'), every)
  if (typeof timer.unref === 'function') timer.unref()
  const shellTimer = setInterval(() => void ensureShell(), 15000)
  if (typeof shellTimer.unref === 'function') shellTimer.unref()
  void ensureShell()
  void tick('启动')

  try {
    const cleanup = () => {
      clearInterval(timer)
      clearInterval(shellTimer)
      for (const st of pendingBatch.values()) { try { if (st.timer) clearTimeout(st.timer) } catch { } }
      pendingBatch.clear()
    }
    g[cleanupKey] = cleanup
    ctx.on('dispose', cleanup)
  } catch { /* 收摊失败无所谓 */ }

  // ── 工具 ──
  let defineTool = (spec) => spec
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (mod && typeof mod.defineTool === 'function') defineTool = mod.defineTool
  } catch { /* 自测环境没有宿主包 */ }

  try {
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    ctx.tools.register(defineTool({
      name: TP('qq_send'),
      description: '用自己 QQ 号发一条消息。chat 写成 u-<uid> 或 g-<群号>（和自己号发的消息用同一个标识）。',
      parameters: {
        chat: { type: 'string', description: 'u-<uid> 私聊 / g-<群号> 群聊', required: true },
        text: { type: 'string', description: '要发的文字', required: true },
        at: { type: 'string', description: '可选：要 @ 的 uid（群里用，u- 开头也可以）' },
        atNick: { type: 'string', description: '可选：@ 时显示的名字' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
      },
      async execute(args) {
        const key = String(args.chat || '').trim()
        const isGroup = key.startsWith('g-') || key.startsWith('G-')
        const peerUid = key.replace(/^[ugUG][-_]/, '')
        if (!peerUid) throw new Error('chat 得写成 u-<uid> 或 g-<群号>')
        const at = String(args.at || '').replace(/^u-/, '')
        const r = await bridge.send(isGroup ? 2 : 1, peerUid, String(args.text ?? ''), at, String(args.atNick || ''))
        return { ok: r?.ok === true, result: r?.result ?? null, err: r?.err ?? null, chat: key }
      },
    }))

    ctx.tools.register(defineTool({
      name: TP('qq_history'),
      description: '翻聊天记录（私聊和群聊都行）。chat 写成 u-<uid> 或 g-<群号>，count 最多 100；seq 可选，从某条消息往前翻。',
      parameters: {
        chat: { type: 'string', description: 'u-<uid> 私聊 / g-<群号> 群聊', required: true },
        count: { type: 'number', description: '拉多少条（默认 20，最多 100）' },
        seq: { type: 'string', description: '可选：从这条消息序号往前翻' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
      },
      async execute(args) {
        const key = String(args.chat || '').trim()
        const isGroup = key.startsWith('g-') || key.startsWith('G-')
        const peerUid = key.replace(/^[ugUG][-_]/, '')
        if (!peerUid) throw new Error('chat 得写成 u-<uid> 或 g-<群号>')
        const r = await bridge.history(isGroup ? 2 : 1, peerUid, args.count ?? 20, args.seq ?? '')
        return { ok: r?.ok === true, count: r?.count ?? 0, messages: r?.messages ?? [], err: r?.err ?? null }
      },
    }))

    ctx.tools.register(defineTool({
      name: TP('qq_send_image'),
      description: '用自己 QQ 号发一张本地图片。chat 写成 u-<uid> 或 g-<群号>，path 是本地图片绝对路径。',
      parameters: {
        chat: { type: 'string', description: 'u-<uid> 私聊 / g-<群号> 群聊', required: true },
        path: { type: 'string', description: '本地图片绝对路径', required: true },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
      },
      async execute(args) {
        const key = String(args.chat || '').trim()
        const isGroup = key.startsWith('g-') || key.startsWith('G-')
        const peerUid = key.replace(/^[ugUG][-_]/, '')
        if (!peerUid) throw new Error('chat 得写成 u-<uid> 或 g-<群号>')
        const r = await bridge.sendImage(isGroup ? 2 : 1, peerUid, String(args.path || ''))
        return { ok: r?.ok === true, result: r?.result ?? null, err: r?.err ?? null, chat: key }
      },
    }))

    ctx.tools.register(defineTool({
      name: TP('qq_send_file'),
      description: '用自己 QQ 号发一个本地文件。chat 写成 u-<uid> 或 g-<群号>，path 是本地文件绝对路径。',
      parameters: {
        chat: { type: 'string', description: 'u-<uid> 私聊 / g-<群号> 群聊', required: true },
        path: { type: 'string', description: '本地文件绝对路径', required: true },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
      },
      async execute(args) {
        const key = String(args.chat || '').trim()
        const isGroup = key.startsWith('g-') || key.startsWith('G-')
        const peerUid = key.replace(/^[ugUG][-_]/, '')
        if (!peerUid) throw new Error('chat 得写成 u-<uid> 或 g-<群号>')
        const r = await bridge.sendFile(isGroup ? 2 : 1, peerUid, String(args.path || ''))
        return { ok: r?.ok === true, result: r?.result ?? null, err: r?.err ?? null, chat: key }
      },
    }))

    ctx.tools.register(defineTool({
      name: TP('qq_send_voice'),
      description: '用自己 QQ 号发一条语音。chat 写成 u-<uid> 或 g-<群号>；path 可以是任意音频（wav/mp3/amr/silk），不是 silk 会先本地编码；duration 不填就按音频长度算。',
      parameters: {
        chat: { type: 'string', description: 'u-<uid> 私聊 / g-<群号> 群聊', required: true },
        path: { type: 'string', description: '音频文件绝对路径（wav/mp3/amr/silk 都行）', required: true },
        duration: { type: 'number', description: '可选：时长（秒），不填自动算' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
      },
      async execute(args) {
        const key = String(args.chat || '').trim()
        const isGroup = key.startsWith('g-') || key.startsWith('G-')
        const peerUid = key.replace(/^[ugUG][-_]/, '')
        if (!peerUid) throw new Error('chat 得写成 u-<uid> 或 g-<群号>')
        const src = String(args.path || '')
        const silk = await toSilk(src, { ffmpegPath: cfg.ffmpegPath, silkEncoderPath: cfg.silkEncoderPath })
        const duration = Number(args.duration) || silk.duration || 0
        const r = await bridge.sendVoice(isGroup ? 2 : 1, peerUid, silk.silkPath, duration)
        await cleanupSilk(silk)
        return {
          ok: r?.ok === true, result: r?.result ?? null, err: r?.err ?? null, chat: key,
          converted: silk.converted, duration, silkPath: silk.silkPath,
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: TP('qq_reply'),
      description: '用自己 QQ 号引用某条消息回复。chat 写成 u-<uid> 或 g-<群号>；msgId 是那条消息的 msgId（可以不填，默认引用对方最近一条）；text 是要说的话。',
      parameters: {
        chat: { type: 'string', description: 'u-<uid> 私聊 / g-<群号> 群聊', required: true },
        text: { type: 'string', description: '要发的内容', required: true },
        msgId: { type: 'string', description: '可选：被引用消息的 msgId' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
      },
      async execute(args) {
        const key = String(args.chat || '').trim()
        const isGroup = key.startsWith('g-') || key.startsWith('G-')
        const peerUid = key.replace(/^[ugUG][-_]/, '')
        if (!peerUid) throw new Error('chat 得写成 u-<uid> 或 g-<群号>')
        const last = globalThis.__qqLastInbound?.get(key) || null
        const msgId = String(args.msgId || last?.msgId || '')
        const meta = !args.msgId && last ? { seq: last.msgSeq, time: last.time, senderUid: last.senderUid } : {}
        const r = await bridge.reply(isGroup ? 2 : 1, peerUid, msgId, String(args.text ?? ''), meta)
        return { ok: r?.ok === true, result: r?.result ?? null, err: r?.err ?? null, chat: key, msgId }
      },
    }))

    ctx.tools.register(defineTool({
      name: TP('qq_status'),
      description: '看 QQ 桥的状态：登录没登录、session/msgService 好没好、收件箱里排了几条。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
      },
      async execute() {
        const s = await bridge.status()
        return { ok: s?.ok === true, status: s }
      },
    }))
  }
  } catch (err) { warn('注册工具失败（不影响分流）：', err?.message || err) }
}

export const _internal = { resolveTarget, deliver, SOURCE_KIND }
