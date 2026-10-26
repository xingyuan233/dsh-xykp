// dsh-xykp · chat/toolret-forget
//
// 让模型自己选择「哪些工具结果不留在下一轮」。
//
//   forget_tool_results({ step?: 1, forget?: [1,3], keep?: [...], tool?: 'x', reason?: '...' })
//
// - step：1 = 最近一次带工具调用的步骤；一次性并行调了 5 个工具，就在这里点序号
// - 被点到的结果会替换成 ⟨已折叠⟩ 占位：下一轮看不见原文，会话日志里还完整留着
// - 这个工具自己的结果也会立刻折叠掉，所以「选择本身」不会留在下一轮（assistant 的调用参数还会在，那点很小）
//
// 折叠用的是 surfaceOp=replace（跟官方 tool-result-pruner 同一套），不会把 tool-call 配对弄断。
import { FOLDED, SELF_MARK, textOfMessage, foldResult, listSurface, toolNameOfCall } from './fold.js'

export const name = 'toolret-forget'
export const inject = ['agents', 'agentPresets', 'tools']

const PREFIX = '[toolret-forget]'
const log = (...args) => console.log(PREFIX, ...args)
const warn = (...args) => console.warn(PREFIX, ...args)

const tool = (ctx) => ({
  name: 'forget_tool_results',
  description:
    '把工具结果折叠掉：从下一轮起模型看不到这些结果的原文（日志里仍保留）。' +
    '一次性并行调了很多工具、只要其中几条时用它。' +
    '序号按最近一个「带工具调用的步骤」从 1 开始；不填 forget/keep 就全忘。' +
    '这个工具自己的结果也会被折叠，所以选择本身不会留在对话里。',
  parameters: {
    step: {
      type: 'number',
      description: '1 = 最近一次带工具调用的步骤（默认）；2 = 再往前一个步骤。',
    },
    forget: {
      type: 'array',
      items: { type: 'number' },
      description: '要忘掉的调用序号（从 1 开始），比如 [1,3]。',
    },
    keep: {
      type: 'array',
      items: { type: 'number' },
      description: '要保留的调用序号，其余的忘掉。和 forget 二选一。',
    },
    tool: {
      type: 'string',
      description: '只处理这个名字的工具调用（可选）。',
    },
    reason: {
      type: 'string',
      description: '可选，一句话写进占位里，比如「只是中间过程」。',
    },
  },
  async execute(args, exec) {
    try {
      const session = exec?.agent?.session
      if (!session) return `${SELF_MARK} 没折叠：拿不到会话`
      const { foldSelection } = await import('./fold.js')
      const result = foldSelection(ctx, session, args || {})
      if (!result.folded.length) {
        return `${SELF_MARK} 没折叠任何结果${result.reason ? `：${result.reason}` : ''}${
          result.missing?.length ? `（序号不存在或还没结果：${result.missing.join(',')}）` : ''
        }`
      }
      const names = result.folded.map((item) => `#${item.index} ${item.tool}`).join('、')
      log(`折叠了第 ${result.step} 步的 ${result.folded.length} 条：${names}`)
      return `${SELF_MARK} 已折叠 ${result.folded.length} 条工具结果（第 ${result.step} 步）：${names}`
    } catch (err) {
      warn('执行失败：', err?.message || err)
      return `${SELF_MARK} 折叠失败：${err?.message || err}`
    }
  },
})

export function apply(ctx, config = {}) {
  void boot(ctx, config).catch((err) => warn('启动失败（已忽略）：', err?.stack || err))
}

async function boot(ctx, config) {
  const presets = new Set(config.presets || ['alive'])
  const refreshMs = Number.isFinite(config.refreshMs) ? config.refreshMs : 3000
  const watched = new Set()
  const disposers = new Map()

  const allowed = (agent) => {
    if (!presets.size) return true
    try {
      const id = ctx.agentPresets.composedPreset(agent.ctx)
      return !!id && presets.has(id)
    } catch (error) {
      return false
    }
  }

  // 自己那条结果一落地就折叠：这样「选择本身」不会留到下一轮
  const foldSelf = (agent, event) => {
    if (event?.type !== 'tool/result') return
    const message = event.data?.message
    if (!message || message.role !== 'tool') return
    const text = textOfMessage(message)
    if (!text.startsWith(SELF_MARK)) return
    const seq = event.seq
    // 等这一轮事件派发完再替换，别在 append 回调里直接 append
    queueMicrotask(() => {
      try {
        const target = listSurface(agent.session).find((item) => item.seq === seq)
        if (target) foldResult(ctx, agent.session, target, '选择本身')
      } catch (err) {
        warn('折叠自身结果失败：', err?.message || err)
      }
    })
  }

  // 「默认不保留」：某些工具的结果，这一轮用完、回合结束就折叠掉
  const sweep = (agent, why) => {
    const names = new Set(config.autoForget || [])
    const all = config.autoForgetAll === true
    if (!all && !names.size) return
    try {
      let folded = 0
      for (const item of listSurface(agent.session)) {
        if (item.event.type !== 'tool/result') continue
        const message = item.event.data?.message
        if (!message) continue
        if (textOfMessage(message).startsWith(FOLDED)) continue
        const toolName = toolNameOfCall(agent.session, message.toolCallId || message.source?.callId)
        if (!all && !names.has(toolName)) continue
        if (foldResult(ctx, agent.session, item, '默认不保留')) folded++
      }
      if (folded) log(`${why}：按「默认不保留」折叠了 ${folded} 条`)
    } catch (err) {
      warn('默认折叠失败：', err?.message || err)
    }
  }

  const watch = (agent) => {
    if (!agent || watched.has(agent)) return
    if (!allowed(agent)) return
    watched.add(agent)
    try {
      disposers.set(agent, agent.ctx.tools.register(tool(ctx)))
      agent.ctx.on('session/event', (_subject, event) => foldSelf(agent, event))
      agent.ctx.on('agent/turn-stopping', () => sweep(agent, '回合结束'))
      agent.ctx.on('agent/status', () => {
        if (agent.status !== 'running') sweep(agent, '空闲')
      })
      agent.ctx.on('dispose', () => {
        watched.delete(agent)
        const off = disposers.get(agent)
        disposers.delete(agent)
        try {
          if (typeof off === 'function') off()
        } catch (error) {}
      })
      log(`已挂到会话 ${agent.session?.id || agent.id}`)
    } catch (err) {
      warn('挂工具失败：', err?.message || err)
    }
  }

  ctx.on('agent/created', (payload) => {
    try {
      watch(payload?.agent)
    } catch (err) {
      warn('处理 agent/created 失败：', err?.message || err)
    }
  })

  try {
    for (const agent of ctx.agents.list()) watch(agent)
  } catch (err) {
    warn('读现有 agent 失败：', err?.message || err)
  }

  const timer = setInterval(() => {
    try {
      for (const agent of ctx.agents.list()) watch(agent)
    } catch (error) {}
  }, refreshMs)
  if (typeof timer.unref === 'function') timer.unref()
  ctx.on('dispose', () => clearInterval(timer))

  const auto = config.autoForgetAll ? '全部工具' : (config.autoForget || []).join('/')
  log(`就绪：预设 ${[...presets].join('/') || '全部'}，工具 forget_tool_results${auto ? `，默认不保留：${auto}` : ''}`)
  void FOLDED
}
