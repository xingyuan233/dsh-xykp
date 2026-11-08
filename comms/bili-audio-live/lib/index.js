// bili-audio-live · 宿主半边
//
// 盯 B 站直播间：弹幕（WS）+ 主播语音（ffmpeg 抽音轨 → silero VAD → 本地 SenseVoice），
// 按 binding 攒批投递到「那条绑定指定的」对话/预设。
//
// 配置模型（2026-11-06 重构）：
//   rooms    —— 纯静态目录 [{ roomId, name }]
//   bindings —— 真正的绑定：[{ target: 'p-xx' | 's-xx', roomId, enabled, danmaku, audio }]
//   同一个 target 只允许挂一个房间（否则两路消息会串进同一个对话）。
//
// 原则：任何一路挂了只降级；所有投递必须 await followup（未处理 rejection = 宿主退出）。
import fs from 'node:fs'
import { join } from 'node:path'
import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { configFor } from '../../../ui/store.js'
import { loadCredential, fetchWbiKeys, getLiveStreams, getDanmuServer, homeDir } from './bili.js'
import { DanmakuClient } from './danmaku.js'
import { AudioCapture, cleanupStaleFfmpeg } from './audio.js'
import { AsrClient } from './asr-client.js'
import { deliver } from './deliver.js'
import { resolveTarget } from './bind.js'
import { sendDanmaku, sendGift, listEmoticons } from './send.js'

let defineTool = (spec) => spec
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  if (mod && typeof mod.defineTool === 'function') defineTool = mod.defineTool
} catch {
  /* 自测环境没有宿主包，用恒等实现 */
}

export const name = 'bili-audio-live'
export const inject = ['tools', 'agents', 'sessions', 'sessionPersistence', 'webServer']

function moduleMark(text) {
  try {
    const dir = join(process.env.DSH_HOME || 'D:\\AI\\DeepseekHarness\\home', 'xykp', 'bili-audio-live')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(join(dir, 'debug.log'), `${new Date().toISOString()} ${text}\n`, 'utf8')
  } catch {
    /* 排障用，失败无所谓 */
  }
}
moduleMark('module loaded')

export const DEFAULTS = {
  enabled: false,
  dryRun: false,
  // 静态房间目录
  rooms: [],
  // 绑定：一条 = 一个房间 → 一个对话/预设
  bindings: [],
  // 兼容老配置：bindings 为空时，用 session/preset + 第一个房间
  session: '',
  preset: '',
  sources: { danmaku: true, audio: true },
  pacing: {
    minIntervalSec: 120,
    maxWaitSec: 420,
    minSentences: 5,
    maxSentences: 40,
    minDanmaku: 8,
    maxDanmaku: 60,
    maxChars: 1500,
    renderDanmakuCap: 80,
  },
  schedule: { windows: [] },
  asr: {
    enabled: true,
    modelDir: '',
    vadModel: '',
    vadThreshold: 0.5,
    language: 'zh',
    numThreads: 4,
    ffmpegPath: 'ffmpeg',
    minSpeechMs: 240,
    cutSilenceMs: 600,
    maxUtteranceMs: 20000,
    minSegmentSec: 0.45,
    mergeGapMs: 600,
    mergeMaxSec: 22,
    threshold: 380,
  },
  // 主动发送（写操作，默认全关）
  send: {
    enabled: false,
    gift: { enabled: false, minYuan: 1, maxYuan: 50, maxPerSend: 1, allow: [] },
  },
  pushGift: true,
  pushGuard: true,
  logLines: 60,
}

function ring(max) {
  const arr = []
  return {
    push(line) {
      arr.push(line)
      if (arr.length > max) arr.splice(0, arr.length - max)
    },
    list() {
      return arr.slice()
    },
  }
}

function parseWindow(text) {
  const m = String(text || '').trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const toMin = (h, mm) => Number(h) * 60 + Number(mm)
  return { from: toMin(m[1], m[2]), to: toMin(m[3], m[4]) }
}

function inWindow(win, nowMinutes) {
  if (!win) return false
  if (win.from <= win.to) return nowMinutes >= win.from && nowMinutes < win.to
  return nowMinutes >= win.from || nowMinutes < win.to
}

function hhmm(d = new Date()) {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

/** rooms 两种写法都认：数组 / 映射（控制台空表会长成 {}） */
function normalizeRooms(rooms) {
  if (Array.isArray(rooms)) {
    return rooms.map((r) => (typeof r === 'object' && r ? { ...r } : { roomId: String(r) })).filter((r) => r.roomId || r.id)
  }
  if (rooms && typeof rooms === 'object') {
    return Object.entries(rooms)
      .map(([k, v]) => (v && typeof v === 'object' ? { ...v, roomId: v.roomId || k } : { roomId: k, name: String(v ?? '') }))
      .filter((r) => r.roomId)
  }
  return []
}

/** 'p-alive' → 预设；'s-xxx' / 'session-xxx' → 会话；空 → 用老配置兜底 */
function parseTarget(target) {
  const t = String(target || '').trim()
  if (!t) return {}
  if (t.startsWith('p-')) return { preset: t.slice(2) }
  if (t.startsWith('s-')) {
    const rest = t.slice(2)
    return { session: rest.startsWith('session-') ? rest : `session-${rest}` }
  }
  if (t.startsWith('session-')) return { session: t }
  return { session: t }
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...configFor('bili-audio-live', config) }
  const pacing = { ...DEFAULTS.pacing, ...(cfg.pacing || {}) }
  const sources = { ...DEFAULTS.sources, ...(cfg.sources || {}) }
  const asrCfg = { ...DEFAULTS.asr, ...(cfg.asr || {}) }
  const sched = { ...DEFAULTS.schedule, ...(cfg.schedule || {}) }
  const sendCfg = {
    ...DEFAULTS.send,
    ...(cfg.send || {}),
    gift: { ...DEFAULTS.send.gift, ...((cfg.send && cfg.send.gift) || {}) },
  }

  moduleMark(`apply start enabled=${cfg.enabled} bindings=${Array.isArray(cfg.bindings) ? cfg.bindings.length : 0}`)

  const logs = ring(Math.max(10, Number(cfg.logLines) || 60))
  const logFile = join(homeDir(), 'xykp', 'bili-audio-live', 'debug.log')
  const log = (msg) => {
    const line = `${hhmm()} ${msg}`
    logs.push(line)
    try {
      console.log('[bili-audio-live]', msg)
    } catch {
      /* ignore */
    }
    void mkdir(join(homeDir(), 'xykp', 'bili-audio-live'), { recursive: true })
      .then(() => appendFile(logFile, line + '\n', 'utf8'))
      .catch(() => {})
  }
  const warn = (msg) => log('⚠ ' + msg)

  const gen = (globalThis.__biliAudioLiveGen = (globalThis.__biliAudioLiveGen || 0) + 1)

  const pauseFile = join(homeDir(), 'xykp', 'bili-audio-live', 'paused.json')
  let manualPaused = !cfg.enabled || fs.existsSync(pauseFile)

  const pidLedger = join(homeDir(), 'xykp', 'bili-audio-live', 'ffmpeg.pids')
  try {
    cleanupStaleFfmpeg(pidLedger, log)
  } catch {
    /* ignore */
  }

  const state = {
    startedAt: null,
    channels: new Map(), // key -> channel
    asr: null,
    cred: null,
    keys: null,
    tick: null,
    scheduleTimer: null,
    lastError: '',
    deliveries: 0,
  }

  const isStale = () => globalThis.__biliAudioLiveGen !== gen

  // ── 目标解析 ────────────────────────────────────────────────────────────
  async function loadBinder() {
    try {
      return JSON.parse(await readFile(join(homeDir(), 'xykp', 'preset-binder', 'preset-binder.json'), 'utf8'))
    } catch {
      return null
    }
  }

  async function targetSessionId(target) {
    const parsed = parseTarget(target)
    if (!parsed.session && !parsed.preset) return ''
    const binder = await loadBinder()
    const t = resolveTarget(parsed, binder)
    return (t && t.sessionId) || ''
  }

  // ── 房间 / 绑定 ─────────────────────────────────────────────────────────
  function roomName(roomId) {
    const hit = normalizeRooms(cfg.rooms).find((r) => String(r.roomId) === String(roomId))
    return hit?.name || String(roomId)
  }

  /** 归一化 bindings；没写 bindings 时用 session/preset + 第一个房间兜底。 */
  let bindingsWarned = false
  function normalizeBindings() {
    const raw = Array.isArray(cfg.bindings) ? cfg.bindings : []
    const list = raw
      .filter((b) => b && typeof b === 'object')
      .map((b) => ({
        target: String(b.target || b.session || b.preset || '').trim(),
        roomId: String(b.roomId || b.room || '').trim(),
        enabled: b.enabled !== false,
        danmaku: b.danmaku !== false,
        audio: b.audio !== false,
        windows: Array.isArray(b.windows) ? b.windows : Array.isArray(b.schedule?.windows) ? b.schedule.windows : null,
      }))
      .filter((b) => b.target && b.roomId)

    if (list.length) {
      const seen = new Map()
      const out = []
      for (const b of list) {
        const n = (seen.get(b.target) || 0) + 1
        seen.set(b.target, n)
        if (n > 1) {
          // 只在第一次算的时候喊一声，status() 每次都要调用，不能刷屏
          if (!bindingsWarned) {
            warn(`绑定冲突：${b.target} 已经绑过一个房间，跳过 ${b.roomId}（一个对话只能盯一个房间）`)
          }
          continue
        }
        out.push(b)
      }
      bindingsWarned = true
      return out
    }

    const rooms = normalizeRooms(cfg.rooms)
    const target = cfg.session ? `s-${cfg.session}` : cfg.preset ? `p-${cfg.preset}` : ''
    if (target && rooms[0]) {
      return [
        {
          target,
          roomId: String(rooms[0].roomId),
          enabled: true,
          danmaku: sources.danmaku,
          audio: sources.audio,
          windows: null,
        },
      ]
    }
    return []
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────
  function renderBatch(ch, reason) {
    const buf = ch.buf
    const pickAudio = buf.audio.slice()
    const pickDan = buf.danmaku.slice(-Math.max(1, Number(pacing.renderDanmakuCap) || 80))
    const events = buf.events.slice(-20)
    const from = pickAudio[0]?.time || pickDan[0]?.time || ''
    const to = pickAudio[pickAudio.length - 1]?.time || pickDan[pickDan.length - 1]?.time || ''
    const lines = []
    lines.push(
      `【B站直播·${ch.name}·${reason}】${from}${to && to !== from ? '~' + to : ''}　语音 ${pickAudio.length} 句 / 弹幕 ${buf.danmaku.length} 条`,
    )
    if (pickAudio.length) {
      lines.push('')
      lines.push('— 说了什么 —')
      for (const a of pickAudio) lines.push(`${a.time} ${a.text}`)
    }
    if (events.length) {
      lines.push('')
      lines.push('— 礼物/SC/上舰 —')
      for (const e of events) lines.push(`${e.time} ${e.text}`)
    }
    if (pickDan.length) {
      lines.push('')
      lines.push('— 弹幕 —')
      const merged = []
      const index = new Map()
      for (const d of pickDan) {
        const key = `${(d.ats || []).join('@')}|${d.text || ''}`
        const hit = index.get(key)
        if (hit) {
          hit.n++
          continue
        }
        const row = { ...d, n: 1 }
        index.set(key, row)
        merged.push(row)
      }
      for (const row of merged) {
        const at = row.ats && row.ats.length ? `@${row.ats.join(' @')} ` : ''
        lines.push(`${row.time} ${row.user}：${at}${row.text}${row.n > 1 ? `（×${row.n}）` : ''}`)
      }
    }
    if (buf.danmaku.length > pickDan.length) lines.push(`…另有 ${buf.danmaku.length - pickDan.length} 条弹幕未列出`)
    let text = lines.join('\n')
    const max = Math.max(200, Number(pacing.maxChars) || 1500)
    if (text.length > max) text = text.slice(0, max) + '…（截断）'
    return text
  }

  async function flushChannel(ch, reason = '定时') {
    if (isStale()) return { ok: false, error: 'stale-instance' }
    const empty = !ch.buf.audio.length && !ch.buf.danmaku.length && !ch.buf.events.length
    if (empty) return { ok: false, error: '没有内容' }
    const text = renderBatch(ch, reason)
    if (cfg.dryRun) {
      log(`[dryRun][${ch.name}] ${reason} 批 ${text.length} 字：\n${text}`)
      ch.lastDeliver = Date.now()
      ch.buf = { audio: [], danmaku: [], events: [], firstAt: 0 }
      state.deliveries++
      return { ok: true, dryRun: true, chars: text.length }
    }
    try {
      const sessionId = await targetSessionId(ch.target)
      if (!sessionId) throw new Error(`绑定 ${ch.target} 解析不到会话`)
      await deliver(ctx, sessionId, text, log)
      ch.lastDeliver = Date.now()
      ch.buf = { audio: [], danmaku: [], events: [], firstAt: 0 }
      state.deliveries++
      log(`投递 #${state.deliveries} [${ch.name}]（${reason}，${text.length} 字）→ ${sessionId}`)
      return { ok: true, chars: text.length, sessionId }
    } catch (e) {
      state.lastError = e.message
      warn(`[${ch.name}] 投递失败：${e.message}`)
      const half = Math.floor(ch.buf.danmaku.length / 2)
      if (half > 0) ch.buf.danmaku.splice(0, half)
      return { ok: false, error: e.message }
    }
  }

  // ── 语音 ────────────────────────────────────────────────────────────────
  function asrModelDir() {
    return asrCfg.modelDir || join(homeDir(), 'xykp', 'bili-audio-live', 'models', 'sensevoice')
  }

  function ensureAsr() {
    if (!asrCfg.enabled) return null
    if (state.asr) return state.asr
    state.asr = new AsrClient({
      modelDir: asrModelDir(),
      language: asrCfg.language,
      numThreads: asrCfg.numThreads,
      log,
    })
    void state.asr.start()
    return state.asr
  }

  // ── 通道启停 ────────────────────────────────────────────────────────────
  function channelKey(b) {
    return `${b.target}|${b.roomId}`
  }

  async function startChannel(b) {
    const key = channelKey(b)
    stopChannel(key)
    const ch = {
      key,
      target: b.target,
      roomId: b.roomId,
      name: roomName(b.roomId),
      windows: b.windows,
      buf: { audio: [], danmaku: [], events: [], firstAt: 0 },
      lastDeliver: 0,
      danmaku: null,
      audio: null,
      status: 'starting',
    }
    state.channels.set(key, ch)
    if (isStale()) return

    if (sources.danmaku && b.danmaku) {
      try {
        const client = new DanmakuClient({
          roomId: Number(ch.roomId),
          cred: state.cred,
          keys: state.keys,
          getServer: () => getDanmuServer(Number(ch.roomId), state.cred, state.keys),
          log,
        })
        client.on('danmaku', (d) => {
          if (isStale()) return
          if (!ch.buf.firstAt) ch.buf.firstAt = Date.now()
          ch.buf.danmaku.push({ ts: Date.now(), time: hhmm(), user: d.user, text: d.text, ats: d.ats || [] })
          if (ch.buf.danmaku.length > 500) ch.buf.danmaku.splice(0, 100)
        })
        client.on('superchat', (s) => {
          if (isStale()) return
          if (!ch.buf.firstAt) ch.buf.firstAt = Date.now()
          ch.buf.events.push({ time: hhmm(), text: `SC ¥${s.price} ${s.user}：${s.text}` })
        })
        client.on('gift', (g) => {
          if (!cfg.pushGift || isStale()) return
          if (!ch.buf.firstAt) ch.buf.firstAt = Date.now()
          const price = g.price ? `（¥${g.price}）` : ''
          ch.buf.events.push({ time: hhmm(), text: `${g.user} ${g.action || '送出'} ${g.giftName}×${g.num}${price}` })
        })
        client.on('guard', (g) => {
          if (!cfg.pushGuard || isStale()) return
          if (!ch.buf.firstAt) ch.buf.firstAt = Date.now()
          ch.buf.events.push({
            time: hhmm(),
            text: `${g.user} 开通了 ${g.level}（×${g.num || 1}${g.price ? `，¥${g.price}` : ''}）`,
          })
        })
        client.connect()
        ch.danmaku = client
      } catch (e) {
        warn(`[${ch.name}] 弹幕启动失败：${e.message}`)
      }
    }

    if (sources.audio && b.audio) {
      const asr = ensureAsr()
      if (asr && !asr.ready) warn(`[${ch.name}] ASR 还没就绪，后台加载中`)
      if (asr) {
        try {
          const cap = new AudioCapture({
            roomId: Number(ch.roomId),
            cred: state.cred,
            ffmpegPath: asrCfg.ffmpegPath,
            getStreams: () => getLiveStreams(Number(ch.roomId), state.cred),
            log,
            vadModel: asrCfg.vadModel || join(asrModelDir(), '..', 'silero', 'silero_vad.onnx'),
            vadThreshold: asrCfg.vadThreshold,
            minSpeechMs: asrCfg.minSpeechMs,
            cutSilenceMs: asrCfg.cutSilenceMs,
            maxUtteranceMs: asrCfg.maxUtteranceMs,
            threshold: asrCfg.threshold,
            pidLedger,
          })

          let pendingSeg = null
          let pendingTimer = null
          const flushSeg = async () => {
            const job = pendingSeg
            pendingSeg = null
            clearTimeout(pendingTimer)
            pendingTimer = null
            if (!job || !job.samples.length || isStale()) return
            const text = await asr.transcribe(job.samples)
            const clean = String(text || '').replace(/\s+/g, ' ').trim()
            if (!clean || clean.length < 2) return
            if (!ch.buf.firstAt) ch.buf.firstAt = Date.now()
            ch.buf.audio.push({ ts: Date.now(), time: hhmm(), text: clean, sec: job.samples.length / 16000 })
          }
          const MERGE_GAP_MS = Math.max(0, Number(asrCfg.mergeGapMs ?? 600))
          const MERGE_MAX_SEC = Math.max(5, Number(asrCfg.mergeMaxSec ?? 22))
          cap.on('segment', ({ samples, seconds }) => {
            if (isStale()) return
            if (seconds < Math.max(0.2, Number(asrCfg.minSegmentSec ?? 0.45))) return
            const maxSamples = MERGE_MAX_SEC * 16000
            if (pendingSeg && pendingSeg.samples.length + samples.length <= maxSamples) {
              const merged = new Float32Array(pendingSeg.samples.length + samples.length)
              merged.set(pendingSeg.samples, 0)
              merged.set(samples, pendingSeg.samples.length)
              pendingSeg = { samples: merged }
            } else {
              if (pendingSeg) void flushSeg()
              pendingSeg = { samples }
            }
            clearTimeout(pendingTimer)
            pendingTimer = setTimeout(() => void flushSeg(), MERGE_GAP_MS)
            if (typeof pendingTimer.unref === 'function') pendingTimer.unref()
          })
          cap.on('offline', (title) => log(`[${ch.name}] 未开播${title ? '：' + title : ''}`))
          cap.start()
          ch.audio = cap
        } catch (e) {
          warn(`[${ch.name}] 音频启动失败：${e.message}`)
        }
      }
    }

    ch.status = 'running'
    log(`[${ch.name}] 开盯 ${b.target}（弹幕${ch.danmaku ? '✓' : '✗'} 语音${ch.audio ? '✓' : '✗'}）`)
  }

  function stopChannel(key) {
    const ch = state.channels.get(key)
    if (!ch) return
    try {
      ch.danmaku?.close()
    } catch {
      /* ignore */
    }
    try {
      ch.audio?.stop()
    } catch {
      /* ignore */
    }
    ch.status = 'stopped'
    state.channels.delete(key)
  }

  async function startAll() {
    if (isStale()) return { ok: false, error: 'stale-instance' }
    if (state.startedAt) return { ok: true, already: true }
    manualPaused = false
    try {
      fs.rmSync(pauseFile, { force: true })
    } catch {
      /* ignore */
    }
    state.startedAt = Date.now()
    state.lastError = ''
    try {
      state.cred = loadCredential()
      const keys = await fetchWbiKeys(state.cred)
      state.keys = keys
      log(`登录态：${keys.uname || '(未知)'}`)
    } catch (e) {
      state.startedAt = null
      state.lastError = e.message
      warn(`启动失败：${e.message}`)
      return { ok: false, error: e.message }
    }
    const bindings = normalizeBindings().filter((b) => b.enabled)
    if (!bindings.length) warn('没有启用的绑定（config.bindings）')
    for (const b of bindings) await startChannel(b)
    scheduleTick()
    return { ok: true, channels: state.channels.size }
  }

  function stopAll(reason = '手动') {
    for (const key of [...state.channels.keys()]) stopChannel(key)
    state.startedAt = null
    clearInterval(state.tick)
    state.tick = null
    try {
      state.asr?.close()
    } catch {
      /* ignore */
    }
    state.asr = null
    log(`停止（${reason}）`)
  }

  function pauseNow(reason) {
    stopAll(reason)
    manualPaused = true
    try {
      fs.writeFileSync(pauseFile, JSON.stringify({ pausedAt: new Date().toISOString(), reason }), 'utf8')
    } catch {
      /* ignore */
    }
  }

  // ── 节奏 ────────────────────────────────────────────────────────────────
  function shouldDeliver(ch, now) {
    const audioN = ch.buf.audio.length
    const danN = ch.buf.danmaku.length + ch.buf.events.length
    if (!audioN && !danN) return ''
    const sinceLast = now - (ch.lastDeliver || state.startedAt || now)
    if (sinceLast < Number(pacing.minIntervalSec) * 1000) return ''
    const age = now - (ch.buf.firstAt || now)
    if (age >= Number(pacing.maxWaitSec) * 1000) return '等久了'
    if (audioN >= Number(pacing.maxSentences)) return '语句够多'
    if (danN >= Number(pacing.maxDanmaku)) return '弹幕够多'
    if (audioN >= Number(pacing.minSentences)) return '语句够了'
    if (danN >= Number(pacing.minDanmaku)) return '弹幕够了'
    return ''
  }

  function scheduleTick() {
    clearInterval(state.tick)
    state.tick = setInterval(() => {
      if (isStale()) return
      const now = Date.now()
      for (const ch of state.channels.values()) {
        const reason = shouldDeliver(ch, now)
        if (reason) void flushChannel(ch, reason)
      }
    }, 3000)
    if (typeof state.tick.unref === 'function') state.tick.unref()
  }

  function windowsOf(list) {
    const w = list && list.length ? list : sched.windows
    return (Array.isArray(w) ? w : []).map(parseWindow).filter(Boolean)
  }

  function inWindowsNow(wins) {
    if (!wins.length) return true
    const d = new Date()
    const nowMin = d.getHours() * 60 + d.getMinutes()
    return wins.some((w) => inWindow(w, nowMin))
  }

  function inScheduleNow(ch) {
    return inWindowsNow(windowsOf(ch.windows))
  }

  // ── 状态 ────────────────────────────────────────────────────────────────
  function status() {
    const channels = [...state.channels.values()].map((ch) => ({
      target: ch.target,
      roomId: ch.roomId,
      name: ch.name,
      status: ch.status,
      inWindow: inScheduleNow(ch),
      danmaku: ch.danmaku?.status || 'off',
      audio: ch.audio?.status || 'off',
      segments: ch.audio?.segments || 0,
      buffer: { audio: ch.buf.audio.length, danmaku: ch.buf.danmaku.length, events: ch.buf.events.length },
      lastDeliver: ch.lastDeliver ? new Date(ch.lastDeliver).toISOString() : null,
    }))
    return {
      ok: true,
      running: Boolean(state.startedAt),
      gen,
      pausedManual: manualPaused,
      since: state.startedAt ? new Date(state.startedAt).toISOString() : null,
      bindings: normalizeBindings().map((b) => ({ ...b, name: roomName(b.roomId) })),
      channels,
      pacing,
      sources,
      asr: state.asr ? state.asr.status : { ready: false, modelDir: asrModelDir() },
      send: { enabled: !!sendCfg.enabled, gift: sendCfg.gift },
      deliveries: state.deliveries,
      lastError: state.lastError,
      logs: logs.list(),
    }
  }

  // ── 主动发送 ────────────────────────────────────────────────────────────
  async function doSendDanmaku({ roomId, text, emoticon }) {
    if (!sendCfg.enabled) throw new Error('主动发送未启用（config.send.enabled=false）')
    const cred = state.cred || loadCredential()
    let msg = text
    if (emoticon) {
      const list = await listEmoticons(cred, Number(roomId) || 0)
      const key = String(emoticon).replace(/^\[|\]$/g, '')
      const hit = list.find((x) => x.name === key) || list.find((x) => x.name.includes(key))
      if (!hit) throw new Error(`没找到表情「${emoticon}」（共 ${list.length} 个）`)
      msg = hit.text
    }
    if (!msg) throw new Error('要有 text 或 emoticon')
    return sendDanmaku(cred, roomId, msg)
  }

  async function doSendGift({ roomId, giftName, giftId, num }) {
    if (!sendCfg.enabled) throw new Error('主动发送未启用（config.send.enabled=false）')
    const cred = state.cred || loadCredential()
    return sendGift(cred, roomId, { giftName, giftId, num, policy: sendCfg.gift })
  }

  function pickChannel(roomId) {
    const all = [...state.channels.values()]
    if (!all.length) return null
    if (roomId) {
      const hit = all.find((c) => String(c.roomId) === String(roomId))
      if (hit) return hit
    }
    return all[0]
  }

  // ── 工具 ────────────────────────────────────────────────────────────────
  const tools = ctx.tools || (typeof ctx.get === 'function' ? ctx.get('tools') : null)
  if (tools && typeof tools.register === 'function') {
    try {
      tools.register(
        defineTool({
          name: 'bili_audio_live',
          description:
            '看 B 站直播：按 bindings 盯房间，弹幕+主播语音（本地识别）攒批投递到各自绑定的对话。支持状态/开关/立刻投递/预览，以及（需显式开启）发弹幕、发表情、送礼。',
          parameters: {
            action: {
              type: 'string',
              required: true,
              enum: ['status', 'start', 'stop', 'flush', 'preview', 'emoticons', 'danmaku', 'gift'],
              description:
                'status 状态 / start 开 / stop 关 / flush 立刻投 / preview 只看 / emoticons 表情列表 / danmaku 发弹幕或表情 / gift 送礼',
            },
            roomId: { type: 'string', description: '操作哪个房间（默认第一个通道）' },
            text: { type: 'string', description: '发弹幕的内容' },
            emoticon: { type: 'string', description: '发表情（表情名），和 text 二选一' },
            giftName: { type: 'string', description: '礼物名' },
            giftId: { type: 'string', description: '礼物 id（优先于名字）' },
            num: { type: 'number', description: '数量，默认 1' },
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: {} },
            render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
          },
          execute: async (args = {}) => {
            const action = String(args.action || 'status')
            try {
              if (action === 'start') return { ok: true, result: await startAll(), status: status() }
              if (action === 'stop') {
                pauseNow('工具调用')
                return { ok: true, status: status() }
              }
              if (action === 'preview') {
                const ch = pickChannel(args.roomId)
                if (!ch) return { ok: false, error: '没有正在跑的通道' }
                return { ok: true, preview: renderBatch(ch, '预览'), status: status() }
              }
              if (action === 'flush') {
                const ch = pickChannel(args.roomId)
                if (!ch) return { ok: false, error: '没有正在跑的通道' }
                return { ok: true, result: await flushChannel(ch, '手动'), status: status() }
              }
              if (action === 'emoticons') {
                const cred = state.cred || loadCredential()
                const rid = Number(args.roomId || pickChannel()?.roomId || 0)
                const list = await listEmoticons(cred, rid)
                return { ok: true, count: list.length, emoticons: list.map((e) => ({ name: e.name, pkg: e.pkg, locked: e.locked })) }
              }
              if (action === 'danmaku') {
                const rid = Number(args.roomId || pickChannel()?.roomId || 0)
                const sent = await doSendDanmaku({ roomId: rid, text: args.text, emoticon: args.emoticon })
                return { ok: true, send: sent }
              }
              if (action === 'gift') {
                const rid = Number(args.roomId || pickChannel()?.roomId || 0)
                const sent = await doSendGift({ roomId: rid, giftName: args.giftName, giftId: args.giftId, num: args.num })
                return { ok: true, send: sent }
              }
              return status()
            } catch (e) {
              return { ok: false, error: e.message, status: status() }
            }
          },
        }),
      )
    } catch (e) {
      warn(`注册工具失败：${e.message}`)
    }
  }

  // ── HTTP ────────────────────────────────────────────────────────────────
  const webServer = ctx.webServer || (typeof ctx.get === 'function' ? ctx.get('webServer') : null)
  const sendJson = (res, code, obj) => {
    try {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(obj))
    } catch {
      /* ignore */
    }
  }
  if (webServer && typeof webServer.register === 'function') {
    try {
      ctx.effect(
        () =>
          webServer.register({
            kind: 'prefix',
            path: '/dsh-bili-audio-live',
            handler: async (req, res) => {
              const url = new URL(req.url || '/', 'http://127.0.0.1')
              const p = url.pathname.replace(/\/+$/, '')
              try {
                if (req.method === 'GET' && (p === '/dsh-bili-audio-live' || p === '/dsh-bili-audio-live/status')) {
                  return sendJson(res, 200, status())
                }
                if (req.method === 'POST' && p === '/dsh-bili-audio-live/start') {
                  return sendJson(res, 200, { ...(await startAll()), status: status() })
                }
                if (req.method === 'POST' && p === '/dsh-bili-audio-live/stop') {
                  pauseNow('HTTP')
                  return sendJson(res, 200, { ok: true, status: status() })
                }
                if (req.method === 'POST' && p === '/dsh-bili-audio-live/flush') {
                  const ch = pickChannel(url.searchParams.get('roomId'))
                  if (!ch) return sendJson(res, 400, { ok: false, error: '没有正在跑的通道' })
                  return sendJson(res, 200, { ...(await flushChannel(ch, 'HTTP')), status: status() })
                }
                return sendJson(res, 404, { ok: false, error: 'unknown ' + req.method + ' ' + p })
              } catch (e) {
                return sendJson(res, 500, { ok: false, error: e.message })
              }
            },
          }),
        'bili-audio-live 状态端点',
      )
    } catch (e) {
      warn(`注册 HTTP 端点失败：${e.message}`)
    }
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────
  // 条目级时段：出时段关掉那一条，回到时段再开；手动停过就完全不动
  state.scheduleTimer = setInterval(() => {
    if (isStale() || !state.startedAt || manualPaused) return
    for (const b of normalizeBindings().filter((x) => x.enabled)) {
      const key = channelKey(b)
      const ch = state.channels.get(key)
      const inWin = inWindowsNow(windowsOf(b.windows))
      if (!inWin && ch) {
        stopChannel(key)
        log(`[${roomName(b.roomId)}] 出时段，暂停`)
      } else if (inWin && !ch) {
        void startChannel(b)
        log(`[${roomName(b.roomId)}] 回到时段，恢复`)
      }
    }
  }, 30000)
  if (typeof state.scheduleTimer.unref === 'function') state.scheduleTimer.unref()

  ctx.on('dispose', () => {
    clearInterval(state.scheduleTimer)
    clearInterval(state.tick)
    for (const key of [...state.channels.keys()]) stopChannel(key)
    try {
      state.asr?.close()
    } catch {
      /* ignore */
    }
  })

  log(`装载（gen ${gen}）bindings ${normalizeBindings().length} 条，enabled=${cfg.enabled}`)
  if (cfg.enabled) void startAll()
  else log('未启用（config.enabled = false）')

  moduleMark('apply done')
  return { status, start: startAll, stop: () => pauseNow('外部') }
}
