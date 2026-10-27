// dsh-prosecutor · 消息端点自测（不联网、不真发消息）
//
// 覆盖：/dsh-prosecutor/send 能塞进会话（followup）、会话不在时报原因、没给消息报原因
import { join } from 'node:path'
import { apply } from '../lib/index.js'

let failed = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) failed++
}

const sent = []
const handlers = {}
const ctx = {
  effect: (fn) => fn(),
  webServer: { register: ({ handler }) => { handlers.hit = handler } },
  timer: {},
  agents: {
    get: (id) => (id === 'session-abc' || id === 'abc' ? { followup: async (m) => { sent.push(m) } } : null),
  },
  on: () => {},
  get: () => undefined,
}

apply(ctx, {
  port: 1, // 探不到也没关系（dryRun 不会拉起）
  dryRun: true,
  machineId: 'xy',
  hashPath: join(process.env.TEMP || '.', 'prosecutor-test-hash-' + Date.now()),
})

const call = async (body) => {
  const req = {
    method: 'POST',
    url: '/dsh-prosecutor/send',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body))
    },
  }
  const res = { writeHead() {}, end(b) { this.body = b } }
  await handlers.hit(req, res)
  return JSON.parse(res.body)
}

const r1 = await call({ session: 'session-abc', text: '测试消息' })
check(r1.ok === true, '能发进会话')
check(sent.length === 1 && sent[0].content[0].text === '测试消息', 'followup 收到消息')
check(sent[0].source && sent[0].source.kind === 'plugin:dsh-prosecutor', '带 source.kind（缺了会让会话 projection 崩）')

const r2 = await call({ session: 'session-nope', text: 'x' })
check(r2.ok === false && /会话不在/.test(r2.reason || ''), '会话不在时报原因', r2.reason)

const r3 = await call({ session: 'session-abc' })
check(r3.ok === false && /没给消息/.test(r3.reason || ''), '没给消息时报原因', r3.reason)

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exitCode = failed ? 1 : 0
