// 离线自测 preset-loader：注册、快照、diff、热重载回滚
// 用法：node test/preset-loader.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../storage/preset-loader/index.js'

const logs = []
const origLog = console.log
const origWarn = console.warn
console.log = (...a) => logs.push(a.join(' '))
console.warn = (...a) => logs.push(a.join(' '))

const dir = mkdtempSync(join(tmpdir(), 'preset-loader-'))
mkdirSync(join(dir, 'demo'))
const file = join(dir, 'demo', 'preset.yml')
const v1 = `id: demo
name: 示例
plugins:
  - id: a
    name: 'x'
`
writeFileSync(file, v1)

const registered = new Map()
let broken = false
const ctx = {
  agentPresets: {
    list: async () => [...registered.keys()].map((id) => ({ id, ...(broken ? { broken: '故意的' } : {}) })),
    register: async (def) => {
      registered.set(def.id, def)
      return async () => registered.delete(def.id)
    },
  },
  on: () => {},
}

apply(ctx, { dir, debounceMs: 50 })
await new Promise((r) => setTimeout(r, 300))

console.log('1) 注册后：', [...registered.keys()].join(','))
console.log('2) 快照存在：', existsSync(join(dir, 'demo', '.last-read.json')), ' 记录了 sha：', JSON.parse(readFileSync(join(dir, 'demo', '.last-read.json'), 'utf8')).sha256.slice(0, 8))

// 改内容
writeFileSync(file, v1.replace('name: 示例', 'name: 示例（改）') + '  - id: b\n    name: y\n')
await new Promise((r) => setTimeout(r, 400))
console.log('3) 改完重新注册：', logs.some((l) => l.includes('检测到改动，重注册 demo')))
console.log('4) 日志里有 diff：', logs.some((l) => l.includes('demo 的改动') && l.includes('+name: 示例（改）')))
console.log('5) 快照更新：', JSON.parse(readFileSync(join(dir, 'demo', '.last-read.json'), 'utf8')).sha256 !== JSON.parse(readFileSync(join(dir, 'demo', '.last-read.json'), 'utf8')).sha256 ? '?' : JSON.parse(readFileSync(join(dir, 'demo', '.last-read.json'), 'utf8')).content.includes('示例（改）'))

// 坏掉的改动：应该回滚
broken = true
writeFileSync(file, v1)
await new Promise((r) => setTimeout(r, 400))
console.log('6) 坏改动触发回滚：', logs.some((l) => l.includes('回滚')) || logs.some((l) => l.includes('装载失败')))

console.log('---- 日志 ----')
for (const line of logs) origLog(line)
process.exit(0)
