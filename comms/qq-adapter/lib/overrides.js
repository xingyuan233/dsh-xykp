// qq-adapter · 分流配置的「运行时覆盖」文件
//
// 为什么不直接写 cordis.patch.yml：那份是人配置文件，改错了整个宿主起不来。
// 这里只放「分流/目标」这类可以热改的字段，插件每个 tick 读一次（很便宜），
// 所以保存完立刻生效，不用重启、也不用碰 profile 配置。
//
// 结构（两个实例各一份）：
// {
//   "default": { "defaultTarget": "...", "mode": "blacklist", "blocked": [...], "allowed": [...], "mappings": [...] },
//   "whale":   { ... }
// }

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function overridePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'qq-adapter', 'ui-config.json')
}

/** 读一份覆盖配置；文件不存在就返回空对象 */
export async function readOverride() {
  try {
    const raw = await readFile(overridePath(), 'utf8')
    const json = JSON.parse(raw)
    return json && typeof json === 'object' ? json : {}
  } catch {
    return {}
  }
}

/** 只取跟分流有关、且值合法的字段 */
export function pickRouting(entry) {
  const out = {}
  if (!entry || typeof entry !== 'object') return out
  if (typeof entry.defaultTarget === 'string' && entry.defaultTarget.trim()) out.defaultTarget = entry.defaultTarget.trim()
  if (entry.mode === 'blacklist' || entry.mode === 'whitelist') out.mode = entry.mode
  for (const key of ['blocked', 'allowed']) {
    if (Array.isArray(entry[key])) out[key] = entry[key].map((x) => String(x)).filter(Boolean)
  }
  // 流量控制也能从设置页改（只有一个窗口参数）
  if (entry.coalesceSeconds !== undefined) {
    const n = Number(entry.coalesceSeconds)
    if (Number.isFinite(n) && n >= 0) out.coalesceSeconds = n
  }
  if (Array.isArray(entry.fastUids)) out.fastUids = entry.fastUids.map((x) => String(x)).filter(Boolean)
  if (Array.isArray(entry.mappings)) {
    out.mappings = entry.mappings
      .filter((m) => m && typeof m === 'object' && m.chat && m.target)
      .map((m) => ({ chat: String(m.chat).trim(), target: String(m.target).trim() }))
  }
  return out
}
