// dsh-ntfy · 宿主半边
//
// 实现在 lib/client.js（纯 node，不依赖宿主，独立进程也能 import）。
// 这里负责：Config / apply / 注册 ntfy_push、ntfy_wait 工具 / 提供 ctx.get('ntfy') 服务。

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { DEFAULTS, push, wait, createService, matcherOf, pollOnce } from './client.js'

export { push, wait, createService, DEFAULTS, matcherOf } from './client.js'

export const name = 'ntfy'

/** tools 没有也能跑（自测环境），有才注册工具 */
export const inject = ['tools']

export const Config = Schema.object({
  baseUrl: Schema.string().default(DEFAULTS.baseUrl).description('ntfy 服务地址（自建服务器时改这里）'),
  defaultTopic: Schema.string().default('').description('默认主题；留空则每次调用都要传 topic'),
  pollMs: Schema.number().default(DEFAULTS.pollMs).description('保留字段（wait 已改流式订阅，不再轮询）'),
  defaultTimeoutSec: Schema.number().default(DEFAULTS.defaultTimeoutSec).description('wait 不给 timeout 时的默认超时（秒）'),
  requestTimeoutMs: Schema.number().default(DEFAULTS.requestTimeoutMs).description('单次 HTTP 请求超时（毫秒）'),
})

const log = (...a) => console.log('[ntfy]', ...a)

const jsonOutput = (description) => ({
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: { text: { type: 'string' } },
    description,
  },
  render(_args, value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
  },
})

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...Config(config) }
  const service = createService(cfg)

  try {
    if (typeof ctx.provide === 'function') ctx.provide('ntfy', service)
    else ctx.ntfy = service
  } catch (err) {
    console.warn('[ntfy] ctx.provide 不可用：', err?.message || err)
  }

  const unregister = []
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    unregister.push(
      ctx.tools.register(
        defineTool({
          name: 'ntfy_push',
          description:
            '往 ntfy 主题推一条消息；带 filePath 时把本地文件作为附件发出去（发二维码图片就用这个）。' +
            '不填 topic 时用配置里的默认主题。',
          parameters: {
            topic: { type: 'string', description: 'ntfy 主题；不填用配置的默认主题' },
            message: { type: 'string', description: '正文（纯文本）；发附件时作为附带说明' },
            title: { type: 'string', description: '通知标题，可选（支持中文）' },
            tags: { type: 'string', description: '标签，逗号分隔，如 rotating_light,qrcode' },
            priority: { type: 'number', description: '优先级 1-5，5 最急' },
            filePath: { type: 'string', description: '要作为附件发送的本地文件路径（图片/任意文件）' },
          },
          output: jsonOutput('推送结果：ok / topic / id / status'),
          async execute(args = {}) {
            return push(cfg, args)
          },
        }),
      ),
    )

    unregister.push(
      ctx.tools.register(
        defineTool({
          name: 'ntfy_wait',
          description:
            '在 ntfy 主题上等一条消息（比如等主人发 /post）。默认从现在开始等，返回第一条匹配的消息；' +
            '超时返回 { ok:false, timedOut:true }。match 写纯文本表示正文完全相等，写 re:... 表示正则。',
          parameters: {
            topic: { type: 'string', description: 'ntfy 主题；不填用配置的默认主题' },
            match: { type: 'string', description: '匹配规则：纯文本=正文完全相等；re:开头=正则' },
            timeoutSeconds: { type: 'number', description: '最多等多少秒，不填用配置的默认值' },
            since: { type: 'string', description: '从哪个时间点开始等（unix 秒或 all）；不填=从现在' },
          },
          output: jsonOutput('等待结果：ok / timedOut / message'),
          async execute(args = {}) {
            return wait(cfg, args)
          },
        }),
      ),
    )
  } else {
    console.warn('[ntfy] ctx.tools 不可用，跳过工具注册')
  }

  try {
    ctx.on('dispose', () => {
      for (const off of unregister) {
        try {
          off?.()
        } catch {}
      }
    })
  } catch {}

  log('已加载：默认主题=' + (cfg.defaultTopic || '(空)') + '，baseUrl=' + cfg.baseUrl)
}

// 自测用
export const _internal = { pollOnce, matcherOf, DEFAULTS }
