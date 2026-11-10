// 结果重排 + 页面富化。
//
// 免费引擎给的是「SERP 原始顺序」，官方 deepseek search 给的是
// rerank_score + summary + date + authority。这里用本地启发式补上后半截：
//   1) 关键词覆盖度（标题权重更高）+ 站点权威度 + 引擎位次 → 重排
//   2) 垃圾站/下载页/聚合页降权或剔除
//   3) 同域去重（默认每站 2 条，避免整屏 CSDN）
//   4) 抓取 top N 页面的 meta / 正文，生成「与 query 相关」的 snippet
//   5) 从 meta / JSON-LD / URL / snippet 里补 publishedAt
//
// 失败一律降级为原 SERP 结果，绝不让搜索结果变空。

import { DEFAULT_UA, decodeEntities } from './engines.js'
import { cleanHtml } from './reader.js'

const CACHE = new Map()
const CACHE_TTL = 30 * 60 * 1000
const CACHE_MAX = 300

// 站点权威度（按域名后缀匹配，取最长匹配）。负数表示降权，<= -4 直接丢弃。
const AUTHORITY = {
  'api-docs.deepseek.com': 3.0,
  'platform.deepseek.com': 2.2,
  'deepseek.com': 1.8,
  'github.com': 1.6,
  'docs.github.com': 2.4,
  'raw.githubusercontent.com': 1.8,
  'gist.github.com': 1.4,
  'developer.mozilla.org': 2.6,
  'stackoverflow.com': 2.2,
  'stackexchange.com': 1.6,
  'wikipedia.org': 2.0,
  'arxiv.org': 1.5,
  'news.ycombinator.com': 1.3,
  'kubernetes.io': 2.0,
  'nodejs.org': 2.2,
  'python.org': 2.2,
  'npmjs.com': 1.8,
  'pypi.org': 1.6,
  'docs.docker.com': 2.0,
  'cloudflare.com': 1.5,
  'developers.cloudflare.com': 2.2,
  'learn.microsoft.com': 2.2,
  'developer.apple.com': 2.2,
  'docs.aws.amazon.com': 2.0,
  'react.dev': 2.2,
  'vuejs.org': 2.0,
  'nextjs.org': 2.0,
  'rust-lang.org': 2.0,
  'go.dev': 2.0,
  'medium.com': 0.3,
  'dev.to': 0.6,
  'juejin.cn': 0.5,
  'segmentfault.com': 0.6,
  'cnblogs.com': 0.5,
  'zhuanlan.zhihu.com': 0.8,
  'zhihu.com': 0.4,
  'cloud.tencent.com': 0.8,
  'developer.aliyun.com': 0.7,
  'infoq.cn': 0.8,
  'oschina.net': 0.2,
  '51cto.com': -0.8,
  'csdn.net': -1.8,
  'blog.csdn.net': -1.0,
  'download.csdn.net': -8,
  'wenku.baidu.com': -6,
  'doc88.com': -5,
  'docin.com': -5,
  'book118.com': -5,
  'zhidao.baidu.com': -2.0,
  'jingyan.baidu.com': -1.6,
  'baijiahao.baidu.com': -1.2,
  'toutiao.com': -1.2,
  'sohu.com': -1.0,
  'sina.com.cn': -1.0,
  '163.com': -0.9,
  'taobao.com': -4,
  'tmall.com': -4,
  'jd.com': -3,
  'pinduoduo.com': -4,
}

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'from', 'by',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those',
  'how', 'what', 'why', 'when', 'where', 'which', 'who', 'vs', 'version',
  '的', '了', '是', '在', '和', '与', '及', '或', '等', '这', '那', '有', '无',
  '如何', '什么', '怎么', '为什么', '哪些', '哪个', '是否', '可以', '一个', '我们', '现在',
])

const HIGH_TRUST_TLD = ['.gov', '.edu', '.mil', '.edu.cn', '.gov.cn']

const JUNK_PATH = /(?:^|\/)(?:download|down|dld|soft|zhuanti|tags?|category)(?:\/|$|\?)|(?:^|\/)p-\d+\.html|-it-\d+\.html/i

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

function authorityOf(host, query, siteOnly) {
  let best = null
  let bestLen = -1
  for (const domain of Object.keys(AUTHORITY)) {
    if (host === domain || host.endsWith('.' + domain)) {
      if (domain.length > bestLen) {
        best = AUTHORITY[domain]
        bestLen = domain.length
      }
    }
  }
  if (best === null) {
    for (const tld of HIGH_TRUST_TLD) {
      if (host.endsWith(tld)) {
        best = 1.2
        break
      }
    }
  }
  if (best === null && /^docs?\./.test(host)) best = 0.6
  if (best === null) best = 0

  // 明确 site: 查询时，不要再按站点权威度惩罚/奖励，用户就要这个站。
  if (siteOnly) return 0
  if (/官方|官网|文档|手册|api|sdk|release|发布|公告/i.test(query) && best > 0) best *= 1.25
  return best
}

function tokenize(query) {
  const quoted = []
  const plain = String(query)
    .replace(/"([^"]+)"/g, (_, p) => {
      const t = p.trim().toLowerCase()
      if (t.length >= 2) quoted.push(t)
      return ' '
    })
    .replace(/\b(?:site|filetype|inurl|intitle|after|before|lang):\S+/gi, ' ')
    .toLowerCase()

  const tokens = new Set()
  for (const word of plain.split(/[^\p{L}\p{N}_+.#-]+/u)) {
    if (!word || word.length < 2 || word.length > 40) continue
    if (/^[\d+.#-]+$/.test(word)) continue
    if (STOP.has(word)) continue
    tokens.add(word)
  }
  for (const run of plain.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length >= 2 && run.length <= 8) tokens.add(run)
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const gram = run.slice(i, i + 2)
      if (!STOP.has(gram)) tokens.add(gram)
    }
  }
  for (const q of quoted) tokens.add(q)
  // 控制 token 数量，避免超长 query 把覆盖率算稀。
  return [...tokens].slice(0, 24)
}

function coverageOf(tokens, idf, title, snippet, url) {
  if (tokens.length === 0) return { coverage: 0.5, titleCoverage: 0.5 }
  const t = (title || '').toLowerCase()
  const s = (snippet || '').toLowerCase()
  const u = decodeURIComponent(url || '').toLowerCase()
  let total = 0
  let hit = 0
  let titleHit = 0
  for (const tok of tokens) {
    const weight = idf.get(tok) ?? 1
    total += weight
    const inTitle = t.includes(tok)
    const inBody = s.includes(tok) || u.includes(tok)
    if (inTitle) titleHit += weight
    if (inTitle || inBody) hit += weight
  }
  return { coverage: total ? hit / total : 0, titleCoverage: total ? titleHit / total : 0 }
}

// 文档频率 → IDF：品牌词（deepseek 之类）几乎每条都出现，权重会被压得很低，
// 「发布 / release / 版本号」这种区分性词权重高，行为和官方 rerank 接近。
function buildIdf(candidates, tokens) {
  const idf = new Map()
  if (!tokens.length) return idf
  const docs = candidates.map((c) =>
    `${c.title ?? ''} ${c.snippet ?? ''} ${c.url ?? ''}`.toLowerCase(),
  )
  for (const tok of tokens) {
    let df = 0
    for (const doc of docs) if (doc.includes(tok)) df += 1
    idf.set(tok, Math.log(1 + candidates.length / (df + 0.5)))
  }
  return idf
}

function parseDate(text) {
  if (!text) return null
  const iso = String(text).match(/(20\d{2})-(\d{1,2})-(\d{1,2})/)
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`
  const cn = String(text).match(/(20\d{2})[年\/.](\d{1,2})[月\/.](\d{1,2})?/)
  if (cn) {
    const d = cn[3] ? cn[3].padStart(2, '0') : '01'
    return `${cn[1]}-${cn[2].padStart(2, '0')}-${d}`
  }
  return null
}

function daysSince(date) {
  const t = Date.parse(date)
  if (Number.isNaN(t)) return null
  return (Date.now() - t) / 86400000
}

function siteFilterOf(query) {
  const hosts = []
  const re = /\bsite:([^\s]+)/gi
  let m
  while ((m = re.exec(query))) hosts.push(m[1].toLowerCase().replace(/^www\./, ''))
  return hosts
}

function canonical(url) {
  try {
    const u = new URL(url)
    u.hash = ''
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '')
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|spm|from|ref|source|share|fbclid|gclid)/i.test(key)) u.searchParams.delete(key)
    }
    u.pathname = u.pathname.replace(/\/+$/, '') || '/'
    return u.toString()
  } catch {
    return url
  }
}

function scoreItem(item, ctx) {
  const { tokens, query, siteOnly } = ctx
  const host = hostOf(item.url)
  if (!host) return { score: -99 }
  if (!/^https?:/i.test(item.url)) return { score: -99 }

  const siteHosts = ctx.siteHosts
  if (siteHosts.length) {
    const ok = siteHosts.some((s) => host === s || host.endsWith('.' + s))
    if (!ok) return { score: -99 }
  }

  const auth = authorityOf(host, query, siteOnly)
  if (auth <= -4) return { score: -99 }

  const title = decodeEntities(item.title ?? '')
  const snippet = decodeEntities(item.snippet ?? '')
  const { coverage, titleCoverage } = coverageOf(tokens, ctx.idf, title, snippet, item.url)
  const minCoverage = tokens.length > 3 ? 0.16 : 0.2
  if (!siteOnly && coverage < minCoverage) return { score: -99 }
  const strongHit = tokens.some(
    (tok) => (ctx.idf.get(tok) ?? 1) >= 1.2 && `${title} ${snippet} ${item.url}`.toLowerCase().includes(tok),
  )
  if (!siteOnly && tokens.length > 1 && !strongHit) return { score: -99 }

  let pathname = '/'
  try {
    pathname = new URL(item.url).pathname
  } catch {
    return { score: -99 }
  }
  const homePage = pathname === '/' || pathname === ''
  // github.com/xxx 这种组织主页也不是答案页。
  const orgPage = /^\/[^/]+\/?$/.test(pathname) && host.endsWith('github.com')
  // 单个仓库主页（/user/repo）通常只是 README 摘要，不是「怎么做/限制是什么」的答案。
  const repoPage = host === 'github.com' && /^\/[^/]+\/[^/]+\/?$/.test(pathname)
  const repoIntent = /github|repo|repositor|library|lib\b|npm|package|源码|仓库/i.test(ctx.query)
  const rank = item.rank ?? 0
  const engineWeight = { google: 1.15, bing: 1.0, baidu: 0.85, duckduckgo: 0.9 }[item.engine] ?? 0.8
  const position = (engineWeight * 1.1) / (1 + rank * 0.45)

  let score = 0
  score += position
  score += auth
  score += coverage * 4.2
  score += titleCoverage * 1.8
  if (JUNK_PATH.test(pathname)) score -= 2.6
  if (!siteOnly && homePage) score -= 1.6
  if (!siteOnly && orgPage) score -= 1.2
  if (!siteOnly && repoPage && !repoIntent) score -= 1.5
  if ((snippet || '').length >= 60) score += 0.35
  else score -= 0.35
  // GitHub 仓库的样板 description（"Contribute to ... development"）不算内容。
  const boilerplate = /contribute to .{0,80} development by creating an account on github|sign in to github|view on github|skip to content/i.test(snippet)
  if (boilerplate) {
    if (!ctx.nav && host === 'github.com') return { score: -99 }
    score -= 2.5
  }
  // 非「找仓库/找库」意图时，单个仓库主页基本是噪声（官方 search 也更偏文档页）。
  if (!ctx.nav && repoPage && !repoIntent) return { score: -99 }
  if (quotedPhraseHit(ctx.quoted, title, snippet, item.url)) score += 1.2

  const published = item.publishedAt || parseDate(snippet) || parseDate(item.url)
  if (published) {
    const age = daysSince(published)
    if (age !== null) {
      if (age >= -2 && age <= 120) score += ctx.recency ? 1.4 : 0.6
      else if (age <= 400) score += ctx.recency ? 0.7 : 0.2
      else if (age > 900) score -= 0.4
    }
  }

  // 官方生态 / 议题明确时，官方域名再抬一档。
  if (ctx.official && auth > 1.5) score += 1.0

  return { score, title, snippet, published, host }
}

function quotedPhraseHit(quoted, title, snippet, url) {
  if (!quoted?.length) return false
  const hay = `${title} ${snippet} ${url}`.toLowerCase()
  return quoted.some((q) => hay.includes(q))
}

function looksNavigational(query) {
  const q = String(query).trim()
  return /^https?:\/\//i.test(q) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(q)
}

function bestWindow(text, tokens, maxChars) {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  const sentences = clean.split(/(?<=[。！？!?；;])|\n+/).filter(Boolean)
  let best = ''
  let bestScore = -1
  for (let i = 0; i < sentences.length; i += 1) {
    const sentence = sentences[i].trim()
    if (sentence.length < 12) continue
    let hit = 0
    const lower = sentence.toLowerCase()
    for (const tok of tokens) if (lower.includes(tok)) hit += 1
    const coverage = tokens.length ? hit / tokens.length : 0.4
    const lenScore = Math.min(sentence.length, 160) / 160
    let score = coverage * 5 + lenScore
    if (/cookie|登录|注册|扫码|下载\s*app|广告|版权所有|copyright/i.test(sentence)) score -= 2
    if (score > bestScore) {
      bestScore = score
      best = sentence
    }
  }
  if (!best || bestScore < 2.0) return ''
  let out = best
  if (out.length < 60) {
    const idx = sentences.indexOf(best)
    if (idx >= 0 && sentences[idx + 1]) out += ' ' + sentences[idx + 1].trim()
  }
  out = out.replace(/^[\s—–\-|·•:：,，;；/]+/, '').trim()
  if (out.length > maxChars) {
    out = out.slice(0, maxChars - 1).trimEnd() + '…'
  }
  return out
}

function metaContent(html, key) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${key}["']`, 'i'),
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (m && m[1].trim()) return decodeEntities(m[1].trim())
  }
  return ''
}

function metaDate(html) {
  const keys = ['article:published_time', 'article:modified_time', 'og:updated_time', 'datePublished', 'dateModified']
  for (const key of keys) {
    const v = metaContent(html, key)
    const d = parseDate(v)
    if (d) return d
  }
  const ld = html.match(/"datePublished"\s*:\s*"([^"]{6,40})"/i)
  if (ld) return parseDate(ld[1])
  const time = html.match(/<time[^>]+datetime=["']([^"']+)["']/i)
  if (time) return parseDate(time[1])
  const cnDate = html.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/)
  if (cnDate) return parseDate(cnDate[0])
  return null
}

async function fetchHtml(url, { timeoutMs, signal, ua }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const relay = () => controller.abort()
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer)
      return null
    }
    signal.addEventListener('abort', relay, { once: true })
  }
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': ua || DEFAULT_UA,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    })
    if (!res.ok) return null
    const type = res.headers.get('content-type') || ''
    if (!/text\/html|application\/xhtml/i.test(type)) return null
    const length = Number(res.headers.get('content-length') || 0)
    if (length > 3_000_000) return null

    const reader = res.body.getReader()
    const chunks = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > 700_000) {
        chunks.push(value)
        try {
          await reader.cancel()
        } catch {}
        break
      }
      chunks.push(value)
    }
    const merged = new Uint8Array(Math.min(total, 700_000))
    let offset = 0
    for (const chunk of chunks) {
      const room = merged.length - offset
      if (room <= 0) break
      merged.set(chunk.subarray(0, Math.min(chunk.byteLength, room)), offset)
      offset += Math.min(chunk.byteLength, room)
    }
    return { html: new TextDecoder('utf-8').decode(merged), finalUrl: res.url || url }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', relay)
  }
}

function enrichOne(item, ctx) {
  const key = `v1:${item.url}`
  const cached = CACHE.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.value

  const { tokens, signal, config } = ctx
  return fetchHtml(item.url, {
    timeoutMs: config.enrichTimeoutMs ?? 4500,
    ua: config.userAgent,
    signal,
  }).then((page) => {
    const value = { snippet: item.snippet, publishedAt: item.publishedAt, host: hostOf(item.url) }
    if (page) {
      const { html, finalUrl } = page
      const metaDesc = metaContent(html, 'description') || metaContent(html, 'og:description')
      const bodyHtml = cleanHtml(html)
      const text = bodyHtml
        .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
      const body = decodeEntities(text.replace(/&nbsp;/g, ' '))
      const window = bestWindow(body.slice(0, 20000), tokens, 240)
      const hits = window ? tokens.filter((tok) => window.toLowerCase().includes(tok)).length : 0
      const enough = tokens.length <= 2 ? hits >= 1 : hits >= Math.max(2, Math.ceil(tokens.length * 0.3))
      const metaHits = tokens.filter((tok) => metaDesc.toLowerCase().includes(tok)).length

      if (window && enough && window.length >= 60) {
        value.snippet = window
      } else if (metaDesc.length >= 60 && (metaHits >= 2 || tokens.length <= 1)) {
        value.snippet = metaDesc.slice(0, 240)
      }

      const date = metaDate(html) || parseDate(finalUrl)
      if (date) value.publishedAt = date
    }
    // 二次校验：snippet 与 query 完全无关且很短时，退回原 SERP snippet。
    if (!value.snippet) value.snippet = item.snippet ?? ''
    value.snippet = value.snippet
      .replace(/^[\s—–\-|·•:：,，;；/]+/, '')
      .replace(/^.{0,40}?\d+\s*min(?:ute)?s?\s*read\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim()

    CACHE.set(key, { at: Date.now(), value })
    if (CACHE.size > CACHE_MAX) {
      const first = CACHE.keys().next().value
      CACHE.delete(first)
    }
    return value
  })
}

function mergeSnippet(original, enriched) {
  if (!enriched || !enriched.snippet) return original
  return enriched.snippet
}

export async function enhanceResults({ buckets, query, limit, config = {}, signal }) {
  const engines = config.engines ?? []
  const siteHosts = siteFilterOf(query)
  const siteOnly = siteHosts.length > 0
  const nav = looksNavigational(query)
  const tokens = tokenize(query)
  const quoted = [...String(query).matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase())
  const ctx = {
    tokens,
    quoted,
    query,
    siteHosts,
    siteOnly: siteOnly || nav,
    nav,
    recency: /最新|今天|今年|新闻|发布|刚|release|changelog|202[3-9]|最近/i.test(query),
    official: /官方|官网|文档|docs?|api|公告|发布|release/i.test(query),
    config,
    signal,
  }

  const candidates = []
  buckets.forEach((items, bucketIndex) => {
    const engine = engines[bucketIndex] ?? 'bing'
    items.forEach((item, rank) => {
      candidates.push({ ...item, engine, rank, bucketIndex })
    })
  })
  ctx.idf = buildIdf(candidates, tokens)

  const scored = []
  for (const item of candidates) {
    const res = scoreItem(item, ctx)
    if (res.score <= -90) continue
    scored.push({ ...item, ...res })
  }
  scored.sort((a, b) => b.score - a.score)

  // 同域限流（默认 2 条），URL 去重。
  const perHost = config.perHost ?? 2
  const hostCount = new Map()
  const seen = new Set()
  const picked = []
  for (const item of scored) {
    const key = canonical(item.url)
    if (seen.has(key)) continue
    const host = item.host || hostOf(item.url)
    const count = hostCount.get(host) ?? 0
    if (count >= perHost) continue
    seen.add(key)
    hostCount.set(host, count + 1)
    picked.push(item)
    if (picked.length >= limit + 4) break
  }

  // 降级：一个都没过阈值就按原始 merge 顺序兜底，避免空结果。
  if (picked.length === 0) {
    const fallback = []
    const seenFallback = new Set()
    for (let i = 0; i < Math.max(...buckets.map((b) => b.length), 0); i += 1) {
      for (const bucket of buckets) {
        const item = bucket[i]
        if (!item) continue
        const key = canonical(item.url)
        if (seenFallback.has(key)) continue
        seenFallback.add(key)
        fallback.push(item)
        if (fallback.length >= limit) break
      }
      if (fallback.length >= limit) break
    }
    return { sources: fallback, truncated: buckets.some((b) => b.length > limit) }
  }

  // 富化：先抓前 N 条（不阻塞其它失败项）。
  const enrichEnabled = config.enrich !== false
  if (enrichEnabled) {
    const enrichCount = Math.min(picked.length, config.enrichLimit ?? Math.min(limit, 6))
    const targets = picked.slice(0, enrichCount)
    const results = await Promise.allSettled(
      targets.map((item) =>
        enrichOne(item, { ...ctx, config }).catch(() => ({
          snippet: item.snippet,
          publishedAt: item.publishedAt,
        })),
      ),
    )
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) {
        const enriched = r.value
        targets[i].snippet = mergeSnippet(targets[i].snippet, enriched)
        if (enriched.publishedAt) targets[i].publishedAt = enriched.publishedAt
      }
    })
  }

  const sources = picked.slice(0, limit).map((item) => {
    const out = { title: item.title, url: item.url, snippet: item.snippet }
    if (item.publishedAt) out.publishedAt = item.publishedAt
    return out
  })

  return {
    sources,
    truncated: scored.length > limit || buckets.some((b) => b.length > limit),
  }
}

export { tokenize, parseDate, hostOf }
