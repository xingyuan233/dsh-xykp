/**
 * dsh-session-delete「删除末尾对话」离线自测（不启动 dsh、不连浏览器）。
 *
 * 用真实的 @deepseek-ai/cordis 根 Context 加载插件，用假的 sessionPersistence /
 * sessionQuery / agents 服务，验证：
 *   1. previewTurns 能把 JSONL 日志折叠成轮次（prompt/response/turn/seq）；
 *   2. 非 live 会话：deleteTurnsFrom 立即重写日志，保留 turn/start 之前的事件；
 *   3. live 会话：只登记 pending-turns.json，不碰文件；
 *   4. 下一次启动：排队登记被消费，日志被截断；
 *   5. 非法轮次/非法 id 被拒绝。
 *
 * 运行：node test/tail.mjs
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ENTRY = pathToFileURL(join(HERE, '..', 'lib', 'index.js')).href
const HOST_ROOT = 'D:/AI/DeepseekHarness/npm/node_modules/@deepseek-ai'

// 让插件「宿主锚点回退」能找到协议包：模拟 dsh 进程的 argv[1]。
process.argv[1] = join(HOST_ROOT, 'dsh', 'lib', 'bin.js')

const { Context } = await import(pathToFileURL(join(HOST_ROOT, 'cordis', 'lib', 'index.js')).href)

const WORK = join(HERE, '.tmp', randomUUID())
const HOME = join(WORK, 'home')
const SESSIONS = join(HOME, 'sessions')
const CACHE = join(HOME, 'storages', 'session_projcache', 'sessions')
const PENDING_TURNS = join(HOME, 'storages', 'session-delete', 'pending-turns.json')
const PROJECT_DIR = '--D-AI-test-project--'

const logDir = (id) => join(SESSIONS, PROJECT_DIR, id)
const logFile = (id) => join(logDir(id), 'session.v4.jsonl.zstd')
const cacheFile = (id) => join(CACHE, `${id}.json`)

let passed = 0
let failed = 0
function check(label, condition) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}`)
  }
}

/** 生成一份 v4 JSONL 日志（header + 若干轮的典型事件序列）。 */
function makeLog(id, turnTexts, options = {}) {
  const queued = options.queued === true
  const header = {
    type: 'session',
    version: 4,
    id,
    createdAt: 1700000000000,
    cwd: 'D:/AI/test-project',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  }
  const lines = [JSON.stringify(header)]
  let seq = 0
  const push = (type, data) => {
    lines.push(JSON.stringify({ type, seq, time: 1700000000000 + seq * 10, data }))
    seq += 1
  }
  push('permission/preset', { preset: 'workspace-write' })
  push('sandbox/mode', { mode: 'workspace-write' })
  for (const [index, texts] of turnTexts.entries()) {
    const turn = index + 1
    if (queued && turn > 1) {
      // 真实日志里下一轮的提示词先以 next-turn spliced 排进 inbox，turn/start 之后再消费掉。
      push('agent/inbox/spliced', {
        target: 'next-turn',
        turn,
        inserted: [{ kind: 'text', text: texts[0] }],
      })
    }
    push('turn/start', { turn })
    push('step/start', { turn, step: 1 })
    push('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: texts[0] }] })
    push('assistant/message', { message: { content: [{ type: 'text', text: texts[1] }] } })
    push('step/end', { turn, step: 1 })
    push('turn/end', { turn, reason: { kind: 'completed' } })
    if (queued) push('session/title', { title: `标题 ${turn}` })
  }
  return lines.join('\n') + '\n'
}

/** 解压日志并解析。 */
function decodeLog(id) {
  const text = zstdDecompressSync(readFileSyncCompat(logFile(id))).toString('utf8')
  const lines = text.split('\n').filter(Boolean)
  return {
    header: JSON.parse(lines[0]),
    events: lines.slice(1).map((line) => JSON.parse(line)),
  }
}

import { readFileSync } from 'node:fs'
function readFileSyncCompat(file) {
  return readFileSync(file)
}

async function seed(id, turnTexts, withCache, options) {
  await mkdir(logDir(id), { recursive: true })
  await writeFile(logFile(id), zstdCompressSync(Buffer.from(makeLog(id, turnTexts, options), 'utf8')))
  if (withCache !== false) {
    await mkdir(CACHE, { recursive: true })
    await writeFile(cacheFile(id), '{"fake":true}\n', 'utf8')
  }
}

function makePersistence(headers, files) {
  return {
    async stat(id) {
      if (!(id in headers)) return undefined
      return { header: headers[id], revision: 1 }
    },
    locate(header) {
      return { kind: 'jsonl', path: files[header.id] ?? logFile(header.id) }
    },
  }
}

/** 假的 sessionQuery：从磁盘（或用例注入的 snapshot）读事件。 */
function makeQuery(snapshotFor) {
  return {
    async readSession(id) {
      const snapshot = snapshotFor(id)
      if (snapshot === undefined) throw new Error(`session not found: ${id}`)
      return snapshot
    },
  }
}

async function startHost({ headers, liveId, snapshotFor }) {
  const ctx = new Context()
  ctx.provide('dshHomePath', () => HOME)
  ctx.provide('sessionPersistence', makePersistence(headers, {}))
  ctx.provide('workspaceRegistry', { list: () => [], async unarchiveSession() {}, async unpinSession() {} })
  if (liveId !== undefined) ctx.provide('agents', { get: (id) => (id === liveId ? { id } : undefined) })
  ctx.provide(
    'sessionQuery',
    makeQuery((id) => {
      if (snapshotFor !== undefined) {
        const injected = snapshotFor(id)
        if (injected !== undefined) return injected
      }
      if (!existsSync(logFile(id))) return undefined
      return decodeLog(id)
    }),
  )
  const plugin = await import(`${PLUGIN_ENTRY}?v=${randomUUID()}`)
  await ctx.plugin(plugin, {})
  for (let i = 0; i < 150; i += 1) {
    if (ctx.get('sessionDelete') !== undefined) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  if (ctx.get('sessionDelete') === undefined) throw new Error('插件未完成挂载：ctx.get("sessionDelete") 为空')
  return { ctx }
}

async function main() {
  const id = 'session-33333333-3333-4333-8333-333333333333'
  const headers = {
    [id]: { id, cwd: 'D:/AI/test-project', createdAt: 1700000000000 },
  }
  await seed(id, [
    ['第一轮问题', '第一轮回答'],
    ['第二轮问题', '第二轮回答'],
    ['第三轮问题', '第三轮回答'],
  ])

  console.log('【场景 1】previewTurns 折叠轮次')
  const host1 = await startHost({ headers })
  const preview = await host1.ctx.get('sessionDelete').previewTurns(id)
  check('totalTurns 是 "3"', preview.totalTurns === '3')
  check('返回 3 轮', Array.isArray(preview.turns) && preview.turns.length === 3)
  check('第 1 轮 turn 是 "1"', preview.turns[0]?.turn === '1')
  check('第 3 轮 prompt 正确', preview.turns[2]?.prompt === '第三轮问题')
  check('第 3 轮 response 正确', preview.turns[2]?.response === '第三轮回答')
  check('live=false', preview.live === false)

  console.log('\n【场景 2】非 live 立即截断（从第 2 轮起删除）')
  const result = await host1.ctx.get('sessionDelete').deleteTurnsFrom(id, '2')
  check('applied=true', result.applied === true)
  check('queued=false', result.queued === false)
  check('removedTurns="2"', result.removedTurns === '2')
  const after = decodeLog(id)
  check('日志首行 header 保持不变', after.header.id === id)
  check('只剩第 1 轮的事件（2 条前导 + 6 个/轮）', after.events.length === 8)
  check('最后一个事件是第 1 轮 turn/end', after.events.at(-1)?.type === 'turn/end')
  check('seq 连续', after.events.every((event, index) => event.seq === index))
  check('projection cache 已删除', !existsSync(cacheFile(id)))
  check('没有写入 pending-turns', !existsSync(PENDING_TURNS))
  await host1.ctx.fiber.dispose()

  console.log('\n【场景 3】live 会话只登记，不碰文件')
  const liveId = 'session-44444444-4444-4444-8444-444444444444'
  headers[liveId] = { id: liveId, cwd: 'D:/AI/test-project', createdAt: 1700000000000 }
  await seed(liveId, [
    ['活问题一', '活回答一'],
    ['活问题二', '活回答二'],
  ])
  const beforeLive = decodeLog(liveId).events.length
  const host2 = await startHost({ headers, liveId })
  const livePreview = await host2.ctx.get('sessionDelete').previewTurns(liveId)
  check('live=true', livePreview.live === true)
  const queued = await host2.ctx.get('sessionDelete').deleteTurnsFrom(liveId, '2')
  check('queued=true', queued.queued === true)
  check('applied=false', queued.applied === false)
  check('removedTurns="1"', queued.removedTurns === '1')
  check('日志文件没有被改动', decodeLog(liveId).events.length === beforeLive)
  const pendingFile = JSON.parse(await readFile(PENDING_TURNS, 'utf8'))
  check(
    'pending-turns 记录了请求',
    Array.isArray(pendingFile.entries) &&
      pendingFile.entries.length === 1 &&
      pendingFile.entries[0].sessionId === liveId &&
      pendingFile.entries[0].fromTurn === 2,
  )
  await host2.ctx.fiber.dispose()

  console.log('\n【场景 4】下次启动消费 pending-turns')
  const host3 = await startHost({ headers })
  let applied = false
  for (let i = 0; i < 150; i += 1) {
    if (decodeLog(liveId).events.every((event) => !(event.type === 'turn/start' && event.data?.turn === 2))) {
      applied = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  check('启动后第 2 轮已被删除', applied)
  check('第 1 轮还在', decodeLog(liveId).events.some((event) => event.type === 'turn/start' && event.data?.turn === 1))
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('pending-turns 已清空', JSON.parse(await readFile(PENDING_TURNS, 'utf8')).entries.length === 0)
  await host3.ctx.fiber.dispose()

  console.log('\n【场景 5】非法输入被拒绝')
  const host4 = await startHost({ headers })
  let badId = false
  try {
    await host4.ctx.get('sessionDelete').deleteTurnsFrom('../../etc/passwd', '1')
  } catch (error) {
    badId = error.code === 'session/invalid-id'
  }
  check('目录穿越 id 抛 session/invalid-id', badId)
  let badTurn = false
  try {
    await host4.ctx.get('sessionDelete').deleteTurnsFrom(id, '99')
  } catch (error) {
    badTurn = error.code === 'session/turn-not-found'
  }
  check('不存在的轮次抛 session/turn-not-found', badTurn)
  await host4.ctx.fiber.dispose()

  console.log('\n【场景 6】轮间排气：不留下会显示成「注入」的排队消息（回归）')
  const queuedId = 'session-55555555-5555-4555-8555-555555555555'
  headers[queuedId] = { id: queuedId, cwd: 'D:/AI/test-project', createdAt: 1700000000000 }
  await seed(
    queuedId,
    [
      ['第一轮问题', '第一轮回答'],
      ['第二轮问题', '第二轮回答'],
      ['第三轮问题', '第三轮回答'],
    ],
    false,
    { queued: true },
  )
  const host5 = await startHost({ headers })
  const queuedResult = await host5.ctx.get('sessionDelete').deleteTurnsFrom(queuedId, '3')
  check('返回 applied=true', queuedResult.applied === true)
  const afterQueued = decodeLog(queuedId)
  const queuedTypes = afterQueued.events.map((event) => event.type)
  const lastStart = queuedTypes.lastIndexOf('turn/start')
  check(
    '每个 turn/start 之后才消费排队消息（没有悬空 spliced）',
    queuedTypes.every((type, index) => type !== 'agent/inbox/spliced' || queuedTypes.indexOf('turn/start', index) > index),
  )
  check('保留第 1、2 轮', queuedTypes.filter((type) => type === 'turn/start').length === 2)
  check(
    '标题保住了',
    afterQueued.events.some((event) => event.type === 'session/title' && event.data?.title === '标题 2'),
  )
  check('seq 连续', afterQueued.events.every((event, index) => event.seq === index))
  check('最后一条不是排队消息', !queuedTypes[queuedTypes.length - 1].startsWith('agent/inbox/'))
  await host5.ctx.fiber.dispose()

  console.log('\n【场景 7】删到第一轮：丢掉 turn/start，但保住标题')
  const headId = 'session-66666666-6666-4666-8666-666666666666'
  headers[headId] = { id: headId, cwd: 'D:/AI/test-project', createdAt: 1700000000000 }
  await seed(headId, [['第一轮问题', '第一轮回答'], ['第二轮问题', '第二轮回答']], false, { queued: true })
  const host6 = await startHost({ headers })
  await host6.ctx.get('sessionDelete').deleteTurnsFrom(headId, '1')
  const afterHead = decodeLog(headId)
  const headTypes = afterHead.events.map((event) => event.type)
  check('没有 turn/start 了', !headTypes.includes('turn/start'))
  check('没有残留 agent/inbox/*', !headTypes.some((type) => type.startsWith('agent/inbox/')))
  check('从被删区间借回标题', headTypes.includes('session/title'))
  check('日志首行 header 保持不变', afterHead.header.id === headId)
  check('seq 连续', afterHead.events.every((event, index) => event.seq === index))
  await host6.ctx.fiber.dispose()

  console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
  await rm(WORK, { recursive: true, force: true })
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error('测试崩溃：', error)
  await rm(WORK, { recursive: true, force: true }).catch(() => {})
  process.exit(1)
})
