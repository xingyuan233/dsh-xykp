// tool-gate/registry.js · 门控登记处（纯模块，不依赖插件加载顺序）
//
// 为什么要有它：bili-rove 这类插件是随 bundle 先加载的，tool-gate 是我们 patch 层后加载的；
// 直接 ctx.get('toolGate') 那时还是 undefined，于是工具就按普通方式注册进去了（门控失效）。
// 所以这里用「静态 import + 直接读配置文件」：谁先谁后都行，规则在第一次用时就从磁盘读。
//
// 规则文件：<DSH_HOME>/xykp/tool-gate.json
//   { "bili_rove": { "keys": ["B站","bilibili"], "cooldown": 8, "system": 1, "limit": 3 } }

import { readFileSync, existsSync, appendFileSync } from 'node:fs'
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

const CONFIG_PATH = join(resolveHome(), 'xykp', 'tool-gate.json')
const DEBUG_LOG = join(dirname(CONFIG_PATH), 'tool-gate.log')

function dbg(msg) {
  try {
    appendFileSync(DEBUG_LOG, new Date().toISOString() + ' ' + msg + '\n', 'utf8')
  } catch {}
}
dbg('registry 初始化 · DSH_HOME=' + (process.env.DSH_HOME || '(未设置)') + ' · 配置=' + CONFIG_PATH)

let rules = null
const withheld = new Map()

export function configPath() {
  return CONFIG_PATH
}

export function loadRules(extra) {
  if (rules) return rules
  let fromFile = {}
  try {
    fromFile = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    fromFile = {}
  }
  rules = { ...(fromFile && typeof fromFile === 'object' ? fromFile : {}), ...(extra || {}) }
  return rules
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
    system: Math.max(1, Number.isFinite(raw.system) ? Number(raw.system) : 1),
    limit: Number.isFinite(raw.limit) && Number(raw.limit) > 0 ? Number(raw.limit) : Infinity,
    systemText: typeof raw.systemText === 'string' ? raw.systemText : '',
  }
}

/** 有规则就扣下，返回 true；没规则返回 false（调用方照常注册） */
export function offer(def) {
  dbg('offer(' + (def && def.name) + ') 规则=' + (ruleOf(def && def.name) ? '有' : '无'))
  const toolName = String(def?.name || '').trim()
  if (!toolName) return false
  if (!ruleOf(toolName)) return false
  withheld.set(toolName, def)
  return true
}

export function taken(toolName) {
  return withheld.get(toolName) || null
}

export function withheldNames() {
  return Array.from(withheld.keys())
}
