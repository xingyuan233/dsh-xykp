// dsh-prosecutor · 宿主半边
//
// 需求（任务-2026-10-27.md 第六节 / 2026-10-27 晚补）：
//   把 tools 里的 prosecutor 变成插件 —— 让它能跟着宿主自己启动；
//   但进程本身必须 **分离启动**（detached），dsh 挂了它不能跟着挂。
//
// 插件做四件事：
//   1. 启动时探一下 prosecutor 的锁端口（默认 39997）在不在；不在就 detached 拉起
//   2. 之后每 intervalMinutes 再探一次（进程被别人杀了也能补起来）
//   3. 把 cordis 里的配置（ntfy 频道 / 机器标识 / 定时检查间隔）通过环境变量传给 prosecutor
//   4. 存一份「脚本 + config.json + 关键配置」的哈希：下次启动哈希变了就把旧进程断掉重开新的
//
// 另外给 prosecutor 进程提供一个本地端点，让它能把消息发进会话：
//   POST /dsh-prosecutor/send { session, text } → agents.get(sid).followup(...)
//
// 出任何错只记日志，绝不拖死宿主。
import net from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-prosecutor'
export const inject = ['timer', 'webServer', 'agents']

const PREFIX = '[dsh-prosecutor]'
const log = (...a) => console.log(PREFIX, ...a)
const warn = (...a) => console.warn(PREFIX, ...a)

export const DEFAULTS = {
  // prosecutor 的锁端口
  port: 39997,
  // prosecutor.mjs 的位置，空 = 插件包内的 prosecutor.mjs
  scriptPath: '',
  // node 可执行文件，空 = 当前进程的 execPath
  nodePath: '',
  // 探活超时
  probeTimeoutMs: 1500,
  // 多久补一次检查（分钟）
  intervalMinutes: 10,
  // 拉起后多久再探一次（毫秒），用来判断有没有起来
  afterStartWaitMs: 3000,
  // ⭐ 2026-10-27 新加：
  // 每隔多少分钟检查 DSH 是否存活（0 = 不主动检查，只在收到 /check /notify 时看）
  checkIntervalMinutes: 0,
  // ntfy 频道（默认空 = 用包里 config.json 的 topic）
  ntfyTopic: '',
  // 机器标识（默认空）。指令后面跟标识时，必须跟这个一样才执行
  machineId: '',
  // DSH 的端口（检查存活用）
  dshPort: 3080,
  // 哈希文件，空 = <DSH_HOME>/prosecutor/.prosecutor-hash
  hashPath: '',
  dryRun: false,
}

const home = () => process.env.DSH_HOME || join(homedir(), '.dsh')

// ⭐ 2026-10-27：prosecutor 主程序跟着插件包走（observer/dsh-prosecutor/prosecutor.mjs），
// 不再依赖 <DSH_HOME>/../tools/prosecutor —— tools 里那份只当参考
const 包目录 = fileURLToPath(new URL('../', import.meta.url))

export function defaultScriptPath() {
  return join(包目录, 'prosecutor.mjs')
}

/** 探端口：有人在听 = 进程活着 */
export function probe(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      try {
        socket.destroy()
      } catch {
        /* 无所谓 */
      }
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/**
 * 确保 prosecutor 在跑。deps 便于自测替换。
 * @returns {Promise<{running:boolean, started:boolean, reason?:string}>}
 */
export async function ensureRunning(cfg = {}, deps = {}) {
  const opts = { ...DEFAULTS, ...(cfg || {}) }
  const doProbe = deps.probe || ((p, t) => probe(p, t))
  const doSpawn = deps.spawn || spawnDetached
  const doWait = deps.wait || ((ms) => new Promise((r) => setTimeout(r, ms)))

  // 宿主刚起来时探活偶尔会误判（实测 2026-10-27：重启后 21808 明明在听却判成没在跑，
  // 于是多拉起一个 → 抢锁失败自己退出）。失败后再给一秒，两次都没人听才叫「没在跑」。
  let alive = await doProbe(opts.port, opts.probeTimeoutMs)
  if (!alive) {
    await doWait(1000)
    alive = await doProbe(opts.port, opts.probeTimeoutMs)
  }
  if (alive) {
    return { running: true, started: false }
  }
  if (opts.dryRun) {
    log(`[dry] prosecutor 没在跑，会拉起 ${opts.scriptPath || defaultScriptPath()}`)
    return { running: false, started: false, reason: 'dry-run' }
  }
  try {
    const child = await doSpawn(opts)
    log(`已拉起 prosecutor（pid=${child && child.pid ? child.pid : '?'}）`)
    await doWait(opts.afterStartWaitMs)
    const up = await doProbe(opts.port, opts.probeTimeoutMs)
    if (up) return { running: true, started: true }
    return { running: false, started: true, reason: '拉起了但端口没上来（看 prosecutor.out.log）' }
  } catch (err) {
    return { running: false, started: false, reason: String(err?.message || err) }
  }
}

/** 把 cordis 里的关键配置通过环境变量传给 prosecutor 进程（prosecutor 以它为准） */
export function envFor(cfg = {}) {
  const env = { ...process.env }
  env.DSH_HOME = process.env.DSH_HOME || home()
  if (cfg.machineId) env.DSH_PROSECUTOR_MACHINE_ID = String(cfg.machineId)
  if (cfg.ntfyTopic) env.DSH_PROSECUTOR_TOPIC = String(cfg.ntfyTopic)
  env.DSH_PROSECUTOR_CHECK_INTERVAL_MINUTES = String(Number(cfg.checkIntervalMinutes) || 0)
  env.DSH_PROSECUTOR_DSH_PORT = String(Number(cfg.dshPort) || 3080)
  return env
}

/** 分离启动：detached + stdio 落日志 + unref，宿主重启不会带走它 */
export function spawnDetached(opts) {
  const script = opts.scriptPath || defaultScriptPath()
  const node = opts.nodePath || process.execPath
  // 日志写到 <DSH_HOME>/prosecutor/，不往 node_modules 包里写
  const logDir = join(home(), 'prosecutor')
  try {
    mkdirSync(logDir, { recursive: true })
  } catch {
    /* 无所谓 */
  }
  const logPath = join(logDir, 'prosecutor.out.log')
  let fd
  try {
    fd = openSync(logPath, 'a')
  } catch {
    fd = 'ignore'
  }
  const child = spawn(node, [script], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    cwd: join(script, '..'),
    env: envFor(opts),
  })
  child.unref()
  if (typeof fd === 'number') {
    try {
      closeSync(fd)
    } catch {
      /* 无所谓 */
    }
  }
  return child
}

// ---------- 哈希（脚本 + config.json + 关键配置）----------
function hashPathOf(cfg, script) {
  return cfg.hashPath || join(home(), 'prosecutor', '.prosecutor-hash')
}

export function hashOf(cfg = {}, scriptPath = '') {
  const opts = { ...DEFAULTS, ...(cfg || {}) }
  const script = scriptPath || opts.scriptPath || defaultScriptPath()
  const h = createHash('sha256')
  try {
    h.update(readFileSync(script))
  } catch {
    h.update('missing-script')
  }
  try {
    h.update(readFileSync(join(script, '..', 'config.json')))
  } catch {
    /* 没有 config.json 就算了 */
  }
  h.update(
    JSON.stringify({
      topic: String(opts.ntfyTopic || ''),
      machineId: String(opts.machineId || ''),
      check: Number(opts.checkIntervalMinutes) || 0,
      dshPort: Number(opts.dshPort) || 3080,
    }),
  )
  return h.digest('hex')
}

function readHashFile(path) {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}

function writeHashFile(path, hash) {
  try {
    writeFileSync(path, hash + '\n', 'utf8')
  } catch (err) {
    warn('写哈希文件失败：', err?.message || err)
  }
}

// ---------- 按端口找旧进程并断掉（配置变了要重开新进程）----------
export function killByPort(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true })
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/)
      if (!m || Number(m[1]) !== Number(port)) continue
      const pid = Number(m[2])
      if (!pid || pid === process.pid) continue
      try {
        process.kill(pid)
        return { pid }
      } catch (err) {
        return { pid, error: String(err?.message || err) }
      }
    }
  } catch (err) {
    return { pid: 0, error: String(err?.message || err) }
  }
  return null
}

async function waitPortFree(port, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!(await probe(port, 600))) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

// ---------- 给 prosecutor 用的本地消息端点 ----------
async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res, code, data) {
  try {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  } catch {
    /* 客户端走了就算了 */
  }
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  const script = cfg.scriptPath || defaultScriptPath()
  const hashFile = hashPathOf(cfg, script)

  // ⭐ 2026-10-27：配置/脚本变了 → 断旧进程，重开新进程（哈希变动才动）
  // ⚠ 第一次没有哈希文件时也换：这时无法确认正在跑的那个是不是当前代码
  const curHash = hashOf(cfg, script)
  const oldHash = readHashFile(hashFile)
  const changed = oldHash ? oldHash !== curHash : true

  const run = async (label) => {
    try {
      const r = await ensureRunning(cfg)
      if (r.running && !r.started) return
      log(`${label}：运行=${r.running} 拉起=${r.started}${r.reason ? '（' + r.reason + '）' : ''}`)
      if (r.running) writeHashFile(hashFile, curHash)
    } catch (err) {
      warn(`${label} 失败（已忽略）：`, err?.stack || err)
    }
  }

  // 启动检查：先处理「配置变了要换进程」，再探活/拉起
  void (async () => {
    try {
      if (changed) {
        log('配置/脚本哈希变了（旧 ' + oldHash.slice(0, 10) + ' → 新 ' + curHash.slice(0, 10) + '），准备换掉旧进程')
        const killed = killByPort(cfg.port)
        if (killed && killed.pid) {
          log(`已断开旧 prosecutor（pid=${killed.pid}${killed.error ? '，' + killed.error : ''}）`)
          await waitPortFree(cfg.port)
        }
      }
    } catch (err) {
      warn('换旧进程失败（继续尝试拉起）：', err?.message || err)
    }
    await run('启动检查')
  })()

  const minutes = Math.max(1, Number(cfg.intervalMinutes) || DEFAULTS.intervalMinutes)
  const timer = setInterval(() => void run('定时检查'), minutes * 60000)
  if (typeof timer.unref === 'function') timer.unref()

  // ---- 消息端点：prosecutor 发了 -m，就塞进对应会话（不生成回复，只负责送到）----
  try {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: '/dsh-prosecutor',
          handler: async (req, res) => {
            const url = new URL(req.url, 'http://127.0.0.1')
            if (req.method !== 'POST' || (url.pathname !== '/dsh-prosecutor/send' && url.pathname !== '/dsh-prosecutor/send/')) {
              return sendJson(res, 404, { ok: false, reason: 'unknown ' + req.method + ' ' + url.pathname })
            }
            let b = {}
            try {
              b = JSON.parse((await readBody(req)) || '{}')
            } catch {
              return sendJson(res, 200, { ok: false, reason: '请求不是合法 JSON' })
            }
            const session = String(b.session || '').trim()
            const text = String(b.text || '').trim()
            if (!session) return sendJson(res, 200, { ok: false, reason: '没给 session' })
            if (!text) return sendJson(res, 200, { ok: false, reason: '没给消息' })

            // 会话 id 有带/不带 session- 前缀两种写法，都试一遍
            const ids = [session]
            if (session.startsWith('session-')) ids.push(session.slice('session-'.length))
            else ids.push('session-' + session)
            let agent = null
            for (const id of ids) {
              try {
                const a = ctx.agents.get(id)
                if (a) {
                  agent = a
                  break
                }
              } catch {
                /* 查不动当没找到 */
              }
            }
            if (!agent) return sendJson(res, 200, { ok: false, reason: '会话不在（agent 拿不到，可能没开或被归档）' })
            try {
              const message = createUserMessage({
                content: [{ type: 'text', text }],
                source: { kind: 'plugin:dsh-prosecutor' },
              })
              await agent.followup(message)
              return sendJson(res, 200, { ok: true, via: 'followup' })
            } catch (err) {
              return sendJson(res, 200, { ok: false, reason: '推送失败：' + (err?.message || err) })
            }
          },
        }),
      'dsh-prosecutor: 消息端点',
    )
  } catch (err) {
    warn('消息端点没挂上（不影响保活）：', err?.message || err)
  }

  try {
    ctx.on('dispose', () => clearInterval(timer))
  } catch {
    /* 收摊失败无所谓 */
  }
}

export const _internal = { probe, ensureRunning, spawnDetached, hashOf, killByPort, envFor, DEFAULTS }
