// bili-reply · 昵称缓存「后台重读」自测（不联网：fetch 用假的）
//
// 覆盖：refresh 立刻返回 / 全部排队 / 后台按批次查完 / 缓存时间被刷新
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

let failed = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) failed++
}

const dir = mkdtempSync(join(tmpdir(), 'bili-reply-names-'))
const namesCachePath = join(dir, 'names-cache.json')
const now = Date.now()
writeFileSync(
  namesCachePath,
  JSON.stringify({
    uids: {
      '111': { name: '阿一', at: now },
      '222': { name: '阿二', at: now },
      '333': { name: '阿三', at: now },
      '444': { name: '阿四', at: now },
      '555': { name: '阿五', at: now },
    },
  }),
  'utf8',
)

// 假 fetch：记下每个查过的 mid，返回「新名<mid>」
const asked = []
globalThis.fetch = async (url) => {
  const mid = String(url).split('mid=')[1]
  asked.push(mid)
  return { json: async () => ({ code: 0, data: { card: { name: '新名' + mid } } }) }
}

const handlers = {}
const ctx = {
  effect: (fn) => fn(),
  webServer: { register: ({ handler }) => { handlers.hit = handler } },
  timer: {},
  sessions: {},
  agents: { list: () => [] },
  on: () => {},
  get: () => undefined,
}

apply(ctx, {
  namesCachePath,
  namesRefreshBatch: 2,
  namesRefreshEveryMinutes: 0.05, // = 3 秒一批
  cookie: 'SESSDATA=x; DedeUserID=1',
})

const res = { writeHead() {}, end(b) { this.body = b } }
await handlers.hit({ method: 'POST', url: '/dsh-bili-reply/names/refresh' }, res)
const out = JSON.parse(res.body)
check(out.ok === true && out.mode === 'background', 'refresh 立刻返回（后台模式）')
check(out.queued === 5, '5 个全部排队', `queued=${out.queued}`)
check(out.batch === 2, '每批 2 个', `batch=${out.batch}`)
check(asked.length <= 2, '返回时最多只跑了第一批', `asked=${asked.length}`)

// 5 个 / 每批 2 个 = 3 批，批间隔 3 秒 → 等 8 秒足够
await new Promise((r) => setTimeout(r, 8000))
check(asked.length === 5, '5 个后来全部真的去查了', `asked=${asked.length}`)

const cache = JSON.parse(readFileSync(namesCachePath, 'utf8'))
check(Object.values(cache.uids).every((v) => v.at > 0), '5 个全部有了新时间')
check(cache.uids['111'] && cache.uids['111'].name === '新名111', '名字被刷新', cache.uids['111'] && cache.uids['111'].name)

rmSync(dir, { recursive: true, force: true })
console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exitCode = failed ? 1 : 0
