// dsh-xykp · senses/lib/test-bridge.mjs
//
// 直接测后端 Python server 和 mcp-bridge 的连通性（不经过 DSH 宿主）：
//   node senses/lib/test-bridge.mjs              # 截图 + 输入状态，各调一次
//   node senses/lib/test-bridge.mjs --input      # 额外做一次鼠标 move（会把光标挪走）
//
// 依赖：Python 3.12 + mcp + dxcam + opencv-python，PATH 里有 node。

import { fileURLToPath } from 'node:url'
import { McpBridge, contentToText, firstImage } from './mcp-bridge.mjs'

const PYTHON = process.env.DSH_SENSES_PYTHON || 'D:\\Program-Files\\Python\\312\\python.exe'
const ROOT = fileURLToPath(new URL('../', import.meta.url))

const shot = new McpBridge({
  command: PYTHON,
  args: [fileURLToPath(new URL('../screenshot/server.py', import.meta.url))],
  cwd: `${ROOT}screenshot`,
  clientName: 'senses-test',
  log: (msg) => console.error('[py:screenshot]', msg),
})
const info = await shot.callTool('screen_info')
console.log('--- screen_info ---')
console.log(contentToText(info).split('\n').slice(0, 3).join('\n'))

const grab = await shot.callTool('screenshot', { region: '0,0,320,180', fmt: 'jpg', quality: 70 })
const image = firstImage(grab)
console.log('--- screenshot ---')
console.log(contentToText(grab))
console.log('image:', image ? `${image.mimeType} ${Math.round(image.data.length * 0.75)} bytes` : 'NONE')
shot.dispose()

const keys = new McpBridge({
  command: PYTHON,
  args: [fileURLToPath(new URL('../keymouse/server.py', import.meta.url))],
  cwd: `${ROOT}keymouse`,
  clientName: 'senses-test',
  log: (msg) => console.error('[py:keymouse]', msg),
})
const kinfo = await keys.callTool('input_info')
console.log('--- input_info ---')
console.log(contentToText(kinfo))

if (process.argv.includes('--input')) {
  const moved = await keys.callTool('move', { x: 60, y: 60 })
  console.log('--- move(60,60) ---')
  console.log(contentToText(moved))
}
keys.dispose()
console.log('\nOK')
