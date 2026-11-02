// dsh-xykp · web/web-search-free — 引擎适配层
//
// 只做两件事：拼搜索 URL 发请求、把返回的 HTML 抠成 { title, url, snippet }。
// 没有 key、没有第三方 SDK，纯 HTML 解析，所以引擎改版时只需要改这里的 parse。
//
// 目前内置两个能直连的引擎：
//   bing  cn.bing.com —— 全球索引好、中英都行、无广告位
//   so    www.so.com  —— 360，中文站点覆盖比 Bing 好（Bing 中文结果偏 CSDN/搜狐）
// 试过但在这个网络里不可用：google（要 JS）、duckduckgo（连不上）、mojeek（验证码）、
// brave / searx 公共实例（连不上），sogou（结果全是跳转链接 + 广告）。

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

// Bing 的有机结果偶尔包一层 /ck/a?...&u=a1<base64url>，解出来才是真地址。
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

// 只解析结果容器之后的部分：页面头部的内联 script/style 里也会出现
// `<li class="b_algo` 这类字符串，整页切分会把脚本模板当成结果抠出来。
function cropAfter(html, marker) {
  const at = html.indexOf(marker)
  return at < 0 ? '' : html.slice(at)
}

const NO_RESULTS = /(?:没有与此相关的结果|找不到和您查询的“|未找到相关结果|There are no results)/i

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

// 360 的真地址在 data-mdurl 上；href 是 /link?m=... 这种加密跳转，用不了。
export function parseSo(html) {
  const source = String(html)
  if (NO_RESULTS.test(source)) return []
  const results = []
  const blocks = cropAfter(source, '<ul class="result"').split(/<li class="res-list/i).slice(1)
  for (const raw of blocks) {
    const block = raw.slice(0, 12000)
    const md = block.match(/data-mdurl="([^"]+)"/)
    const url = md ? absolute(md[1]) : ''
    if (!url || isEngineHost(url, 'so.com')) continue
    const anchor = block.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)
    const title = anchor ? plainText(anchor[1]) : ''
    if (!title) continue
    const snippet =
      block.match(/class="res-list-summary"[^>]*>([\s\S]*?)<\/span>/i) ||
      block.match(/<p class="res-desc"[^>]*>([\s\S]*?)<\/p>/i) ||
      block.match(/class="res-desc"[^>]*>([\s\S]*?)<\/(?:p|div)>/i)
    results.push({ title, url, snippet: snippet ? plainText(snippet[1]) : '' })
  }
  return results
}

// Bing 有 RSS 出口（`&format=rss`），比 HTML 稳得多：结构固定、体积小、不用猜卡片布局。
// 从这个网络看，cn.bing.com 的多词长尾排名很差（基本只按第一个词给「官网/百科」），
// 所以默认把 360 排在前面，Bing 用来补全球结果。
function rssTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))
  if (!match) return ''
  return match[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim()
}

export function parseBingRss(xml) {
  const source = String(xml)
  if (!/<rss[\s>]/i.test(source)) return []
  const results = []
  const items = source.match(/<item>[\s\S]*?<\/item>/gi) || []
  for (const item of items) {
    const url = absolute(decodeEntities(rssTag(item, 'link')))
    const title = plainText(rssTag(item, 'title'))
    if (!url || !title || isEngineHost(url, 'bing.com')) continue
    results.push({ title, url, snippet: plainText(rssTag(item, 'description')) })
  }
  return results
}

// 搜狗的结果链接是 /link?url=... 加密跳转，但每条结果旁边有 data-url 指到真实地址，
// 直接用它，比逐条跟随跳转便宜得多。
export function parseSogou(html) {
  const source = String(html)
  if (NO_RESULTS.test(source)) return []
  const results = []
  const blocks = cropAfter(source, 'class="results"').split(/<div class="vrwrap"/i).slice(1)
  for (const raw of blocks) {
    const block = raw.slice(0, 12000)
    const md = block.match(/data-url="([^"]+)"/) || block.match(/data-mdurl="([^"]+)"/)
    const url = md ? absolute(md[1]) : ''
    if (!url || isEngineHost(url, 'sogou.com')) continue
    const anchor = block.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)
    const title = anchor ? plainText(anchor[1]) : ''
    if (!title) continue
    const snippet =
      block.match(/id="cacheresult_summary_\d+"[^>]*>([\s\S]*?)<\/div>/i) ||
      block.match(/class="[^"]*space-txt[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
      block.match(/class="[^"]*text-layout[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    results.push({ title, url, snippet: snippet ? plainText(snippet[1]) : '' })
  }
  return results
}

export const ENGINES = {
  bing: {
    label: 'Bing',
    // 兜底用：多词长尾只按第一个词给官网/百科，只有别的引擎都挂了才需要它。
    filler: true,
    buildUrl: (query, { locale }) =>
      `https://cn.bing.com/search?q=${encodeURIComponent(query)}&format=rss&FORM=BESBTB${
        locale ? `&setlang=${encodeURIComponent(locale)}` : ''
      }`,
    // RSS 正常就用 RSS；偶尔会退回 HTML 页面，那就用 HTML 解析兜底。
    parse: (text) => {
      const viaRss = parseBingRss(text)
      return viaRss.length ? viaRss : parseBing(text)
    },
  },
  so: {
    label: '360',
    buildUrl: (query) => `https://www.so.com/s?q=${encodeURIComponent(query)}`,
    parse: parseSo,
  },
  sogou: {
    label: 'Sogou',
    buildUrl: (query) => `https://www.sogou.com/web?query=${encodeURIComponent(query)}`,
    parse: parseSogou,
  },
}

export function engineIds() {
  return Object.keys(ENGINES)
}

// 抓一个引擎。任何非 200、验证码页、解析出 0 条，都当失败抛给上层去降级。
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
  if (/<title>\s*(?:Captcha|验证码|安全验证)/i.test(html) || /id="captcha"/i.test(html)) {
    throw new Error(`${engine.label} 触发人机验证`)
  }
  const results = engine.parse(html)
  if (!results.length) throw new Error(`${engine.label} 没有解析出结果（页面结构可能变了）`)
  return results
}
