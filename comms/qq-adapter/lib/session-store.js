// qq-adapter · 会话账本
//
// 主人 2026-10-28 定的规矩：一个会话就是一个会话，不绑账号、不隐藏旧的；
// id 由我们自己起：<前缀>-<yyyyMMdd>-<4位随机>，比如 qq-20261028-ab12。
//
// 这里管两件事：
//   1. chats.json —— 哪个聊天现在绑着哪个会话（插件自己维护，跟 profile 配置分开，
//      因为这是「跑的态」，配置文件是「人的意图」）
//   2. 会话列表 —— 从 <DSH_HOME>/sessions 里扫出真实存在的会话目录，按时间排序

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export function homeDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function chatsPath() {
  return join(homeDir(), 'qq-adapter', 'chats.json')
}

export function sessionsRoot() {
  return join(homeDir(), 'sessions')
}

export async function readChats() {
  try {
    const raw = await readFile(chatsPath(), 'utf8')
    const json = JSON.parse(raw)
    return json && typeof json === 'object' ? json : {}
  } catch {
    return {}
  }
}

export async function writeChats(data) {
  try {
    await mkdir(dirname(chatsPath()), { recursive: true })
    await writeFile(chatsPath(), JSON.stringify(data, null, 2), 'utf8')
  } catch { /* 写不进去就算了，别把转发搞挂 */ }
}

/** 生成一个会话 id：qq-20261028-ab12 */
export function newSessionId(prefix = 'qq', randomLen = 4) {
  const d = new Date()
  const ymd = String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0')
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'
  let tail = ''
  for (let i = 0; i < randomLen; i++) tail += alphabet[Math.floor(Math.random() * alphabet.length)]
  return `${prefix}-${ymd}-${tail}`
}

/**
 * 扫出所有会话（目录名就是 session id），按最后修改时间倒序。
 * 返回 [{ id, updatedAt }]
 */
export async function listSessions() {
  const root = sessionsRoot()
  const out = []
  let dirs = []
  try { dirs = await readdir(root, { withFileTypes: true }) } catch { return out }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const workspaceDir = join(root, d.name)
    let entries = []
    try { entries = await readdir(workspaceDir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const p = join(workspaceDir, e.name)
      let st
      try { st = await stat(p) } catch { continue }
      out.push({ id: e.name, workspace: d.name, updatedAt: st.mtimeMs })
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

/** 删一个会话的落盘目录（真删，不可恢复 —— 主人要的就是这个） */
export async function deleteSessionDir(workspaceDir, sessionId) {
  const { rm } = await import('node:fs/promises')
  const p = join(sessionsRoot(), workspaceDir, sessionId)
  await rm(p, { recursive: true, force: true })
  return p
}

/** 人类看的相对时间 */
export function ago(ms) {
  const d = Date.now() - ms
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return Math.floor(d / 60_000) + ' 分钟前'
  if (d < 86_400_000) return Math.floor(d / 3_600_000) + ' 小时前'
  const days = Math.floor(d / 86_400_000)
  if (days < 30) return days + ' 天前'
  return new Date(ms).toISOString().slice(0, 10)
}
