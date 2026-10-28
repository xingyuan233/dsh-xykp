// 离线自测：旧位置的表会搬到 <DSH_HOME>/xykp/preset-binder/preset-binder.json
// 用法：node test/migrate-test.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const home = mkdtempSync(join(tmpdir(), 'preset-binder-home-'))
process.env.DSH_HOME = home

const legacy = join(home, 'storages', 'preset-binder.json')
const next = join(home, 'xykp', 'preset-binder', 'preset-binder.json')
mkdirSync(join(home, 'storages'), { recursive: true })
writeFileSync(
  legacy,
  JSON.stringify({
    version: 2,
    updatedAt: '2026-10-28T00:00:00.000Z',
    presets: { alive: { active: 'session-old', name: '千歌', sessions: { 'session-old': { title: '旧会话' } } } },
  }),
  'utf8',
)

const agent = {
  id: 'session-new',
  status: 'idle',
  options: {},
  session: { id: 'session-new' },
  ctx: { on: () => {} },
}

const ctx = {
  agents: { list: () => [agent] },
  agentPresets: { composedPreset: () => 'alive', list: async () => [{ id: 'alive', name: '千歌' }] },
  get: () => undefined,
  on: () => {},
}

apply(ctx, { refreshMs: 200 })
await new Promise((r) => setTimeout(r, 500))

const okExists = existsSync(next)
const table = okExists ? JSON.parse(readFileSync(next, 'utf8')) : null
console.log('1) 新位置有表：', next, okExists)
console.log('2) 旧数据还在：', !!table?.presets?.alive?.sessions?.['session-old'])
console.log('3) 旧文件已搬走：', !existsSync(legacy))
process.exit(okExists && table?.presets?.alive?.sessions?.['session-old'] && !existsSync(legacy) ? 0 : 1)
