// /post 监听自测（不启宿主）
import { createPostWatcher } from '../lib/post-watch.js'

let failed = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) failed++
}

const flush = () => new Promise((r) => setImmediate(r))

// 1) 超时 → 收到 /post → 补推一次；再超时后 isLoggedIn=true → 自己停
{
  let waits = 0
  let pushes = 0
  let logged = false
  const ntfy = {
    config: { defaultTopic: 't' },
    async wait() {
      waits++
      if (waits === 1) return { ok: false, timedOut: true, message: null }
      if (waits === 2) return { ok: true, message: { id: 'm1', time: Math.floor(Date.now() / 1000), message: '/post' } }
      logged = true
      return { ok: false, timedOut: true, message: null }
    },
  }
  const w = createPostWatcher({
    getNtfy: () => ntfy,
    pushQr: async () => {
      pushes++
    },
    isLoggedIn: async () => logged,
    timeoutMs: 10,
    sleep: () => flush(),
  })
  w.start()
  for (let i = 0; i < 50 && w.running; i++) await flush()
  check(pushes === 1, '收到 /post 补推一次', `pushes=${pushes}`)
  check(!w.running, '登录后自己停')
  check(waits >= 3, '超时后会继续等', `waits=${waits}`)
}

// 2) 匹配到的不是 /post 之前，不会误推（wait 只回匹配消息，这里验证 push 不被空转）
{
  let pushes = 0
  const ntfy = {
    async wait() {
      return { ok: false, timedOut: true, message: null }
    },
  }
  const w = createPostWatcher({
    getNtfy: () => ntfy,
    pushQr: async () => {
      pushes++
    },
    isLoggedIn: async () => false,
    timeoutMs: 10,
    sleep: () => flush(),
  })
  w.start()
  for (let i = 0; i < 20; i++) await flush()
  check(pushes === 0, '没收到 /post 不推码')
  w.stop('测试结束')
  check(!w.running, 'stop 后停止')
}

// 3) 拿不到 ntfy 服务：不崩，返回 false
{
  const w = createPostWatcher({ getNtfy: () => null, command: '/post' })
  const ok = w.start()
  check(ok === false, '没有 ntfy 服务时安全退出')
}

// 4) 用外部 wait 函数（不经过 service）也能工作
{
  let pushed = 0
  let calls = 0
  const w = createPostWatcher({
    wait: async () => {
      calls++
      if (calls === 1) return { ok: true, message: { id: 'x', time: 1, message: '/post' } }
      return { ok: false, timedOut: true, message: null }
    },
    topic: 'abc',
    pushQr: async () => {
      pushed++
    },
    isLoggedIn: async () => true,
    timeoutMs: 10,
    sleep: () => flush(),
  })
  w.start()
  for (let i = 0; i < 30 && w.running; i++) await flush()
  check(pushed === 1, '外部 wait 也能触发补推', `pushed=${pushed}`)
  w.stop()
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exitCode = failed ? 1 : 0
