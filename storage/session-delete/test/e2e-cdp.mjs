/**
 * 通过 Chrome DevTools Protocol 驱动临时 dsh web（3081）验证删除功能。
 * 运行：node test/e2e-cdp.mjs
 */
import { pathToFileURL } from 'node:url'

// ws 从本机 dsh 安装树解析（测试脚本不在 profile 里，没有自己的 node_modules）。
const WebSocket = (
  await import(pathToFileURL('D:/AI/DeepseekHarness/npm/node_modules/ws/index.js').href)
).default

const CDP = 'http://127.0.0.1:9333'
const APP = 'http://127.0.0.1:3081/?token=LKIQVhl0H0sqWHoMcDweTluGArY4yAXhAsZzIs1a2_I'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function targets() {
  const response = await fetch(`${CDP}/json/list`)
  return response.json()
}

async function connect() {
  let page
  for (let i = 0; i < 120; i += 1) {
    const list = await targets()
    page = list.find((target) => target.type === 'page' && /^http:\/\/127\.0\.0\.1:3081/.test(target.url))
    if (page !== undefined) break
    await sleep(250)
  }
  if (page === undefined) throw new Error('找不到 3081 页面 target')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  let id = 0
  const pending = new Map()
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw))
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error !== undefined) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    }
  })
  function send(method, params = {}) {
    id += 1
    const requestId = id
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject })
      socket.send(JSON.stringify({ id: requestId, method, params }))
    })
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (result.exceptionDetails !== undefined) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    }
    return result.result.value
  }
  return { send, evaluate, close: () => socket.close() }
}

async function main() {
  const cdp = await connect()
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  let passed = 0
  let failed = 0
  const check = (label, ok, detail) => {
    if (ok) {
      passed += 1
      console.log(`  ✓ ${label}${detail === undefined ? '' : `（${detail}）`}`)
    } else {
      failed += 1
      console.log(`  ✗ ${label}${detail === undefined ? '' : `（${detail}）`}`)
    }
  }

  // 1. 展开侧栏（新建页面默认是折叠的），等会话行出现
  await cdp.evaluate(`(() => {
    const open = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '打开侧边栏')
    if (open !== undefined) open.click()
    return true
  })()`)
  await sleep(800)

  let rows = []
  for (let i = 0; i < 160; i += 1) {
    rows = await cdp.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('[aria-label^="会话“"]')]
      return buttons.map((b, i) => ({ index: i, label: b.getAttribute('aria-label') }))
    })()`)
    if (rows.length > 0) break
    await sleep(250)
  }
  check('侧栏出现会话行', rows.length > 0, `${rows.length} 行`)
  if (rows.length === 0) {
    console.log('页面文本片段：', await cdp.evaluate('document.body.innerText.slice(0, 800)'))
    process.exit(1)
  }
  console.log('  会话行：', rows.map((row) => row.label).join(' | '))

  // 2. 点开最后一个会话行的「…」菜单（最后一个不是主界面当前会话）
  const targetIndex = Math.max(0, rows.length - 1)
  await cdp.evaluate(`(() => {
    const button = document.querySelectorAll('[aria-label^="会话“"]')[${targetIndex}]
    button.click()
    return true
  })()`)

  // 4. 菜单里应出现「永久删除会话」
  let menuText = ''
  for (let i = 0; i < 60; i += 1) {
    menuText = await cdp.evaluate(
      `[...document.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent).join('|')`,
    )
    if (menuText.includes('永久删除会话')) break
    await sleep(200)
  }
  check('菜单包含「永久删除会话」', menuText.includes('永久删除会话'), menuText)

  // 5. 点击删除项，等弹窗
  await cdp.evaluate(`(() => {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((n) => n.textContent.includes('永久删除会话'))
    item.click()
    return true
  })()`)
  let dialogText = ''
  for (let i = 0; i < 60; i += 1) {
    dialogText = await cdp.evaluate(`document.body.innerText`)
    if (dialogText.includes('永久删除会话？')) break
    await sleep(200)
  }
  check('确认弹窗出现', dialogText.includes('永久删除会话？'))
  check('弹窗包含不可恢复警告', dialogText.includes('无法恢复'))

  // 6. 确认删除
  const before = rows.length
  await cdp.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')]
    const target = buttons.find((b) => b.textContent.trim() === '永久删除')
    if (target === undefined) throw new Error('找不到「永久删除」按钮')
    target.click()
    return true
  })()`)

  let afterRows = before
  let toast = ''
  for (let i = 0; i < 100; i += 1) {
    afterRows = await cdp.evaluate(`document.querySelectorAll('[aria-label^="会话“"]').length`)
    toast = await cdp.evaluate(`document.body.innerText`)
    if (afterRows < before) break
    await sleep(200)
  }
  check('会话行减少', afterRows < before, `${before} → ${afterRows}`)
  check(
    '出现成功/延迟提示',
    toast.includes('会话已永久删除') || toast.includes('重启 dsh web 后会完成磁盘清理'),
  )
  check('确认弹窗已关闭', !toast.includes('永久删除会话？'))

  console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
  cdp.close()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('E2E 失败：', error)
  process.exit(1)
})
