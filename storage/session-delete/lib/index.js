import { configFor } from '../../../ui/store.js'
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
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

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
    pendingTurnsPath: pick(
      raw.pendingTurnsPath,
      () => join(home(), 'storages', 'session-delete', 'pending-turns.json'),
    ),
  }
}

/**
 * 试开一个写句柄（立即关闭）判断日志现在能不能被独占重写。
 * @param persistence - sessionPersistence 服务。
 * @param sessionId - 目标会话。
 */
async function canWriteLog(persistence, sessionId) {
  try {
    const handle = await persistence.open(sessionId, 'write')
    await handle.close()
    return true
  } catch {
    return false
  }
}

/**
 * 轮询等待写句柄被释放（核心补丁的 agents.close 之后可能还要几十毫秒）。
 * @param persistence - sessionPersistence 服务。
 * @param sessionId - 目标会话。
 * @param timeoutMs - 最长等待毫秒数。
 */
async function waitWritable(persistence, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await canWriteLog(persistence, sessionId)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * 会话当前是否仍在宿主内存里（有 live agent 或 live session）。
 * @param ctx - 宿主 Context。
 * @param sessionId - 目标会话。
 */
function isLiveSession(ctx, sessionId) {
  try {
    if (ctx.get('agents')?.get?.(sessionId) !== undefined) return true
    if (ctx.get('sessions')?.get?.(sessionId) !== undefined) return true
  } catch {
    /* 服务缺席按非 live 处理，真正写文件前还会有别的保护 */
  }
  return false
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

// ---------------------------------------------------------------------------
// 删除末尾轮次（截断会话日志）
//
// 会话日志是 zstd 压缩的 JSONL：首行是 header，之后一行一个事件，seq 从 0 连续。
// 「删除末尾 N 轮」= 找到从那一轮开始的 turn/start 事件，把文件重写成它之前的前缀。
// 切割点固定在 turn/start 上，因此保留下来的日志总以完整的一轮结束（turn/end），
// 不需要补合成收尾事件。
//
// 追加写日志不能被正在写它的句柄改写：如果会话在本进程里仍 live，只登记到
// pending-turns.json，等下次宿主启动（此时没有任何 agent）再落盘。
// ---------------------------------------------------------------------------

/** 预览最多返回多少轮。 */
const PREVIEW_TURN_LIMIT = 12

/** 预览文本截断长度。 */
const PREVIEW_TEXT_LIMIT = 160

/** JSONL 日志文件名（v4 起是固定名字；旧版本文件按版本号兜底扫描）。 */
const LOG_NAME_PATTERN = /^session\.v(\d+)\.jsonl\.zstd$/

/** 从内容块数组里拼出纯文本（user/message 的 content、assistant/message 的 message.content）。 */
function textOfParts(parts) {
  if (!Array.isArray(parts)) return ''
  let text = ''
  for (const part of parts) {
    if (part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      text += part.text
    }
  }
  return text
}

/** 压成单行并截断，用于对话框里的预览。 */
function clipPreview(value) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_TEXT_LIMIT ? `${flat.slice(0, PREVIEW_TEXT_LIMIT)}…` : flat
}

/**
 * 把事件流折叠成「轮」列表（与 dsh-session-turn-outline 的 turnOutline 投影同构）：
 * 每轮从 turn/start 开始，到 turn/end 结束；prompt 优先取该轮第一个
 * `source.kind === 'user'` 的 user/message，没有就退回本轮第一条 user/message；
 * response 取本轮最后一个有文本的 assistant/message。
 *
 * @param events - 按 seq 升序的会话事件。
 * @returns `[{ turn, seq, prompt, response }]`，seq 是该轮 turn/start 的序号。
 */
function foldTurns(events) {
  const turns = []
  let current = null
  const finish = () => {
    if (current === null) return
    turns.push({
      turn: current.turn,
      seq: current.seq,
      prompt: current.humanPrompt !== '' ? current.humanPrompt : current.fallbackPrompt,
      response: current.response,
    })
    current = null
  }
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'turn/start') {
      finish()
      const declared = event.data !== null && typeof event.data === 'object' ? event.data.turn : undefined
      current = {
        turn: typeof declared === 'number' ? declared : turns.length + 1,
        seq: typeof event.seq === 'number' ? event.seq : 0,
        humanPrompt: '',
        fallbackPrompt: '',
        response: '',
      }
      continue
    }
    if (current === null) continue
    if (event.type === 'turn/end') {
      finish()
      continue
    }
    if (event.type === 'user/message') {
      const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
      const human = data.source !== null && typeof data.source === 'object' && data.source.kind === 'user'
      const text = clipPreview(textOfParts(data.content))
      if (human && current.humanPrompt === '') current.humanPrompt = text
      else if (!human && current.fallbackPrompt === '' && text !== '') current.fallbackPrompt = text
      continue
    }
    if (event.type === 'assistant/message') {
      const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
      const message = data.message !== null && typeof data.message === 'object' ? data.message : {}
      const text = clipPreview(textOfParts(message.content))
      if (text !== '') current.response = text
    }
  }
  finish()
  return turns
}

/**
 * 解析一份 JSONL 日志文件：首行 header，其余行按顺序是事件。
 * @param file - 日志文件绝对路径。
 * @returns `{ headerLine, header, eventLines, events }`。
 */
async function readLogFile(file) {
  const text = zstdDecompressSync(await readFile(file)).toString('utf8')
  const lines = text.split('\n')
  const headerLine = lines[0] ?? ''
  let header
  try {
    header = JSON.parse(headerLine)
  } catch {
    throw new Error(`会话日志头部无法解析：${file}`)
  }
  const eventLines = lines.slice(1).filter((line) => line.length > 0)
  const events = eventLines.map((line) => JSON.parse(line))
  return { headerLine, header, eventLines, events }
}

/**
 * 找出会话当前的 JSONL 日志路径。
 *
 * 优先用持久化后端的 `locate(header)`，文件不存在再回退扫描
 * `<sessionsRoot>/<工作目录键>/<sessionId>/session.v*.jsonl.zstd`（取版本号最大的）。
 *
 * @param persistence - sessionPersistence 服务。
 * @param options - 规范化后的路径配置。
 * @param sessionId - 目标会话。
 * @param header - 持久化快照里的 header（可能没有）。
 * @returns 日志绝对路径；找不到时 undefined。
 */
async function resolveLogPath(persistence, options, sessionId, header) {
  if (header !== undefined && typeof persistence.locate === 'function') {
    try {
      const located = persistence.locate(header)
      if (located !== null && typeof located === 'object' && typeof located.path === 'string') {
        try {
          await stat(located.path)
          return located.path
        } catch {
          /* 定位到的文件已不在：走扫描兜底 */
        }
      }
    } catch {
      /* 定位失败：走扫描兜底 */
    }
  }
  let roots
  try {
    roots = await readdir(options.sessionsRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  let best
  for (const entry of roots) {
    if (!entry.isDirectory()) continue
    const directory = join(options.sessionsRoot, entry.name, sessionId)
    let names
    try {
      names = await readdir(directory)
    } catch {
      continue
    }
    for (const name of names) {
      const matched = LOG_NAME_PATTERN.exec(name)
      if (matched === null) continue
      const version = Number(matched[1])
      if (best === undefined || version > best.version) best = { path: join(directory, name), version }
    }
  }
  return best?.path
}

/**
 * 把日志重新编码成多帧 zstd：第一帧只能是 header 一行（存储层强校验
 * `assertZstdHeaderFrame`），之后按约 1 MiB 文本一组分帧，每帧都在记录边界结束。
 *
 * @param headerLine - 原始 header JSON 行（不含换行）。
 * @param eventLines - 要保留的事件行（不含换行，保持原始文本）。
 * @returns 可直接原子写入的 zstd 字节。
 */
function encodeLogFrames(headerLine, eventLines) {
  const frames = [zstdCompressSync(Buffer.from(`${headerLine}\n`, 'utf8'))]
  const budget = 1024 * 1024
  let chunk = []
  let size = 0
  const flush = () => {
    if (chunk.length === 0) return
    frames.push(zstdCompressSync(Buffer.from(`${chunk.join('\n')}\n`, 'utf8')))
    chunk = []
    size = 0
  }
  for (const line of eventLines) {
    if (size > 0 && size + line.length > budget) flush()
    chunk.push(line)
    size += line.length + 1
  }
  flush()
  return Buffer.concat(frames)
}

/**
 * 原地截断一份日志：保留到 `turn/start(turn >= fromTurn)` 为止，但只到「上一轮 turn/end」。
 *
 * 轮间事件（上一轮 turn/end 之后、目标 turn/start 之前）会丢掉 agent/inbox/*：
 * next-turn spliced 若留在文件末尾，投影会当成一条没被消费的排队消息，UI 里显示成「注入」。
 * 其余轮间事件（session/title、设置变更等）保留；删到第一轮时从被删区间借回最早的标题，
 * 避免会话变成「未命名」。必要时重排 seq/ts，保证重写后的日志合法。
 *
 * 不重新编码事件行（保留原始 JSON 文本），只重压缩整体并原子替换文件；
 * 写临时文件后 fsync 再 rename，失败不会留下半个日志。
 *
 * @param file - 日志绝对路径。
 * @param sessionId - 目标会话（用于校验 header）。
 * @param fromTurn - 从这一轮开始删除（整数）。
 * @returns `{ removedTurns, removedEvents, remainingEvents }`。
 */
export async function truncateLogAtTurn(file, sessionId, fromTurn) {
  const { headerLine, header, eventLines, events } = await readLogFile(file)
  if (header.id !== sessionId) {
    throw new Error(`日志 id 与目标会话不一致：${String(header.id)} ≠ ${sessionId}`)
  }
  const stop = events.findIndex(
    (event) =>
      event !== null &&
      typeof event === 'object' &&
      event.type === 'turn/start' &&
      event.data !== null &&
      typeof event.data === 'object' &&
      event.data.turn === fromTurn,
  )
  if (stop < 0) {
    const error = new Error(`日志里找不到第 ${fromTurn} 轮（turn/start）`)
    error.code = 'session/turn-not-found'
    throw error
  }
  const isObject = (event) => event !== null && typeof event === 'object'
  // 上一轮 turn/end 之后是轮间区域（排队消息、标题、设置变更……）。
  let lastEnd = -1
  for (let index = stop - 1; index >= 0; index -= 1) {
    if (isObject(events[index]) && events[index].type === 'turn/end') {
      lastEnd = index
      break
    }
  }
  const keptIndexes = []
  for (let index = 0; index <= lastEnd; index += 1) keptIndexes.push(index)
  // 轮间只丢掉 agent/inbox/*：next-turn spliced 若留在文件末尾，投影会把它当成
  // 一条没被消费的消息，UI 里就显示成输入框上方的「注入」。
  for (let index = lastEnd + 1; index < stop; index += 1) {
    const event = events[index]
    if (isObject(event) && typeof event.type === 'string' && event.type.startsWith('agent/inbox/')) continue
    keptIndexes.push(index)
  }
  // 删到第一轮时前缀里没有 session/title，从被删区间借一个最早的标题，避免会话变成「未命名」。
  const hasTitle = keptIndexes.some((index) => isObject(events[index]) && events[index].type === 'session/title')
  if (!hasTitle) {
    for (let index = stop; index < events.length; index += 1) {
      if (isObject(events[index]) && events[index].type === 'session/title') {
        keptIndexes.push(index)
        break
      }
    }
  }
  const cut = keptIndexes.length
  const removedTurns = events.filter(
    (event, index) => isObject(event) && event.type === 'turn/start' && index >= stop,
  ).length
  // 直接从被删区间借事件（标题兜底）时下标不再连续，需要按新顺序重排 seq，必要时把 ts 也顶到末尾，
  // 否则重写的日志会被当成坏文件。只重写借回来的那几行，其余保持原样。
  const contiguous = keptIndexes.every((index, position) => index === position)
  let previousTime = 0
  const keptLines = keptIndexes.map((index, position) => {
    if (contiguous) {
      const event = events[index]
      previousTime = Math.max(previousTime, Number(event?.ts) || 0)
      return eventLines[index]
    }
    const event = JSON.parse(eventLines[index])
    event.seq = position
    const time = Number(event.ts) || 0
    if (time <= previousTime) event.ts = previousTime + 1
    previousTime = Math.max(previousTime, Number(event.ts) || 0)
    return JSON.stringify(event)
  })
  const compressed = encodeLogFrames(headerLine, keptLines)

  const temporary = `${file}.truncate-${process.pid}-${Date.now()}.tmp`
  const handle = await open(temporary, 'w')
  try {
    await handle.writeFile(compressed)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, file)

  // 自检：重读刚写下的文件，确认事件数量与序号收口。
  const check = await readLogFile(file)
  if (check.events.length !== cut) {
    throw new Error(`截断后事件数不符：期望 ${cut}，实际 ${check.events.length}`)
  }
  if (cut > 0 && check.events[cut - 1].seq !== cut - 1) {
    throw new Error(`截断后 seq 不连续：最后一个事件 seq=${String(check.events[cut - 1].seq)}`)
  }
  return { removedTurns, removedEvents: eventLines.length - cut, remainingEvents: cut }
}

/** 读 pending-turns 队列；坏文件按空队列处理。 */
async function readPendingTurns(options) {
  try {
    const parsed = JSON.parse(await readFile(options.pendingTurnsPath, 'utf8'))
    const entries = parsed !== null && typeof parsed === 'object' ? parsed.entries : undefined
    if (!Array.isArray(entries)) return []
    return entries.filter(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof entry.sessionId === 'string' &&
        SESSION_ID_PATTERN.test(entry.sessionId) &&
        Number.isInteger(entry.fromTurn) &&
        entry.fromTurn >= 1,
    )
  } catch {
    return []
  }
}

/** 原子写 pending-turns 队列（tmp + rename）。 */
async function writePendingTurns(options, entries) {
  await mkdir(dirname(options.pendingTurnsPath), { recursive: true })
  const tmp = `${options.pendingTurnsPath}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify({ entries }, null, 2)}\n`, 'utf8')
  await rename(tmp, options.pendingTurnsPath)
}

/** 登记一个「下次启动时截断」请求（同一会话只保留最后一次）。 */
async function queuePendingTurn(options, sessionId, fromTurn) {
  const entries = (await readPendingTurns(options)).filter((entry) => entry.sessionId !== sessionId)
  entries.push({ sessionId, fromTurn, requestedAt: Date.now() })
  await writePendingTurns(options, entries)
}

/** 丢弃某个会话的待截断登记（如果存在）。 */
async function dropPendingTurn(options, sessionId) {
  const entries = await readPendingTurns(options)
  if (!entries.some((entry) => entry.sessionId === sessionId)) return
  await writePendingTurns(
    options,
    entries.filter((entry) => entry.sessionId !== sessionId),
  )
}

/**
 * 宿主启动时应用排队的截断。此刻 agent 都还没恢复，文件可以安全重写。
 * 找不到对应轮次（会话已变短/已删除）的登记直接丢弃并记日志。
 */
async function flushPendingTurns(ctx, options) {
  const entries = await readPendingTurns(options)
  if (entries.length === 0) return
  const persistence = ctx.get('sessionPersistence')
  const remaining = []
  for (const entry of entries) {
    if (isLiveSession(ctx, entry.sessionId)) {
      remaining.push(entry)
      continue
    }
    try {
      const snapshot = await persistence.stat(entry.sessionId)
      if (snapshot === undefined) {
        if (ctx.logger !== undefined) {
          ctx.logger.info(`[dsh-session-delete] 会话已不存在，丢弃末尾截断登记：${entry.sessionId}`)
        }
        continue
      }
      const file = await resolveLogPath(persistence, options, entry.sessionId, snapshot.header)
      if (file === undefined) continue
      const result = await truncateLogAtTurn(file, entry.sessionId, entry.fromTurn)
      await rm(join(options.projectionCacheRoot, `${entry.sessionId}.json`), { force: true })
      if (ctx.logger !== undefined) {
        ctx.logger.info(
          `[dsh-session-delete] 已完成末尾截断：${entry.sessionId} 第 ${entry.fromTurn} 轮起，删除 ${result.removedEvents} 个事件`,
        )
      }
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'session/turn-not-found') {
        if (ctx.logger !== undefined) {
          ctx.logger.warn(`[dsh-session-delete] 丢弃过期的末尾截断登记：${entry.sessionId} 第 ${entry.fromTurn} 轮`)
        }
        continue
      }
      remaining.push(entry)
      if (ctx.logger !== undefined) {
        ctx.logger.warn(`[dsh-session-delete] 末尾截断失败：${entry.sessionId}（${String(error)}）`)
      }
    }
  }
  await writePendingTurns(options, remaining)
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
export async function apply(ctx, config = {}) {
  config = configFor('dsh-session-delete', config)
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

    /**
     * 预览会话的轮次，供「删除末尾对话」对话框显示。
     * @param sessionId - 会话 id。
     * @param fromTurn - 可选：十进制字符串，只返回这一轮及之后的轮次。
     * @returns `{ sessionId, displayTitle, live, totalTurns, turns: [{ turn, prompt, response }] }`；
     *          turn / totalTurns 是十进制字符串（避免客户端依赖 number codec）。
     */
    async previewTurns(sessionId, fromTurn) {
      if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
        throw new RemoteError('session/invalid-id', `非法的会话 id：${String(sessionId)}`, {})
      }
      const from = typeof fromTurn === 'string' && fromTurn !== '' ? Number(fromTurn) : undefined
      if (from !== undefined && (!Number.isInteger(from) || from < 1)) {
        throw new RemoteError('session/invalid-turn', `非法的轮次：${String(fromTurn)}`, {})
      }
      const persistence = ctx.get('sessionPersistence')
      const snapshot = await persistence.stat(sessionId).catch(() => undefined)
      if (snapshot === undefined) {
        throw new RemoteError('session/not-found', `会话不存在：${sessionId}`, {})
      }
      const query = ctx.get('sessionQuery')
      let events
      if (query !== undefined && typeof query.readSession === 'function') {
        const read = await query.readSession(sessionId)
        events = read.events
      } else {
        const file = await resolveLogPath(persistence, options, sessionId, snapshot.header)
        if (file === undefined) {
          throw new RemoteError('session/log-missing', `找不到会话日志：${sessionId}`, {})
        }
        events = (await readLogFile(file)).events
      }
      const turns = foldTurns(events)
      let displayTitle = ''
      if (typeof snapshot.header?.title === 'string') displayTitle = snapshot.header.title
      for (const event of events) {
        if (event?.type === 'session/title' && typeof event.data?.title === 'string') displayTitle = event.data.title
      }
      const visible = from === undefined ? turns : turns.filter((entry) => entry.turn >= from)
      const start = Math.max(0, visible.length - PREVIEW_TURN_LIMIT)
      return {
        sessionId,
        displayTitle,
        live: isLiveSession(ctx, sessionId),
        canClose: typeof ctx.get('agents')?.close === 'function',
        totalTurns: String(turns.length),
        turns: visible.slice(start).map((entry) => ({
          turn: String(entry.turn),
          prompt: entry.prompt,
          response: entry.response,
        })),
      }
    }

    /**
     * 删除某轮及之后的全部对话（截断会话日志）。
     * @param sessionId - 会话 id。
     * @param fromTurn - 十进制字符串，删除这一轮及之后的内容。
     * @returns `{ sessionId, fromTurn, applied, queued, removedTurns, removedEvents, remainingEvents }`；
     *          数值字段都是十进制字符串。queued 表示会话仍 live，已登记到下次启动。
     */
    async deleteTurnsFrom(sessionId, fromTurn) {
      if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
        throw new RemoteError('session/invalid-id', `非法的会话 id：${String(sessionId)}`, {})
      }
      const turn = typeof fromTurn === 'string' ? Number(fromTurn) : Number(fromTurn)
      if (!Number.isInteger(turn) || turn < 1) {
        throw new RemoteError('session/invalid-turn', `非法的轮次：${String(fromTurn)}`, {})
      }
      return enqueue(async () => {
        const persistence = ctx.get('sessionPersistence')
        const snapshot = await persistence.stat(sessionId).catch(() => undefined)
        if (snapshot === undefined) {
          throw new RemoteError('session/not-found', `会话不存在：${sessionId}`, {})
        }

        if (isLiveSession(ctx, sessionId)) {
          // 优先用核心补丁（plugins/core/agent-close.mjs）提供的 agents.close(id)：
          // 显式 dispose 这个 live agent，把会话写句柄放掉，然后原地重写日志。
          // 没有补丁（旧宿主）或释放失败时，退回「登记到下次启动」。
          const agents = ctx.get('agents')
          let released = false
          if (agents !== undefined && typeof agents.close === 'function') {
            try {
              released = await agents.close(sessionId)
            } catch (error) {
              if (ctx.logger !== undefined) {
                ctx.logger.warn(`[dsh-session-delete] 关闭 live agent 失败：${String(error)}`)
              }
            }
            if (released) released = await waitWritable(persistence, sessionId, 3000)
          }
          if (!released) {
            // 写句柄还在：只能登记，等下次宿主启动时再重写。
            let removedTurns = 0
            let removedEvents = 0
            let remainingEvents = 0
            try {
              const query = ctx.get('sessionQuery')
              if (query !== undefined && typeof query.readSession === 'function') {
                const read = await query.readSession(sessionId)
                const cut = read.events.findIndex(
                  (event) => event?.type === 'turn/start' && event.data?.turn === turn,
                )
                if (cut < 0) {
                  throw new RemoteError('session/turn-not-found', `会话里找不到第 ${turn} 轮`, {})
                }
                remainingEvents = cut
                removedEvents = read.events.length - cut
                removedTurns = read.events
                  .slice(cut)
                  .filter((event) => event?.type === 'turn/start').length
              }
            } catch (error) {
              if (error instanceof RemoteError) throw error
              if (ctx.logger !== undefined) {
                ctx.logger.warn(`[dsh-session-delete] 统计待截断轮次失败：${String(error)}`)
              }
            }
            await queuePendingTurn(options, sessionId, turn)
            return {
              sessionId,
              fromTurn: String(turn),
              applied: false,
              queued: true,
              removedTurns: String(removedTurns),
              removedEvents: String(removedEvents),
              remainingEvents: String(remainingEvents),
            }
          }
        }

        const file = await resolveLogPath(persistence, options, sessionId, snapshot.header)
        if (file === undefined) {
          throw new RemoteError('session/log-missing', `找不到会话日志：${sessionId}`, {})
        }
        const result = await truncateLogAtTurn(file, sessionId, turn)
        await rm(join(options.projectionCacheRoot, `${sessionId}.json`), { force: true })
        await dropPendingTurn(options, sessionId)
        return {
          sessionId,
          fromTurn: String(turn),
          applied: true,
          queued: false,
          removedTurns: String(result.removedTurns),
          removedEvents: String(result.removedEvents),
          remainingEvents: String(result.remainingEvents),
        }
      })
    }
  }

  // SRC 回退读取的原型描述符（与 @Remote('deleteSession') 写下的结构一致）。
  Object.defineProperty(SessionDeleteService.prototype, REMOTE_METHOD_DESCRIPTOR, {
    value: {
      version: 1,
      methods: [
        { method: 'deleteSession', invocation: { kind: 'direct' } },
        { method: 'previewTurns', invocation: { kind: 'direct' } },
        { method: 'deleteTurnsFrom', invocation: { kind: 'direct' } },
      ],
    },
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
  void flushPendingTurns(ctx, options).catch((error) => {
    if (ctx.logger !== undefined) ctx.logger.warn(`[dsh-session-delete] 启动末尾截断失败：${String(error)}`)
  })

  if (ctx.logger !== undefined) {
    ctx.logger.info(`[dsh-session-delete] 已挂载：sessionsRoot=${options.sessionsRoot}`)
  }
}
