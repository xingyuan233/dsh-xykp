// senses/balance-reporter · 页面侧（VK-1 余额挂件）
//
// 这个文件会被 build.mjs 拼进包根 client.js 的生成段里，和 vendored widget.js
// 一起组成「页面右下角的余额宠物」。
//
// 余额来源有两条，按优先级：
//   1. 宿主插件 /xykp/balance-reporter/status（缓存 + 历史；重启后才存在）
//   2. 客户端 ctx.remote.account.getBalance()（现在就能用）
// 两条都失败时挂件会显示断线红点，下一轮自动重试。

function installBalanceReporter(ctx) {
  var KEY = '__xykpBalanceReporter'
  var prev = window[KEY]
  if (prev && typeof prev.stop === 'function') {
    try { prev.stop() } catch (e) {}
  }

  var stopped = false
  var restoreBtn = null
  var routeState = 'unknown' // unknown | ok | missing
  var routeNextTry = 0

  function stopWidget() {
    try {
      var table = window.__dshAppearanceWidgets
      if (table && table['dsh-vk1-balance-widget'] && typeof table['dsh-vk1-balance-widget'].stop === 'function') {
        table['dsh-vk1-balance-widget'].stop()
      }
    } catch (e) {}
  }

  // 挂件是 pointer-events:none，鼠标移到它下面时 elementFromPoint 拿到的是真正的页面控件。
  // 底部（输入框 / 发送按钮 / 模型选择）一旦被指到，就让挂件淡出，别挡输入。
  var yieldStyle = document.createElement('style')
  yieldStyle.id = 'xykp-balance-pet-yield-style'
  var yieldOn = true
  var yieldOpacity = 0.07
  function yieldCss() {
    return (
      '.dshvk1-stage{transition:opacity .55s cubic-bezier(.22,.61,.36,1)!important}' +
      // 让挂件矩形本身接住 hover / pointermove，页面不会再在下面跟着交互；
      // 需要输入框时，.dshvk1-yield 会把 pointer-events 关掉，让页面接管。
      '.dshvk1-root{pointer-events:auto!important;transition:left .16s ease,top .16s ease,opacity .55s cubic-bezier(.22,.61,.36,1)!important}' +
      '.dshvk1-root.dshvk1-dragging{transition:none!important}' +
      '.dshvk1-yield{opacity:' + yieldOpacity + ' !important;pointer-events:none!important}'
    )
  }
  function applyYieldStyle() {
    yieldStyle.textContent = yieldCss()
  }
  applyYieldStyle()
  var staleStyle = document.getElementById('xykp-balance-pet-yield-style')
  if (staleStyle) staleStyle.remove()
  document.head.appendChild(yieldStyle)
  var yielding = false
  function setYield(on) {
    if (yielding === on) return
    yielding = on
    var stage = document.querySelector('.dshvk1-stage')
    var root = document.querySelector('.dshvk1-root')
    if (stage) stage.classList.toggle('dshvk1-yield', on)
    if (root) root.classList.toggle('dshvk1-yield', on)
  }
  function onPointerMove(e) {
    if (stopped) return
    if (!yieldOn) {
      setYield(false)
      return
    }
    // 挂件自己接住了 hover，所以用 elementsFromPoint 看它下面真正是什么。
    var stack = document.elementsFromPoint(e.clientX, e.clientY)
    var el = null
    for (var i = 0; i < stack.length; i++) {
      if (!stack[i].closest || !stack[i].closest('.dshvk1-root,.dshvk1-stage,.dshvk1-menu,.dshvk1-dialog')) {
        el = stack[i]
        break
      }
    }
    var interactive = !!(el && el.closest && el.closest('textarea,input,select,[contenteditable="true"],[role="textbox"]'))
    setYield(interactive)
  }
  function onBlurYield() { setYield(false) }
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('blur', onBlurYield, true)
  var yieldApi = {
    set: function (on, opacity) {
      yieldOn = on !== false
      if (typeof opacity === 'number' && isFinite(opacity)) yieldOpacity = Math.max(0, Math.min(1, opacity))
      applyYieldStyle()
      if (!yieldOn) setYield(false)
    },
  }
  window.__xykpVk1Yield = yieldApi

  function localeTag() {
    try {
      var locale = ctx.get('locale')
      var snap = locale && locale.getSnapshot && locale.getSnapshot()
      if (snap && snap.active) return snap.active
    } catch (e) {}
    return 'zh-CN'
  }

  function clientMeta() {
    return {
      version: '0.2.1-rc.2',
      locale: localeTag(),
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    }
  }

  async function sleep(ms) {
    await new Promise(function (resolve) { setTimeout(resolve, ms) })
  }

  function pollSeconds() {
    try {
      var options = JSON.parse(localStorage.getItem('dsh-vk1-options') || 'null')
      var s = Number(options && options.pollSeconds)
      return isFinite(s) ? Math.max(2, Math.min(300, s)) : 12
    } catch (e) {
      return 12
    }
  }

  async function fromHost(force) {
    if (stopped) return null
    if (routeState === 'missing' && Date.now() < routeNextTry) return null
    try {
      var query = force ? '?force=1' : '?maxAge=' + pollSeconds()
      var res = await fetch('/xykp/balance-reporter/status' + query, { credentials: 'same-origin', cache: 'no-store' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      var data = await res.json()
      if (data && data.ok === true && data.total != null && isFinite(Number(data.total))) {
        routeState = 'ok'
        return {
          ok: true,
          totalBalance: Number(data.total),
          serverTime: new Date(Number(data.at) || Date.now()).toISOString(),
          origin: 'host',
        }
      }
      if (data && data.ok === false) {
        routeState = 'ok'
        return null
      }
      throw new Error('bad payload')
    } catch (e) {
      routeState = 'missing'
      routeNextTry = Date.now() + 5 * 60 * 1000
      return null
    }
  }

  async function fromAccount() {
    var lastErr = null
    for (var attempt = 0; attempt < 6; attempt++) {
      if (stopped) throw new Error('stopped')
      var account = ctx.get('remote.account')
      if (account && typeof account.getBalance === 'function') {
        try {
          var res = await account.getBalance(clientMeta())
          if (!res || !res.ok) throw new Error('账号余额请求失败')
          var value = res.value
          if (!value || value.status !== 'ready') throw new Error('账号还没登录')
          var total = 0
          var wallets = (value.value || []).concat(value.bonusWallets || [])
          for (var i = 0; i < wallets.length; i++) total += Number(wallets[i].balance) || 0
          return {
            ok: true,
            totalBalance: total,
            serverTime: new Date().toISOString(),
            origin: 'account',
          }
        } catch (err) {
          lastErr = err
        }
      } else {
        lastErr = lastErr || new Error('remote.account 还没就绪')
      }
      await sleep(800)
    }
    throw lastErr || new Error('拿不到余额')
  }

  window.__xykpVk1BalanceProvider = async function (force) {
    if (stopped) throw new Error('stopped')
    var host = await fromHost(!!force)
    if (host) return host
    return await fromAccount()
  }

  function showRestoreButton() {
    if (restoreBtn || stopped) return
    var btn = document.createElement('button')
    btn.id = 'xykp-balance-pet-restore'
    btn.type = 'button'
    btn.title = '显示 VK-1 余额挂件'
    btn.textContent = 'VK'
    btn.style.cssText = [
      'position:fixed', 'right:14px', 'bottom:14px', 'width:36px', 'height:36px',
      'border-radius:50%', 'border:1px solid rgba(255,255,255,.22)',
      'background:rgba(24,27,33,.86)', 'color:#ffd166',
      'font:700 12px/1 system-ui,sans-serif', 'z-index:2147483000',
      'cursor:pointer', 'box-shadow:0 6px 20px rgba(0,0,0,.35)',
      'backdrop-filter:blur(6px)', 'pointer-events:auto',
    ].join(';')
    btn.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      if (restoreBtn) {
        restoreBtn.remove()
        restoreBtn = null
      }
      startWidget()
    })
    document.body.appendChild(btn)
    restoreBtn = btn
  }

  function hideWidget() {
    if (stopped) return
    stopWidget()
    showRestoreButton()
  }

  function startWidget() {
    if (stopped) return
    if (window.__dshVk1Widget) stopWidget()
    try {
      __xykpVk1Start()
    } catch (err) {
      console.warn('[balance-reporter] 挂件启动失败：', err)
    }
  }

  window.__xykpVk1Hide = hideWidget

  var instance = {
    stop: function () {
      if (stopped) return
      stopped = true
      window.removeEventListener('pointermove', onPointerMove, true)
      window.removeEventListener('blur', onBlurYield, true)
      try { yieldStyle.remove() } catch (e) {}
      setYield(false)
      if (window.__xykpVk1Yield === yieldApi) window.__xykpVk1Yield = null
      stopWidget()
      if (restoreBtn) {
        restoreBtn.remove()
        restoreBtn = null
      }
      if (window.__xykpVk1Hide === hideWidget) window.__xykpVk1Hide = null
      if (window[KEY] === instance) window[KEY] = null
    },
    refresh: function () {
      try {
        var table = window.__dshAppearanceWidgets
        var api = table && table['dsh-vk1-balance-widget']
        if (api && typeof api.refresh === 'function') api.refresh()
      } catch (e) {}
    },
    hide: hideWidget,
  }
  window[KEY] = instance

  // ---- 节假日数据：内嵌表是兜底；优先宿主缓存，其次 7 天内的 localStorage，最后直连 GitHub。
  function holidayYear() {
    return new Date(Date.now() + 8 * 3600000).getUTCFullYear()
  }

  function applyHolidayDays(days) {
    try {
      var peak = window.__xykpVk1Peak
      if (peak && typeof peak.setHolidays === 'function') peak.setHolidays(days)
    } catch (e) {}
  }

  function readHolidayCache() {
    try {
      var raw = JSON.parse(localStorage.getItem('xykp-balance-reporter-holidays') || 'null')
      return raw && Array.isArray(raw.days) && raw.days.length ? raw : null
    } catch (e) {
      return null
    }
  }

  function saveHolidayCache(data) {
    try {
      localStorage.setItem('xykp-balance-reporter-holidays', JSON.stringify(data))
    } catch (e) {}
  }

  async function fetchHostHolidays() {
    try {
      var res = await fetch('/xykp/balance-reporter/holidays', { credentials: 'same-origin', cache: 'no-store' })
      if (!res.ok) return null
      var data = await res.json()
      if (data && data.ok === true && Array.isArray(data.days) && data.days.length) {
        return {
          updatedAt: Number(data.updatedAt) || Date.now(),
          years: Array.isArray(data.years) ? data.years : [],
          days: data.days,
          source: data.source || 'host',
        }
      }
    } catch (e) {}
    return null
  }

  async function fetchGithubHolidays(years) {
    var days = []
    for (var i = 0; i < years.length; i++) {
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null
      var timer = ctrl ? setTimeout(function () { ctrl.abort() }, 6000) : null
      try {
        var res = await fetch('https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/' + years[i] + '.json', {
          cache: 'no-store',
          signal: ctrl ? ctrl.signal : undefined,
        })
        if (timer) clearTimeout(timer)
        if (!res.ok) continue
        var data = await res.json()
        var list = data.days || []
        for (var j = 0; j < list.length; j++) {
          if (list[j].isOffDay && /^\d{4}-\d{2}-\d{2}$/.test(String(list[j].date))) days.push(list[j].date)
        }
      } catch (e) {
        if (timer) clearTimeout(timer)
      }
    }
    return days.length ? days : null
  }

  async function refreshHolidays() {
    if (stopped) return
    var host = await fetchHostHolidays()
    if (stopped) return
    if (host) {
      saveHolidayCache(host)
      applyHolidayDays(host.days)
      return
    }
    var cached = readHolidayCache()
    if (cached) applyHolidayDays(cached.days)
    var age = cached ? Date.now() - Number(cached.updatedAt || 0) : Infinity
    if (cached && age < 7 * 86400000) return
    var year = holidayYear()
    var days = await fetchGithubHolidays([year, year + 1, year + 2])
    if (stopped || !days) return
    var merged = Array.from(new Set([...(cached && cached.days ? cached.days : []), ...days])).sort()
    var data = { updatedAt: Date.now(), years: [year, year + 1, year + 2], days: merged, source: 'github' }
    saveHolidayCache(data)
    applyHolidayDays(data.days)
  }

  startWidget()

  try {
    var cachedNow = readHolidayCache()
    if (cachedNow) applyHolidayDays(cachedNow.days)
  } catch (e) {}
  refreshHolidays().catch(function () {})

  ctx.effect(function () {
    return function () {
      instance.stop()
    }
  })
}
