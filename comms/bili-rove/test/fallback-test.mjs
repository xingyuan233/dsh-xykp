// bili-rove 自测（不启宿主、不联网）
//
// 覆盖：回退状态机、cookie 读取优先级（配置 > 环境变量 > bili-duty 凭证）
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nextStep } from '../lib/fallback.js'
import { resolveCookie, readCredential, writeCredential, cookieOf, credentialOfCookie } from '../lib/account.js'

let failed = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) failed++
}

// ── 状态机 ──
check(nextStep([]).mode === 'cookie', '第一次带 cookie')
const s1 = nextStep([{ mode: 'cookie', ok: false }], { maxCookieFailures: 3 })
check(s1.mode === 'cookie' && s1.pushQr, 'cookie 失败 → 推二维码继续等')
const s2 = nextStep([{ mode: 'cookie', ok: false }, { mode: 'cookie', ok: false }, { mode: 'cookie', ok: false }], { maxCookieFailures: 3 })
check(s2.mode === 'anonymous', '连续失败到上限 → 回退匿名')
const s3 = nextStep([{ mode: 'anonymous', ok: false }], { maxAnonymousTries: 1 })
check(s3.mode === 'fail', '匿名也失败 → 直接失败')
check(nextStep([{ mode: 'cookie', ok: true }]).mode === 'cookie', '成功后继续用 cookie')

// ── 凭证读写 ──
const dir = mkdtempSync(join(tmpdir(), 'bili-rove-'))
const cfg = { dataDir: dir }
const cred = { sessdata: 'S1', bili_jct: 'J1', buvid3: 'B1', dedeuserid: '42' }
await writeCredential(cfg, cred)
const back = await readCredential(cfg)
check(back && back.sessdata === 'S1' && back.dedeuserid === '42', '凭证原子写 / 读回')
const ck = cookieOf(back)
check(ck.includes('SESSDATA=S1') && ck.includes('bili_jct=J1') && ck.includes('DedeUserID=42'), '凭证 → cookie 串')
const parsed = credentialOfCookie(ck)
check(parsed && parsed.bili_jct === 'J1', 'cookie 串 → 凭证（拿 csrf）', JSON.stringify(parsed))

// ── cookie 优先级 ──
writeFileSync(join(dir, 'bili_credential.json'), JSON.stringify({ sessdata: 'FROM_FILE' }))
const viaFile = await resolveCookie(cfg)
check(viaFile === 'SESSDATA=FROM_FILE', '从 bili-duty 凭证读')

process.env.BILI_TEST_COOKIE = 'FROM_ENV'
const viaEnv = await resolveCookie({ ...cfg, cookieEnv: 'BILI_TEST_COOKIE' })
check(viaEnv === 'FROM_ENV', '环境变量优先于文件')
const viaCfg = await resolveCookie({ ...cfg, cookie: 'FROM_CFG', cookieEnv: 'BILI_TEST_COOKIE' })
check(viaCfg === 'FROM_CFG', '配置里的 cookie 优先级最高')
delete process.env.BILI_TEST_COOKIE

rmSync(dir, { recursive: true, force: true })
console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exitCode = failed ? 1 : 0
