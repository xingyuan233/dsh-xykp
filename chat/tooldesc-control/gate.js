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
      for (const key of ['text', 'content', 'thinking', 'delta', 'message', 'messages', 'frame', 'chunk']) {
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

  // ── 推送状态落盘（2026-10-29）──
  // 重启会把门控状态清掉：同一个会话里本来已经推出来的工具又被扣回去 → 请求开头的 tools 少一个 →
  // 前缀缓存整段作废。所以把「哪个会话推过哪些工具」写盘，重启后第一轮照旧推回来。
  const statePath = () => {
    const base = globalThis.process?.env?.DSH_HOME || 'D:\\AI\\DeepseekHarness\\home'
    return base + '\\xykp\\tool-gate-state.json'
  }
  const fsx = () => globalThis.process?.getBuiltinModule?.('node:fs')
  const readStateFile = () => {
    try {
      return JSON.parse(fsx().readFileSync(statePath(), 'utf8')) || {}
    } catch {
      return {}
    }
  }
  const sidOf = (agent) => String(agent?.session?.id || agent?.id || '')
  const persistPushed = (agent, toolName) => {
    const sid = sidOf(agent)
    if (!sid) return
    try {
      const all = readStateFile()
      const list = new Set(Array.isArray(all[sid]) ? all[sid] : [])
      list.add(toolName)
      all[sid] = [...list]
      fsx().writeFileSync(statePath(), JSON.stringify(all, null, 2))
    } catch (error) {
      warn('落盘推送状态失败：', error?.message || error)
    }
  }
  const restorePushed = (agent) => {
    const sid = sidOf(agent)
    if (!sid) return
    const st = stateOf(agent)
    if (!st) return
    const saved = readStateFile()[sid]
    if (!Array.isArray(saved)) return
    for (const name of saved) {
      if (st.registered.has(name)) continue
      const def = withheld.get(name)
      if (!def) continue
      try {
        agent.ctx.tools.register(def)
        st.registered.add(name)
        st.pushed[name] = st.pushed[name] || 1
        log('恢复推过的 ' + name + '（重启后不抖工具表）')
      } catch (error) {
        warn('恢复 ' + name + ' 失败：', error?.message || error)
      }
    }
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
    persistPushed(agent, toolName)
    if (!pendingUnlocks.includes(toolName)) pendingUnlocks.push(toolName)
    // 2026-10-29：工具的「系统说明」也不再往 systemPrompt 里塞（那等于重写请求开头、废掉前缀缓存），
    // 攒进下一轮那条消息通知里，跟「已解锁」一起说明。
    if (rule.systemText && (st.systemCount[toolName] - 1) % rule.system === 0) {
      pendingUnlockTexts[toolName] = String(rule.systemText)
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

  // ── 统一的通知通道（2026-10-29）──
  // 往当前会话 steer 一条消息：不碰请求开头（前缀缓存照旧），下一轮第一屏就能看到。
  // 注意：steer 会被宿主当成一次「收到执行请求」，凭空多一轮回复——所以**闲话一律走 queueNotice**，
  // 只有真的要立刻说的时候才用 notify。
  const pendingExtras = []
  const NOTICE_KIND = 'tool-gate:notice'
  async function notify(agent, text) {
    if (!agent || !text) return false
    const note = {
      id: globalThis.crypto?.randomUUID?.() ?? ('gate-notice-' + Date.now()),
      role: 'user',
      source: { kind: NOTICE_KIND },
      content: [{ type: 'text', text }],
    }
    try {
      if (typeof agent.steer === 'function') await agent.steer(note)
      else if (typeof agent.followup === 'function') await agent.followup(note)
      else return false
      return true
    } catch (error) {
      warn('通知发出失败：', error?.message || error)
      return false
    }
  }

  // 本轮新解锁的工具：攒着，下一轮消息开头一并告诉模型（不往 systemPrompt 里塞，前缀不动）
  const pendingUnlocks = []
  const pendingUnlockTexts = Object.create(null)

  // 工具说明变更（tool-desc-pin 记在 globalThis.__ykpToolDescChanges）
  // 内置工具（pwsh / read / edit …）会被 wire 精简改写文案，那不是「人改了说明」，按规则忽略。
  const DESC_WINDOW_MS = 10 * 60 * 1000
  const pendingDescNotices = () => {
    const pending = globalThis.__ykpToolDescChanges
    if (!Array.isArray(pending) || pending.length === 0) return []
    const ignore = new Set(config.descNoticeIgnore || [])
    return pending.filter((change) => {
      if (!change || change.sent) return false
      if (ignore.has(change.name)) return false
      // 内置工具（pwsh/read/edit…）的文案会被 wire 精简改写，冻结补丁会给它们打 builtin，跳过
      if (change.builtin) return false
      const at = Date.parse(change.at || '')
      return Number.isFinite(at) ? Date.now() - at < DESC_WINDOW_MS : true
    })
  }

  // ── 给别的插件用的服务 ──
  const service = {
    /** 统一通知通道：别的插件（比如 context-refresh）想跟用户说句话就走这里 */
    notify,
    /** 攒一条闲话，等下一条用户消息进来时一起带到开头（不单独开一轮回复） */
    queueNotice: (text) => {
      if (text && !pendingExtras.includes(String(text))) pendingExtras.push(String(text))
    },
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

  // 重入守卫：发通知本身就是往收件箱插消息，会同步再触发本 handler
  let dispatching = false

  // ── 消息一进来就扫（比 pre-step 早：用户消息刚进收件箱那一刻，工具就能赶上同一轮的第一个请求）──
  try {
    ctx.on('agent/inbox/inserted', (payload) => {
      try {
        if (dispatching) return
        const agent = payload?.agent
        const st = stateOf(agent)
        if (st) st.turn += 1
        // 事件 payload 是 { agent, message }（单数，挨条发）；以前写成 messages，扫到的是空串
        const list = payload?.messages || payload?.inserted || (payload?.message ? [payload.message] : [])
        restorePushed(agent)
        const text = (Array.isArray(list) ? list : [list]).map(textOf).join('\n')
        scan(agent, text)
        // 工具说明变更：同一套通知通道发一条独立消息（不碰前缀）
        const notes = pendingDescNotices()
        const unlocks = pendingUnlocks.splice(0, pendingUnlocks.length)
        const extras = pendingExtras.splice(0, pendingExtras.length)
        if (notes.length || unlocks.length || extras.length) {
          // 同步占位：notify → steer 会同步插消息、再触发本 handler；
          // sent 若等到 .then 才置位，二次进入时会重发同一批 → 无限递归（2026-10-29 爆栈）
          for (const change of notes) change.sent = true
          dispatching = true
          const parts = []
          for (const name of unlocks) {
            const extra = pendingUnlockTexts[name]
            delete pendingUnlockTexts[name]
            const def = withheld.get(name)
            const desc = typeof def?.description === 'string' ? def.description : ''
            parts.push(['〔已解锁工具 · ' + name + '〕',
              '关键词命中，这个工具现在可以用了，说明如下：',
              desc].join('\n'))
            if (extra) parts.push(String(extra))
          }
          for (const change of notes) {
            parts.push(['〔工具说明已更新 · ' + change.name + '〕',
              '请求开头的工具定义保持不变（为了复用缓存），以这段为新说明：',
              String(change.after || '')].join('\n'))
          }
          notify(agent, parts.concat(extras).join('\n\n')).then((ok) => {
            dispatching = false
            if (!ok) {
              for (const change of notes) change.sent = false
              return
            }
            log('推送通知：解锁 ' + unlocks.length + ' 个，说明变更 ' + notes.length + ' 条')
          }).catch((error) => {
            dispatching = false
            for (const change of notes) change.sent = false
            warn('推送通知失败：', error?.message || error)
          })
        }
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
          const tail = nodes.slice(-6).map((n) => textOf(n)).join('\n')
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
          const frame = payload?.frame ?? payload
          // 2026-10-29：思考（reasoning）帧的结构和正文不一样，textOf 只认几种 key，取不全；
          // 再扫一遍原始 JSON，关键词藏在哪个字段里都能撞上。
          scan(payload?.agent, textOf(frame) + '\n' + JSON.stringify(frame ?? {}))
        } catch {}
      })
    } catch (error) {
      warn('挂 assistant-stream 失败：', error?.message || error)
    }
  }

  log('已装：' + compiled.size + ' 条规则' + (compiled.size ? '（' + Array.from(compiled.keys()).join(', ') + '）' : ''))
}
