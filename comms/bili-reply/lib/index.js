// bili-reply · 宿主半边
//
// 需求（任务-2026-10-27.md 第四节）：
//   1. 绑定预设或会话（预设优先，参考 preset-binder）—— 见 bind.js
//   2. 轮询 @ / 回复（默认 120 秒），新条目推送到绑定的会话
//   3. 只推新的：seen 表去重，轮询之间不会重复打扰
//
// ⚠️ 现状（2026-10-27 05:15）：
//   · 绑定解析、去重、消息构造、轮询调度、推送适配器都已经就位并自测过
//   · **拉取 B 站收件箱的接口还没接**：`fetchItems` 默认返回空数组，
//     接入时换成 subagent 里那套（@ / 回复 / 私信三路），或直接复用 mcp_server 的 bili_* 工具
//
// 出任何错只记日志，绝不拖死宿主。
//
// ⚠️ 2026-10-27 事故（参考号 MF-mvq18jvo4sut）：
//   之前用裸 `session.append('user/message', { role, content })` 落消息，**没有 source**。
//   宿主的 projection（sessionListMetadata / sessionTitle / turnOutline）和
//   agent-loop 的 RuntimeContextProjection 都会读 `event.data.source.kind`，
//   于是一条没 source 的 user/message 会让整个会话 projection 抛
//   `Cannot read properties of undefined (reading 'kind')`，历史加载失败、回合也跑不动。
//   现在用宿主的 createUserMessage（自带 id + 冻结），source 用插件自己的 kind。
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveTarget, DEFAULTS as BIND_DEFAULTS } from './bind.js'
import { pickFresh, render, keyOf } from './dedupe.js'
import { createFetcher } from './fetch.js'
import { loadQueue, saveQueue, enqueue, trim, take, consume, failItem, DEFAULTS as QUEUE_DEFAULTS } from './queue.js'
import { resolveCookie, DEFAULTS as COOKIE_DEFAULTS } from './cookie.js'
import { loadCache, saveCache, emptyCache, resolveNames, DEFAULTS as NAME_DEFAULTS } from './names.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** 这条 user/message 的来源标记（宿主要求每个 message 都有 source.kind）。 */
export const SOURCE_KIND = 'plugin:bili-reply'

export const name = 'bili-reply'
export const inject = ['timer', 'sessions', 'agents', 'webServer']

const PREFIX = '[bili-reply]'
const log = (...a) => console.log(PREFIX, ...a)
const warn = (...a) => console.warn(PREFIX, ...a)

export const DEFAULTS = {
  ...BIND_DEFAULTS,
  ...COOKIE_DEFAULTS,
  ...QUEUE_DEFAULTS,
  ...NAME_DEFAULTS,
  // 昵称缓存「后台重读」：每批查几个（0 = 跟 namesMaxFetchPerRun 一样）、隔几分钟一批
  // （2026-10-27：refresh 从「一次最多 5 个」改成排队分批，直到全查完）
  namesRefreshBatch: 0,
  namesRefreshEveryMinutes: 2,
  // 本地队列文件，空 = <DSH_HOME>/bili-duty/reply-queue.json
  queuePath: '',
  // 拉哪几路：at（@ 我的）/ reply（回复我的）
  kinds: ['at', 'reply', 'dm'],
  // 拉取实现：'bili'（默认，真接口）| 'none'（空转，调试用）
  source: 'bili',
  dryRun: false,
}

const home = () => process.env.DSH_HOME || join(homedir(), '.dsh')

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(path, data) {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(data, null, 2), 'utf8')
  } catch (err) {
    warn(`写 ${path} 失败：`, err?.message || err)
  }
}

async function loadBinder() {
  return readJson(join(home(), 'xykp', 'preset-binder', 'preset-binder.json'), null)
}

/**
 * 默认的空实现：接 B 站 API 之前什么都不拉。
 * 换成真实现时保持返回结构 [{ kind:'at'|'reply'|'dm', id, rpid, mid, nickname, bvid, content, at }]。
 */
async function fetchItemsNone() {
  return []
}

/**
 * 推送一条文本到会话。
 * 先用 session.append 落一条 user/message（掉电也能看到），
 * 真正「叫醒她跑一轮」的接口待和宿主确认（inbox/steer），这里用可替换的 deliver。
 *
 * ⚠️ 必须用 createUserMessage 造消息：宿主所有 projection 都会读 `message.source.kind`，
 *    裸对象（没有 source）会让会话历史直接加载失败（2026-10-27 事故）。
 */
async function deliverDefault(ctx, sessionId, text) {
  const agents = ctx.agents
  if (!agents || typeof agents.get !== 'function') throw new Error('拿不到 agents 服务')

  // ⚠ 2026-10-27：append 只落一条事件、**不会开新一轮**；
  //   要真的「唤醒」得走 agent.followup（speak-up 就是这么做的）。
  //   会话 id 有带/不带 session- 前缀两种写法，都试一遍。
  const 候选 = [String(sessionId)]
  if (String(sessionId).startsWith('session-')) 候选.push(String(sessionId).slice('session-'.length))
  else 候选.push('session-' + sessionId)
  let agent = null
  for (const id of 候选) {
    try {
      const a = agents.get(id)
      if (a) { agent = a; break }
    } catch { /* 查不动当没找到 */ }
  }
  if (!agent) throw new Error('会话 ' + sessionId + ' 不在了（agent 拿不到，可能被归档/删了）')

  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND },
  })
  // ⚠ 必须 await：followup 的 rejection 不接住 = 未处理 rejection = 整个宿主退出
  await agent.followup(message)
  return { delivered: true, via: 'followup' }
}

async function tick(ctx, cfg, deps) {
  const binder = await deps.loadBinder()
  const target = resolveTarget(cfg, binder)
  if (!target.sessionId) {
    return { skipped: true, reason: target.reason || '没有绑定目标' }
  }
  const queuePath = cfg.queuePath || join(home(), 'bili-duty', 'reply-queue.json')
  const q = await deps.loadQueue(queuePath, cfg.queueName)

  // 队列里早前没查到昵称的（私信不带昵称），缓存里现在有了就直接补上
  // —— 只读缓存、不查接口、不占 namesMaxFetchPerRun 的额度 ✓
  if (deps.fillNames) {
    try {
      if (await deps.fillNames(q.items)) log('队列里有条目补上了昵称（来自缓存）')
    } catch (err) {
      warn('补队列昵称失败（不影响推送）：', err?.message || err)
    }
  }

  // 本地队列空了才去接口拉 —— 一次全拉到本地，再慢慢处理
  let pulled = 0
  if (!q.items.length) {
    const items = await deps.fetchItems(cfg)
    pulled = enqueue(q, items)
    q.lastPullAt = Date.now()
    trim(q, cfg)
    if (!cfg.dryRun) await deps.saveQueue(queuePath, q)
    if (pulled) log(`从接口拉入 ${pulled} 条（队列 ${q.items.length}）`)
  }

  const batch = take(q, cfg.maxPerTick)
  if (!batch.length) return { target, pulled, done: 0, queue: q.items.length }

  const doneKeys = []
  for (const item of batch) {
    const text = render(item)
    if (cfg.dryRun) {
      log(`[dry] 会推送 ${item.key} → ${target.sessionId}：${text}`)
      doneKeys.push(item)
      continue
    }
    try {
      await deps.deliver(ctx, target.sessionId, text)
      doneKeys.push(item)
    } catch (err) {
      failItem(item)
      warn(`推送 ${item.key} 失败（第 ${item.tries} 次，${new Date(item.nextTryAt).toLocaleTimeString()} 再试）：`, err?.message || err)
    }
  }
  if (!cfg.dryRun) {
    consume(q, doneKeys)
    await deps.saveQueue(queuePath, q)
  }
  return { target, pulled, done: doneKeys.length, queue: q.items.length }
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  const fetcher = createFetcher(cfg)

  // ── 昵称缓存的后台重读（2026-10-27 改）──
  // 以前 refresh 是一次请求里最多查 5 个（namesMaxFetchPerRun 挡住），查不完还得再点。
  // 现在 refresh 只负责「把全部标过期 + 排队」，真正的查名字在后台一批一批做，
  // 每批 namesRefreshBatch 个、隔 namesRefreshEveryMinutes 分钟，直到查完（每批失败的最多重试 3 批）。
  const namesPath = () => cfg.namesCachePath || join(home(), 'bili-duty', 'names-cache.json')
  const 重读批大小 = () => Math.max(1, Number(cfg.namesRefreshBatch) || Number(cfg.namesMaxFetchPerRun) || 5)
  const 重读间隔分钟 = () => Math.max(0.05, Number(cfg.namesRefreshEveryMinutes) || 2)
  const 待重读 = new Set()
  const 重读次数 = new Map()
  let 重读计时器 = null
  let 重读批数 = 0

  /** 把一批 uid 排进后台重读（后台已经在跑就把新 uid 合并进去） */
  function 排重读(mids = []) {
    for (const raw of mids) {
      const mid = String(raw || '')
      if (!mid) continue
      待重读.add(mid)
      if (!重读次数.has(mid)) 重读次数.set(mid, 0)
    }
    if (!重读计时器 && 待重读.size) void 跑一批重读()
    return 待重读.size
  }

  /** 跑一批：这些 uid 的 at 已经/将被标成 0，resolveNames 会真的去查 */
  async function 跑一批重读() {
    重读计时器 = null
    if (!待重读.size) return
    const batch = [...待重读].slice(0, 重读批大小())
    try {
      const cache = await loadCache(namesPath())
      const cookie = await resolveCookie(cfg)
      const { names, fetched } = await resolveNames(
        batch,
        cache,
        { ...cfg, namesMaxFetchPerRun: batch.length },
        undefined,
        cookie,
      )
      for (const [mid, name] of Object.entries(names || {})) {
        if (!name) continue
        待重读.delete(String(mid))
        重读次数.delete(String(mid))
      }
      // 没查到的：最多重试 3 批，之后放弃（名字保留原值，只把 at 留在 0）
      for (const mid of batch) {
        if (names && names[mid]) continue
        const n = (重读次数.get(mid) || 0) + 1
        if (n >= 3) {
          待重读.delete(mid)
          重读次数.delete(mid)
          warn(`昵称重读放弃 ${mid}（3 批都没查到）`)
        } else {
          重读次数.set(mid, n)
        }
      }
      await saveCache(namesPath(), cache)
      重读批数++
      log(`昵称重读第 ${重读批数} 批：${batch.length} 个，查到 ${fetched} 个，剩 ${待重读.size}`)
    } catch (err) {
      warn('昵称重读这一批出错（稍后再试）：', err?.message || err)
    }
    if (待重读.size) {
      重读计时器 = setTimeout(() => void 跑一批重读(), 重读间隔分钟() * 60000)
      if (typeof 重读计时器.unref === 'function') 重读计时器.unref()
    } else {
      log(`昵称重读完成：共 ${重读批数} 批`)
      重读批数 = 0
    }
  }

  const deps = {
    loadBinder,
    loadQueue,
    saveQueue,
    fetchItems: async (c) => {
      if (String(c.source || 'bili') === 'none') return fetchItemsNone()
      const cookie = await resolveCookie(c)
      if (!cookie) {
        warn('没有 cookie，这一轮不拉（配置 cookie / 环境变量 / bili-duty/config.json 都空）')
        return []
      }
      return fetcher({ cookie, kinds: c.kinds })
    },
    deliver: deliverDefault,
    // 队列里旧条目缺昵称：缓存里有了就补（只读缓存，不查接口）
    fillNames: async (items) => {
      try {
        const cache = await loadCache(namesPath())
        let dirty = false
        for (const it of items || []) {
          if (!it || it.nickname || !it.mid) continue
          const hit = cache.uids[String(it.mid)]
          if (hit && hit.name) {
            it.nickname = hit.name
            dirty = true
          }
        }
        return dirty
      } catch {
        return false
      }
    },
  }
  const run = async (label) => {
    try {
      const r = await tick(ctx, cfg, deps)
      if (r.skipped) {
        log(`${label}：跳过（${r.reason}）`)
        return
      }
      if (r.fresh) log(`${label}：拉到 ${r.pulled} 条，新的 ${r.fresh} 条，推了 ${r.sent} 条 → ${r.target.sessionId}`)
    } catch (err) {
      warn(`${label} 失败（已忽略）：`, err?.stack || err)
    }
  }
  void run('启动检查')

  // ── 昵称缓存的接口：看 / 重置 / 重读（重读走后台分批，见上面的 排重读）──
  try {
    const sendJson = (res, code, data) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(data))
    }
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/dsh-bili-reply',
      handler: async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1')
        const p = url.pathname
        if (req.method === 'GET' && (p === '/dsh-bili-reply/names' || p === '/dsh-bili-reply/names/')) {
          const cache = await loadCache(namesPath())
          const now = Date.now()
          const ttl = Math.max(0, Number(cfg.namesTtlHours) || 0)
          const rows = Object.entries(cache.uids).map(([mid, v]) => ({
            mid, name: v.name, at: v.at,
            ageHours: Math.round(((now - Number(v.at || 0)) / 3600000) * 10) / 10,
            expired: !(ttl && now - Number(v.at || 0) < ttl * 3600000),
          }))
          return sendJson(res, 200, { ok: true, count: rows.length, ttlHours: ttl, uids: rows })
        }
        if (req.method === 'POST' && p === '/dsh-bili-reply/names/reset') {
          await saveCache(namesPath(), emptyCache())
          log('昵称缓存已清空（下次拉取会重新查）')
          return sendJson(res, 200, { ok: true, cleared: true })
        }
        if (req.method === 'POST' && p === '/dsh-bili-reply/names/refresh') {
          // 强制重读：全部条目标成过期（名字保留，不清空），然后**排队**给后台
          // 一批一批查（每批 namesRefreshBatch 个、隔 namesRefreshEveryMinutes 分钟），
          // 直到查完 —— 接口本身立刻返回，不会像以前那样一次请求里死等好几个接口 ✓
          const cache = await loadCache(namesPath())
          const mids = Object.keys(cache.uids)
          for (const k of mids) {
            if (cache.uids[k]) cache.uids[k].at = 0
          }
          await saveCache(namesPath(), cache)
          const queued = 排重读(mids)
          log(
            `昵称缓存重读已排队：${queued} 个 uid，每批 ${重读批大小()} 个、间隔 ${重读间隔分钟()} 分钟（后台进行）`,
          )
          return sendJson(res, 200, {
            ok: true,
            mode: 'background',
            queued,
            batch: 重读批大小(),
            everyMinutes: 重读间隔分钟(),
          })
        }
        return sendJson(res, 404, { ok: false, error: 'unknown ' + req.method + ' ' + p })
      },
    }), 'bili-reply: 昵称缓存接口')
  } catch (err) {
    warn('昵称缓存接口没挂上（不影响推送）：', err?.message || err)
  }

  // 启动时：缓存里还有「被标过期但没查完」的（上次 refresh 没做完 / 中途重启过），接着排后台
  void (async () => {
    try {
      const cache = await loadCache(namesPath())
      const 待补 = Object.entries(cache.uids)
        .filter(([, v]) => v && v.name && !(Number(v.at) > 0))
        .map(([mid]) => mid)
      if (待补.length) {
        log(`缓存里有 ${待补.length} 个昵称上次没查完，接着后台重读`)
        排重读(待补)
      }
    } catch (err) {
      warn('启动补排昵称重读失败（不影响推送）：', err?.message || err)
    }
  })()

  const minutes = Math.max(1, Number(cfg.tickMinutes) || DEFAULTS.tickMinutes)
  const timer = setInterval(() => void run('处理'), minutes * 60 * 1000)
  if (typeof timer.unref === 'function') timer.unref()
  try {
    ctx.on('dispose', () => {
      clearInterval(timer)
      if (重读计时器) clearTimeout(重读计时器)
    })
  } catch {
    /* 收摊失败无所谓 */
  }
}

export const _internal = { tick, fetchItemsNone, deliverDefault, DEFAULTS, SOURCE_KIND }
export { resolveTarget, pickFresh, render, keyOf }








