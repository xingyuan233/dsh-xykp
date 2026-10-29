// tool-gate · 关键词门控工具（工具先不出来，命中关键词才推出来）
//
// 主人 2026-10-29 定的语义：
//   · 配置在插件 config 里，按工具名写：
//       bili_rove:
//         keys: [B站, bilibili, 投稿]
//         cooldown: 8     # 至少隔 8 个「大轮」（一条用户消息 = 一轮）才能再推
//         system: 1       # 每推 N 次工具描述，才附一次该工具的系统提示词
//         limit: 3        # 一个对话最多推几次；不填 = 无限
//         systemText: ... # 可选，推的时候附加的一段说明（当系统提示词用）
//   · 每步都检查：用户输入、工具结果回传、模型输出（含流式）里出现 keys 就算命中
//   · 命中就**立刻**在该会话的 agent 上注册这个工具 —— 下一次请求（不管下一步是工具结果还是用户消息）就带着它
//   · 冷却按「大轮」算（turn），不按 step：两个 step 之间只隔几秒，按 step 冷却等于没冷却
//
// 谁用它：其它插件本来 `ctx.tools.register(def)` 的地方改成
//     const gate = ctx.get('toolGate')
//     if (gate && gate.offer(def)) { /* 被收走了，等触发 */ } else { ctx.tools.register(def) }
//   gate.offer(def) 返回 true = 「这个工具先扣着」，返回 false = 「没配门控，你自己照常注册」。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import Schema from '@deepseek-ai/schemastery'

import * as __R from './registry.js'

export const name = 'tool-gate'
export const inject = ['tools', 'agents']

const log = (...a) => console.log('[tool-gate]', ...a)
const warn = (...a) => console.warn('[tool-gate]', ...a)

export const Config = Schema.object({
  configPath: Schema.string().default('').description('额外配置（json，空 = 只用下面这份）'),
  rules: Schema.any().default({}).description('按工具名的规则表'),
  checkAssistant: Schema.boolean().default(true).description('也检查模型自己的输出/思考'),
})

function textOf(node) {
  // 从消息节点里尽量把可读文本抠出来（块结构 / 纯字符串都照顾）
  if (!node) return ''
  if (typeof node === 'string') return node
  const out = []
  const walk = (v, depth) => {
    if (depth > 6 || v == null) return
    if (typeof v === 'string') {
      out.push(v)
      return
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1)
      return
    }
    if (typeof v === 'object') {
      for (const key of ['text', 'content', 'thinking', 'delta', 'message', 'messages']) {
        if (key in v) walk(v[key], depth + 1)
      }
    }
  }
  walk(node, 0)
  return out.join('\n')
}

export function apply(ctx, config = {}) {
  // 规则和「被扣下的定义」都放 registry（bili-rove 是静态 import 它，跟加载顺序无关）
  const rules = __R.loadRules(config.rules || {})

  /** 工具名 -> 定义（被扣着的） */
  const withheld = {
    get: (n) => __R.taken(n),
    keys: () => __R.withheldNames(),
    has: (n) => !!__R.taken(n),
    set: () => {},
  }
  /** 工具名 -> 规则的编译版 */
  const compiled = new Map()
  for (const toolName of Object.keys(rules)) {
    const cmp = __R.ruleOf(toolName)
    if (cmp) compiled.set(toolName, cmp)
  }

  /** sid -> 状态 */
  const states = new Map()
  const stateOf = (agent) => {
    const sid = String(agent?.session?.id || agent?.id || '')
    if (!sid) return null
    if (!states.has(sid)) states.set(sid, { turn: 0, pushed: {}, lastTurn: {}, registered: new Set(), systemCount: {} })
    return states.get(sid)
  }

  const hit = (text, rule) => {
    if (!text) return false
    const lower = text.toLowerCase()
    return rule.lowerKeys.some((k) => lower.includes(k))
  }

  function tryPush(agent, toolName) {
    const rule = compiled.get(toolName)
    const def = withheld.get(toolName)
    const st = stateOf(agent)
    if (!rule || !def || !st) return false
    if (st.registered.has(toolName)) return false
    const pushed = st.pushed[toolName] || 0
    if (pushed >= rule.limit) return false
    const last = st.lastTurn[toolName]
    if (last !== undefined && st.turn - last < rule.cooldown) return false
    try {
      agent.ctx.tools.register(def)
    } catch (error) {
      warn('注册 ' + toolName + ' 失败：', error?.message || error)
      return false
    }
    st.registered.add(toolName)
    st.pushed[toolName] = pushed + 1
    st.lastTurn[toolName] = st.turn
    st.systemCount[toolName] = (st.systemCount[toolName] || 0) + 1
    log('推出 ' + toolName + '（第 ' + st.pushed[toolName] + ' 次，turn=' + st.turn + '）')
    if (rule.systemText && (st.systemCount[toolName] - 1) % rule.system === 0) {
      try {
        agent.ctx.systemPrompt.section({
          name: 'tool-gate-' + toolName,
          order: 10400,
          text: () => rule.systemText,
        })
      } catch (error) {
        warn('挂 ' + toolName + ' 的说明段失败：', error?.message || error)
      }
    }
    return true
  }

  function scan(agent, text) {
    if (!text || !compiled.size) return
    for (const toolName of withheld.keys()) {
      if (!compiled.has(toolName)) continue
      if (!hit(text, compiled.get(toolName))) continue
      tryPush(agent, toolName)
    }
  }

  // ── 给别的插件用的服务 ──
  const service = {
    /** 有规则就扣着（返回 true），没规则就返回 false 让调用方自己注册 */
    offer(def) {
      if (__R.offer(def)) return true
      const toolName = String(def?.name || '').trim()
      if (!toolName) return false
      if (!compiled.has(toolName)) return false
      withheld.set(toolName, def)
      log('扣下 ' + toolName + '（关键词：' + compiled.get(toolName).keys.join(' / ') + '）')
      return true
    },
    /** 手动放行（调试用） */
    release(agent, toolName) {
      return tryPush(agent, toolName)
    },
    /** 看看扣了哪些 */
    list() {
      return Array.from(withheld.keys())
    },
  }
  // 暴露给别的插件：走全局变量最稳（cordis 各版本的服务注册 API 不一样，之前那行会抛，整个插件挂不上）
  try {
    globalThis.__toolGate = service
  } catch {}
  try {
    if (typeof ctx.provide === 'function') ctx.provide('toolGate', service)
  } catch (error) {
    warn('ctx.provide 不可用（不影响，走全局变量）：', error?.message || error)
  }

  // ── 消息一进来就扫（比 pre-step 早：用户消息刚进收件箱那一刻，工具就能赶上同一轮的第一个请求）──
  try {
    ctx.on('agent/inbox/inserted', (payload) => {
      try {
        const agent = payload?.agent
        const st = stateOf(agent)
        if (st) st.turn += 1
        // 事件 payload 是 { agent, message }（单数，挨条发）；以前写成 messages，扫到的是空串
        const list = payload?.messages || payload?.inserted || (payload?.message ? [payload.message] : [])
        const text = (Array.isArray(list) ? list : [list]).map(textOf).join('\n')
        scan(agent, text)
      } catch (error) {
        warn('inbox 扫描失败：', error?.message || error)
      }
    })
  } catch (error) {
    warn('挂 inbox 失败：', error?.message || error)
  }

  // ── 每步再扫一遍（工具结果回传、补漏）──
  try {
    ctx.on('agent/pre-step', (payload, next) => {
      try {
        const agent = payload?.agent
        const st = stateOf(agent)
        if (st && Number.isFinite(payload?.turn) && payload.turn > st.turn) st.turn = Number(payload.turn)
        const text = (payload?.messages || []).map(textOf).join('\n')
        scan(agent, text)
        // 2026-10-29：也扫一眼**自己上一轮说的话**（assistant-stream 的 payload 形状不一定稳，
        // 从会话面上取最后几个节点更可靠）——这样「我自己的输出里提到关键词」也能触发
        try {
          const nodes = agent?.session?.surface?.nodes || []
          const tail = nodes.slice(-3).map((n) => textOf(n)).join('\n')
          if (tail) scan(agent, tail)
        } catch {}
      } catch (error) {
        warn('pre-step 扫描失败：', error?.message || error)
      }
      return next ? next() : undefined
    })
  } catch (error) {
    warn('挂 pre-step 失败：', error?.message || error)
  }

  if (config.checkAssistant !== false) {
    try {
      ctx.on('agent/assistant-stream', (payload) => {
        try {
          scan(payload?.agent, textOf(payload?.chunk || payload?.delta || payload?.text || payload))
        } catch {}
      })
    } catch (error) {
      warn('挂 assistant-stream 失败：', error?.message || error)
    }
  }

  log('已装：' + compiled.size + ' 条规则' + (compiled.size ? '（' + Array.from(compiled.keys()).join(', ') + '）' : ''))
}
