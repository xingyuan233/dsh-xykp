// qq-adapter · QQ 侧指令系统
//
// 主人 2026-10-28 定的规矩：
//   · 不做伪群组、不做中文别名、不做"管理员替别人切会话"
//   · 一个会话就是一个会话，id 由我们自己起：<前缀>-<日期>-<随机>
//   · 私聊切绑定不用权限；群聊 / 预设相关要权限（ownerUids）
//   · 配置类指令带 -d：顺手把「部署默认」也改掉
//
// 这个模块只做「解析 + 分发 + 文案」，真正的动作（建会话、切绑定、调模型）
// 由 index.js 传进来的 actions 接口完成，方便单测。

export const HELP_GROUPS = ['会话', '配置', '适配层', '操作', '查询']

/** 指令表：row 顺序 = /help 里的顺序 */
export const COMMANDS = [
  // ── 会话 ──
  {
    name: 'new', needsOwner: false, usage: '/new', group: '会话',
    help: '开一个新会话（id 形如 qq-20261028-ab12），并把这个聊天绑过去',
  },
  {
    name: 'session', needsOwner: false, usage: '/session [-[[offset,]n]] [-del]', group: '会话',
    help: '列出/切换历史会话；默认最新 6 条，-10 是最新 10 条，-10,5 是从第 10 条起 5 条；-del 删除指定会话',
  },
  {
    name: 'compact', needsOwner: false, usage: '/compact', group: '会话',
    help: '把当前会话压缩成一段交接摘要，开一个新会话接手，并把绑定改过去',
  },

  // ── 配置 ──
  { name: 'model', needsOwner: true, usage: '/model [provider model | 序号] [-d]', group: '配置', help: '查看/切换当前会话的模型；-d 同时改部署默认' },
  { name: 'level', needsOwner: true, usage: '/level [序号|id] [-d]', group: '配置', help: '查看/设置推理等级；-d 同时改默认' },
  { name: 'workspace', needsOwner: true, usage: '/workspace [路径|序号] [-d]', group: '配置', help: '查看/切换工作区；-d 同时改默认' },
  { name: 'preset', needsOwner: true, usage: '/preset [id|序号] [-d]', group: '配置', help: '查看/切换 agent 预设；-d 同时改默认' },
  { name: 'permission', needsOwner: true, usage: '/permission [c|w|f|预设名] [-d]', group: '配置', help: '切换权限预设；-d 同时改默认' },

  // ── 适配层（qq-adapter 自己的配置）──
  { name: 'cfg-default', needsOwner: true, usage: '/cfg-default [p-预设|s-会话|QQ号]', group: '适配层', help: '查看/设置这个聊天的默认目标' },
  { name: 'cfg-mode', needsOwner: true, usage: '/cfg-mode [blacklist|whitelist]', group: '适配层', help: '查看/切换名单模式' },
  { name: 'cfg-list', needsOwner: true, usage: '/cfg-list [-add u-xxx|g-xxx] [-del 序号|键] [blocked|allowed|fast]', group: '适配层', help: '查看/增删名单（blocked=禁用、allowed=白名单、fast=免合并）' },
  { name: 'cfg-table', needsOwner: true, usage: '/cfg-table [-set u-xxx target] [-del u-xxx]', group: '适配层', help: '查看/设置映射表（一个聊天 → 一个目标，键值对形式）' },

  // ── 操作 ──
  { name: 'free', needsOwner: false, usage: '/free', group: '操作', help: '看一眼这个会话是不是在跑（卡在审批/长任务时用；只读，不动它）' },
  { name: 'stop', needsOwner: true, usage: '/stop', group: '操作', help: '停掉这个会话当前正在跑的东西' },

  // ── 查询 ──
  { name: 'status', needsOwner: false, usage: '/status', group: '查询', help: '这个聊天的全景：绑定、会话、预设、状态' },
  { name: 'ver', needsOwner: false, usage: '/ver', group: '查询', help: '插件版本 + 桥是否活着（快速自检）' },
  { name: 'help', needsOwner: false, usage: '/help', group: '查询', help: '本帮助' },
]

export const COMMAND_INDEX = new Map(COMMANDS.map((c) => [c.name, c]))

export function helpText() {
  const byGroup = new Map()
  for (const c of COMMANDS) {
    const list = byGroup.get(c.group) || []
    list.push(c)
    byGroup.set(c.group, list)
  }
  const lines = []
  for (const g of HELP_GROUPS) {
    const rows = byGroup.get(g)
    if (!rows || !rows.length) continue
    lines.push(`【${g}】`)
    for (const c of rows) lines.push(`  ${c.usage.padEnd(46, ' ')} ${c.help}`)
    lines.push('')
  }
  lines.push('配置类指令加 -d 会同时改「部署默认」；不带 / 的消息才会交给模型。')
  return lines.join('\n')
}

/** 解析一行指令；不是指令就返回 null */
export function parseCommand(text) {
  const raw = String(text || '').trim()
  if (!raw.startsWith('/')) return null
  const body = raw.slice(1)
  if (!body) return { name: '', arg: '', raw }
  const m = /^([a-zA-Z][a-zA-Z0-9-]*)\s*([\s\S]*)$/.exec(body)
  if (!m) return { name: body.split(/\s+/)[0] || '', arg: '', raw }
  return { name: m[1].toLowerCase(), arg: m[2] || '', raw }
}

/** 解析 /session 的参数： [-[[offset,]n]] [-del] */
export function parseSessionArgs(arg) {
  const out = { offset: 0, count: 6, del: false, index: null, bad: '' }
  const tokens = String(arg || '').split(/\s+/).filter(Boolean)
  for (const t of tokens) {
    if (t === '-del') { out.del = true; continue }
    if (/^\d+$/.test(t)) { out.index = Number(t); continue }
    const m = /^-(\d+)?(?:,(\d+))?$/.exec(t)
    if (m) {
      const a = m[1] === undefined ? null : Number(m[1])
      const b = m[2] === undefined ? null : Number(m[2])
      if (a !== null && b !== null) { out.offset = a; out.count = b }
      else if (a !== null) { out.offset = 0; out.count = a }
      continue
    }
    out.bad = t
  }
  if (out.count <= 0) out.count = 6
  return out
}

/** 解析 -d / 其它开关 */
export function parseFlags(arg) {
  const tokens = String(arg || '').split(/\s+/).filter(Boolean)
  const flags = new Set()
  const rest = []
  for (const t of tokens) {
    if (t === '-d' || t === '--default') flags.add('default')
    else flags.add(t)
  }
  return { flags, args: rest.concat(tokens.filter((t) => !t.startsWith('-') || t === '-d')) }
}

export function isOwner(senderUid, cfg) {
  const uid = String(senderUid || '').trim()
  if (!uid) return false
  if (cfg.selfUid && uid === cfg.selfUid) return true
  const norm = (s) => String(s || '').trim().replace(/^u-/, '')
  const list = Array.isArray(cfg.ownerUids) ? cfg.ownerUids : []
  return list.some((x) => norm(x) === norm(uid))
}
