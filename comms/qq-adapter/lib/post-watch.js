// /post 监听：自动推码（2 分钟 × N 次）用完之后，等主人发 /post，收到就再补推一张。
//
// 单独抽出来是为了能脱开宿主自测：不碰 ctx，只依赖传进来的几个函数。
//
// 行为：
//   - start() 起一个后台循环，反复 ntfy.wait({ topic, match: command })
//   - 等到匹配消息 → 调 pushQr()（由调用方负责要新码 + 推送）
//   - 每轮超时就检查 isLoggedIn()；登录了（stage=ready）就自己停
//   - stop() 立刻结束循环（宿主 dispose、登录成功都用它）

export function createPostWatcher({
  getNtfy,
  wait = null,
  command = '/post',
  topic = '',
  timeoutMs = 60_000,
  isLoggedIn = () => false,
  pushQr = async () => {},
  log = () => {},
  warn = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let state = null

  function stop(reason = '') {
    if (!state) return
    state.stopped = true
    state = null
    if (reason) log(`停止等待 ${command}（${reason}）`)
  }

  function start() {
    if (state) return false
    if (!command) return false
    const ntfy = typeof getNtfy === 'function' ? getNtfy() : getNtfy
    const waiter = ntfy && typeof ntfy.wait === 'function' ? ntfy.wait.bind(ntfy) : wait
    if (typeof waiter !== 'function') {
      warn(`拿不到 ntfy 服务，${command} 重推不可用`)
      return false
    }
    const topicName = String(topic || (ntfy && ntfy.config && ntfy.config.defaultTopic) || '').trim()
    if (!topicName) {
      warn(`没有 topic，${command} 重推不可用`)
      return false
    }

    const me = { stopped: false }
    state = me
    log(`推码次数用完，开始等 ${command}（topic=${topicName}）`)

    void (async () => {
      let since = Math.floor(Date.now() / 1000)
      while (!me.stopped) {
        let r = null
        try {
          r = await waiter({ topic: topicName, match: command, timeoutMs, since })
        } catch (err) {
          warn(`等 ${command} 出错：`, err?.message || err)
          await sleep(3000)
          continue
        }
        if (me.stopped) break

        if (r && r.ok && r.message) {
          if (typeof r.message.time === 'number') since = r.message.time + 1
          log(`收到 ${command}，补推一张二维码`)
          try {
            await pushQr()
          } catch (err) {
            warn('补推二维码失败：', err?.message || err)
          }
          continue
        }

        // 超时：从下一轮重新等，顺手看看是不是已经登录了
        since = Math.floor(Date.now() / 1000)
        try {
          if (await isLoggedIn()) {
            stop('已登录')
            break
          }
        } catch {}
        await sleep(300)
      }
      if (state === me) state = null
    })()
    return true
  }

  return {
    start,
    stop,
    get running() {
      return Boolean(state)
    },
  }
}
