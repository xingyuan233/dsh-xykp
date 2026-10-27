/** 刷新页面后验证删除已持久化：被删会话不再出现。 */
import { pathToFileURL } from 'node:url'

const WebSocket = (
  await import(pathToFileURL('D:/AI/DeepseekHarness/npm/node_modules/ws/index.js').href)
).default
const CDP = 'http://127.0.0.1:9333'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && t.url.includes('3081'))
if (page === undefined) throw new Error('没有 3081 页面')
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
    const entry = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  }
})
function send(method, params = {}) {
  id += 1
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}

await send('Runtime.enable')
await send('Page.enable')
await send('Page.reload', { ignoreCache: true })
await sleep(1500)

// 侧栏展开状态是 localStorage 保存的；保险起见再点一次。
await evaluate(`(() => {
  const open = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '打开侧边栏')
  if (open !== undefined) open.click()
  return true
})()`)

let labels = []
for (let i = 0; i < 120; i += 1) {
  labels = await evaluate(`[...document.querySelectorAll('[aria-label^="会话“"]')].map((n) => n.getAttribute('aria-label'))`)
  if (labels.length > 0) break
  await sleep(250)
}

const gone = !labels.some((label) => label.includes('修改 npm 缓存路径'))
console.log('刷新后的会话行：', labels.join(' | '))
console.log(gone ? '✓ 被删会话没有回来（持久化删除生效）' : '✗ 被删会话仍然存在')
console.log(labels.length === 2 ? `✓ 会话数为 ${labels.length}` : `! 会话数为 ${labels.length}`)
socket.close()
process.exit(gone ? 0 : 1)
