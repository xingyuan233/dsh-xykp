// bili-reply · 绑定解析
//
// 绑法（2026-11-05 改）：
//   · 只配 `session`：绑指定对话；
//   · 只配 `preset`：绑预设的最新对话（`active`，缺失时按 `lastActivityAt` 找）；
//   · 两个都配：指定对话优先；对话不在了（被删 / 没这个 id）→ 回退到预设的最新对话。
//
// 这里只做「给定配置 → 候选会话列表 / 选哪个」，不做 IO：
// 是否存在由调用方传 `exists(id)` 进来（宿主里用 sessionPersistence.stat 查）。

export const DEFAULTS = {
  preset: '', // 预设 id：绑它的最新对话，也当会话不存在时的兜底
  session: '', // 指定对话 id（绑对话时填这个，优先级最高）
  pollSeconds: 120,
}

const str = (v) => String(v == null ? '' : v).trim()

// 会话 id 有带 / 不带 `session-` 前缀两种写法，查存在性时都试一下
export function idForms(id) {
  const raw = str(id)
  if (!raw) return []
  const out = [raw]
  if (raw.startsWith('session-')) out.push(raw.slice('session-'.length))
  else out.push('session-' + raw)
  return [...new Set(out)]
}

/**
 * 预设里的会话，按「最新」排序：先 active，再按 lastActivityAt 倒序。
 * active 由 preset-binder 跟着最新会话走，这里仍排在第一位（用户显式绑过的优先），
 * 它不在了才轮到后面的。
 */
export function presetSessionIds(binder, preset) {
  const id = str(preset)
  const entry = id && binder && binder.presets && binder.presets[id]
  if (!entry) return []
  const out = []
  const seen = new Set()
  const push = (raw) => {
    const s = str(raw)
    if (!s || seen.has(s)) return
    seen.add(s)
    out.push(s)
  }
  push(entry.active)
  const rows = Object.entries(entry.sessions && typeof entry.sessions === 'object' ? entry.sessions : {})
    .map(([sid, meta]) => ({ sid, at: Date.parse(meta && meta.lastActivityAt) || 0 }))
    .sort((a, b) => b.at - a.at)
  for (const row of rows) push(row.sid)
  return out
}

/** 按优先级列出候选：指定对话 → 预设的最新对话（→ 预设里更早的）。 */
export function targetCandidates(cfg = {}, binder = null) {
  const preset = str(cfg.preset)
  const session = str(cfg.session)
  const out = []
  const seen = new Set()
  const push = (item) => {
    const id = str(item.sessionId)
    if (!id || seen.has(id)) return
    seen.add(id)
    out.push(item)
  }

  if (session) push({ sessionId: session, via: 'session' })

  if (preset) {
    for (const id of presetSessionIds(binder, preset)) {
      push({
        sessionId: id,
        via: session ? 'preset-fallback' : 'preset',
        preset,
        ...(session ? { fallbackFrom: session } : {}),
      })
    }
  }
  return out
}

/** 候选全没了时给一句能看懂的原因。 */
export function noTargetReason(cfg = {}, binder = null) {
  const preset = str(cfg.preset)
  const session = str(cfg.session)
  if (!preset && !session) return '既没配预设也没配会话'
  if (preset && !presetSessionIds(binder, preset).length) {
    return session ? `绑定的对话不在了，预设 ${preset} 也没有活跃会话` : `预设 ${preset} 没有活跃会话`
  }
  if (session && preset) return `绑定的对话和预设 ${preset} 的会话都不在了`
  if (session) return '绑定的对话不存在（也没配预设兜底）'
  return `预设 ${preset} 的会话都不在了`
}

/**
 * 同步版：只按配置排优先级，不查存在性（测试 / 不需要兜底的地方用）。
 * @returns {{ sessionId: string, via: 'preset'|'session'|'preset-fallback'|'none', preset?: string, fallbackFrom?: string, reason?: string }}
 */
export function resolveTarget(cfg = {}, binder = null) {
  const first = targetCandidates(cfg, binder)[0]
  if (first) return first
  return { sessionId: '', via: 'none', reason: noTargetReason(cfg, binder) }
}

/**
 * 真正拿来投递的版本：按优先级逐个问 `exists(id)`，第一个存在的胜出。
 * 指定对话不存在时会自然落到 `preset-fallback`（预设的最新对话）。
 *
 * @param {object} cfg - { preset, session }
 * @param {object} binder - home/xykp/preset-binder/preset-binder.json
 * @param {(id: string) => boolean|Promise<boolean>} exists - 判断会话是否还在
 */
export async function resolveExistingTarget(cfg = {}, binder = null, exists = null) {
  const candidates = targetCandidates(cfg, binder)
  if (!candidates.length) {
    return { sessionId: '', via: 'none', reason: noTargetReason(cfg, binder) }
  }
  if (typeof exists !== 'function') return candidates[0]

  for (const item of candidates) {
    let ok = false
    try {
      ok = Boolean(await exists(item.sessionId))
    } catch {
      ok = false
    }
    if (ok) return item
  }
  return {
    sessionId: '',
    via: 'none',
    reason: noTargetReason(cfg, binder),
    missing: candidates.map((c) => c.sessionId),
  }
}
