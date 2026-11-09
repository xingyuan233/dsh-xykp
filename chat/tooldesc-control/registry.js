// tool-gate/registry.js · 门控登记处（纯模块，不依赖插件加载顺序）
//
// 为什么要有它：bili-rove 这类插件是随 bundle 先加载的，tool-gate 是我们 patch 层后加载的；
// 直接 ctx.get('toolGate') 那时还是 undefined，于是工具就按普通方式注册进去了（门控失效）。
// 所以这里用「静态 import registry + 直接读配置文件」：谁先谁后都行，规则在每次用时现读。
//
// 规则文件：<DSH_HOME>/xykp/config.yml → tooldesc-control.rules（Web 控制台/QQ /cfg-* 写的那份）
//   tooldesc-control:
//     rules:
//     rules:   bili_rove: { keys: [B站, bilibili], cooldown: 8, limit: 3 }
//     notes:   qq-note:    { keys: [权限], cooldown: 3, text: '## 权限不足怎么办 ...' }

import { existsSync, appendFileSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { configFile, configFor } from '../../ui/store.js'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 找 DSH_HOME：环境变量优先；没有就从本文件位置往上爬
// （正常情况下是 <home>\profiles\web\node_modules\dsh-xykp\chat\tool-gate\registry.js）
function resolveHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'xykp'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return join(homedir(), '.dsh')
}

const STATE_DIR = join(resolveHome(), 'xykp')
const DATA_DIR = join(STATE_DIR, 'tooldesc-control')
const DEBUG_LOG = join(DATA_DIR, 'tool-gate.log')

export function dbg(msg) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(DEBUG_LOG, new Date().toISOString() + ' ' + msg + '\n', 'utf8')
  } catch {}
}
dbg('registry 初始化 · DSH_HOME=' + (process.env.DSH_HOME || '(未设置)') + ' · 配置=<DSH_HOME>/xykp/config.yml → tooldesc-control.rules')


export function loadRules(extra) {
  // 规则只有一份：Web 控制台（以及 QQ /cfg-*）写的 <DSH_HOME>/xykp/config.yml → tooldesc-control.rules
  // 不缓存：控制台保存后，下一次装配/offer 就该拿到新值。
  let fromWeb = {}
  try {
    const cfg = configFor('tooldesc-control', {})
    const r = cfg && typeof cfg === 'object' ? cfg.rules : null
    if (r && typeof r === 'object' && !Array.isArray(r)) fromWeb = r
  } catch {
    fromWeb = {}
  }
  return { ...fromWeb, ...(extra || {}) }
}

export function ruleOf(toolName) {
  const r = loadRules()
  const raw = r[toolName]
  if (!raw || typeof raw !== 'object') return null
  const keys = (Array.isArray(raw.keys) ? raw.keys : []).map((k) => String(k).trim()).filter(Boolean)
  if (!keys.length) return null
  return {
    keys,
    lowerKeys: keys.map((k) => k.toLowerCase()),
    cooldown: Number.isFinite(raw.cooldown) ? Number(raw.cooldown) : 8,
    limit: Number.isFinite(raw.limit) && Number(raw.limit) > 0 ? Number(raw.limit) : Infinity,
  }
}

// 门控不再扣「工具定义」：tool-gate 在 system-prompt/assemble 里按规则把没解锁的工具从工具表摘掉。
// registry 只负责一件事：规则从哪读、怎么编译成 [keys / cooldown / limit]；说明（notes）同理，带 text。

/** 规则的「版本号」= config.yml 的 mtime；gate 靠它判断要不要重建规则表（改规则不用重启） */
export function rulesVersion() {
  try {
    return statSync(configFile()).mtimeMs
  } catch {
    return 0
  }
}
/** 说明（notes）：不是工具，是一段文本。命中关键词 + 过了冷却就注入一次。 */
export function loadNotes(extra) {
  let fromWeb = {}
  try {
    const cfg = configFor('tooldesc-control', {})
    const n = cfg && typeof cfg === 'object' ? cfg.notes : null
    if (n && typeof n === 'object' && !Array.isArray(n)) fromWeb = n
  } catch {
    fromWeb = {}
  }
  return { ...fromWeb, ...(extra || {}) }
}

export function noteOf(id) {
  const raw = loadNotes()[id]
  if (!raw || typeof raw !== 'object') return null
  const keys = (Array.isArray(raw.keys) ? raw.keys : []).map((k) => String(k).trim()).filter(Boolean)
  if (!keys.length || typeof raw.text !== 'string' || !raw.text) return null
  return {
    keys,
    lowerKeys: keys.map((k) => k.toLowerCase()),
    cooldown: Number.isFinite(raw.cooldown) ? Number(raw.cooldown) : 8,
    limit: Number.isFinite(raw.limit) && raw.limit > 0 ? Number(raw.limit) : Infinity,
    text: raw.text,
  }
}
// ── 会话级工具表快照（前缀缓存的终极保险）----------------------------------
// 第一次组装时把该会话的 tools 原样存盘，之后每次组装都原样发回这一份：
// 改描述、改参数、删工具、改名，都不影响请求开头。新工具靠消息追加，不进这张表。
const FROZEN_PATH = join(DATA_DIR, 'frozen-tools.json')

function readFrozenAll() {
  try {
    return JSON.parse(readFileSync(FROZEN_PATH, 'utf8')) || {}
  } catch {
    return {}
  }
}

export function frozenTools(sid) {
  const all = readFrozenAll()
  return Array.isArray(all[sid]) ? all[sid] : null
}

export function saveFrozenTools(sid, list) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const all = readFrozenAll()
    all[sid] = list
    writeFileSync(FROZEN_PATH, JSON.stringify(all), 'utf8')
  } catch {}
}