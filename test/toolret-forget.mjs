// 离线自测 toolret-forget：选序号折叠、占位替换、配对不断
import { foldSelection, FOLDED } from '../chat/toolret-forget/fold.js'

const events = new Map()
let nextSeq = 100
const appended = []
const surface = { nodes: [1, 2, 3, 4] }

const assistant = {
  type: 'assistant/message',
  data: {
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: '我同时查三样东西' },
        { type: 'tool-call', id: 'c1', name: 'search', arguments: '{}' },
        { type: 'tool-call', id: 'c2', name: 'fetch', arguments: '{}' },
        { type: 'tool-call', id: 'c3', name: 'read', arguments: '{}' },
      ],
    },
  },
}
const result = (id, name, text) => ({
  type: 'tool/result',
  data: { message: { role: 'tool', toolCallId: id, source: { kind: 'tool', callId: id }, content: [{ type: 'text', text }] } },
})

events.set(1, assistant)
events.set(2, result('c1', 'search', '搜索结果：很长很长'))
events.set(3, result('c2', 'fetch', '网页正文：也很长'))
events.set(4, result('c3', 'read', '文件内容：同样长'))

const session = {
  surface,
  eventAt: (seq) => events.get(seq),
  deriveEventMessage: (event) => event.data?.message,
  append: (type, data, opts) => {
    appended.push({ type, data, opts })
    const seq = nextSeq++
    if (type === 'tool/result' && opts?.surfaceOp?.op === 'replace') {
      events.set(seq, { type, seq, data })
      const at = surface.nodes.indexOf(opts.surfaceOp.startSeq)
      if (at >= 0) surface.nodes[at] = seq
      else surface.nodes.push(seq)
    }
    return { seq }
  },
}

const ctx = { get: () => undefined }

const out = foldSelection(ctx, session, { step: 1, forget: [2] })
console.log('1) 折叠了：', JSON.stringify(out.folded))
console.log('2) 只剩 c2 被换：', appended.filter((a) => a.type === 'tool/result').length === 1)

const replaced = appended.find((a) => a.type === 'tool/result').data.message
console.log('3) 占位文案：', replaced.content[0].text)
console.log('4) 占位里带标记：', replaced.content[0].text.startsWith(FOLDED), ' callId 还在：', replaced.toolCallId === 'c2')

// 再来一次：keep 语义
const out2 = foldSelection(ctx, session, { step: 1, keep: [1] })
console.log('5) keep=[1] → 折叠其余：', out2.folded.map((x) => x.index).join(','))

// 再来一次：已经折叠的不会重复折
const out3 = foldSelection(ctx, session, { step: 1, forget: [2] })
console.log('6) 重复折叠被跳过：', out3.folded.length === 0)
