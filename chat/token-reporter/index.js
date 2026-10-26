// dsh-xykp · chat/token-reporter
//
// 给每个会话附带 token 用量信息，并提供一个查询工具：
//   - 当前账号余额（走 DSH 的 deepseekAccount 服务，平台登录态；没有就走官方 /user/balance）
//   - DSH 在某个时间段的 token 用量（扫 $DSH_HOME/sessions 的会话日志，provider/model 可过滤）
//   - 当前会话的累计/上下文占用
//
// 默认全关：config.enabled=false 时什么都不注册、不发请求。
//
// config 示例（profile 的 cordis.patch.yml）：
//   - insert:
//       - id: token-reporter
//         name: 'dsh-xykp/chat/token-reporter'
//         config:
//           enabled: true
//           tool: true                 # 注册 token_report 工具
//           prompt:                    # 每轮塞进系统提示的摘要（默认关）
//             enabled: true
//             order: 880
//             header: '[token]'
//             fields: [turn, session, context, cache, cost]
//           cost:                      # 可选：元 / 百万 token，用于估算
//             input: 2
//             cacheRead: 0.2
//             output: 3
//           sessionsRoot: ''           # 默认 $DSH_HOME/sessions

import { join } from 'node:path'
import { scanUsage } from './usage.js'

export const name = 'token-reporter'
export const inject = ['tools', 'agents']

const DEFAULTS = {
  presets: [],
  prompt: {
    order: 880,
    header: '[token]',
    fields: ['turn', 'session', 'cache', 'context', 'cost'],
  },
  cost: { input: 0, cacheRead: 0, output: 0 },
  sessionsRoot: '',
}

function log(message) {
  console.error(`[token-reporter] ${message}`)
}

function pickConfig(raw = {}) {
  return {
    ...DEFAULTS,
    ...raw,
    prompt: { ...DEFAULTS.prompt, ...(raw.prompt || {}) },
    cost: { ...DEFAULTS.cost, ...(raw.cost || {}) },
  }
}

/** 1,234,567 -> 1.2m；12,345 -> 12.3k；小数字原样。 */
function fmt(n) {
  const value = Number(n) || 0
  const abs = Math.abs(value)
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}b`
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}m`
  if (abs >= 1e4) return `${(value / 1e3).toFixed(1)}k`
  return String(Math.round(value))
}

function exact(n) {
  return (Number(n) || 0).toLocaleString('en-US')
}

function localDate(ms) {
  const d = new Date(ms)
  const pad = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 解析时间参数：today / 7d / 12h / 30m / YYYY-MM-DD / ISO。
 * @param {string|undefined} value 用户给的时间
 * @param {number} fallbackMs 缺省值
 * @returns {number} 毫秒时间戳
 */
function parseWhen(value, fallbackMs) {
  if (!value) return fallbackMs
  const text = String(value).trim()
  if (text === 'today') {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const relative = /^(\d+)\s*(m|h|d|w)$/i.exec(text)
  if (relative) {
    const n = Number(relative[1])
    const unit = relative[2].toLowerCase()
    const mult = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit]
    return Date.now() - n * mult
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [y, m, d] = text.split('-').map(Number)
    return new Date(y, m - 1, d).getTime()
  }
  const parsed = Date.parse(text)
  if (!Number.isNaN(parsed)) return parsed
  throw new Error(`看不懂的时间：「${text}」。用 today / 7d / 24h / YYYY-MM-DD / ISO 都行。`)
}

function sessionsRootOf(ctx, config) {
  if (config.sessionsRoot) return config.sessionsRoot
  const home = process.env.DSH_HOME
  if (home) return join(home, 'sessions')
  return join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'sessions')
}

function projectUsage(ctx, session) {
  try {
    const registry = ctx.get?.('sessionProjections')
    if (!registry || !session) return undefined
    return registry.stateOf(session, 'tokenUsage')
  } catch {
    return undefined
  }
}

function projectPressure(ctx, session) {
  try {
    const registry = ctx.get?.('sessionProjections')
    if (!registry || !session) return undefined
    return registry.stateOf(session, 'contextPressure')
  } catch {
    return undefined
  }
}

function costOf(totals, cost) {
  const million = 1_000_000
  const input = (totals.input * (cost.input || 0)) / million
  const cacheRead = (totals.cacheRead * (cost.cacheRead || 0)) / million
  const output = (totals.output * (cost.output || 0)) / million
  return input + cacheRead + output
}

function promptLine(agent, config) {
  const usage = projectUsage(agent.ctx, agent.session)
  const pressure = projectPressure(agent.ctx, agent.session)
  if (!usage && !pressure) return ''

  const parts = []
  const fields = new Set(config.prompt.fields || [])
  const totals = usage?.totals
  const last = usage?.last?.buckets

  if (fields.has('turn') && last) {
    parts.push(`上一步 in ${fmt(last.uncachedInputTokens)} / out ${fmt(last.outputTokens)} / cacheRead ${fmt(last.cacheReadTokens)}`)
  }
  if (fields.has('session') && totals) {
    parts.push(`会话累计 ${fmt(totals.uncachedInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens)}`)
  }
  if (fields.has('cache') && totals) {
    const promptAll = totals.uncachedInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
    const rate = promptAll > 0 ? (totals.cacheReadTokens / promptAll) * 100 : 0
    parts.push(`缓存命中 ${rate.toFixed(0)}%`)
  }
  if (fields.has('context') && pressure) {
    const used = pressure.projectedTokens ?? pressure.pressureTokens
    if (used !== undefined) parts.push(`上下文 ${fmt(used)}${pressure.contextWindow ? `/${fmt(pressure.contextWindow)}` : ''}`)
  }
  if (fields.has('cost') && totals) {
    const money = costOf(
      { input: totals.uncachedInputTokens, cacheRead: totals.cacheReadTokens, output: totals.outputTokens },
      config.cost,
    )
    if (money > 0) parts.push(`≈¥${money.toFixed(3)}`)
  }
  if (!parts.length) return ''
  return `${config.prompt.header} ${parts.join(' · ')}`
}

/** 余额：优先用 DSH 的平台账号服务；没有就退回官方 /user/balance（需要 DEEPSEEK_API_KEY）。 */
async function readBalance(ctx) {
  const account = ctx.get?.('deepseekAccount')
  if (account && typeof account.getBalance === 'function') {
    try {
      const result = await account.getBalance({
        version: 'dsh-xykp/token-reporter',
        locale: 'zh-CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      })
      if (result?.status === 'ready') {
        const trim = (v) => {
          const n = Number(v)
          return Number.isFinite(n) ? String(n) : String(v)
        }
        const walletLine = (wallets) =>
          (wallets || []).map((w) => `${w.currency} ${trim(w.balance)}`).join('，') || '无'
        const normal = walletLine(result.value)
        const bonus = walletLine(result.bonusWallets)
        return { source: 'deepseek-account-platform', text: `充值余额：${normal}\n赠金余额：${bonus}` }
      }
      if (result?.status === 'failed') {
        return { source: 'deepseek-account-platform', text: '平台余额查询失败（登录态可能过期，去设置页重新登录）。' }
      }
      return { source: 'deepseek-account-platform', text: '账号还没登录，查不到余额。' }
    } catch (err) {
      return { source: 'deepseek-account-platform', text: `平台余额查询出错：${err?.message || err}` }
    }
  }

  const key = process.env.DEEPSEEK_API_KEY
  if (!key) {
    return { source: 'none', text: '没有可用余额来源：既没有挂载 deepseekAccount 服务，环境里也没有 DEEPSEEK_API_KEY。' }
  }
  try {
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!res.ok) return { source: 'api.deepseek.com', text: `官方余额接口返回 HTTP ${res.status}。` }
    const data = await res.json()
    const wallets = (data.balance_infos || [])
      .map((w) => `${w.currency} 总 ${w.total_balance}（赠金 ${w.granted_balance} / 充值 ${w.topped_up_balance}）`)
      .join('\n')
    return { source: 'api.deepseek.com', text: `可用：${data.is_available ? '是' : '否'}\n${wallets || '（没有余额信息）'}` }
  } catch (err) {
    return { source: 'api.deepseek.com', text: `官方余额接口请求失败：${err?.message || err}` }
  }
}

function usageReport(ctx, config, args) {
  const now = Date.now()
  const since = parseWhen(args.since, now - 7 * 86_400_000)
  const until = args.until ? parseWhen(args.until, now) : now
  const root = sessionsRootOf(ctx, config)
  const result = scanUsage({ root, sinceMs: since, untilMs: until, provider: args.provider, model: args.model })

  const filter = [args.provider && `provider≈${args.provider}`, args.model && `model≈${args.model}`].filter(Boolean).join('，')
  const lines = []
  lines.push(`时间段：${localDate(since)} → ${localDate(until)}${filter ? `（${filter}）` : ''}`)
  if (result.attempts === 0) {
    lines.push(`这段时间没有调用记录。扫描了 ${result.filesScanned} 个会话文件${result.skipped ? `（${result.skipped} 个读不了）` : ''}。`)
    return lines.join('\n')
  }
  lines.push(`调用 ${result.attempts} 次 · 会话 ${result.sessions} 个`)
  lines.push(
    `input ${exact(result.totals.input)} · cacheRead ${exact(result.totals.cacheRead)} · cacheWrite ${exact(result.totals.cacheWrite)} · output ${exact(result.totals.output)}`,
  )
  lines.push(`合计 ${exact(result.totals.total)} tokens`)

  const money = costOf(
    { input: result.totals.input, cacheRead: result.totals.cacheRead, output: result.totals.output },
    config.cost,
  )
  if (money > 0) lines.push(`估算费用 ≈¥${money.toFixed(3)}（按配置单价）`)

  const groupBy = args.group_by === 'model' ? 'model' : 'day'
  if (groupBy === 'day') {
    lines.push('按天：')
    for (const day of result.days) {
      lines.push(`  ${day.date}  ${day.attempts} 次  in ${fmt(day.input)} / out ${fmt(day.output)} / 合计 ${fmt(day.total)}`)
    }
  } else {
    lines.push('按模型：')
    for (const row of result.models) {
      lines.push(`  ${row.provider}/${row.model}  ${row.attempts} 次  合计 ${fmt(row.total)}`)
    }
  }
  return lines.join('\n')
}

function sessionReport(ctx, session) {
  const usage = projectUsage(ctx, session)
  const pressure = projectPressure(ctx, session)
  const lines = []
  if (!usage) {
    lines.push('当前会话还没有可用的 token 统计（token-meter 没挂，或这轮还没结算）。')
  } else {
    const t = usage.totals
    lines.push(`会话 ${session?.id ?? '?'}`)
    lines.push(`累计：input ${exact(t.uncachedInputTokens)} · cacheRead ${exact(t.cacheReadTokens)} · cacheWrite ${exact(t.cacheWriteTokens)} · output ${exact(t.outputTokens)}`)
    lines.push(`合计 ${exact(t.uncachedInputTokens + t.cacheReadTokens + t.cacheWriteTokens + t.outputTokens)} tokens`)
    const last = usage.last
    if (last) {
      lines.push(
        `上一步（turn ${last.turn} / step ${last.step}）：in ${exact(last.buckets.uncachedInputTokens)} · out ${exact(last.buckets.outputTokens)} · cacheRead ${exact(last.buckets.cacheReadTokens)}`,
      )
    }
  }
  if (pressure) {
    const used = pressure.projectedTokens ?? pressure.pressureTokens
    lines.push(`上下文：${used === undefined ? '未知' : exact(used)}${pressure.contextWindow ? ` / ${exact(pressure.contextWindow)}` : ''}`)
  }
  return lines.join('\n')
}

const parameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['all', 'balance', 'usage', 'session'],
      description: 'balance 查账号余额；usage 查某时间段的 token 用量；session 查当前会话累计；all = 三者都查（默认）。',
    },
    since: {
      type: 'string',
      description: 'usage 的起始时间：today / 7d / 24h / 30m / YYYY-MM-DD / ISO。默认 7d。',
    },
    until: {
      type: 'string',
      description: 'usage 的结束时间，格式同 since，默认现在。',
    },
    provider: { type: 'string', description: '只统计 provider 名包含这个子串的调用（如 deepseek-account）。' },
    model: { type: 'string', description: '只统计 model 名包含这个子串的调用（如 deepseek-flash）。' },
    group_by: {
      type: 'string',
      enum: ['day', 'model'],
      description: 'usage 明细按天还是按模型分组，默认 day。',
    },
  },
}

function toolDefinition(ctx, config) {
  return {
    name: 'token_report',
    description:
      '查 token 用量和账号余额：action=balance 查当前账号余额（平台登录态或 DEEPSEEK_API_KEY）；' +
      'action=usage 查 DSH 在某个时间段的 token 用量（可过滤 provider/model，数据来自本机会话日志）；' +
      'action=session 查当前会话累计与上下文占用。默认 all。',
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
      },
      render(_args, value) {
        return [{ type: 'text', text: String(value?.text ?? '') }]
      },
    },
    async execute(args = {}, exec) {
      const action = args.action || 'all'
      const sections = []
      if (action === 'balance' || action === 'all') {
        const balance = await readBalance(ctx)
        sections.push(`【余额 · ${balance.source}】\n${balance.text}`)
      }
      if (action === 'usage' || action === 'all') {
        try {
          sections.push(`【用量】\n${usageReport(ctx, config, args)}`)
        } catch (err) {
          sections.push(`【用量】查询失败：${err?.message || err}`)
        }
      }
      if (action === 'session' || action === 'all') {
        try {
          sections.push(`【本会话】\n${sessionReport(ctx, exec?.agent?.session)}`)
        } catch (err) {
          sections.push(`【本会话】查询失败：${err?.message || err}`)
        }
      }
      return { text: sections.join('\n\n') }
    },
  }
}

export function apply(ctx, rawConfig = {}) {
  const config = pickConfig(rawConfig)
  const presets = new Set(config.presets || [])

  const watched = new Set()
  const perAgent = new Map()
  const disposers = []

  // 工具是全局常驻的：工具定义只占系统提示词一次（KV 缓存友好），
  // 开关它反而会因为工具集变化让整个提示词重传，纯浪费。
  disposers.push(ctx.tools.register(toolDefinition(ctx, config)))

  /** 摘要按预设生效：presets 里列出的预设有提示摘要，其余没有。 */
  const allowed = (agent) => {
    try {
      const id = ctx.agentPresets?.composedPreset?.(agent.ctx)
      return !!id && presets.has(id)
    } catch {
      return false
    }
  }

  const watch = (agent) => {
    if (!agent || watched.has(agent)) return
    if (!presets.size || !allowed(agent)) return
    watched.add(agent)
    const mine = []
    try {
      mine.push(
        agent.ctx.systemPrompt.section({
          name: 'token-reporter',
          order: config.prompt.order,
          text: () => promptLine(agent, config),
        }),
      )
      perAgent.set(agent, mine)
      agent.ctx.on('dispose', () => {
        watched.delete(agent)
        const list = perAgent.get(agent) || []
        perAgent.delete(agent)
        for (const off of list) {
          try {
            off?.()
          } catch {}
        }
      })
      let preset = '?'
      try {
        preset = ctx.agentPresets?.composedPreset?.(agent.ctx) || '?'
      } catch {}
      log(`已挂提示摘要：${agent.session?.id || agent.id}（预设 ${preset}）`)
    } catch (err) {
      log(`挂提示摘要失败：${err?.message || err}`)
    }
  }

  ctx.on('agent/created', (payload) => {
    try {
      watch(payload?.agent)
    } catch (err) {
      log(`处理 agent/created 失败：${err?.message || err}`)
    }
  })
  const scan = () => {
    try {
      for (const agent of ctx.agents?.list?.() || []) watch(agent)
    } catch {}
  }
  scan()
  const timer = setInterval(scan, 30_000)
  if (typeof timer.unref === 'function') timer.unref()
  disposers.push(() => clearInterval(timer))

  // 插件卸载/热重载时把自己挂上去的东西全部摘掉（不然旧 section 会一直留在提示里）。
  disposers.push(() => {
    for (const [, list] of perAgent) {
      for (const off of list) {
        try {
          off?.()
        } catch {}
      }
    }
    perAgent.clear()
    watched.clear()
  })

  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      for (const off of disposers) {
        try {
          off?.()
        } catch {}
      }
      disposers.length = 0
    })
  }

  log(
    `已启用：工具 token_report（全局）；提示摘要 ${
      presets.size ? `预设 ${[...presets].join('/')}（${config.prompt.fields.join('/')}）` : '不注入（presets 为空）'
    }`,
  )
}
