// qq-adapter · 把任意音频转成 QQ 认的 silk
//
// 为什么不装 silk-wasm：gate 扫它是 BLOCK（Emscripten loader 里有 new Function 混淆）。
// 现在用的是开源源码自己编的原生编码器：
//   https://github.com/kn007/silk-v3-decoder  （Skype SILK SDK，MIT）
//   构建：gcc -O2 -w -Iinterface -Isrc -o silk_encode.exe test/Encoder.c src/*.c
//   调用：silk_encode.exe in.pcm out.silk -Fs_API 16000 -tencent
// 前置：先把任意音频用 ffmpeg 解成 16k / 单声道 / s16le 的裸 PCM。
//
// 任何一个环节失败都抛错给调用方，别在这里吞。

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SILK_MAGIC = '#!SILK_V3'

export async function isSilk(path) {
  try {
    const buf = await readFile(path)
    return buf.length > SILK_MAGIC.length && buf.subarray(0, SILK_MAGIC.length).toString('latin1') === SILK_MAGIC
  } catch {
    return false
  }
}

function run(cmd, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} 失败：${String(stderr || err.message).slice(0, 300)}`))
      else resolve(stdout)
    })
  })
}

/**
 * 任意音频 → silk（已经是 silk 就原样返回）
 * @returns {Promise<{silkPath: string, converted: boolean, duration: number, dir?: string}>}
 */
export async function toSilk(inputPath, opts = {}) {
  const ffmpeg = opts.ffmpegPath || 'ffmpeg'
  const encoder = opts.silkEncoderPath || 'D:\\AI\\DeepseekHarness\\tools\\silk\\silk_encode.exe'
  const tempRoot = opts.tempDir || tmpdir()

  if (await isSilk(inputPath)) return { silkPath: inputPath, converted: false, duration: 0 }

  const dir = await mkdtemp(join(tempRoot, 'qq-silk-'))
  const pcm = join(dir, 'in.pcm')
  const out = join(dir, 'out.silk')

  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-f', 's16le', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le',
    pcm,
  ])

  const { size } = await stat(pcm)
  if (!size) throw new Error('PCM 是空的，这个音频解不出来')
  // 16000 Hz × 2 字节 = 一秒 32000 字节
  const duration = Math.max(1, Math.round(size / 32000))

  await run(encoder, [pcm, out, '-Fs_API', '16000', '-tencent', '-quiet'])

  return { silkPath: out, converted: true, duration, dir }
}

/** 发完把临时目录删掉（失败无所谓） */
export async function cleanupSilk(res) {
  if (!res?.dir) return
  try { await rm(res.dir, { recursive: true, force: true }) } catch { /* 删不掉就算了 */ }
}
