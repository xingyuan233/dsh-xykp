// QQ 自研适配层 · 注入脚本 v10
// 在 QQ 主进程里跑：自己 init session → 收/发消息 → 本地 HTTP 给 DSH 插件用
// 只在 qq-inst2（独立实例）执行主逻辑；热重载 1.5s
(function () {
  var p = process
  var fs = p.mainModule.require('fs')
  var path = p.mainModule.require('path')
  var os = p.mainModule.require('os')
  var WS = 'D:\\AI\\DeepseekHarness\\workspaces\\alive-workspace'
  var LOG = WS + '\\qq-bridge.log'
  var SELF = WS + '\\qq-bridge-script.js'
  var CMD = WS + '\\qq-cmd.json'
  var RES = WS + '\\qq-cmd-result.json'
  var TAG = '[' + p.pid + ']'
  function w(s) { try { fs.appendFileSync(LOG, TAG + ' ' + s + '\n') } catch (e) { } }
  function J(o) { try { var s = JSON.stringify(o); return s === undefined ? String(o) : s } catch (e) { return 'ERR ' + e } }

  // ---------- 自热重载（所有实例） ----------
  if (!global.__qqReload) {
    var last0 = fs.statSync(SELF).mtimeMs
    global.__qqReload = setInterval(function () {
      try {
        var m = fs.statSync(SELF).mtimeMs
        if (m !== last0) { last0 = m; try { eval(fs.readFileSync(SELF, 'utf8')) } catch (e) { w('[qq] reload eval err ' + e.message) } }
      } catch (e) { }
    }, 1500)
    w('[qq] self-reload ON pid=' + p.pid)
  }

  var IS_TARGET = false
  try { IS_TARGET = /qq-inst|QQ-shell/i.test(p.argv.join(' ')) } catch (e) { }
  if (!IS_TARGET) return

  var S = global.__qqState || (global.__qqState = { inbox: [], stage: 'init' })
  if (!S.inbox) S.inbox = []

  // ---------- 配置 ----------
  var CFG = {}
  try { CFG = JSON.parse(fs.readFileSync(WS + '\\qq-config.json', 'utf8') || '{}') } catch (e) { }

  // ---------- 常量 ----------
  var WRAPPER = CFG.wrapperPath || 'D:\\Program-Files\\QQ-dsh\\versions\\9.9.36-53644\\resources\\app\\wrapper.node'
  var VER = '9.9.36-53644'
  var APPID = 537391628
  var QUA = 'V1_WIN_NQ_9.9.36_53644_GW_B'
  var DATA_ROOT = 'D:\\下载\\缓存\\qq聊天消息\\Tencent Files'
  var OWN = WS + '\\qq-nt'
  var GLOBAL_PATH = OWN + '\\global'
  var PORT = 39272
  var QUICK_UIN = '3793339506'
  var LISTENER_VER = 'v17'
  var HTTP_VER = 'v11'
  var CMD_VER = 'v10'

  try { fs.mkdirSync(GLOBAL_PATH, { recursive: true }) } catch (e) { }

  var wmod
  try { wmod = p.mainModule.require(WRAPPER) } catch (e) { w('[qq] require wrapper FAILED ' + e.message); return }
  var eng = wmod.NodeIQQNTWrapperEngine.get()
  var login = wmod.NodeIKernelLoginService.get()

  function msgService() {
    try { return S.session ? S.session.getMsgService() : null } catch (e) { return null }
  }

  // ---------- 0) 控制 app 侧的登录调用 ----------
  // QQ 的 UI（major.node）和我们的 session 共用同一个 login service。
  // 挡太多会把扫码流程也弄坏（实测：挡住 getQRCodePicture/connect 之后扫码直接失败），
  // 现在默认什么都不挡，靠 qq-config.json 里的 patchLogin 开关实验。
  if (!global.__qqLoginPatched) {
    global.__qqLoginPatched = true
    try {
      S.realLogin = {
        connect: login.connect.bind(login),
        getQRCodePicture: login.getQRCodePicture.bind(login),
        quickLoginWithUin: login.quickLoginWithUin.bind(login)
      }
      w('[qq] realLogin refs saved')
    } catch (e) { w('[qq] save realLogin THREW ' + e.message) }
  }
  if (CFG.policy) S.policy = CFG.policy
  S.policy = S.policy || { connect: true, qr: true, quick: false }
  if (CFG.patchLogin === false) w('[qq] app login patch DISABLED (config)')
  else try {
    if (S.realLogin) {
      login.connect = function () {
        if (S.policy.connect) return S.realLogin.connect()
        w('[qq] app login.connect BLOCKED')
      }
      login.getQRCodePicture = function () {
        if (S.policy.qr) return S.realLogin.getQRCodePicture()
        w('[qq] app getQRCodePicture BLOCKED')
        return false
      }
      login.quickLoginWithUin = function (u) {
        if (S.policy.quick) return S.realLogin.quickLoginWithUin(u)
        w('[qq] app quickLogin(' + u + ') BLOCKED')
        return Promise.resolve({ result: '-1', loginErrorInfo: { errMsg: 'blocked by dsh adapter' } })
      }
    }
  } catch (e) { w('[qq] reapply login policy THREW ' + e.message) }

  // ---------- 1) 引擎 + 登录服务（只做一次） ----------
  if (!S.engineInited) {
    try {
      eng.initWithDeskTopConfig({
        base_path_prefix: '', platform_type: 3, app_type: 4, app_version: VER,
        os_version: os.release(), use_xlog: false, qua: QUA,
        global_path_config: { desktopGlobalPath: GLOBAL_PATH },
        thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 }
      }, {
        onLog: function () { },
        onGetSrvCalTime: function () { return 0 },
        onShowErrUITips: function () { },
        fixPicImgType: function () { },
        getAppSetting: function () { return '{"maxSide":324,"minSide":48,"longLimit":6,"density":2}' },
        onInstallFinished: function () { },
        onUpdateGeneralFlag: function () { },
        onGetOfflineMsg: function () { }
      })
      w('[qq] engine.initWithDeskTopConfig done')
      S.engineInited = true
    } catch (e) { w('[qq] engine.init THREW ' + e.message) }
  }
  if (!S.loginInited) {
    if (CFG.skipLoginInit) {
      w('[qq] login.initConfig SKIPPED (config) - 交给 QQ 界面自己登')
      S.loginInited = true
    } else
    try {
      login.initConfig({
        machineId: '', appid: APPID, platVer: os.release(), commonPath: (CFG.commonPath || GLOBAL_PATH),
        clientVer: VER, hostName: os.hostname(), externalVersion: false
      })
      w('[qq] login.initConfig done, msf=' + login.getMsfStatus())
      S.loginInited = true
    } catch (e) { w('[qq] login.initConfig THREW ' + e.message) }
  }

  // ---------- 1.5) 先建 StartupSessionWrapper，再拿 session 壳 ----------
  // NapCat 的顺序是：StartupSessionWrapper.create() 在前，getNTWrapperSession('nt_1') 在后。
  // 反过来的话 getNTWrapperSession 一直 undefined（纯 shell 模式就是这个坑）。
  if (!S.startup) {
    try {
      S.startup = wmod.NodeIQQNTStartupSessionWrapper.create()
      w('[qq] startup wrapper created (early)')
    } catch (e) { w('[qq] startup create early THREW ' + e.message) }
  }
  if (!S.session) {
    try {
      var pre = wmod.NodeIQQNTWrapperSession.getNTWrapperSession('nt_1')
      if (pre) { S.session = pre; w('[qq] pre-acquired session shell') }
      else w('[qq] pre-acquire: still undefined (startup=' + !!S.startup + ')')
    } catch (e) { w('[qq] pre-acquire THREW ' + e.message) }
  }
  // ---------- 2) 登录 ----------
  function startSession(info) {
    if (S.session && msgService()) return
    var uin = String(info.uin || '')
    var uid = String(info.uid || '')
    if (!uin || !uid) { w('[qq] startSession: missing uin/uid'); return }
    var session = null
    try { session = wmod.NodeIQQNTWrapperSession.getNTWrapperSession('nt_1') } catch (e) { w('[qq] getNTWrapperSession THREW ' + e.message) }
    if (!session) { w('[qq] no session yet, retry'); setTimeout(function () { startSession(info) }, 1500); return }
    S.session = session
    S.uin = uin
    S.uid = uid
    S.selfUid = uid

    var infoObj = {
      selfUin: uin, selfUid: uid,
      desktopPathConfig: { account_path: (CFG.accountPathMode === 'root' ? DATA_ROOT : path.join(DATA_ROOT, uin)) },
      clientVer: VER, a2: '', d2: '', d2Key: '', machineId: '',
      platform: 3, platVer: os.release(), appid: APPID,
      rdeliveryConfig: {
        appKey: '', systemId: 0, appId: '', logicEnvironment: '', platform: 3, language: '',
        sdkVersion: '', userId: '', appVersion: '', osVersion: '', bundleId: '', serverUrl: '',
        fixedAfterHitKeys: ['']
      },
      defaultFileDownloadPath: OWN + '\\temp',
      deviceInfo: {
        guid: login.getMachineGuid(), buildVer: VER, localId: 2052, devName: os.hostname(),
        devType: os.type(), vendorName: '', osVer: os.release(), vendorOsName: os.type(),
        setMute: false, vendorType: 0
      },
      deviceConfig: '{"appearance":{"isSplitViewMode":true},"msg":{}}'
    }

    try {
      session.init(infoObj,
        {
          onMSFStatusChange: function (a, b) { w('[qq] cb onMSFStatusChange ' + J([a, b])) },
          onMSFSsoError: function () { w('[qq] cb onMSFSsoError') },
          getGroupCode: function () { return '' }
        },
        {
          dispatchRequest: function () { return null },
          dispatchCall: function () { return null },
          dispatchCallWithJson: function () { return null }
        },
        {
          onNTSessionCreate: function () { w('[qq] cb onNTSessionCreate') },
          onGProSessionCreate: function () { },
          onSessionInitComplete: function (a) { w('[qq] cb onSessionInitComplete ' + J(a)); S.stage = 'ready' },
          onOpentelemetryInit: function (a) { w('[qq] cb onOpentelemetryInit ' + J(a)) },
          onUserOnlineResult: function (a) { w('[qq] cb onUserOnlineResult ' + J(a).slice(0, 200)) },
          onGetSelfTinyId: function () { w('[qq] cb onGetSelfTinyId') }
        })
      w('[qq] session.init called')
    } catch (e) { w('[qq] session.init THREW ' + e.message) }

    try {
      if (!S.startup) S.startup = wmod.NodeIQQNTStartupSessionWrapper.create()
      S.startup.start()
      w('[qq] startup.start called')
      // 看门狗：8s / 20s 还没 msgService 就再踹一脚
      setTimeout(function () {
        if (msgService()) return
        w('[qq] watchdog#1: no msgService, startNT(0)')
        try { S.session.startNT(0) } catch (e) { w('[qq] startNT err ' + e.message) }
      }, 8000)
      setTimeout(function () {
        if (msgService()) return
        w('[qq] watchdog#2: still nothing, startup.start() again')
        try { S.startup.start() } catch (e) { w('[qq] startup.start#2 err ' + e.message) }
        try { S.session.startNT(0) } catch (e) { }
      }, 20000)
    } catch (e) { w('[qq] startup THREW ' + e.message) }
    S.stage = 'session-starting'
  }

  function registerLoginListener() {
    if (S.loginListenerVer !== 'v3') {
      S.loginListenerVer = 'v3'
      try { if (S.loginListener) login.removeKernelLoginListener(S.loginListener) } catch (e) { }
      S.loginListener = {
        onLoginConnected: function () { w('[qq] login cb connected') },
        onLoginConnecting: function () { },
        onLoginDisConnected: function () { w('[qq] login cb disconnected') },
        onQRCodeGetPicture: function (d) {
          try {
            var url = d && (d.qrcodeUrl || d.url)
            var b64 = d && (d.pngBase64QrcodeData || d.pngBase64)
            S.qrUrl = url || null
            S.qrAt = Date.now()
            w('[qq] QR url=' + String(url).slice(0, 120))
            if (b64) {
              fs.writeFileSync(WS + '\\qq-qr-login.png', Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64'))
              w('[qq] QR saved (raw)')
            }
            // 自己用 python 重新编码一张高清二维码，页面那边直接看这个文件
            try {
              var cp = p.mainModule.require('child_process')
              fs.writeFileSync(WS + '\\qq-qr-url.txt', String(url || ''))
              cp.execFile('python', [WS + '\\make-qr.py', String(url || ''), WS + '\\qq-qr-fresh.png'], function (err) {
                if (err) w('[qq] render qr err ' + err.message)
                else w('[qq] QR rendered (crisp) ' + (Date.now() - S.qrAt) + 'ms')
              })
            } catch (e) { w('[qq] spawn python err ' + e.message) }

          } catch (e) { w('[qq] qr cb err ' + e.message) }
        },
        onQRCodeLoginPollingStarted: function () { },
        onQRCodeSessionUserScaned: function () { w('[qq] login cb scanned') },
        onQRCodeLoginSucceed: function (info) {
          w('[qq] login cb succeed ' + J(info).slice(0, 200))
          S.uin = String(info.uin || '')
          S.uid = String(info.uid || '')
          startSession(info)
        },
        onQRCodeLoginFail: function (e) { w('[qq] login cb qr fail ' + J(e)) },
        onQRCodeSessionFailed: function (a, b) { w('[qq] login cb onQRCodeSessionFailed type=' + J(a) + ' code=' + J(b)) },
        onUserLoggedIn: function (u) { w('[qq] login cb onUserLoggedIn ' + J(u)) },
        onLogoutSucceed: function () { w('[qq] login cb logout') },
        onLoginFailed: function (e) { w('[qq] login cb loginFailed ' + J(e)) }
      }
      try { login.addKernelLoginListener(S.loginListener) } catch (e) { w('[qq] addKernelLoginListener THREW ' + e.message) }
    }
  }

  function requestQR() {
    registerLoginListener()
    try { (S.realLogin ? S.realLogin.connect : login.connect)(); w('[qq] login.connect()') } catch (e) { w('[qq] connect THREW ' + e.message) }
  }

  function tryQuickLogin() {
    try {
      login.getLoginList().then(function (r) {
        var list = (r && r.LocalLoginInfoList) || []
        var hit = null
        for (var i = 0; i < list.length; i++) if (String(list[i].uin) === QUICK_UIN) { hit = list[i]; break }
        if (!hit) { w('[qq] quickLogin: ' + QUICK_UIN + ' not in list'); requestQR(); return }
        w('[qq] quickLogin trying ' + hit.uin + ' uid=' + hit.uid)
        (S.realLogin ? S.realLogin.quickLoginWithUin : login.quickLoginWithUin)(hit.uin).then(function (u) {
          w('[qq] quickLogin result=' + J(u).slice(0, 200))
          if (u && String(u.result) === '0' && !(u.loginErrorInfo && u.loginErrorInfo.errMsg)) {
            startSession({ uin: hit.uin, uid: hit.uid })
          } else { requestQR() }
        }).catch(function (e) { w('[qq] quickLogin err ' + e.message); requestQR() })
      }).catch(function (e) { w('[qq] getLoginList err ' + e.message); requestQR() })
    } catch (e) { w('[qq] tryQuickLogin THREW ' + e.message); requestQR() }
  }

  registerLoginListener()
  if ((!S.session || !msgService()) && CFG.autoLogin !== false) {
    if (!S.qrRequested) { S.qrRequested = true; S.stage = 'login'; tryQuickLogin() }
  }

  // ---------- 2.5) 二维码自动换新 ----------
  if (!S.qrKeeper) {
    S.qrKeeper = setInterval(function () {
      try {
        if (msgService()) return
        var age = S.qrAt ? (Date.now() - S.qrAt) : 1e9
        if (age < 45000) return
        w('[qq] qr keeper: age=' + Math.round(age / 1000) + 's, request new QR')
        ;(S.realLogin ? S.realLogin.getQRCodePicture : login.getQRCodePicture)()
      } catch (e) { w('[qq] qr keeper err ' + e.message) }
    }, 10000)
    w('[qq] qr keeper ON')
  }
  // ---------- 3) 消息监听 ----------
  global.__qqListenerVer = LISTENER_VER
  /** 把 addKernelMsgListener 包一层：只接收「当前版本」的监听器。
   *  旧 eval 留下的僵尸定时器每 10 秒会把旧监听器再注册回来（QQ 会给新监听器回放最近消息 → 同一条刷十几遍） */
  function installListenerGuard() {
    try {
      var s = msgService()
      if (!s || s.__qqGuard) return
      var origAdd = s.addKernelMsgListener
      var origRm = s.removeKernelMsgListener
      s.addKernelMsgListener = function (l) {
        if (!l || l.__qqVer !== global.__qqListenerVer) { w('[qq] 拒绝旧监听器 ' + (l && l.__qqVer)); return }
        return origAdd.call(s, l)
      }
      s.removeKernelMsgListener = function (l) { try { return origRm.call(s, l) } catch (e) { } }
      s.__qqGuard = true
      w('[qq] listener guard installed')
    } catch (e) { w('[qq] listener guard err ' + e.message) }
  }
  function ensureMsgListener() {
  if (S.session && msgService() && S.listenerVer !== LISTENER_VER) {
    try {
      try {
        // 之前注册过的监听器全部摘掉（只记住最后一个的话，旧的那份还会重复回调）
        S.msgListeners = S.msgListeners || []
        if (S.msgListener) S.msgListeners.push(S.msgListener)
        S.msgListeners.forEach(function (l) { try { msgService().removeKernelMsgListener(l) } catch (e) { } })
        S.msgListeners = []
      } catch (e) { }
      installListenerGuard()
      S.listenerVer = LISTENER_VER
      S.msgListener = {
        __qqVer: LISTENER_VER,
        onRecvMsg: function (arr) { (arr || []).forEach(onOneMsg) },
        onAddSendMsg: function (m) { w('[qq] SENT-LOCAL msgId=' + m.msgId + ' status=' + m.sendStatus) },
        onMsgInfoListUpdate: function () { },
        onRichMediaDownloadComplete: function (d) { w('[qq] cb onRichMediaDownloadComplete ' + J(d).slice(0, 300)); onDownloadComplete(d) },
        onRichMediaProgressUpdate: function (d) { w('[qq] cb onRichMediaProgressUpdate ' + J(d).slice(0, 200)) },
        onMsgError: function (e) { w('[qq] cb onMsgError ' + J(e).slice(0, 200)) }
      }
      msgService().addKernelMsgListener(S.msgListener)
      S.msgListeners = [S.msgListener]
      w('[qq] msg listener added (' + LISTENER_VER + ')')
    } catch (e) { w('[qq] addKernelMsgListener THREW ' + e.message) }
  }
  }
  ensureMsgListener()
  // 旧 eval 的 onOneMsg 引用的这两个函数可能不在它自己的作用域里 → 兜到全局，免得每次回调都 ReferenceError
  try { global.ensurePttTranscribed = ensurePttTranscribed; global.ensurePicDownloaded = ensurePicDownloaded } catch (e) { }
  if (!S.ensureTimer) {
    global.__qqEnsureMsgListener = ensureMsgListener
    S.ensureTimer = setInterval(function () { try { if (global.__qqEnsureMsgListener) global.__qqEnsureMsgListener() } catch (e) { } }, 10000)
    w('[qq] ensure-msg-listener timer ON')
  }

  /** 收到图片就顺手落到工作区（QQ 有时自己下好，有时得我们拉） */
  /** 语音转文字：translatePtt2Text 是异步的，要轮询等消息上的 pttElement.text 出现 */
  function transcribePtt(msgId, peer, maxTries) {
    return new Promise(function (resolve) {
      try {
        var s9 = msgService()
        if (!s9) return resolve('')
        var findEl = function (list) {
          for (var i = 0; i < list.length; i++) {
            if (String(list[i].msgId) !== String(msgId)) continue
            var els = list[i].elements || []
            for (var j = 0; j < els.length; j++) if (els[j].elementType === 4) return els[j]
          }
          return null
        }
        s9.getAioFirstViewLatestMsgs(peer, 60).then(function (x) {
          var list = (x && (x.msgList || x.msg_list)) || []
          var el = findEl(list)
          if (!el) return resolve('')
          var tries = 0
          var poll = function () {
            tries++
            s9.getAioFirstViewLatestMsgs(peer, 60).then(function (y) {
              var list2 = (y && (y.msgList || y.msg_list)) || []
              var el2 = findEl(list2)
              var t = el2 && el2.pttElement && el2.pttElement.text
              if (t) return resolve(t)
              if (tries >= (maxTries || 8)) return resolve('')
              setTimeout(poll, 1200)
            }).catch(function () { resolve('') })
          }
          s9.translatePtt2Text(String(msgId), peer, el).then(function () { setTimeout(poll, 1200) }).catch(function () { resolve('') })
        }).catch(function () { resolve('') })
      } catch (e) { resolve('') }
    })
  }

  /** 收到语音就顺手转成文字，转完往收件箱补一条（插件会转发给会话） */
  function ensurePttTranscribed(evt) {
    try {
      var el = (evt.elements || []).filter(function (e) { return e.type === 4 && e.ptt })[0]
      if (!el) return
      var peer = { chatType: evt.chatType, peerUid: evt.peerUid, guildId: '' }
      transcribePtt(evt.msgId, peer, 8).then(function (text) {
        if (!text) { w('[qq] 语音没转出文字 ' + evt.msgId); return }
        el.ptt.text = text
        w('[qq] 语音转写 ' + evt.msgId + ' -> ' + J(text))
        S.inbox.push({
          time: Date.now(), chatType: evt.chatType, peerUid: evt.peerUid, senderUid: evt.senderUid,
          senderName: evt.senderName || '', msgId: evt.msgId + '-asr', msgSeq: evt.msgSeq,
          text: '（语音转写）' + text, elements: [{ type: 1, text: '（语音转写）' + text }]
        })
      })
    } catch (e) { w('[qq] ensurePttTranscribed err ' + e.message) }
  }

  function ensurePicDownloaded(evt) {
    try {
      (evt.elements || []).forEach(function (el) {
        if (el.type !== 2 || !el.pic) return
        var dir0 = WS + '\\qq-media'
        try { fs.mkdirSync(dir0, { recursive: true }) } catch (e) { }
        var ext0 = (String(el.pic.fileName || '').match(/\.[a-z0-9]+$/i) || ['.png'])[0]
        var out0 = dir0 + '\\' + evt.msgId + '_' + (el.id || '0') + ext0
        if (el.pic.sourcePath) {
          try { fs.copyFileSync(el.pic.sourcePath, out0); el.pic.localPath = out0 } catch (e) { el.pic.localPath = el.pic.sourcePath }
          return
        }
        if (!el.id) return
        downloadMedia({ msgId: evt.msgId, chatType: evt.chatType, peerUid: evt.peerUid, elementId: el.id, filePath: '' }, 45000)
          .then(function (d) {
            var fp = d && d.filePath
            if (!fp) return
            el.pic.sourcePath = fp
            try { fs.copyFileSync(fp, out0); el.pic.localPath = out0 } catch (e) { el.pic.localPath = fp }
            w('[qq] 图片已落盘 ' + el.pic.localPath)
          })
          .catch(function (e) { w('[qq] 图片下载失败 ' + evt.msgId + ': ' + e.message) })
      })
    } catch (e) { w('[qq] ensurePicDownloaded err ' + e.message) }
  }
  function onOneMsg(m) {
    try {
      var evt = {
        time: Date.now(), chatType: m.chatType, peerUid: m.peerUid, senderUid: m.senderUid,
        senderName: m.sendMemberName || m.sendNickName || '', msgId: m.msgId, msgSeq: m.msgSeq,
        text: (m.elements || []).filter(function (e) { return e.textElement }).map(function (e) { return e.textElement.content }).join(''),
        elements: (m.elements || []).map(function (el) {
          var o = { type: el.elementType, id: el.elementId }
          try {
            if (el.textElement) o.text = el.textElement.content
            if (el.picElement) o.pic = {
              fileName: el.picElement.fileName, fileSize: el.picElement.fileSize,
              sourcePath: el.picElement.sourcePath, thumbPath: el.picElement.thumbPath,
              width: el.picElement.picWidth, height: el.picElement.picHeight,
              md5: el.picElement.md5HexStr, picType: el.picElement.picType,
              fileUuid: el.picElement.fileUuid, transferStatus: el.picElement.transferStatus
            }
            if (el.pttElement) o.ptt = { fileName: el.pttElement.fileName, filePath: el.pttElement.filePath, duration: el.pttElement.duration, fileSize: el.pttElement.fileSize, md5: el.pttElement.md5HexStr }
            if (el.videoElement) o.video = { fileName: el.videoElement.fileName, filePath: el.videoElement.filePath, duration: el.videoElement.duration, fileSize: el.videoElement.fileSize }
            if (el.faceElement) o.face = { faceIndex: el.faceElement.faceIndex, faceText: el.faceElement.faceText }
            if (el.marketFaceElement) o.mface = { faceId: el.marketFaceElement.faceId, emojiId: el.marketFaceElement.emojiId }
            if (el.atElement) o.at = { atNtUid: el.atElement.atNtUid, atUid: el.atElement.atUid, atTinyId: el.atElement.atTinyId }
            if (el.replyElement) o.reply = { sourceMsgIdInRecords: el.replyElement.sourceMsgIdInRecords }
            if (el.fileElement) o.file = {
              fileName: el.fileElement.fileName, fileSize: el.fileElement.fileSize,
              filePath: el.fileElement.filePath, fileUuid: el.fileElement.fileUuid,
              subElementType: el.fileElement.subElementType, transferStatus: el.fileElement.transferStatus
            }
          } catch (e) { }
          return o
        })
      }
      // 同一条消息会多次回调（元素逐步补全）：按 msgId 覆盖，保留最后一份
      var dup = -1
      for (var i = S.inbox.length - 1; i >= 0; i--) { if (S.inbox[i].msgId === m.msgId) { dup = i; break } }
      if (dup >= 0) S.inbox[dup] = evt
      else {
        S.inbox.push(evt)
        if (S.inbox.length > 500) S.inbox = S.inbox.slice(-500)
      }
      ensurePicDownloaded(evt)
      ensurePttTranscribed(evt)
      w('[qq] RECV ct=' + evt.chatType + ' peer=' + evt.peerUid + ' seq=' + evt.msgSeq +
        ' text=' + J(evt.text) + ' types=' + J(evt.elements.map(function (e) { return e.type })))
    } catch (e) { w('[qq] onOneMsg err ' + e.message) }
  }

  // ---------- 4) 本地 HTTP ----------
  // 下载富媒体：等 onRichMediaDownloadComplete 回调
  function onDownloadComplete(d) {
    try {
      var key = d && d.msgElementId
      w('[qq] download complete key=' + key + ' path=' + (d && (d.filePath || d.fileName)))
      S.pendingDownloads = S.pendingDownloads || {}
      if (key && S.pendingDownloads[key]) {
        var cb = S.pendingDownloads[key]
        delete S.pendingDownloads[key]
        cb(d)
      }
    } catch (e) { w('[qq] onDownloadComplete err ' + e.message) }
  }

  function downloadMedia(opt, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var s = msgService()
      if (!s) return reject(new Error('no msgService'))
      S.pendingDownloads = S.pendingDownloads || {}
      var timer = setTimeout(function () {
        delete S.pendingDownloads[opt.elementId]
        reject(new Error('download timeout'))
      }, timeoutMs || 30000)
      S.pendingDownloads[opt.elementId] = function (d) {
        clearTimeout(timer)
        resolve(d)
      }
      try {
        var ret = s.downloadRichMedia({
          fileModelId: '0', downSourceType: 0, downloadSourceType: 0, triggerType: 1,
          msgId: opt.msgId, chatType: opt.chatType || 1, peerUid: opt.peerUid,
          elementId: opt.elementId, thumbSize: 0, downloadType: 1, filePath: opt.filePath || ''
        })
        w('[qq] downloadRichMedia ret=' + J(ret).slice(0, 200))
        if (ret && ret.then) {
          ret.then(function (x) { w('[qq] downloadRichMedia resolved ' + J(x).slice(0, 300)) })
            .catch(function (e) { w('[qq] downloadRichMedia rejected ' + e.message) })
        }
      } catch (e) {
        w('[qq] downloadRichMedia THREW ' + e.message)
        clearTimeout(timer)
        delete S.pendingDownloads[opt.elementId]
        reject(e)
      }
    })
  }

  // 图片尺寸：PNG / JPEG 头部直接读，读不出来就当 0（QQ 也能发）
  function imageDims(buf) {
    try {
      if (buf.length > 24 && buf.slice(1, 4).toString('latin1') === 'PNG') {
        return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
      }
      if (buf[0] === 0xFF && buf[1] === 0xD8) {
        let o = 2
        while (o + 9 < buf.length) {
          if (buf[o] !== 0xFF) { o++; continue }
          const m = buf[o + 1]
          const len = buf.readUInt16BE(o + 2)
          if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
            return { w: buf.readUInt16BE(o + 7), h: buf.readUInt16BE(o + 5) }
          }
          o += 2 + len
        }
      }
    } catch (e) { }
    return { w: 0, h: 0 }
  }

  /** 发本地图片：把文件塞进 QQ 的发送目录，再按 picElement 发出去 */
  function sendPictureInternal(peerUid, chatType, filePath) {
    var s = msgService()
    if (!s) throw new Error('no msgService')
    var crypto = p.mainModule.require('crypto')
    var buf = fs.readFileSync(filePath)
    var md5 = crypto.createHash('md5').update(buf).digest('hex')
    var name = require_basename(filePath)
    var dims = imageDims(buf)
    var target = s.getRichMediaFilePathForMobileQQSend({
      md5HexStr: md5, fileName: name, elementType: 2, elementSubType: 0,
      thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: ''
    })
    if (!target) throw new Error('getRichMediaFilePathForMobileQQSend 没给路径')
    try { fs.mkdirSync(p.mainModule.require('path').dirname(target), { recursive: true }) } catch (e) { }
    fs.copyFileSync(filePath, target)
    var elem = {
      elementType: 2, elementId: '', elementGroupId: 0,
      picElement: {
        fileSize: String(buf.length), fileName: name, sourcePath: target,
        original: true, picWidth: dims.w, picHeight: dims.h,
        md5HexStr: md5, fileUuid: '', fileSubId: '', summary: '[图片]',
        picType: 1000, thumbPath: new Map(), thumbFileSize: 0, originImageMd5: ''
      }
    }
    w('[qq] sendPicture md5=' + md5 + ' size=' + buf.length + ' dims=' + dims.w + 'x' + dims.h + ' -> ' + target)
    return s.sendMsg('0', { chatType: chatType || 1, peerUid: peerUid, guildId: '' }, [elem], new Map())
  }

  function require_basename(p2) {
    try { return p.mainModule.require('path').basename(p2) } catch (e) { return 'image.png' }
  }
  /** 组一条 @ 元素（群里 @ 人用；atType 2 = 指定一个人） */
  function atElement(uid, nick, atType) {
    return {
      elementType: 1, elementId: '',
      textElement: {
        content: '@' + (nick || ''),
        atType: atType || 2,
        atUid: '',
        atTinyId: '',
        atNtUid: uid
      }
    }
  }

  function sendMsgInternal(peerUid, chatType, elementsOrText, atUid, atNick) {
    var s = msgService()
    if (!s) throw new Error('no msgService')
    var peer = { chatType: chatType || 1, peerUid: peerUid, guildId: '' }
    var elems = Array.isArray(elementsOrText) ? elementsOrText
      : [{ elementType: 1, elementId: '', textElement: { content: String(elementsOrText || ''), atType: 0, atUid: '', atTinyId: '', atNtUid: '' } }]
    if (atUid) elems.unshift(atElement(atUid, atNick || '', 2))
    return s.sendMsg('0', peer, elems, new Map())
  }

  // 服务器只创建一次；handler 每次热重载替换（避免端口被旧实例占着）
  if (S.httpPort !== PORT) {
    try { if (S.httpSrv) { S.httpSrv.close(); S.httpSrv = null } } catch (e) { }
    try {
      var http = p.mainModule.require('http')
      var srv = http.createServer(function (req, res) {
        try { if (S.httpHandler) return S.httpHandler(req, res) } catch (e) { w('[qq] http handler err ' + e.message) }
        try { res.writeHead(500); res.end('no handler') } catch (e) { }
      })
      srv.on('error', function (e) { w('[qq] http err ' + e.message) })
      srv.listen(PORT, '127.0.0.1', function () { w('[qq] http on 127.0.0.1:' + PORT) })
      S.httpSrv = srv
      S.httpPort = PORT
    } catch (e) { w('[qq] http THREW ' + e.message) }
  }

  S.httpHandler = function (req, res) {
        var url = req.url || '/'
        function reply(code, obj) {
          var body = J(obj)
          try {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
            res.end(body)
          } catch (e) { }
        }
        function qs() {
          var q = {}
          try {
            (url.split('?')[1] || '').split('&').forEach(function (kv) {
              var a = kv.split('=')
              if (a[0]) q[a[0]] = decodeURIComponent(a[1] || '')
            })
          } catch (e) { }
          return q
        }

        if (url.indexOf('/status') === 0) {
          return reply(200, { ok: true, stage: S.stage, uin: S.uin || null, session: !!S.session, ms: !!msgService(), inbox: S.inbox.length, qr: !!S.qrUrl, qrAge: S.qrAt ? Math.round((Date.now() - S.qrAt) / 1000) : null })
        }
        if (url.indexOf('/events') === 0) {
          var since = parseInt(qs().since || '0', 10) || 0
          return reply(200, { ok: true, next: S.inbox.length, events: S.inbox.slice(since) })
        }
        if (url.indexOf('/qr') === 0) {
          S.qrRequested = true
          try { (S.realLogin ? S.realLogin.getQRCodePicture : login.getQRCodePicture)() } catch (e) { }
          return reply(200, { ok: true, qrUrl: S.qrUrl })
        }
        if (url.indexOf('/quicklogin') === 0) {
          try {
            var qq2 = qs()
            ;(S.realLogin ? S.realLogin.quickLoginWithUin : login.quickLoginWithUin)(qq2.uin || QUICK_UIN).then(function (u) {
              w('[qq] /quicklogin -> ' + J(u).slice(0, 300))
              reply(200, { ok: !!(u && String(u.result) === '0'), result: u })
            }).catch(function (e) { reply(500, { ok: false, err: e.message }) })
          } catch (e) { reply(500, { ok: false, err: e.message }) }
          return
        }        if (url.indexOf('/loginlist') === 0) {
          try {
            login.getLoginList().then(function (r) {
              var list = (r && r.LocalLoginInfoList) || []
              reply(200, { ok: true, list: list.map(function (o) { return { uin: o.uin, uid: o.uid, nick: o.nickName, isUserLogin: o.isUserLogin } }) })
            }).catch(function (e) { reply(500, { ok: false, err: e.message }) })
          } catch (e) { reply(500, { ok: false, err: e.message }) }
          return
        }
        if (url.indexOf('/reboot') === 0) {
          // 关掉旧 session 再重新拿一个（登录已经完成的情况下用）
          var r4 = {}
          try { if (S.session) { S.session.close(); r4.closed = true } } catch (e) { r4.closeErr = e.message }
          try {
            var s2 = wmod.NodeIQQNTWrapperSession.getNTWrapperSession('nt_1')
            r4.got = s2 ? 'object' : 'undefined'
            if (s2) { S.session = s2; r4.msgServiceBeforeInit = !!s2.getMsgService() }
          } catch (e) { r4.getErr = e.message }
          try { startSession({ uin: qs().uin || '3793339506', uid: qs().uid || 'u_BsJrCaYeH77_OZ78H5pEXA' }); r4.init = 'called' } catch (e) { r4.initErr = e.message }
          return reply(200, { ok: true, result: r4 })
        }        if (url.indexOf('/win') === 0) {
          // 把 QQ 自己的登录窗口藏起来，避免它抢着申请二维码把我们的作废
          var info = []
          try {
            var el = p.mainModule.require('electron')
            var wins = el.BrowserWindow.getAllWindows()
            wins.forEach(function (w2, idx) {
              var t = ''
              try { t = w2.getTitle() } catch (e) { }
              info.push(idx + ':' + t + ':' + (w2.isVisible() ? 'vis' : 'hid'))
              if (qs().hide) { try { w2.hide() } catch (e) { } }
              if (qs().destroy) { try { w2.destroy() } catch (e) { } }
            })
          } catch (e) { info.push('ERR ' + e.message) }
          return reply(200, { ok: true, windows: info })
        }        if (url.indexOf('/diag') === 0) {
          var out3 = {}
          try { out3.loginMsf = login.getMsfStatus() } catch (e) { out3.loginMsf = 'err ' + e.message }
          try {
            var msfSvc = S.session.getMSFService()
            out3.msfSvc = msfSvc ? Object.getOwnPropertyNames(Object.getPrototypeOf(msfSvc)).join(',') : 'null'
            try { out3.serverTime = msfSvc.getServerTime() } catch (e) { out3.serverTime = 'err ' + e.message }
            try { out3.msfStatus2 = msfSvc.getMsfStatus ? msfSvc.getMsfStatus() : 'n/a' } catch (e) { out3.msfStatus2 = 'err ' + e.message }
          } catch (e) { out3.msfSvc = 'err ' + e.message }
          try { out3.sessionId = S.session.getSessionId() } catch (e) { }
          try { out3.stage = S.stage } catch (e) { }
          if (qs().startnt) {
            try { var sn = S.session.startNT(0); out3.startNT = J(sn) } catch (e) { out3.startNT = 'err ' + e.message }
            try { var sn2 = S.session.startNT(); out3.startNT2 = J(sn2) } catch (e) { out3.startNT2 = 'err ' + e.message }
          }
          if (qs().online) {
            try { S.session.onLine(); out3.onLine = 'called' } catch (e) { out3.onLine = 'err ' + e.message }
          }
          return reply(200, { ok: true, diag: out3 })
        }
        if (url.indexOf('/boot') === 0) {
          try {
            var q1 = qs()
            if (q1.uin && q1.uid) { startSession({ uin: q1.uin, uid: q1.uid }); return reply(200, { ok: true, started: q1.uin }) }
            login.getLoginList().then(function (r) {
              var list = (r && r.LocalLoginInfoList) || []
              var hit = null
              for (var i = 0; i < list.length; i++) if (list[i].isUserLogin) { hit = list[i]; break }
              if (!hit && list.length) hit = list[0]
              if (!hit) { reply(404, { ok: false, err: 'no login info' }); return }
              w('[qq] /boot using ' + hit.uin + ' isUserLogin=' + hit.isUserLogin)
              startSession({ uin: hit.uin, uid: hit.uid })
              reply(200, { ok: true, started: hit.uin, isUserLogin: hit.isUserLogin })
            }).catch(function (e) { reply(500, { ok: false, err: e.message }) })
          } catch (e) { reply(500, { ok: false, err: e.message }) }
          return
        }
        if (url.indexOf('/send') === 0 && req.method === 'POST') {
          var chunks = []
          req.on('data', function (c) { chunks.push(c) })
          req.on('end', function () {
            var payload = {}
            try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch (e) { }
            try {
              var r = sendMsgInternal(payload.peerUid || payload.to, payload.chatType || 1, payload.elements || payload.text, payload.at || '', payload.atNick || '')
              w('[qq] http send -> ' + (payload.peerUid || payload.to) + ' text=' + J(payload.text))
              if (r && r.then) r.then(function (x) { reply(200, { ok: true, result: x }) }).catch(function (e) { reply(500, { ok: false, err: e.message }) })
              else reply(200, { ok: true, result: r })
            } catch (e) { reply(500, { ok: false, err: e.message }) }
          })
          return
        }
        if (url.indexOf('/ptt') === 0) {
          var qq3 = qs()
          var peer3 = { chatType: parseInt(qq3.chatType || '1', 10), peerUid: qq3.peerUid, guildId: '' }
          try {
            var s7 = msgService()
            var findPtt = function (list, id) {
              for (var i = 0; i < list.length; i++) {
                if (String(list[i].msgId) !== String(id)) continue
                var els = list[i].elements || []
                for (var j = 0; j < els.length; j++) if (els[j].elementType === 4) return els[j]
              }
              return null
            }
            s7.getAioFirstViewLatestMsgs(peer3, 60).then(function (x) {
              var list = (x && (x.msgList || x.msg_list)) || []
              var el = findPtt(list, qq3.msgId)
              if (!el) { reply(404, { ok: false, err: '这条消息里没找到语音' }); return }
              // translatePtt2Text 是异步的：调完过一会儿消息上的 pttElement.text 才有值，
              // 所以要轮询几次（实测第一次调返回空、第二次就有字了）
              var tries2 = 0
              var poll2 = function () {
                tries2++
                s7.getAioFirstViewLatestMsgs(peer3, 60).then(function (y) {
                  var list2 = (y && (y.msgList || y.msg_list)) || []
                  var el2 = findPtt(list2, qq3.msgId)
                  var text = el2 && el2.pttElement && el2.pttElement.text
                  if (text) { w('[qq] ptt translate ' + qq3.msgId + ' -> ' + J(text)); reply(200, { ok: true, text: text }); return }
                  if (tries2 >= 8) { reply(200, { ok: true, text: '' }); return }
                  setTimeout(poll2, 1200)
                }).catch(function (e) { reply(500, { ok: false, err: e.message }) })
              }
              s7.translatePtt2Text(String(qq3.msgId), peer3, el).then(function () { setTimeout(poll2, 1200) })
                .catch(function (e) { reply(500, { ok: false, err: 'translate: ' + e.message }) })
            }).catch(function (e) { reply(500, { ok: false, err: e.message }) })
          } catch (e) { reply(500, { ok: false, err: e.message }) }
          return
        }        if (url.indexOf('/history') === 0) {
          var qh = qs()
          var peer = { chatType: parseInt(qh.chatType || '1', 10), peerUid: qh.peerUid, guildId: '' }
          var cnt = Math.min(100, Math.max(1, parseInt(qh.count || '20', 10)))
          try {
            var s6 = msgService()
            var pr
            if (qh.seq) {
              pr = s6.getMsgsBySeqAndCount(peer, String(qh.seq), cnt, true, true)
            } else if (qh.api === 'latest') {
              pr = s6.getLatestDbMsgs(peer, cnt)
            } else {
              pr = s6.getAioFirstViewLatestMsgs(peer, cnt)
            }
            pr.then(function (x) {
              var list = (x && (x.msgList || x.msg_list)) || []
              var brief = list.map(function (m) {
                return {
                  msgId: m.msgId, msgSeq: m.msgSeq, time: Number(m.msgTime) * 1000,
                  senderUid: m.senderUid, senderName: m.sendMemberName || m.sendNickName || '',
                  text: (m.elements || []).filter(function (e) { return e.textElement }).map(function (e) { return e.textElement.content }).join(''),
                  types: (m.elements || []).map(function (e) { return e.elementType })
                }
              })
              reply(200, { ok: true, count: brief.length, messages: brief })
            }).catch(function (e) { reply(500, { ok: false, err: e.message }) })
          } catch (e) { reply(500, { ok: false, err: e.message }) }
          return
        }        if (url.indexOf('/sendpic') === 0) {
          var qp = qs()
          try {
            var r5 = sendPictureInternal(qp.peerUid || qp.to, parseInt(qp.chatType || '1', 10), qp.path)
            w('[qq] http sendpic -> ' + (qp.peerUid || qp.to) + ' ' + qp.path)
            if (r5 && r5.then) r5.then(function (x) { reply(200, { ok: true, result: x }) }).catch(function (e) { reply(500, { ok: false, err: e.message }) })
            else reply(200, { ok: true, result: r5 })
          } catch (e) { reply(500, { ok: false, err: e.message }) }
          return
        }        if (url.indexOf('/sendfile') === 0) {
          var qf = qs()
          try {
            var r6 = sendFileInternal(qf.peerUid || qf.to, parseInt(qf.chatType || '1', 10), qf.path)
            w('[qq] http sendfile -> ' + (qf.peerUid || qf.to) + ' ' + qf.path)
            if (r6 && r6.then) r6.then(function (x) { reply(200, { ok: true, result: Js(x) }) }).catch(function (e) { reply(500, { ok: false, err: e.message }) })
            else reply(200, { ok: true, result: r6 })
          } catch (e) { reply(500, { ok: false, err: e.message }) }
          return
        }        if (url.indexOf('/raw') === 0) {
          // 把某条消息的原始元素结构 dump 出来（看 replyElement / fileElement 到底长什么样）
          var qr = qs()
          var peerR = { chatType: parseInt(qr.chatType || '1', 10), peerUid: qr.peerUid, guildId: '' }
          try {
            var s8 = msgService()
            var pr8 = qr.msgId ? s8.getMsgsByMsgId(peerR, [String(qr.msgId)]) : s8.getAioFirstViewLatestMsgs(peerR, parseInt(qr.count || '5', 10))
            pr8.then(function (x) {
              var list = (x && (x.msgList || x.msg_list)) || (Array.isArray(x) ? x : [])
              if (qr.msgId && !list.length) list = []
              reply(200, {
                ok: true, count: list.length,
                messages: list.map(function (m) {
                  return {
                    msgId: m.msgId, msgSeq: m.msgSeq, msgTime: m.msgTime, chatType: m.chatType,
                    peerUid: m.peerUid, senderUid: m.senderUid, sendNickName: m.sendNickName, sendMemberName: m.sendMemberName,
                    elements: Js(m.elements)
                  }
                })
              })
            }).catch(function (e) { reply(500, { ok: false, err: e.message }) })
          } catch (e) { reply(500, { ok: false, err: e.message }) }
          return
        }        if (url.indexOf('/reply') === 0) {
          // 引用回复：字段名是内核里那个拼错的 replayMsgId / replayMsgSeq，
          // 还要带 replyMsgTime / senderUin / senderUidStr / replyMsgClientSeq —— 少一个就不挂引用块
          var q7 = qs()
          try {
            var s11 = msgService()
            var peer7 = { chatType: parseInt(q7.chatType || '1', 10), peerUid: q7.peerUid, guildId: '' }
            var sendReply = function (tgt) {
              var seq7 = String(q7.seq || q7.msgSeq || (tgt && tgt.msgSeq) || '0')
              var t = q7.time || (tgt && tgt.msgTime) || Math.floor(Date.now() / 1000)
              var rElems = [{
                elementType: 7, elementId: '',
                replyElement: {
                  replayMsgId: String(q7.msgId || (tgt && tgt.msgId) || ''),
                  replayMsgSeq: seq7,
                  replyMsgTime: String(t),
                  senderUin: String(q7.senderUin || (tgt && tgt.senderUin) || '0'),
                  senderUidStr: q7.senderUid || (tgt && tgt.senderUid) || '',
                  replyMsgClientSeq: seq7
                }
              }]
              if (q7.text) rElems.push({ elementType: 1, elementId: '', textElement: { content: String(q7.text), atType: 0, atUid: '', atTinyId: '', atNtUid: '' } })
              var r11 = s11.sendMsg('0', peer7, rElems, new Map())
              w('[qq] http reply -> ' + q7.peerUid + ' to msgId=' + (q7.msgId || (tgt && tgt.msgId)) + ' seq=' + seq7)
              if (r11 && r11.then) r11.then(function (x) { reply(200, { ok: true, result: Js(x) }) }).catch(function (e) { reply(500, { ok: false, err: e.message }) })
              else reply(200, { ok: true, result: r11 })
            }
            if (q7.seq && q7.senderUid) return sendReply(null)
            // 没给 seq/发送者 → 自己把目标消息查出来（qq_reply 工具只传 chat + msgId 就能用）
            var pr7 = q7.msgId ? s11.getMsgsByMsgId(peer7, [String(q7.msgId)])
              : s11.getAioFirstViewLatestMsgs(peer7, 20)
            pr7.then(function (x) {
              var list = (x && (x.msgList || x.msg_list)) || (Array.isArray(x) ? x : [])
              var tgt = null
              if (q7.msgId) { for (var i = 0; i < list.length; i++) if (String(list[i].msgId) === String(q7.msgId)) { tgt = list[i]; break } }
              else { for (var j = list.length - 1; j >= 0; j--) { if (String(list[j].senderUid) !== String(S.selfUid || '')) { tgt = list[j]; break } } }
              if (!tgt) return reply(404, { ok: false, err: '找不到要引用的那条消息' })
              sendReply(tgt)
            }).catch(function (e) { reply(500, { ok: false, err: e.message }) })
          } catch (e) { reply(500, { ok: false, err: e.message }) }
          return
        }        if (url.indexOf('/sendptt') === 0) {
          var qt = qs()
          try {
            var r7 = sendPttInternal(qt.peerUid || qt.to, parseInt(qt.chatType || '1', 10), qt.path, qt.duration)
            w('[qq] http sendptt -> ' + (qt.peerUid || qt.to) + ' ' + qt.path)
            if (r7 && r7.then) r7.then(function (x) { reply(200, { ok: true, result: Js(x) }) }).catch(function (e) { reply(500, { ok: false, err: e.message }) })
            else reply(200, { ok: true, result: r7 })
          } catch (e) { reply(500, { ok: false, err: e.message }) }
          return
        }        if (url.indexOf('/download') === 0) {
          var q0 = qs()
          var mediaDir = WS + '\\qq-media'
          try { fs.mkdirSync(mediaDir, { recursive: true }) } catch (e) { }
          var save = q0.save || ''
          downloadMedia({
            msgId: q0.msgId, chatType: parseInt(q0.chatType || '1', 10), peerUid: q0.peerUid,
            elementId: q0.elementId, filePath: save
          }, 60000).then(function (d) {
            var fp = d && (d.filePath || '')
            if (!fp) return reply(500, { ok: false, err: 'no filePath in callback', raw: d })
            var out2 = save
            if (!out2) {
              var ext = (fp.match(/\.[a-z0-9]+$/i) || [''])[0]
              out2 = mediaDir + '\\' + q0.msgId + '_' + q0.elementId + ext
              try { fs.copyFileSync(fp, out2) } catch (e) { out2 = fp }
            }
            reply(200, { ok: true, filePath: fp, savedAs: out2, raw: d })
          }).catch(function (e) { reply(500, { ok: false, err: e.message }) })
          return
        }
        if (url.indexOf('/svc') === 0) {
          try {
            var which = qs().which || 'richmedia'
            var svcMap = {
              richmedia: 'getRichMediaService', group: 'getGroupService', buddy: 'getBuddyService',
              recent: 'getRecentContactService', profile: 'getProfileService', avatar: 'getAvatarService',
              file: 'getFileAssistantService', msf: 'getMSFService', setting: 'getSettingService'
            }
            var fn = svcMap[which]
            var o = fn ? S.session[fn]() : null
            if (!o) return reply(404, { ok: false, err: 'no service ' + which })
            return reply(200, { ok: true, which: which, methods: Object.getOwnPropertyNames(Object.getPrototypeOf(o)) })
          } catch (e) { return reply(500, { ok: false, err: e.message }) }
        }
        if (url.indexOf('/buddy') === 0) {
          try {
            var bsvc = S.session.getBuddyService()
            var pb = bsvc.getBuddyListV2('0', true, 0)
            pb.then(function (x) {
              var groups = (x && x.data) || []
              var uids = []
              groups.forEach(function (g) { (g.buddyUids || []).forEach(function (u) { uids.push(u) }) })
              w('[qq] buddy list groups=' + groups.length + ' uids=' + uids.length)
              reply(200, { ok: true, count: uids.length, sample: uids.slice(0, 10), hasStar: uids.indexOf('u_VyRaaHm1qjSkW7EbHh62w') >= 0 })
            }).catch(function (e) { reply(500, { ok: false, err: e.message }) })
          } catch (e) { reply(500, { ok: false, err: e.message }) }
          return
        }        if (url.indexOf('/recent') === 0) {
          try {
            var rc = S.session.getRecentContactService()
            var pr = rc.getRecentContactListSnapShot(parseInt(qs().count || '20', 10))
            pr.then(function (x) { reply(200, { ok: true, result: x }) }).catch(function (e) { reply(500, { ok: false, err: e.message }) })
          } catch (e) { reply(500, { ok: false, err: e.message }) }
          return
        }
        return reply(404, { ok: false, err: 'not found ' + url })
  }

  /** 把内核对象转成能看懂的 JSON（Map / BigInt / 循环引用都处理掉） */
  function Js(o) {
    var seen = []
    function conv(v) {
      if (v === null || v === undefined) return v
      var t = typeof v
      if (t === 'bigint') return String(v)
      if (t === 'function') return '[fn]'
      if (t !== 'object') return v
      if (seen.indexOf(v) >= 0) return '[circular]'
      seen.push(v)
      try {
        if (v instanceof Map) { var m2 = {}; v.forEach(function (val, k) { m2[String(k)] = conv(val) }); return { __map: m2 } }
        if (Array.isArray(v)) return v.map(conv)
        if (typeof Uint8Array !== 'undefined' && v instanceof Uint8Array) return '[bytes ' + v.length + ']'
      } catch (e) { }
      var out = {}
      try { Object.keys(v).forEach(function (k) { try { out[k] = conv(v[k]) } catch (e) { out[k] = '[err]' } }) } catch (e) { }
      return out
    }
    return conv(o)
  }

  /** 发本地文件：照 NapCat 的做法——先把文件塞进 QQ 的发送目录，再发 fileElement{FILE=3}
   *  注意 elementType 必须 3（FILE），9 是 WALLET → 内核直接回 result=5 */
  function sendFileInternal(peerUid, chatType, filePath) {
    var s = msgService()
    if (!s) throw new Error('no msgService')
    var crypto = p.mainModule.require('crypto')
    var buf = fs.readFileSync(filePath)
    var md5 = crypto.createHash('md5').update(buf).digest('hex')
    var name = require_basename(filePath)
    var req = { md5HexStr: md5, fileName: name, elementType: 3, elementSubType: 0, thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: '' }
    var target = ''
    try { target = s.getRichMediaFilePathForMobileQQSend(req) } catch (e) { }
    if (!target) { try { target = s.getRichMediaFilePathForGuild(req) } catch (e) { } }
    if (!target) throw new Error('没拿到发送目录路径')
    try { fs.mkdirSync(p.mainModule.require('path').dirname(target), { recursive: true }) } catch (e) { }
    fs.copyFileSync(filePath, target)
    var elem = {
      elementType: 3, elementId: '',
      fileElement: { fileName: name, folderId: '', filePath: target, fileSize: String(buf.length) }
    }
    w('[qq] sendFile md5=' + md5 + ' size=' + buf.length + ' -> ' + target)
    return s.sendMsg('0', { chatType: chatType || 1, peerUid: peerUid, guildId: '' }, [elem], new Map())
  }

  /** 发语音：pttElement（FILE=4）。文件必须已经是 silk，塞进 QQ 的语音发送目录再发 */
  function sendPttInternal(peerUid, chatType, filePath, duration) {
    var s = msgService()
    if (!s) throw new Error('no msgService')
    var crypto = p.mainModule.require('crypto')
    var buf = fs.readFileSync(filePath)
    var md5 = crypto.createHash('md5').update(buf).digest('hex')
    var name = require_basename(filePath)
    var req = { md5HexStr: md5, fileName: name, elementType: 4, elementSubType: 0, thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: '' }
    var target = ''
    try { target = s.getRichMediaFilePathForMobileQQSend(req) } catch (e) { }
    if (!target) { try { target = s.getRichMediaFilePathForGuild(req) } catch (e) { } }
    if (!target) throw new Error('没拿到语音发送目录路径')
    try { fs.mkdirSync(p.mainModule.require('path').dirname(target), { recursive: true }) } catch (e) { }
    fs.copyFileSync(filePath, target)
    var elem = {
      elementType: 4, elementId: '',
      pttElement: {
        fileName: name, filePath: target, md5HexStr: md5, fileSize: String(buf.length),
        duration: Number(duration) || 2, formatType: 1, voiceType: 1, voiceChangeType: 0,
        canConvert2Text: true,
        waveAmplitudes: [0, 18, 9, 23, 16, 17, 16, 15, 44, 17, 24, 20, 14, 15, 17],
        fileSubId: '', playState: 1, autoConvertText: 0, storeID: 0,
        otherBusinessInfo: { aiVoiceType: 0 }
      }
    }
    w('[qq] sendPtt md5=' + md5 + ' size=' + buf.length + ' dur=' + (duration || 2) + ' -> ' + target)
    return s.sendMsg('0', { chatType: chatType || 1, peerUid: peerUid, guildId: '' }, [elem], new Map())
  }

  // ---------- 5) 命令文件（调试用） ----------
  if (S.cmdVer !== CMD_VER) {
    try { if (S.cmdTimer) clearInterval(S.cmdTimer) } catch (e) { }
    S.cmdVer = CMD_VER
    S.cmdTimer = setInterval(function () {
      var cmd = null
      try { cmd = JSON.parse(fs.readFileSync(CMD, 'utf8')) } catch (e) { return }
      if (!cmd || !cmd.seq || cmd.seq <= (S.lastSeq || 0)) return
      S.lastSeq = cmd.seq
      w('[qq] CMD ' + J(cmd).slice(0, 200))
      try {
        if (cmd.action === 'send') {
          var r = sendMsgInternal(cmd.to, cmd.chatType || 1, cmd.text)
          if (r && r.then) r.then(function (x) { fs.writeFileSync(RES, J({ seq: cmd.seq, ok: true, result: x }) + '\n') })
            .catch(function (e) { fs.writeFileSync(RES, J({ seq: cmd.seq, ok: false, err: e.message }) + '\n') })
        } else if (cmd.action === 'ping') {
          fs.writeFileSync(RES, J({ seq: cmd.seq, ok: true, ms: !!msgService(), stage: S.stage }) + '\n')
        }
      } catch (e) { w('[qq] CMD err ' + e.message) }
    }, 1000)
  }
})()

// touch 20:52:42

// touch 21:13:07