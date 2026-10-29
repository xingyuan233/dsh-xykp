// tooldesc-control —— 工具说明 + 工具懒加载 + 上下文重贴，三件事一个入口
//
// 2026-10-29 合体（主人要求）：原来拆在 chat/tool-gate 和 chat/context-refresh 两个插件里，
// 现在统一挂这一个 id，配置也收进同一块（rules / everyTokens / withPrefix / withTools / descNoticeIgnore）。
//
// 底下还是复用那两个实现（它们各自还有被别处引用的东西，比如 tool-gate/registry.js 被 bili-rove 静态 import）：
//   · ./gate.js     ← chat/tool-gate/index.js      关键词门控 + 通知通道（notify / queueNotice）+ 工具说明变更推送
//   · ./refresh.js  ← chat/context-refresh/index.js 上下文超过阈值时把预设要点 + 工具清单再带一遍（排队下发）
//
// 合体的好处：两类通知共用同一个 notify/queueNotice，不会再出现「一个走 steer、一个走 section、位置各不相同」。

import * as gate from './gate.js'
import * as refresh from './refresh.js'

export const name = 'tooldesc-control'

/** 两边的依赖合集（systemPrompt 给注意：gate 内部不再往 section 里塞东西，但保留注入不碍事） */
export const inject = [...new Set([...(gate.inject || []), ...(refresh.inject || []), 'systemPrompt'])]

export async function apply(ctx, config = {}) {
  const log = (...a) => console.log('[tooldesc-control]', ...a)

  try {
    await gate.apply(ctx, config)
    log('门控 / 通知通道已挂')
  } catch (error) {
    console.warn('[tooldesc-control] 门控挂了：', error?.message || error)
  }

  try {
    await refresh.apply(ctx, config)
    log('上下文重贴已挂')
  } catch (error) {
    console.warn('[tooldesc-control] 重贴挂了：', error?.message || error)
  }
}
