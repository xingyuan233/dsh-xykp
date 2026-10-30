// dsh-session-archiver · 宿主半边
//
// 需求（任务-2026-10-27.md 第三节）：
//   1. 启动跑一次 + 每 12 小时一次（异步，不阻塞主线程）
//   2. 扫描范围固定：<DSH_HOME>/sessions 下登记的会话
//   3. 跳过整个工作区（ignoreWorkspaces，默认写入 alive-workspace）
//   4. 跳过会话名 / session id（ignoreSessions，支持通配符）
//   5. 距上次活动超过 idleDays（默认 3 天）→ 归档
//   6. 归档走宿主自己的 ctx.workspaceRegistry.archiveSession（不自己改文件）
//   7. 任何错误只记日志，绝不拖死宿主
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export const name = 'session-archiver'
export const inject = ['workspaceRegistry', 'timer']

const PREFIX = '[session-archiver]'
const log = (...a) => console.log(PREFIX, ...a)
const warn = (...a) => console.warn(PREFIX, ...a)

const DEFAULTS = {
  // 这些工作区里的会话一律不自动归档（名字或路径都认）
  ignoreWorkspaces: ['alive-workspace'],
  // 会话名 / session id，支持通配符（如 test-*）和正则（re:^onebot-）
  ignoreSessions: [],
  // 预设 id / 预设名，同样支持通配符和正则（re:^alive$）
  ignorePresets: [],
  // 距上次活动超过几天就归档
  idleDays: 3,
  intervalHours: 12,
  dryRun: false,
  // 会话落盘根目录，空 = <DSH_HOME>/sessions
  sessionsRoot: '',
}

const globToRe = (g) =>
  new RegExp('^' + String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')

function matcherOf(pattern) {
  const p = String(pattern || '').trim()
  if (!p) return null
  try {
    if (p.startsWith('re:')) return new RegExp(p.slice(3), 'i')
    return globToRe(p)
  } catch {
    return null
  }
}

const hitAny = (name, matchers) => matchers.some((re) => re && re.test(name))

const yieldNow = () => new Promise((r) => setImmediate(r))

// DSH_HOME 是数据根目录（里面还有 storages / profiles / sessions …），会话在其下的 sessions 子目录
const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')

function rootOf(cfg) {
  const custom = String(cfg.sessionsRoot || '').trim()
  return custom ? custom : join(dshHome(), 'sessions')
}

/**
 * 会话标题 / 预设：宿主把这两样都投影缓存在
 * <DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json 里。
 * 只读、拿不到就当没有（标题空、预设空），坏缓存不影响归档。
 */
async function collectSessionMeta() {
  const out = new Map()
  const dir = join(dshHome(), 'storages', 'session_projcache', 'sessions')
  let files
  try {
    files = await readdir(dir)
  } catch {
    return out
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const raw = JSON.parse(await readFile(join(dir, file), 'utf8'))
      const rows = raw?.record?.rows || {}
      out.set(file.slice(0, -5), {
        title: typeof rows.title?.val === 'string' ? rows.title.val : '',
        preset: typeof rows.agentPreset?.val === 'string' ? rows.agentPreset.val : '',
      })
    } catch {
      /* 坏缓存当没有 */
    }
  }
  return out
}

/**
 * 预设 id → 预设名：<DSH_HOME>/profiles/<profile>/presets/<id>/preset.yml，
 * 目录名就是 id，顶层 name: 是展示名（千歌 这种）。
 */
async function collectPresetNames() {
  const names = new Map()
  const root = join(dshHome(), 'profiles')
  let profiles
  try {
    profiles = await readdir(root)
  } catch {
    return names
  }
  for (const profile of profiles) {
    let dirs
    try {
      dirs = await readdir(join(root, profile, 'presets'))
    } catch {
      continue
    }
    for (const dir of dirs) {
      try {
        const text = await readFile(join(root, profile, 'presets', dir, 'preset.yml'), 'utf8')
        const id = /^id:\s*(.+)$/m.exec(text)?.[1]?.trim() || dir
        const label = (/^name:\s*(.+)$/m.exec(text)?.[1] || '').trim().replace(/^['"]|['"]$/g, '')
        if (!names.has(id)) names.set(id, label)
      } catch {
        /* 没 preset.yml 就用文件夹名 */
      }
    }
  }
  return names
}

/**
 * 扫 <sessionsRoot>，建 sessionId → 最后活动时间（毫秒）。
 * 落盘布局：<root>/<workspace-key>/<sessionId>/session*.jsonl(.zstd)
 */
export async function collectActivity(cfgInput = {}) {
  const cfg = { ...DEFAULTS, ...(cfgInput && typeof cfgInput === 'object' ? cfgInput : {}) }
  const root = rootOf(cfg)
  const out = new Map()
  let groups = []
  try {
    groups = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const g of groups) {
    if (!g.isDirectory()) continue
    const groupDir = join(root, g.name)
    let sessions = []
    try {
      sessions = await readdir(groupDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      const sessionDir = join(groupDir, s.name)
      let files = []
      try {
        files = await readdir(sessionDir, { withFileTypes: true })
      } catch {
        continue
      }
      let newest = 0
      for (const f of files) {
        if (!f.isFile()) continue
        if (!/^session.*\.(jsonl|zstd|jsonl\.zstd)$/i.test(f.name)) continue
        const st = await stat(join(sessionDir, f.name)).catch(() => null)
        if (st && st.mtimeMs > newest) newest = st.mtimeMs
      }
      if (newest) out.set(s.name, newest)
    }
    await yieldNow()
  }
  return out
}

/**
 * 纯逻辑：给定工作区表、已归档集合、活动时间，算出这一轮该归档谁。
 * 抽出来是为了能脱离宿主自测。
 */
export function plan(workspaces, archivedIds, cfgInput, activityOf, titleOf = () => '', presetOf = () => ({})) {
  const cfg = { ...DEFAULTS, ...(cfgInput && typeof cfgInput === 'object' ? cfgInput : {}) }
  const archived = new Set(archivedIds || [])
  const wsMatchers = (cfg.ignoreWorkspaces || []).map(matcherOf)
  const sMatchers = (cfg.ignoreSessions || []).map(matcherOf)
  const pMatchers = (cfg.ignorePresets || []).map(matcherOf)
  const cutoff = Date.now() - Math.max(0, Number(cfg.idleDays) || 0) * 86400000

  const keep = []
  const toArchive = []
  for (const ws of workspaces || []) {
    const wsName = String(ws.title || '')
    const wsPath = String(ws.path || '')
    if (hitAny(wsName, wsMatchers) || hitAny(basename(wsPath), wsMatchers) || hitAny(wsPath, wsMatchers)) {
      keep.push({ id: null, reason: 'workspace', workspace: wsName })
      continue
    }
    for (const id of ws.sessionIds || []) {
      if (archived.has(id)) {
        keep.push({ id, reason: 'already-archived', workspace: wsName })
        continue
      }
      const title = String(titleOf(id) || '')
      if (hitAny(id, sMatchers) || hitAny(title, sMatchers)) {
        keep.push({ id, reason: 'ignored', workspace: wsName })
        continue
      }
      if (pMatchers.length) {
        const preset = presetOf(id) || {}
        const presetId = String(preset.id || '')
        const presetName = String(preset.name || '')
        // 预设不明时保守跳过：配置了「跳过预设」就绝不误伤
        if (!presetId) {
          keep.push({ id, reason: 'preset-unknown', workspace: wsName })
          continue
        }
        if (hitAny(presetId, pMatchers) || hitAny(presetName, pMatchers)) {
          keep.push({ id, reason: 'ignored-preset', workspace: wsName })
          continue
        }
      }
      const last = activityOf(id)
      if (!last) {
        keep.push({ id, reason: 'no-activity-time', workspace: wsName })
        continue
      }
      if (last > cutoff) {
        keep.push({ id, reason: 'active-recently', workspace: wsName })
        continue
      }
      toArchive.push({ id, workspace: wsName, last })
    }
  }
  return { toArchive, keep }
}

async function runOnce(registry, cfg) {
  const workspaces = registry.list()
  const archivedIds = registry.archivedSessionIds
  const activity = await collectActivity(cfg)
  const meta = await collectSessionMeta()
  const presetNames = await collectPresetNames()
  const liveOf = (id) => {
    try {
      return registry.ctx?.sessions?.get?.(id) || null
    } catch {
      return null
    }
  }
  const titleOf = (id) => {
    const cached = meta.get(id)?.title
    if (cached) return cached
    const live = liveOf(id)
    return (live && (live.title || live.name || live.header?.title)) || ''
  }
  const presetOf = (id) => {
    const live = liveOf(id)
    const preset =
      meta.get(id)?.preset || String(live?.header?.agentPreset || live?.agentPreset || '') || ''
    return { id: preset, name: presetNames.get(preset) || '' }
  }
  const { toArchive, keep } = plan(workspaces, archivedIds, cfg, (id) => activity.get(id), titleOf, presetOf)
  let done = 0
  let failed = 0
  for (const item of toArchive) {
    if (cfg.dryRun) {
      log(`[dry] 会归档 ${item.id}（${item.workspace}，最后活动 ${new Date(item.last).toISOString()}）`)
      done++
      continue
    }
    try {
      // stopActivity: false —— 活着的会话由宿主自己拒绝（WorkspaceActiveSessionError），我们只跳过
      await registry.archiveSession(item.id)
      done++
    } catch (err) {
      failed++
      if (String(err?.name || '').includes('ActiveSession')) {
        log(`跳过 ${item.id}：还在活动（宿主拒绝归档）`)
      } else {
        warn(`归档 ${item.id} 失败：`, err?.message || err)
      }
    }
    await yieldNow()
  }
  return { scanned: workspaces.length, archived: done, failed, dryRun: Boolean(cfg.dryRun), toArchive: toArchive.length, keep }
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  const registry = ctx.workspaceRegistry
  const run = async (label) => {
    if (!registry) {
      warn(`${label} 跳过：拿不到 workspaceRegistry`)
      return
    }
    try {
      const r = await runOnce(registry, cfg)
      const why = {}
      for (const item of r.keep) if (item?.reason) why[item.reason] = (why[item.reason] || 0) + 1
      const detail = Object.entries(why).map(([k, v]) => `${k}=${v}`).join(', ')
      log(`${label}：${r.toArchive} 个候选，归档 ${r.archived} 个，跳过 ${r.keep.length} 条${detail ? `（${detail}）` : ''}${r.dryRun ? '（dryRun）' : ''}`)
    } catch (err) {
      warn(`${label} 失败（已忽略）：`, err?.stack || err)
    }
  }
  void run('启动检查')

  const hours = Math.max(1, Number(cfg.intervalHours) || DEFAULTS.intervalHours)
  const timer = setInterval(() => void run('定时检查'), hours * 3600000)
  if (typeof timer.unref === 'function') timer.unref()
  try {
    ctx.on('dispose', () => clearInterval(timer))
  } catch {
    /* 收摊失败无所谓 */
  }
}

// 自测用
export const _internal = {
  plan,
  collectActivity,
  collectSessionMeta,
  collectPresetNames,
  matcherOf,
  rootOf,
  dshHome,
  DEFAULTS,
}
