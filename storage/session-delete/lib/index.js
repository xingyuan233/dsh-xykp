/**
 * dsh-session-delete — Host half.
 *
 * 给 dsh web 增加「永久删除会话」能力。宿主侧只做三件事：
 *   1. 注册一个 Typert Remote 命名空间 `sessionDelete`，暴露 `deleteSession(sessionId)`；
 *   2. 真正删除磁盘上的会话：会话日志目录、projection cache、Workspace 记账/归档/置顶集合；
 *   3. 对「仍在宿主内存里」的会话（本进程创建过 / 跑过回合）做延迟删除：先归档让它在
 *      侧栏消失，把 id 记进 pending 队列，下次宿主启动时再物理清理（此时已无写入者）。
 *
 * 设计约束（对照 @deepseek-ai/dsh-session-persistence）：
 *   - 持久化层没有 delete API，唯一的写者（live agent 的 write handle）只属于创建它的
 *     fiber，第三方插件无法 dispose；因此 live 会话绝不原地删文件，否则 JSONL 句柄会在
 *     close/drain 时把文件重新写回来。
 *   - 非 live 会话才允许立即删除；删除前先问 `workspace/session-activity` 瀑布，
 *     还有后台任务/定时任务在跑就拒绝（先归档或先停掉）。
 *
 * Remote descriptor 说明：宿主网关的 SRC 回退按「服务实例上的 typertRemote 绑定 +
 * 原型上的 remote-methods 描述符」发现方法（dsh-api-gateway/lib/index.js:
 * resolveSrcDescriptor / methodParameterNames）。本包不依赖装饰器语法，直接在原型上
 * 写入同一份描述符，方法参数保持「纯标识符」形式。
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'

export const name = 'dsh-session-delete'

/** 服务键 = Remote 命名空间。 */
export const NAMESPACE = 'sessionDelete'

/** 必需服务就绪后再 apply，注册表 / 持久化都已完成 init。 */
export const inject = ['sessionPersistence', 'workspaceRegistry']

/** 与 typert-protocol 的常量保持一致（remote-methods 描述符的键）。 */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** 会话 id 只允许安全字符，直接拼路径前必须校验（防目录穿越）。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/

/**
 * 解析 @deepseek-ai/dsh-typert-protocol。
 *
 * 宿主加载 profile 插件时会做模块解析拦截（dsh-app-boot 的 layer 路由），所以裸
 * specifier 通常可用；但未经过该拦截的进程里裸 specifier 会失败。这里保留一条
 * 「以 dsh 入口为锚点」的 createRequire 回退，保证本插件在两种装载方式下都能拿到
 * 与网关同一个模块实例（RemoteError 的跨域识别依赖同一个类）。
 *
 * @returns typert-protocol 模块命名空间。
 */
async function loadProtocol() {
  try {
    return await import('@deepseek-ai/dsh-typert-protocol')
  } catch (bareError) {
    try {
      const anchor = process.argv[1]
      const require = createRequire(anchor ? pathToFileURL(resolvePath(anchor)) : import.meta.url)
      const entry = require.resolve('@deepseek-ai/dsh-typert-protocol')
      return await import(pathToFileURL(entry).href)
    } catch (anchoredError) {
      throw new Error(
        'dsh-session-delete: 无法加载 @deepseek-ai/dsh-typert-protocol（裸导入与宿主锚点回退都失败）',
        { cause: bareError },
      )
    }
  }
}

/**
 * 解析插件配置：三个路径都可覆盖，默认按 dsh home 推导。
 * @param ctx - 宿主 Context（用于读取 dshHomePath 服务）。
 * @param config - loader 传入的原始 config。
 * @returns 规范化后的选项。
 */
function resolveOptions(ctx, config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const home = () => {
    const resolver = ctx.get('dshHomePath')
    if (typeof resolver !== 'function') {
      throw new Error('dsh-session-delete: 宿主没有提供 dshHomePath 服务，无法定位数据目录')
    }
    return resolver()
  }
  const pick = (value, fallback) =>
    typeof value === 'string' && value.trim() !== '' ? resolvePath(value) : fallback()
  return {
    sessionsRoot: pick(raw.sessionsRoot, () => join(home(), 'sessions')),
    projectionCacheRoot: pick(
      raw.projectionCacheRoot,
      () => join(home(), 'storages', 'session_projcache', 'sessions'),
    ),
    pendingPath: pick(
      raw.pendingPath,
      () => join(home(), 'storages', 'session-delete', 'pending.json'),
    ),
  }
}

/** 读 pending 队列；坏文件按空队列处理（下次写入会覆盖）。 */
async function readPending(options) {
  try {
    const parsed = JSON.parse(await readFile(options.pendingPath, 'utf8'))
    const ids = parsed !== null && typeof parsed === 'object' ? parsed.sessionIds : undefined
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && SESSION_ID_PATTERN.test(id)) : []
  } catch {
    return []
  }
}

/** 原子写 pending 队列（tmp + rename）。 */
async function writePending(options, ids) {
  await mkdir(dirname(options.pendingPath), { recursive: true })
  const tmp = `${options.pendingPath}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify({ sessionIds: ids }, null, 2)}\n`, 'utf8')
  await rename(tmp, options.pendingPath)
}

/** 追加一个待删 id（幂等）。 */
async function queuePending(options, sessionId) {
  const ids = await readPending(options)
  if (!ids.includes(sessionId)) ids.push(sessionId)
  await writePending(options, ids)
}

/**
 * 把会话从 Workspace 注册表里彻底忘掉：取消归档、取消置顶、从每个 Workspace 的
 * 记账里摘除。删除磁盘文件之前/之后都可以调用，全部是幂等的。
 * @param registry - workspaceRegistry 服务，可能缺席。
 * @param sessionId - 目标会话。
 */
async function forgetInRegistry(registry, sessionId) {
  if (registry === undefined) return
  await registry.unarchiveSession(sessionId)
  await registry.unpinSession(sessionId)
  for (const workspace of registry.list()) {
    let accounted
    try {
      accounted = workspace.sessionIds
    } catch {
      continue
    }
    if (Array.isArray(accounted) && accounted.includes(sessionId)) await workspace.detachSession(sessionId)
  }
}

/**
 * 删除一个会话的物理文件。
 *
 * 优先用持久化后端的 `locate(header)`（JSONL 后端提供精确路径），再兜底扫描
 * `<sessionsRoot>/*\/<sessionId>/`，两条路径都覆盖到才 `rm -r`。
 * projection cache 是独立存储单元，单独按 `<id>.json` 删除。
 *
 * @param persistence - sessionPersistence 服务。
 * @param options - 规范化后的路径配置。
 * @param sessionId - 目标会话。
 * @param header - 持久化快照里的 header（可能没有，例如文件已丢失）。
 */
async function removeSessionFiles(persistence, options, sessionId, header) {
  const directories = new Set()
  if (header !== undefined && typeof persistence.locate === 'function') {
    try {
      const located = persistence.locate(header)
      if (located !== null && typeof located === 'object' && typeof located.path === 'string') {
        directories.add(dirname(located.path))
      }
    } catch {
      /* 定位失败就走下面的扫描兜底 */
    }
  }
  try {
    const entries = await readdir(options.sessionsRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      directories.add(join(options.sessionsRoot, entry.name, sessionId))
    }
  } catch {
    /* 根目录不存在：没有可删的日志 */
  }
  for (const directory of directories) await rm(directory, { recursive: true, force: true })
  await rm(join(options.projectionCacheRoot, `${sessionId}.json`), { force: true })
  return directories
}

/**
 * 立即删除一个非 live 会话：检查活动 → 删文件 → 清注册表。
 * @returns 处理结果（给 Remote 返回的 JSON）。
 */
async function deleteNow(ctx, persistence, registry, options, sessionId) {
  const activity = await ctx.waterfall(
    'workspace/session-activity',
    { sessionId },
    () => Promise.resolve([]),
  )
  if (Array.isArray(activity) && activity.length > 0) {
    const error = new Error(`会话「${sessionId}」仍有未结束的工作（${activity
      .map((entry) => (entry !== null && typeof entry === 'object' ? entry.kind : String(entry)))
      .join('、')}），请先停止或归档后再删除`)
    error.code = 'session/active'
    throw error
  }
  const snapshot = await persistence.stat(sessionId)
  await removeSessionFiles(persistence, options, sessionId, snapshot?.header)
  await forgetInRegistry(registry, sessionId)
  return { deleted: true, deferred: false, sessionId, existed: snapshot !== undefined }
}

/**
 * 处理一个 live 会话：归档（顺带停掉运行中的工作）+ 记入 pending 队列，等下次宿主
 * 启动时物理删除。
 * @returns 处理结果。
 */
async function deferLive(ctx, registry, options, sessionId) {
  try {
    await registry.archiveSession(sessionId, { stopActivity: true })
  } catch (error) {
    // 文件已经不在了 / 注册表不认这个 id 时仍然允许排队，下一轮清理会幂等处理。
    if (ctx.logger !== undefined) ctx.logger.warn(`[dsh-session-delete] 归档会话「${sessionId}」失败：${String(error)}`)
  }
  await queuePending(options, sessionId)
  return { deleted: true, deferred: true, sessionId }
}

/**
 * 宿主启动时清理上一轮排队的延迟删除。
 * 此刻所有 agent 都还没被恢复，可以安全地删文件；注册表也已 init（inject 保证）。
 */
async function flushPending(ctx, options) {
  const ids = await readPending(options)
  if (ids.length === 0) return
  const persistence = ctx.get('sessionPersistence')
  const registry = ctx.get('workspaceRegistry')
  const remaining = []
  for (const sessionId of ids) {
    const live =
      ctx.get('agents')?.get?.(sessionId) !== undefined ||
      ctx.get('sessions')?.get?.(sessionId) !== undefined
    if (live) {
      remaining.push(sessionId)
      continue
    }
    try {
      const snapshot = await persistence.stat(sessionId)
      await removeSessionFiles(persistence, options, sessionId, snapshot?.header)
      await forgetInRegistry(registry, sessionId)
      if (ctx.logger !== undefined) ctx.logger.info(`[dsh-session-delete] 已完成延迟删除：${sessionId}`)
    } catch (error) {
      remaining.push(sessionId)
      if (ctx.logger !== undefined) ctx.logger.warn(`[dsh-session-delete] 延迟删除「${sessionId}」失败：${String(error)}`)
    }
  }
  await writePending(options, remaining)
}

/**
 * 插件入口。
 * @param ctx - 宿主 Context。
 * @param config - 可选路径覆盖。
 */
export async function apply(ctx, config) {
  const protocol = await loadProtocol()
  const options = resolveOptions(ctx, config)
  const { TypertRemoteService, RemoteError } = protocol

  let tail = Promise.resolve()

  /** 串行化所有删除请求，避免同一会话被并发处理。 */
  function enqueue(operation) {
    const run = tail.then(operation)
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  class SessionDeleteService extends TypertRemoteService {
    constructor(serviceCtx) {
      super(serviceCtx, NAMESPACE)
    }

    /**
     * 永久删除一个会话。
     * @param sessionId - 会话 id。
     * @returns `{ deleted, deferred, sessionId }`；deferred 表示本进程内仍 live，
     *          已归档并排队到下次宿主启动时物理清理。
     */
    async deleteSession(sessionId) {
      if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
        throw new RemoteError('session/invalid-id', `非法的会话 id：${String(sessionId)}`, {})
      }
      return enqueue(async () => {
        const persistence = ctx.get('sessionPersistence')
        const registry = ctx.get('workspaceRegistry')
        const live =
          ctx.get('agents')?.get?.(sessionId) !== undefined ||
          ctx.get('sessions')?.get?.(sessionId) !== undefined
        if (live) return deferLive(ctx, registry, options, sessionId)
        return deleteNow(ctx, persistence, registry, options, sessionId)
      })
    }
  }

  // SRC 回退读取的原型描述符（与 @Remote('deleteSession') 写下的结构一致）。
  Object.defineProperty(SessionDeleteService.prototype, REMOTE_METHOD_DESCRIPTOR, {
    value: { version: 1, methods: [{ method: 'deleteSession', invocation: { kind: 'direct' } }] },
    enumerable: false,
    configurable: true,
    writable: false,
  })

  // TypertRemoteService 的构造函数内部已经完成 cordis 服务注册（键 = NAMESPACE），
  // 这里只需实例化；服务随插件 fiber 一起卸载。
  new SessionDeleteService(ctx)

  // 启动清理：不阻塞插件激活，失败只记日志。
  void flushPending(ctx, options).catch((error) => {
    if (ctx.logger !== undefined) ctx.logger.warn(`[dsh-session-delete] 启动清理失败：${String(error)}`)
  })

  if (ctx.logger !== undefined) {
    ctx.logger.info(`[dsh-session-delete] 已挂载：sessionsRoot=${options.sessionsRoot}`)
  }
}
