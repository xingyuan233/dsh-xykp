// dsh-xykp · comms/search-engine — 网页正文抓取（dsh-web 的 fetch provider）
//
// 官方默认的 @deepseek-ai/dsh-web-fetch-http 是裸 HTTP：拿到整页 HTML 就交给工具转
// markdown，导航栏、广告位、评论区全在里面，而且碰到 Cloudflare / JS 壳就直接失败。
// 这个 provider 做三件事：
//   1. 带浏览器头请求；被拦（403/429/503、Cloudflare、请开启 JS）时用本机 Chrome 渲染再取 DOM；
//   2. 去掉 script/style/nav/footer/aside/广告容器，优先取 <article> / <main>；
//   3. 输出仍是 html，交给 dsh-tool-web 的 turndown 转 markdown，但干净得多。
// 另外做 SSRF 防护：只允许 http(s)，拒绝本机 / 内网地址。

import { DEFAULT_UA, renderWithBrowser } from './engines.js'

const BLOCKED_PATTERNS =
  /(?:Just a moment\.\.\.|cf-challenge|checking your browser|enable JavaScript and cookies to continue|请开启 JavaScript|请启用 JavaScript|安全验证|访问过于频繁|Verify you are human|Robot Check|Access Denied|JavaScript is required|请先启用)/i

function plainLength(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length
}

// 只做粗筛：本机、常见内网段、link-local。DNS 解析后的地址无法在这里核验，
// 但 web_fetch 工具本身也只接受公网 http(s) 目标。
const PRIVATE_HOST =
  /^(?:localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i

const JUNK_TAGS =
  /<(script|style|noscript|template|svg|iframe|canvas|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi

const LAYOUT_TAGS = /<(nav|footer|aside|form|button|select)\b[^>]*>[\s\S]*?<\/\1>/gi

// 带这些 class/id 的容器基本是噪音：导航、广告、分享、推荐、评论、cookie 提示。
const JUNK_ATTR =
  /(?:^|["'\s])(?:class|id)="[^"]*(?:advert|ads?\b|banner|sidebar|side-bar|share|social|comment|related|recommend|cookie|popup|modal|navbar|nav-|menu|breadcrumb|pagination|newsletter|subscribe|footer|toolbar)[^"]*"/i

function removeJunkContainers(html) {
  // 逐个 <div|section|span ...> 标签检查属性：命中噪音关键字就把整个块删掉。
  let out = html
  for (let guard = 0; guard < 400; guard += 1) {
    const match = out.match(/<(div|section|span|ul|dl|figure)\b([^>]*)>([\s\S]*?)<\/\1>/i)
    if (!match || !JUNK_ATTR.test(match[0].slice(0, match[0].indexOf('>') + 1))) break
    out = out.slice(0, match.index) + out.slice(match.index + match[0].length)
  }
  return out
}

// 链接密度高的块（导航、面包屑、相关推荐）直接删：正文几乎全是 <a>、文字又不多。
function dropLinkDenseBlocks(html) {
  return html.replace(
    /<(div|ul|ol|table|section)\b[^>]*>([\s\S]{0,20000}?)<\/\1>/gi,
    (whole, _tag, inner) => {
      const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      if (!text.length || text.length > 900) return whole
      const linkText = (inner.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [])
        .join(' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      return linkText.length / text.length > 0.6 ? ' ' : whole
    },
  )
}

export function cleanHtml(html) {
  const source = String(html)
  const title = (source.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]
  let out = source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')
    .replace(JUNK_TAGS, ' ')
    .replace(LAYOUT_TAGS, ' ')
  out = removeJunkContainers(out)
  out = dropLinkDenseBlocks(out)
  // 优先正文容器，其次 <main>，最后整页。
  const article = out.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)
  const main = out.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)
  const body = article && article[1].length > 500 ? article[1] : main && main[1].length > 500 ? main[1] : out
  const heading = title ? `<h1>${title.replace(/\s+/g, ' ').trim()}</h1>` : ''
  return heading + body
}

function capText(text, maxChars) {
  if (text.length <= maxChars) return { content: text, truncated: false }
  return { content: text.slice(0, maxChars), truncated: true }
}

function assertSafeUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`不是合法 URL：${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`只支持 http(s)：${parsed.protocol}`)
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (PRIVATE_HOST.test(host)) throw new Error(`拒绝抓取内网地址：${host}`)
  return parsed
}

async function fetchOnce(url, options) {
  const { userAgent, timeoutMs, signal, fetchImpl } = options
  const doFetch = fetchImpl || globalThis.fetch
  const timeout = AbortSignal.timeout(timeoutMs)
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout
  const response = await doFetch(url, {
    method: 'GET',
    redirect: 'follow',
    signal: composed,
    headers: {
      'user-agent': userAgent,
      accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.7,*/*;q=0.5',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'cache-control': 'no-cache',
      'upgrade-insecure-requests': '1',
    },
  })
  const contentType = String(response.headers.get('content-type') || '').toLowerCase()
  const text = await response.text()
  return { response, contentType, text }
}

function looksBlocked(status, text, contentType) {
  if (status === 403 || status === 429 || status === 503) return true
  if (BLOCKED_PATTERNS.test(text.slice(0, 20000))) return true
  const looksHtml = contentType.includes('html') || /^\s*<(!doctype|html)/i.test(text.slice(0, 200))
  if (!looksHtml) return false
  if (plainLength(text) < 300) return true
  // 空壳 SPA / JS 挑战页：正文几乎没有、段落 < 3、脚本却一堆。
  const paragraphs = (text.match(/<p\b/gi) || []).length
  const scripts = (text.match(/<script\b/gi) || []).length
  return plainLength(text) < 1200 && paragraphs < 3 && scripts >= 2
}

function toResult(response, contentType, text, options) {
  const isHtml = contentType.includes('html') || /^\s*<!doctype html|^\s*<html/i.test(text.slice(0, 200))
  if (!isHtml) {
    const { content, truncated } = capText(text, options.maxChars)
    return {
      url: response.url,
      statusCode: response.status,
      body: { kind: 'text', content },
      truncated,
    }
  }
  const cleaned = cleanHtml(text)
  // 2xx 但正文几乎是空的（反爬/登录墙），与其把垃圾交出去不如报错；4xx/5xx 照常返回状态码。
  if (response.status < 400 && plainLength(cleaned) < 80) {
    throw new Error('页面没有可读正文（可能被反爬拦了，或内容要登录/开 JS 才出来）')
  }
  const { content, truncated } = capText(cleaned, options.maxChars)
  return {
    url: response.url,
    statusCode: response.status,
    body: { kind: 'html', content },
    truncated,
  }
}

export function createFetchProvider(rawConfig = {}) {
  const cfg = {
    userAgent: rawConfig.userAgent || DEFAULT_UA,
    timeoutMs: Number(rawConfig.timeoutMs) || 20000,
    maxChars: Number(rawConfig.maxChars) || 200000,
    browserFallback: rawConfig.browserFallback !== false,
    browserPath: rawConfig.browserPath || '',
    browserProfileDir: rawConfig.browserProfileDir || '',
    browserTimeoutMs: Number(rawConfig.browserTimeoutMs) || 20000,
  }

  async function fetchPage(request = {}, signal) {
    const url = assertSafeUrl(String(request.url || '').trim()).toString()

    let attempt = await fetchOnce(url, { ...cfg, signal })
    const status = attempt.response.status
    const shouldTryBrowser =
      cfg.browserFallback &&
      (status < 400 || status === 403 || status === 429 || status === 503) &&
      looksBlocked(status, attempt.text, attempt.contentType)
    if (shouldTryBrowser) {
      // 拦了或者只给了 JS 壳：让本机浏览器渲染完再取 DOM；渲染失败就退回原始响应。
      try {
        const rendered = await renderWithBrowser(url, {
          browserPath: cfg.browserPath,
          browserProfileDir: cfg.browserProfileDir,
          browserTimeoutMs: cfg.browserTimeoutMs,
          userAgent: cfg.userAgent,
        })
        attempt = { ...attempt, text: rendered, contentType: 'text/html' }
      } catch (error) {
        console.error(`[search-engine] 浏览器渲染失败，保留原始响应：${error.message}`)
      }
    }
    return toResult(attempt.response, attempt.contentType, attempt.text, cfg)
  }

  return { fetch: fetchPage, config: cfg }
}

// 供调试/单测直接调用（不经过 cordis）
export async function fetchPage(url, options = {}) {
  const provider = createFetchProvider(options)
  return provider.fetch({ url }, undefined)
}

export { assertSafeUrl }
