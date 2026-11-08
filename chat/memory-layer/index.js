// memory-layer：以概念为核心的联想记忆
//   · 只扫 user / assistant 的正文，不扫 reasoning、不扫工具返回
//   · 命中就用 systemPrompt.context 每轮注入，不改前缀、不多一轮
//   · 所有写操作收进一个工具 memory_ctrl，返回里带 eventId
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { MemoryLayer } from './lib/layer.mjs'
import { normalizeKey } from './lib/key.mjs'
import { configFor } from '../../ui/store.js'

export const name = 'memory-layer'
export const inject = ['agents', 'agentPresets', 'tools']

const HOME = process.env.DSH_HOME || path.join(homedir(), '.dsh')
const ROOT = path.join(HOME, 'xykp', 'memory-layer')
const LAYERS = path.join(ROOT, 'layers')
const BACKUPS = path.join(ROOT, 'backups')
const LOCKS = path.join(ROOT, 'locks')
const DAY = 86400000

const DEFAULT_CONFIG = {
  // 绑定哪些预设；null = 全部预设，[] = 都不生效。默认只挂 test，避免误伤
  presets: ['test'],
  injectOrder: 960,
  eventBudget: 4,
  charBudget: 320,
  // 日更新：启动时一次 + 每天这个点
  dailyAt: '04:00',
  // 一轮里最多扫多少字，太长的正文截断再扫
  maxScanChars: 4000,
  // 可视化服务端口，0 = 不启动
  vizPort: 3099,
  // 备份保留几天，每天一份；0 = 不备份
  backupDays: 7,
}

// 配置统一走 xykp 的 config.yml（memory-layer: 段），也可以放 $DSH_HOME/memory-layer/config.json 覆盖
function loadConfig() {
  let cfg = DEFAULT_CONFIG
  try { cfg = configFor('memory-layer', DEFAULT_CONFIG) } catch {}
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
    cfg = { ...cfg, ...j }
  } catch {}
  return cfg
}

// ── 库（一个预设一个）────────────────────────────
const stores = new Map()
const queues = new Map()

function withLock(key, fn) {
  const prev = queues.get(key) || Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(key, next.catch(() => {}))
  return next
}

function layerFile(preset) {
  return path.join(LAYERS, preset + '.json')
}

function openStore(preset, cfg) {
  if (stores.has(preset)) return stores.get(preset)
  fs.mkdirSync(LAYERS, { recursive: true })
  fs.mkdirSync(LOCKS, { recursive: true })

  let layer
  try {
    layer = MemoryLayer.fromJSON(JSON.parse(fs.readFileSync(layerFile(preset), 'utf8')))
  } catch {
    layer = new MemoryLayer()
  }

  const st = {
    preset,
    layer,
    cfg,
    pending: [],      // 本轮要注入的事件
    lastPushed: [],   // 本轮推出去的，用来判命中
    lastSavedAt: 0,
    lastDay: Math.floor(Date.now() / DAY),
  }
  stores.set(preset, st)
  return st
}

function backup(st) {
  const keep = Number(st.cfg.backupDays ?? 7)
  if (!keep) return
  try {
    const day = new Date().toISOString().slice(0, 10)
    const target = path.join(BACKUPS, st.preset + '-' + day + '.json')
    if (!fs.existsSync(target)) {
      fs.mkdirSync(BACKUPS, { recursive: true })
      const src = layerFile(st.preset)
      if (fs.existsSync(src)) fs.copyFileSync(src, target)
    }
    // 清掉超过 keep 天的
    const cutoff = new Date(Date.now() - keep * DAY).toISOString().slice(0, 10)
    for (const name of fs.readdirSync(BACKUPS)) {
      if (!name.startsWith(st.preset + '-') || !name.endsWith('.json')) continue
      const d = name.slice(st.preset.length + 1, -5)
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) fs.unlinkSync(path.join(BACKUPS, name))
    }
  } catch (e) {
    console.error('[memory-layer] 备份失败:', e?.message)
  }
}

function save(st, force = false) {
  const now = Date.now()
  if (!force && now - st.lastSavedAt < 1500) return
  st.lastSavedAt = now
  try {
    const f = layerFile(st.preset)
    const tmp = f + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(st.layer.toJSON()), 'utf8')
    fs.renameSync(tmp, f)
    backup(st)
  } catch (e) {
    console.error('[memory-layer] 存盘失败:', e?.message)
  }
}

// ── 扫描与注入 ───────────────────────────────────
function textOfMessage(msg) {
  const c = msg?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  const parts = []
  for (const p of c) {
    if (!p || typeof p !== 'object') continue
    // 思考 / 工具调用 / 工具结果一律不扫
    if (p.type === 'text' || p.type === 'text_delta') parts.push(p.text ?? '')
  }
  return parts.join('\n')
}

function scanAndInject(st, text) {
  const L = st.layer
  const clipped = text.length > st.cfg.maxScanChars ? text.slice(0, st.cfg.maxScanChars) : text
  const hit = L.matchConcepts(clipped)
  if (!hit.size) return false

  const now = Date.now() / DAY
  for (const cid of hit) {
    const c = L.concepts.get(cid)
    if (c) c.cm.touch(L.turn, now)
  }

  const rows = L.retrieve(clipped, { eventBudget: st.cfg.eventBudget, charBudget: st.cfg.charBudget })
  if (!rows.length) return false
  L.markPushed(rows, L.turn)
  st.pending = rows
  st.lastPushed = rows
  save(st, true)
  return true
}

function injectText(st) {
  const rows = st.pending
  if (!rows.length) return ''
  const lines = rows.map((r) => {
    const e = r.event
    let s = `event-${e.id}: ${e.brief}`
    if (e.detail && e.detail.type === 'path' && e.detail.value) s += ` | ${e.detail.value}`
    else if (e.detail && e.detail.type === 'web' && e.detail.value) s += ` | ${e.detail.value}`
    return s
  })
  return `【相关记忆】\n${lines.join('\n')}\n（要展开某条就用 memory_ctrl get eventId=${rows[0].event.id} 之类的 id）`
}

// ── 工具 ─────────────────────────────────────────
function makeTool(st) {
  const L = st.layer
  return {
    name: 'memory_ctrl',
    description:
      '长期记忆。add 记下这次对话里以后还该记得的事：约定、决定、ta 的偏好和状态、重要的细节、' +
      '你自己的判断里不想丢的部分。不用每轮都记，只在真的有东西值得留的时候。' +
      'brief 要能独立看懂（别写「刚才那个」），人称用 ta / 我；concepts 给最简短的名词，' +
      '不要用人称代词当关键词；match 0-1 表示这件事有多依赖这个词。长的内容落盘写路径。' +
      'forget 按 eventId 忘掉（关联清零但记录留着），delete 是真删（连关联一起），compact 清一次垃圾，' +
      'get 取详情，list 检索，stats 看规模。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'forget', 'delete', 'compact', 'get', 'list', 'stats'],
          description: '要做什么',
        },
        brief: { type: 'string', description: 'add：一句话简述，能独立看懂' },
        concepts: {
          type: 'array',
          description: 'add：关键词及关联度。关键词用最简短的名词，不要带人称代词',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              match: { type: 'number', description: '0-1' },
            },
            required: ['key'],
          },
        },
        detail: { type: 'string', description: 'add：详细内容或文件路径（没有就不填，尽量落盘用路径）' },
        detailType: { type: 'string', enum: ['path', 'text', 'web'], description: 'add：详情类型，默认 path' },
        eventId: { type: 'number', description: 'forget / get：事件 id' },
        keyword: { type: 'string', description: 'list：按关键词过滤' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } } },
      render(_args, value) {
        return [{ type: 'text', text: value?.text ?? '' }]
      },
    },
    async execute(args) {
      const act = args?.action
      if (act === 'add') {
        if (!args.brief) return { text: '缺少 brief' }
        const cs = (args.concepts ?? [])
          .filter((c) => c && c.key && normalizeKey(c.key))
          .map((c) => ({ key: c.key, match: typeof c.match === 'number' ? c.match : 0.7 }))
        if (!cs.length) return { text: '至少要给一个有效概念（不能是空的或纯符号）' }
        const warn = []
        if (cs.some((c) => c.match < 0 || c.match > 1)) warn.push('match 超出 0-1，已截断')
        if (args.detailType && !['path', 'text', 'web'].includes(args.detailType)) {
          warn.push(`detailType「${args.detailType}」不认识，按 path 存`)
        }

        // 一模一样的事件不要重复存
        const dup = [...L.events.values()].find((e) => !e.forgotten && e.brief === args.brief)
        if (dup) {
          return { text: `已存在 event-${dup.id}：${dup.brief}（没有重复存）` }
        }
        const ev = await withLock(st.preset, async () => {
          const e = L.addEvent({
            brief: args.brief,
            concepts: cs,
            detail: args.detail
              ? { type: ['path', 'text', 'web'].includes(args.detailType) ? args.detailType : 'path', value: args.detail }
              : null,
          })
          save(st, true)
          return e
        })
        return { text: `已记下 event-${ev.id}：${args.brief}` + (warn.length ? `（${warn.join('；')}）` : '') }
      }

      if (act === 'forget') {
        if (!args.eventId) return { text: '缺少 eventId' }
        const ok = await withLock(st.preset, async () => {
          const r = L.forget(args.eventId)
          save(st, true)
          return r
        })
        return { text: ok ? `event-${args.eventId} 已忘记（关联清零）` : `没找到 event-${args.eventId}` }
      }

      if (act === 'delete') {
        if (!args.eventId) return { text: '缺少 eventId' }
        const ok = await withLock(st.preset, async () => {
          const r = L.deleteEvent(args.eventId)
          save(st, true)
          return r
        })
        return { text: ok ? 'event-' + args.eventId + ' 已删除（连它的关联一起）' : '没找到 event-' + args.eventId }
      }

      if (act === 'compact') {
        const r = await withLock(st.preset, async () => {
          const x = L.compact()
          save(st, true)
          return x
        })
        return { text: '清掉已忘记的事件 ' + r.events + ' 条、空概念 ' + r.concepts + ' 个' }
      }

      if (act === 'get') {
        const raw = L.events.get(args.eventId)
        if (!raw) return { text: `没找到 event-${args.eventId}` }
        if (raw.forgotten) return { text: `event-${args.eventId} 已经被忘记了` }
        const ev = L.recall(args.eventId)
        const keys = ev.refs.map((l) => {
          const c = L.concepts.get(l.cid)
          return c ? `${c.key}(${l.ce.long.toFixed(2)})` : null
        }).filter(Boolean)
        return {
          text: `event-${ev.id}: ${ev.brief}\n关键词: ${keys.join(' / ')}\n` +
            (ev.detail ? `详情(${ev.detail.type}): ${ev.detail.value}` : '（没有详细内容）'),
        }
      }

      if (act === 'list') {
        const kw = args.keyword ? normalizeKey(args.keyword) : ''
        const hitC = (c) => !kw || c.key.includes(kw)
        const hitE = (e) => !kw || (e.refs || []).some((l) => {
          const c = L.concepts.get(l.cid)
          return c && c.key.includes(kw)
        })
        const allC = [...L.concepts.values()].filter(hitC)
        const allE = [...L.events.values()].filter((e) => !e.forgotten && hitE(e))
        const cs = allC.sort((a, b) => b.df - a.df).slice(0, 60).map((c) => `${c.key}(${c.df})`)
        const es = allE.slice(-40).map((e) => `event-${e.id}: ${e.brief}`)
        const more = []
        if (allC.length > 60) more.push(`概念还有 ${allC.length - 60} 个没列`)
        if (allE.length > 40) more.push(`事件还有 ${allE.length - 40} 条没列`)
        return {
          text: (kw ? `过滤「${args.keyword}」：` : '') +
            `概念 ${allC.length} 个 / 事件 ${allE.length} 条\n${cs.join('  ') || '（无）'}\n\n最近事件：\n${es.join('\n') || '（无）'}` +
            (more.length ? `\n（${more.join('；')}）` : ''),
        }
      }

      if (act === 'stats') {
        const s = L.stats()
        return { text: `${s.concepts} 概念 / ${s.events} 事件 / ${s.edges} 关联 / 第 ${L.turn} 回合` }
      }

      return { text: `未知 action: ${act}` }
    },
  }
}

// ── 插件主体 ─────────────────────────────────────
export function apply(ctx, config) {
  boot(ctx, config).catch((e) => {
    try {
      fs.mkdirSync(ROOT, { recursive: true })
      fs.appendFileSync(path.join(ROOT, 'boot-error.log'),
        new Date().toISOString() + '\n' + (e?.stack || e?.message || String(e)) + '\n\n')
    } catch {}
    console.error('[memory-layer] boot 失败:', e?.message)
  })
}

async function boot(ctx) {
  const cfg = loadConfig()
  const disposers = new Map()

  const allowed = (agent) => {
    if (!cfg.presets) return true
    const id = ctx.agentPresets.composedPreset(agent.ctx)
    return cfg.presets.includes(id)
  }

  function store(agent) {
    const id = ctx.agentPresets.composedPreset(agent.ctx) || 'default'
    return openStore(id, cfg)
  }

  function onSessionEvent(agent, event) {
    // user/message：event.data 就是 message；assistant/message：event.data.message
    const type = event?.type
    let msg
    let role
    if (type === 'user/message') { msg = event.data; role = 'user' }
    else if (type === 'assistant/message') { msg = event?.data?.message; role = 'assistant' }
    else {
      msg = event?.data?.message ?? event?.message
      if (!msg) return
      role = msg.role
    }
    if (!msg || (role !== 'user' && role !== 'assistant')) return
    const st = store(agent)
    // 空正文（纯图片/纯文件）也算一轮，否则 pending 会一直不刷新
    if (role === 'user') {
      st.layer.nextTurn()
      st.pending = []
      st.lastPushed = []
    }

    const text = textOfMessage(msg)
    if (!text) return

    if (role === 'assistant' && st.lastPushed.length) {
      // 模型这一轮说的话，用来判定上一轮推出去的东西有没有被用上
      st.layer.feedback(st.lastPushed, text)
      st.lastPushed = []
    }
    scanAndInject(st, text)
  }

  function watch(agent) {
    if (disposers.has(agent)) return
    if (!allowed(agent)) return
    const st = store(agent)

    const ds = []
    ds.push(agent.ctx.tools.register(makeTool(st)))
    ds.push(agent.ctx.systemPrompt.context({
      name: 'memory-layer',
      order: cfg.injectOrder,
      text: () => injectText(st),
    }))
    // 很短的常驻约定，告诉模型这套东西在、以及什么时候该写
    ds.push(agent.ctx.systemPrompt.context({
      name: 'memory-layer-note',
      order: cfg.injectOrder + 1,
      text: () =>
        '【记忆】遇到以后还该记得的事（约定、决定、ta 的偏好与状态、重要细节）就用 memory_ctrl add 记下，' +
        '不用每轮都记；记完不用特意说出来。',
    }))
    ds.push(agent.ctx.on('session/event', (_subject, event) => onSessionEvent(agent, event)))
    ds.push(agent.ctx.on('agent/turn-stopping', () => {
      // 这一轮结束：拿本轮输出回填命中，然后结算走过的边
      st.layer.settle()
      save(st, true)
    }))
    ds.push(agent.ctx.on('dispose', () => save(st, true)))
    disposers.set(agent, ds)
  }

  ctx.on('agent/created', ({ agent }) => watch(agent))
  for (const agent of ctx.agents.list()) watch(agent)

  // 可视化服务跟着插件一起起，dsh 重启它也就自动回来了
  if (cfg.vizPort !== 0) {
    try {
      const { startVizServer } = await import('./viz/server.mjs')
      startVizServer({ port: cfg.vizPort ?? 3099, layersDir: LAYERS, seed: false })
    } catch (e) {
      console.error('[memory-layer] 可视化没起来:', e?.message)
    }
  }

  // 日更新：启动一次 + 每天定点
  const dailyTick = () => {
    const today = Math.floor(Date.now() / DAY)
    for (const st of stores.values()) {
      if (today > st.lastDay) {
        st.lastDay = today
        save(st, true)
      }
    }
  }
  dailyTick()
  setInterval(dailyTick, 10 * 60 * 1000)
}

