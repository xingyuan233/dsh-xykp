// dsh-ntfy 自测（不启宿主，直接打 ntfy.sh）
// 覆盖：推文本 / 等消息 / 正则匹配 / 文件附件 / 超时 / 默认主题
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { push, wait } from '../lib/index.js'

const topic = 'dsh-ntfy-selftest-' + Math.random().toString(36).slice(2, 8)
const cfg = { baseUrl: 'https://ntfy.sh', defaultTopic: topic, pollMs: 800, requestTimeoutMs: 15000 }

let failed = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) failed++
}
const nowSec = () => Math.floor(Date.now() / 1000)

// 1) 推一条文本
const since1 = nowSec() - 5
const p1 = await push(cfg, { message: 'hello-ntfy', title: '自测', tags: 'white_check_mark' })
check(p1.ok && !!p1.id, '推送文本消息', `id=${p1.id} status=${p1.status}`)

// 2) 等到它
const w1 = await wait(cfg, { match: 'hello-ntfy', timeoutMs: 20000, since: since1 })
check(w1.ok && w1.message?.message === 'hello-ntfy', '等待到刚才那条消息', `id=${w1.message?.id}`)

// 3) 正则匹配 /post
const p2 = await push(cfg, { message: '/post 来张码' })
const w2 = await wait(cfg, { match: 're:^/post', timeoutMs: 20000, since: since1 })
check(w2.ok && /^\/post/.test(w2.message?.message || ''), 're: 正则匹配 /post', `msg=${w2.message?.message}`)

// 4) 文件附件
const dir = mkdtempSync(join(tmpdir(), 'ntfy-test-'))
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const file = join(dir, 'qr.png')
writeFileSync(file, png)
const since4 = nowSec() - 5
const p3 = await push(cfg, { message: 'qr attached', filePath: file, title: '码' })
check(p3.ok && !!p3.id, '推送文件附件', `id=${p3.id}`)
const w3 = await wait(cfg, { match: (m) => m?.attachment?.name === 'qr.png', timeoutMs: 20000, since: since4 })
check(w3.ok && w3.message?.attachment?.name === 'qr.png', '附件名保留', `att=${w3.message?.attachment?.name} size=${w3.message?.attachment?.size}`)

// 5) 超时
const t0 = Date.now()
const w4 = await wait(cfg, { match: 'never-arrives', timeoutMs: 2500, since: nowSec() })
check(w4.timedOut === true && w4.message === null, '超时返回 timedOut', `${Date.now() - t0}ms`)

// 6) 不传 topic 用 defaultTopic
const p5 = await push(cfg, { message: 'default-topic-ok' })
check(p5.topic === topic && p5.ok, '不传 topic 用 defaultTopic')

// 7) apply 装配：服务 + 两个工具
const { apply } = await import('../lib/index.js')
const services = {}
const tools = []
const fakeCtx = {
  provide(n, s) {
    services[n] = s
  },
  tools: {
    register(def) {
      tools.push(def)
      return () => {}
    },
  },
  on() {},
}
apply(fakeCtx, { defaultTopic: topic })
check(services.ntfy && typeof services.ntfy.push === 'function', 'ctx.provide 注册 ntfy 服务')
check(
  tools.map((t) => t.name).join(',') === 'ntfy_push,ntfy_wait',
  '注册 ntfy_push / ntfy_wait',
  tools.map((t) => t.name).join(','),
)
const toolPush = tools.find((t) => t.name === 'ntfy_push')
const toolRes = await toolPush.execute({ message: 'via-tool' })
check(toolRes.ok && toolRes.topic === topic, '工具 ntfy_push 可用', `id=${toolRes.id}`)

// 清理：删掉测试消息
for (const id of [p1.id, p2.id, p3.id, p5.id, toolRes.id].filter(Boolean)) {
  try {
    await fetch(`https://ntfy.sh/${topic}/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(8000) })
  } catch {}
}
rmSync(dir, { recursive: true, force: true })

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exitCode = failed ? 1 : 0
