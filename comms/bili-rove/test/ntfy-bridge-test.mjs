// bili-rove ntfy 适配层自测：优先走 comms/ntfy 服务，没服务时走自带实现兜底
import { notifyQr, notifyText, setService } from '../lib/ntfy.js'

let failed = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) failed++
}

const calls = []
setService(() => ({
  async push(opts) {
    calls.push(opts)
    return { ok: true, status: 200, id: 'fake' }
  },
}))

const png = Buffer.from([1, 2, 3])
const code = await notifyQr(png, { ntfyTopic: 'topic-a', ntfyTitle: '标题', ntfyMessage: '说明' })
check(code === 200, 'notifyQr 走服务并返回状态码', `code=${code}`)
check(calls[0]?.body === png, '二维码 Buffer 原样交给服务')
check(calls[0]?.topic === 'topic-a', 'topic 透传')
check(calls[0]?.title === '标题' && calls[0]?.message === '说明', '标题/说明透传')

const ok = await notifyText('T', 'M', { ntfyTopic: 'topic-b' })
check(ok === true, 'notifyText 走服务返回 true')
check(calls[1]?.message === 'M' && calls[1]?.topic === 'topic-b', '文本内容/topic 透传')

// 服务拿不到（抛错）时不应崩
setService(() => {
  throw new Error('no ctx')
})
const stillOk = await notifyText('T2', 'M2', { ntfyTopic: 'topic-c' })
check(typeof stillOk === 'boolean', '服务 getter 抛错也不崩', String(stillOk))
setService(() => null)

// 兜底：没服务 + 连不上 → 返回 0/false，不抛
const bad = await notifyQr(png, { ntfyServer: 'http://127.0.0.1:1', ntfyTopic: 'x' })
check(bad === 0, '兜底实现连不上时返回 0', `bad=${bad}`)
const badText = await notifyText('T', 'M', { ntfyServer: 'http://127.0.0.1:1', ntfyTopic: 'x' })
check(badText === false, '兜底文本失败返回 false')

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exitCode = failed ? 1 : 0
