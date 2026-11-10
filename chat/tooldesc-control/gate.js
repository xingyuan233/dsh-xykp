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

// 调试日志只有一份实现（写 <DSH_HOME>/xykp/tool-gate.log），放在 registry 里；
// 以前 gate.js 直接写 dbg(...) 但没定义 → 每次 assemble 抛 ReferenceError，整个回合挂掉。
const dbg = __R.dbg

export const name = 'tool-gate'
export const inject = ['tools', 'agents']

const log = (...a) => console.log('[tool-gate]', ...a)
const warn = (...a) => console.warn('[tool-gate]', ...a)

export const Config = Schema.object({
  rules: Schema.any().default({}).description('按工具名的规则表'),
  checkAssistant: Schema.boolean().default(true).description('也检查模型自己的输出（不含思考/工具调用）'),
})

// 只取「人写 / 模型说」的文本：纯字符串，或 type=text 的块。
// 工具调用的参数、工具结果、思考块、注入内容一律不算（它们会被当成"顺手提了一嘴"误触发）。
function blockText(block) {
  if (!block) return ''
  if (typeof block === 'string') return block
  if (Array.isArray(block)) return block.map(blockText).filter(Boolean).join('\n')
  if (typeof block !== 'object') return ''
  const type = typeof block.type === 'string' ? block.type.toLowerCase() : ''
  if (type.includes('think') || type.includes('reason') || type.includes('tool')) return ''
  if ('arguments' in block || 'args' in block || 'toolName' in block) return ''
  if (typeof block.text === 'string') return block.text
  if (typeof block.content === 'string') return block.content
  if (Array.isArray(block.content)) return block.content.map(blockText).filter(Boolean).join('\n')
  return ''
}

function textOf(node) {
  if (!node) return ''
  if (typeof node === 'string') return node
  if (typeof node !== 'object') return ''
  const type = typeof node.type === 'string' ? node.type.toLowerCase() : ''
  if (type.includes('think') || type.includes('reason') || type.includes('tool')) return ''
  if ('arguments' in node || 'args' in node || 'toolName' in node) return ''
  if (Array.isArray(node.content)) return node.content.map(blockText).filter(Boolean).join('\n')
  if (node.message && node.message !== node) return textOf(node.message)
  if (node.frame && node.frame !== node) return textOf(node.frame)
  if (node.chunk && node.chunk !== node) return textOf(node.chunk)
  if (typeof node.text === 'string') return node.text
  if (typeof node.delta === 'string') return node.delta
  if (node.delta && typeof node.delta === 'object') return blockText(node.delta)
  return ''
}

export function apply(ctx, config = {}) {
  // 规则从 registry 读（Web 配置那一份）；门控不再扣工具定义，只在 system-prompt/assemble 里把没解锁的工具摘掉
    /** 工具名 -> 规则的编译版 */
  const compiled = new Map()
  const compiledNotes = new Map()
  let compiledVersion = -1
  const rebuild = () => {
    const rules = __R.loadRules(config.rules || {})
    compiled.clear()
    for (const toolName of Object.keys(rules)) {
      const cmp = __R.ruleOf(toolName)
      if (cmp) compiled.set(toolName, cmp)
    }
    const noteRules = __R.loadNotes(config.notes || {})
    compiledNotes.clear()
    for (const id of Object.keys(noteRules)) {
      const n = __R.noteOf(id)
      if (n) compiledNotes.set(id, n)
    }
  }
  // 规则是 Web 配置里现读的：config.yml 一改（mtime 变了）就重建，改规则不用重启
  const ensureFresh = () => {
    let v = 0
    try { v = __R.rulesVersion() } catch { v = 0 }
    if (v === compiledVersion) return
    compiledVersion = v
    rebuild()
  }
  ensureFresh()

  /** sid -> 状态 */
  const states = new Map()
  const stateOf = (agent) => {
    const sid = String(agent?.session?.id || agent?.id || '')
    if (!sid) return null
    if (!states.has(sid)) states.set(sid, { turn: 0, pushed: {}, lastTurn: {}, registered: new Set(), declared: new Set(), notes: {}, noteTurn: {}, injected: [] })
    return states.get(sid)
  }

  // 短英文键（≤3 字符）必须带词边界：BV 不该命中 oBVious；长词/中文仍按子串（schedule 能匹配 schedule_list）
  const shortKeyRe = new Map()
  const keyRe = (key) => {
    let re = shortKeyRe.get(key)
    if (!re) {
      re = new RegExp('(^|[^a-z0-9])' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])')
      shortKeyRe.set(key, re)
    }
    return re
  }
  const matchKey = (lower, key) => {
    if (!key) return false
    const k = String(key).toLowerCase()
    if (k.length > 3 || /[^\x00-\x7f]/.test(k)) return lower.includes(k)
    return keyRe(k).test(lower)
  }

  const hit = (text, rule) => {
    if (!text) return false
    const lower = text.toLowerCase()
    return rule.lowerKeys.some((k) => matchKey(lower, k))
  }
  /** 返回命中的那个关键词（消息里展示用）；没命中返回 '' */
  const hitKey = (text, rule) => {
    if (!text) return ''
    const lower = text.toLowerCase()
    const idx = rule.lowerKeys.findIndex((k) => matchKey(lower, k))
    return idx < 0 ? '' : String(rule.keys[idx] || rule.lowerKeys[idx])
  }

  // ── 推送状态落盘（2026-10-29）──
  // 重启会把门控状态清掉：同一个会话里本来已经推出来的工具又被扣回去 → 请求开头的 tools 少一个 →
  // 前缀缓存整段作废。所以把「哪个会话推过哪些工具」写盘，重启后第一轮照旧推回来。
  const statePath = () => {
    const base = globalThis.process?.env?.DSH_HOME || 'D:\\AI\\DeepseekHarness\\home'
    return base + '\\xykp\\tooldesc-control\\state.json'
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
  /** 分支/复制会话的父 sid（宿主的 header.parentSession），没有就是 '' */
  const parentSidOf = (agent) => {
    const header = agent?.session?.header || agent?.session?.meta || {}
    return String(header?.parentSession || header?.parent || '')
  }
  const persistPushed = (agent, toolName) => {
    const sid = sidOf(agent)
    if (!sid) return
    try {
      const all = readStateFile()
      const list = new Set(Array.isArray(all[sid]) ? all[sid] : [])
      list.add(toolName)
      all[sid] = [...list]
      fsx().mkdirSync(statePath().replace(/[^\\/]+$/, ''), { recursive: true })
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
      if (!compiled.has(name)) continue
      st.registered.add(name)
      st.pushed[name] = st.pushed[name] || 1
      log('恢复已解锁的 ' + name + '（重启后不抖工具表）')
    }
  }

  function tryPush(agent, toolName, matchedKey) {
    const rule = compiled.get(toolName)
    const st = stateOf(agent)
    if (!rule || !st) return false
    const pushed = st.pushed[toolName] || 0
    if (pushed >= rule.limit) return false
    const last = st.lastTurn[toolName]
    if (last !== undefined) {
      // 同一轮不重复推；已经推过的工具冷却（默认 8 轮）过了也允许再推：
      // 只重发「已解锁」通知，不动 tools 表，前缀照样不变。
      if (st.turn <= last) return false
      if (st.turn - last < rule.cooldown) return false
    }
    st.registered.add(toolName)
    st.pushed[toolName] = pushed + 1
    st.lastTurn[toolName] = st.turn

    log('推出 ' + toolName + '（第 ' + st.pushed[toolName] + ' 次，turn=' + st.turn + '）')
    persistPushed(agent, toolName)
    const q = queueOf(agent)
    if (q && !q.unlocks.includes(toolName)) {
      q.unlocks.push(toolName)
      q.unlockKeys[toolName] = String(matchedKey || '')
    }

    return true
  }

  // 剔除我们自己注入的文本（解锁通知 / 说明变更 / notes / 上下文提醒）：
  // 它们里面带工具名和关键词，模型转述或通知被拼进同一条消息时，会把「说明里的词」当成关键词 → 连锁自解锁。
  const INJECTED_MARK = /〔(?:已解锁工具 · |工具说明已更新 · |上下文提醒)[\s\S]*?(?=\n\n|$)/g
  function stripInjected(agent, text) {
    if (!text) return ''
    let out = String(text)
    try {
      const st = stateOf(agent)
      for (const sent of (st?.injected || [])) {
        if (sent && out.includes(sent)) out = out.split(sent).join('\n')
      }
    } catch {}
    return out.replace(INJECTED_MARK, '\n')
  }

  function scan(agent, text, source = '?') {
    text = stripInjected(agent, text)
    if (!text || (!compiled.size && !compiledNotes.size)) return
    for (const toolName of compiled.keys()) {
      const key = hitKey(text, compiled.get(toolName))
      if (!key) continue
      logHit(source, text, key, 'tool:' + toolName)
      tryPush(agent, toolName, key)
    }
    // 说明（notes）：跟工具同理，命中 + 过了冷却就注入一次（可反复注入）
    for (const id of compiledNotes.keys()) {
      const nk = hitKey(text, compiledNotes.get(id))
      if (!nk) continue
      logHit(source, text, nk, 'note:' + id)
      tryNote(agent, id)
    }
  }

  /** 记录「谁、哪个词、什么上下文」触发的：排障全靠它 */
  function logHit(source, text, key, target) {
    try {
      const lower = String(text).toLowerCase()
      const raw = lower.indexOf(String(key).toLowerCase())
      const idx = raw < 0 ? 0 : raw
      const from = Math.max(0, idx - 40)
      const snippet = String(text).slice(from, Math.min(String(text).length, idx + key.length + 40)).replace(/\s+/g, ' ')
      dbg('[hit] src=' + source + ' key=' + key + ' target=' + target + ' :: ' + snippet)
    } catch {}
  }

  function tryNote(agent, id) {
    const note = compiledNotes.get(id)
    const st = stateOf(agent)
    if (!note || !st) return false
    const pushed = st.notes[id] || 0
    if (pushed >= note.limit) return false
    const last = st.noteTurn[id]
    if (last !== undefined && st.turn - last < note.cooldown) return false
    st.notes[id] = pushed + 1
    st.noteTurn[id] = st.turn
    log('注入说明 ' + id + '（第 ' + st.notes[id] + ' 次，turn=' + st.turn + '）')
    const q = queueOf(agent)
    if (q && !q.notes.includes(note.text)) q.notes.push(note.text)
    return true
  }

  // ── 统一的通知通道（2026-10-29）──
  // 往当前会话 steer 一条消息：不碰请求开头（前缀缓存照旧），下一轮第一屏就能看到。
  // 注意：steer 会被宿主当成一次「收到执行请求」，凭空多一轮回复——所以**闲话一律走 queueNotice**，
  // 只有真的要立刻说的时候才用 notify。
  let assembleSeen = false
  const lastRemoved = new Map()
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
  // 2026-10-30：原来是进程级全局数组，A 会话攒的通知会弹到 B 会话，新建的空会话也会被塞一条。
  // 现在按 sid 分桶，各发各的（扫描/触发逻辑不变，仍然扫模型自己的输出）。
  const queues = new Map() // sid -> { unlocks: [], texts: {}, extras: [] }
  const queueOf = (agentOrSid) => {
    const sid = typeof agentOrSid === 'string' ? agentOrSid.trim() : sidOf(agentOrSid)
    if (!sid) return null
    let q = queues.get(sid)
    if (!q) {
      // 会话多了别无限涨；队头是最久没动的会话
      if (queues.size > 300) queues.delete(queues.keys().next().value)
      q = { unlocks: [], unlockKeys: Object.create(null), notes: [], extras: [] }
      queues.set(sid, q)
    }
    return q
  }

  // 工具说明变更（tool-desc-pin 记在 globalThis.__ykpToolDescChanges）
  // 内置工具（pwsh / read / edit …）会被 wire 精简改写文案，那不是「人改了说明」，按规则忽略。
  const DESC_WINDOW_MS = 10 * 60 * 1000
  // 还没说过一句话的新会话不该收到「工具说明变更」这类通知：等它有了真正的用户消息再说。
  const hasUserContent = (agent) => {
    try {
      const nodes = agent?.session?.surface?.nodes || []
      return nodes.some((node) => {
        if (!node || node.role !== 'user') return false
        const kind = node?.source?.kind
        return !kind || (kind !== NOTICE_KIND && kind !== 'user-approval')
      })
    } catch {
      return false
    }
  }
  const descSent = new Map() // sid -> Set(变更 key)，同一个会话同一条说明只提示一次
  const hijacked = (name) => compiled.has(name) || compiledNotes.has('tool:' + name)
  const pendingDescNotices = (agent) => {
    const pending = globalThis.__ykpToolDescChanges
    if (!Array.isArray(pending) || pending.length === 0) return []
    if (!hasUserContent(agent)) return []
    const sid = sidOf(agent) || '?'
    let seen = descSent.get(sid)
    if (!seen) {
      // 新会话：第一次请求本来就按当前（最新）工具定义取前缀，历史变更不该补发
      seen = new Set()
      for (const change of pending) if (change) seen.add(descKeyOf(change))
      descSent.set(sid, seen)
      return []
    }
    const ignore = new Set(config.descNoticeIgnore || [])
    return pending.filter((change) => {
      if (!change) return false
      const name = String(change.name || '')
      if (ignore.has(name)) return false
      // 被 control 接管（门控/注记）的工具不在这里提示：等下一次注入时直接带最新定义
      if (hijacked(name)) return false
      // 内置工具（pwsh/read/edit…）的文案会被 wire 精简改写，跳过
      if (change.builtin) return false
      if (String(change.before || '') === String(change.after || '')) return false
      const at = Date.parse(change.at || '')
      if (!(Number.isFinite(at) ? Date.now() - at < DESC_WINDOW_MS : true)) return false
      const key = descKeyOf(change)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  const descKeyOf = (change) => String(change?.at || '') + '|' + String(change?.name || '')
  const releaseDescNotices = (agent, notes) => {
    const seen = descSent.get(sidOf(agent) || '?')
    if (!seen) return
    for (const change of notes) seen.delete(descKeyOf(change))
  }

  // ── 给别的插件用的服务 ──
  const service = {
    /** 统一通知通道：别的插件（比如 context-refresh）想跟用户说句话就走这里 */
    notify,
    /** 写一行到 tool-gate.log（给别的子插件用） */
    debug: (msg) => { try { dbg(String(msg)) } catch {} },
    /** 攒一条闲话，等下一条用户消息进来时一起带到开头（不单独开一轮回复）；按 sid 分桶 */
    queueNotice: (text, sid) => {
      const q = queueOf(sid ? String(sid) : '')
      if (!q || !text) return
      if (!q.extras.includes(String(text))) q.extras.push(String(text))
    },
    /** 手动放行（调试用） */
    release(agent, toolName) {
      return tryPush(agent, toolName)
    },
    /** 看看门控了哪些工具 */
    list() {
      return Array.from(compiled.keys())
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

  // ── 整段系统提示词冻结（前缀无论如何都不能改）─────────────────────────
  // tools 早就冻结了；sections 以前还是每次现拼，改一个字就把整条前缀缓存冲掉。
  // 现在：第一次组装后把 sections 原样存盘，之后**永远**发回这份冻结版；
  // 后面插件改说明/加说明/删说明，都只走“变更通知”这条增量通道（走 queueNotice，
  // 跟工具解锁通知同一条路，追加在对话里），前缀字节保持不变。
  const notifiedDeltas = new Map() // sid -> Set<name+NUL+hash+kind>

  const shortHash = (text) => {
    let h = 0
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
    return h
  }

  const pushNotice = (text, sid) => {
    try {
      globalThis.__toolGate?.queueNotice?.(text, sid)
    } catch {}
  }

  /** 冻结 sections，并把 live 与冻结版的差异转成增量通知。 */
  const freezeSections = (sid, assembly) => {
    const live = (Array.isArray(assembly.sections) ? assembly.sections : []).map((s) => ({
      name: String(s?.name ?? ''),
      order: s?.order,
      text: String(s?.text ?? ''),
    }))
    const frozen = __R.frozenSections(sid)
    if (!frozen) {
      __R.saveFrozenSections(sid, live)
      return
    }
    // 前缀永远用冻结版，live 一律不写回去
    assembly.sections = frozen.map((s) => ({ ...s }))

    const liveMap = new Map(live.map((s) => [s.name, s.text]))
    const frozenMap = new Map(frozen.map((s) => [s.name, s.text]))
    let seen = notifiedDeltas.get(sid)
    if (!seen) {
      seen = new Set()
      notifiedDeltas.set(sid, seen)
    }
    for (const [name, text] of liveMap) {
      const old = frozenMap.get(name)
      if (old === text) continue
      const kind = old === undefined ? 'add' : 'edit'
      const key = name + '\u0000' + shortHash(text) + '\u0000' + kind
      if (seen.has(key)) continue
      seen.add(key)
      pushNotice(
        (kind === 'add' ? '〔说明新增〕' : '〔说明变更〕') +
          name +
          '\n\n（请求开头的说明保持不变以复用缓存，以下为最新内容，以此为准）\n\n' +
          text,
        sid,
      )
    }
    for (const [name] of frozenMap) {
      if (liveMap.has(name)) continue
      const key = name + '\u0000\u0000del'
      if (seen.has(key)) continue
      seen.add(key)
      pushNotice(
        '〔说明移除〕' + name + '（请求开头的说明保持不变以复用缓存，请忽略这一段）',
        sid,
      )
    }
  }

  // 「本会话已经给模型看过的工具」= 会话里所有 request/header 里出现过的工具名 ∪ tool-addition 事件。
  // 这是单调集合：只增不减。所以只要某个工具在某个历史请求里出现过，就永远不再摘（保证前缀稳定）。
  const declaredOf = (agent, st) => {
    if (!st.declared) st.declared = new Set()
    try {
      const log = agent?.session?.snapshotEvents?.() || []
      const from = typeof st.declaredCursor === 'number' ? st.declaredCursor : 0
      for (let i = from; i < log.length; i += 1) {
        const ev = log[i]
        if (ev?.type === 'request/header') {
          for (const tool of ev.data?.header?.tools || []) {
            const name = tool?.name ?? tool?.function?.name
            if (name) st.declared.add(String(name))
          }
        } else if (ev?.type === 'developer/message') {
          const msg = ev.data?.message
          if (msg?.source?.kind !== 'tool-registry') continue
          for (const block of msg.content || []) {
            if (block?.type === 'tool-addition' && block.toolName) st.declared.add(String(block.toolName))
          }
        }
      }
      st.declaredCursor = log.length
    } catch {}
    return st.declared
  }
  /** 工具名 -> 最近一次见到的定义（用于解锁消息） */
  const defs = new Map()
  const unlockNotice = (name, matchedKey) => {
    const liveDef = globalThis.__ykpToolLive
    const def = (liveDef && typeof liveDef.get === 'function' ? liveDef.get(name) : null) || defs.get(name)
    const desc = typeof def?.description === 'string' ? def.description : ''
    const key = String(matchedKey || '').trim()
    return [
      '关键词「' + key + '」命中，已解锁工具「' + name + '」',
      desc,
    ].filter(Boolean).join('\n')
  }
  // ── 真正的门控点：请求组装时，把这个会话还没解锁的工具从工具表里摘掉 ──
  // 别的插件不用配合（照常 ctx.tools.register），规则里只写工具名。
  // 只影响「发给模型的那份 tools」；工具一直注册着，解锁后下一次请求就出现。
  ctx.on('system-prompt/assemble', (assembly, context, next) => {
    const agent = context?.agent
    try {
      ensureFresh()
      const st = stateOf(agent)
      if (!st || !assembly || !Array.isArray(assembly.tools)) return next()
      const sid = sidOf(agent)
      const nameOf = (tool) => String(tool?.name ?? tool?.function?.name ?? '')
      // 会话级快照：第一次组装时按规则过滤一次、存盘；之后永远发这一份
      // 系统提示词里 `tool:<名字>` 那段说明，对「被门控且不在快照里」的工具要一起摘掉：
      // 否则模型照着说明直接按名字调用 —— 工具其实注册着，调用会成功（绕过门控）。
      // 只做精确匹配，不做任何“名字包含”推断：
      //   ① notes 里配了什么 section 名，就摘什么（tool:goal 这种分组说明靠这条）
      //   ② 其余只有 tool:<工具名> 且该工具在规则里、又没进快照时才摘
      const dropSections = (list, visibleNames, forcedDrop) => {
        if (!Array.isArray(list)) return list
        const forced = new Set(forcedDrop || [])
        return list.filter((section) => {
          const name = String(section?.name || '')
          if (!name.startsWith('tool:')) return true
          if (forced.has(name)) return false
          if (compiledNotes.has(name)) return false
          const tool = name.slice(5)
          if (!compiled.has(tool)) return true
          return visibleNames.has(tool)
        })
      }

      // 分支/复制出来的会话：它继承的历史就是父会话的前缀，工具表和分段都必须原样继承。
      // 否则第一次组装会按当前注册表重建 → 继承来的整条历史缓存当场全废。
      let snap = __R.frozenTools(sid)
      if (!snap) {
        const parentSid = parentSidOf(agent)
        if (parentSid && parentSid !== sid) {
          const inherited = __R.frozenTools(parentSid)
          const inheritedSections = __R.frozenSections(parentSid)
          if (inherited?.tools?.length) {
            __R.saveFrozenTools(sid, inherited.tools, inherited.dropped || [])
            if (inheritedSections?.length) __R.saveFrozenSections(sid, inheritedSections)
            snap = inherited
            dbg('分支继承前缀 ' + inherited.tools.length + ' 条 · sid=' + sid + ' <- ' + parentSid)
          } else if (inheritedSections?.length) {
            __R.saveFrozenSections(sid, inheritedSections)
            dbg('分支继承分段 ' + inheritedSections.length + ' 段 · sid=' + sid + ' <- ' + parentSid)
          }
        }
      }
      if (snap) {
        // 前缀（tools/sections）继续锁死用快照；但「注入用定义」要按当前注册表刷新：
        // 被门控工具下一次解锁注入时才带最新说明/参数。
        for (const tool of assembly.tools) {
          const name = nameOf(tool)
          if (name) defs.set(name, { description: tool?.description, parameters: tool?.parameters })
        }
        const visible = new Set()
        for (const tool of snap.tools) {
          const name = nameOf(tool)
          if (!name) continue
          visible.add(name)
        }
        assembly.tools = snap.tools
        assembly.sections = dropSections(assembly.sections, visible, snap.dropped)
        freezeSections(sid, assembly)
        return next()
      }
      // 定义快照要抓「过滤前」的全量：被门控摘掉的工具也得有定义，否则解锁通知贴不出参数
      for (const tool of assembly.tools) {
        const name = nameOf(tool)
        if (name) defs.set(name, { description: tool?.description, parameters: tool?.parameters })
      }
      const declared = declaredOf(agent, st)
      const total = assembly.tools.length
      const kept = assembly.tools.filter((tool) => {
        const name = nameOf(tool)
        return !compiled.has(name) || declared.has(name)
      })
      {
        const visible = new Set(kept.map(nameOf).filter(Boolean))
        const dropped = []
        const keptSections = []
        for (const section of assembly.sections || []) {
          const name = String(section?.name || '')
          if (name.startsWith('tool:')) {
            if (compiledNotes.has(name)) { dropped.push(name); continue }
            const tool = name.slice(5)
            if (compiled.has(tool) && !visible.has(tool)) { dropped.push(name); continue }
          }
          keptSections.push(section)
        }
        assembly.sections = keptSections
        __R.saveFrozenTools(sid, kept, dropped)
        freezeSections(sid, assembly)
      }
      assembly.tools = kept
      dbg('工具表快照 ' + kept.length + ' 条（原 ' + total + ' 条）· sid=' + sid)
      return next()
    } catch (error) {
      dbg('assemble 出错：' + (error?.message || error))
      return next()
    }
  })

  // 只认「真人用户输入」：role=user 且来源不是各种注入
  const INJECT_KINDS = new Set([NOTICE_KIND, 'user-approval', 'schedule', 'reminder', 'system', 'system-reminder', 'agent-notice', 'host'])
  const isUserNode = (node) => !!node && node.role === 'user' && !INJECT_KINDS.has(String(node?.source?.kind || ''))
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
        // 只扫「真人用户输入」：注入的（门控通知、审批、定时提醒、系统提示）一律跳过
        const text = (Array.isArray(list) ? list : [list]).filter(isUserNode).map(textOf).join('\n')
        scan(agent, text, 'inbox')
        // 工具说明变更：同一套通知通道发一条独立消息（不碰前缀）
        // 工具说明变更 / 解锁 / 闲话都按会话（sid）取自己那一桶
        const q = queueOf(agent)
        const notes = pendingDescNotices(agent)
        // 解锁通知等「定义快照」到位再发（第一次请求之前还没抓过定义，参数贴不出来）
        const unlocks = q ? q.unlocks.filter((n) => defs.has(n)) : []
        if (q) q.unlocks = q.unlocks.filter((n) => !defs.has(n))
        const extras = q ? q.extras.splice(0, q.extras.length) : []
        const noteTexts = q ? q.notes.splice(0, q.notes.length) : []
        if (notes.length || unlocks.length || extras.length || noteTexts.length) {
          // 同步占位：notify → steer 会同步插消息、再触发本 handler；
          // 说明变更的「已提示」标记在 pendingDescNotices() 里同步置位，二次进入不会重发（2026-10-29 爆栈）
          dispatching = true
          const parts = []
          // 说明（note）排在工具解锁前面
          for (const text of noteTexts) parts.push(String(text))
          for (const name of unlocks) {
            parts.push(unlockNotice(name, q ? q.unlockKeys[name] : ''))
          }
          // 多个命中时不在每条后面重复声明，统一补一次
          if (unlocks.length) parts.push('仅静态命中，不是要求调用；不在 tools 列表里，直接按格式调用即可')
          for (const change of notes) {
            parts.push(['〔工具说明已更新 · ' + change.name + '〕',
              '请求开头的工具定义保持不变（为了复用缓存），以这段为新说明：',
              String(change.after || '')].join('\n'))
          }
          const requeue = () => {
            if (q) {
              q.unlocks.unshift(...unlocks)
              q.extras.unshift(...extras)
              q.notes.unshift(...noteTexts)
            }
            releaseDescNotices(agent, notes)
          }
          const chunks = parts.concat(extras)
          const sentText = chunks.join('\n\n')
          {
            // 逐段记：宿主可能把这条消息拆开/重排，整条精确匹配会失配；按段记才能都剥掉
            const st = stateOf(agent)
            if (st) {
              for (const chunk of chunks) {
                const s = String(chunk || '')
                if (!s) continue
                st.injected.unshift(s)
              }
              if (st.injected.length > 60) st.injected.length = 60
            }
          }
          notify(agent, sentText).then((ok) => {
            dispatching = false
            if (!ok) {
              requeue()
              return
            }
            log('推送通知：解锁 ' + unlocks.length + ' 个，说明 ' + noteTexts.length + ' 条，变更 ' + notes.length + ' 条')
          }).catch((error) => {
            dispatching = false
            requeue()
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

  // ── 每步只补扫「最后一条真人用户消息」（工具结果、注入、历史一概不扫）──
  try {
    ctx.on('agent/pre-step', (payload, next) => {
      try {
        const agent = payload?.agent
        const st = stateOf(agent)
        if (st && Number.isFinite(payload?.turn) && payload.turn > st.turn) st.turn = Number(payload.turn)
        let lastUser = null
        try {
          const msgs = agent?.session?.deriveMessages?.() || []
          lastUser = [...msgs].reverse().find(isUserNode) || null
        } catch {}
        if (!lastUser) {
          const msgs = Array.isArray(payload?.messages) ? payload.messages : []
          lastUser = [...msgs].reverse().find(isUserNode) || null
        }
        if (lastUser) scan(agent, textOf(lastUser), 'pre-step')
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
          // 只扫模型自己产出的文本/思考；不 dump 原始帧 JSON（会把工具定义、上下文里的字一起带进来）
          // 只看正式输出：思考帧整帧跳过（流式思考的正文在 delta 里，光排 thinking 键不够）
          const frame = payload?.frame ?? payload
          const kind = String(frame?.type || frame?.channel || '').toLowerCase()
          // 只认正经的文本帧：其它帧（工具、附件、状态）一律不看
          if (kind && !/(text|content|delta|message|assistant)/.test(kind)) return
          if (kind.includes('think') || kind.includes('reason') || kind.includes('tool')) return
          if (frame?.toolName || frame?.arguments || frame?.args) return
          scan(payload?.agent, textOf(frame), 'assistant')
        } catch {}
      })
    } catch (error) {
      warn('挂 assistant-stream 失败：', error?.message || error)
    }
  }

  log('已装：' + compiled.size + ' 条规则' + (compiled.size ? '（' + Array.from(compiled.keys()).join(', ') + '）' : ''))
}
