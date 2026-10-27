// bili-rove · 宿主半边（主动用的那半边）
//
// 需求（任务-2026-10-27.md 第四节）：
//   · 我主动做的事：搜视频、看详情、截帧、读评论、回评论、私信 —— 默认都带 cookie
//   · cookie 失效 → ntfy 推二维码，等一段时间（等扫码）
//   · 持续失败 → 回退不带 cookie 再试
//   · 匿名也被限制 → 返回失败
//   · 不再定时轮询 cookie
//
// ⚠️ 现状（2026-10-27 06:00）：
//   · 回退状态机、ntfy 推送、cookie 读取、工具注册、失败流程都就位并自测过
//   · **读能力已接**：search / video / subtitles 走 vendor/ 里的官方 provider（复制自 dsh-plugin-bilibili）
//   · **还没接**：frames / comments / reply / dm（调用会抛 BILI_ROVE_NOT_WIRED）
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { nextStep, DEFAULTS as FALLBACK_DEFAULTS } from './fallback.js'
import { notify, DEFAULTS as NTFY_DEFAULTS } from './ntfy.js'
import { createBackend } from './backend.js'

// 自测环境里没有宿主的 dsh-tools 包，用恒等实现兜底（宿主里拿到的才是真的 defineTool）
let defineTool = (spec) => spec
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  if (mod && typeof mod.defineTool === 'function') defineTool = mod.defineTool
} catch {
  /* 没有就算了，宿主里一定有 */
}

export const name = 'bili-rove'
export const inject = ['tools', 'systemPrompt']

const PREFIX = '[bili-rove]'
const log = (...a) => console.log(PREFIX, ...a)
const warn = (...a) => console.warn(PREFIX, ...a)

export const DEFAULTS = {
  ...FALLBACK_DEFAULTS,
  ...NTFY_DEFAULTS,
  cookie: '',
  cookieEnv: 'BILIBILI_SESSDATA',
  // bili-duty 的配置（扫码登录会写这里）
  dutyConfigPath: '',
  // 等扫码最长多久（秒），0 = 不等待，直接回退
  qrWaitSeconds: 60,
  // 检查 cookie 文件变化的间隔（秒）
  qrPollSeconds: 5,
}

const home = () => process.env.DSH_HOME || join(homedir(), '.dsh')

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** 读 cookie：配置 > 环境变量 > bili-duty/config.json */
export async function resolveCookie(cfg = {}) {
  const literal = String(cfg.cookie || '').trim()
  if (literal) return literal
  const env = String(cfg.cookieEnv || DEFAULTS.cookieEnv)
  const fromEnv = String(process.env[env] || '').trim()
  if (fromEnv) return fromEnv
  const path = cfg.dutyConfigPath || join(home(), 'bili-duty', 'config.json')
  const duty = await readJson(path, null)
  const fromFile = duty && typeof duty.cookie === 'string' ? duty.cookie.trim() : ''
  return fromFile || ''
}

/** 默认 backend：读能力（search/video/subtitles）已接 vendor 里的 provider；
 *  评论/回复/私信/截帧还没接，会抛 BILI_ROVE_NOT_WIRED。 */
export function makeBackend(cfg) {
  return createBackend({ baseUrl: cfg.baseUrl, userAgent: cfg.userAgent, timeoutMs: cfg.timeoutMs })
}

/** 等扫码：轮询 cookie 文件，变了就返回 true；超时返回 false */
async function waitForCookie(cfg, deps, before) {
  const wait = Math.max(0, Number(cfg.qrWaitSeconds) || 0)
  if (!wait) return false
  const every = Math.max(1, Number(cfg.qrPollSeconds) || 5) * 1000
  const deadline = Date.now() + wait * 1000
  for (;;) {
    await new Promise((r) => setTimeout(r, every))
    const now = await deps.cookie()
    if (now && now !== before) return true
    if (Date.now() >= deadline) return false
  }
}

/**
 * 带 cookie → 二维码等待 → 匿名 → 失败。
 * 抽成独立函数，方便用假 backend / 假 cookie 自测。
 */
export async function runWithFallback(action, args, cfg, deps) {
  const history = []
  let qrPushed = 0
  let anonymousTried = 0
  for (;;) {
    const step = nextStep(history, cfg)
    log(`action=${action} → ${step.mode}（${step.reason}）`)
    if (step.mode === 'fail') {
      return { ok: false, error: 'BILI_ROVE_LIMITED', reason: step.reason, tried: history.map((h) => h.mode) }
    }
    if (step.pushQr && qrPushed < 1) {
      qrPushed++
      await deps.pushQr(step.reason)
      const before = await deps.cookie()
      const got = await deps.waitForCookie(cfg, before)
      if (!got) log('二维码等待超时，继续按失败处理')
    }
    const cookie = step.mode === 'cookie' ? await deps.cookie() : ''
    try {
      const data = await deps.call({ action, args, cookie })
      history.push({ mode: step.mode, ok: true })
      return { ok: true, mode: step.mode, data }
    } catch (err) {
      if (step.mode === 'anonymous') anonymousTried++
      history.push({ mode: step.mode, ok: false, error: String(err?.message || err) })
      if (history.length > 12) {
        return { ok: false, error: 'BILI_ROVE_LOOP', reason: '回退次数过多', tried: history.map((h) => h.mode) }
      }
    }
  }
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  const backend = makeBackend(cfg)
  const deps = {
    cookie: () => resolveCookie(cfg),
    call: (req) => backend.call(req),
    pushQr: async (reason) => {
      const ok = await notify('B站登录失效', `需要扫码：${reason}\n扫完 cookie 会自动接上`, 'rotating_light', cfg)
      if (!ok) warn('ntfy 推送失败（不影响回退流程）')
      log(`已推二维码请求：${reason}`)
    },
    waitForCookie,
  }

  ctx.tools.register(defineTool({
    name: 'bili_rove',
    description:
      'B站主动操作（带 cookie）：search 搜视频 / video 详情 / subtitles 字幕 / frames 截帧 / comments 读评论 / reply 回评论 / dm 私信。' +
      'cookie 失效会自动推二维码到 ntfy 并等待，持续失败会回退匿名，匿名也被限制就直接报失败。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['search', 'video', 'subtitles', 'frames', 'comments', 'reply', 'dm'],
        description: '要做的操作',
      },
      keyword: { type: 'string', description: 'search 用的关键词' },
      bvid: { type: 'string', description: 'video / subtitles / frames / comments / reply 用的 BV 号' },
      rpid: { type: 'string', description: 'reply 要回的那条评论 id' },
      text: { type: 'string', description: 'reply / dm 要发的内容' },
      page: { type: 'number', description: '搜索页码，默认 1' },
    },
    async execute(args) {
      const action = String(args && args.action ? args.action : '').trim()
      if (!action) return { ok: false, error: 'BILI_ROVE_BAD_ARGS', reason: 'action 必填' }
      return runWithFallback(action, args || {}, cfg, deps)
    },
  }))
  log('已注册工具 bili_rove（backend 未接，见 README）')
}

export const _internal = { runWithFallback, resolveCookie, DEFAULTS }
export { nextStep, notify }
