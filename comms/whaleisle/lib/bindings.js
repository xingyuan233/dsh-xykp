// whaleisle · 运行期绑定与预设池
//
// 绑定数据放 <DSH_HOME>/xykp/whaleisle/bindings.json（插件自己维护，跟 config.yml 的「人的意图」分开）：
//   { "u-xingyuan": { "target": "p-alive", "updatedAt": 179... }, "g-c-xxx": { "target": "s-abc" } }
//
// 预设池读 preset-binder 的 preset-binder.json：presets.<名>.active 就是该预设当前挂着的会话。

import { mkdir, readFile, readdir, stat, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export function homeDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function dataDir() {
  return join(homeDir(), 'xykp', 'whaleisle')
}

export function bindingsPath() {
  return join(dataDir(), 'bindings.json')
}

export function statePath() {
  return join(dataDir(), 'state.json')
}

/** 旧插件（whaleisle）的数据目录，用来做一次性迁移 */
export function legacyDir() {
  return join(homeDir(), 'xykp', 'whaleisle')
}

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, path)
}

/**
 * 配置只有 config.yml 一份：账号绑定（target / workspace / preset）就存在它的 accounts[] 里。
 * 插件 apply 时把 cfg 喂进来，读绑定就从这里拼，不再维护第二份静态配置。
 */
let bindingCfg = null

export function useConfigAsBindings(cfg) {
  bindingCfg = cfg || null
}

function accountsOf() {
  return bindingCfg && Array.isArray(bindingCfg.accounts) ? bindingCfg.accounts : []
}

export async function readBindings() {
  const map = {}
  for (const a of accountsOf()) {
    if (!a || !a.name) continue
    if (a.target) map[`acct:${a.name}`] = { target: String(a.target), updatedAt: 0 }
    if (a.workspace) map[`ws:${a.name}`] = { target: String(a.workspace), updatedAt: 0 }
    if (a.preset) map[`newpreset:${a.name}`] = { target: String(a.preset), updatedAt: 0 }
  }
  // 一次性兼容：config.yml 里还没填的，回落到旧的 bindings.json（迁完就可以删那个文件）
  const legacy = await readJson(bindingsPath(), {})
  if (legacy && typeof legacy === 'object') {
    for (const [k, v] of Object.entries(legacy)) {
      if (!map[k] && v && v.target) map[k] = v
    }
  }
  return map
}

/** 把整份配置写回 config.yml（宿主控制台接口，保存后会热重载这一行） */
async function saveConfig(cfg) {
  const base = `http://127.0.0.1:${process.env.DSH_PORT || 3080}`
  const resp = await fetch(`${base}/xykp-console/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'whaleisle', config: cfg }),
  })
  if (!resp.ok) throw new Error(`保存 config.yml 失败：HTTP ${resp.status}`)
}

export async function writeBinding(chatKey, target) {
  const key = String(chatKey || '').trim()
  if (!key) return readBindings()
  const m = /^(acct|ws|newpreset):(.+)$/.exec(key)
  const acct = m ? accountsOf().find((a) => a && a.name === m[2]) : null
  if (acct) {
    const value = String(target || '').trim()
    if (m[1] === 'acct') acct.target = value
    else if (m[1] === 'ws') acct.workspace = value
    else acct.preset = value
    await saveConfig(bindingCfg)
    return readBindings()
  }
  // 账号级以外的 key（正常不该有）：留在运行时小文件里，不算配置
  const all = (await readJson(bindingsPath(), {})) || {}
  if (!target) delete all[key]
  else all[key] = { target: String(target).trim(), updatedAt: Date.now() }
  await writeJson(bindingsPath(), all)
  return readBindings()
}

/** 预设池：预设名 → { active: <会话id>, sessions: {id: ...} } */
export async function presetPools() {
  const json = await readJson(join(homeDir(), 'xykp', 'preset-binder', 'preset-binder.json'), null)
  const presets = (json && json.presets) || {}
  const out = new Map()
  for (const [name, pool] of Object.entries(presets)) {
    out.set(String(name), {
      active: String((pool && pool.active) || ''),
      sessions: Object.keys((pool && pool.sessions) || {}),
    })
  }
  return out
}

/** 预设名 → 当前活跃会话 id（没有就空串） */
export async function presetActive(name) {
  const pools = await presetPools()
  const pool = pools.get(String(name || '').trim())
  return pool ? pool.active : ''
}

export function newSessionId(prefix = 'isle') {
  const d = new Date()
  const ymd = String(d.getFullYear())
    + String(d.getMonth() + 1).padStart(2, '0')
    + String(d.getDate()).padStart(2, '0')
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'
  let tail = ''
  for (let i = 0; i < 4; i += 1) tail += alphabet[Math.floor(Math.random() * alphabet.length)]
  return `${prefix}-${ymd}-${tail}`
}

export async function archivedIds() {
  const set = new Set()
  try {
    const json = JSON.parse(await readFile(join(homeDir(), 'storages', 'workspace.json'), 'utf8'))
    const ids = json && json.global && json.global.archivedSessionIds
    if (Array.isArray(ids)) for (const id of ids) set.add(String(id))
  } catch { /* 读不到就当没归档 */ }
  return set
}

/**
 * 归档（删除）一条对话：
 * 1. 把 id 写进 storages/workspace.json 的 global.archivedSessionIds —— /session 列表和 GUI 都不再显示；
 * 2. 尽量把落盘的会话目录挪到 sessions-archive/<workspace-slug>/<id>，真的腾出空间（挪不动只留归档标记）。
 */
export async function archiveSession(sessionId) {
  const id = String(sessionId || '').trim()
  if (!id) throw new Error('会话 id 是空的')
  const wsFile = join(homeDir(), 'storages', 'workspace.json')
  let json = {}
  try { json = JSON.parse(await readFile(wsFile, 'utf8')) || {} } catch { json = {} }
  json.global = json.global || {}
  const ids = Array.isArray(json.global.archivedSessionIds) ? json.global.archivedSessionIds : []
  if (!ids.includes(id)) ids.push(id)
  json.global.archivedSessionIds = ids
  await writeFile(wsFile, JSON.stringify(json, null, 2), 'utf8')

  const root = join(homeDir(), 'sessions')
  try {
    for (const d of await readdir(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const from = join(root, d.name, id)
      try { await stat(from) } catch { continue }
      const targetDir = join(homeDir(), 'sessions-archive', d.name)
      await mkdir(targetDir, { recursive: true })
      await rename(from, join(targetDir, id))
    }
  } catch { /* 挪不动就算了，归档标记已经生效 */ }
  return true
}

/** 扫出所有会话（目录名就是 session id），按最后修改时间倒序，归档的不算 */
export async function listSessions() {
  const root = join(homeDir(), 'sessions')
  const archived = await archivedIds()
  const out = []
  let dirs = []
  try { dirs = await readdir(root, { withFileTypes: true }) } catch { return out }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    let entries = []
    try { entries = await readdir(join(root, d.name), { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory() || archived.has(e.name)) continue
      let st
      try { st = await stat(join(root, d.name, e.name)) } catch { continue }
      out.push({ id: e.name, workspace: d.name, updatedAt: st.mtimeMs })
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

/** 会话标题（宿主投影缓存），没有就空串 */
export async function readSessionTitle(sessionId) {
  const id = String(sessionId || '').trim()
  if (!id) return ''
  const p = join(homeDir(), 'storages', 'session_projcache', 'sessions', `${id}.json`)
  try {
    const j = JSON.parse(await readFile(p, 'utf8'))
    const v = j && j.record && j.record.rows && j.record.rows.title && j.record.rows.title.val
    return typeof v === 'string' ? v.trim() : ''
  } catch {
    return ''
  }
}

/** 会话记录的模型选择（宿主投影缓存 modelSelection.lastUsed），没有就 null
 *  宿主只在 GUI 路径用 agent/request 兜底补 model，插件直接 resume 出来的 agent 是空的，
 *  所以这里把会话自己的模型读出来，resume/create 时显式传下去。 */
export async function readSessionModel(sessionId) {
  const id = String(sessionId || '').trim()
  if (!id) return null
  const p = join(homeDir(), 'storages', 'session_projcache', 'sessions', `${id}.json`)
  try {
    const j = JSON.parse(await readFile(p, 'utf8'))
    const val = j && j.record && j.record.rows
      && j.record.rows.modelSelection && j.record.rows.modelSelection.val
    const used = val && val.lastUsed
    if (used && used.provider && used.model) {
      const out = { provider: String(used.provider), model: String(used.model) }
      if (used.reasoningEffort) out.reasoningEffort = String(used.reasoningEffort)
      return out
    }
  } catch { /* 读不到就算了 */ }
  return null
}

export function ago(ms) {
  const d = Date.now() - ms
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  return `${Math.floor(d / 86_400_000)} 天前`
}
