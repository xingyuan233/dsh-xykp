// 峰谷判定：北京时间（UTC+8）。
//
// 峰时：周一至周五（不含中国法定节假日）09:00–12:00、14:00–18:00。
// 其余时间（含周末、法定节假日全天）谷时，谷时价格 = 峰时价格的一半。
//
// 法定节假日表由 client/make-holidays.mjs 从 NateScarlet/holiday-cn 生成，
// 内嵌快照覆盖 2025–2028；宿主插件会每周自动刷新，
// 页面也会用 /xykp/balance-reporter/holidays 或 localStorage 里的更新结果覆盖这张表。
var __xykpVk1Holidays = new Set(["2025-01-01","2025-01-28","2025-01-29","2025-01-30","2025-01-31","2025-02-01","2025-02-02","2025-02-03","2025-02-04","2025-04-04","2025-04-05","2025-04-06","2025-05-01","2025-05-02","2025-05-03","2025-05-04","2025-05-05","2025-05-31","2025-06-01","2025-06-02","2025-10-01","2025-10-02","2025-10-03","2025-10-04","2025-10-05","2025-10-06","2025-10-07","2025-10-08","2026-01-01","2026-01-02","2026-01-03","2026-02-15","2026-02-16","2026-02-17","2026-02-18","2026-02-19","2026-02-20","2026-02-21","2026-02-22","2026-02-23","2026-04-04","2026-04-05","2026-04-06","2026-05-01","2026-05-02","2026-05-03","2026-05-04","2026-05-05","2026-06-19","2026-06-20","2026-06-21","2026-09-25","2026-09-26","2026-09-27","2026-10-01","2026-10-02","2026-10-03","2026-10-04","2026-10-05","2026-10-06","2026-10-07","2027-01-01","2027-01-02","2027-01-03","2027-02-05","2027-02-06","2027-02-07","2027-02-08","2027-02-09","2027-02-10","2027-02-11","2027-02-12","2027-02-13","2027-04-03","2027-04-04","2027-04-05","2027-05-01","2027-05-02","2027-05-03","2027-05-04","2027-05-05","2027-06-09","2027-09-15","2027-10-01","2027-10-02","2027-10-03","2027-10-04","2027-10-05","2027-10-06","2027-10-07"])

function __xykpVk1SetHolidays(days) {
  if (!Array.isArray(days)) return false
  var next = new Set()
  for (var i = 0; i < days.length; i++) {
    var d = String(days[i] || '')
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) next.add(d)
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
