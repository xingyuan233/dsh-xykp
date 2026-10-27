// bili-rove · backend 适配层
//
// 把 bili_rove 的 action 映射到 B站 provider 上。
// vendor/ 里是复制自 dsh-plugin-bilibili 的官方 API 实现（provider/types/wbi），
// 上游：moxingovo/dsh-bilibili（我们只做适配，不改它的请求逻辑）。
import { BilibiliOfficialProvider, BILIBILI_DEFAULT_BASE_URL, BILIBILI_DEFAULT_USER_AGENT } from './vendor/provider.js'

export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * @param {object} cfg - { baseUrl, userAgent, timeoutMs }
 * @param {(opts:object)=>object} [factory] - 方便自测替换
 */
export function createBackend(cfg = {}, factory) {
  const make = factory || ((opts) => new BilibiliOfficialProvider(opts))
  const cache = new Map()

  function providerFor(cookie) {
    const key = String(cookie || '')
    if (cache.has(key)) return cache.get(key)
    const p = make({
      baseUrl: cfg.baseUrl || BILIBILI_DEFAULT_BASE_URL,
      userAgent: cfg.userAgent || BILIBILI_DEFAULT_USER_AGENT,
      requestTimeoutMs: Number(cfg.timeoutMs) || DEFAULT_TIMEOUT_MS,
      ...(key ? { cookie: key } : {}),
    })
    cache.set(key, p)
    return p
  }

  return {
    async call({ action, args = {}, cookie = '' }) {
      const p = providerFor(cookie)
      const a = args || {}
      switch (action) {
        case 'search': {
          const keyword = String(a.keyword || '').trim()
          if (!keyword) throw new Error('BILI_ROVE_BAD_ARGS：search 需要 keyword')
          return p.search({
            keyword,
            page: Math.max(1, Number(a.page) || 1),
            pageSize: Math.min(20, Math.max(1, Number(a.pageSize) || 10)),
            ...(a.order ? { order: String(a.order) } : {}),
          })
        }
        case 'video': {
          const bvid = String(a.bvid || '').trim()
          if (!bvid) throw new Error('BILI_ROVE_BAD_ARGS：video 需要 bvid')
          return p.video({ bvid })
        }
        case 'subtitles': {
          const bvid = String(a.bvid || '').trim()
          if (!bvid) throw new Error('BILI_ROVE_BAD_ARGS：subtitles 需要 bvid')
          return p.subtitles({ bvid, ...(a.language ? { language: String(a.language) } : {}) })
        }
        case 'frames':
        case 'comments':
        case 'reply':
        case 'dm':
          throw new Error(`BILI_ROVE_NOT_WIRED：${action} 还没接（读能力先接 search/video/subtitles）`)
        default:
          throw new Error(`BILI_ROVE_BAD_ACTION：${action}`)
      }
    },
  }
}
