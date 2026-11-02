// dsh-xykp · web/web-search-free
//
// 一个免费的 `web_search` 提供方：直接抓 Bing / 360 的搜索结果页，抠出标题、
// 链接、摘要，再按 URL 去重、两个引擎的结果交替合并。
//
// 为什么要有它：官方 `web-search-deepseek` 走的是 DeepSeek 服务端的联网检索，
// 每次搜索都是一次带 server-tool-search 的模型请求（账单里那 0.07 元/小时就是它）。
// 这个插件不发模型请求，只是一个 HTTP GET，所以除了流量不花钱。
//
// 它是 dsh-web 的一个 provider（id 默认 `free`），`web_search` 工具本身不用改。
// 在 profile 里把 web 行切过来就能用：
//
//   - id: web
//     config:
//       searchProvider: free
//       fetchProvider: http
//
// 想换回官方检索就把 searchProvider 改回 deepseek-official。
//
// config 示例：
//   - id: web-search-free
//     name: 'dsh-xykp/web/web-search-free'
//     config:
//       providerId: free          # 注册成哪个 provider id
//       engines: [so, bing]       # 并发请求；也可以用 [so] 只用一个
//       maxResults: 8             # web_search 没指定 maxResults 时的上限
//       timeoutMs: 12000          # 单个引擎的超时
//       cacheTtlMs: 600000        # 相同 query+engine 10 分钟内复用
//       cooldownMs: 600000        # 某个引擎触发人机验证后，歇这么久再试
//       locale: zh-CN             # 影响 Bing 的 setlang 和 Accept-Language
//       userAgent: ''             # 空 = 用内置 Chrome UA
//       debug: false              # true 时把每次降级原因打到 stderr
//       enabled: true

import Schema from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'
import { DEFAULT_UA, ENGINES, engineIds, searchEngine } from './engines.js'

export const name = 'web-search-free'
export const inject = ['web']

// 360 的结果页里偶尔混进自家导流位（视频 / 文档 / 导航），以及搜索引擎自己的域名。
const DEFAULT_BLOCK_HOSTS = ['so.com', '360kan.com', '360doc.com', 'hao.360.cn', 'bing.com']

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  providerId: Schema.string().default('free'),
  engines: Schema.array(Schema.string()).default(['so', 'bing']),
  maxResults: Schema.number().default(8),
  timeoutMs: Schema.number().default(12000),
  cacheTtlMs: Schema.number().default(10 * 60 * 1000),
  cooldownMs: Schema.number().default(10 * 60 * 1000),
  locale: Schema.string().default('zh-CN'),
  userAgent: Schema.string().default(''),
  blockHosts: Schema.array(Schema.string()).default(DEFAULT_BLOCK_HOSTS),
  debug: Schema.boolean().default(false),
})

const DEFAULTS = {
  enabled: true,
  providerId: 'free',
  engines: ['so', 'bing'],
  maxResults: 8,
  timeoutMs: 12000,
  cacheTtlMs: 10 * 60 * 1000,
  cooldownMs: 10 * 60 * 1000,
  locale: 'zh-CN',
  userAgent: '',
  blockHosts: DEFAULT_BLOCK_HOSTS,
  debug: false,
}

function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULTS, ...(raw || {}) }
  const engines = (Array.isArray(cfg.engines) ? cfg.engines : DEFAULTS.engines)
    .map((id) => String(id).trim().toLowerCase())
    .filter((id) => id && ENGINES[id])
  cfg.engines = engines.length ? engines : [...DEFAULTS.engines]
  cfg.providerId = String(cfg.providerId || DEFAULTS.providerId).trim() || DEFAULTS.providerId
  cfg.maxResults = clampInt(cfg.maxResults, 1, 20, DEFAULTS.maxResults)
  cfg.timeoutMs = clampInt(cfg.timeoutMs, 1000, 60000, DEFAULTS.timeoutMs)
  cfg.cacheTtlMs = clampInt(cfg.cacheTtlMs, 0, 24 * 60 * 60 * 1000, DEFAULTS.cacheTtlMs)
  cfg.cooldownMs = clampInt(cfg.cooldownMs, 0, 60 * 60 * 1000, DEFAULTS.cooldownMs)
  cfg.userAgent = String(cfg.userAgent || '').trim() || DEFAULT_UA
  cfg.locale = String(cfg.locale || '').trim()
  cfg.blockHosts = (Array.isArray(cfg.blockHosts) ? cfg.blockHosts : DEFAULT_BLOCK_HOSTS)
    .map((host) => String(host).trim().toLowerCase())
    .filter(Boolean)
  return cfg
}

function isBlocked(cfg, url) {
  if (!cfg.blockHosts.length) return false
  try {
    const host = new URL(url).hostname.toLowerCase()
    return cfg.blockHosts.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))
  } catch {
    return false
  }
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function log(cfg, message) {
  if (cfg.debug) console.error(`[web-search-free] ${message}`)
}

const TRACKING_PARAMS = /^(utm_[a-z]+|spm|fbclid|gclid|msclkid|ref_src|vd_source)$/i

// 同一个页面在 Bing / 360 里常带不同的跟踪参数，去重前先抹平。
export function canonicalUrl(url) {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) parsed.searchParams.delete(key)
    }
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return String(url)
  }
}

// 两个引擎的结果按名次交替排：各自第 1 名、各自第 2 名……这样质量不比单引擎差，
// 又不会让「一个引擎的广告/采集站」占满前几条。
export function mergeResults(buckets, limit) {
  const merged = []
  const seen = new Set()
  const longest = buckets.reduce((max, bucket) => Math.max(max, bucket.length), 0)
  for (let rank = 0; rank < longest; rank += 1) {
    for (const bucket of buckets) {
      if (merged.length >= limit) return merged
      const item = bucket[rank]
      if (!item) continue
      const key = canonicalUrl(item.url)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push({ title: item.title, url: item.url, snippet: item.snippet })
    }
  }
  return merged
}

// 供单测/离线调用：不依赖 cordis context。
export function createSearchProvider(rawConfig = {}) {
  const cfg = normalizeConfig(rawConfig)
  const cache = new Map()
  const cooldowns = new Map()

  function cacheGet(key) {
    const hit = cache.get(key)
    if (!hit) return null
    if (Date.now() - hit.at > cfg.cacheTtlMs) {
      cache.delete(key)
      return null
    }
    return hit.results
  }

  function cacheSet(key, results) {
    if (cfg.cacheTtlMs <= 0) return
    if (cache.size > 200) cache.clear()
    cache.set(key, { at: Date.now(), results })
  }

  async function search(request = {}, signal) {
    const query = String(request.query ?? '').trim()
    if (!query) throw new WebError('web search query is empty', 'WEB_SEARCH_EMPTY_QUERY')
    const limit = clampInt(request.maxResults, 1, 20, cfg.maxResults)

    const failures = []
    const results = await Promise.all(
      cfg.engines.map(async (engineId) => {
        const key = `${engineId}\u0000${query}`
        const cached = cacheGet(key)
        if (cached) return cached
        const until = cooldowns.get(engineId) || 0
        if (Date.now() < until) {
          failures.push(`${engineId}: 冷却中，还有 ${Math.ceil((until - Date.now()) / 1000)}s`)
          return []
        }
        try {
          const found = (await searchEngine(engineId, query, {
            userAgent: cfg.userAgent,
            locale: cfg.locale,
            timeoutMs: cfg.timeoutMs,
            signal,
          })).filter((item) => !isBlocked(cfg, item.url))
          if (!found.length) throw new Error('结果都被 blockHosts 过滤了')
          cacheSet(key, found)
          return found
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          if (reason.includes('人机验证') && cfg.cooldownMs > 0) {
            cooldowns.set(engineId, Date.now() + cfg.cooldownMs)
          }
          log(cfg, `${engineId} 失败：${reason}`)
          failures.push(`${engineId}: ${reason}`)
          return []
        }
      }),
    )

    const merged = mergeResults(results, limit)
    if (merged.length) return { sources: merged }
    throw new WebError(
      `免费搜索没有结果（${failures.join('；') || '引擎没有返回可解析的结果'}）`,
      'WEB_SEARCH_FAILED',
    )
  }

  return {
    id: cfg.providerId,
    available: () => cfg.enabled && cfg.engines.length > 0,
    search,
    // 调试用
    config: cfg,
  }
}

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config)
  if (!cfg.enabled) {
    log(cfg, 'disabled，不注册 provider')
    return
  }
  const provider = createSearchProvider(cfg)
  ctx.web.registerSearchProvider({
    id: provider.id,
    available: provider.available,
    search: provider.search,
  })
  console.error(
    `[web-search-free] 已注册搜索 provider "${cfg.providerId}"（引擎：${cfg.engines.join(
      ', ',
    )}；在 profile 里设置 web.config.searchProvider=${cfg.providerId} 启用）`,
  )
}

export { engineIds }
