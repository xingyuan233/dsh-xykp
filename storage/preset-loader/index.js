// dsh-xykp · storage/preset-loader
//
// 从「一个预设一个文件夹」的目录加载人格预设：
//   <dir>/<id>/preset.yml
//
// 干四件事：
//   1. 扫目录、注册预设（文件夹名必须 = 预设 id）
//   2. 每个预设算 sha256 指纹，记 mtime/size 到 .lock.json
//   3. 指纹变了就往 .changelog.log 追一行（只追加，不改历史）
//   4. 盯着目录：改完 preset.yml 自动重注册，不用重启宿主
//      —— 已经跑着的会话留在旧版本上，新会话用新版本（跟原来 patch 热重载一个语义）
//
// 安全原则：
//   - profile 里别人先声明的同名预设不抢（只记账）
//   - 新版本装载失败 / 装载出来是 broken → 自动回滚到上一个能用的定义
//   - 任何异常只记日志，绝不让宿主起不来
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, watch as fsWatch } from 'node:fs'
import {
  makeYaml,
  scanDir,
  readLock,
  writeLock,
  diffLock,
  changelogLines,
  appendChangelog,
  appendPerPresetChangelog,
  metaOf,
  localStamp,
  readSnapshot,
  writeSnapshot,
  diffLines,
} from './scan.js'

export const name = 'preset-loader'
export const inject = ['agentPresets']

const PREFIX = '[preset-loader]'
const log = (...args) => console.log(PREFIX, ...args)
const warn = (...args) => console.warn(PREFIX, ...args)

export function apply(ctx, config = {}) {
  void boot(ctx, config).catch((err) => warn('启动失败（已忽略）：', err?.stack || err))
}

async function boot(ctx, config) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dir = config.dir || join(home, 'profiles', 'web', 'presets')
  const lockPath = config.lockPath || join(dir, '.lock.json')
  const changelogPath = config.changelogPath || join(dir, '.changelog.log')
  const watchEnabled = config.watch !== false
  const debounceMs = Number.isFinite(config.debounceMs) ? config.debounceMs : 400

  let yamlMod
  try {
    yamlMod = await import('js-yaml')
  } catch (err) {
    warn('找不到 js-yaml，这层跳过：', err?.message || err)
    return
  }
  const yaml = makeYaml(yamlMod.default ?? yamlMod)

  mkdirSync(dir, { recursive: true })

  // id -> { dispose, definition, sha256 }
  const owned = new Map()
  // id -> 上次装载失败的那个文件指纹（文件没再变就别反复试）
  const badSha = new Map()
  let syncing = Promise.resolve()

  // 预设重推：把「刚改过」的预设重新绑到还活着的 agent 上。
  // 不推的话，老会话会一直攥着旧工具集，改了预设得等它重开才生效。
  // 会话里没起 agent 的（归档/关着的）跳过；单个失败只记日志，不打断别的会话。
  async function pushToLiveSessions(ids) {
    const presets = ctx.agentPresets
    if (!presets || typeof presets.recompose !== 'function') {
      warn('宿主里的 agentPresets 没有 recompose，跳过预设重推')
      return
    }
    const get = (name) => {
      try {
        const v = ctx.get ? ctx.get(name) : null
        if (v) return v
      } catch { /* 没这个服务就当没拿到，下面按属性名再试一次 */ }
      try { return ctx[name] || null } catch { return null }
    }
    const sessions = get('sessions')
    const agents = get('agents')
    if (!sessions || typeof sessions.list !== 'function' || !agents || typeof agents.get !== 'function') return
    let list = []
    try { list = sessions.list() } catch { return }
    for (const presetId of ids) {
      let done = 0
      let skipped = 0
      for (const session of list) {
        const header = session && (session.header || session)
        const mine = header && (header.agentPreset || header.preset)
        if (mine !== presetId) continue
        const sid = session.id || header.id
        let agent = null
        try { agent = agents.get(sid) } catch { agent = null }
        if (!agent) { skipped += 1; continue }
        try {
          await presets.recompose(agent.ctx, presetId)
          done += 1
        } catch (err) {
          skipped += 1
          warn(`把 ${presetId} 推给 ${sid} 失败：`, err?.message || err)
        }
      }
      log(`预设重推 ${presetId}：成功 ${done}，跳过 ${skipped}`)
    }
  }

  async function registeredIds() {
    try {
      return new Set((await ctx.agentPresets.list()).map((preset) => preset.id))
    } catch (err) {
      warn('读不到已注册列表：', err?.message || err)
      return new Set()
    }
  }

  async function isBroken(id) {
    try {
      const row = (await ctx.agentPresets.list()).find((preset) => preset.id === id)
      return row ? row.broken : undefined
    } catch (error) {
      return undefined
    }
  }

  /** 注册一个定义；失败或装载成 broken 都返回 false */
  async function register(entry) {
    try {
      const dispose = await ctx.agentPresets.register(entry.definition)
      const broken = await isBroken(entry.id)
      if (broken) {
        warn(`${entry.id} 装载失败：${broken}`)
        try {
          await dispose()
        } catch (error) {}
        return false
      }
      owned.set(entry.id, { dispose, definition: entry.definition, sha256: entry.sha256 })
      log(`已注册 ${entry.id}（${entry.rows} 行，${entry.sha256.slice(0, 12)}）`)
      return true
    } catch (err) {
      warn(`注册 ${entry.id} 失败：`, err?.message || err)
      return false
    }
  }

  /** 改动后重注册：先卸旧的，装新的；新的不行就装回旧的。返回是否装上新版本 */
  async function reload(entry, previous) {
    try {
      await previous.dispose()
    } catch (error) {}
    owned.delete(entry.id)
    log(`检测到改动，重注册 ${entry.id}`)
    if (await register(entry)) return true
    try {
      const dispose = await ctx.agentPresets.register(previous.definition)
      owned.set(entry.id, { dispose, definition: previous.definition, sha256: previous.sha256 })
      warn(`已经回滚到上一个能用的 ${entry.id}`)
    } catch (err) {
      warn(`回滚 ${entry.id} 也失败：`, err?.message || err)
    }
    return false
  }

  async function check() {
    const entries = scanDir(yaml, dir)
    for (const bad of entries.filter((entry) => entry.error)) warn(bad.error)
    const good = entries.filter((entry) => !entry.error)
    const next = {}
    for (const entry of good) next[entry.id] = metaOf(entry)

    const existing = await registeredIds()
    const diffs = [] // { id, text }
    for (const entry of good) {
      const mine = owned.get(entry.id)
      if (!mine) {
        if (existing.has(entry.id)) {
          log(`跳过 ${entry.id}：profile 里已经声明过（只记指纹）`)
          continue
        }
        if (await register(entry)) {
          writeSnapshot(dir, entry.id, { mtime: entry.mtime, sha256: entry.sha256, content: entry.content })
        }
        continue
      }
      if (mine.sha256 === entry.sha256) {
        // 内容没变：补一下快照（第一次跑 / 只有 touch 的时候）
        const snap = readSnapshot(dir, entry.id)
        if (!snap || snap.sha256 !== entry.sha256 || snap.mtime !== entry.mtime) {
          writeSnapshot(dir, entry.id, { mtime: entry.mtime, sha256: entry.sha256, content: entry.content })
        }
        continue
      }

      // 内容变了：先看这份改动是不是已经失败过（失败过就别反复试）
      if (badSha.get(entry.id) === entry.sha256) {
        log(`跳过 ${entry.id}：这份改动上次装载失败过，等文件再变`)
        continue
      }
      badSha.delete(entry.id)

      // 拿上次的快照出 diff，再重注册
      const snap = readSnapshot(dir, entry.id)
      if (!snap) {
        warn(`${entry.id} 改了，但没有上次快照（只记指纹，不出 diff）`)
      } else if (snap.sha256 !== entry.sha256) {
        const text = diffLines(snap.content, entry.content)
        if (text) {
          diffs.push({ id: entry.id, text })
          log(`${entry.id} 的改动：\n` + text)
        }
      }

      const ok = await reload(entry, mine)
      if (!ok) badSha.set(entry.id, entry.sha256)
      if (owned.get(entry.id)?.sha256 === entry.sha256) {
        writeSnapshot(dir, entry.id, { mtime: entry.mtime, sha256: entry.sha256, content: entry.content })
      }
    }

    for (const [id, mine] of [...owned]) {
      if (id in next) continue
      try {
        await mine.dispose()
      } catch (error) {}
      owned.delete(id)
      log(`已移除 ${id}`)
    }

    // 只有真变了才写锁 —— 不然锁文件自己会触发一轮监听，来回转圈
    const lock = readLock(lockPath)
    const diff = diffLock(lock, next)
    if (diff.added.length || diff.changed.length || diff.removed.length) {
      writeLock(lockPath, { version: 1, updatedAt: new Date().toISOString(), presets: next })
      const stamp = localStamp()
      const lines = changelogLines(diff, next)
      for (const item of diffs) {
        lines.push('', `${stamp}  ${item.id} diff：`, item.text)
      }
      appendChangelog(changelogPath, lines)
      // 每份留痕也写进预设自己的文件夹（.changelog.log），总索引那份当目录用
      try {
        appendPerPresetChangelog(dir, diff, diffs, next)
      } catch (err) {
        warn('写各预设留痕失败：', err?.message || err)
      }
      // 预设重推：改完之后把新版本推给「还活着、正用着这个预设」的会话
      if (diff.changed.length) {
        try {
          await pushToLiveSessions(diff.changed.map((c) => c.id))
        } catch (err) {
          warn('预设重推失败：', err?.stack || err)
        }
      }
      log('预设变动已留痕：\n' + lines.join('\n'))
    } else {
      log(`指纹没变（${localStamp()}）`)
    }
    return good.length
  }

  const count = await check()
  log(`目录 ${dir}：${count} 个可用预设`)

  if (!watchEnabled) return
  let timer
  try {
    const watcher = fsWatch(dir, { recursive: true }, (_event, filename) => {
      // 锁/留痕/临时文件自己写出来的动静，不算「有人改预设」
      if (filename && /(^|[\\/])\./.test(String(filename))) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        syncing = syncing
          .then(check)
          .catch((err) => warn('重新扫描失败：', err?.stack || err))
      }, debounceMs)
    })
    ctx.on('dispose', () => {
      clearTimeout(timer)
      try {
        watcher.close()
      } catch (error) {}
    })
    log('目录监听已开启（改 preset.yml 会自动重注册，不用重启）')
  } catch (err) {
    warn('目录监听不可用（改动要重启才生效）：', err?.message || err)
  }
}
