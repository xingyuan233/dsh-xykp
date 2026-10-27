// bili-rove · cookie 回退决策（纯逻辑，可自测）
//
// 需求（任务-2026-10-27.md 第四节）：
//   · 默认带 cookie 干活
//   · 失败（cookie 失效 / 风控）→ 推二维码，等一段时间
//   · 持续失败 → 回退不带 cookie 再试
//   · 匿名也被限制 → 直接返回失败
//   · 不再定时轮询 cookie（过期概率低）

export const DEFAULTS = {
  maxCookieFailures: 3,
  maxAnonymousTries: 1,
}

/**
 * 决定下一步怎么打。
 * @param {Array<{mode:'cookie'|'anonymous', ok:boolean}>} history 本次调用里已经试过的
 * @returns {{ mode:'cookie'|'anonymous'|'fail', pushQr:boolean, reason:string }}
 */
export function nextStep(history = [], cfg = {}) {
  const opts = { ...DEFAULTS, ...(cfg || {}) }
  const last = history[history.length - 1]

  if (!last || last.ok) return { mode: 'cookie', pushQr: false, reason: 'ok' }

  if (last.mode === 'cookie') {
    const cookieFails = history.filter((h) => h.mode === 'cookie' && !h.ok).length
    if (cookieFails < Math.max(1, Number(opts.maxCookieFailures) || 1)) {
      return { mode: 'cookie', pushQr: true, reason: 'cookie 失效，推二维码等扫码' }
    }
    return { mode: 'anonymous', pushQr: false, reason: 'cookie 连续失败，回退匿名' }
  }

  const anonFails = history.filter((h) => h.mode === 'anonymous' && !h.ok).length
  if (anonFails < Math.max(1, Number(opts.maxAnonymousTries) || 1)) {
    return { mode: 'anonymous', pushQr: false, reason: '匿名再试一次' }
  }
  return { mode: 'fail', pushQr: false, reason: '匿名也被限制，放弃' }
}
