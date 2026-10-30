// qq-adapter · 宿主半边
//
// 干的事：
//   1. 轮询 QQ 桥（127.0.0.1:39272）的 /events，把新消息按分流规则送进对应的会话/预设
//   2. 提供 qq_send / qq_status 两个工具，让我能回消息、看桥的状态
//
// 分流规则写在插件的 Config 里 —— 也就是 Web 设置页那一层（cordis.patch.yml），
// 改完是 **live 生效**，不用重启宿主。
//
// 任何异常只记日志，绝不拖死宿主。

import { access, readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { chatKeyOf, resolveRoute, parseTargetRef, formatIncoming, DEFAULTS as ROUTER_DEFAULTS } from './router.js'
import { createPostWatcher } from './post-watch.js'
import { createBridge } from './bridge.js'
import { toSilk, cleanupSilk } from './silk.js'
import { readOverride, pickRouting, overridePath } from './overrides.js'
import { COMMANDS, COMMAND_INDEX, helpText, parseCommand, parseSessionArgs, isOwner } from './commands.js'
import { readChats, writeChats, newSessionId, listSessions, deleteSessionDir, ago, listWorkspaces, presetPools } from './session-store.js'

export const name = 'qq-adapter'

/** 必须先拿到 agents（推消息进会话）；tools 没有也能跑（自测环境）；systemPrompt 用来塞「QQ 通道权限不够怎么办」 */
export const inject = ['agents', 'tools', 'systemPrompt']

/** 这条 user/message 的来源（宿主要求每条消息都有 source.kind） */
export const SOURCE_KIND = 'plugin:qq-adapter'

/** /ver 里显示的版本（改代码时顺手改一下） */
const PKG_VERSION = '0.2.0'

const log = (...a) => console.log('[qq-adapter]', ...a)
const warn = (...a) => console.warn('[qq-adapter]', ...a)

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('总开关（关掉就只保留工具，不再自动转发）'),
  bridgeUrl: Schema.string().default('http://127.0.0.1:39272').description('QQ 桥的 HTTP 地址'),
  selfUid: Schema.string().default('u_BsJrCaYeH77_OZ78H5pEXA').description('机器人自己的 uid（自己的消息不转发）'),
  defaultTarget: Schema.string().default('p-alive').description('默认目标：p-<预设名> 或 s-<会话id>'),
  mode: Schema.union([Schema.const('blacklist'), Schema.const('whitelist')]).default('blacklist')
    .description('名单模式：blacklist=名单里的不转，whitelist=只转名单里的'),
  blocked: Schema.array(Schema.string()).default([]).description('黑名单：u-<uid> / g-<群号>'),
  allowed: Schema.array(Schema.string()).default([]).description('白名单：u-<uid> / g-<群号>'),
  mappings: Schema.array(Schema.object({
    chat: Schema.string().description('u-<uid> 或 g-<群号>'),
    target: Schema.string().description('p-<预设名> 或 s-<会话id>'),
  })).default([]).description('自定义映射（优先于名单）'),
  deliverMode: Schema.union([Schema.const('steer'), Schema.const('followup')]).default('steer')
    .description('转发方式：steer=插队（这轮就能看到）/ followup=排队（下轮才看到）'),
  pollMs: Schema.number().default(1500).description('轮询间隔（毫秒）'),
  maxPerTick: Schema.number().default(10).description('一次最多转发几条'),
  coalesceSeconds: Schema.number().default(10).description('合并窗口（秒）：同一个聊天里的消息攒到「静默这么久」再一次性发；0 = 不合并，来一条转一条'),
  fastUids: Schema.array(Schema.string()).default([]).description('不受限的聊天（u-<uid> / g-<群号>），这些来一条转一条'),
  ownerUids: Schema.array(Schema.string()).default([]).description('能发管理类指令的人（写 uid 或 u-<uid> 都行）；私聊切换不需要，群聊/预设相关才要'),
  workspaceRoot: Schema.string().default('D:\\\\AI\\\\DeepseekHarness\\\\workspaces\\\\alive-workspace').description('新会话默认挂哪个工作区'),
  commandsEnabled: Schema.boolean().default(true).description('QQ 侧指令开关（关掉就全当普通消息）'),
  groupWake: Schema.union([Schema.const('mention'), Schema.const('all')]).default('mention')
    .description('群聊怎么唤醒对话：mention = 只有 @ 到自己（或 @ 完后面跟 / 指令）才转进会话；all = 群里每条都转'),
  autoReply: Schema.boolean().default(true)
    .description('QQ 来的消息跑完这一轮，把最终回复自动发回来源聊天（回复是 [[SILENT]]、或者这一轮已经用工具发过同样的话，就不重复发）'),
  instanceId: Schema.string().default('default').description('实例名：同一个宿主跑多个账号时用来隔开去重文件/内部状态'),
  toolPrefix: Schema.string().default('').description('工具名前缀（同一个宿主跑两个 QQ 账号时，第二个实例用 qq2_ 之类，免得多实例抢同名工具）'),
  seenPath: Schema.string().default('').description('去重记录文件（空 = <DSH_HOME>/qq-adapter/seen-<instanceId>.json）'),
  skipBacklog: Schema.boolean().default(true).description('启动时不补发桥里积压的旧消息'),
  notifyTopic: Schema.string().default('whale-qq-shell-channel').description('登录失效时把二维码推到哪个 ntfy 主题（空 = 不推）'),
  notifyEveryMinutes: Schema.number().default(3).description('两次推码之间至少隔几分钟'),
  notifyMax: Schema.number().default(3).description('一次掉线最多推几张码'),
  postCommand: Schema.string().default('/post')
    .description('自动推码次数用完后，在 ntfy 主题里等这条消息，收到就再补推一张；空 = 不监听'),
  qrFile: Schema.string().default('D:\\\\AI\\\\DeepseekHarness\\\\home\\\\xykp\\\\qq-adapter\\\\qq-qr-fresh.png').description('桥写出来的二维码图片路径（数据目录，别放工作区）'),
  autoStartShell: Schema.boolean().default(true).description('桥没在跑时自动拉起 QQ shell'),
  shellBootPath: Schema.string().default('D:\\\\Program-Files\\\\QQ-shell\\\\NapCatWinBootMain.exe').description('shell 启动器路径'),
  shellDir: Schema.string().default('D:\\\\Program-Files\\\\QQ-shell').description('shell 工作目录'),
  ffmpegPath: Schema.string().default('ffmpeg').description('发语音时转 PCM 用的 ffmpeg（PATH 里没有就给绝对路径）'),
  silkEncoderPath: Schema.string().default('D:\\\\AI\\\\DeepseekHarness\\\\tools\\\\silk\\\\silk_encode.exe').description('silk 编码器路径（自编的 silk_encode.exe）'),
  permissionNote: Schema.boolean().default(true).description('往系统提示词里塞「QQ 通道权限不够怎么办」那段'),
})

const home = () => process.env.DSH_HOME || join(homedir(), '.dsh')

/**
 * 桥的代码（qq-bridge-script.js / make-qr.py）只放在插件包 bridge/ 里，由 QQ 壳的
 * dsh-loader 直接 eval；工作区里不再放任何桥文件（放那儿迟早被清理掉）。
 * 运行时数据（日志、二维码、命令文件、媒体）统一落在 <DSH_HOME>\xykp\qq-adapter。
 */
const BRIDGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'bridge')
const QQ_DATA_DIR = join(home(), 'xykp', 'qq-adapter')

export async function ensureDataDir(qrFile) {
  const target = dirname(String(qrFile || '')) || QQ_DATA_DIR
  try {
    await mkdir(target, { recursive: true })
  } catch (err) {
    warn(`建数据目录失败：${target}：${err?.message || err}`)
  }
  // 代码文件没了是部署问题，只提醒，不往工作区乱放
  for (const name of ['qq-bridge-script.js', 'make-qr.py', 'dsh-loader.js']) {
    try {
      await access(join(BRIDGE_DIR, name))
    } catch {
      warn(`插件里缺桥文件：${join(BRIDGE_DIR, name)}`)
    }
  }
  return target
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
}

async function writeJson(path, data) {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(data, null, 2), 'utf8')
  } catch (err) { warn('写 ' + path + ' 失败：', err?.message || err) }
}

async function loadBinder() {
  return readJson(join(home(), 'xykp', 'preset-binder', 'preset-binder.json'), null)
}

/** p-<预设> / s-<会话id> → 真正的会话 id */
async function resolveTarget(targetRef) {
  const ref = parseTargetRef(targetRef)
  if (ref.kind === 'none') return { sessionId: '', reason: '目标为空' }
  if (ref.kind === 'session') return { sessionId: ref.value, via: 'session' }
  const binder = await loadBinder()
  const active = binder && binder.presets && binder.presets[ref.value] && binder.presets[ref.value].active
  if (active && String(active).trim()) return { sessionId: String(active).trim(), via: 'preset', preset: ref.value }
  return { sessionId: '', reason: '预设 ' + ref.value + ' 没有活跃会话' }
}

/** 找 agent（会话 id 有带/不带 session- 前缀两种写法） */
function findAgent(agents, sessionId) {
  const cands = [String(sessionId)]
  if (String(sessionId).startsWith('session-')) cands.push(String(sessionId).slice('session-'.length))
  else cands.push('session-' + sessionId)
  for (const id of cands) {
    try {
      const a = agents.get(id)
      if (a) return a
    } catch { /* 查不到当没有 */ }
  }
  return null
}

// 统一算「这个 agent 该用哪个 provider/model」——create 和 resume 都必须带。
// ⚠ 2026-10-29：resume 那条分支以前只传 resumeSessionId，宿主重启后所有活着的绑定
//   每一轮都炸 `agent "session-…" has no provider/model`（session-12ecb406 就这么废的）
function resolveAgentOptions(ctx, prefs = null) {
  try {
    const dm = ctx && typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null
    const sel = prefs && prefs.model
      ? { provider: prefs.model.provider, model: prefs.model.model, reasoningEffort: prefs.level }
      : (dm && dm.currentSelection ? dm.currentSelection() : null)
    if (sel && sel.provider && sel.model) {
      const out = { provider: sel.provider, model: sel.model }
      if (sel.reasoningEffort) out.reasoningEffort = sel.reasoningEffort
      return out
    }
  } catch (err) { warn('拿默认模型失败：', err?.message || err) }
  return null
}

async function deliver(agentsSvc, sessionId, text, mode = 'steer', ctx = null) {
  let agent = findAgent(agentsSvc, sessionId)
  if (!agent) {
    // 宿主重启后，`/new` 建的那些会话没有活着的 agent —— 按 id resume 回来再投
    // （2026-10-28：以前这里直接抛「找不到了」，等于重启后 /new 的绑定全废）
    try {
      const resumeOpts = { resumeSessionId: sessionId }
      const resumeAgentOptions = resolveAgentOptions(ctx)
      if (resumeAgentOptions) resumeOpts.agentOptions = resumeAgentOptions
      const h = await agentsSvc.resume(resumeOpts)
      agent = (h && h.agent) || findAgent(agentsSvc, sessionId)
      // ⚠ resume 出来的 agent **没有挂预设** → 消息进去了但这一轮根本跑不起来
      //   （实测：qq-20261028-ry86 的会话文件一直停在创建那一刻，不涨）
      try {
        const presets = ctx && typeof ctx.get === 'function' ? ctx.get('agentPresets') : null
        const header = agent && agent.session && agent.session.header
        const want = String((header && (header.agentPreset || header.preset)) || '')
        const has = presets && typeof presets.composedPreset === 'function' ? presets.composedPreset(agent.ctx) : ''
        if (presets && want && !has && typeof presets.mount === 'function') {
          await presets.mount(agent.ctx, want)
          log('resume 后补挂预设：' + want + '（' + sessionId + '）')
        }
      } catch (err) { warn('resume 后补挂预设失败：', err?.message || err) }
    } catch (err) {
      warn('resume ' + sessionId + ' 失败：', err?.message || err)
    }
  }
  if (!agent) throw new Error('会话 ' + sessionId + ' 找不到了（可能被归档/删了）')
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND },
  })
  // 空闲的 agent 用 steer 也能唤醒（send 的 wakeup=true），但 running 的时候用 steer 才不打断
  if (mode === 'steer' && typeof agent.steer === 'function') {
    await agent.steer(message)
    return { delivered: true, via: 'steer' }
  }
  await agent.followup(message)
  return { delivered: true, via: 'followup' }
}

export async function apply(ctx, config = {}) {
  const cfg = { ...ROUTER_DEFAULTS, ...Config(config) }
  // 数据目录（日志/二维码/命令文件）确保存在；桥代码只在插件包里
  await ensureDataDir(cfg.qrFile)
  const bridge = createBridge(cfg.bridgeUrl, { timeoutMs: 4000 })
  // 在 apply（还活着）的时候就把 agents 抓住，定时器里不再碰 ctx
  const agentsSvc = ctx.agents
  const INST = String(cfg.instanceId || 'default')
  const TP = (n) => String(cfg.toolPrefix || '') + n
  // 2026-10-29：把 home\AGENTS.md 里的「QQ 通道权限不够怎么办」搬进系统提示词。
  // 为什么要进提示词：QQ 那边没人点审批卡，走一次 Web 审批这一轮就卡死，
  // 这条规矩得每轮都在视野里，不能只躺在 AGENTS.md 里等模型自己去翻。
  if (cfg.permissionNote !== false) {
    try {
      const 权限说明 = [
        '## QQ 通道权限不够怎么办',
        '',
        '- 这条只对**从 QQ 通道来的指令**生效（主人在 QQ 里发消息，人大概率不在电脑边）。',
        '  遇到**权限不足**（workspace-write 拦下的写操作、需要审批的命令等）时，**绝对不要**去走 Web 端权限申请 / 审批卡：',
        '  没人会点，会把这一轮对话直接卡死。',
        '- 正确做法：立刻在 QQ 里发一段纯文字，说明「需要什么权限、要改哪个文件 / 要跑哪条命令」，',
        '  然后**停手**等主人发 `/permission` 放开；开了之后接着干。',
        '- Web 会话（主人就坐在电脑前）不受这条影响，照常用审批。',
      ].join('\n')
      ctx.systemPrompt.section({
        name: 'qq-adapter:permission-note',
        order: 10300,
        text: () => 权限说明,
      })
      log('系统提示词已注入「QQ 通道权限不够怎么办」')
    } catch (error) {
      warn('注入系统提示词失败：', error?.message || error)
    }
  }

  // 2026-10-29：插件数据统一搬到 home\xykp 下面（旧的 home\qq-adapter 已经拷过来了）
  const seenFile = () => cfg.seenPath || join(home(), 'xykp', 'qq-adapter', 'seen-' + INST + '.json')

  let seen = await readJson(seenFile(), { ids: [], cursor: 0 })
  if (!Array.isArray(seen.ids)) seen.ids = []
  const seenSet = new Set(seen.ids)
  let cursor = Number(seen.cursor) || 0
  let started = false

  // 2026-10-28：插件被挂了两份（bundle patch 和 profile insert 各一条）→
  //   同一条 QQ 消息被处理两次、每条回复发两遍 ✗
  //   兜住：**同一个桥只允许一个实例轮询**（后来的接管，先来的只挂工具不轮询）
  const 桥主表 = (globalThis.__qqAdapterBridgeOwners ||= new Map())
  const 桥键 = String(cfg.bridgeUrl || '')
  const 本键 = 桥键 + '|' + INST + '|' + Math.random().toString(36).slice(2, 8)
  const 前主 = 桥主表.get(桥键)
  if (前主 && 前主 !== 本键) warn('桥 ' + 桥键 + ' 已被另一个实例接管（' + 前主 + '），这个实例只挂工具、不轮询')
  桥主表.set(桥键, 本键)
  const 是桥主 = () => 桥主表.get(桥键) === 本键
  let running = false

  async function saveSeen() {
    seen.ids = Array.from(seenSet).slice(-2000)
    seen.cursor = cursor
    await writeJson(seenFile(), seen)
  }

  /** 桥没在跑就把 QQ shell 拉起来（DSH 重启后 shell 会跟着死，这条兜住） */
  let lastSpawnAt = 0
  async function ensureShell() {
    // 先看桥：活着就看登录态，挂了才去拉
    let st = null
    try { st = await bridge.status() } catch { st = null }
    if (st && st.ok) {
      const ready = st.stage === 'ready' && st.ms === true
      if (ready) {
        if (!wasReady) { log('桥已就绪（uin=' + st.uin + '）') ; wasReady = true }
        notifyCount = 0
        postWatcher.stop('已登录')
        reapLaunchers()
        return
      }
      wasReady = false
      await pushQrToNtfy(st)
      // 自动推够次数了（notifyMax），就转为等 /post
      if (notifyCount >= (Number(cfg.notifyMax) || 3)) postWatcher.start()
      return
    }
    postWatcher.stop('桥不可用')
    if (cfg.autoStartShell === false) return
    // ⚠ 2026-10-29：桥连不上的时候（壳还没起来/刚掉线）以前一张码都不推，
    //   主人只能守在电脑前。现在用上一次落盘的二维码也推一下，间隔/次数照旧受 notifyEveryMinutes / notifyMax 管 ✓
    await pushQrToNtfy(null)
    // 冷却：壳正在启动时 /status 还没起来，别每 15 秒又拉一个（两个实例会互相踢登录）
    if (Date.now() - lastSpawnAt < 120000) return
    // 同一套安装目录里只要有 QQ.exe 在跑，就绝不能再拉一个：
    // QQ.exe 是单实例的，后来的那个会把先跑的顶掉（2026-10-27 半夜就这么把樱和鲸鱼娘各顶掉一次）
    try {
      const { execFileSync } = await import('node:child_process')
      const dirPrefix = String(cfg.shellDir || 'D:\\Program-Files\\QQ-shell')
      const psCmd = "Get-Process -Name QQ -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '" + dirPrefix + "*' } | Select-Object -First 1 -ExpandProperty Id"
      const alive = String(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { encoding: 'utf8', windowsHide: true }) || '').trim()
      if (alive) { log('壳的 QQ 进程还在（pid=' + alive + '），不重复拉'); return }
    } catch { /* 查不到就按原来的走 */ }
    lastSpawnAt = Date.now()
    try {
      // 用 WMI 拉，进程挂在 WmiPrvSE 下面 —— 这样宿主重启（杀进程树）不会把 QQ shell 一起带走
      const { execFile } = await import('node:child_process')
      const boot = cfg.shellBootPath || 'D:\\Program-Files\\QQ-shell\\NapCatWinBootMain.exe'
      const dir = cfg.shellDir || 'D:\\Program-Files\\QQ-shell'
      const ps = 'powershell.exe'
      const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"
      // ⚠ 2026-10-28 主人：壳起完窗口不关、越堆越多 →
      //   现在套一层 `cmd /c`，启动器一退出那个控制台窗口就跟着关掉 ✓
      const script =
        'Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ' +
        q('cmd.exe /c "' + boot + '"') + '; CurrentDirectory = ' + q(dir) + ' } | Out-Null'
      execFile(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err) => {
        if (err) warn('拉起 QQ shell 失败：', err.message)
        else log('桥没在跑，已用 WMI 拉起 QQ shell：' + boot)
      })
    } catch (err) { warn('拉起 QQ shell 失败：', err?.message || err) }
  }

  // 启动器（NapCatWinBootMain.exe）起完 QQ 不会自己退，窗口就一直留着 ——
  //   桥 ready 说明 QQ 已经起好了，这些启动器可以清掉（每 60 秒最多清一次）
  let lastReapAt = 0
  async function reapLaunchers() {
    if (Date.now() - lastReapAt < 60000) return
    lastReapAt = Date.now()
    try {
      const dirPrefix = String(cfg.shellDir || 'D:\\Program-Files\\QQ-shell')
      // ⚠ 别用 `Get-Process -Name X -ErrorAction SilentlyContinue`：进程不存在时 powershell 退出码仍是 1，
      //   会被当成「清理失败」写日志（2026-10-28 实测）。用 CIM 查，没有就静默返回空 ✓
      const psCmd =
        'Get-CimInstance Win32_Process | Where-Object { $_.Name -eq ' + "'NapCatWinBootMain.exe'" +
        ' -and $_.ExecutablePath -like ' + "'" + dirPrefix + "*'" +
        ' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }'
      const { execFile } = await import('node:child_process')
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { windowsHide: true }, (err, stdout) => {
        const ids = String(stdout || '').trim().split(/\s+/).filter(Boolean)
        if (ids.length) log('清掉 ' + ids.length + ' 个残留启动器（' + ids.join(',') + '）')
        if (err) warn('清残留启动器失败：', err.message)
      })
    } catch { /* 清不掉就算了 */ }
  }
  // ── 哨兵：桥没起来就去拉；起来了但没登录就把二维码推到 ntfy ──
  let lastNotifyAt = 0
  let notifyCount = 0
  let wasReady = false
  let lastQrStamp = 0   // 上次推出去的那张码的 mtime：同一张不重复推，保证到手是「刚生成」的

  /** 拿 ntfy 组件（comms/ntfy 提供的服务）；没装/没起来就返回 null，后面走自带 fetch 兜底 */
  const ntfyOf = () => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('ntfy') || null : null
    } catch {
      return null
    }
  }

  /** 读二维码文件（附带 mtime 和码龄） */
  async function readQrFile() {
    const { readFile, stat } = await import('node:fs/promises')
    const st = await stat(cfg.qrFile)
    return { png: await readFile(cfg.qrFile), stamp: st.mtimeMs, ageMin: (Date.now() - st.mtimeMs) / 60_000 }
  }

  /** 让壳重新要一张码，并等文件真的更新；超时返回 null */
  async function freshQrFromBridge() {
    const { stat } = await import('node:fs/promises')
    const file = cfg.qrFile || ''
    const before = await stat(file).then((s) => s.mtimeMs).catch(() => 0)
    try {
      await bridge.qr()
    } catch (err) {
      warn('让壳出新码失败：', err?.message || err)
    }
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 300))
      const s = await stat(file).catch(() => null)
      if (s && s.mtimeMs > before) return await readQrFile()
    }
    return null
  }

  /** 推一张码：优先用 comms/ntfy 服务，没有就走自带 fetch */
  async function pushQrImage(title) {
    const ntfy = ntfyOf()
    if (ntfy && typeof ntfy.push === 'function') {
      await ntfy.push({
        topic: cfg.notifyTopic,
        filePath: cfg.qrFile,
        filename: 'qq-qr.png',
        title,
        tags: 'rotating_light,qrcode',
        priority: 4,
      })
      return
    }
    const { readFile } = await import('node:fs/promises')
    const png = await readFile(cfg.qrFile)
    const hz = (s) => Buffer.from(String(s), 'utf8').toString('latin1')
    const res = await fetch('https://ntfy.sh/' + encodeURIComponent(cfg.notifyTopic), {
      method: 'PUT',
      headers: { Title: hz(title), Tags: 'rotating_light,qrcode', Priority: '4', Filename: 'qq-qr.png' },
      body: png,
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
  }

  async function pushQrToNtfy(st) {
    if (!cfg.notifyTopic) return
    const everyMs = Math.max(30_000, (Number(cfg.notifyEveryMinutes) || 1) * 60_000)
    const maxPushes = Number(cfg.notifyMax) || 6
    if (notifyCount >= maxPushes) return
    if (Date.now() - lastNotifyAt < everyMs) return

    // ⚠ 自动换码已关（主人要求）：每次推之前现要一张新码，保证到手能扫；
    //   只有桥挂了才退回「落盘旧图」，且超过 2 分钟就当没码。
    let qr = null
    if (st && st.ok) qr = await freshQrFromBridge()
    if (!qr) {
      try {
        qr = await readQrFile()
      } catch (err) {
        warn('读二维码图片失败（等新码）：', err?.message || err)
        return
      }
      if (qr.ageMin > 2) {
        log('二维码文件太旧（' + Math.round(qr.ageMin) + ' 分钟前），等壳出新码再推')
        return
      }
      if (qr.stamp <= lastQrStamp) {
        log('还是上一张码，等新的')
        return
      }
    }

    lastNotifyAt = Date.now()
    notifyCount++
    lastQrStamp = qr.stamp
    try {
      await pushQrImage('QQ 掉线了，扫这张码 (' + notifyCount + '/' + maxPushes + ')')
      log('已把二维码推到 ntfy（' + cfg.notifyTopic + '）· uin=' + (st?.uin ?? '?') + ' stage=' + (st?.stage ?? '?'))
    } catch (err) {
      warn('推二维码到 ntfy 失败：', err?.message || err)
    }
  }

  /** 主人发 /post 之后要一张新码再推一张（不占自动推的 N 次额度） */
  async function pushFreshQr() {
    if (!cfg.notifyTopic) return false
    const qr = await freshQrFromBridge()
    if (!qr) {
      warn('/post 补推：等新二维码超时')
      return false
    }
    lastQrStamp = qr.stamp
    try {
      await pushQrImage('QQ 掉线了，扫这张码（/post 补发）')
      log('已按 /post 补推一张二维码')
      return true
    } catch (err) {
      warn('补推二维码失败：', err?.message || err)
      return false
    }
  }

  // 自动推码（2 分钟 × N 次）用完后，等 /post；收到就补一张，登录成功就停
  const postWatcher = createPostWatcher({
    getNtfy: ntfyOf,
    command: String(cfg.postCommand || '').trim(),
    topic: cfg.notifyTopic,
    timeoutMs: 60_000,
    isLoggedIn: async () => {
      try {
        const st = await bridge.status()
        return Boolean(st && st.ok && st.stage === 'ready' && st.ms === true)
      } catch {
        return false
      }
    },
    pushQr: pushFreshQr,
    log,
    warn,
  })

  // ────────── QQ 侧指令系统 ──────────
  // 规矩（主人 2026-10-28 定）：不做伪群组；一个会话就是一个会话；id 自己起；
  // 私聊切绑定不用权限，群聊 / 预设相关要权限；配置类带 -d 顺手改部署默认。
  const chatCache = { data: null, at: 0 }

  async function chatsNow(force) {
    if (!force && chatCache.data && Date.now() - chatCache.at < 1000) return chatCache.data
    chatCache.data = await readChats()
    chatCache.at = Date.now()
    return chatCache.data
  }

  async function setChatSession(key, sessionId, extra) {
    const all = await chatsNow(true)
    all[key] = { ...(all[key] || {}), sessionId, updatedAt: Date.now(), ...(extra || {}) }
    await writeChats(all)
    chatCache.data = all
    chatCache.at = Date.now()
  }

  function splitKey(key) {
    const g = /^g-(.+)$/.exec(String(key || ''))
    if (g) return { chatType: 2, peerUid: g[1] }
    const u = /^u-(.+)$/.exec(String(key || ''))
    if (u) return { chatType: 1, peerUid: u[1] }
    return null
  }

  // 最近发出去的文本（key → { text, at }）：自动回发前拿来比对，同一句话不重复发
  const 近发文本 = new Map()

  async function replyTo(key, text) {
    const p = splitKey(key)
    if (!p) return
    try {
      await bridge.send(p.chatType, p.peerUid, text)
      近发文本.set(key, { text: String(text || ''), at: Date.now() })
    } catch (err) { warn('指令回复发送失败：', err?.message || err) }
  }

  // ⚠ 2026-10-29 主人：「绑定的是预设，那在这里聊过之后，再发消息应该发到这个对话」——
  //   以前投递目标只看 chats.json 里钉死的 sessionId，/new 之后那个聊天就永远停在那条会话，
  //   哪怕 Web 里已经换到别的会话聊了（预设的活跃会话表 `home\xykp\preset-binder\preset-binder.json`
  //   明明更新了）。现在改成：**只有 /session 明确绑会话才钉死**（boundBy='session'），
  //   其余情况身份跟着预设走，每条消息现查一次预设的活跃会话 ✓
  async function 预设活跃会话(preset) {
    if (!preset) return ''
    try {
      const t = await resolveTarget('p-' + preset)
      return (t && t.sessionId) || ''
    } catch { return '' }
  }

  /** /new 建完会话后，把预设的活跃会话指过去（不然下次投递又跟回 Web 那条） */
  async function 记预设活跃(preset, sessionId) {
    if (!preset || !sessionId) return
    try {
      const p = join(home(), 'xykp', 'preset-binder', 'preset-binder.json')
      let t = { version: 1, updatedAt: new Date().toISOString(), presets: {} }
      try {
        const j = JSON.parse(await readFile(p, 'utf8'))
        if (j && j.presets) t = j
      } catch { /* 第一次写 */ }
      const cur = t.presets[preset] || { active: '', recent: [] }
      const now = new Date().toISOString()
      const recent = [sessionId, ...(Array.isArray(cur.recent) ? cur.recent : []).filter((x) => x !== sessionId)].slice(0, 30)
      t.presets[preset] = { ...cur, active: sessionId, at: now, recent }
      t.version = t.version || 1
      t.updatedAt = now
      await mkdir(dirname(p), { recursive: true })
      await writeFile(p, JSON.stringify(t, null, 2), 'utf8')
      log('预设 ' + preset + ' 的活跃会话 → ' + sessionId)
    } catch (err) { warn('写预设活跃会话失败：', err?.message || err) }
  }

  async function chatSessionId(key) {
    const all = await chatsNow()
    const rec = all[key] || {}
    const route = resolveRoute(cfg, key)
    if (rec.boundBy !== 'session') {
      const preset = String(rec.preset || (rec.prefs && rec.prefs.preset) || presetOfTarget(route.target || '') || '')
      if (preset) {
        const act = await 预设活跃会话(preset)
        if (act) return act
      }
    }
    const bound = rec.sessionId
    if (bound && findAgent(agentsSvc, bound)) return bound
    if (!route.target) return ''
    const t = await resolveTarget(route.target)
    return t.sessionId || ''
  }

  // 真正的投递目标：**预设优先**（身份绑预设，跟着预设的活跃会话走），
  // 只有 /session 明确绑了某条会话（boundBy='session'）才钉死那一条。
  // 10-28 主人：「我明明 /new 了，为什么消息还到那边去」—— 那时候只有指令读 chats.json，
  //   转发只看 mappings/defaultTarget；10-29 又发现问题反过来了：/new 钉死会话后，
  //   Web 里换了活跃会话，QQ 还往里投 ✗
  async function 投递目标(key) {
    let chats = {}
    try { chats = await chatsNow() } catch { /* 读不到就按路由走 */ }
    const rec = chats[key] || {}
    const route = resolveRoute(cfg, key)
    const preset = rec.boundBy === 'session'
      ? ''
      : String(rec.preset || (rec.prefs && rec.prefs.preset) || presetOfTarget(route.target || '') || '')
    if (preset) {
      const act = await 预设活跃会话(preset)
      const alive = act && findAgent(agentsSvc, act)
      if (act && (alive || act)) return { sessionId: act, via: 'preset:' + preset, routeTarget: 'p-' + preset }
    }
    const bound = String(rec.sessionId || '')
    if (bound) return { sessionId: bound, via: 'chats.json' }
    if (!route.target) return { sessionId: '', reason: route.reason || route.via, route: null }
    const t = await resolveTarget(route.target)
    return { ...t, routeTarget: route.target, via: 'route' }
  }

  function presetOfTarget(target) {
    const ref = parseTargetRef(target)
    return ref.kind === 'preset' ? ref.value : ''
  }

  /** 建会话：先按聊天偏好临时改部署默认（模型/等级/预设），建完立刻改回去 */
  async function createSessionFor(key) {
    const route = resolveRoute(cfg, key)
    const all = await chatsNow(true)
    const prefs = (all[key] && all[key].prefs) || {}
    // `/new` 用「这个聊天设置的偏好」，没设就用部署默认（预设 = agent-preset-registry 的 selectedDefault、
    // 工作区 = workspaceRoot）。**不继承当前会话**——主人 2026-10-28 03:57：
    //   「/new 应该用设置的预设和 ws，没设置用默认的；继承是会话转移（/compact、memory_movctx）才需要，
    //    不然改不动了」✓
    const preset = prefs.preset || presetOfTarget(route.target) || ''
    // ⚠ cwd 必须是**绝对路径**（宿主会校验：session header cwd must be an absolute path）。
    //   以前 `/workspace alive-workspace` 存成名字，`/new` 直接炸 ✗ → 这里兜一下，按名字换成路径
    // 2026-10-29：原来只用插件配置里的 workspaceRoot（默认写死 alive-workspace），
    //   结果 `/new` 拿的不是「部署里选中的工作区」（主人指出的）。
    //   改成：聊天偏好 → <DSH_HOME>\storages\workspace.json 里选中的工作区 → 插件配置 ✓
    let cwd = String(prefs.workspace || '')
    if (!cwd) {
      try {
        const ws = JSON.parse(await readFile(join(home(), 'storages', 'workspace.json'), 'utf8'))
        const wsId = ws && ws.global && ws.global.defaultWorkspaceId
        const hit = wsId && ws.tables && ws.tables.workspaces ? ws.tables.workspaces[wsId] : null
        if (hit && hit.path) cwd = String(hit.path)
      } catch { /* 读不到就退回插件配置 */ }
    }
    if (!cwd) cwd = String(cfg.workspaceRoot || '')
    if (cwd && !/^[a-zA-Z]:[\\/]/.test(cwd) && !cwd.startsWith('\\\\')) {
      try {
        const spaces = await listWorkspaces()
        const 名 = cwd.trim().replace(/[\\/]+$/, '')
        const hit = spaces.find((w) => w.title === 名 || w.id === 名 || w.path.toLowerCase().replace(/[\\/]+$/, '').endsWith('\\' + 名.toLowerCase()))
        if (hit) cwd = hit.path
      } catch { /* 换不到就用原值，下面还得校验 */ }
    }
    if (!/^[a-zA-Z]:[\\/]/.test(cwd) && !cwd.startsWith('\\\\')) {
      await replyTo(key, '工作区「' + cwd + '」不是绝对路径，/new 开不了——先发 /workspace 选一个（或写完整的 D:\\…）')
      return { id: '', preset: '' }
    }
    const editor = (() => { try { return ctx.get('configEditor') } catch { return null } })()
    const overrideOf = (id) => {
      try {
        const row = editor.configuration().find((r) => r.entry.options.id === id)
        return row ? { ...(row.override || {}) } : null
      } catch { return null }
    }
    const entryOf = (id) => {
      try { return editor.entries().find((e) => e.options.id === id) } catch { return null }
    }
    const saved = {}
    let patched = false
    try {
      if (editor && prefs.model) {
        const entry = entryOf('agent-default-model')
        const orig = overrideOf('agent-default-model')
        if (entry && orig) {
          saved.model = orig
          await editor.edit(entry, (c) => ({
            ...(c || {}), provider: prefs.model.provider, model: prefs.model.model,
            ...(prefs.level ? { reasoningEffort: prefs.level } : {}),
          }))
          patched = true
        }
      }
      if (editor && prefs.preset) {
        const entry = entryOf('agent-preset-registry')
        const orig = overrideOf('agent-preset-registry')
        if (entry && orig) {
          saved.preset = orig
          await editor.edit(entry, (c) => ({ ...(c || {}), selectedDefault: prefs.preset }))
          patched = true
        }
      }
      const id = newSessionId('qq')
      const meta = { cwd }
      if (preset) meta.agentPreset = preset
      // ⚠ 2026-10-29：新 agent 不带 agentOptions 的话 options.model 是空的 →
      //   系统提示里 {{model}} 就「has no value for this assembly」、请求前还会
      //   「has no provider/model」。Web 那边是 api-session-controller 传的
      //   agentOptions = agentDefaultModel.currentSelection()，这里照抄一份 ✓
      const agentOptions = resolveAgentOptions(ctx, prefs) || undefined
      // ⚠ 2026-10-29：以前只把预设 id 写进 meta，没有真的 mount →
      //   新会话 header 里 agentPreset=alive，但工具集是「最小默认集」（没有 read/pwsh/edit）。
      //   Web 那边建会话时 composition.setup 会做 `agentPresets.mount(...)`，这里照抄 ✓
      let resolvedPreset = preset
      let presetSetup
      if (preset) {
        try {
          const presets = ctx.get('agentPresets')
          if (presets && typeof presets.resolve === 'function') {
            const r = await presets.resolve(preset)
            if (r && r.id) {
              resolvedPreset = r.id
              if (r.broken) warn('预设 ' + preset + ' 有损坏：' + JSON.stringify(r.broken).slice(0, 300))
              presetSetup = async (agentCtx) => { await presets.mount(agentCtx, r.id) }
            }
          }
        } catch (err) { warn('挂预设 ' + preset + ' 失败：', err?.message || err) }
      }
      if (resolvedPreset) meta.agentPreset = resolvedPreset
      const handle = await agentsSvc.create({
        sessionId: id,
        meta,
        ...(agentOptions ? { agentOptions } : {}),
        ...(presetSetup ? { setup: presetSetup } : {}),
      })
      const real = handle?.agent?.session?.id || id
      // ⚠ 2026-10-29：只设 cwd 会话还是「未分组」——工作区的成员表要靠 attachSession 写进去
      //   （Web 那边建完会话也会把 session 挂到对应工作区）。这里按 cwd 反查工作区再挂上 ✓
      try {
        const reg = ctx.get('workspaceRegistry')
        if (reg && typeof reg.resolveByPath === 'function') {
          const ws = await reg.resolveByPath(cwd)
          if (ws) await ws.attachSession(real)
          else warn('没找到 cwd 对应的工作区（' + cwd + '），会话会显示未分组')
        }
      } catch (err) { warn('把新会话挂进工作区失败：', err?.message || err) }
      await setChatSession(key, real, { preset, boundBy: 'preset' })
      // 这个聊天里设过的权限预设，/new 出来的新会话也照用（没设就什么都不做）
      // ⚠ pp.set 要的是 session 对象（内部会 session.append + permissionState），给 id 会炸
      try {
        const wantPerm = prefs && prefs.permission
        const sessionObj = handle?.agent?.session || null
        const pp = wantPerm && sessionObj ? ctx.get('permissionPresets') : null
        if (pp && typeof pp.set === 'function') pp.set(sessionObj, wantPerm)
      } catch (err) { warn('新会话套权限预设失败：', err?.message || err) }
      // /new 的意义就是「以后投递到这条新会话」→ 把预设的活跃会话也指过去，
      // 不然投递按「预设优先」查活跃会话，又会被 Web 那边最后聊过的那条抢走 ✓
      await 记预设活跃(preset, real)
      return { id: real, preset }
    } finally {
      // 临时改的部署默认，不管建没建成都改回去
      if (patched) {
        try {
          if (saved.model) {
            const entry = entryOf('agent-default-model')
            if (entry) await editor.edit(entry, () => saved.model)
          }
          if (saved.preset) {
            const entry = entryOf('agent-preset-registry')
            if (entry) await editor.edit(entry, () => saved.preset)
          }
        } catch (err) { warn('恢复部署默认失败：', err?.message || err) }
      }
    }
  }

  async function runCommand(evt, key, parsed) {
    const spec = COMMAND_INDEX.get(parsed.name)
    const chatType = Number(evt.chatType) || 1
    const owner = isOwner(evt.senderUid, cfg)
    if (!spec) {
      await replyTo(key, '未知指令 /' + parsed.name + '。发 /help 看列表；想让模型处理就去掉开头的 / 重发')
      return
    }
    // 权限：群聊里所有「会改状态」的指令要主人；私聊里只放行 会话类
    const stateChanging = ['model', 'level', 'workspace', 'preset', 'permission', 'cfg-default', 'cfg-mode', 'cfg-list', 'cfg-table', 'stop'].includes(spec.name)
    if (stateChanging && !owner) {
      await replyTo(key, '这条指令只有主人能用' + (chatType === 2 ? '（群里）' : ''))
      return
    }
    if (chatType === 2 && ['new', 'session', 'compact'].includes(spec.name) && !owner) {
      await replyTo(key, '群聊里切会话只有主人能用')
      return
    }

    if (spec.name === 'help') { await replyTo(key, helpText()); return }
    if (spec.name === 'ver') {
      // 能收到回复就说明插件活着，多余的状态不啰嗦
      await replyTo(key, 'qq-adapter ' + INST + ' v' + PKG_VERSION)
      return
    }
    if (spec.name === 'status') {
      const sid = await chatSessionId(key)
      const agent = sid ? findAgent(agentsSvc, sid) : null
      const all = await chatsNow()
      const bound = all[key] || {}
      await replyTo(key, [
        '聊天 ' + key,
        '绑定会话 ' + (sid || '（没有）') + (bound.sessionId ? '（来自 chats.json）' : '（来自默认/映射）'),
        '预设 ' + (bound.preset || presetOfTarget(resolveRoute(cfg, key).target) || '—'),
        '状态 ' + (agent ? agent.status : '（找不到这个会话）'),
        '指令 ' + (cfg.commandsEnabled === false ? '关' : '开') + ' · 限流 ' + (cfg.coalesceSeconds > 0 ? cfg.coalesceSeconds + 's' : '关'),
      ].join('\n'))
      return
    }
    if (spec.name === 'free') {
      const sid = await chatSessionId(key)
      const agent = sid ? findAgent(agentsSvc, sid) : null
      if (!agent) { await replyTo(key, '这个聊天没有可用的会话'); return }
      await replyTo(key, agent.status === 'running'
        ? '这条会话在跑（running）。要是它是卡在等审批上，用 /stop 才停得掉，/free 只看不动'
        : '空闲（idle），没在跑')
      return
    }
    if (spec.name === 'stop') {
      const sid = await chatSessionId(key)
      const agent = sid ? findAgent(agentsSvc, sid) : null
      if (!agent) { await replyTo(key, '没有可停的会话'); return }
      if (agent.status !== 'running') { await replyTo(key, '它本来就没在跑'); return }
      try { agent.cancel('user') } catch (err) { await replyTo(key, '停不下来：' + (err?.message || err)); return }
      await replyTo(key, '⏹ 已经叫停了')
      return
    }
    if (spec.name === 'new') {
      const { id, preset } = await createSessionFor(key)
      await replyTo(key, '新会话开好了：' + id + (preset ? '（预设 ' + preset + '）' : '') + '\n这个聊天已经绑过去')
      return
    }
    if (spec.name === 'session') {
      const args = parseSessionArgs(parsed.arg)
      if (args.bad) { await replyTo(key, '看不懂这个参数：' + args.bad + '\n用法 /session [-[[offset,]n]] [-del]'); return }
      const current = await chatSessionId(key)
      const all = await listSessions()
      // 2026-10-28 主人：看「这个私聊/群聊**现在**绑的是什么」——
      //   · 明确绑了会话（chats.json 的 sessionId / 映射或默认目标写成 s-xxx）→ 列全部**未归档**会话
      //   · 绑的是预设（聊天偏好 preset / 目标 p-xxx）→ 只列该预设池里的会话
      // ⚠ 以前还加过一条「绑的会话正好在某个预设池里就当预设」的猜测 —— 主人 03:31 明确否掉了：
      //   他特意映射成 s-xxx，结果 /session 还报预设，就是因为那条猜测 ✗ 已删掉。
      const pools = await presetPools()
      const chatRec = (await chatsNow())[key] || {}
      const routeNow = resolveRoute(cfg, key)
      const refNow = parseTargetRef(routeNow.target)
      let presetName = ''
      let howBound = chatRec.sessionId ? '会话（chats.json）' : '会话（配置/映射）'
      const prefPreset = String((chatRec.prefs && chatRec.prefs.preset) || '')
      if (prefPreset) { presetName = prefPreset; howBound = '预设（聊天偏好）' }
      else if (refNow.kind === 'preset') { presetName = String(refNow.value); howBound = '预设（配置/映射）' }
      let mine = all
      if (presetName) {
        const ids = pools.get(presetName)
        mine = ids && ids.size ? all.filter((s) => ids.has(s.id)) : []
      }
      const 绑头 = '当前绑定：' + (presetName ? '预设 ' + presetName : '会话 ' + (current || '（没有）')) + ' · ' + howBound
      if (presetName && !mine.length) {
        await replyTo(key, 绑头 + '\n这个预设下面还没有会话（发 /new 在这个预设里开一个）')
        return
      }
      if (!mine.length) { await replyTo(key, 绑头 + '\n还没有自己的会话，发 /new 开一个'); return }
      if (args.index !== null) {
        const rows = mine.slice(args.offset, args.offset + args.count)
        const picked = rows[args.index - 1]
        if (!picked) { await replyTo(key, '序号越界：现在只显示 ' + rows.length + ' 条'); return }
        if (args.del) {
          if (picked.id === current) { await replyTo(key, '不能删正在用的这条，先 /new 或切走'); return }
          await deleteSessionDir(picked.workspace, picked.id)
          const chats = await chatsNow(true)
          for (const k of Object.keys(chats)) if (chats[k] && chats[k].sessionId === picked.id) delete chats[k]
          await writeChats(chats)
          chatCache.data = chats
          await replyTo(key, '删了：' + picked.id)
          return
        }
        if (!findAgent(agentsSvc, picked.id)) { await replyTo(key, picked.id + ' 现在没有活着的 agent（下次发消息会自动起）') }
        // ⚠ 2026-10-29 主人：「/session 如果绑定的预设，那切的也是**全局预设池的绑定**，不是改成绑会话」
        if (presetName) {
          await 记预设活跃(presetName, picked.id)
          await setChatSession(key, picked.id, { preset: presetName, boundBy: 'preset' })
          await replyTo(key, '切到（预设 ' + presetName + ' 的活跃会话）：' + picked.id)
          return
        }
        await setChatSession(key, picked.id, { boundBy: 'session' })
        await replyTo(key, '切到：' + picked.id)
        return
      }
      const rows = mine.slice(args.offset, args.offset + args.count)
      const lines = rows.map((s, i) => (i + 1) + '. ' + s.id + (s.id === current ? '  ← 当前' : '') + '  ' + ago(s.updatedAt))
      await replyTo(key, 绑头 + '\n会话（共 ' + mine.length + '，从第 ' + (args.offset + 1) + ' 条起 ' + rows.length + ' 条）\n' +
        lines.join('\n') + '\n\n/session <序号> 切换 · /session <序号> -del 删除')
      return
    }
    if (spec.name === 'compact') {
      // 走 memory-refine 自带的 memory_movctx：它自己把对话压成交接、开新对话接着聊
      // （同一份逻辑宿主里早就有了，别自己再造一遍）
      const old = await chatSessionId(key)
      const agent = old ? findAgent(agentsSvc, old) : null
      if (!agent) { await replyTo(key, '这个聊天没有活着的会话，没法压缩'); return }
      const before = new Set((await listSessions()).map((s) => s.id))
      const say = '（系统指令）请调用 memory_movctx 工具：把我和你这段对话压成交接摘要、开一个新对话接着聊，extra 不用填。做完回我一句「已交接」。'
      try { await deliver(agentsSvc, old, say, cfg.deliverMode, ctx) } catch (err) { await replyTo(key, '叫不动它：' + (err?.message || err)); return }
      await replyTo(key, '已让它自己压缩并开新对话（memory_movctx），我盯着新会话切绑定…')
      // 盯 60 秒，看有没有新会话冒出来，有就把这个聊天绑过去
      let hits = 0
      const timer = setInterval(async () => {
        hits++
        try {
          const now = await listSessions()
          const fresh = now.find((s) => !before.has(s.id))
          if (fresh) {
            clearInterval(timer)
            await setChatSession(key, fresh.id, { preset: '', boundBy: 'session' })
            await replyTo(key, '新会话接上了：' + fresh.id + '\n这个聊天已经绑过去')
            return
          }
        } catch { /* 继续等 */ }
        if (hits > 20) { clearInterval(timer); warn('compact 没等到新会话（' + key + '）') }
      }, 3000)
      if (typeof timer.unref === 'function') timer.unref()
      return
    }

    // ── 适配层配置类：改的是 ui-config.json（运行时覆盖）──
    if (spec.name.startsWith('cfg-')) {
      const cur = (await bridge.getConfig()) || {}
      const mineCfg = cur[INST] || {}
      const tokens = String(parsed.arg || '').split(/\s+/).filter(Boolean)
      if (spec.name === 'cfg-default') {
        if (!tokens.length) { await replyTo(key, '当前默认目标：' + (mineCfg.defaultTarget || cfg.defaultTarget)); return }
        const v = tokens[0]
        await bridge.saveConfig(INST, { defaultTarget: v })
        await replyTo(key, '默认目标改成 ' + v + '（下一轮生效）')
        return
      }
      if (spec.name === 'cfg-mode') {
        if (!tokens.length) { await replyTo(key, '当前模式：' + (mineCfg.mode || cfg.mode)); return }
        if (!['blacklist', 'whitelist'].includes(tokens[0])) { await replyTo(key, '只有 blacklist / whitelist'); return }
        await bridge.saveConfig(INST, { mode: tokens[0] })
        await replyTo(key, '名单模式改成 ' + tokens[0])
        return
      }
      if (spec.name === 'cfg-list') {
        const listName = { blocked: 'blocked', allowed: 'allowed', fast: 'fastUids', fastUids: 'fastUids' }
        const which = tokens.find((t) => listName[t]) || 'blocked'
        const field = listName[which]
        const arr = Array.isArray(mineCfg[field]) ? mineCfg[field].slice() : []
        const add = tokens.indexOf('-add')
        const del = tokens.indexOf('-del')
        if (add >= 0 && tokens[add + 1]) {
          if (!arr.includes(tokens[add + 1])) arr.push(tokens[add + 1])
          await bridge.saveConfig(INST, { [field]: arr })
          await replyTo(key, which + ' 加了 ' + tokens[add + 1])
          return
        }
        if (del >= 0 && tokens[del + 1]) {
          const t = tokens[del + 1]
          const idx = arr.indexOf(t)
          let removed = ''
          if (idx >= 0) removed = arr.splice(idx, 1)[0]
          else if (/^\d+$/.test(t)) removed = arr.splice(Number(t) - 1, 1)[0] || ''
          await bridge.saveConfig(INST, { [field]: arr })
          await replyTo(key, removed ? which + ' 删了 ' + removed : '没找到要删的')
          return
        }
        await replyTo(key, which + '（' + arr.length + '）\n' + (arr.length ? arr.map((x, i) => (i + 1) + '. ' + x).join('\n') : '（空）'))
        return
      }
      if (spec.name === 'cfg-table') {
        const maps = Array.isArray(mineCfg.mappings) ? mineCfg.mappings.slice() : []
        const setAt = tokens.indexOf('-set')
        const addAt = tokens.indexOf('-add')
        const delAt = tokens.indexOf('-del')
        // 2026-10-28：两种写法都认 ——
        //   `/cfg-table -set <chat> <target>`（空格分隔）
        //   `/cfg-table -add <chat>:<target>`（冒号分隔，主人写的就是这个）
        const 写字 = setAt >= 0 ? setAt : addAt
        if (写字 >= 0) {
          let chat = ''
          let target = ''
          if (tokens[写字 + 1] && tokens[写字 + 2]) { chat = tokens[写字 + 1]; target = tokens[写字 + 2] }
          else if (tokens[写字 + 1] && tokens[写字 + 1].includes(':')) {
            const idx = tokens[写字 + 1].indexOf(':')
            chat = tokens[写字 + 1].slice(0, idx).trim()
            target = tokens[写字 + 1].slice(idx + 1).trim()
          }
          if (!chat || !target) {
            await replyTo(key, '写法：/cfg-table -set <u-xxx|g-xxx> <p-预设|s-会话>\n或者 /cfg-table -add <chat>:<target>')
            return
          }
          const i = maps.findIndex((m) => m.chat === chat)
          if (i >= 0) maps[i] = { chat, target }
          else maps.push({ chat, target })
          await bridge.saveConfig(INST, { mappings: maps })
          await replyTo(key, '映射：' + chat + ' → ' + target)
          return
        }
        if (delAt >= 0 && tokens[delAt + 1]) {
          const t = tokens[delAt + 1]
          const i = maps.findIndex((m) => m.chat === t)
          const removed = i >= 0 ? maps.splice(i, 1)[0] : null
          await bridge.saveConfig(INST, { mappings: maps })
          await replyTo(key, removed ? '删了映射 ' + removed.chat : '没找到这条映射')
          return
        }
        await replyTo(key, '映射（' + maps.length + '）\n' + (maps.length ? maps.map((m) => m.chat + ' → ' + m.target).join('\n') : '（空）') + '\n\n/cfg-table -set u-xxx p-alive · /cfg-table -add g-123:s-会话 · /cfg-table -del u-xxx')
        return
      }
    }

    // ── 配置类：直接改「部署默认」，或者先存偏好等下次 /new 用 ──
    // 2026-10-28 主人：不加参数的时候要把可选项列出来（model / preset / level / workspace 都要）
    if (['model', 'level', 'workspace', 'preset', 'permission'].includes(spec.name)) {
      const editor = (() => { try { return ctx.get('configEditor') } catch { return null } })()
      if (!editor) { await replyTo(key, '这个宿主没给 configEditor，改不了配置'); return }
      const entryOf = (id) => { try { return editor.entries().find((e) => e.options.id === id) } catch { return null } }
      const wantDefault = /(^|\s)-d(\s|$)/.test(String(parsed.arg || ''))
      const body = String(parsed.arg || '').replace(/(^|\s)-d(\s|$)/g, ' ').trim()

      // 模型目录：provider 列表 + 每个 provider 的模型（给 /model 列出来 / 支持序号）
      const 模型目录 = async () => {
        const out = []
        const llm = (() => { try { return ctx.get('llm') } catch { return null } })()
        if (!llm || typeof llm.listProviders !== 'function') return out
        let providers = []
        try { providers = llm.listProviders() || [] } catch { providers = [] }
        for (const p of providers) {
          const id = String((p && (p.provider || p.id)) || '')
          if (!id) continue
          let models = []
          try { models = (await llm.listModels(id)) || [] } catch { models = [] }
          for (const m of models) out.push({ provider: id, model: String((m && m.id) || ''), name: String((m && m.name) || '') })
        }
        return out
      }
      const 引擎 = () => { try { return ctx.get('llm') } catch { return null } }

      if (spec.name === 'model' || spec.name === 'level') {
        const cur = (() => { try { return (editor.configuration().find((r) => r.entry.options.id === 'agent-default-model') || {}).override || {} } catch { return {} } })()
        const chat = (await chatsNow(true))[key] || {}
        const pref = chat.prefs || {}
        const curProvider = String(pref.model?.provider || cur.provider || '')
        const curModel = String(pref.model?.model || cur.model || '')
        const show = () => replyTo(key, '当前部署默认：' + (cur.provider || '?') + ' / ' + (cur.model || '?') + (cur.reasoningEffort ? ' / ' + cur.reasoningEffort : '') +
          (pref.model ? '\n这个聊天的偏好：' + pref.model.provider + ' / ' + pref.model.model + '（下次 /new 生效）' : '') +
          (pref.level ? '\n等级偏好：' + pref.level : ''))
        if (!body) {
          // 不带参数：列出来给人挑
          if (spec.name === 'level') {
            let efforts = []
            let def = ''
            try {
              const llm = 引擎()
              const info = await llm.resolveModelInfo(curProvider, curModel)
              efforts = ((info && info.reasoning && info.reasoning.efforts) || []).map((e) => String(e.id))
              def = String((info && info.reasoning && info.reasoning.defaultEffort) || '')
            } catch { /* 拿不到就只报当前值 */ }
            await show()
            await replyTo(key, '当前模型 ' + curProvider + ' / ' + curModel + ' 支持的等级：\n' +
              (efforts.length ? efforts.map((e, i) => (i + 1) + '. ' + e + (e === def ? '（默认）' : '')).join('\n') : '（这个模型没报等级，直接 /level <等级> 试）') +
              '\n\n/level <等级|序号> 只存偏好（下次 /new 生效） · 加 -d 直接改部署默认')
            return
          }
          const catalog = await 模型目录()
          await show()
          const rows = catalog.slice(0, 20)
          await replyTo(key, '可选模型（共 ' + catalog.length + (catalog.length > 20 ? '，只列前 20' : '') + '）：\n' +
            (rows.length ? rows.map((c, i) => (i + 1) + '. ' + c.provider + ' / ' + c.model + (c.name && c.name !== c.model ? '  ' + c.name : '') + (c.provider === curProvider && c.model === curModel ? '  ← 当前' : '')).join('\n') : '（宿主没给模型目录）') +
            '\n\n/model <序号> 或 /model <provider> <model>；加 -d 改部署默认，不带只存偏好')
          return
        }
        if (spec.name === 'level') {
          if (wantDefault) {
            const entry = entryOf('agent-default-model')
            if (!entry) { await replyTo(key, '找不到 agent-default-model'); return }
            await editor.edit(entry, (c) => ({ ...(c || {}), reasoningEffort: body }))
            await replyTo(key, '部署默认推理等级 → ' + body)
          } else {
            const all = await chatsNow(true)
            all[key] = { ...(all[key] || {}), prefs: { ...(all[key]?.prefs || {}), level: body } }
            await writeChats(all); chatCache.data = all
            await replyTo(key, '记下了：下次 /new 用 ' + body + ' 等级')
          }
          return
        }
        // /model：先认序号，再认 provider model / provider/model
        const catalog = await 模型目录()
        let provider = ''
        let model = ''
        if (/^\d+$/.test(body)) {
          const pick = catalog[Number(body) - 1]
          if (!pick) { await replyTo(key, '序号越界：模型目录里一共 ' + catalog.length + ' 个，发 /model 看列表'); return }
          provider = pick.provider; model = pick.model
        } else {
          const parts = body.split(/\s+/).filter(Boolean)
          if (parts.length === 1 && parts[0].includes('/')) { provider = parts[0].split('/')[0]; model = parts[0].split('/').slice(1).join('/') }
          else { provider = parts[0]; model = parts[1] || '' }
        }
        if (!provider || !model) { await replyTo(key, '用法 /model（看列表和当前） · /model <序号> · /model <provider> <model>\n加 -d 改部署默认，不带只存偏好'); return }
        if (wantDefault) {
          const entry = entryOf('agent-default-model')
          if (!entry) { await replyTo(key, '找不到 agent-default-model'); return }
          await editor.edit(entry, (c) => ({ ...(c || {}), provider, model }))
          await replyTo(key, '部署默认模型 → ' + provider + ' / ' + model)
        } else {
          const all = await chatsNow(true)
          all[key] = { ...(all[key] || {}), prefs: { ...(all[key]?.prefs || {}), model: { provider, model } } }
          await writeChats(all); chatCache.data = all
          await replyTo(key, '记下了：下次 /new 用 ' + provider + ' / ' + model)
        }
        return
      }

      if (spec.name === 'preset') {
        const reg = (() => { try { return (editor.configuration().find((r) => r.entry.options.id === 'agent-preset-registry') || {}).override || {} } catch { return {} } })()
        const chat = (await chatsNow(true))[key] || {}
        if (!body) {
          let rows = []
          try { rows = await ctx.get('agentPresets').list() } catch { rows = [] }
          await replyTo(key, '部署默认预设：' + (reg.selectedDefault || reg.default || '?') +
            (chat.prefs && chat.prefs.preset ? '\n这个聊天的偏好：' + chat.prefs.preset + '（下次 /new 生效）' : '') +
            '\n\n可选预设（' + rows.length + '）：\n' +
            (rows.length ? rows.map((r, i) => (i + 1) + '. ' + r.id + (r.name && r.name !== r.id ? '  ' + r.name : '') + (r.id === (reg.selectedDefault || reg.default) ? '  ← 默认' : '') + (r.broken ? '  ⚠ 坏了' : '')).join('\n') : '（宿主没列出来）') +
            '\n\n/preset <序号|id>；加 -d 改部署默认，不带只存偏好')
          return
        }
        let chosen = body
        if (/^\d+$/.test(body)) {
          let rows = []
          try { rows = await ctx.get('agentPresets').list() } catch { rows = [] }
          const pick = rows[Number(body) - 1]
          if (!pick) { await replyTo(key, '序号越界：预设共 ' + rows.length + ' 个，发 /preset 看列表'); return }
          chosen = pick.id
        }
        if (wantDefault) {
          const entry = entryOf('agent-preset-registry')
          if (!entry) { await replyTo(key, '找不到 agent-preset-registry'); return }
          await editor.edit(entry, (c) => ({ ...(c || {}), selectedDefault: chosen }))
          await replyTo(key, '部署默认预设 → ' + chosen)
        } else {
          const all = await chatsNow(true)
          all[key] = { ...(all[key] || {}), prefs: { ...(all[key]?.prefs || {}), preset: chosen } }
          await writeChats(all); chatCache.data = all
          await replyTo(key, '记下了：下次 /new 用预设 ' + chosen)
        }
        return
      }

      if (spec.name === 'workspace') {
        const chat = (await chatsNow(true))[key] || {}
        const spaces = await listWorkspaces()
        if (!body) {
          await replyTo(key, '部署工作区根：' + cfg.workspaceRoot +
            (chat.prefs && chat.prefs.workspace ? '\n这个聊天的偏好：' + chat.prefs.workspace : '') +
            '\n\n已有工作区（' + spaces.length + '）：\n' +
            (spaces.length ? spaces.map((w, i) => (i + 1) + '. ' + (w.title || w.path) + '（' + w.live.length + ' 个未归档会话）\n   ' + w.path).join('\n') : '（还没有工作区）') +
            '\n\n/workspace <序号|路径>；加 -d 改部署工作区根，不带只存偏好')
          return
        }
        let target = body
        if (/^\d+$/.test(body)) {
          const pick = spaces[Number(body) - 1]
          if (!pick) { await replyTo(key, '序号越界：工作区共 ' + spaces.length + ' 个，发 /workspace 看列表'); return }
          target = pick.path
        } else if (!/^[a-zA-Z]:[\\/]/.test(target) && !target.startsWith('\\\\')) {
          // ⚠ 2026-10-28 主人 `/workspace alive-workspace` → 存成相对名字，
          //   `/new` 时报 `session header cwd must be an absolute path` ✗
          //   → 允许写工作区**名字**，这里按 workspace.json 的表换成绝对路径
          const 名 = String(target).replace(/[\\/]+$/, '')
          const hit = spaces.find((w) => w.title === 名 || w.id === 名 || w.path.replace(/[\\/]+$/, '').toLowerCase().endsWith('\\' + 名.toLowerCase()))
          if (!hit) {
            await replyTo(key, '没找到工作区「' + target + '」——发 /workspace 看列表；要给路径就写绝对路径（D:\\…）')
            return
          }
          target = hit.path
        }
        if (wantDefault) {
          const entry = entryOf('workspace-controller')
          if (!entry) { await replyTo(key, '找不到 workspace-controller'); return }
          await editor.edit(entry, (c) => ({ ...(c || {}), documentsDirectory: target }))
          cfg.workspaceRoot = target
          await replyTo(key, '部署工作区根 → ' + target)
        } else {
          const all = await chatsNow(true)
          all[key] = { ...(all[key] || {}), prefs: { ...(all[key]?.prefs || {}), workspace: target } }
          await writeChats(all); chatCache.data = all
          await replyTo(key, '记下了：下次 /new 在这个工作区开\n' + target)
        }
        return
      }

      if (spec.name === 'permission') {
        // 2026-10-29 接上了：宿主里那条 entry 叫 permission-presets（服务名 permissionPresets）
        let pp = null
        try { pp = ctx.get('permissionPresets') || null } catch { pp = null }
        if (!pp || typeof pp.apply !== 'function') {
          await replyTo(key, '权限预设服务没挂上（宿主里没找到 permissionPresets），先别依赖它')
          return
        }
        const names = (Array.isArray(pp.names) ? pp.names.slice() : Object.keys(pp.presets || {}))
        const chat = (await chatsNow(true))[key] || {}
        const agent = chat.sessionId ? findAgent(agentsSvc, chat.sessionId) : null
        let now = ''
        try {
          now = agent ? pp.current(agent.session) : (pp.defaultPreset || '')
        } catch { now = '' }
        if (!body) {
          await replyTo(key, '当前权限预设：' + (now || '?') +
            '\n\n可选（' + names.length + '）：\n' +
            names.map((n, i) => (i + 1) + '. ' + n + (n === now ? '  ← 现在这个' : '')).join('\n') +
            '\n\n/permission <序号|名字> 立刻换这个会话的；加 -d 改部署默认（重启后对新的会话生效）')
          return
        }
        let chosen = body
        // 短写（2026-10-29 主人确认：c = const 只读，w = workspace 工作区，f = full 完全）
        const ALIAS = {
          c: 'read-only', const: 'read-only', read: 'read-only', 只读: 'read-only',
          w: 'workspace-write', write: 'workspace-write', 工作区: 'workspace-write',
          f: 'danger-full-access', full: 'danger-full-access', 完全: 'danger-full-access',
        }
        const aliasKey = ALIAS[chosen] ? chosen : ALIAS[String(chosen).toLowerCase()]
        if (aliasKey && names.includes(ALIAS[aliasKey])) chosen = ALIAS[aliasKey]
        if (/^\d+$/.test(body)) {
          const pick = names[Number(body) - 1]
          if (!pick) { await replyTo(key, '序号越界：一共 ' + names.length + ' 个，发 /permission 看列表'); return }
          chosen = pick
        }
        if (!names.includes(chosen)) {
          await replyTo(key, '没有这个权限预设：' + chosen + '（可用 ' + names.join(' / ') + '）')
          return
        }
        if (wantDefault) {
          const entry = entryOf('permission-presets')
          if (!entry) { await replyTo(key, '找不到 permission-presets 这条 entry'); return }
          await editor.edit(entry, (c) => ({ ...(c || {}), defaultPreset: chosen }))
          await replyTo(key, '部署默认权限预设 → ' + chosen + '（重启后生效；当前会话不变）')
          return
        }
        if (!agent) {
          const all = await chatsNow(true)
          all[key] = { ...(all[key] || {}), prefs: { ...(all[key]?.prefs || {}), permission: chosen } }
          await writeChats(all); chatCache.data = all
          await replyTo(key, '这个会话现在没起来，先记成偏好：下次 /new 用权限预设 ' + chosen)
          return
        }
        try {
          // ⚠ 本插件 inject 里只有 agents/tools → 直接读 ctx.approval 会抛
          //   「cannot get property approval without inject」；ctx.get 拿服务不受 inject 限制
          const appr = (() => { try { return ctx.get('approval') } catch { return null } })()
          pp.apply(agent.session, chosen, (policy) => {
            try {
              if (appr && typeof appr.setPolicy === 'function') appr.setPolicy(agent, policy)
            } catch (e) { warn('同步 approval 策略失败：', e?.message || e) }
          })
          await replyTo(key, '权限预设 → ' + chosen)
        } catch (err) {
          await replyTo(key, '切权限预设失败：' + (err?.message || err))
        }
        return
      }
    }
    await replyTo(key, '这条指令还没实现：/' + spec.name)
  }
  // ── 允许配置里直接写 QQ 号（u-3041632789），这里统一换成内核用的 uid ──
  const uinCache = new Map()
  async function normChatKey(key) {
    const s = String(key || '').trim()
    if (!/^u-\d{5,}$/.test(s)) return s
    if (uinCache.has(s)) return uinCache.get(s)
    try {
      const r = await bridge.uid(s.slice(2))
      if (r && r.ok && r.uid) { const v = 'u-' + r.uid; uinCache.set(s, v); return v }
    } catch { /* 转不了就按原样，最多匹配不上 */ }
    return s
  }

  // ── 流量控制：同一个聊天「发得太密」时把消息合并成一条 ──
  // 主人 2026-10-28 定的语义（改过一次）：
  //   · 时间轴是「**距上次发送**」至少 coalesceSeconds，不是「距上一条消息静默这么久」。
  //     隔了很久没人说话 → 第一条立刻发；刚发过 → 后面的攒着，到「上次发送 + 窗口」一起发。
  //   · 以前是每条消息都把定时器往后推，结果不管之前发没发过都要硬等一个窗口 ✗
  //   · fastUids 里的聊天完全不受限（来一条转一条）
  const pendingBatch = new Map() // key -> { parts: [{sender,text}], timer, firstAt }
  const lastDeliveredAt = new Map() // key -> ms

  // ── 自动回发：QQ 进来一条 → 记下来源 → 这一轮跑完把最终回复发回那个聊天 ──
  // 主人 2026-10-28：群里跟机器人说话，机器人得在群里回话（以前只有指令会回，普通聊天永远没动静）
  const 待回发 = new Map() // sessionId -> { key, at }
  function 提取回复文本(msg) {
    if (!msg) return ''
    if (typeof msg === 'string') return msg.trim()
    const blocks = Array.isArray(msg.content) ? msg.content : []
    return blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim()
  }
  async function 检查回发() {
    if (cfg.autoReply === false) return
    if (!待回发.size) return
    for (const [sid, info] of [...待回发]) {
      if (Date.now() - info.at > 5 * 60 * 1000) { 待回发.delete(sid); continue }
      const ag = findAgent(agentsSvc, sid)
      if (!ag) { 待回发.delete(sid); continue }
      if (ag.status === 'running') continue // 还在跑，等下一轮 tick
      let 文 = ''
      try {
        const ev = (ag.session && ag.session.snapshotEvents ? ag.session.snapshotEvents() : []) || []
        for (let i = ev.length - 1; i >= 0; i--) {
          const e = ev[i]
          if (e && e.type === 'assistant/message') { 文 = 提取回复文本(e.data && e.data.message); break }
        }
      } catch { /* 拿不到就不发 */ }
      待回发.delete(sid)
      if (!文) continue
      if (/^\[\[SILENT\]\]$/i.test(文)) { log('这一轮回的是 [[SILENT]]，不回发'); continue }
      const 近 = 近发文本.get(info.key)
      if (近 && 近.text === 文 && Date.now() - 近.at < 60 * 1000) { log('这一轮已经用工具发过同样的话，跳过自动回发'); continue }
      const p = splitKey(info.key)
      if (!p) continue
      try {
        await bridge.send(p.chatType, p.peerUid, 文)
        近发文本.set(info.key, { text: 文, at: Date.now() })
        log('自动回发 → ' + info.key + '（' + 文.length + ' 字）')
      } catch (err) { warn('自动回发失败：', err?.message || err) }
    }
  }

  function coalesceMs() {
    return Math.max(0, (Number(cfg.coalesceSeconds) || 0) * 1000)
  }

  function trafficLimited(key) {
    const win = coalesceMs()
    if (win <= 0) return false
    const fast = Array.isArray(cfg.fastUids) ? cfg.fastUids : []
    if (fast.includes(key)) return false
    const last = lastDeliveredAt.get(key) || 0
    return Date.now() - last < win // 只有「刚发过、窗口还没过」才限流
  }

  function queueBatch(key, evt, text) {
    let st = pendingBatch.get(key)
    if (!st) { st = { parts: [], timer: null, firstAt: Date.now() }; pendingBatch.set(key, st) }
    st.parts.push({ sender: String(evt.senderName || evt.senderUid || ''), text })
    const win = coalesceMs()
    const last = lastDeliveredAt.get(key) || st.firstAt
    // 到「上次发送 + 窗口」就发；**不因为新消息又往后推**
    const wait = Math.max(100, last + win - Date.now())
    if (st.timer) clearTimeout(st.timer)
    st.timer = setTimeout(() => { void flushBatch(key) }, wait)
    if (typeof st.timer.unref === 'function') st.timer.unref()
  }

  async function flushBatch(key) {
    const st = pendingBatch.get(key)
    if (!st || !st.parts.length) return
    pendingBatch.delete(key)
    const parts = st.parts
    const target = await 投递目标(key)
    if (!target.sessionId) {
      log(`合并的 ${parts.length} 条丢了：${key} 没有可用目标（${target.reason || (target.routeTarget || '')}）`)
      return
    }
    const text = parts.length === 1
      ? parts[0].text
      : `（${parts.length} 条连着来的，合并成一条）\n` + parts.map((p) => (p.sender ? `[${p.sender}] ` : '') + p.text).join('\n')
    try {
      await deliver(agentsSvc, target.sessionId, text, cfg.deliverMode, ctx)
      待回发.set(target.sessionId, { key, at: Date.now() })
      lastDeliveredAt.set(key, Date.now())
      log(`转发${parts.length > 1 ? `(${parts.length} 条合并)` : ''} ${key} → ${target.sessionId}`)
    } catch (err) {
      warn('合并转发失败（下轮再说）：', err?.message || err)
    }
  }

  // ── 「自己号」判定（2026-10-28，主人：指令执行完就该结束，别把结果又当消息转发出去）──
  // 症状：樱那边执行 /model -d，回复「部署默认模型 → …」；这条回复从桥上回来，
  //   鲸鱼娘那个实例把它当成「陌生人发来的消息」转发进了会话，模型只好回 [[SILENT]]。
  // 原因：两个实例互相把对方的号当普通用户。本机所有实例的号都登记进同一个全局集合，
  //   谁发的消息只要是自己号，一律不转发（连 fastUids 也不管）。
  function 自己号集合() {
    const set = (globalThis.__qqAdapterSelfUids ||= new Set())
    const add = (v) => {
      const s = String(v || '').trim()
      if (!s) return
      set.add(s)
      set.add(s.replace(/^u-/, ''))
    }
    try { add(cfg.selfUid) } catch { /* 没有就算了 */ }
    return set
  }
  自己号集合()
  // 自己的 QQ 号（uin）也算「自己」：群里 @ 人时元素里给的是 atUid / atNtUid / atTinyId
  try {
    bridge.status().then((s) => {
      const uin = String((s && s.uin) || '')
      if (uin) 自己号集合().add(uin)
    }).catch(() => {})
  } catch { /* 桥还没起就算了 */ }

  function 是自己Uid(v) {
    const s = String(v || '').trim()
    if (!s) return false
    const set = 自己号集合()
    return set.has(s) || set.has(s.replace(/^u-/, ''))
  }

  function 是自己号(evt) {
    if (!evt) return false
    if (evt.isSelf === true) return true // 桥直接标了（自己发出去又被内核回调回来的回执）
    return 是自己Uid(evt.senderUid)
  }

  // ── 指令判定（主人 2026-10-28 定的规矩）──
  // 私聊：以 `/` 开头就是指令
  // 群聊：没 @ 的时候跟私聊一样；
  //       开头一连串 @ 里**只要有自己**，就把 @ 后面那段当指令；
  //       开头 @ 的是别人、后面却跟着一条指令 → **静默忽略**（不执行、不转发、不回话）
  //
  // ⚠⚠ 2026-10-28 实测（主人从手机在群里发「@樱 /ver」）：QQ 把群里的 @ 写进了**正文**，
  //   事件长这样 → text="@樱 /ver"，elements=[TEXT, TEXT]，**没有 at 元素**。
  //   所以只认 element.at 的话永远认不出「@ 的是我」✗
  //   → 现在两头都认：element.at（有就认）+ 正文开头的「@名字」（拿群成员里自己的卡片名比）
  const 群内自己名 = new Map() // gid -> { names: Set, at: ms }
  async function 取自己群名(gid) {
    const key = String(gid || '')
    if (!key) return new Set()
    const 旧 = 群内自己名.get(key)
    if (旧 && Date.now() - 旧.at < 10 * 60 * 1000) return 旧.names
    const names = new Set()
    try {
      const r = await bridge.groupMembers(key)
      for (const m of (r && Array.isArray(r.members) ? r.members : [])) {
        if (!m || m.isSelf !== true) continue
        for (const n of [m.card, m.nick]) {
          const s = String(n || '').trim()
          if (s) names.add(s)
        }
      }
    } catch { /* 拿不到成员表就只能靠 at 元素 */ }
    群内自己名.set(key, { names, at: Date.now() })
    return names
  }

  async function 取指令(evt) {
    let 文本 = String((evt && evt.text) || '')
    if (Number(evt && evt.chatType) !== 2) return { cmd: parseCommand(文本), 提到自己: false }
    let 开头有at = false
    let 提到自己 = false
    // (a) 真给了 at 元素的情况（别的 QQ 版本可能是这样）
    const els = Array.isArray(evt.elements) ? evt.elements : []
    for (let i = 0; i < els.length; i++) {
      const el = els[i]
      if (!el || !el.at) break // 只认「开头连着的那几个 @」，中间夹了别的东西就不算
      const at = el.at || {}
      // ⚠ atType:0 / atUid:"0" 是「没有 @」的占位——字符串 "0" 是真值！
      //   2026-10-28 就因为没挑掉它，群里发的 /ver 被当成「@ 了别人」静默忽略 ✗
      const 有at = Number(at.atType) > 0 ||
        (String(at.atUid || '') !== '' && String(at.atUid) !== '0') ||
        (String(at.atNtUid || '') !== '' && String(at.atNtUid) !== '0')
      if (!有at) continue
      开头有at = true
      if (是自己Uid(at.atUid) || 是自己Uid(at.atNtUid) || 是自己Uid(at.atTinyId)) 提到自己 = true
    }
    // (b) @ 写在正文里的情况：「@樱 @鲸鱼娘 /ver」→ 把开头的 @名字 一个个剥掉
    if (/^\s*@/.test(文本)) {
      const names = await 取自己群名(evt.peerUid)
      const 候选 = [...names].sort((a, b) => b.length - a.length) // 长名字优先，别被前缀骗
      for (let n = 0; n < 8; n++) {
        const head = /^\s*@/.exec(文本)
        if (!head) break
        开头有at = true
        const 余 = 文本.slice(head[0].length)
        // 先试「已知的自己名字」（这样 “@樱/ver” 不带空格也能剥干净）
        let 命中 = 候选.find((x) => 余.startsWith(x)) || ''
        if (!命中) {
          const g = /^([^\s@]{1,40})/.exec(余)
          if (!g) break
          命中 = g[1]
        }
        文本 = 余.slice(命中.length).replace(/^\s+/, '')
        if (names.has(命中)) 提到自己 = true
      }
    }
    if (!开头有at) return { cmd: parseCommand(文本), 提到自己: false }
    if (!文本.trim().startsWith('/')) return { cmd: null, 提到自己 } // @ 了人但说的不是指令 → 照常转发
    if (!提到自己) return { cmd: null, 提到自己: false, silent: true }
    return { cmd: parseCommand(文本), 提到自己: true }
  }

  async function tick(reason) {
    if (!cfg.enabled || running) return
    if (!是桥主()) return // 同一个桥已经有别的实例在轮询了（重复挂载时只让一份干活）
    // 运行时覆盖：设置页写到 home\qq-adapter\ui-config.json 的分流配置，每轮读一次（很便宜）
    try { Object.assign(cfg, pickRouting((await readOverride())[INST] || {})) } catch { /* 读不到就用原配置 */ }
    // 名单/映射/白名单里允许写 QQ 号，统一换成 uid 再比（幂等，转换结果会缓存）
    try {
      cfg.blocked = await Promise.all((cfg.blocked || []).map(normChatKey))
      cfg.allowed = await Promise.all((cfg.allowed || []).map(normChatKey))
      cfg.fastUids = await Promise.all((cfg.fastUids || []).map(normChatKey))
      cfg.mappings = await Promise.all((cfg.mappings || []).map(async (m) => ({ ...m, chat: await normChatKey(m.chat) })))
    } catch { /* 转不了就按原样 */ }
    running = true
    try {
      const r = await bridge.events(cursor)
      if (!r || r.ok === false) { warn('桥没回话：', r?.err || r?.raw || '空响应'); return }
      const next = Number(r.next) || 0
      const events = Array.isArray(r.events) ? r.events : []
      if (!started) {
        started = true
        if (cursor === 0 && next > 0 && cfg.skipBacklog !== false) {
          cursor = next
          log('启动跳过积压的 ' + next + ' 条（skipBacklog）')
          await saveSeen()
          return
        }
      }
      if (next < cursor) { cursor = 0; log('桥的收件箱被重启过，游标归零') }
      cursor = next

      let handled = 0
      for (const evt of events) {
        if (handled >= cfg.maxPerTick) break
        const msgId = String(evt?.msgId || '')
        if (!msgId || seenSet.has(msgId)) continue
        const key = chatKeyOf(evt)
        // 灰条（系统提示，elementType 8，比如「谁拍了拍谁」「谁加入了群」）没有正文，
        // 转发进会话只会变成一行 `[元素8]` 的噪音 —— 直接丢（2026-10-28 主人被这个吵到）
        {
          const els = Array.isArray(evt.elements) ? evt.elements : []
          if (els.length && els.every((e) => e && Number(e.type) === 8)) {
            seenSet.add(msgId)
            handled++
            log('跳过灰条（' + (key || '?') + '）')
            continue
          }
        }
        // 记住「每个聊天最近一条进来的消息」——qq_reply 不传 msgId 时就用它，
        // 别去翻历史挑一条（翻出来的可能是自己刚发的）
        try {
          const box = (globalThis.__qqLastInbound ||= new Map())
          box.set(key, { msgId, msgSeq: String(evt.msgSeq ?? ''), time: Number(evt.time) || Date.now(), senderUid: String(evt.senderUid || '') })
        } catch { /* 记不住就算了 */ }
        // 指令判定（私聊只看开头 /；群聊还要看开头有没有 @ 到自己）——
        //   顺便拿到「提没提到我」，下面的群聊唤醒策略要用 ✓
        const 意 = await 取指令(evt)
        if (cfg.commandsEnabled !== false) {
          if (意.silent) {
            seenSet.add(msgId)
            handled++
            log(`群里 @ 的是别人，指令静默忽略（${key}）：${String(evt.text || '').slice(0, 40)}`)
            continue
          }
          if (意.cmd) {
            seenSet.add(msgId)
            handled++
            try { await runCommand(evt, key, 意.cmd) } catch (err) { warn('指令 ' + 意.cmd.name + ' 执行失败：', err?.message || err) }
            continue
          }
        }
        // 自己号发的**普通消息**（包括刚发出去又被内核回调回来的回执）→ 丢掉，不转发。
        // 2026-10-28 主人：「指令执行完就结束了，不应该真的转发给对方」
        //   樱执行 /model -d 的回复就是这么绕回鲸鱼娘会话里的，模型只好回 [[SILENT]] ✗
        if (是自己号(evt) || (cfg.selfUid && String(evt.senderUid || '') === cfg.selfUid)) {
          seenSet.add(msgId)
          handled++
          log(`跳过自己号发的消息（${key || '?'}${evt?.isSelf ? ' · 桥标了 isSelf' : ''}）`)
          continue
        }
        // 群聊唤醒策略（2026-10-28 主人要的配置）：默认 mention = 没 @ 到我就不转进会话；
        //   设成 all 就群里每条都转（主人没加几个群，要的就是全唤醒）
        if (Number(evt.chatType) === 2 && String(cfg.groupWake || 'mention') !== 'all' && !意.提到自己) {
          seenSet.add(msgId)
          handled++
          log(`群里没 @ 我，不唤醒（${key}）：${String(evt.text || '').slice(0, 30)}`)
          continue
        }
        const target = await 投递目标(key)
        if (!target.sessionId) {
          if (!target.route) {
            log(`跳过 ${key || '?'}（${target.reason || '没有目标'}）`)
            seenSet.add(msgId)
            continue
          }
          warn(`转发目标 ${target.routeTarget} 解析不到会话（${target.reason || '未知'}），这条留在原地`)
          continue
        }
        const text = formatIncoming(evt)
        // 流量控制：太频繁就先攒着，别一条一条砸进会话
        if (trafficLimited(key)) {
          queueBatch(key, evt, text)
          seenSet.add(msgId)
          handled++
          log(`暂存 ${key}（静默 ${cfg.coalesceSeconds}s 后合并发）`)
          continue
        }
        try {
          await deliver(agentsSvc, target.sessionId, text, cfg.deliverMode, ctx)
          待回发.set(target.sessionId, { key, at: Date.now() })
          seenSet.add(msgId)
          handled++
          lastDeliveredAt.set(key, Date.now())
          log(`转发 ${key} → ${target.sessionId}（${target.via}${target.via === 'chats.json' ? ' 绑定' : ''}${target.via === 'preset' ? ':预设 ' + target.preset : ''}）`)
        } catch (err) {
          warn('转发 ' + key + ' 失败（下轮再试）：', err?.message || err)
        }
      }
      await 检查回发()
      if (handled || events.length) await saveSeen()
    } catch (err) {
      warn('轮询失败（' + reason + '）：', err?.message || err)
    } finally {
      running = false
    }
  }

  // 同一份插件可能被 loader 重复 apply（改配置时），把**同一个桥**上一个实例的定时器掐掉，
  // 否则会出现「两个实例各转一份、每条回复发两遍」的怪现象。
  // ⚠ 2026-10-28：以前这里写的是 `g[cleanupKey]`，而 cleanupKey 根本没定义 → 收摊函数被存到
  //   globalThis.undefined 上，永远找不到 → 旧实例一直活着 ✗（这就是「回复发两遍」的真凶）
  const g = globalThis
  const 收摊表 = (g.__qqAdapterCleanups ||= new Map())
  const 上一份收摊 = 收摊表.get(桥键)
  if (typeof 上一份收摊 === 'function') {
    try { 上一份收摊(); log('同一个桥的上一个实例已收摊（' + 桥键 + '）') } catch { /* 清理失败无所谓 */ }
  }
  const every = Math.max(500, Number(cfg.pollMs) || 1500)
  const timer = setInterval(() => void tick('定时'), every)
  if (typeof timer.unref === 'function') timer.unref()
  const shellTimer = setInterval(() => void ensureShell(), 15000)
  if (typeof shellTimer.unref === 'function') shellTimer.unref()
  void ensureShell()
  void tick('启动')

  try {
    const cleanup = () => {
      clearInterval(timer)
      clearInterval(shellTimer)
      postWatcher.stop('宿主收摊')
      for (const st of pendingBatch.values()) { try { if (st.timer) clearTimeout(st.timer) } catch { } }
      pendingBatch.clear()
    }
    收摊表.set(桥键, cleanup)
    ctx.on('dispose', cleanup)
  } catch { /* 收摊失败无所谓 */ }

  // ── 工具 ──
  let defineTool = (spec) => spec
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (mod && typeof mod.defineTool === 'function') defineTool = mod.defineTool
  } catch { /* 自测环境没有宿主包 */ }

  try {
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    // 2026-10-29 主人：qq 接口太多，合起来省 token 也更好调。
    //   9 个工具 → qq_send / qq_read 两个（旧实现整段留着，回滚把下面的 false 改成 true、再删掉末尾两段即可）✓
    if (false) {
    ctx.tools.register(defineTool({
      name: TP('qq_send'),
      description: '用自己 QQ 号发一条消息。chat 写成 u-<uid> 或 g-<群号>（和自己号发的消息用同一个标识）。',
      parameters: {
        chat: { type: 'string', description: 'u-<uid> 私聊 / g-<群号> 群聊', required: true },
        text: { type: 'string', description: '要发的文字', required: true },
        at: { type: 'string', description: '可选：要 @ 的 uid（群里用，u- 开头也可以）' },
        atNick: { type: 'string', description: '可选：@ 时显示的名字' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
      },
      async execute(args) {
        const key = String(args.chat || '').trim()
        const isGroup = key.startsWith('g-') || key.startsWith('G-')
        const peerUid = key.replace(/^[ugUG][-_]/, '')
        if (!peerUid) throw new Error('chat 得写成 u-<uid> 或 g-<群号>')
        const at = String(args.at || '').replace(/^u-/, '')
        // 2026-10-28：群里发消息以前会崩 native，根因是群聊 peer 少了唯一的 guildId（桥已修好，
        //   见 HANDOFF 18.4）。现在群里发文字、带 @ 都通了 ✓
        const r = await bridge.send(isGroup ? 2 : 1, peerUid, String(args.text ?? ''), at, String(args.atNick || ''))
        if (r && r.ok) 近发文本.set(key, { text: String(args.text ?? ''), at: Date.now() })
        return { ok: r?.ok === true, result: r?.result ?? null, err: r?.err ?? null, chat: key }
      },
    }))

    // QQ 自带表情（小黄脸）：id 就是 QQ 表情的 faceIndex（14 = 微笑，13 = 呲牙…）
    ctx.tools.register(defineTool({
      name: TP('qq_face'),
      description: '发一个 QQ 自带的黄脸表情（不是图片）。id 是 QQ 表情序号：14=微笑、13=呲牙、12=调皮、9=笑哭、5=大哭、109=抱抱…；也可传 text 当兜底文字。',
      parameters: {
        chat: { type: 'string', description: 'u-<uid> 私聊 / g-<群号> 群聊', required: true },
        id: { type: 'number', description: 'QQ 表情序号（faceIndex）', required: true },
        text: { type: 'string', description: '可选：兜底文字，像 [微笑]' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
      },
      async execute(args) {
        const key = String(args.chat || '').trim()
        const isGroup = key.startsWith('g-') || key.startsWith('G-')
        const peerUid = key.replace(/^[ugUG][-_]/, '')
        if (!peerUid) throw new Error('chat 得写成 u-<uid> 或 g-<群号>')
        const r = await bridge.face(isGroup ? 2 : 1, peerUid, { id: Number(args.id) || 0, text: args.text })
        return { ok: r?.ok === true, result: r?.result ?? null, err: r?.err ?? null, chat: key, id: Number(args.id) || 0 }
      },
    }))

    // 拍一拍：内核里就是 faceElement(faceType=5, pokeType=1)
    ctx.tools.register(defineTool({
      name: TP('qq_poke'),
      description: '拍一拍对方（私聊拍对方；群里拍的是一条带 poke 元素的消息）。',
      parameters: {
        chat: { type: 'string', description: 'u-<uid> 私聊 / g-<群号> 群聊', required: true },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
      },
      async execute(args) {
        const key = String(args.chat || '').trim()
        // ⚠ 2026-10-28 02:41（主人实测）：用 faceElement(faceType=5) 发出去，QQ 里显示成**一个表情**，
        //   不是「拍了拍你」那条灰条 —— 它不是真拍一拍。真拍一拍只有两条路：
        //   · 内核 `getMsgService().sendNudge(...)`（native，arity=0，签名全靠试）
        //   · OIDB 包（NapCat 用它自带的原生插件 napcat.packet.node 发的，我们壳里没有）
        //   在接通之前直接报错，别发出一坨看不懂的东西 ✗
        if (!key) throw new Error('chat 不能空')
        throw new Error('真拍一拍还没接通：现在只能发「看起来像表情」的假戳一戳，先不做。要试 sendNudge 得拿一个号去探签名（可能崩壳要重扫码）')
      },
    }))
    // ⚠ 2026-10-28 02:41 主人实测：上面这条 poke 发出去在 QQ 里**显示成一个表情**，
    //   不是「樱拍了拍你」那条灰条 —— 所以它不是真拍一拍，先禁用，别再误用 ✗
    //   真拍一拍要内核的 `MsgService.sendNudge`（native、签名未知）或 OIDB 包
    //   （NapCat 用的是它自带的原生插件 napcat.packet.node，我们壳里没有）

    ctx.tools.register(defineTool({
      name: TP('qq_history'),
      description: '翻聊天记录（私聊和群聊都行）。chat 写成 u-<uid> 或 g-<群号>，count 最多 100；seq 可选，从某条消息往前翻。',
      parameters: {
        chat: { type: 'string', description: 'u-<uid> 私聊 / g-<群号> 群聊', required: true },
        count: { type: 'number', description: '拉多少条（默认 20，最多 100）' },
        seq: { type: 'string', description: '可选：从这条消息序号往前翻' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
      },
      async execute(args) {
        const key = String(args.chat || '').trim()
        const isGroup = key.startsWith('g-') || key.startsWith('G-')
        const peerUid = key.replace(/^[ugUG][-_]/, '')
        if (!peerUid) throw new Error('chat 得写成 u-<uid> 或 g-<群号>')
        const r = await bridge.history(isGroup ? 2 : 1, peerUid, args.count ?? 20, args.seq ?? '')
        return { ok: r?.ok === true, count: r?.count ?? 0, messages: r?.messages ?? [], err: r?.err ?? null }
      },
    }))

    ctx.tools.register(defineTool({
      name: TP('qq_send_image'),
      description: '用自己 QQ 号发一张本地图片。chat 写成 u-<uid> 或 g-<群号>，path 是本地图片绝对路径。',
      parameters: {
        chat: { type: 'string', description: 'u-<uid> 私聊 / g-<群号> 群聊', required: true },
        path: { type: 'string', description: '本地图片绝对路径', required: true },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
      },
      async execute(args) {
        const key = String(args.chat || '').trim()
        const isGroup = key.startsWith('g-') || key.startsWith('G-')
        const peerUid = key.replace(/^[ugUG][-_]/, '')
        if (!peerUid) throw new Error('chat 得写成 u-<uid> 或 g-<群号>')
        const r = await bridge.sendImage(isGroup ? 2 : 1, peerUid, String(args.path || ''))
        return { ok: r?.ok === true, result: r?.result ?? null, err: r?.err ?? null, chat: key }
      },
    }))

    ctx.tools.register(defineTool({
      name: TP('qq_send_file'),
      description: '用自己 QQ 号发一个本地文件。chat 写成 u-<uid> 或 g-<群号>，path 是本地文件绝对路径。',
      parameters: {
        chat: { type: 'string', description: 'u-<uid> 私聊 / g-<群号> 群聊', required: true },
        path: { type: 'string', description: '本地文件绝对路径', required: true },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
      },
      async execute(args) {
        const key = String(args.chat || '').trim()
        const isGroup = key.startsWith('g-') || key.startsWith('G-')
        const peerUid = key.replace(/^[ugUG][-_]/, '')
        if (!peerUid) throw new Error('chat 得写成 u-<uid> 或 g-<群号>')
        const r = await bridge.sendFile(isGroup ? 2 : 1, peerUid, String(args.path || ''))
        return { ok: r?.ok === true, result: r?.result ?? null, err: r?.err ?? null, chat: key }
      },
    }))

    ctx.tools.register(defineTool({
      name: TP('qq_send_voice'),
      description: '用自己 QQ 号发一条语音。chat 写成 u-<uid> 或 g-<群号>；path 可以是任意音频（wav/mp3/amr/silk），不是 silk 会先本地编码；duration 不填就按音频长度算。',
      parameters: {
        chat: { type: 'string', description: 'u-<uid> 私聊 / g-<群号> 群聊', required: true },
        path: { type: 'string', description: '音频文件绝对路径（wav/mp3/amr/silk 都行）', required: true },
        duration: { type: 'number', description: '可选：时长（秒），不填自动算' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
      },
      async execute(args) {
        const key = String(args.chat || '').trim()
        const isGroup = key.startsWith('g-') || key.startsWith('G-')
        const peerUid = key.replace(/^[ugUG][-_]/, '')
        if (!peerUid) throw new Error('chat 得写成 u-<uid> 或 g-<群号>')
        const src = String(args.path || '')
        const silk = await toSilk(src, { ffmpegPath: cfg.ffmpegPath, silkEncoderPath: cfg.silkEncoderPath })
        const duration = Number(args.duration) || silk.duration || 0
        const r = await bridge.sendVoice(isGroup ? 2 : 1, peerUid, silk.silkPath, duration)
        await cleanupSilk(silk)
        return {
          ok: r?.ok === true, result: r?.result ?? null, err: r?.err ?? null, chat: key,
          converted: silk.converted, duration, silkPath: silk.silkPath,
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: TP('qq_reply'),
      description: '用自己 QQ 号引用某条消息回复。chat 写成 u-<uid> 或 g-<群号>；msgId 是那条消息的 msgId（可以不填，默认引用对方最近一条）；text 是要说的话。',
      parameters: {
        chat: { type: 'string', description: 'u-<uid> 私聊 / g-<群号> 群聊', required: true },
        text: { type: 'string', description: '要发的内容', required: true },
        msgId: { type: 'string', description: '可选：被引用消息的 msgId' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
      },
      async execute(args) {
        const key = String(args.chat || '').trim()
        const isGroup = key.startsWith('g-') || key.startsWith('G-')
        const peerUid = key.replace(/^[ugUG][-_]/, '')
        if (!peerUid) throw new Error('chat 得写成 u-<uid> 或 g-<群号>')
        const last = globalThis.__qqLastInbound?.get(key) || null
        const msgId = String(args.msgId || last?.msgId || '')
        const meta = !args.msgId && last ? { seq: last.msgSeq, time: last.time, senderUid: last.senderUid } : {}
        const r = await bridge.reply(isGroup ? 2 : 1, peerUid, msgId, String(args.text ?? ''), meta)
        return { ok: r?.ok === true, result: r?.result ?? null, err: r?.err ?? null, chat: key, msgId }
      },
    }))

    ctx.tools.register(defineTool({
      name: TP('qq_status'),
      description: '看 QQ 桥的状态：登录没登录、session/msgService 好没好、收件箱里排了几条。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
      },
      async execute() {
        const s = await bridge.status()
        return { ok: s?.ok === true, status: s }
      },
    }))
    }  // ← if (false)：旧的 9 个工具到此为止

    // ── 合并版：qq_send / qq_read ──
    const QQ_BRIDGE_RENDER = (_args, result) => [{ type: 'text', text: JSON.stringify(result) }]

    ctx.tools.register(defineTool({
      name: TP('qq_send'),
      description: '发 QQ。kind 决定发什么：text(默认,用 text)/image、file、voice(用 path)/face(用 faceId,可选 text 兜底)/reply(text+msgId 引用，不填 msgId 就引用对方最后一条)。chat 写 u-<uid> 或 g-<群号>；at/atNick 只在群里有用；poke 现在发不了。',
      parameters: {
        chat: { type: 'string', description: 'u-<uid> / g-<群号>', required: true },
        kind: { type: 'string', description: 'text/image/file/voice/face/reply' },
        text: { type: 'string' },
        path: { type: 'string' },
        faceId: { type: 'number' },
        msgId: { type: 'string' },
        at: { type: 'string' },
        atNick: { type: 'string' },
        duration: { type: 'number' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: QQ_BRIDGE_RENDER },
      async execute(args) {
        const key = String(args.chat || '').trim()
        const chatType = /^[gG]-/.test(key) ? 2 : 1
        const peerUid = key.replace(/^[ugUG][-_]/, '')
        if (!peerUid) throw new Error('chat 得写成 u-<uid> 或 g-<群号>')
        const kind = String(args.kind || 'text').toLowerCase()
        if (kind === 'image' || kind === 'file' || kind === 'voice') {
          const p = String(args.path || '')
          const r = kind === 'image' ? await bridge.sendImage(chatType, peerUid, p)
            : kind === 'file' ? await bridge.sendFile(chatType, peerUid, p)
              : await bridge.sendVoice(chatType, peerUid, p, args.duration)
          return { ok: r?.ok === true, kind, chat: key, path: p }
        }
        if (kind === 'face') {
          const r = await bridge.face(chatType, peerUid, { id: Number(args.faceId) || 0, text: String(args.text || '') })
          return { ok: r?.ok === true, kind, chat: key }
        }
        const text = String(args.text ?? '')
        if (kind === 'reply') {
          const last = globalThis.__qqLastInbound?.get(key) || null
          const msgId = String(args.msgId || last?.msgId || '')
          const meta = !args.msgId && last ? { seq: last.msgSeq, time: last.time, senderUid: last.senderUid } : {}
          const r = await bridge.reply(chatType, peerUid, msgId, text, meta)
          return { ok: r?.ok === true, kind, chat: key, msgId }
        }
        const r = await bridge.send(chatType, peerUid, text, args.at, args.atNick)
        return { ok: r?.ok === true, kind: 'text', chat: key, result: r?.result ?? null }
      },
    }))

    ctx.tools.register(defineTool({
      name: TP('qq_read'),
      description: '读 QQ。kind: status(桥的登录态/收件箱，不用 chat)/history(聊天记录，要 chat)。count ≤100 默认 20；seq 从某条往前翻。',
      parameters: {
        kind: { type: 'string', description: 'status/history' },
        chat: { type: 'string' },
        count: { type: 'number' },
        seq: { type: 'number' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: QQ_BRIDGE_RENDER },
      async execute(args) {
        const kind = String(args.kind || 'history').toLowerCase()
        if (kind === 'status') {
          const s = await bridge.status()
          return { ok: s?.ok === true, status: s }
        }
        const key = String(args.chat || '').trim()
        const chatType = /^[gG]-/.test(key) ? 2 : 1
        const peerUid = key.replace(/^[ugUG][-_]/, '')
        if (!peerUid) throw new Error('history 要给 chat：u-<uid> 或 g-<群号>')
        const r = await bridge.history(chatType, peerUid, Math.min(100, Number(args.count) || 20), args.seq ? Number(args.seq) : '')
        return { ok: r?.ok !== false, chat: key, messages: r?.result ?? r }
      },
    }))
  }
  } catch (err) { warn('注册工具失败（不影响分流）：', err?.message || err) }

  // ── 设置页用：读写运行时覆盖（home\xykp\qq-adapter\ui-config.json）──
  // 2026-10-29：把原来 39273/adapter-ui 那个独立页面搬进 DSH 设置页
  try {
    // ⚠ inject 里没有 webServer → 直接读 ctx.webServer 会抛，用 ctx.get
    const webServer = (() => { try { return ctx.get('webServer') } catch { return null } })()
    if (webServer && typeof webServer.register === 'function') {
      const route = (path, handler) =>
        ctx.effect(() => webServer.register({ kind: 'exact', path, handler }))
      route('/dsh-qq-adapter/overrides', async (req, res) => {
        const send = (code, body) => {
          try {
            res.writeHead(code, { 'content-type': 'application/json' })
            res.end(JSON.stringify(body))
          } catch (e) { /* 连接没了就算了 */ }
        }
        try {
          const file = overridePath()
          if (req.method === 'GET') {
            const all = await readOverride()
            return send(200, { ok: true, instance: INST, overrides: all[INST] || all.default || {} })
          }
          if (req.method !== 'POST') return send(405, { ok: false, error: '只能 GET / POST' })
          let body = ''
          for await (const chunk of req) body += chunk
          const patch = JSON.parse(body || '{}')
          const all = await readOverride()
          all[INST] = { ...(all[INST] || all.default || {}), ...patch }
          await mkdir(dirname(file), { recursive: true })
          await writeFile(file, JSON.stringify(all, null, 2), 'utf8')
          return send(200, { ok: true, instance: INST, overrides: all[INST] })
        } catch (err) {
          return send(500, { ok: false, error: String(err?.message || err) })
        }
      })
      log('设置页端点已挂：/dsh-qq-adapter/overrides')
    } else {
      warn('宿主没有 webServer，设置页改动端没挂上（不影响分流）')
    }
  } catch (err) { warn('挂设置页端点失败（不影响分流）：', err?.message || err) }
}

export const _internal = { resolveTarget, deliver, SOURCE_KIND }



