// bili-rove · ntfy 推送（登录二维码 / 登录恢复通知）
//
// 从 tools/bili-bot 的 ntfy 实现搬过来的（原来那套实测能用）：
//   · 图片消息：POST 二进制 + Content-Type: image/png
//   · 文本消息：POST JSON
//   · header 里的中文按 UTF-8 字节转 latin1（ntfy 服务端按 UTF-8 解）
// 失败只返回 false / 0，绝不抛——推送挂了不能影响正事。
import { request } from 'node:https'

export const DEFAULTS = {
  ntfyServer: 'https://ntfy.sh',
  ntfyTopic: 'whale-bilibili-login-channel',
  ntfyTitle: 'B站登录过期了，扫一下二维码喵',
  ntfyMessage: '手机 B 站扫一下这张码，本小姐登录完就继续干活喵',
  ntfyTags: 'rotating_light,qrcode',
  ntfyPriority: 4,
  ntfyClickUrl: '',
}

const latin1 = (s) => Buffer.from(String(s), 'utf8').toString('latin1')

function post(cfg, { png, title, message, json }) {
  const opts = { ...DEFAULTS, ...(cfg || {}) }
  const server = String(opts.ntfyServer || DEFAULTS.ntfyServer).replace(/\/+$/, '')
  let url
  try {
    url = new URL(server + '/' + encodeURIComponent(opts.ntfyTopic))
  } catch {
    return Promise.resolve(0)
  }
  const headers = {}
  let body
  if (png) {
    headers.Title = latin1(title || opts.ntfyTitle)
    headers.Message = latin1(message || opts.ntfyMessage)
    headers.Priority = String(opts.ntfyPriority || 4)
    headers.Tags = latin1(opts.ntfyTags || '')
    headers.Filename = 'bili-qr-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '.png'
    headers['Content-Type'] = 'image/png'
    if (opts.ntfyClickUrl) headers.Click = String(opts.ntfyClickUrl)
    body = png
  } else {
    body = Buffer.from(JSON.stringify({
      topic: opts.ntfyTopic,
      title: title || 'B站登录已恢复',
      message: message || '扫码成功，B 站工具可以继续用了喵',
      tags: ['white_check_mark'],
      priority: 3,
      ...(json || {}),
    }), 'utf8')
    headers['Content-Type'] = 'application/json; charset=utf-8'
  }
  headers['Content-Length'] = body.length

  return new Promise((resolve) => {
    let done = false
    const finish = (v) => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    const req = request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: url.pathname + url.search,
      headers,
    }, (res) => {
      res.resume()
      res.on('end', () => finish(res.statusCode || 0))
    })
    req.on('error', () => finish(0))
    req.setTimeout(20000, () => {
      try {
        req.destroy()
      } catch {}
      finish(0)
    })
    req.end(body)
  })
}

/** 推一张二维码图片；失败返回 0 */
export function notifyQr(png, cfg = {}) {
  return post(cfg, { png })
}

/** 推一条文本（登录恢复 / 失败说明）；失败返回 false */
export async function notifyText(title, message, cfg = {}) {
  const code = await post(cfg, { title, message })
  return code >= 200 && code < 300
}

/** 兼容旧调用：notify(title, message, tags, cfg) */
export function notify(title, message, tags = 'rotating_light', cfg = {}) {
  return notifyText(title, message, { ...(cfg || {}), ntfyTags: tags })
}
