// dsh-xykp · web/web-search-free — 引擎适配层
//
// 只做两件事：拼搜索 URL 发请求、把返回的 HTML 抠成 { title, url, snippet }。
// 没有 key、没有第三方 SDK，纯 HTML 解析，所以引擎改版时只需要改这里的 parse。
//
// 引擎（按主人定的优先级）：
//   google  www.google.com     —— 首选。但这台机器的 IP 会被 google 直接甩 captcha，
//                                 先按普通 HTTP 试，命中验证码就抛错让上层冷却 + 降级。
//   bing    cn.bing.com        —— 走 RSS 出口，结构稳；缺点：多词长尾排名很「导航化」。
//   baidu   www.baidu.com      —— 中文兜底，结果里带 mu="真实地址"，广告块有「广告」标记。
//
// 已删掉的（主人嫌垃圾）：360（so.com）、搜狗（广告/加密跳转多，且频繁人机验证）。
// 试过不可用的：DuckDuckGo / Brave / Yahoo / Searx 公共实例（连不上）、Mojeek（验证码）、
// Yandex（302）、Ecosia（403）。

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  middot: '·',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  divide: '÷',
  deg: '°',
}

export function decodeEntities(input) {
  return String(input).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      return String.fromCodePoint(code)
    }
    const hit = NAMED_ENTITIES[body.toLowerCase()]
    return hit === undefined ? whole : hit
  })
}

// 把一段 HTML 变成一行纯文本。块级标签补空格，避免「标</div><div>题」粘在一起。
export function plainText(html) {
  return decodeEntities(
    String(html)
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|table|section|article)>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

function absolute(url) {
  const raw = decodeEntities(String(url)).trim()
  return /^https?:\/\//i.test(raw) ? raw : ''
}

function isEngineHost(url, host) {
  try {
    return new URL(url).hostname.toLowerCase().endsWith(host)
  } catch {
    return false
  }
}

// 只解析结果容器之后的部分：页面头部内联的 script/style 里也会出现
// `<li class="b_algo` 这类字符串，整页切分会把脚本模板当成结果。
function cropAfter(html, marker) {
  const at = String(html).indexOf(marker)
  return at < 0 ? '' : String(html).slice(at)
}

const NO_RESULTS =
  /(?:没有与此相关的结果|找不到和您查询的“|未找到相关结果|There are no results|did not match any documents)/i

// ── Bing ────────────────────────────────────────────────────────────────────
// Bing 有 RSS 出口（`&format=rss`），比 HTML 稳得多：结构固定、体积小。

function rssTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))
  if (!match) return ''
  return match[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim()
}

export function parseBingRss(xml) {
  const source = String(xml)
  if (!/<rss[\s>]/i.test(source)) return []
  const results = []
  for (const item of source.match(/<item>[\s\S]*?<\/item>/gi) || []) {
    const url = absolute(decodeEntities(rssTag(item, 'link')))
    const title = plainText(rssTag(item, 'title'))
    if (!url || !title || isEngineHost(url, 'bing.com')) continue
    results.push({ title, url, snippet: plainText(rssTag(item, 'description')) })
  }
  return results
}

export function parseBing(html) {
  const source = String(html)
  if (NO_RESULTS.test(source)) return []
  const results = []
  const blocks = cropAfter(source, 'id="b_results"').split(/<li class="b_algo/).slice(1)
  for (const raw of blocks) {
    const block = raw.slice(0, 8000)
    const anchor = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!anchor) continue
    const url = absolute(bingTarget(anchor[1]))
    if (!url || isEngineHost(url, 'bing.com')) continue
    const title = plainText(anchor[2])
    if (!title) continue
    const snippet =
      block.match(/<p class="[^"]*(?:b_lineclamp|b_algoSlug|b_paractl)[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
      block.match(/<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ||
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
    results.push({ title, url, snippet: snippet ? plainText(snippet[1]) : '' })
  }
  return results
}

// Bing 偶尔把有机结果包一层 /ck/a?...&u=a1<base64url>。
function bingTarget(href) {
  const url = decodeEntities(href)
  if (!isEngineHost(url, 'bing.com')) return url
  const encoded = url.match(/[?&]u=a1([A-Za-z0-9_-]+)/)
  if (!encoded) return ''
  try {
    return Buffer.from(encoded[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  } catch {
    return ''
  }
}

// ── Baidu ───────────────────────────────────────────────────────────────────
// 每条有机结果是 `<div class="result c-container ..." ... mu="真实地址">`，
// 标题在 <h3><a> 里，摘要在 summaryData 的内联 JSON 里。广告块带「广告」标记，直接丢。

export function parseBaidu(html) {
  const source = String(html)
  if (NO_RESULTS.test(source)) return []
  const results = []
  const blocks = source.split(/<div class="result c-container/).slice(1)
  for (const raw of blocks) {
    const tagEnd = raw.indexOf('>')
    const tag = tagEnd >= 0 ? raw.slice(0, tagEnd) : raw.slice(0, 800)
    const real = tag.match(/mu="([^"]+)"/)
    if (!real) continue
    const url = absolute(decodeEntities(real[1]))
    if (!url || isEngineHost(url, 'baidu.com')) continue
    const block = raw.slice(0, 24000)
    // 广告：百度在块里塞「广告」或 ec_ads 标记
    if (/广告/.test(block.slice(0, 8000)) || /ec_ads|ec_result/.test(tag)) continue
    const anchor = block.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)
    const title = anchor ? plainText(anchor[1]) : ''
    if (!title) continue
    const summary = block.match(/"summaryData"[\s\S]{0,4000}?"text":"((?:[^"\\]|\\.)*)"/)
    const snippet = summary ? plainText(summary[1].replace(/\\"/g, '"')) : ''
    results.push({ title, url, snippet })
  }
  return results
}

// ── Google ──────────────────────────────────────────────────────────────────
// 只有 google 能把结果直接吐成 HTML 才谈得上解析；当前这个 IP 拿到的都是
// enablejs / captcha 页，解析出 0 条 → 上层降级并冷却。

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
}

function googleDate(text) {
  const cn = text.match(/(20\d{2})[年\/.](\d{1,2})[月\/.]?(\d{1,2})?/)
  if (cn) return { y: +cn[1], m: +cn[2], d: +(cn[3] || 1) }
  const en = text.match(/([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})/)
  if (en) return { y: +en[3], m: +MONTHS[en[1].toLowerCase()] || 1, d: +en[2] }
  return null
}

export function parseGoogle(html) {
  const items = []
  const anchorRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  let m
  while ((m = anchorRe.exec(html))) {
    const href = decodeEntities(m[1])
    const inner = m[2]
    if (!/\/url\?|\/goto\?/i.test(href)) continue
    if (!/<h3/i.test(inner)) continue
    const heading = inner.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)
    const title = plainText(heading ? heading[1] : inner)
    if (!title) continue

    const tailStart = anchorRe.lastIndex
    const nextH3 = html.indexOf('<h3', tailStart)
    const tailEnd = nextH3 > 0 ? nextH3 : tailStart + 2200
    const tail = html.slice(tailStart, tailEnd)
    const tailText = plainText(tail)

    const snippetBlock =
      tail.match(/<div[^>]+class="[^"]*(?:InXCmc|VwiC3b|IsZvec|lyLwlc)[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
      null
    let snippet = snippetBlock ? plainText(snippetBlock[1]) : tailText

    const date = googleDate(tailText.slice(0, 80))
    if (date) {
      const dateStr = `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`
      snippet = snippet
        .replace(/^[A-Z][a-z]{2}[a-z]*\.?\s+\d{1,2},?\s+20\d{2}\s*[·•-]?\s*/, '')
        .replace(/^20\d{2}[年\/.]\d{1,2}[月\/.]?\d{0,2}日?\s*[·•-]?\s*/, '')
      items.push({
        title,
        url: '',
        snippet: snippet.slice(0, 300),
        pending: href,
        published: dateStr,
        cite: '',
        display: tailText.slice(0, 80),
      })
    } else {
      items.push({
        title,
        url: '',
        snippet: snippet.slice(0, 300),
        pending: href,
        published: '',
        cite: '',
        display: tailText.slice(0, 80),
      })
    }
    if (items.length >= 20) break
  }

  const seen = new Set()
  return items.filter((item) => {
    const key = item.title.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function resolveGoogleLinks(items, options) {
  const { userAgent, locale, timeoutMs, signal, fetchImpl } = options
  const doFetch = fetchImpl || globalThis.fetch
  const hopTimeout = Math.min(timeoutMs ?? 8000, 8000)

  const follow = async (startUrl) => {
    let target = startUrl
    for (let hop = 0; hop < 3; hop += 1) {
      const timeout = AbortSignal.timeout(hopTimeout)
      const res = await doFetch(target, {
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
          'user-agent': userAgent,
          'accept-language': locale ? `${locale},en;q=0.8` : 'en;q=0.9',
        },
      })
      const location = res.headers.get('location')
      if (location) return new URL(location, target).toString()
      const body = await res.text()
      const meta = body.match(/<meta[^>]+content=["']\s*\d+\s*;\s*url=([^"']+)/i) || body.match(/url=(https?:[^"'&]+)/i)
      if (!meta) return ''
      target = new URL(decodeEntities(meta[1].trim()), 'https://www.google.com').toString()
    }
    return ''
  }

  const resolveOne = async (item) => {
    if (!item.pending) return item.url ? item : null
    const startUrl = new URL(item.pending, 'https://www.google.com').toString()
    let destination = ''
    try {
      destination = await follow(startUrl)
    } catch {}
    if (destination) return { ...item, url: absolute(destination), pending: '' }

    const domain = item.display && item.display.match(/^((?:[a-z0-9-]+\.)+[a-z]{2,})/i)
    if (domain) return { ...item, url: `https://${domain[1]}`, pending: '' }
    return null
  }

  const out = []
  for (let i = 0; i < items.length; i += 3) {
    const chunk = items.slice(i, i + 3)
    const settled = await Promise.all(chunk.map((item) => resolveOne(item).catch(() => null)))
    out.push(...settled.filter((item) => item && item.url))
  }
  return out
}

// ── 请求 ────────────────────────────────────────────────────────────────────

// Google 只肯把结果交给会跑 JS 的客户端，所以要么本机有 Chrome/Edge，
// 要么这个引擎就只能降级。找到浏览器就用 `--dump-dom` 让它渲染完把 DOM 吐出来。
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]

export function findBrowser(configured) {
  const explicit = String(configured || '').trim()
  if (explicit) return existsSync(explicit) ? explicit : ''
  return BROWSER_CANDIDATES.find((candidate) => candidate && existsSync(candidate)) || ''
}

export function renderWithBrowser(url, options) {
  const binary = findBrowser(options.browserPath)
  if (!binary) return Promise.reject(new Error('没有找到 Chrome/Edge，Google 需要浏览器渲染'))
  const profileDir = String(options.browserProfileDir || '').trim() || join(tmpdir(), 'dsh-web-search-free-browser')
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-blink-features=AutomationControlled',
    `--user-agent=${options.userAgent}`,
    `--user-data-dir=${profileDir}`,
    '--virtual-time-budget=8000',
    '--dump-dom',
    url,
  ]
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { timeout: options.browserTimeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (stdout && stdout.length > 2000) resolve(stdout)
        else reject(new Error(error?.message || '浏览器没有输出页面'))
      },
    )
  })
}

export const ENGINES = {
  google: {
    label: 'Google',
    browser: true,
    buildUrl: (query, { locale }) =>
      `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10&pws=0${
        locale ? `&hl=${encodeURIComponent(locale.split('-')[0])}` : ''
      }`,
    parse: parseGoogle,
    resolve: resolveGoogleLinks,
    blockedBy: /captcha-form|unusual traffic|enablejs/i,
  },
  bing: {
    label: 'Bing',
    buildUrl: (query, { locale }) =>
      `https://cn.bing.com/search?q=${encodeURIComponent(query)}&format=rss&FORM=BESBTB${
        locale ? `&setlang=${encodeURIComponent(locale)}` : ''
      }`,
    parse: (text) => parseBingRss(text).length ? parseBingRss(text) : parseBing(text),
  },
  baidu: {
    label: 'Baidu',
    buildUrl: (query) => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&ie=utf-8`,
    parse: parseBaidu,
  },
}

export function engineIds() {
  return Object.keys(ENGINES)
}

// 抓一个引擎。非 200、验证码页、解析出 0 条都当失败抛给上层去降级。
export async function searchEngine(engineId, query, options) {
  const engine = ENGINES[engineId]
  if (!engine) throw new Error(`unknown search engine "${engineId}"`)
  const { userAgent, locale, timeoutMs, signal, fetchImpl } = options
  const url = engine.buildUrl(query, { locale })
  const doFetch = fetchImpl || globalThis.fetch
  const timeout = AbortSignal.timeout(timeoutMs)
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout
  const response = await doFetch(url, {
    method: 'GET',
    redirect: 'follow',
    signal: composed,
    headers: {
      'user-agent': userAgent,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': locale ? `${locale},${locale.split('-')[0]};q=0.9,en;q=0.8` : 'en;q=0.9',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
    },
  })
  let html = await response.text()
  if (!response.ok) throw new Error(`${engine.label} HTTP ${response.status}`)

  const blocked = () =>
    (engine.blockedBy && engine.blockedBy.test(html.slice(0, 30000))) ||
    /<title>\s*(?:Captcha|验证码|安全验证)/i.test(html) ||
    /id="captcha"/i.test(html)

  // Google 这类必须跑 JS 的：静态页被拦时，用本机浏览器渲染一次再解析。
  if (blocked() && engine.browser) {
    html = await renderWithBrowser(url, {
      browserPath: options.browserPath,
      browserProfileDir: options.browserProfileDir,
      browserTimeoutMs: options.browserTimeoutMs || timeoutMs,
      userAgent,
    })
  }
  if (blocked()) throw new Error(`${engine.label} 触发人机验证`)

  const parsed = engine.parse(html)
  let results = parsed
  if (engine.resolve && parsed.length) {
    results = (await engine.resolve(parsed, options)).filter((item) => !/google\.[a-z.]+\//i.test(item.url))
  }
  if (!results.length) throw new Error(`${engine.label} 没有解析出结果（页面结构可能变了）`)
  return results
}
