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

export function parseGoogle(html) {
  const source = String(html)
  if (NO_RESULTS.test(source)) return []
  const results = []
  const seen = new Set()
  for (const heading of source.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)) {
    const before = source.slice(Math.max(0, heading.index - 900), heading.index)
    const hrefs = [...before.matchAll(/href="((?:\/url\?q=|https?:\/\/)[^"]+)"/g)]
    if (!hrefs.length) continue
    let url = decodeEntities(hrefs[hrefs.length - 1][1])
    const redirected = url.match(/^\/url\?q=([^&]+)/)
    if (redirected) url = decodeURIComponent(redirected[1])
    url = absolute(url)
    if (!url || isEngineHost(url, 'google.') || /google\.[a-z.]+\//i.test(url)) continue
    const title = plainText(heading[1])
    if (!title) continue
    const after = source.slice(heading.index + heading[0].length, heading.index + heading[0].length + 2000)
    const snippet =
      after.match(/<div[^>]*class="[^"]*VwiC3b[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
      after.match(/<span[^>]*class="[^"]*(?:aCOpRe|st)[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
    results.push({ title, url, snippet: snippet ? plainText(snippet[1]) : '' })
  }
  return results.filter((item) => {
    if (seen.has(item.url)) return false
    seen.add(item.url)
    return true
  })
}

// ── 请求 ────────────────────────────────────────────────────────────────────

export const ENGINES = {
  google: {
    label: 'Google',
    buildUrl: (query, { locale }) =>
      `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10&pws=0${
        locale ? `&hl=${encodeURIComponent(locale.split('-')[0])}` : ''
      }`,
    parse: parseGoogle,
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
  const doFetch = fetchImpl || globalThis.fetch
  const timeout = AbortSignal.timeout(timeoutMs)
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout
  const response = await doFetch(engine.buildUrl(query, { locale }), {
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
  const html = await response.text()
  if (!response.ok) throw new Error(`${engine.label} HTTP ${response.status}`)
  if (engine.blockedBy && html.slice(0, 30000).match(engine.blockedBy)) {
    throw new Error(`${engine.label} 触发人机验证`)
  }
  if (/<title>\s*(?:Captcha|验证码|安全验证)/i.test(html) || /id="captcha"/i.test(html)) {
    throw new Error(`${engine.label} 触发人机验证`)
  }
  const results = engine.parse(html)
  if (!results.length) throw new Error(`${engine.label} 没有解析出结果（页面结构可能变了）`)
  return results
}
