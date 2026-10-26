// dsh-xykp · senses/lib/mcp-bridge.mjs
//
// 极简 MCP stdio 客户端：把已有的 Python MCP server（server.py）当成后端，
// 让上层 JS 插件用干净的「原生工具名」重新暴露，不带 mcp__<server>__ 前缀。
//
// 只实现用得到的部分：initialize 握手 + tools/call。
// stdio 传输是「一行一条 JSON-RPC」，不需要 SDK，也不需要 Content-Length 头。

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const PROTOCOL_VERSION = '2025-06-18'

export class McpBridge {
  #opts
  #proc
  #ready
  #starting
  #seq = 0
  #pending = new Map()

  /**
   * @param {object} opts
   * @param {string} opts.command   可执行文件（python.exe）
   * @param {string[]} opts.args    参数（server.py）
   * @param {string} opts.cwd       工作目录（插件目录）
   * @param {string} opts.clientName 握手用的 clientInfo.name
   * @param {number} [opts.timeoutMs] 单次调用超时，默认 30s
   * @param {(msg: string) => void} [opts.log]
   */
  constructor(opts) {
    this.#opts = { timeoutMs: 30_000, log: () => {}, ...opts }
  }

  /** 首次调用/进程死掉后重建时，走 initialize 握手。 */
  async #ensure() {
    if (this.#ready) return this.#ready
    if (this.#starting) return this.#starting
    this.#starting = this.#start().finally(() => {
      this.#starting = undefined
    })
    return this.#starting
  }

  async #start() {
    const { command, args, cwd, clientName, log } = this.#opts
    const proc = spawn(command, args, {
      cwd,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.#proc = proc

    createInterface({ input: proc.stdout }).on('line', (line) => this.#onLine(line))
    proc.stderr.on('data', (buf) => {
      const text = String(buf).trim()
      if (text) log(text)
    })
    proc.on('exit', (code, signal) => {
      this.#proc = undefined
      this.#ready = undefined
      const err = new Error(`MCP 后端退出（code=${code}, signal=${signal ?? '-'}）`)
      for (const waiter of this.#pending.values()) waiter.reject(err)
      this.#pending.clear()
    })
    proc.on('error', (err) => {
      this.#ready = undefined
      log(`spawn 失败：${err.message}`)
    })

    const init = await this.#request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: '0.1.0' },
    })
    this.#notify('notifications/initialized')
    this.#ready = init
    return init
  }

  #onLine(line) {
    if (!line.trim()) return
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const waiter = this.#pending.get(msg.id)
      if (!waiter) return
      this.#pending.delete(msg.id)
      clearTimeout(waiter.timer)
      if (msg.error) waiter.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
      else waiter.resolve(msg.result)
      return
    }
    // 服务端发来的请求（暂不支持）明确回一个错误，别让服务端干等
    if (msg.id !== undefined && msg.method) {
      this.#write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unsupported: ${msg.method}` } })
    }
  }

  #write(payload) {
    const proc = this.#proc
    if (!proc?.stdin?.writable) throw new Error('MCP 后端不可写（进程未起来或已退出）')
    proc.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  #notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  #request(method, params, timeoutMs = this.#opts.timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++this.#seq
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`MCP 调用超时（${timeoutMs}ms）：${method}`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      try {
        this.#write({ jsonrpc: '2.0', id, method, params })
      } catch (err) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(err)
      }
    })
  }

  /**
   * 调一个后端原始工具，返回 MCP result（{ content: [...] }）。
   * @param {string} name 后端原始工具名（如 screenshot / click）
   * @param {object} args
   */
  async callTool(name, args = {}) {
    await this.#ensure()
    return this.#request('tools/call', { name, arguments: args })
  }

  /** 插件卸载/热重载时收尾。 */
  dispose() {
    const proc = this.#proc
    this.#proc = undefined
    this.#ready = undefined
    if (!proc) return
    try {
      proc.stdin.end()
    } catch {}
    try {
      proc.kill()
    } catch {}
  }
}

/** 把 MCP content 拼成纯文本（非文本块用一行占位）。 */
export function contentToText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block?.type === 'image') parts.push(`[image ${block.mimeType ?? '?'} ${Math.round((block.data?.length ?? 0) * 0.75)} bytes]`)
  }
  return parts.join('\n').trim()
}

/** 取出第一个图片块（base64）。 */
export function firstImage(result) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  return blocks.find((block) => block?.type === 'image' && typeof block.data === 'string') ?? undefined
}
