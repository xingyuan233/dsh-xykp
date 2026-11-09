// 宿主半边的最小冒烟测试：不依赖 DSH 进程，用 mock ctx 走一遍 apply → 工具 → HTTP 路由。
// 运行：node senses/balance-reporter/test/host.test.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'xykp-balance-reporter-'))
process.env.DSH_HOME = home

const holidayPayloads = {
  2026: {
    days: [
      { date: '2026-01-01', isOffDay: true },
      { date: '2026-01-02', isOffDay: true },
      { date: '2026-01-04', isOffDay: false }, // 调休上班的周末，不是休假日
    ],
  },
  2027: { days: [{ date: '2027-01-01', isOffDay: true }] },
}
const realFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const m = String(url).match(/(\d{4})\.json$/)
  const data = m ? holidayPayloads[m[1]] : null
  if (!data) return { ok: false, status: 404, json: async () => ({}) }
  return { ok: true, status: 200, json: async () => data }
}

const { apply, normalizeBalance, statePath, holidayPath } = await import('../index.js')

const sample = {
  status: 'ready',
  value: [
    { currency: 'CNY', balance: '12.3456789' },
    { currency: 'USD', balance: '1.5' },
  ],
  bonusWallets: [{ currency: 'CNY', balance: '0.01' }],
}

const fakeWebServer = {
  routes: [],
  register(route) {
    this.routes.push(route)
    return () => {
      this.routes = this.routes.filter((r) => r !== route)
    }
  },
}

let tool = null
const cleanups = []
const ctx = {
  get(name) {
    if (name === 'deepseekAccount') {
      return {
        async getBalance(options) {
          assert.equal(options.version, 'dsh-xykp/balance-reporter')
          return sample
        },
      }
    }
    if (name === 'webServer') return fakeWebServer
    return undefined
  },
  tools: {
    register(definition) {
      tool = definition
      return () => {
        tool = null
      }
    },
  },
  effect(fn) {
    const dispose = fn()
    cleanups.push(dispose)
    return dispose
  },
}

function callRoute(route, url) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      headers: null,
      body: '',
      writeHead(code, headers) {
        this.statusCode = code
        this.headers = headers
      },
      end(chunk) {
        this.body = chunk
        resolve(this)
      },
    }
    Promise.resolve(route.handler({ url }, res)).catch(reject)
  })
}

const normalized = normalizeBalance(sample)
assert.equal(normalized.total, 13.8556789)
assert.equal(normalized.currency, 'CNY')
assert.equal(normalized.wallets.length, 2)

apply(ctx, { enabled: true, lowBalance: 20, holidayUrl: 'https://mock.local/holiday-cn' })

assert.ok(tool, 'balance_report 应该注册')
assert.equal(tool.name, 'balance_report')
assert.equal(fakeWebServer.routes.length, 2, '余额 + 节假日两个路由')

const statusRoute = fakeWebServer.routes.find((r) => r.path === '/xykp/balance-reporter/status')
const holidayRoute = fakeWebServer.routes.find((r) => r.path === '/xykp/balance-reporter/holidays')
assert.ok(statusRoute && holidayRoute)

const status = await tool.execute({ action: 'status' })
assert.match(status.text, /13\.86/)
assert.match(status.text, /低于提醒线/)

const statusBody = await callRoute(statusRoute, '/xykp/balance-reporter/status')
assert.equal(statusBody.statusCode, 200)
assert.equal(statusBody.headers['Content-Type'], 'application/json; charset=utf-8')
const parsed = JSON.parse(statusBody.body)
assert.equal(parsed.ok, true)
assert.equal(parsed.total, 13.8556789)

const holidayBody = await callRoute(holidayRoute, '/xykp/balance-reporter/holidays?force=1')
assert.equal(holidayBody.statusCode, 200)
const holidays = JSON.parse(holidayBody.body)
assert.equal(holidays.ok, true)
assert.equal(holidays.source, 'network')
assert.ok(holidays.days.includes('2026-01-01'))
assert.ok(!holidays.days.includes('2026-01-04'), '调休上班日不是休假日')
assert.ok(existsSync(holidayPath()), '节假日缓存应该落盘')

const holidayText = await tool.execute({ action: 'holidays' })
assert.match(holidayText.text, /节假日/)
assert.match(holidayText.text, /network/)

const history = await tool.execute({ action: 'history' })
assert.match(history.text, /余额变动/)

// 状态文件应该被写出来。
const state = JSON.parse(readFileSync(statePath(), 'utf8'))
assert.ok(Array.isArray(state.history))
assert.ok(state.history.length >= 1)

for (const dispose of cleanups.reverse()) {
  try {
    dispose?.()
  } catch {
    /* ignore */
  }
}

// 服务不可用时工具要报错而不是崩。
tool = null
fakeWebServer.routes = []
const failingCtx = {
  get(name) {
    if (name === 'tools') return failingCtx.tools
    return undefined
  },
  tools: {
    register(definition) {
      tool = definition
      return () => {}
    },
  },
  effect(fn) {
    const d = fn()
    return () => d?.()
  },
}
apply(failingCtx, { enabled: true, holidays: false })
const failed = await tool.execute({ action: 'status' })
assert.match(failed.text, /查询失败/)
assert.equal(failed.isError, true)

globalThis.fetch = realFetch
rmSync(home, { recursive: true, force: true })
console.log('balance-reporter host smoke test: OK')
