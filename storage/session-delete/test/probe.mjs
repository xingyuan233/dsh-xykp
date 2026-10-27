/** 探测临时实例页面结构，帮助定位侧栏会话行。 */
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
await sleep(1500)

console.log('=== body 文本 ===')
console.log(await evaluate('document.body.innerText'))
console.log('\n=== 带 aria-label 的元素 ===')
console.log(await evaluate(`[...document.querySelectorAll('[aria-label]')].map((n) => n.tagName + ' [' + n.getAttribute('aria-label') + ']').slice(0, 60).join('\\n')`))
console.log('\n=== 侧栏 HTML 摘要 ===')
console.log(await evaluate(`(() => {
  const open = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '打开侧边栏')
  if (open !== undefined) open.click()
  return open === undefined ? '(侧栏已展开)' : '(已点击打开侧边栏)'
})()`))
await sleep(1500)
console.log('\n=== 会话行 ===')
console.log(await evaluate(`[...document.querySelectorAll('[aria-label^="会话“"]')].map((n) => n.getAttribute('aria-label')).join('\\n')`))
console.log('\n=== 第一行 outerHTML ===')
console.log(await evaluate(`(() => {
  const b = document.querySelector('[aria-label^="会话“"]')
  if (b === null) return '(没有会话行)'
  let node = b
  for (let i = 0; i < 6 && node.parentElement !== null; i += 1) node = node.parentElement
  return node.outerHTML.slice(0, 3000)
})()`))
console.log('\n=== 侧栏 HTML 摘要 ===')
console.log(await evaluate(`(() => {
  const aside = document.querySelector('aside, [class*="sidebar"], [class*="Sidebar"]')
  return aside === null ? '(找不到 aside)' : aside.outerHTML.slice(0, 4000)
})()`))
socket.close()
