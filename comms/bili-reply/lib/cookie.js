// bili-reply · 读 cookie
// 唯一存储位置：<DSH_HOME>/xykp/bilibili/bili_credential.json
// 覆盖顺序：配置 cookie > 环境变量 BILIBILI_SESSDATA > 上面的凭证文件
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULTS = {
  cookie: '',
  cookieEnv: 'BILIBILI_SESSDATA',
  // 凭证文件（空 = <DSH_HOME>/xykp/bilibili/bili_credential.json）
  credPath: '',
}

const home = () => process.env.DSH_HOME || join(homedir(), '.dsh')

export const credPathOf = (cfg = {}) =>
  String(cfg.credPath || cfg.dutyConfigPath || '').trim() ||
  join(home(), 'xykp', 'bilibili', 'bili_credential.json')

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** 从 {sessdata|SESSDATA, bili_jct, dedeuserid|DedeUserID} 拼出 cookie 串 */
function fromCredential(j) {
  if (!j || typeof j !== 'object') return ''
  const sess = String(j.sessdata || j.SESSDATA || '').trim()
  if (!sess) return ''
  const parts = ['SESSDATA=' + sess]
  const jct = String(j.bili_jct || '').trim()
  if (jct) parts.push('bili_jct=' + jct)
  const uid = String(j.dedeuserid || j.DedeUserID || '').trim()
  if (uid) parts.push('DedeUserID=' + uid)
  return parts.join('; ')
}

export async function resolveCookie(cfg = {}) {
  const literal = String(cfg.cookie || '').trim()
  if (literal) return literal
  const env = String(cfg.cookieEnv || DEFAULTS.cookieEnv)
  const fromEnv = String(process.env[env] || '').trim()
  if (fromEnv) return fromEnv

  const cred = await readJson(credPathOf(cfg), null)
  return fromCredential(cred)
}
