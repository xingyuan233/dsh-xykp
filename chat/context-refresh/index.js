// context-refresh · 长对话里定期把「预设 + 工具清单」再提醒一遍
//
// 为什么需要：上下文一长，开头的系统提示（人格、规矩、工具说明）在注意力上越来越远，
// 容易开始「忘自己是谁」「编工具名」。这里按累计 token 定期塞一小段提醒进系统提示的**最后**。
//
// 关键设计（别乱改）：
//   · 用 `systemPrompt.section({ order: 10500 })` —— 排在 DSH 自己的段（工具说明、persona，最高到 10200）**后面**。
//     系统提示是按 order 拼的，变的那一段放最后，前面几千字照样命中缓存，只有这一小段按全价算。
//   · 平时 text() 返回空串（不占 token、不改前缀）；真到阈值才返回一段提醒，然后重置计数。
//   · 计数用 sessionProjections 的 tokenUsage 累计值，按会话记。
//
// 配置：
//   everyTokens   累计多少 token 提醒一次（0 = 关，默认 60000）
//   withPrefix    提醒里带不带「预设要点」（从预设文件里读 persona 那段，默认 true）
//   withTools     提醒里带不带工具名清单（从最近一次请求头里读，默认 true）
//   presetDir     预设目录（空 = <DSH_HOME>/profiles/web/presets）

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import Schema from '@deepseek-ai/schemastery'

export const name = 'context-refresh'
export const inject = ['systemPrompt', 'agents']

const log = (...a) => console.log('[context-refresh]', ...a)
const warn = (...a) => console.warn('[context-refresh]', ...a)

export const Config = Schema.object({
  everyTokens: Schema.number().default(200000).description('累计多少 token 提醒一次；0 = 关'),
  withPrefix: Schema.boolean().default(true).description('提醒里带预设要点'),
  withTools: Schema.boolean().default(true).description('提醒里带工具名清单'),
  presetDir: Schema.string().default('').description('预设目录（空 = 默认）'),
})

const home = () => process.env.DSH_HOME || join(homedir(), '.dsh')

function presetDirOf(config) {
  return config.presetDir || join(home(), 'profiles', 'web', 'presets')
}

// 从 preset.yml 里抠出 persona 那段 prefix（没有 yaml 库就用最笨的正则，够用）
function readPresetPrefix(dir, id) {
  try {
    const file = join(dir, String(id), 'preset.yml')
    if (!existsSync(file)) return ''
    const text = readFileSync(file, 'utf8')
    const m = text.match(/prefix:\s*\|-?\s*\n([\s\S]*?)(?=\n\s*(?:-\s+)?[a-zA-Z_][\w-]*:|$)/)
    if (!m) return ''
    const lines = m[1].split('\n')
    // 截到下一个插件条目（"- id:" / "- name:"）为止 —— 正则容易多吃一行
    const cut = lines.findIndex((line) => /^\s*-\s*(id|name):/.test(line))
    const body = cut >= 0 ? lines.slice(0, cut) : lines
    return body
      .map((line) => line.replace(/^ {8}/, '').replace(/^ {0,7}/, ''))
      .join('\n')
      .trim()
  } catch (error) {
    warn('读预设要点失败：', error?.message || error)
    return ''
  }
}

function presetList(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
      .map((e) => e.name)
  } catch {
    return []
  }
}

function toolNames(agent) {
  try {
    const header = agent.session && agent.session.requestHeader ? agent.session.requestHeader() : null
    const arr = Array.isArray(header?.tools) ? header.tools : []
    return arr
      .map((t) => (typeof t === 'string' ? t : t?.name || t?.function?.name || ''))
      .filter(Boolean)
  } catch {
    return []
  }
}

function tokensOf(ctx, agent) {
  // 2026-10-29：看的是**当前上下文长度**，不是累计用量。
  // （累计用量每步都会涨几十万，拿它比阈值等于每步都触发。）
  try {
    const registry = ctx.get ? ctx.get('sessionProjections') : null
    if (!registry || !agent.session) return 0
    const pressure = registry.stateOf(agent.session, 'contextPressure')
    const used = pressure?.projectedTokens ?? pressure?.pressureTokens
    if (Number.isFinite(Number(used))) return Number(used)
    return 0
  } catch {
    return 0
  }
}

export function apply(ctx, config = {}) {
  const every = Math.max(0, Number(config.everyTokens ?? 200000))
  if (!every) {
    log('everyTokens=0，不启用')
    return
  }
  const dir = presetDirOf(config)
  const mounted = (globalThis.__ctxRefreshMounted ||= new Map()) // sid -> off（模块级，防重复挂）
  const sharedState = (globalThis.__ctxRefreshState ||= new Map()) // sid -> state（几个定时器共用同一道闸）

  function reminderFor(agent) {
    const preset = (() => {
      try {
        const reg = ctx.get ? ctx.get('agentPresets') : null
        return (reg && reg.composedPreset ? reg.composedPreset(agent.ctx) : '') || ''
      } catch {
        return ''
      }
    })()
    const parts = ['〔上下文提醒 · 把开头要点再带一遍〕']
    if (preset) parts.push('当前预设：' + preset)
    if (config.withPrefix !== false && preset) {
      const prefix = readPresetPrefix(dir, preset)
      if (prefix) parts.push('—— 预设要点 ——\n' + prefix)
    }
    if (config.withTools !== false) {
      const names = toolNames(agent)
      if (names.length) parts.push('—— 工具（只有这些，别编名字）——\n' + names.join(', '))
    }
    parts.push('（照系统提示的人格和规矩继续，别把自己是谁忘了）')
    return parts.join('\n\n')
  }

  function mount(agent) {
    const sid = String(agent?.session?.id || agent?.id || '')
    if (!sid || mounted.has(sid)) return
    // 2026-10-29：不再往 systemPrompt 里塞（那会重写请求开头、把前缀缓存整段作废），
    // 改成走 tool-gate 的统一通知通道（steer 一条消息，前缀一个字不动）。
    const state = sharedState.get(sid) || { lastAt: tokensOf(ctx, agent), busy: false, lastFiredAt: 0 }
    sharedState.set(sid, state)
    const timer = setInterval(() => {
      try {
        if (state.busy) return
        const now = tokensOf(ctx, agent)
        if (now - state.lastAt < every) return
        state.busy = true
        state.lastAt = now
        state.lastFiredAt = Date.now()
        let text = ''
        try {
          text = reminderFor(agent)
        } catch (error) {
          warn('生成提醒失败：', error?.message || error)
          state.busy = false
          return
        }
        // 2026-10-29：不 steer（那会凭空多一轮「收到执行请求」），改成排队，
        // 等下一条用户消息进来时由 tool-gate 一起贴到开头。
        try {
          globalThis.__toolGate?.queueNotice?.(text)
          log('排队重贴：' + sid + '（累计 ' + now + ' tokens）')
        } catch (error) {
          warn('排队失败：', error?.message || error)
        } finally {
          state.busy = false
        }
      } catch (error) {
        warn('重贴检查失败：', error?.message || error)
      }
    }, 60_000)
    if (typeof timer.unref === 'function') timer.unref()
    mounted.set(sid, () => clearInterval(timer))
  }

  function sweep() {
    try {
      for (const agent of ctx.agents.list ? ctx.agents.list() : []) mount(agent)
    } catch (error) {
      warn('扫描会话失败：', error?.message || error)
    }
  }

  try {
    sweep()
    const timer = setInterval(sweep, 15000)
    if (typeof timer.unref === 'function') timer.unref()
    ctx.effect(() => () => {
      clearInterval(timer)
      for (const off of mounted.values()) {
        try {
          if (typeof off === 'function') off()
        } catch {}
      }
      mounted.clear()
    })
  } catch (error) {
    warn('启动扫描失败：', error?.message || error)
  }

  log('已装：每 ' + every + ' tokens 提醒一次；预设目录 ' + dir + '；' + presetList(dir).length + ' 个预设')
}
