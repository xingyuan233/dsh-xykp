// bili-rove · 账号数据
//
// 只碰 <DSH_HOME>/bili-duty 里的**数据文件**（凭证 / 配置 / 缓存），
// 不再依赖 tools/bili-bot 或 duty 里的 Python 脚本。
//
// 凭证格式沿用 B站 MCP 的四个字段（小写）：
//   { sessdata, bili_jct, buvid3, dedeuserid }
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULTS = {
  // 数据目录（空 = <DSH_HOME>/bili-duty）
  dataDir: '',
  // 直接写死的 cookie（不推荐）
  cookie: '',
  // 环境变量名
  cookieEnv: 'BILIBILI_SESSDATA',
}

export const home = () => process.env.DSH_HOME || join(homedir(), '.dsh')

export function dataDirOf(cfg = {}) {
  const literal = String(cfg.dataDir || '').trim()
  return literal || join(home(), 'bili-duty')
}

export const credPathOf = (cfg = {}) => join(dataDirOf(cfg), 'bili_credential.json')
export const configPathOf = (cfg = {}) => join(dataDirOf(cfg), 'config.json')

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** 读凭证；没有 / 读坏了都返回 null（调用方按「没登录」处理，扫一次码就能恢复） */
export async function readCredential(cfg = {}) {
  const j = await readJson(credPathOf(cfg), null)
  if (!j || typeof j !== 'object') return null
  const sessdata = String(j.sessdata || j.SESSDATA || '').trim()
  if (!sessdata) return null
  return {
    sessdata,
    bili_jct: String(j.bili_jct || '').trim(),
    buvid3: String(j.buvid3 || '').trim(),
    dedeuserid: String(j.dedeuserid || j.DedeUserID || '').trim(),
  }
}

/** 原子写凭证：先写 .tmp 再 replace，写到一半被打断也不会毁掉旧凭证 */
export async function writeCredential(cfg = {}, cred = {}) {
  const path = credPathOf(cfg)
  await mkdir(dataDirOf(cfg), { recursive: true })
  const tmp = path + '.tmp'
  await writeFile(tmp, JSON.stringify({
    sessdata: String(cred.sessdata || ''),
    bili_jct: String(cred.bili_jct || ''),
    buvid3: String(cred.buvid3 || ''),
    dedeuserid: String(cred.dedeuserid || ''),
  }, null, 2), 'utf8')
  await rename(tmp, path)
}

/** 凭证 → cookie 请求头 */
export function cookieOf(cred) {
  if (!cred || !cred.sessdata) return ''
  const parts = ['SESSDATA=' + cred.sessdata]
  if (cred.bili_jct) parts.push('bili_jct=' + cred.bili_jct)
  if (cred.dedeuserid) parts.push('DedeUserID=' + cred.dedeuserid)
  if (cred.buvid3) parts.push('buvid3=' + cred.buvid3)
  return parts.join('; ')
}

export const csrfOf = (cred) => String((cred && cred.bili_jct) || '')
export const uidOf = (cred) => Number((cred && cred.dedeuserid) || 0)

/**
 * cookie 读取优先级：配置 > 环境变量 > bili-duty/bili_credential.json。
 * 返回 cookie 字符串（可能是空串）。
 */
export async function resolveCookie(cfg = {}) {
  const literal = String(cfg.cookie || '').trim()
  if (literal) return literal
  const env = String(cfg.cookieEnv || DEFAULTS.cookieEnv)
  const fromEnv = String(process.env[env] || '').trim()
  if (fromEnv) return fromEnv
  return cookieOf(await readCredential(cfg))
}

/** 把 cookie 串拆回凭证四件套（给需要 csrf / uid 的写接口用） */
export function credentialOfCookie(cookie = '') {
  const pick = (name) => {
    const m = String(cookie).match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'))
    return m ? decodeURIComponent(m[1]) : ''
  }
  const cred = {
    sessdata: pick('SESSDATA'),
    bili_jct: pick('bili_jct'),
    buvid3: pick('buvid3'),
    dedeuserid: pick('DedeUserID'),
  }
  return cred.sessdata ? cred : null
}
