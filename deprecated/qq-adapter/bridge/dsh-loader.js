// QQ 纯 shell 模式加载器（鲸鱼娘 2909433072）
// 2026-10-28：樱（3793339506）退役后只剩这一个壳 —— 文件名全部去掉「2」后缀，
// 端口还是 39273（端口号不算名字，桥/插件配置都按它来）
// 2026-10-30：代码放插件包、运行时数据放 home\xykp\qq-adapter。工作区里的文件随时会被清理，别再往 workspaces 写。
//
// 部署位置：<QQ-shell>\versions\<ver>\resources\app\dsh-loader.js
// 插件里的副本：plugins\comms\qq-adapter\bridge\dsh-loader.js
const fs = require('fs')

const CODE = 'D:\\AI\\DeepseekHarness\\plugins\\comms\\qq-adapter\\bridge'
const DATA = 'D:\\AI\\DeepseekHarness\\home\\xykp\\qq-adapter'
const LOG = DATA + '\\qq-shell.log'
const SCRIPT = CODE + '\\qq-bridge-script.js'

try {
  fs.mkdirSync(DATA, { recursive: true })
} catch (e) {}

global.__QQ_BOOT = {
  port: 39273,
  log: DATA + '\\qq-bridge.log',
  cmd: DATA + '\\qq-cmd.json',
  res: DATA + '\\qq-cmd-result.json',
  config: DATA + '\\qq-config.json',
  qrFile: DATA + '\\qq-qr-fresh.png',
  own: DATA + '\\nt',
  uin: '2909433072',
}

function log(s) {
  try {
    fs.appendFileSync(LOG, '[' + process.pid + '] ' + s + '\n')
  } catch (e) {}
}

log('=== dsh-loader boot ===')
log('execPath=' + process.execPath)
log('argv=' + JSON.stringify(process.argv))
log('appPath=' + __dirname)

function run() {
  try {
    eval(fs.readFileSync(SCRIPT, 'utf8'))
  } catch (e) {
    log('eval err ' + (e && e.message))
  }
}

// 单实例守卫：先抢 39273，抢不到说明已经有一个主进程在跑 —— 这个直接退出。
// （QQ.exe 被拉起时会起两个主进程，两个都登录就会互相把对方顶下线）
const net = require('net')
const guard = net.createServer()
guard.once('error', (e) => {
  log('39273 已被占用（' + (e && e.code) + '），本进程退出')
  setTimeout(() => process.exit(0), 300)
})
guard.listen(39273, '127.0.0.1', () => {
  guard.close(() => {
    log('单实例守卫通过')
    run()
  })
})

let last = 0
try {
  last = fs.statSync(SCRIPT).mtimeMs
} catch (e) {}
setInterval(() => {
  try {
    const m = fs.statSync(SCRIPT).mtimeMs
    if (m !== last) {
      last = m
      log('reload')
      run()
    }
  } catch (e) {}
}, 1500)
