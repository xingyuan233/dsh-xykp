// bili-rove 自测（不启宿主、不联网）
//
// 覆盖：回退状态机（cookie 失败→推码→匿名→失败）、runWithFallback 的真实流程、
//       cookie 读取优先级（配置 > 环境变量 > bili-duty/config.json）
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nextStep } from '../lib/fallback.js'
import { runWithFallback, resolveCookie } from '../lib/index.js'

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

// ── runWithFallback：cookie 失败 → 匿名成功 ──
let qrCount = 0
const deps = {
  cookie: async () => 'SESSDATA=abc',
  call: async ({ mode, cookie }) => {
    if (cookie === 'SESSDATA=abc') throw new Error('401 风控')
    return { hello: 'anonymous' }
  },
  pushQr: async () => { qrCount++ },
  waitForCookie: async () => false,
}
const r1 = await runWithFallback('search', { keyword: 'x' }, { maxCookieFailures: 2, qrWaitSeconds: 0 }, deps)
check(r1.ok === true && r1.mode === 'anonymous', 'cookie 挂了之后匿名成功', `mode=${r1.mode}`)
check(qrCount === 1, '只推一次二维码', `qr=${qrCount}`)

// ── runWithFallback：全挂 → 失败 ──
const r2 = await runWithFallback('search', {}, { maxCookieFailures: 1, maxAnonymousTries: 1, qrWaitSeconds: 0 }, {
  ...deps,
  call: async () => { throw new Error('全挂') },
  cookie: async () => 'SESSDATA=abc',
})
check(r2.ok === false && r2.error === 'BILI_ROVE_LIMITED', '全挂时报 BILI_ROVE_LIMITED')

// ── cookie 优先级 ──
const dir = mkdtempSync(join(tmpdir(), 'bili-rove-'))
const duty = join(dir, 'config.json')
writeFileSync(duty, JSON.stringify({ cookie: 'FROM_FILE' }))
const viaFile = await resolveCookie({ dutyConfigPath: duty })
check(viaFile === 'FROM_FILE', '从 bili-duty 配置文件读')
const viaEnv = await resolveCookie({ dutyConfigPath: duty, cookieEnv: 'BILI_TEST_COOKIE' })
check(viaEnv === 'FROM_FILE', '没有环境变量时仍回落到文件')
process.env.BILI_TEST_COOKIE = 'FROM_ENV'
const viaEnv2 = await resolveCookie({ dutyConfigPath: duty, cookieEnv: 'BILI_TEST_COOKIE' })
check(viaEnv2 === 'FROM_ENV', '环境变量优先于文件')
const viaCfg = await resolveCookie({ dutyConfigPath: duty, cookie: 'FROM_CFG', cookieEnv: 'BILI_TEST_COOKIE' })
check(viaCfg === 'FROM_CFG', '配置里的 cookie 优先级最高')
delete process.env.BILI_TEST_COOKIE

rmSync(dir, { recursive: true, force: true })
console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exitCode = failed ? 1 : 0
