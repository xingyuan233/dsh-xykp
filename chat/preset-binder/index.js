// dsh-xykp · chat/preset-binder
//
// 维护一张「预设 → 会话」的实时表：
//   <DSH_HOME>/storages/preset-binder.json
//
// 每个会话记：标题、提供方/模型、这轮对话开始没/结束没、起止时间、轮数、
// token 用量（未缓存输入 / 缓存读取 / 缓存写入 / 输出 / 合计）、上下文占用。
// 这些数不是去读会话文件：token/上下文/模型选择都是 DSH 的 session projection，
// 直接从内存拿，随用随查。
//
// 表只记账，不拦消息；出错只记日志。
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readTable, writeTable, noteSession } from './table.js'

export const name = 'preset-binder'
export const inject = ['agents', 'agentPresets']

const PREFIX = '[preset-binder]'
const log = (...args) => console.log(PREFIX, ...args)
const warn = (...args) => console.warn(PREFIX, ...args)

const DEFAULT_IGNORE = ['standard', 'ptc', 'minimal', 'cordis']

export function apply(ctx, config = {}) {
  void boot(ctx, config).catch((err) => warn('启动失败（已忽略）：', err?.stack || err))
}

async function boot(ctx, config) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const tablePath = config.tablePath || join(home, 'storages', 'preset-binder.json')
  const ignore = new Set(config.ignore?.length ? config.ignore : DEFAULT_IGNORE)
  const track = new Set(config.track || [])
  const maxSessions = Number.isFinite(config.maxSessions) ? config.maxSessions : 30
  const refreshMs = Number.isFinite(config.refreshMs) ? config.refreshMs : 3000

  let table = readTable(tablePath)
  const presetNames = new Map()
  let saveTimer = null
  let saving = Promise.resolve()

  const scheduleSave = () => {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      const snapshot = table
      saving = saving
        .then(() => writeTable(tablePath, snapshot))
        .catch((err) => warn('写表失败：', err?.message || err))
    }, 150)
    if (typeof saveTimer.unref === 'function') saveTimer.unref()
  }

  const proj = (agent, key) => {
    try {
      const registry = ctx.get('sessionProjections')
      if (!registry || !agent.session) return undefined
      return registry.stateOf(agent.session, key)
    } catch (error) {
      return undefined
    }
  }

  async function refreshPresetNames() {
    try {
      for (const preset of await ctx.agentPresets.list()) presetNames.set(preset.id, preset.name || '')
    } catch (error) {}
  }

  function record(agent, why) {
    try {
      const preset = ctx.agentPresets.composedPreset(agent.ctx)
      if (!preset) return
      if (ignore.has(preset)) return
      if (track.size && !track.has(preset)) return
      const sid = String(agent.session?.id || agent.id || '')
      if (!sid) return

      const row = table.presets?.[preset]
      const prev = row?.sessions?.[sid] || {}
      const nowIso = new Date().toISOString()
      const running = agent.status === 'running'
      const meta = proj(agent, 'sessionListMetadata')
      const usage = proj(agent, 'tokenUsage')
      const pressure = proj(agent, 'contextPressure')
      const stats = proj(agent, 'sessionStats')
      const title = proj(agent, 'title')
      const selection = proj(agent, 'modelSelection')

      const buckets = usage?.totals
      const tokens = buckets
        ? {
            uncachedInput: buckets.uncachedInputTokens,
            cacheRead: buckets.cacheReadTokens,
            cacheWrite: buckets.cacheWriteTokens,
            output: buckets.outputTokens,
            total:
              buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens + buckets.outputTokens,
          }
        : prev.tokens || null

      const context = pressure
        ? {
            window: pressure.contextWindow ?? null,
            pressureTokens: pressure.projectedTokens ?? pressure.pressureTokens ?? null,
          }
        : prev.context || null

      const lastPromptIso = meta?.lastPromptAt ? new Date(meta.lastPromptAt).toISOString() : ''
      const startedAt = running ? (prev.running && prev.startedAt ? prev.startedAt : nowIso) : prev.startedAt || null
      const endedAt = running ? null : prev.running ? nowIso : prev.endedAt || null
      const lastActivityAt = why === 'inbox' ? nowIso : lastPromptIso || prev.lastActivityAt || nowIso

      const wasActive = row?.active
      table = noteSession(
        table,
        preset,
        sid,
        {
          title: title || prev.title || '',
          provider: agent.options?.provider || selection?.lastUsed?.provider || prev.provider || '',
          model: agent.options?.model || selection?.lastUsed?.model || prev.model || '',
          running,
          startedAt,
          endedAt,
          lastActivityAt,
          turns: stats?.turns ?? prev.turns ?? 0,
          tokens,
          context,
        },
        { maxSessions, presetName: presetNames.get(preset) || '' },
      )
      const active = table.presets[preset]?.active
      if (active && active !== wasActive) log(`${preset} 的活跃会话 -> ${active}`)
      scheduleSave()
    } catch (err) {
      warn('记会话失败：', err?.message || err)
    }
  }

  const watched = new Set()
  const watch = (agent) => {
    if (!agent || watched.has(agent)) return
    watched.add(agent)
    try {
      agent.ctx.on('agent/inbox/inserted', () => record(agent, 'inbox'))
      agent.ctx.on('agent/status', () => record(agent, 'status'))
      agent.ctx.on('agent/disposed', () => record(agent, 'disposed'))
      agent.ctx.on('dispose', () => watched.delete(agent))
    } catch (err) {
      warn('挂监听失败：', err?.message || err)
    }
    record(agent, 'init')
  }

  ctx.on('agent/created', (payload) => {
    try {
      watch(payload?.agent)
    } catch (err) {
      warn('处理 agent/created 失败：', err?.message || err)
    }
  })

  await refreshPresetNames()
  try {
    for (const agent of ctx.agents.list()) watch(agent)
  } catch (err) {
    warn('读现有 agent 失败：', err?.message || err)
  }

  // 兜底：补挂新 agent；跑着的会话隔几秒刷一次 token
  let ticks = 0
  const timer = setInterval(() => {
    ticks++
    try {
      for (const agent of ctx.agents.list()) {
        watch(agent)
        if (agent.status === 'running') record(agent, 'refresh')
      }
      if (ticks % 10 === 0) void refreshPresetNames()
    } catch (error) {}
  }, refreshMs)
  if (typeof timer.unref === 'function') timer.unref()

  ctx.on('dispose', () => {
    clearInterval(timer)
    if (saveTimer) clearTimeout(saveTimer)
    try {
      void saving.then(() => writeTable(tablePath, table))
    } catch (error) {}
  })

  log(
    `就绪：表在 ${tablePath}，忽略 ${[...ignore].join('/')}${track.size ? `，只跟 ${[...track].join('/')}` : ''}`,
  )
}
