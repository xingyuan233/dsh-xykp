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

export async function readBindings() {
  const data = await readJson(bindingsPath(), {})
  return data && typeof data === 'object' ? data : {}
}

export async function writeBinding(chatKey, target) {
  const all = await readBindings()
  const key = String(chatKey || '').trim()
  if (!key) return all
  if (!target) delete all[key]
  else all[key] = { target: String(target).trim(), updatedAt: Date.now() }
  await writeJson(bindingsPath(), all)
  return all
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

export function ago(ms) {
  const d = Date.now() - ms
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  return `${Math.floor(d / 86_400_000)} 天前`
}
