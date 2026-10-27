// bili-rove · ntfy 推送（登录二维码 / 失败通知）
import { request } from 'node:https'

export const DEFAULTS = {
  ntfyServer: 'https://ntfy.sh',
  ntfyTopic: 'whale-bilibili-login-channel',
}

/** 往 ntfy 推一条；失败只返回 false，不抛 */
export function notify(title, message, tags = 'rotating_light', cfg = {}) {
  const opts = { ...DEFAULTS, ...(cfg || {}) }
  const server = String(opts.ntfyServer || DEFAULTS.ntfyServer).replace(/\/+$/, '')
  let url
  try {
    url = new URL(server + '/' + encodeURIComponent(opts.ntfyTopic))
  } catch {
    return Promise.resolve(false)
  }
  const body = Buffer.from(String(message || ''), 'utf8')
  return new Promise((resolve) => {
    const req = request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        headers: {
          Title: String(title || 'B站'),
          Tags: String(tags || ''),
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': body.length,
        },
      },
      (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      },
    )
    req.on('error', () => resolve(false))
    req.setTimeout(8000, () => {
      req.destroy()
      resolve(false)
    })
    req.end(body)
  })
}
