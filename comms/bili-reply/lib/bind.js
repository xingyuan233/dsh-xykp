// bili-reply · 绑定解析
//
// 需求（任务-2026-10-27.md 第四节）：绑定对应的预设或会话，**预设优先**（参考 preset-binder）。
// 这里只做「给定配置 → 找到该推到哪儿」，不做 IO（调用方把 binder 表传进来）。

export const DEFAULTS = {
  preset: '', // 预设 id，优先级最高
  session: '', // 预设查不到时用它
  pollSeconds: 120,
}

/**
 * @param {object} cfg - { preset, session }
 * @param {object} binder - home/storages/preset-binder.json 的内容
 * @returns {{ sessionId: string, via: 'preset'|'session'|'none', preset?: string, reason?: string }}
 */
export function resolveTarget(cfg = {}, binder = null) {
  const preset = String(cfg.preset || '').trim()
  if (preset) {
    const active = binder && binder.presets && binder.presets[preset] && binder.presets[preset].active
    if (active && String(active).trim()) return { sessionId: String(active).trim(), via: 'preset', preset }
    return { sessionId: '', via: 'none', preset, reason: '预设没有活跃会话' }
  }
  const session = String(cfg.session || '').trim()
  if (session) return { sessionId: session, via: 'session' }
  return { sessionId: '', via: 'none', reason: '既没配预设也没配会话' }
}
