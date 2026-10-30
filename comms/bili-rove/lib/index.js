// bili-rove · 宿主半边（主动用的那半边）
//
// 一个插件两把工具：
//   · bili_rove —— 搜视频 / 看详情 / 字幕 / 截帧 / 评论 / 弹幕 / 用户 / 收藏 / 热榜 /
//                  回复 / 私信 / 三连 / 发动态 / 收到的 @ 和回复 / 批量扫
//   · bili_login —— 扫码登录（推 ntfy 等扫码）/ 检查登录状态
//
// 设计取舍（任务-2026-10-27 第四节 + 2026-10-27 15:xx 主人补充）：
//   · 不做自动刷、不做定时轮询 —— 什么时候刷由我自己判断
//   · 不做自动回复 —— 那是 bili-reply 的事
//   · 读操作 cookie 失效可以回退匿名；写操作**绝不重试**（避免重复发评论/私信）
//   · cookie / 凭证 / 配置都只读写 <DSH_HOME>/xykp/bilibili 里的数据文件
import { offer as gateOffer } from '../../../chat/tooldesc-control/registry.js'
import { DEFAULTS as FALLBACK_DEFAULTS } from './fallback.js'
import { DEFAULTS as ACCOUNT_DEFAULTS, resolveCookie, readCredential, cookieOf, dataDirOf } from './account.js'
import { DEFAULTS as NTFY_DEFAULTS, setService as setNtfyService } from './ntfy.js'
import { DEFAULTS as LOGIN_DEFAULTS, qrLogin, checkLogin, loginStart } from './login.js'
import { createBackend, WRITE_ACTIONS } from './backend.js'
import { collectFrames, FRAME_MODES, FRAME_MAX_COUNT, FRAME_DEFAULT_COUNT } from './frames.js'

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
  ...ACCOUNT_DEFAULTS,
  ...NTFY_DEFAULTS,
  ...LOGIN_DEFAULTS,
  // 读操作 cookie 失效时要不要顺手把二维码推到 ntfy（1 = 推，0 = 只报错）
  autoPushQr: 0,
}

const READ_ACTIONS = [
  'search', 'video', 'subtitles', 'frames', 'comments', 'danmaku',
  'user', 'user_videos', 'favorites', 'hot', 'rank',
  'dm_sessions', 'dm_recent', 'received_at', 'received_replies', 'whoami', 'crawl',
]

/** 读操作：cookie → （登录类错误就推一次二维码）→ 匿名 → 失败 */
async function runRead(action, args, cfg, deps) {
  let lastErr = null
  const cookie = await deps.cookie()
  try {
    return { ok: true, mode: 'cookie', data: await deps.call({ action, args, cookie }) }
  } catch (e) {
    lastErr = e
  }
  const msg = String(lastErr?.message || lastErr)
  const authIssue = !cookie || /NO_CREDENTIAL|未登录|not login|-101|-111/i.test(msg)
  if (authIssue && Number(cfg.autoPushQr) === 1) {
    try {
      const qr = await loginStart()
      const { notifyText } = await import('./ntfy.js')
      await notifyText('B站登录失效', '打开这条链接用 B站 App 扫码登录：' + qr.url, cfg)
    } catch {
      /* 推送失败不影响下面回退 */
    }
  }
  // 匿名再试一次（读接口匿名通常也通）
  try {
    return { ok: true, mode: 'anonymous', data: await deps.call({ action, args, cookie: '' }) }
  } catch (e) {
    lastErr = e
  }
  const hint = authIssue
    ? '\n（需要登录：调 bili_login 生成二维码扫码，扫完再试）'
    : ''
  throw new Error(String(lastErr?.message || lastErr) + hint)
}

/** frames 的图片块 <-> 模型 */
function framesContent(value) {
  const envelope = [
    '<bvid>' + value.meta.bvid + '</bvid>',
    '<title>' + value.meta.title + '</title>',
    '<source>' + value.meta.source + '</source>',
    '<frames>' + String(value.images.length) + '</frames>',
  ]
  if (value.meta.note !== undefined) envelope.push('<note>' + value.meta.note + '</note>')
  const blocks = [{ type: 'text', text: envelope.join('\n') }]
  for (const image of value.images) {
    blocks.push({
      type: 'image',
      attachment: {
        attachmentId: image.attachmentId,
        mediaType: image.mediaType,
        bytes: image.bytes,
        width: image.width,
        height: image.height,
        ...(image.name === undefined ? {} : { name: image.name }),
      },
    })
  }
  return blocks
}

/** 一条 image 结果 → 一个 image block */
function imageBlocks(value) {
  const blocks = []
  for (const image of value.images) {
    blocks.push({
      type: 'image',
      attachment: {
        attachmentId: image.attachmentId,
        mediaType: image.mediaType,
        bytes: image.bytes,
        width: image.width,
        height: image.height,
        ...(image.name === undefined ? {} : { name: image.name }),
      },
    })
  }
  return blocks
}

/** comments 带图的结果：评论 JSON 照常给，图片跟在后面，各带一条 <comment_image> 说明 */
function commentsContent(value) {
  const text = JSON.stringify({ ok: value.ok, mode: value.mode, data: value.data }, null, 2)
  const lines = []
  value.images.forEach((image, i) => {
    lines.push(
      '<comment_image n="' + String(i + 1) + '" rpid="' + String(image.rpid || '') + '" user="' + String(image.user || '') + '">' +
        String(image.caption || '') + '</comment_image>',
    )
  })
  if (Array.isArray(value.image_errors) && value.image_errors.length) {
    lines.push('<image_errors>' + JSON.stringify(value.image_errors) + '</image_errors>')
  }
  return [{ type: 'text', text: lines.length ? text + '\n\n' + lines.join('\n') : text }, ...imageBlocks(value)]
}

function roveRender(args, value) {
  if (value && Array.isArray(value.images) && value.meta && value.meta.bvid) {
    return value.meta.source === 'comments' ? commentsContent(value) : framesContent(value)
  }
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms))

// 评论区带图的楼层，一次最多回几张（避免一次塞满上下文）
const COMMENT_IMAGE_MAX = 3
const COMMENT_IMAGE_MAX_BYTES = 8 * 1024 * 1024

function imageMediaTypeOf(url, contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (type.startsWith('image/')) return type
  const lower = String(url).toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return 'image/jpeg'
}

async function downloadCommentImage(url, signal) {
  const r = await fetch(url.startsWith('//') ? 'https:' + url : url, {
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' },
    ...(signal ? { signal } : {}),
  })
  if (!r.ok) throw new Error('下载图片失败 (HTTP ' + r.status + ')')
  return { data: new Uint8Array(await r.arrayBuffer()), mediaType: imageMediaTypeOf(url, r.headers.get('content-type')) }
}

/** 从 comments 结果里按楼层顺序挑带图的评论 */
function pickCommentPictures(data, max) {
  const out = []
  const list = data && Array.isArray(data.comments) ? data.comments : []
  for (const comment of list) {
    for (const pic of comment.pictures || []) {
      if (out.length >= max) return out
      out.push({
        url: pic.url,
        rpid: comment.rpid,
        user: comment.user || '',
        caption: String(comment.content || '').slice(0, 60),
      })
    }
  }
  return out
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  // ntfy 推送统一走 comms/ntfy 组件（拿不到时 ntfy.js 里还有自带实现兜底）
  setNtfyService(() => (typeof ctx.get === 'function' ? ctx.get('ntfy') : null))
  const backend = createBackend(cfg)
  const deps = {
    cookie: () => resolveCookie(cfg),
    call: (req) => backend.call(req),
  }

  // 2026-10-29：交给 tool-gate 决定「先扣着还是照常注册」——
  //   配了门控规则的工具（比如 bili_rove），一开始不出现在工具列表里，等对话里出现关键词再推出来
  const registerTool = (def) => {
    // 静态 import registry：不管 tool-gate 插件是不是后加载，规则都能读到（配了规则就先扣着）
    if (gateOffer(def)) return
    ctx.tools.register(def)
  }

  // ── bili_login ───────────────────────────────────────────────────────────
  registerTool(defineTool({
    name: 'bili_login',
    description: 'B站扫码登录：qr 生成二维码推 ntfy（whale-bilibili-login-channel）后等扫码，check 查凭证。cookie 失效时先调这个。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['qr', 'check'],
        description: 'qr 扫码登录 / check 检查登录状态',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const action = String(args && args.action ? args.action : 'check').trim()
      if (action === 'check') {
        const cred = await readCredential(cfg)
        const st = await checkLogin(cookieOf(cred))
        return { ...st, dataDir: dataDirOf(cfg) }
      }
      if (action !== 'qr') return { ok: false, error: 'BILI_ROVE_BAD_ARGS：action 只能是 qr / check' }
      log('开始扫码登录…')
      const cred = await qrLogin(cfg, { push: true })
      if (!cred) return { ok: false, error: 'BILI_ROVE_LOGIN_TIMEOUT：没等到扫码（二维码已推到 ntfy，可以再调一次）' }
      const st = await checkLogin(cookieOf(cred))
      return { ok: true, ...st, saved: true }
    },
  }))

  // ── bili_rove ────────────────────────────────────────────────────────────
  registerTool(defineTool({
    name: 'bili_rove',
    description: [
      'B站操作（带 cookie）。action 决定做什么，括号里是它要带的参数：',
      '读 —— search(keyword,page,pageSize,order) / video、subtitles、danmaku(bvid) / comments(bvid；带图的楼层会附前 3 张图) / frames(bvid,count,mode) / user、user_videos(uid) / favorites(uid,mediaId) / hot / rank(rid) / received_at / received_replies / crawl(keyword,maxVideos,commentsPerVideo,getSubtitles)',
      '写 —— reply(bvid,rpid,root,text) / dm(uid,text；不带 text 读) / dm_sessions(size) / dm_recent(size,pages) / triple(bvid,mode,coinNum) / dynamic(text)',
      'frames 返回真帧图片，meta.source 是 preview/videoshot 才是真帧（cover 只是封面）。',
    ].join('\n'),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [...READ_ACTIONS, 'reply', 'dm', 'triple', 'dynamic'],
        description: '要做什么',
      },
      keyword: { type: 'string', description: 'search / crawl' },
      bvid: { type: 'string', description: 'BV 号（reply/triple 也收纯数字 aid）' },
      uid: { type: 'string', description: 'user / user_videos / favorites / dm', showType: true },
      mediaId: { type: 'number', description: 'favorites 收藏夹 id' },
      rpid: { type: 'string', description: 'reply 要回的评论' },
      root: { type: 'string', description: 'reply 楼层根（一般不用填）' },
      text: { type: 'string', description: 'reply / dm / dynamic 内容' },
      mode: { type: 'string', description: 'frames: auto/extract；triple: like/coin/fav/like_fav/triple' },
      count: { type: 'number', description: 'frames 1-12（默认 8）' },
      num: { type: 'number', description: 'comments / danmaku 条数' },
      page: { type: 'number', description: '页码（默认 1）' },
      pageSize: { type: 'number', description: '每页条数' },
      order: { type: 'string', description: 'search / user_videos 排序' },
      size: { type: 'number', description: 'dm_sessions / dm_recent 条数' },
      pages: { type: 'number', description: 'dm_recent 往前翻' },
      rid: { type: 'number', description: 'rank 分区（0 = 全站）' },
      coinNum: { type: 'number', description: 'triple 投币 1-2' },
      maxVideos: { type: 'number', description: 'crawl 视频数' },
      commentsPerVideo: { type: 'number', description: 'crawl 每条视频评论数' },
      getSubtitles: { type: 'boolean', description: 'crawl 读字幕（默认 true）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: roveRender,
    },
    async execute(args, exec) {
      const action = String(args && args.action ? args.action : '').trim()
      if (!action) return { ok: false, error: 'BILI_ROVE_BAD_ARGS：action 必填' }
      const a = args || {}

      if (action === 'frames') {
        const bvid = String(a.bvid || '').trim()
        if (!bvid) return { ok: false, error: 'BILI_ROVE_BAD_ARGS：frames 需要 bvid' }
        const attachments = ctx.get('attachments')
        if (attachments === undefined) return { ok: false, error: 'BILI_ROVE_NO_ATTACHMENTS：这个部署没有挂载附件服务，看不了帧' }
        const cookie = await deps.cookie()
        const mode = a.mode === undefined ? 'auto' : String(a.mode)
        if (!FRAME_MODES.includes(mode)) return { ok: false, error: 'mode 只能是 ' + FRAME_MODES.join(' / ') }
        const count = a.count === undefined ? FRAME_DEFAULT_COUNT : Number(a.count)
        if (!Number.isInteger(count) || count < 1 || count > FRAME_MAX_COUNT) {
          return { ok: false, error: 'count 要是 1-' + FRAME_MAX_COUNT + ' 的整数' }
        }
        // 用 provider 的 video/playerInfo/videoshot/fetchBytes 拿数据
        const { BilibiliOfficialProvider } = await import('./vendor/provider.js')
        const service = new BilibiliOfficialProvider({
          ...(cookie ? { cookie } : {}),
          requestTimeoutMs: Number(cfg.timeoutMs) || 30_000,
        })
        try {
          const detail = await service.video({ bvid }, exec?.signal)
          const value = await collectFrames({ service, attachments, detail, bvid, mode, count, signal: exec?.signal })
          return value
        } catch (e) {
          return { ok: false, error: 'BILI_ROVE_FRAMES_FAILED：' + String(e?.message || e) }
        }
      }

      if (action === 'comments') {
        // 文字照常走 runRead；楼层里有图就把前几张下载下来，走附件通道给模型真看
        const result = await runRead(action, a, cfg, deps)
        const picked = pickCommentPictures(result.data, COMMENT_IMAGE_MAX)
        if (picked.length === 0) return result
        const attachments = ctx.get('attachments')
        if (attachments === undefined) return result
        const images = []
        const imageErrors = []
        for (const item of picked) {
          try {
            const { data, mediaType } = await downloadCommentImage(item.url, exec?.signal)
            if (data.length > COMMENT_IMAGE_MAX_BYTES) throw new Error('图片过大（' + String(data.length) + ' bytes）')
            const limits = attachments.imageLimits
            if (limits && Array.isArray(limits.mediaTypes) && !limits.mediaTypes.includes(mediaType)) {
              throw new Error('附件服务不支持 ' + mediaType)
            }
            const ref = await attachments.saveImage({ data, mediaType, name: 'bili-comment-' + String(item.rpid) })
            images.push({ ...ref, rpid: item.rpid, user: item.user, caption: item.caption })
          } catch (e) {
            imageErrors.push({ rpid: item.rpid, url: item.url, error: String(e?.message || e) })
          }
        }
        const bvid = String(a.bvid || '').trim()
        if (images.length === 0) return { ...result, image_errors: imageErrors }
        return {
          ...result,
          images,
          ...(imageErrors.length ? { image_errors: imageErrors } : {}),
          meta: { bvid, source: 'comments' },
        }
      }

      if (WRITE_ACTIONS.has(action)) {
        // 写操作：只带 cookie 试一次，失败不重试、不回退匿名
        const cookie = await deps.cookie()
        if (!cookie) {
          return { ok: false, error: 'BILI_ROVE_NO_CREDENTIAL：写操作需要登录，先调 bili_login 扫码' }
        }
        try {
          const data = await backend.call({ action, args: a, cookie, signal: exec?.signal })
          return data && typeof data === 'object' ? data : { ok: true, data }
        } catch (e) {
          return { ok: false, error: String(e?.message || e) }
        }
      }

      try {
        const r = await runRead(action, a, cfg, deps)
        return { ok: true, mode: r.mode, data: r.data }
      } catch (e) {
        return { ok: false, error: String(e?.message || e) }
      }
    },
  }))
  log('已注册工具 bili_rove / bili_login')
}

export const _internal = { runRead, DEFAULTS }
export { checkLogin, qrLogin, loginStart }
