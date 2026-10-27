/** 打开第二个会话，验证主界面切换与会话行定位方式。 */
import { pathToFileURL } from 'node:url'

const WebSocket = (
  await import(pathToFileURL('D:/AI/DeepseekHarness/npm/node_modules/ws/index.js').href)
).default
const CDP = 'http://127.0.0.1:9333'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && t.url.includes('3081'))
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

console.log('行结构：')
console.log(await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('[aria-label^="会话“"]')]
  return buttons.map((b) => {
    const item = b.closest('[role="treeitem"]')
    return JSON.stringify({
      label: b.getAttribute('aria-label'),
      treeitem: item === null ? null : item.className,
      text: item === null ? null : item.innerText.slice(0, 60),
      id: item === null ? null : item.getAttribute('data-session-id'),
    })
  }).join('\\n')
})()`))

console.log('\n点击第二个会话的 treeitem…')
console.log(await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('[aria-label^="会话“"]')]
  const item = buttons[1].closest('[role="treeitem"]')
  if (item === null) return '没有 treeitem'
  item.click()
  return 'clicked: ' + item.innerText.slice(0, 60)
})()`))
await sleep(2000)
console.log('\n主区域文本：')
console.log(await evaluate('document.body.innerText.slice(0, 500)'))
socket.close()
