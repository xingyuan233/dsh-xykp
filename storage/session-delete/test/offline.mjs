/**
 * dsh-session-delete 离线自测（不启动 dsh、不连浏览器）。
 *
 * 用真实的 @deepseek-ai/cordis 根 Context 加载插件，替换掉
 * sessionPersistence / workspaceRegistry / 文件系统 fixture，验证：
 *   1. 非活动会话：立即删除日志目录 + projection cache + Workspace 记账；
 *   2. 本进程仍 live 的会话：归档（stopActivity）+ 写入延迟队列，不碰文件；
 *   3. 下一次启动时：延迟队列被消费，文件被物理删除。
 *
 * 运行：node test/offline.mjs
 */
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

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
const PENDING = join(HOME, 'storages', 'session-delete', 'pending.json')
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

async function seed(id) {
  await mkdir(logDir(id), { recursive: true })
  await writeFile(logFile(id), 'fake-session-log\n', 'utf8')
  await mkdir(CACHE, { recursive: true })
  await writeFile(cacheFile(id), '{"fake":true}\n', 'utf8')
}

/** 所有 fake 的会话头：只认识自己 seed 过的 id。 */
function makePersistence(headers) {
  return {
    async stat(id) {
      if (!(id in headers)) return undefined
      return { header: headers[id], revision: 1 }
    },
    locate(header) {
      return { kind: 'jsonl', path: logFile(header.id) }
    },
  }
}

function makeRegistry(accounted) {
  const calls = { unarchive: [], unpin: [], detach: [] }
  const entity = {
    get sessionIds() {
      return [...accounted]
    },
    async detachSession(id) {
      calls.detach.push(id)
      const index = accounted.indexOf(id)
      if (index >= 0) accounted.splice(index, 1)
    },
  }
  return {
    calls,
    async unarchiveSession(id) {
      calls.unarchive.push(id)
    },
    async unpinSession(id) {
      calls.unpin.push(id)
    },
    list() {
      return [entity]
    },
  }
}

async function startHost({ headers, accounted, liveId, registryCalls }) {
  const ctx = new Context()
  ctx.provide('dshHomePath', () => HOME)
  ctx.provide('sessionPersistence', makePersistence(headers))
  const registry = makeRegistry(accounted)
  ctx.provide('workspaceRegistry', registry)
  if (liveId !== undefined) ctx.provide('agents', { get: (id) => (id === liveId ? { id } : undefined) })
  const plugin = await import(`${PLUGIN_ENTRY}?v=${randomUUID()}`)
  await ctx.plugin(plugin, {})
  // apply 是 async（内部还要加载协议），等 Remote 服务真正可用。
  for (let i = 0; i < 100; i += 1) {
    if (ctx.get('sessionDelete') !== undefined) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  if (ctx.get('sessionDelete') === undefined) throw new Error('插件未完成挂载：ctx.get("sessionDelete") 为空')
  if (registryCalls !== undefined) Object.assign(registryCalls, registry.calls)
  return { ctx, registry }
}

async function main() {
  console.log('【场景 1】非 live 会话立即删除')
  const id1 = 'session-11111111-1111-4111-8111-111111111111'
  const headers = { [id1]: { id: id1, cwd: 'D:/AI/test-project', createdAt: Date.now() } }
  const accounted = [id1]
  await seed(id1)
  const host1 = await startHost({ headers, accounted })
  const result1 = await host1.ctx.get('sessionDelete').deleteSession(id1)
  check('返回 deleted=true', result1.deleted === true)
  check('返回 deferred=false', result1.deferred === false)
  check('会话日志目录已删除', !existsSync(logDir(id1)))
  check('projection cache 已删除', !existsSync(cacheFile(id1)))
  check('从 Workspace 记账中摘除', accounted.length === 0 && host1.registry.calls.detach.includes(id1))
  check('取消了归档标记', host1.registry.calls.unarchive.includes(id1))
  check('取消了置顶标记', host1.registry.calls.unpin.includes(id1))
  check('未写入延迟队列', !existsSync(PENDING))
  await host1.ctx.fiber.dispose()

  console.log('\n【场景 2】本进程 live 会话：归档 + 排队，不删文件')
  const id2 = 'session-22222222-2222-4222-8222-222222222222'
  headers[id2] = { id: id2, cwd: 'D:/AI/test-project', createdAt: Date.now() }
  const accounted2 = [id2]
  await seed(id2)
  const archiveCalls = []
  const host2 = await startHost({ headers, accounted: accounted2, liveId: id2 })
  // 用假 registry 记录 archiveSession 的调用参数。
  host2.ctx.get('workspaceRegistry').archiveSession = async (id, options) => archiveCalls.push({ id, options })
  const result2 = await host2.ctx.get('sessionDelete').deleteSession(id2)
  check('返回 deleted=true', result2.deleted === true)
  check('返回 deferred=true', result2.deferred === true)
  check('调用了 archiveSession(stopActivity)', archiveCalls.length === 1 && archiveCalls[0].options.stopActivity === true)
  check('日志文件暂时保留', existsSync(logFile(id2)))
  const pending = JSON.parse(await readFile(PENDING, 'utf8'))
  check('已写入延迟删除队列', Array.isArray(pending.sessionIds) && pending.sessionIds.includes(id2))
  await host2.ctx.fiber.dispose()

  console.log('\n【场景 3】下次启动消费延迟队列')
  const accounted3 = [id2]
  const host3 = await startHost({ headers, accounted: accounted3 })
  let cleaned = false
  for (let i = 0; i < 100; i += 1) {
    if (!existsSync(logDir(id2))) {
      cleaned = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  check('启动清理删除了日志目录', cleaned)
  check('启动清理删除了 cache', !existsSync(cacheFile(id2)))
  check('延迟队列已清空', (await readFile(PENDING, 'utf8')).includes('[]'))
  await host3.ctx.fiber.dispose()

  console.log('\n【场景 4】非法 id 被拒绝')
  const host4 = await startHost({ headers, accounted: [] })
  let rejected = false
  try {
    await host4.ctx.get('sessionDelete').deleteSession('../../etc/passwd')
  } catch (error) {
    rejected = error.code === 'session/invalid-id'
  }
  check('目录穿越 id 抛 session/invalid-id', rejected)

  console.log('\n【场景 5】网关 SRC 发现所需的绑定与描述符')
  const service = host4.ctx.get('sessionDelete')
  const descriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(service),
    '@deepseek-ai/dsh-typert-protocol/remote-methods',
  )
  check('服务上存在 typertRemote 绑定', service.typertRemote !== undefined)
  check('命名空间为 sessionDelete', service.typertRemote?.namespace === 'sessionDelete')
  check('服务键为 sessionDelete', service.typertRemote?.serviceKey === 'sessionDelete')
  // 网关拿到的 receiver 可能被 Context 代理包了一层；它用 originalOf() 解包后要求
  // value.service === original。这里验证绑定里的 service 就是持有该绑定的原始实例。
  check(
    '绑定指向服务自身（原始实例自洽）',
    service.typertRemote?.service?.typertRemote === service.typertRemote,
  )
  check(
    '原型上有 remote-methods v1 描述符',
    descriptor !== undefined && descriptor.value.version === 1,
  )
  check(
    '描述符导出了 deleteSession（direct）',
    descriptor.value.methods.length === 1 &&
      descriptor.value.methods[0].method === 'deleteSession' &&
      descriptor.value.methods[0].invocation.kind === 'direct',
  )
  check('deleteSession 是原型方法', typeof service.deleteSession === 'function')
  await host4.ctx.fiber.dispose()

  console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('测试崩溃：', error)
  process.exit(1)
})
