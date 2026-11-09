// finch 插件自测：假 DSH 宿主 + 真 bridge + 真服务器。
//
// 跑法（需要 bridge 在本机 8710 跑着）：
//   node plugins/comms/finch/test/finch-test.mjs
//
// 覆盖：注入（agent.steer）、source.kind、自动回发（session/event）、工具注册。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROJECT = 'D:\\devoding\\Python\\Finch'
const PLUGIN = process.env.FINCH_PLUGIN_PATH
  || 'D:\\AI\\DeepseekHarness\\plugins\\comms\\whaleisle\\lib\\index.js'
const PY = 'D:\\Program-Files\\Python\\312\\python.exe'

const env = { ...process.env, PYTHONPATH: PROJECT, FINCH_SERVER: 'https://114.215.205.181' }
const probe = (...args) => execFileSync(PY, [join(PROJECT, 'tests', 'bot_probe.py'), ...args], {
  env,
  encoding: 'utf8',
}).trim()

const dshHome = mkdtempSync(join(tmpdir(), 'finch-dsh-'))
process.env.DSH_HOME = dshHome

const BRIDGE_CONFIG = process.env.WHALEISLE_BRIDGE_CONFIG
  || (process.env.LOCALAPPDATA + '\\Finch\\bridge.json')

const config = {
  bridgeUrl: 'http://127.0.0.1:8710',
  bridgeToken: JSON.parse(
    execFileSync(PY, ['-c', `import json;print(json.dumps(json.load(open(r"${BRIDGE_CONFIG}",encoding="utf-8"))))`], { encoding: 'utf8' })
  ).api_token,
  target: 'session-test-session-0001',
  autoReply: true,
  pollWait: 1,
}

const convId = probe('conv')
console.log('conv:', convId)

// ---- 假宿主 ---------------------------------------------------------------
const events = { steer: [], followup: [], tools: [], sections: [], listeners: [] }
const agent = {
  session: { id: 'session-test-session-0001', header: {} },
  ctx: {},
  async steer(message) { events.steer.push(message) },
  async followup(message) { events.followup.push(message) },
}
const agents = {
  get(id) {
    if (id === 'session-test-session-0001' || id === 'test-session-0001' || id === 'test-session-0001'.replace(/^/, 'session-')) return agent
    return null
  },
  async resume({ resumeSessionId }) {
    if (String(resumeSessionId).includes('test-session-0001')) return { agent }
    throw new Error('unknown session ' + resumeSessionId)
  },
}
const ctx = {
  agents,
  tools: { register(tool) { events.tools.push(tool) } },
  systemPrompt: { section(section) { events.sections.push(section) } },
  on(name, fn) { if (name === 'session/event') events.listeners.push(fn) },
  get() { return null },
}

const plugin = await import('file:///' + PLUGIN.replaceAll('\\', '/'))
await plugin.apply(ctx, config)
console.log('plugin applied; tools:', events.tools.map((t) => t.name).join(','))
assert.deepEqual(events.tools.map((t) => t.name).sort(), ['finch_read', 'finch_send', 'finch_status'])
assert.equal(events.sections.length, 1)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- 1) 注入 ---------------------------------------------------------------
const text = 'plugin-test-' + Date.now()
probe('send', '--conv', convId, '--text', text)
let injected = null
for (let i = 0; i < 40; i += 1) {
  injected = events.steer.find((message) =>
    (message.content || []).some((block) => (block.text || '').includes(text)))
  if (injected) break
  await sleep(500)
}
assert.ok(injected, 'message was not injected into the fake agent')
assert.ok(injected.content[0].text.includes('[雀语]'), 'missing channel prefix')
assert.equal(injected.source.kind, 'plugin:finch', 'missing source kind')
console.log('injected:', injected.content[0].text)

// ---- 2) 自动回发 -----------------------------------------------------------
const replyText = 'auto-reply-' + Date.now()
for (const listener of events.listeners) {
  listener({ id: 'session-test-session-0001' },
    { type: 'user/message', data: { source: { kind: 'plugin:finch' } } })
  await sleep(10)
  listener({ id: 'session-test-session-0001' },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: replyText }] } } })
  await sleep(10)
  listener({ id: 'session-test-session-0001' }, { type: 'turn/end', data: {} })
}
await sleep(1500)
const history = probe('history', '--conv', convId, '--limit', '8')
assert.ok(history.includes(replyText), 'auto reply was not sent to the chat')
console.log('auto reply delivered')

// ---- 3) 工具 ---------------------------------------------------------------
const send = events.tools.find((tool) => tool.name === 'finch_send')
const result = await send.execute({ conversation_id: convId, text: 'tool-send-' + Date.now() })
assert.ok(result, 'finch_send returned nothing')
const status = events.tools.find((tool) => tool.name === 'finch_status')
const statusResult = await status.execute({})
assert.ok(JSON.stringify(statusResult).includes('connected'))

// ---- 4) 状态落盘 -----------------------------------------------------------
const statePath = join(dshHome, 'xykp', 'finch', 'state.json')
assert.ok(existsSync(statePath), 'state file missing')
console.log('state:', JSON.parse(execFileSync(PY, ['-c', `import json;print(open(r"${statePath}",encoding="utf-8").read())`], { encoding: 'utf8' })).cursor)

console.log('\nFINCH PLUGIN TEST OK')
process.exit(0)
