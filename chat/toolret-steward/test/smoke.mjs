// 冒烟测试（node test/smoke.mjs）：打标 / 折叠 / keep / recall / 续号 / 回流防递归 / 定时刷新不重挂
import { apply } from '../lib/index.js'

class Session {
  constructor(id = 's1') {
    this.id = id
    this.events = []
    this.surface = { nodes: [] }
    this.onAppend = null
  }
  eventAt(seq) { return this.events[seq] }
  append(type, data, opts) {
    const seq = this.events.length
    this.events.push({ type, data })
    if (opts?.surfaceOp?.op === 'replace') this.surface.nodes = this.surface.nodes.map((n) => (n === opts.surfaceOp.startSeq ? seq : n))
    else this.surface.nodes.push(seq)
    if (this.onAppend) this.onAppend({ type, data }) // 模拟宿主：append 也会发 session/event
    return seq
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function makeAgent(session) {
  let registered = 0
  const handlers = []
  const agent = {
    id: 'a-' + session.id,
    session,
    counters: () => registered,
    ctx: {
      tools: { register: () => { registered++; return () => {} } },
      systemPrompt: {
        context: () => () => {},
        section: () => () => {},
      },
      on: (ev, fn) => { if (ev === 'session/event') handlers.push(fn); return () => {} },
      get: () => undefined,
    },
  }
  agent.emit = (event) => handlers.forEach((fn) => fn('s', event))
  session.onAppend = (event) => agent.emit(event)
  return agent
}

function assistant(session, calls, text) {
  const content = []
  if (text) content.push({ type: 'text', text })
  for (const c of calls || []) content.push({ type: 'tool-call', id: c.id, name: c.name, arguments: JSON.stringify(c.args || {}) })
  session.append('assistant/message', { message: { role: 'assistant', content } })
}

function resultText(session, callId) {
  for (const seq of session.surface.nodes) {
    const ev = session.eventAt(seq)
    if (ev?.type !== 'tool/result') continue
    if (ev.data.message?.toolCallId === callId) return ev.data.message.content.map((b) => b.text).join('\n')
  }
}

let fail = 0
const check = (n, ok, extra = '') => { console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : extra); if (!ok) fail++ }
const ctxOf = (agents) => ({ agents: { list: () => agents }, get: () => undefined, on: () => () => {} })

const s1 = new Session()
const a1 = makeAgent(s1)
apply(ctxOf([a1]), { minChars: 2000, refreshMs: 20 })
await new Promise((r) => setTimeout(r, 120))
check('定时刷新不重复挂载', a1.counters() === 1, String(a1.counters()))

assistant(s1, [{ id: 'c1', name: 'pwsh', args: { command: 'dir' } }])
s1.append('tool/result', { message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'X'.repeat(5000) }] } })
await tick()
await tick()
check('打标且不递归', (resultText(s1, 'c1') || '').startsWith('[#1] '), (resultText(s1, 'c1') || '').slice(0, 10))
check('surface 节点不膨胀', s1.surface.nodes.length < 8, String(s1.surface.nodes.length))

assistant(s1, [{ id: 'd1', name: 'steward', args: { keep: [1] } }])
await tick()
check('keep 保留原文', (resultText(s1, 'c1') || '').startsWith('[#1] XXXX'), String((resultText(s1, 'c1') || '').length))

assistant(s1, [{ id: 'c2', name: 'pwsh', args: { command: 'rg foo' } }])
s1.append('tool/result', { message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'Y'.repeat(5000) }] } })
await tick()
assistant(s1, [], 'ok')
await tick()
check('默认折叠 stub', (resultText(s1, 'c2') || '').startsWith('⟨dropped #2'), resultText(s1, 'c2'))

assistant(s1, [{ id: 'd2', name: 'steward', args: { recall: [2] } }])
await tick()
check('recall 铺回', (resultText(s1, 'c2') || '').startsWith('[#2] YYYY'), String((resultText(s1, 'c2') || '').length))

const s2 = new Session('s2')
s2.append('assistant/message', { message: { role: 'assistant', content: [] } })
s2.append('tool/result', { message: { role: 'tool', toolCallId: 'old', content: [{ type: 'text', text: '[#9] 旧' }] } })
const a2 = makeAgent(s2)
apply(ctxOf([a2]), { minChars: 100 })
await tick()
assistant(s2, [{ id: 'c3', name: 'read', args: { file_path: 'a.md' } }])
s2.append('tool/result', { message: { role: 'tool', toolCallId: 'c3', content: [{ type: 'text', text: 'Z'.repeat(300) }] } })
await tick()
check('续号 #10', (resultText(s2, 'c3') || '').startsWith('[#10] '), (resultText(s2, 'c3') || '').slice(0, 12))

console.log(fail === 0 ? '\n全部通过' : `\n失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
