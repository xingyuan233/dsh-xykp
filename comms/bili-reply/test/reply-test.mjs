// bili-reply 自测（不联网）
//
// 覆盖：绑定解析、本地队列（入队去重 / 裁剪保留 uid / 取批 / 消费）、一轮 tick 的拉取与处理
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTarget, render, keyOf, _internal, SOURCE_KIND } from '../lib/index.js'
import { loadQueue, saveQueue, enqueue, trim, take, consume } from '../lib/queue.js'

let failed = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) failed++
}

// ── 绑定解析 ──
const binder = { presets: { alive: { active: 'session-alive' } } }
check(resolveTarget({ preset: 'alive' }, binder).sessionId === 'session-alive', '预设优先')
check(resolveTarget({ preset: 'x' }, binder).via === 'none', '预设没活跃会话 → 不推')
check(resolveTarget({ session: 's' }, binder).via === 'session', '回退到会话')

// ── 队列：入队去重 ──
const q = { name: 't', items: [], seen: {}, lastPullAt: 0 }
const items = [
  { key: 'at:1', kind: 'at', id: '1', mid: 111, at: 1 },
  { key: 'at:2', kind: 'at', id: '2', mid: 222, at: 2 },
]
check(enqueue(q, items) === 2, '首次入队 2 条')
check(enqueue(q, items) === 0, '同样的条目不会重复入队')
q.seen['at:3'] = { at: Date.now() }
check(enqueue(q, [{ key: 'at:3', kind: 'at', id: '3', mid: 333, at: 3 }]) === 0, 'seen 里处理过的不会再入队')

// ── 队列：裁剪保留 keepUids ──
const big = { name: 't', items: [], seen: {}, lastPullAt: 0 }
for (let i = 0; i < 20; i++) {
  big.items.push({ key: `at:${i}`, kind: 'at', id: String(i), mid: i === 5 ? 3546798887013093 : 1000 + i, at: i })
}
const dropped = trim(big, { maxQueue: 5, keepUids: [3546798887013093] })
check(big.items.length === 5, '裁剪到 maxQueue', `len=${big.items.length} dropped=${dropped}`)
check(big.items.some((x) => x.mid === 3546798887013093), 'keepUids 里的条目被保留')
check(dropped === 15, '删掉的数量正确')

// ── 取批 / 消费 ──
const b2 = take(big, 2)
check(b2.length === 2, 'take 按 maxPerTick 取')
consume(big, b2)
check(big.items.length === 3 && big.seen[b2[0].key], '消费后出队并记 seen')

// ── 一轮 tick：队列空 → 拉 → 只处理 maxPerTick 条 ──
const dir = mkdtempSync(join(tmpdir(), 'bili-reply-'))
const queuePath = join(dir, 'queue.json')
const delivered = []
const fetched = [
  { key: 'at:201', kind: 'at', id: '201', mid: 1, at: 21, nickname: 'A', content: '一' },
  { key: 'at:202', kind: 'at', id: '202', mid: 2, at: 22, nickname: 'B', content: '二' },
  { key: 'at:203', kind: 'at', id: '203', mid: 3, at: 23, nickname: 'C', content: '三' },
]
const deps = {
  loadBinder: async () => ({ presets: { alive: { active: 'session-alive' } } }),
  loadQueue,
  saveQueue,
  fetchItems: async () => fetched,
  deliver: async (ctx, sid, text) => { delivered.push(text) },
}
const cfg = { preset: 'alive', queuePath, maxPerTick: 2, tickMinutes: 3, maxQueue: 120, keepUids: [] }

const t1 = await _internal.tick({}, cfg, deps)
check(t1.pulled === 3, '第一次把 3 条全拉到本地', `pulled=${t1.pulled}`)
check(t1.done === 2, '一次只处理 2 条', `done=${t1.done}`)
check(t1.queue === 1, '队列里还剩 1 条', `queue=${t1.queue}`)
check(existsSync(queuePath), '队列落盘')

const t2 = await _internal.tick({}, cfg, deps)
check(t2.pulled === 0, '队列非空时不再去接口拉', `pulled=${t2.pulled}`)
check(t2.done === 1 && t2.queue === 0, '把剩下的 1 条处理完')

const t3 = await _internal.tick({}, cfg, deps)
check(t3.pulled === 0, '拉过的不再重复入队（接口还是返回那 3 条）', `pulled=${t3.pulled}`)

const before = readFileSync(queuePath, 'utf8')
await _internal.tick({}, { ...cfg, dryRun: true }, deps)
check(readFileSync(queuePath, 'utf8') === before, 'dryRun 不写队列')

// ── deliverDefault：必须用 createUserMessage（带 source.kind）并 followup 真的开一轮 ──
const followedUp = []
const fakeAgent = { followup: async (m) => { followedUp.push(m) } }
const ctxDeliver = { agents: { get: (id) => (String(id) === 'session-x' || String(id) === 'x' ? fakeAgent : null) } }
await _internal.deliverDefault(ctxDeliver, 'session-x', '测试推送')
const msg = followedUp[0]
check(Boolean(msg), 'followup 被调用（append 不会开新一轮）')
check(msg && msg.role === 'user' && typeof msg.id === 'string' && msg.id.length > 0, '带 role/id')
check(msg && msg.source && msg.source.kind === SOURCE_KIND, '带 source.kind（缺了会让会话 projection 崩）')
check(msg && msg.content && msg.content[0] && msg.content[0].text === '测试推送', '内容正确')

let threw = false
try {
  await _internal.deliverDefault({ agents: { get: () => null } }, 'gone', 'x')
} catch {
  threw = true
}
check(threw, '会话不在时抛错（不静默吞）')


rmSync(dir, { recursive: true, force: true })
console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exitCode = failed ? 1 : 0
