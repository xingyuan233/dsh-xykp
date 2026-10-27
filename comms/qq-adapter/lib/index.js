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
  pollMs: Schema.number().default(1500).description('轮询间隔（毫秒）'),
  maxPerTick: Schema.number().default(10).description('一次最多转发几条'),
  seenPath: Schema.string().default('').description('去重记录文件（空 = <DSH_HOME>/qq-adapter/seen.json）'),
  skipBacklog: Schema.boolean().default(true).description('启动时不补发桥里积压的旧消息'),
  autoStartShell: Schema.boolean().default(true).description('桥没在跑时自动拉起 QQ shell'),
  shellBootPath: Schema.string().default('D:\\\\Program-Files\\\\QQ-shell\\\\NapCatWinBootMain.exe').description('shell 启动器路径'),
  shellDir: Schema.string().default('D:\\\\Program-Files\\\\QQ-shell').description('shell 工作目录'),
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

async function deliver(agentsSvc, sessionId, text) {
  const agent = findAgent(agentsSvc, sessionId)
  if (!agent) throw new Error('会话 ' + sessionId + ' 找不到了（可能被归档/删了）')
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND },
  })
  await agent.followup(message)
  return { delivered: true, via: 'followup' }
}

export async function apply(ctx, config = {}) {
  const cfg = { ...ROUTER_DEFAULTS, ...Config(config) }
  const bridge = createBridge(cfg.bridgeUrl, { timeoutMs: 4000 })
  // 在 apply（还活着）的时候就把 agents 抓住，定时器里不再碰 ctx
  const agentsSvc = ctx.agents
  const seenFile = () => cfg.seenPath || join(home(), 'qq-adapter', 'seen.json')

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
  async function ensureShell() {
    if (cfg.autoStartShell === false) return
    try {
      const st = await bridge.status()
      if (st && st.ok) return
    } catch { /* 连不上，往下走 */ }
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
  async function tick(reason) {
    if (!cfg.enabled || running) return
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
        try {
          await deliver(agentsSvc, target.sessionId, text)
          seenSet.add(msgId)
          handled++
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
    const cleanup = () => { clearInterval(timer); clearInterval(shellTimer) }
    g.__qqAdapterCleanup = cleanup
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
      name: 'qq_send',
      description: '用自己 QQ 号发一条消息。chat 写成 u-<uid> 或 g-<群号>（和自己号发的消息用同一个标识）。',
      parameters: {
        chat: { type: 'string', description: 'u-<uid> 私聊 / g-<群号> 群聊', required: true },
        text: { type: 'string', description: '要发的文字', required: true },
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
        const r = await bridge.send(isGroup ? 2 : 1, peerUid, String(args.text ?? ''))
        return { ok: r?.ok === true, result: r?.result ?? null, err: r?.err ?? null, chat: key }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'qq_status',
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
