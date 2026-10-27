// dsh-prosecutor 自测（不真的拉起进程）
//
// 覆盖：端口探活、ensureRunning 的三条路（已在跑 / 没在跑→拉起→探到 / dryRun）
import net from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { probe, ensureRunning } from '../lib/index.js'

let failed = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) failed++
}

// 开一个临时端口当「活着的 prosecutor」
const server = net.createServer((s) => s.end())
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

check(await probe(port, 800) === true, '端口在听 → 探活成功')
check(await probe(port + 1 > 65535 ? 1 : port + 1, 500) === false, '端口没听 → 探活失败')

// 已在跑 → 什么都不做
let spawned = 0
const r1 = await ensureRunning({ port }, {
  probe: async () => true,
  spawn: async () => { spawned++; return {} },
  wait: async () => {},
})
check(r1.running && !r1.started && spawned === 0, '已在跑就不重复拉起')

// 没在跑 → 拉起 → 第二次探到
const r2 = await ensureRunning({ port, dryRun: false }, {
  probe: async () => spawned >= 1, // 拉起之后才 true
  spawn: async () => { spawned++; return { pid: 1234 } },
  wait: async () => {},
})
check(r2.started && r2.running && spawned === 1, '没在跑时拉起一次并确认起来')

// 拉起失败 → 记原因，不抛
const r3 = await ensureRunning({ port }, {
  probe: async () => false,
  spawn: async () => { throw new Error('boom') },
  wait: async () => {},
})
check(!r3.running && /boom/.test(r3.reason || ''), '拉起失败时返回原因')

// dryRun 不动手
const before = spawned
const r4 = await ensureRunning({ port, dryRun: true }, {
  probe: async () => false,
  spawn: async () => { spawned++; return {} },
  wait: async () => {},
})
check(r4.reason === 'dry-run' && spawned === before, 'dryRun 不拉起')

await new Promise((r) => server.close(r))

// ---- 2026-10-27 新加：哈希 / 环境变量 ----
import { hashOf, envFor } from '../lib/index.js'

const scriptPath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '..', 'tools', 'prosecutor', 'prosecutor.mjs')
const h1 = hashOf({ machineId: 'xy', ntfyTopic: 't1' }, scriptPath)
const h2 = hashOf({ machineId: 'xy', ntfyTopic: 't2' }, scriptPath)
check(h1 !== h2, '配置变了哈希就变')
check(hashOf({ machineId: 'xy', ntfyTopic: 't1' }, scriptPath) === h1, '配置没变哈希稳定')

const env = envFor({ machineId: 'xy', ntfyTopic: 'ch', checkIntervalMinutes: 5, dshPort: 3080 })
check(
  env.DSH_PROSECUTOR_MACHINE_ID === 'xy' && env.DSH_PROSECUTOR_TOPIC === 'ch' &&
    env.DSH_PROSECUTOR_CHECK_INTERVAL_MINUTES === '5' && env.DSH_PROSECUTOR_DSH_PORT === '3080',
  '配置通过环境变量传给 prosecutor',
)

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exitCode = failed ? 1 : 0


