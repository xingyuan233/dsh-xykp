// 把 vendored VK-1 widget + 压缩后的素材 + 页面侧 mount.js 拼成
// 包根 client.js 里的一段生成代码（客户端 bundle 只认整包 client.js）。
//
// 用法：
//   node senses/balance-reporter/client/build.mjs           # 只改 DSH\plugins\client.js
//   node senses/balance-reporter/client/build.mjs --install # 同时同步到已安装的 dsh-xykp
//
// 素材来自 YCTS-otree/VK-1 dsh-plugin（MIT，见 ../LICENSE 与 ../NOTICE），
// 用 Pillow 转成 640px WebP 只是为了塞进单文件 bundle；原始 PNG 不随包发布。

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const pkgRoot = resolve(pluginRoot, '../..') // DSH\plugins
const clientPath = join(pkgRoot, 'client.js')

const ASSET_MAP = {
  expression_11: 'expression_11.webp',
  expression_12: 'expression_12.webp',
  expression_21: 'expression_21.webp',
  expression_22: 'expression_22.webp',
  rice: 'rice.webp',
  iron_bowl: 'iron_bowl.webp',
  hit: 'hit.mp3',
  feed: 'feed.mp3',
  pot_land: 'pot_land.mp3',
  pot_off: 'pot_off.mp3',
  pat_hand_0: 'pat_hand_0.webp',
  pat_hand_1: 'pat_hand_1.webp',
  pat_hand_2: 'pat_hand_2.webp',
  pat_hand_3: 'pat_hand_3.webp',
  pat_hand_4: 'pat_hand_4.webp',
}

function readAsset(name) {
  const file = join(pluginRoot, 'assets', ASSET_MAP[name])
  const buf = readFileSync(file)
  const mime = name === 'hit' || name === 'feed' || name === 'pot_land' || name === 'pot_off' ? 'audio/mpeg' : 'image/webp'
  return `data:${mime};base64,${buf.toString('base64')}`
}

function mustReplace(source, from, to, label) {
  if (!source.includes(from)) throw new Error(`补丁点不存在：${label}`)
  return source.replace(from, to)
}

function patchWidget(source) {
  source = mustReplace(
    source,
    `  var BASE = '/dsh-vk1'\n  var EXPR_URL = {\n    happy: BASE + '/expression_11.png',\n    nervous: BASE + '/expression_22.png',\n    aloof: BASE + '/expression_12.png',\n    calm: BASE + '/expression_21.png',\n  }\n  var EXPR_ORDER = ['happy', 'nervous', 'aloof', 'calm']\n  var RICE_URL = BASE + '/rice.png'\n  var IRON_URL = BASE + '/iron_bowl.png'\n  var ironDrawUrl = ''\n  var HIT_SOUND = BASE + '/hit.mp3'\n  var FEED_SOUND = BASE + '/feed.mp3'\n  var BALANCE_URL = BASE + '/balance.json'`,
    `  var BASE = '/dsh-vk1'\n  var EXPR_URL = {\n    happy: __xykpVk1Assets.expression_11,\n    nervous: __xykpVk1Assets.expression_22,\n    aloof: __xykpVk1Assets.expression_12,\n    calm: __xykpVk1Assets.expression_21,\n  }\n  var EXPR_ORDER = ['happy', 'nervous', 'aloof', 'calm']\n  var RICE_URL = __xykpVk1Assets.rice\n  var IRON_URL = __xykpVk1Assets.iron_bowl\n  var ironDrawUrl = ''\n  var HIT_SOUND = __xykpVk1Assets.hit\n  var FEED_SOUND = __xykpVk1Assets.feed\n  var BALANCE_URL = ''`,
    '素材常量',
  )
  source = mustReplace(source, '  var POLL_MS = 2000', '  var POLL_MS = 12000', '轮询间隔')
  source = mustReplace(source, '  var DEFAULT_SIZE = 454', '  var DEFAULT_SIZE = 340', '默认尺寸')

  source = mustReplace(
    source,
    `  var landPool = makePool(BASE + '/pot_land.mp3', 2)`,
    `  var landPool = makePool(__xykpVk1Assets.pot_land, 2)`,
    '落盆音效',
  )
  source = mustReplace(
    source,
    `  var offPool = makePool(BASE + '/pot_off.mp3', 2)`,
    `  var offPool = makePool(__xykpVk1Assets.pot_off, 2)`,
    '取盆音效',
  )
  source = mustReplace(
    source,
    `    hand.src = BASE + '/pat_hand_' + hi + '.png'`,
    `    hand.src = __xykpVk1Assets['pat_hand_' + hi]`,
    '摸头手图',
  )
  source = mustReplace(
    source,
    `  var DEFAULT_SOUNDS = [HIT_SOUND, FEED_SOUND, BASE + '/pot_land.mp3', BASE + '/pot_off.mp3']`,
    `  var DEFAULT_SOUNDS = [HIT_SOUND, FEED_SOUND, __xykpVk1Assets.pot_land, __xykpVk1Assets.pot_off]`,
    '默认音效列表',
  )
  source = mustReplace(
    source,
    `    fetch(BALANCE_URL, { cache: 'no-store' })\n      .then(function (r) { return r.json() })`,
    `    Promise.resolve()\n      .then(function () { return window.__xykpVk1BalanceProvider(!!snap) })`,
    '余额拉取',
  )
  source = mustReplace(
    source,
    `  function refreshUpdateStatus() {`,
    `  function refreshUpdateStatus() {\n    return // 由 dsh-xykp 管理更新，页面挂件不查 GitHub`,
    '更新检查',
  )
  source = mustReplace(
    source,
    `  function onDown(e) {\n    blockPat()`,
    `  function onDown(e) {\n    // 页面输入框在挂件下方时，把点击让给页面（挂件是 pointer-events:none，\n    // 所以 e.target 是真正的输入控件；只放行文本输入，链接/按钮不穿透）。\n    if (e.target && e.target.closest && e.target.closest('textarea,input,select,[contenteditable="true"],[role="textbox"]')) return\n    blockPat()`,
    '输入框让点击',
  )
  source = mustReplace(
    source,
    `    menuRow('立即刷新余额', function () { poll(true) })`,
    `    menuRow('立即刷新余额', function () { poll(true) })\n    menuRow('隐藏挂件', function () { if (window.__xykpVk1Hide) window.__xykpVk1Hide() })`,
    '隐藏菜单项',
  )
  // 说明这是二次分发版本，别把上游的“纯插件形态”误当成还没改。
  source = source.replace(
    '/* ===========================================================================\n * VK-1 余额挂件 —— 网页内挂件（纯插件形态）',
    '/* ===========================================================================\n * VK-1 余额挂件 —— dsh-xykp 页面内二次分发版（源自 YCTS-otree MIT 移植）\n * 素材 / 峰谷 / 余额 provider / 隐藏菜单由 build.mjs 打补丁；\n * 设置界面与滚轮交互由 dsh-xykp 在「显示 / 动画 / 声音」重排时手改。\n *\n * 原注释：\n * VK-1 余额挂件 —— 网页内挂件（纯插件形态）',
  )
  return source
}

function buildSection() {
  const assets = {}
  for (const key of Object.keys(ASSET_MAP)) assets[key] = readAsset(key)
  const widget = patchWidget(readFileSync(join(here, 'widget.js'), 'utf8'))
  const peak = readFileSync(join(here, 'peak.js'), 'utf8')
  const mount = readFileSync(join(here, 'mount.js'), 'utf8')
  const lines = [
    '    // ==== BEGIN GENERATED: senses/balance-reporter ====',
    '    // 由 senses/balance-reporter/client/build.mjs 生成；改素材/挂件后重新跑，不要手改。',
    `    var __xykpVk1Assets = ${JSON.stringify(assets)}`,
    '    function __xykpVk1Start() {',
    peak,
    '    ;',
    widget,
    '    }',
    mount,
    '    // ==== END GENERATED: senses/balance-reporter ====',
  ]
  return lines.join('\n')
}

const BEGIN = '    // ==== BEGIN GENERATED: senses/balance-reporter ===='
const END = '    // ==== END GENERATED: senses/balance-reporter ===='

function writeClient() {
  let client = readFileSync(clientPath, 'utf8')
  const section = buildSection()
  const beginAt = client.indexOf(BEGIN)
  const endAt = client.indexOf(END)
  if (beginAt >= 0 && endAt > beginAt) {
    client = client.slice(0, beginAt) + section + client.slice(endAt + END.length)
  } else {
    const anchor = '    exports.apply = apply'
    const at = client.lastIndexOf(anchor)
    if (at < 0) throw new Error('client.js 里找不到 exports.apply = apply')
    client = client.slice(0, at) + section + '\n\n' + client.slice(at)
  }
  if (!client.includes('senses/balance-reporter 的客户端半边')) {
    const hook = `      sessionsGetter = ctx.get('sessions') || null`
    if (!client.includes(hook)) throw new Error('client.js apply 里找不到 sessionsGetter 锚点')
    client = client.replace(
      hook,
      hook + `\n\n      // 页面右下角的 VK-1 余额挂件（senses/balance-reporter 的客户端半边）\n      try {\n        installBalanceReporter(ctx)\n      } catch (e) {\n        console.warn('[balance-reporter] 挂件初始化失败：', e)\n      }`,
    )
  }
  writeFileSync(clientPath, client)
  console.log('client.js updated:', clientPath, (client.length / 1024).toFixed(1) + ' KiB')

  if (process.argv.includes('--install')) {
    const home = process.env.DSH_HOME || 'D:\\AI\\DeepseekHarness\\home'
    const installedRoot = join(home, 'profiles', 'web', 'node_modules', 'dsh-xykp')
    if (!existsSync(join(installedRoot, 'client.js'))) throw new Error('已安装的 dsh-xykp 不存在：' + installedRoot)
    copyFileSync(clientPath, join(installedRoot, 'client.js'))
    copyTree(join(pluginRoot), join(installedRoot, 'senses', 'balance-reporter'))
    console.log('installed to:', installedRoot)
  }
}

function copyTree(from, to) {
  mkdirSync(to, { recursive: true })
  for (const ent of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, ent.name)
    const dst = join(to, ent.name)
    if (ent.isDirectory()) {
      copyTree(src, dst)
    } else if (ent.isFile()) {
      copyFileSync(src, dst)
    }
  }
}

writeClient()
