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
  const tools = []
  let notice = () => ''
  const agent = {
    id: 'a-' + session.id,
    session,
    counters: () => registered,
    notice: () => notice(),
    tool: () => tools[0],
    ctx: {
      tools: { register: (t) => { registered++; tools.push(t); return () => {} } },
      systemPrompt: {
        context: (opts) => {
          if (opts && typeof opts.text === 'function') notice = opts.text
          return () => {}
        },
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

// 召回现在是「当场把原文作为工具结果返回」，历史节点不动（旧 stub 还在，前缀缓存不受影响）
const recalled = await a1.tool().execute({ recall: [2] })
check('recall 原文进工具结果', recalled.text.includes('Y'.repeat(100)), recalled.text.slice(0, 60))
check('recall 不动历史节点', (resultText(s1, 'c2') || '').startsWith('⟨dropped #2'), resultText(s1, 'c2'))
const missing = await a1.tool().execute({ recall: [999] })
check('recall 未找到会报', missing.text.includes('未找到：#999'), missing.text)

// 召回正文按「新结果」记账：本体不打 [#id]，下一步默认折叠，keep 才留
assistant(s1, [{ id: 'd2', name: 'steward', args: { recall: [2] } }])
s1.append('tool/result', { message: { role: 'tool', toolCallId: 'd2', content: [{ type: 'text', text: recalled.text }] } })
await tick()
check('召回结果不打 [#id]', (resultText(s1, 'd2') || '').startsWith('⟨decided⟩'), resultText(s1, 'd2'))
check('召回结果进通知', /#3\b/.test(a1.notice()), a1.notice())
assistant(s1, [], 'ok')
await tick()
check('召回结果默认折叠', (resultText(s1, 'd2') || '').startsWith('⟨dropped #3'), resultText(s1, 'd2'))

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

// 日志兜底：模拟宿主重启（新实例、档案为空），surface 已经是 stub，日志里还有 [#3] 原节点
const s3 = new Session('s3')
s3.append('assistant/message', { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c9', name: 'pwsh', arguments: '{}' }] } })
s3.append('tool/result', { message: { role: 'tool', toolCallId: 'c9', content: [{ type: 'text', text: '[#3] ' + 'Q'.repeat(3000) }] } })
s3.append('tool/result', { message: { role: 'tool', toolCallId: 'c9', content: [{ type: 'text', text: '⟨dropped #3 pwsh · 3005 chars⟩' }] } }, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } })
const a3 = makeAgent(s3)
apply(ctxOf([a3]), { minChars: 100 })
await tick()
check('日志兜底前是 stub', (resultText(s3, 'c9') || '').startsWith('⟨dropped #3'))
const out3 = await a3.tool().execute({ recall: [3] })
check('日志兜底召回成功', out3.text.includes('QQQ') && out3.text.includes('日志兜底'), out3.text.slice(0, 60))

// silence：静默下一批通知，倒计时走完后第一次通知带「（silence 已结束）」
const s4 = new Session('s4')
const a4 = makeAgent(s4)
apply(ctxOf([a4]), { minChars: 100 })
await tick()
assistant(s4, [{ id: 'e1', name: 'pwsh', args: { command: 'a' } }])
s4.append('tool/result', { message: { role: 'tool', toolCallId: 'e1', content: [{ type: 'text', text: 'A'.repeat(300) }] } })
check('通知默认出现', /^\[steward\] 上一步结果 #\d+/.test(a4.notice()), a4.notice())
assistant(s4, [{ id: 'e2', name: 'steward', args: { silence: 1 } }])
assistant(s4, [{ id: 'e3', name: 'pwsh', args: { command: 'b' } }])
s4.append('tool/result', { message: { role: 'tool', toolCallId: 'e3', content: [{ type: 'text', text: 'B'.repeat(300) }] } })
const quiet = a4.notice()
check('silence 之后不弹通知', quiet === '', quiet)
assistant(s4, [{ id: 'e4', name: 'pwsh', args: { command: 'c' } }])
s4.append('tool/result', { message: { role: 'tool', toolCallId: 'e4', content: [{ type: 'text', text: 'C'.repeat(300) }] } })
const resumed = a4.notice()
check('silence 结束标记', resumed.includes('silence 已结束'), resumed)

console.log(fail === 0 ? '\n全部通过' : `\n失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
