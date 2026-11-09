// 生成 senses/balance-reporter/client/peak.js（内嵌兜底表）和 holidays.json（宿主兜底）。
// 数据：NateScarlet/holiday-cn（每年国务院安排，isOffDay=true 的休假日）。
// 调休上班的周末不要：规则里周末本来就是谷时。
//
// 用法：node client/make-holidays.mjs
// 之后跑 node client/build.mjs --install 把新的 peak.js 拼进 client.js。
import { writeFileSync } from 'node:fs'

const nowYear = new Date(Date.now() + 8 * 3600000).getUTCFullYear()
const years = [nowYear - 1, nowYear, nowYear + 1, nowYear + 2]
const dates = []
const fetched = []
for (const y of years) {
  try {
    const res = await fetch(`https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${y}.json`)
    if (!res.ok) {
      console.warn(`skip ${y}: HTTP ${res.status}`)
      continue
    }
    const data = await res.json()
    for (const day of data.days || []) {
      if (day.isOffDay) dates.push(day.date)
    }
    fetched.push(y)
  } catch (err) {
    console.warn(`skip ${y}: ${err.message}`)
  }
}
if (!fetched.length) throw new Error('没有取到任何年份的节假日数据')
const unique = [...new Set(dates)].sort()
if (!unique.length) throw new Error('节假日数据为空')

const source = `// 峰谷判定：北京时间（UTC+8）。
//
// 峰时：周一至周五（不含中国法定节假日）09:00–12:00、14:00–18:00。
// 其余时间（含周末、法定节假日全天）谷时，谷时价格 = 峰时价格的一半。
//
// 法定节假日表由 client/make-holidays.mjs 从 NateScarlet/holiday-cn 生成，
// 内嵌快照覆盖 ${years[0]}–${years[years.length - 1]}；宿主插件会每周自动刷新，
// 页面也会用 /xykp/balance-reporter/holidays 或 localStorage 里的更新结果覆盖这张表。
var __xykpVk1Holidays = new Set(${JSON.stringify(unique)})

function __xykpVk1SetHolidays(days) {
  if (!Array.isArray(days)) return false
  var next = new Set()
  for (var i = 0; i < days.length; i++) {
    var d = String(days[i] || '')
    if (/^\\d{4}-\\d{2}-\\d{2}$/.test(d)) next.add(d)
  }
  if (!next.size) return false
  __xykpVk1Holidays = next
  return true
}

var __xykpVk1Peak = (function () {
  var DAY = 86400000
  var OFFSET = 8 * 3600000
  var PEAK = [9 * 3600, 12 * 3600, 14 * 3600, 18 * 3600]

  function pad2(n) { return n < 10 ? '0' + n : String(n) }
  function dayKey(t) {
    var d = new Date(t)
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
  }
  /** t 是「北京时间轴」上的毫秒（ts + 8h）。 */
  function isOffAt(t) {
    var d = new Date(t)
    var wd = d.getUTCDay()
    if (wd === 0 || wd === 6) return true
    if (__xykpVk1Holidays.has(dayKey(t))) return true
    var s = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()
    return !((s >= PEAK[0] && s < PEAK[1]) || (s >= PEAK[2] && s < PEAK[3]))
  }
  /** 下一个峰/谷切换点（北京时间轴毫秒）。 */
  function nextChange(t) {
    var dayStart = Math.floor(t / DAY) * DAY
    var current = isOffAt(t)
    for (var i = 0; i < 15; i++) {
      for (var j = 0; j < 5; j++) {
        var at = dayStart + i * DAY + [0, 9, 12, 14, 18][j] * 3600000
        if (at > t && isOffAt(at) !== current) return at
      }
    }
    return t + DAY
  }
  return {
    /** nowMs 是真实 UTC 毫秒；返回 { off, left(ms) }。 */
    info: function (nowMs) {
      var t = nowMs + OFFSET
      var target = nextChange(t)
      return { off: isOffAt(t), left: Math.max(0, target - OFFSET - nowMs) }
    },
    /** 用宿主/页面拉到的新表替换内嵌快照。 */
    setHolidays: __xykpVk1SetHolidays,
    holidayCount: function () { return __xykpVk1Holidays.size },
  }
})()
`

writeFileSync(new URL('./peak.js', import.meta.url), source, 'utf8')
writeFileSync(
  new URL('./holidays.json', import.meta.url),
  JSON.stringify({ version: 1, updatedAt: Date.now(), years: fetched, days: unique }, null, 0),
  'utf8',
)
console.log(`wrote peak.js / holidays.json: ${fetched.join(',')} (${unique.length} days)`)
