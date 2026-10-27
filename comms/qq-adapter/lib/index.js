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

export const name = 'qq-adapter'

/** 必须先拿到 agents（推消息进会话）；tools 没有也能跑（自测环境） */
export const inject = ['agents', 'tools']

/** 这条 user/message 的来源（宿主要求每条消息都有 source.kind） */
export const SOURCE_KIND = 'plugin:qq-adapter'

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

  async function tick(reason) {
    if (!cfg.enabled || running) return
    // 运行时覆盖：设置页写到 home\qq-adapter\ui-config.json 的分流配置，每轮读一次（很便宜）
    try { Object.assign(cfg, pickRouting((await readOverride())[INST] || {})) } catch { /* 读不到就用原配置 */ }
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
        if (cfg.selfUid && String(evt.senderUid || '') === cfg.selfUid) continue

        const key = chatKeyOf(evt)
        // 记住「每个聊天最近一条进来的消息」——qq_reply 不传 msgId 时就用它，
        // 别去翻历史挑一条（翻出来的可能是自己刚发的）
        try {
          const box = (globalThis.__qqLastInbound ||= new Map())
          box.set(key, { msgId, msgSeq: String(evt.msgSeq ?? ''), time: Number(evt.time) || Date.now(), senderUid: String(evt.senderUid || '') })
        } catch { /* 记不住就算了 */ }
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
