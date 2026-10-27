// bili-rove · 扫码登录（passport 接口）
//
// 从 tools/bili-bot/bili-login.mjs 搬过来的（那条链实测能用），去掉「同步到
// profile 配置」和常驻 watch —— 现在插件自己读 bili-duty 里的凭证，不用再改 yml。
//
// 流程：
//   ① GET  /x/passport-login/web/qrcode/generate?source=main-fe-header → data.url + data.qrcode_key
//   ② 手机扫 → 轮询 /x/passport-login/web/qrcode/poll?qrcode_key=…
//      data.code：86101 未扫 / 86090 已扫待确认 / 0 成功 / 86038 过期
//   ③ ⭐ 凭证在轮询响应的 Set-Cookie 头里（不是 data.url）
//   ④ 写成 { sessdata, bili_jct, buvid3, dedeuserid }
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDirOf, writeCredential } from './account.js'
import { notifyQr, notifyText } from './ntfy.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const GEN = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
const POLL = (key) =>
  'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(key) + '&source=main-fe-header'
const SPI = 'https://api.bilibili.com/x/frontend/finger/spi'
const NAV = 'https://api.bilibili.com/x/web-interface/nav'

export const DEFAULTS = {
  // 等扫码最长多久（秒）
  qrWaitSeconds: 600,
  // 二维码过期后自动换新码重推
  qrRegenSeconds: 180,
  // 两次推送之间至少隔多久（秒）
  ntfyMinIntervalSec: 60,
  // 最多推几次（防止一张坏码刷屏）
  ntfyMaxPushes: 30,
  // 用哪个在线服务把登录链接画成二维码图片（空 = 只推链接文本）
  qrImageService: 'https://api.qrserver.com/v1/create-qr-code/?size=420x420&data=',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 从 Set-Cookie 数组里抠出凭证字段 */
export function pickCookies(list = []) {
  const jar = {}
  const want = { SESSDATA: 'sessdata', bili_jct: 'bili_jct', DedeUserID: 'dedeuserid', buvid3: 'buvid3' }
  for (const raw of list || []) {
    const first = String(raw).split(';')[0] || ''
    const i = first.indexOf('=')
    if (i <= 0) continue
    const name = first.slice(0, i).trim()
    const value = first.slice(i + 1).trim()
    if (want[name]) jar[want[name]] = value
  }
  return jar
}

/** 拿不到 buvid3 时补一张指纹（非致命，失败就当空） */
async function ensureBuvid3(jar) {
  if (jar.buvid3) return jar
  try {
    const r = await fetch(SPI, { headers: { 'User-Agent': UA } })
    const j = await r.json()
    const v = j?.data?.b_3
    if (v) jar.buvid3 = String(v)
  } catch {
    /* 拿不到就算了 */
  }
  return jar
}

/** 生成一张登录二维码 */
export async function loginStart() {
  const r = await fetch(GEN, { headers: { 'User-Agent': UA } })
  const j = await r.json()
  const data = j?.data
  if (!j || j.code !== 0 || !data?.qrcode_key || !data?.url) {
    throw new Error('生成登录二维码失败：' + JSON.stringify(j).slice(0, 200))
  }
  return { key: data.qrcode_key, url: data.url }
}

/**
 * 轮询一次扫码结果。
 * @returns {{status:'wait'|'scanned'|'ok'|'expired'|'unknown', credential?:object, code?:number}}
 */
export async function loginPoll(key) {
  const r = await fetch(POLL(key), { headers: { 'User-Agent': UA } })
  const j = await r.json()
  const code = j?.data?.code
  if (j?.code === 0 && code === 0) {
    const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : []
    const jar = await ensureBuvid3(pickCookies(setCookies))
    if (!jar.sessdata) throw new Error('登录成功但没拿到 SESSDATA（Set-Cookie 为空）')
    return { status: 'ok', credential: jar }
  }
  if (code === 86101) return { status: 'wait' }
  if (code === 86090) return { status: 'scanned' }
  if (code === 86038) return { status: 'expired' }
  return { status: 'unknown', code }
}

/** 用 nav 接口验证当前 cookie 是否有效 */
export async function checkLogin(cookie) {
  if (!cookie) return { ok: false, reason: '没有 cookie / 没有凭证' }
  try {
    const r = await fetch(NAV, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', cookie } })
    const j = await r.json()
    if (j?.code === 0 && j?.data?.isLogin) {
      return { ok: true, uname: j.data.uname || '', mid: Number(j.data.mid || 0), vip: Boolean(j.data.vipStatus) }
    }
    return { ok: false, reason: 'cookie 无效或已过期', code: j?.code }
  } catch (e) {
    return { ok: false, reason: '网络错误：' + (e?.message || e) }
  }
}

/** 拿一张二维码 PNG（走在线服务；失败返回 null，退回只推链接） */
async function qrPng(url, cfg) {
  const service = String(cfg.qrImageService ?? DEFAULTS.qrImageService).trim()
  if (!service) return null
  try {
    const r = await fetch(service + encodeURIComponent(url), { headers: { 'User-Agent': UA } })
    if (!r.ok) return null
    return new Uint8Array(await r.arrayBuffer())
  } catch {
    return null
  }
}

async function readState(cfg) {
  try {
    return JSON.parse(await readFile(join(dataDirOf(cfg), 'bili-login-state.json'), 'utf8'))
  } catch {
    return {}
  }
}

async function writeState(cfg, patch) {
  const s = { ...(await readState(cfg)), ...patch, updatedAt: new Date().toISOString() }
  try {
    await writeFile(join(dataDirOf(cfg), 'bili-login-state.json'), JSON.stringify(s, null, 2), 'utf8')
  } catch {
    /* 状态写不了不算事 */
  }
  return s
}

/**
 * 完整扫码流程：生成 → 推 ntfy → 轮询（过期自动换新码重推）。
 * @returns {Promise<object|null>} 成功返回凭证，超时/中止返回 null
 */
export async function qrLogin(cfg = {}, { push = true, onQr = null } = {}) {
  const opts = { ...DEFAULTS, ...(cfg || {}) }
  const deadline = Date.now() + Math.max(30, Number(opts.qrWaitSeconds) || 600) * 1000
  const state = await readState(cfg)
  let lastPushAt = Number(state.lastPushAt || 0)
  let pushCount = Number(state.pushCount || 0)
  const gap = Math.max(0, Number(opts.ntfyMinIntervalSec) || 0) * 1000
  const maxPushes = Math.max(1, Number(opts.ntfyMaxPushes) || 30)

  while (Date.now() < deadline) {
    const qr = await loginStart()
    if (typeof onQr === 'function') {
      try {
        await onQr(qr)
      } catch {
        /* 回调出错不影响登录 */
      }
    }
    if (push) {
      if (Date.now() - lastPushAt >= gap && pushCount < maxPushes) {
        const png = await qrPng(qr.url, opts)
        let code = 0
        if (png) code = await notifyQr(png, opts)
        if (!(code >= 200 && code < 300)) {
          await notifyText('B站登录过期了', '打开这条链接用 B站 App 扫码登录：' + qr.url, opts)
        }
        lastPushAt = Date.now()
        pushCount += 1
        await writeState(cfg, { lastPushAt, pushCount })
      }
    }
    const qrDeadline = Math.min(deadline, Date.now() + Math.max(60, Number(opts.qrRegenSeconds) || 180) * 1000)
    let lastStatus = ''
    while (Date.now() < qrDeadline) {
      await sleep(2000)
      const r = await loginPoll(qr.key)
      if (r.status !== lastStatus && r.status !== 'wait') lastStatus = r.status
      if (r.status === 'ok') {
        await writeCredential(cfg, r.credential)
        if (push) await notifyText(opts.ntfyOkTitle || 'B站登录已恢复', opts.ntfyOkMessage || '扫码成功，B 站工具可以继续用了喵', opts)
        await writeState(cfg, { lastPushAt: 0, pushCount: 0, lastResult: 'ok', uname: '', lastCheckAt: new Date().toISOString() })
        return r.credential
      }
      if (r.status === 'expired') break
    }
    if (Date.now() >= deadline) break
  }
  await writeState(cfg, { lastResult: 'timeout', lastCheckAt: new Date().toISOString() })
  return null
}
