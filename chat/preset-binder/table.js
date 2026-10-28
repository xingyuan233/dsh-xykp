// dsh-xykp · chat/preset-binder · 表的纯逻辑
// 结构：
// {
//   version: 2,
//   updatedAt,
//   presets: {
//     alive: {
//       active: "<最近说话的那个 session>",
//       name: "<预设显示名>",
//       sessions: {
//         "<sid>": {
//           title, provider, model,
//           running, startedAt, endedAt, lastActivityAt,
//           turns, tokens: {uncachedInput, cacheRead, cacheWrite, output, total},
//           context: {window, pressureTokens}
//         }
//       }
//     }
//   }
// }
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = () => process.env.DSH_HOME || join(homedir(), '.dsh')

/** 表文件的位置：<DSH_HOME>/xykp/preset-binder/preset-binder.json */
export function binderPath(home = HOME()) {
  return join(home, 'xykp', 'preset-binder', 'preset-binder.json')
}

export function emptyTable() {
  return { version: 2, updatedAt: null, presets: {} }
}

export function readTable(path) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (raw && typeof raw === 'object' && raw.presets && typeof raw.presets === 'object') {
      for (const row of Object.values(raw.presets)) {
        if (!row.sessions || typeof row.sessions !== 'object') row.sessions = {}
      }
      return raw
    }
  } catch (e) {}
  return emptyTable()
}

export function writeTable(path, table) {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(table, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
}

/**
 * 记一个会话的现状（patch 里没给的字段保留旧值）。
 * active = 这个预设下「最后活动时间」最新的那个会话。
 */
export function noteSession(table, presetId, sid, patch, { maxSessions = 30, presetName = '' } = {}) {
  const next = JSON.parse(JSON.stringify(table && table.presets ? table : emptyTable()))
  const row = next.presets[presetId] || { active: null, name: '', sessions: {} }
  const prev = row.sessions[sid] || {}
  const merged = { ...prev, ...patch }
  row.sessions[sid] = merged
  if (presetName) row.name = presetName

  const ids = Object.keys(row.sessions)
  ids.sort((a, b) => {
    const ta = Date.parse(row.sessions[a].lastActivityAt || '') || 0
    const tb = Date.parse(row.sessions[b].lastActivityAt || '') || 0
    return tb - ta
  })
  for (const id of ids.slice(maxSessions)) delete row.sessions[id]
  row.active = ids[0] || null

  next.presets[presetId] = row
  next.updatedAt = new Date().toISOString()
  return next
}

export function activeSession(table, presetId) {
  const row = table?.presets?.[presetId]
  return row && typeof row.active === 'string' ? row.active : undefined
}

export function sessionInfo(table, presetId, sid) {
  return table?.presets?.[presetId]?.sessions?.[sid]
}

export function fileExists(path) {
  return existsSync(path)
}
