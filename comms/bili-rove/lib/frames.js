// bili-rove · 截帧（走宿主 attachments）
//
// 逻辑与 dsh-plugin-bilibili 的 bilibili_frames 一致（同一条链路实测过）：
//   auto：preview_pic → /x/player/videoshot 真帧网格（切单帧）→ 封面兜底
//   extract：下载 mp4 + ffmpeg 抽帧
// 区别：这里把 service / attachments 作为参数传进来，方便在 bili_rove 的 execute 里用。
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BLANK_FRAME_BYTES = 6000
export const FRAME_MODES = ['auto', 'extract']
export const FRAME_MAX_COUNT = 12
export const FRAME_DEFAULT_COUNT = 8

function runCommand(command, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c.toString() })
    child.stderr.on('data', (c) => { stderr += c.toString() })
    const abort = () => { child.kill() }
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (e) => { signal?.removeEventListener('abort', abort); reject(e) })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort)
      if (code === 0) resolve(stdout)
      else reject(new Error('command failed (' + String(code) + '): ' + stderr.slice(0, 300)))
    })
  })
}

let ffmpegAvailable
export async function hasFfmpeg() {
  if (ffmpegAvailable !== undefined) return ffmpegAvailable
  try {
    await runCommand('ffmpeg', ['-version'])
    ffmpegAvailable = true
  } catch {
    ffmpegAvailable = false
  }
  return ffmpegAvailable
}

async function downloadBytes(url, signal) {
  const r = await fetch(url.startsWith('//') ? 'https:' + url : url, {
    ...(signal ? { signal } : {}),
    redirect: 'manual',
    headers: { 'user-agent': 'Mozilla/5.0' },
  })
  if (!r.ok) throw new Error('download failed (HTTP ' + r.status + ')')
  return new Uint8Array(await r.arrayBuffer())
}

function imageMediaTypeOf(url) {
  const lower = String(url).toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return 'image/jpeg'
}

async function extractFrames(videoPath, outDir, duration, count, signal) {
  const fps = Math.min(count / Math.max(duration, 1), 60)
  const pattern = join(outDir, 'frame-%02d.png')
  await runCommand('ffmpeg', [
    '-y', '-i', videoPath,
    '-vf', "fps=" + fps.toFixed(4) + ",scale='min(512,iw)':-2",
    '-frames:v', String(count),
    pattern,
  ], signal)
  const files = (await readdir(outDir)).filter((n) => n.startsWith('frame-')).sort()
  return files.map((n) => join(outDir, n))
}

/** 从雪碧图里按 index 时间戳均匀挑 N 格，切成单独 PNG；黑空格子按体积判掉 */
export async function cutSpriteFrames(shot, tmp, count, signal) {
  const perPage = shot.xLen * shot.yLen
  if (shot.images.length === 0 || perPage <= 0 || shot.xSize <= 0 || shot.ySize <= 0) return []
  if (!(await hasFfmpeg())) return []
  const total = shot.timestamps.length > 0 ? shot.timestamps.length : shot.images.length * perPage
  const wanted = Math.min(count + 2, total)
  const picked = []
  for (let k = 0; k < wanted; k += 1) {
    const at = wanted === 1 ? 0 : Math.round(k * (total - 1) / (wanted - 1))
    if (picked[picked.length - 1] !== at) picked.push(at)
  }
  const pagePath = new Map()
  const out = []
  const cutTile = async (flat, slot) => {
    if (flat < 0 || flat >= total) return null
    const pageIndex = Math.floor(flat / perPage)
    const url = shot.images[pageIndex]
    if (url === undefined) return null
    let spritePath = pagePath.get(url)
    if (spritePath === undefined) {
      spritePath = join(tmp, 'sprite-' + String(pageIndex) + '.jpg')
      await writeFile(spritePath, await downloadBytes(url, signal))
      pagePath.set(url, spritePath)
    }
    const tile = flat % perPage
    const x = (tile % shot.xLen) * shot.xSize
    const y = Math.floor(tile / shot.xLen) * shot.ySize
    const framePath = join(tmp, 'shot-' + String(slot).padStart(2, '0') + '.png')
    await runCommand('ffmpeg', [
      '-y', '-i', spritePath,
      '-vf', 'crop=' + String(shot.xSize) + ':' + String(shot.ySize) + ':' + String(x) + ':' + String(y),
      '-frames:v', '1',
      framePath,
    ], signal)
    const size = (await stat(framePath)).size
    return { path: framePath, blank: size < BLANK_FRAME_BYTES }
  }
  for (let n = 0; n < picked.length; n += 1) {
    const flat = picked[n]
    let tile = await cutTile(flat, n)
    if (tile !== null && tile.blank) {
      const alt = flat > 0 ? flat - 1 : flat + 1
      const retry = await cutTile(alt, n)
      tile = retry !== null && !retry.blank ? retry : null
    }
    if (tile !== null) out.push(tile.path)
  }
  if (out.length <= count) return out
  const trimmed = []
  for (let k = 0; k < count; k += 1) {
    const at = count === 1 ? 0 : Math.round(k * (out.length - 1) / (count - 1))
    if (!trimmed.includes(out[at])) trimmed.push(out[at])
  }
  return trimmed
}

/**
 * 取帧并写进宿主 attachments。
 * @returns {Promise<{images:Array,meta:object}>}
 */
export async function collectFrames({ service, attachments, detail, bvid, mode = 'auto', count = FRAME_DEFAULT_COUNT, signal }) {
  const n = Math.max(1, Math.min(FRAME_MAX_COUNT, Number(count) || FRAME_DEFAULT_COUNT))
  const committed = []
  const maxImages = Number(attachments?.imageLimits?.maxImagesPerMessage || FRAME_MAX_COUNT)
  let source = 'cover'
  let note
  const saveUrl = async (url, name) => {
    const mediaType = imageMediaTypeOf(url)
    if (attachments?.imageLimits?.mediaTypes && !attachments.imageLimits.mediaTypes.includes(mediaType)) {
      throw new Error('图片类型 ' + mediaType + ' 不被当前部署接受')
    }
    const data = await service.fetchBytes(url, signal)
    return attachments.saveImage({ data, mediaType, name })
  }

  if (mode === 'extract') {
    source = 'extract'
    const tmp = await mkdtemp(join(tmpdir(), 'dsh-bili-frames-'))
    try {
      if (!(await hasFfmpeg())) throw new Error('宿主没有 ffmpeg，用 mode=auto（videoshot 真帧）')
      const play = await service.playurl({ bvid }, signal)
      const videoPath = join(tmp, 'video.mp4')
      await writeFile(videoPath, await downloadBytes(play.url, signal))
      const frames = await extractFrames(videoPath, tmp, detail.duration, n, signal)
      for (const framePath of frames) {
        const data = new Uint8Array(await readFile(framePath))
        const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: bvid + '-' + framePath.split(/[\\/]/).pop() })
        committed.push(ref)
        if (committed.length >= maxImages) break
      }
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
    if (committed.length === 0) throw new Error('抽帧没有产出任何图片')
  } else {
    const info = await service.playerInfo({ bvid, cid: detail.cid }, signal)
    if (info.previewPic !== undefined) {
      source = 'preview'
      committed.push(await saveUrl(info.previewPic, bvid + '-preview'))
    } else {
      const shot = await service.videoshot({ bvid, cid: detail.cid }, signal).catch(() => undefined)
      const tmp = await mkdtemp(join(tmpdir(), 'dsh-bili-sprites-'))
      try {
        const frames = shot === undefined ? [] : await cutSpriteFrames(shot, tmp, n, signal)
        for (const framePath of frames) {
          const data = new Uint8Array(await readFile(framePath))
          const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: bvid + '-' + framePath.split(/[\\/]/).pop() })
          committed.push(ref)
          if (committed.length >= maxImages) break
        }
        if (committed.length > 0) {
          source = 'videoshot'
        } else if (shot !== undefined && shot.images.length > 0) {
          source = 'videoshot'
          committed.push(await saveUrl(shot.images[0], bvid + '-sprite'))
          note = '这是一张 ' + shot.xLen + 'x' + shot.yLen + ' 的帧网格（每格一帧，整张看比较小）；宿主没有可用的 ffmpeg，没法切成单帧。需要清晰的单帧时用 mode=extract。'
        }
      } finally {
        await rm(tmp, { recursive: true, force: true })
      }
      if (committed.length === 0) {
        source = 'cover'
        if (detail.coverUrl) {
          committed.push(await saveUrl(detail.coverUrl, bvid + '-cover'))
          note = '⚠️ 这是视频封面，不是视频帧：B站 preview_pic / videoshot 都没给可用画面。要真画面请用 mode=extract。'
        }
      }
    }
  }

  return {
    images: committed.map((ref) => ({
      attachmentId: String(ref.attachmentId),
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
    })),
    meta: { bvid, title: detail.title, source, ...(note === undefined ? {} : { note }) },
  }
}
