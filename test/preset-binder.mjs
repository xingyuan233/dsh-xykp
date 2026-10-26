// 离线自测 preset-binder：字段是否齐全、running/endedAt 语义
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../chat/preset-binder/index.js'

const dir = mkdtempSync(join(tmpdir(), 'preset-binder-'))
const tablePath = join(dir, 'preset-binder.json')
const handlers = new Map()

const projections = {
  title: '千歌 (1)',
  modelSelection: { lastUsed: { provider: 'deepseek-account', model: 'deepseek-flash' }, next: null },
  tokenUsage: { totals: { uncachedInputTokens: 1307, outputTokens: 65029, cacheReadTokens: 1254144, cacheWriteTokens: 0 } },
  contextPressure: { contextWindow: 1048576, projectedTokens: 176121 },
  sessionListMetadata: { blank: false, lastPromptAt: Date.now() },
  sessionStats: { turns: 13, steps: 91 },
}

const agent = {
  id: 'session-abc',
  status: 'running',
  options: { provider: 'deepseek-account', model: 'deepseek-flash' },
  session: { id: 'session-abc' },
  ctx: { on: (name, fn) => handlers.set(name, fn) },
}

const ctx = {
  agents: { list: () => [agent] },
  agentPresets: { composedPreset: () => 'alive', list: async () => [{ id: 'alive', name: '千歌' }] },
  get: (name) => (name === 'sessionProjections' ? { stateOf: (_s, key) => projections[key] } : undefined),
  on: () => {},
}

apply(ctx, { tablePath, refreshMs: 200 })
await new Promise((r) => setTimeout(r, 400))

const read = () => JSON.parse(readFileSync(tablePath, 'utf8'))
let t = read()
const ok = t.presets.alive.sessions['session-abc']
console.log('1) 表：', JSON.stringify(t.presets.alive, null, 2))
console.log('2) 字段齐：', ['title', 'provider', 'model', 'running', 'startedAt', 'endedAt', 'lastActivityAt', 'turns', 'tokens', 'context'].every((k) => k in ok))
console.log('3) 跑着时 endedAt 为 null：', ok.endedAt === null)

// 收尾：状态转 idle
agent.status = 'idle'
handlers.get('agent/status')?.()
await new Promise((r) => setTimeout(r, 400))
t = read()
const done = t.presets.alive.sessions['session-abc']
console.log('4) 结束后 running=false、endedAt 有值：', done.running === false && !!done.endedAt)
console.log('5) token 合计：', done.tokens.total, '（应为', 1307 + 65029 + 1254144 + 0, '）')
console.log('6) active =', t.presets.alive.active)
process.exit(0)
