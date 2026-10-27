/**
 * 负向验证：删除「主界面正打开」的会话时，客户端应拒绝并保留弹窗。
 * 运行前需先打开目标会话（probe-open.mjs 已打开第二个会话）。
 */
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

const before = await evaluate(`document.querySelectorAll('[aria-label^="会话“"]').length`)
console.log(`操作前会话数：${before}`)

// 打开第二个会话的菜单
await evaluate(`(() => {
  const button = [...document.querySelectorAll('[aria-label^="会话“"]')].find((n) => n.getAttribute('aria-label').includes('修复重启后旧命令框残留'))
  button.click()
  return true
})()`)
await sleep(500)
await evaluate(`(() => {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((n) => n.textContent.includes('永久删除会话'))
  item.click()
  return true
})()`)
await sleep(600)

let text = await evaluate('document.body.innerText')
console.log('弹窗出现：', text.includes('永久删除会话？'))

await evaluate(`(() => {
  const target = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '永久删除')
  target.click()
  return true
})()`)

let errorShown = false
for (let i = 0; i < 40; i += 1) {
  text = await evaluate('document.body.innerText')
  if (text.includes('正在主界面打开')) {
    errorShown = true
    break
  }
  await sleep(200)
}
const after = await evaluate(`document.querySelectorAll('[aria-label^="会话“"]').length`)
const dialogOpen = text.includes('永久删除会话？')

console.log(errorShown ? '✓ 显示了「正在主界面打开」的拒绝提示' : '✗ 没有拒绝提示')
console.log(dialogOpen ? '✓ 弹窗保持打开（未误删）' : '✗ 弹窗被关闭')
console.log(after === before ? `✓ 会话数不变（${after}）` : `✗ 会话数变化（${before} → ${after}）`)

// 关闭弹窗，避免影响后续操作
await evaluate(`(() => {
  const cancel = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '取消')
  if (cancel !== undefined) cancel.click()
  return true
})()`)

socket.close()
process.exit(errorShown && dialogOpen && after === before ? 0 : 1)
