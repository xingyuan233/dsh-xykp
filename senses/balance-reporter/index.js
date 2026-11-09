// dsh-xykp · senses/balance-reporter
//
// DeepSeek 余额的「服务端半边」：给页面里的 VK-1 挂件提供缓存过的余额快照，
// 顺便给 Agent 一个 balance_report 工具查余额 / 变动历史。
//
// 页面挂件本体在包根 client.js（senses/balance-reporter 生成段）——
// 即使这个宿主插件没加载，挂件也会退回客户端 remote.account 直接查余额；
// 加载后挂件优先走 /xykp/balance-reporter/status，省掉重复请求、还能拿到历史。
//
// 余额来源：DSH 的 deepseekAccount 服务（平台登录态），不读环境里的 API Key，
// 也不把余额写到日志里。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configFor } from '../../ui/store.js'

export const name = 'balance-reporter'
// 只等 tools；webServer 用 ctx.get 软取，宿主没挂也不影响工具。
export const inject = ['tools']

const DEFAULTS = {
  enabled: true,
  tool: true,
  route: true,
  lowBalance: 20,
  refreshSeconds: 10,
  historyLimit: 240,
  holidays: true,
  // 法定节假日：宿主每周从 holiday-cn 拉一次，落盘缓存；页面也能直接读这个缓存。
  holidayUrl: 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master',
  holidayRefreshDays: 7,
}

const STATE_VERSION = 1
const HOLIDAY_VERSION = 1
const homeDir = () => process.env.DSH_HOME || 'D:\\AI\\DeepseekHarness\\home'
const pluginDir = () => dirname(fileURLToPath(import.meta.url))
export const statePath = () => join(homeDir(), 'xykp', 'balance-reporter', 'state.json')
export const holidayPath = () => join(homeDir(), 'xykp', 'balance-reporter', 'holidays.json')
const embeddedHolidayPath = () => join(pluginDir(), 'client', 'holidays.json')

/** 进程内缓存：并发请求合并成一次平台查询。 */
let cache = { at: 0, data: null, pending: null }

function readState() {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8'))
    if (!raw || raw.version !== STATE_VERSION) return { version: STATE_VERSION, history: [] }
    return {
      version: STATE_VERSION,
      history: Array.isArray(raw.history) ? raw.history.filter((x) => Number.isFinite(Number(x?.at)) && Number.isFinite(Number(x?.total))).slice(-400) : [],
    }
  } catch {
    return { version: STATE_VERSION, history: [] }
  }
}

function writeJsonFile(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(value), 'utf8')
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

function saveState(state) {
  writeJsonFile(statePath(), state)
}

// --------------------------------------------------------------- 节假日 ---

let holidayCache = null
let holidayPending = null

function normalizeHolidayData(raw, source) {
  if (!raw || !Array.isArray(raw.days)) return null
  const days = [...new Set(raw.days.map((d) => String(d)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort()
  if (!days.length) return null
  const years = Array.isArray(raw.years) ? [...new Set(raw.years.map(Number).filter(Number.isFinite))].sort() : []
  return {
    version: HOLIDAY_VERSION,
    updatedAt: Number(raw.updatedAt) || 0,
    years,
    days,
    source: source || raw.source || 'cache',
  }
}

/** 先读落盘缓存，再退包里自带的快照（client/holidays.json）。 */
function loadHolidays() {
  for (const [path, source] of [
    [holidayPath(), 'cache'],
    [embeddedHolidayPath(), 'embedded'],
  ]) {
    try {
      const data = normalizeHolidayData(JSON.parse(readFileSync(path, 'utf8')), source)
      if (data) return data
    } catch {
      /* 换下一个来源 */
    }
  }
  return null
}

function holidayYears() {
  const year = new Date(Date.now() + 8 * 3600000).getUTCFullYear()
  return [year, year + 1, year + 2]
}

function holidayNeedsRefresh(data, refreshDays) {
  if (!data) return true
  if (Date.now() - data.updatedAt > Math.max(1, refreshDays) * 86400000) return true
  // 只要当前年和下一年有数据就能撑到下次；再下一年一般还没公布。
  const [year, next] = holidayYears()
  return !(data.years.includes(year) && data.years.includes(next))
}

async function fetchHolidayYears(baseUrl, years, previous) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (!base) return null
  const set = new Set(previous?.days || [])
  const got = []
  for (const year of years) {
    try {
      const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined
      const res = await fetch(`${base}/${year}.json`, { cache: 'no-store', signal })
      if (!res.ok) continue
      const data = await res.json()
      for (const day of data.days || []) {
        if (day.isOffDay && /^\d{4}-\d{2}-\d{2}$/.test(String(day.date))) set.add(day.date)
      }
      got.push(year)
    } catch {
      /* 单年失败不拖累其它年份 */
    }
  }
  if (!got.length) return null
  return {
    version: HOLIDAY_VERSION,
    updatedAt: Date.now(),
    years: [...new Set([...(previous?.years || []), ...got])].sort(),
    days: [...set].sort(),
    source: 'network',
  }
}

/** 过期/缺年份时拉一次；并发合并；失败退回旧缓存。 */
async function ensureHolidays(config, { force = false } = {}) {
  if (!holidayCache) holidayCache = loadHolidays()
  if (config.holidays === false) return holidayCache
  const refreshDays = Number(config.holidayRefreshDays) || 7
  if (!force && holidayCache && !holidayNeedsRefresh(holidayCache, refreshDays)) return holidayCache
  if (holidayPending) return holidayPending
  holidayPending = (async () => {
    const next = await fetchHolidayYears(config.holidayUrl, holidayYears(), holidayCache)
    if (next) {
      const merged = new Set([...(holidayCache?.days || []), ...next.days])
      holidayCache = { ...next, days: [...merged].sort() }
      writeJsonFile(holidayPath(), holidayCache)
    } else if (holidayCache) {
      // 拉取失败也把「已尝试」时间推进，避免每次请求都打网络。
      holidayCache = { ...holidayCache, updatedAt: Date.now() }
      writeJsonFile(holidayPath(), holidayCache)
    }
    return holidayCache
  })()
  try {
    return await holidayPending
  } finally {
    holidayPending = null
  }
}


/** 把 deepseekAccount.getBalance() 的结果归一成 { total, currency, wallets, bonusWallets }。 */
export function normalizeBalance(result) {
  if (!result || result.status !== 'ready') return null
  const wallets = Array.isArray(result.value) ? result.value : []
  const bonusWallets = Array.isArray(result.bonusWallets) ? result.bonusWallets : []
  let total = 0
  let currency = 'CNY'
  for (const w of [...wallets, ...bonusWallets]) {
    const n = Number(w?.balance)
    if (Number.isFinite(n)) total += n
    if (w?.currency) currency = w.currency
  }
  return {
    total: Math.round(total * 1e8) / 1e8,
    currency,
    wallets: wallets.map((w) => ({ currency: w.currency, balance: String(w.balance) })),
    bonusWallets: bonusWallets.map((w) => ({ currency: w.currency, balance: String(w.balance) })),
  }
}

function trimNumber(v) {
  const n = Number(v)
  return Number.isFinite(n) ? String(Math.round(n * 1e8) / 1e8) : String(v)
}

function appendHistory(data) {
  const state = readState()
  const last = state.history[state.history.length - 1]
  if (!last || Math.abs(Number(last.total) - data.total) > 1e-9) {
    state.history.push({ at: data.at, total: data.total, currency: data.currency })
    const limit = 400
    if (state.history.length > limit) state.history = state.history.slice(-limit)
    saveState(state)
  }
}

async function refresh(ctx, config, { force = false, maxAge } = {}) {
  const ttl =
    maxAge != null && Number.isFinite(Number(maxAge))
      ? Math.max(0, Number(maxAge) * 1000)
      : Math.max(5, Number(config.refreshSeconds) || 10) * 1000
  if (!force && cache.data && Date.now() - cache.at < ttl) return cache.data
  if (cache.pending) return cache.pending
  const task = (async () => {
    const account = ctx.get('deepseekAccount')
    if (!account || typeof account.getBalance !== 'function') {
      throw new Error('DSH 的 deepseekAccount 服务没挂载（无法读取平台余额）')
    }
    const result = await account.getBalance({
      version: 'dsh-xykp/balance-reporter',
      locale: 'zh-CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    })
    if (result?.status === 'failed') throw new Error('平台余额查询失败（登录态可能过期，去设置页重新登录）')
    const normalized = normalizeBalance(result)
    if (!normalized) throw new Error('账号还没登录，查不到余额')
    const data = {
      ok: true,
      at: Date.now(),
      total: normalized.total,
      currency: normalized.currency,
      wallets: normalized.wallets,
      bonusWallets: normalized.bonusWallets,
      lowBalance: Number(config.lowBalance) || 0,
      low: normalized.total < (Number(config.lowBalance) || 0),
      source: 'deepseek-account-platform',
    }
    cache = { at: Date.now(), data, pending: null }
    appendHistory(data)
    return data
  })()
  cache.pending = task
  try {
    return await task
  } finally {
    if (cache.pending === task) cache.pending = null
  }
}

function fmtTime(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmt(n, currency = 'CNY') {
  return `${currency === 'CNY' ? '¥' : '$'}${(Math.round(Number(n) * 100) / 100).toFixed(2)}`
}

function statusText(data) {
  const lines = [`【余额】${fmt(data.total, data.currency)}`]
  const normal = data.wallets.map((w) => `${w.currency} ${trimNumber(w.balance)}`).join('，')
  const bonus = data.bonusWallets.map((w) => `${w.currency} ${trimNumber(w.balance)}`).join('，')
  lines.push(`充值：${normal || '无'}`)
  lines.push(`赠金：${bonus || '无'}`)
  lines.push(`来源：${data.source} · 更新 ${fmtTime(data.at)}`)
  const state = readState()
  const dayAgo = Date.now() - 24 * 3600 * 1000
  const first = state.history.find((x) => x.at >= dayAgo)
  if (first && Math.abs(first.total - data.total) > 1e-9) {
    const delta = data.total - first.total
    lines.push(`较 ${fmtTime(first.at)}：${delta > 0 ? '+' : ''}${(Math.round(delta * 100) / 100).toFixed(2)}`)
  }
  if (data.low) lines.push(`⚠️ 低于提醒线 ${fmt(data.lowBalance, data.currency)}，该充值了`)
  lines.push('页面右下角的 VK-1 挂件会按同一份余额自动刷新。')
  return lines.join('\n')
}

function historyText(data) {
  const state = readState()
  if (!state.history.length) return '还没有余额变动记录（第一次查询之后才会有）。'
  const tail = state.history.slice(-20)
  const lines = [`【余额变动】最近 ${tail.length} 条（当前 ${fmt(data.total, data.currency)}）`]
  for (let i = tail.length - 1; i >= 0; i--) {
    const row = tail[i]
    const prev = i > 0 ? tail[i - 1] : null
    const delta = prev ? row.total - prev.total : null
    const sign = delta === null ? '' : delta > 0 ? `+${(Math.round(delta * 100) / 100).toFixed(2)}` : (Math.round(delta * 100) / 100).toFixed(2)
    lines.push(`${fmtTime(row.at)}  ${fmt(row.total, row.currency || data.currency)}${sign ? '  (' + sign + ')' : ''}`)
  }
  return lines.join('\n')
}

function toolDefinition(ctx, config) {
  return {
    name: 'balance_report',
    description: '账号余额（DSH 平台登录态）：status 当前余额与变化 / history 最近变动 / refresh 强制刷新 / holidays 节假日数据状态。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'history', 'refresh', 'holidays'],
          description: '默认 status',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
      },
      render(_args, value) {
        return [{ type: 'text', text: String(value?.text ?? '') }]
      },
    },
    async execute(args = {}) {
      const action = args.action || 'status'
      try {
        if (action === 'holidays') {
          const data = await ensureHolidays(config)
          if (!data) throw new Error('没有可用的节假日数据')
          return {
            text: `【节假日】覆盖 ${data.years.join('、')}，共 ${data.days.length} 天；更新 ${fmtTime(data.updatedAt)}；来源 ${data.source}`,
          }
        }
        const data = await refresh(ctx, config, { force: action === 'refresh' })
        return { text: action === 'history' ? historyText(data) : statusText(data) }
      } catch (err) {
        return { text: `【余额】查询失败：${err?.message || err}`, isError: true }
      }
    },
  }
}

export function apply(ctx, rawConfig = {}) {
  const config = configFor('senses-balance-reporter', { ...DEFAULTS, ...rawConfig })
  if (!config.enabled) return

  if (config.tool !== false) {
    ctx.effect(() => {
      const dispose = ctx.tools.register(toolDefinition(ctx, config))
      return () => {
        try {
          dispose?.()
        } catch {
          /* ignore */
        }
      }
    })
  }

  const webServer = ctx.get('webServer')
  if (webServer && config.route !== false) {
    ctx.effect(() => {
      const disposeStatus = webServer.register({
        kind: 'exact',
        path: '/xykp/balance-reporter/status',
        handler: async (req, res) => {
          const headers = {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          }
          try {
            const url = new URL(req.url || '/', 'http://127.0.0.1')
            const maxAge = url.searchParams.get('maxAge')
            const data = await refresh(ctx, config, {
              force: url.searchParams.get('force') === '1',
              maxAge: maxAge != null ? Number(maxAge) : undefined,
            })
            res.writeHead(200, headers)
            res.end(JSON.stringify(data))
          } catch (err) {
            res.writeHead(200, headers)
            res.end(JSON.stringify({ ok: false, error: String(err?.message || err).slice(0, 300) }))
          }
        },
      })
      const disposeHolidays = webServer.register({
        kind: 'exact',
        path: '/xykp/balance-reporter/holidays',
        handler: async (req, res) => {
          const headers = {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          }
          try {
            const url = new URL(req.url || '/', 'http://127.0.0.1')
            const data = await ensureHolidays(config, { force: url.searchParams.get('force') === '1' })
            if (!data) throw new Error('没有可用的节假日数据')
            res.writeHead(200, headers)
            res.end(JSON.stringify({ ok: true, updatedAt: data.updatedAt, years: data.years, days: data.days, source: data.source }))
          } catch (err) {
            res.writeHead(200, headers)
            res.end(JSON.stringify({ ok: false, error: String(err?.message || err).slice(0, 300) }))
          }
        },
      })
      return () => {
        try {
          disposeStatus?.()
        } catch {
          /* ignore */
        }
        try {
          disposeHolidays?.()
        } catch {
          /* ignore */
        }
      }
    })
  }

  // 节假日：启动时先读缓存；缺年份/过期就后台拉一次，之后每 6 小时检查。
  holidayCache = loadHolidays()
  if (config.holidays !== false) {
    ensureHolidays(config).catch(() => {})
    const timer = setInterval(() => {
      ensureHolidays(config).catch(() => {})
    }, 6 * 3600 * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    ctx.effect(() => () => clearInterval(timer))
  }

  ctx.effect(() => () => {
    cache = { at: 0, data: null, pending: null }
  })
}
