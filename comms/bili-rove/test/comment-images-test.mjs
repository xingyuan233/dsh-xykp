// 评论区图片：backend 归一化 + 工具层「下载图片走附件通道」的结果渲染
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// tool-gate 的 registry 会在 import 时读 <DSH_HOME>/xykp/tool-gate.json，指到空目录免得被门控扣下
const home = await mkdtemp(join(tmpdir(), 'bili-rove-comment-'))
process.env.DSH_HOME = home

const { createBackend } = await import('../lib/backend.js')
const { apply } = await import('../lib/index.js')

let failed = 0
function check(name, ok, detail) {
  if (ok) console.log('PASS ', name, detail === undefined ? '' : JSON.stringify(detail))
  else {
    failed += 1
    console.log('FAIL ', name, detail === undefined ? '' : JSON.stringify(detail))
  }
}

const REPLY = {
  rpid: 101,
  member: { uname: '甲', mid: 9 },
  content: {
    message: '看图',
    pictures: [
      { img_src: 'http://i0.hdslb.com/a.jpg', img_width: 640, img_height: 480, img_size: 20 },
      { img_src: '//i0.hdslb.com/b.png', img_width: 10, img_height: 10, img_size: 1 },
    ],
    emote: { '[大笑]': { text: '[大笑]', url: '//i0.hdslb.com/e.png' } },
  },
  like: 3,
  rcount: 0,
  ctime: 1700000000,
}
const PLAIN_REPLY = { rpid: 102, member: { uname: '乙', mid: 8 }, content: { message: '纯文字' }, like: 1, ctime: 1700000001 }

// ── 1. backend 归一化 ────────────────────────────────────────────────────────
{
  const provider = {
    video: async () => ({ aid: 1, cid: 2, title: 't', duration: 30 }),
    requestJson: async (path, params) => {
      if (path !== '/x/v2/reply') throw new Error('unexpected ' + path)
      return { replies: params.pn === 1 ? [REPLY, PLAIN_REPLY] : [] }
    },
  }
  const backend = createBackend({}, () => provider)
  const data = await backend.call({ action: 'comments', args: { bvid: 'BV1xx411c7mD', num: 10 }, cookie: '' })
  const withPics = data.comments[0]
  const plain = data.comments[1]
  check('图片楼层带 pictures', Array.isArray(withPics.pictures) && withPics.pictures.length === 2, withPics.pictures)
  check('http 前缀原样保留', withPics.pictures[0].url === 'http://i0.hdslb.com/a.jpg')
  check('// 前缀补成 https', withPics.pictures[1].url === 'https://i0.hdslb.com/b.png')
  check('图片宽高带上', withPics.pictures[0].width === 640 && withPics.pictures[0].height === 480)
  check('表情摊平成数组', withPics.emotes && withPics.emotes[0].url === 'https://i0.hdslb.com/e.png', withPics.emotes)
  check('纯文字楼层不多字段', plain.pictures === undefined && plain.emotes === undefined, plain)
}

// ── 2. 工具层：评论文字 + 图片块 ────────────────────────────────────────────
{
  const realFetch = globalThis.fetch
  const imageCalls = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('/x/web-interface/view')) {
      return new Response(JSON.stringify({ code: 0, data: { aid: 1, cid: 2, title: 'T', duration: 30 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('/x/v2/reply')) {
      const pn = Number(new URL(url).searchParams.get('pn') || 1)
      return new Response(JSON.stringify({ code: 0, data: { replies: pn === 1 ? [REPLY, PLAIN_REPLY] : [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('hdslb.com')) {
      imageCalls.push(url)
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'image/jpeg' } })
    }
    return realFetch(input, init)
  }

  const registered = new Map()
  const saved = []
  const attachments = {
    imageLimits: { mediaTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], maxImagesPerMessage: 8 },
    saveImage: async ({ data, mediaType, name }) => {
      saved.push({ data, mediaType, name })
      return { attachmentId: 'att-' + saved.length, mediaType, bytes: data.length, width: 640, height: 480, name }
    },
  }
  const ctx = {
    tools: { register: (def) => registered.set(def.name, def) },
    get: (name) => (name === 'attachments' ? attachments : undefined),
  }
  apply(ctx, {})

  const tool = registered.get('bili_rove')
  check('工具注册成功', tool !== undefined)

  const value = await tool.execute({ action: 'comments', bvid: 'BV1xx411c7mD', num: 10 }, {})
  check('结果带 2 张图（同楼层两图）', Array.isArray(value.images) && value.images.length === 2, value.images && value.images.length)
  check('meta 标记 comments', value.meta && value.meta.source === 'comments' && value.meta.bvid === 'BV1xx411c7mD', value.meta)
  check('评论文字没丢', value.data.comments[0].content === '看图')
  check('图片确实下载过', imageCalls.length === 2, imageCalls)
  check('saveImage 收到 jpeg', saved.every((s) => s.mediaType === 'image/jpeg'))

  const blocks = tool.output.render({}, value)
  check('render 首块是文本', blocks[0].type === 'text')
  check('文本里有 pictures', blocks[0].text.includes('"pictures"'))
  check('文本里有 comment_image 说明', blocks[0].text.includes('<comment_image n="1" rpid="101"'))
  check('图片块数量对', blocks.filter((b) => b.type === 'image').length === 2)
  check('图片块带 attachment', Boolean(blocks[1].attachment && blocks[1].attachment.attachmentId))

  // 纯文字评论 → 不下载、不渲染图片块
  const plainValue = await tool.execute({ action: 'comments', bvid: 'BV1xx411c7mD', num: 10 }, {})
  check('重复调用仍正常', plainValue.data.comments.length === 2)

  globalThis.fetch = realFetch
}

await rm(home, { recursive: true, force: true })
if (failed) {
  console.log('\n失败 ' + failed + ' 项')
  process.exitCode = 1
} else {
  console.log('\n全部通过')
}
