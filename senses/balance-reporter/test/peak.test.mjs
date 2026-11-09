// 峰谷判定回归测试：node senses/balance-reporter/test/peak.test.mjs
// 规则：北京时间周一至周五（不含法定节假日）09:00–12:00、14:00–18:00 为峰时；
// 其余时间（含周末、法定节假日全天）为谷时。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '../client/peak.js'), 'utf8')
const peak = new Function(source + '\nreturn __xykpVk1Peak')()
const DAY = 86400000

/** 北京时间 -> 真实 UTC 毫秒。 */
function bj(y, m, d, hh = 0, mm = 0, ss = 0) {
  return Date.UTC(y, m - 1, d, hh, mm, ss) - 8 * 3600000
}
function check(y, m, d, hh, mm, expectOff, nextB, label) {
  const now = bj(y, m, d, hh, mm)
  const info = peak.info(now)
  assert.equal(info.off, expectOff, `${label}: off`)
  assert.equal(new Date(now + info.left).toISOString(), new Date(nextB).toISOString(), `${label}: next`)
}

// 2026-11-09 是周一。
check(2026, 11, 9, 8, 59, true, bj(2026, 11, 9, 9, 0), '周一 08:59')
check(2026, 11, 9, 9, 0, false, new Date(bj(2026, 11, 9, 12, 0)).toISOString(), '周一 09:00')
check(2026, 11, 9, 11, 59, false, new Date(bj(2026, 11, 9, 12, 0)).toISOString(), '周一 11:59')
check(2026, 11, 9, 12, 0, true, new Date(bj(2026, 11, 9, 14, 0)).toISOString(), '周一 12:00')
check(2026, 11, 9, 12, 47, true, new Date(bj(2026, 11, 9, 14, 0)).toISOString(), '周一 12:47')
check(2026, 11, 9, 14, 0, false, new Date(bj(2026, 11, 9, 18, 0)).toISOString(), '周一 14:00')
check(2026, 11, 9, 18, 0, true, new Date(bj(2026, 11, 10, 9, 0)).toISOString(), '周一 18:00')
check(2026, 11, 13, 19, 0, true, new Date(bj(2026, 11, 16, 9, 0)).toISOString(), '周五晚 -> 周一')
check(2026, 11, 14, 10, 0, true, new Date(bj(2026, 11, 16, 9, 0)).toISOString(), '周六')
check(2026, 11, 15, 10, 0, true, new Date(bj(2026, 11, 16, 9, 0)).toISOString(), '周日')
check(2026, 10, 2, 10, 0, true, new Date(bj(2026, 10, 8, 9, 0)).toISOString(), '国庆 10-02')
check(2026, 10, 8, 9, 0, false, new Date(bj(2026, 10, 8, 12, 0)).toISOString(), '国庆后首个工作日')
check(2027, 1, 1, 10, 0, true, new Date(bj(2027, 1, 4, 9, 0)).toISOString(), '2027 元旦')
check(2025, 1, 29, 10, 0, true, new Date(bj(2025, 2, 5, 9, 0)).toISOString(), '2025 春节')
// 调休上班的周末仍然是谷时。
check(2026, 2, 14, 10, 0, true, bj(2026, 2, 24, 9, 0), '周六（春节调休上班日）')

console.log('peak test: OK')
