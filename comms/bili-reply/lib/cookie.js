// bili-reply · 读 cookie
// 优先级：配置 > 环境变量 BILIBILI_SESSDATA > bili-duty/bili_credential.json > tools/bili-bot/cookie.json
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULTS = {
  cookie: '',
  cookieEnv: 'BILIBILI_SESSDATA',
  dutyConfigPath: '',
}

const home = () => process.env.DSH_HOME || join(homedir(), '.dsh')

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

  const dutyPath = cfg.dutyConfigPath || join(home(), 'bili-duty', 'bili_credential.json')
  const duty = await readJson(dutyPath, null)
  const fromDuty = fromCredential(duty)
  if (fromDuty) return fromDuty

  const botPath = cfg.botCookiePath || join(home(), '..', 'tools', 'bili-bot', 'cookie.json')
  const bot = await readJson(botPath, null)
  return fromCredential(bot)
}
