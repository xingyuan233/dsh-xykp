// bili-reply · 拉取 @ 和回复（真接口）
//
// 接口：/x/msgfeed/at（@ 我的）、/x/msgfeed/reply（回复我的），都要 wbi 签名。
// vendor/ 里的 provider 复制自 dsh-plugin-bilibili（moxingovo/dsh-bilibili）。
//
// 返回结构（跟 dedupe.js 约定）：
//   { kind:'at'|'reply', id, rpid, mid, nickname, bvid, content, at }
import { BilibiliOfficialProvider } from './vendor/provider.js'
import { wbiSign } from './vendor/wbi.js'
import { createDmFetcher, meIdOf } from './dm.js'
import { loadCache, saveCache, remember, resolveNames, DEFAULTS as NAME_DEFAULTS } from './names.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

const KIND = { at: 'at', reply: 'reply' }

/** 从 uri / native_uri 里抽 BV 号 */
export function bvidOf(item = {}) {
  const raw = String((item.item && (item.item.uri || item.item.native_uri)) || '')
  const m = raw.match(/BV[0-9A-Za-z]{10,}/)
  return m ? m[0] : ''
}

/** msgfeed 的原始 item → 我们的收件结构 */
export function mapMsgfeed(raw = {}, kind = 'at') {
  const user = raw.user || {}
  const item = raw.item || {}
  const atTime = Number(raw.at_time || item.ctime || 0)
  return {
    kind: KIND[kind] || 'at',
    id: String(raw.id || ''),
    rpid: String(item.source_id || item.target_id || 0),
    mid: Number(user.mid || 0),
    nickname: String(user.nickname || ''),
    bvid: bvidOf(raw),
    content: String(item.source_content || item.title || '').slice(0, 300),
    at: atTime ? atTime * 1000 : Date.now(),
  }
}

/**
 * 建一个拉取器。factory 便于自测替换 provider。
 */
export function createFetcher(cfg = {}, factory) {
  const make = factory || ((opts) => new BilibiliOfficialProvider(opts))
  const dmFetcher = createDmFetcher(cfg)
  const cache = new Map()
  function providerFor(cookie) {
    const key = String(cookie || '')
    if (cache.has(key)) return cache.get(key)
    const p = make({ ...(key ? { cookie: key } : {}), requestTimeoutMs: Number(cfg.timeoutMs) || 20000 })
    cache.set(key, p)
    return p
  }

  async function signed(p, extra = {}) {
    const keys = await p.resolveWbiKeys()
    return wbiSign({ build: 0, mobi_app: 'web', ...extra }, keys.imgKey, keys.subKey, Math.floor(Date.now() / 1000))
  }

  return async function fetchItems(runCfg = {}) {
    const cookie = String(runCfg.cookie || '')
    const p = providerFor(cookie)
    const out = []
    const want = Array.isArray(runCfg.kinds) ? runCfg.kinds : ['at', 'reply']
    if (want.includes('at')) {
      try {
        const data = await p.requestJson('/x/msgfeed/at', await signed(p))
        for (const it of (data && data.items) || []) out.push(mapMsgfeed(it, 'at'))
      } catch (err) {
        console.warn('[bili-reply] 拉 @ 失败：', err?.message || err)
      }
    }
    if (want.includes('reply')) {
      try {
        const data = await p.requestJson('/x/msgfeed/reply', await signed(p))
        for (const it of (data && data.items) || []) out.push(mapMsgfeed(it, 'reply'))
      } catch (err) {
        console.warn('[bili-reply] 拉回复失败：', err?.message || err)
      }
    }
    if (want.includes('dm')) {
      try {
        const dms = await dmFetcher({ cookie, meId: meIdOf(cookie), maxSessions: runCfg.dmMaxSessions })
        out.push(...dms)
      } catch (err) {
        console.warn('[bili-reply] 拉私信失败：', err?.message || err)
      }
    }

    // ── 昵称缓存：at/reply 自带昵称，私信没有就从缓存/接口补 ──
    try {
      const cachePath = cfg.namesCachePath || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'xykp', 'bilibili', 'names-cache.json')
      const cache = await loadCache(cachePath)
      let dirty = false
      for (const it of out) {
        if (it.nickname) dirty = remember(cache, it.mid, it.nickname) || dirty
      }
      const missing = out.filter((x) => !x.nickname).map((x) => x.mid)
      if (missing.length) {
        const { names, fetched } = await resolveNames(missing, cache, cfg, undefined, cookie)
        for (const it of out) {
          if (!it.nickname && names[String(it.mid)]) it.nickname = names[String(it.mid)]
        }
        if (fetched) dirty = true
      }
      if (dirty) await saveCache(cachePath, cache)
    } catch (err) {
      console.warn('[bili-reply] 昵称缓存出错（不影响推送）：', err?.message || err)
    }
    return out
  }
}


