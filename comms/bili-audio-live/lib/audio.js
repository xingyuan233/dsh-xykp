/**
 * bili-audio-live :: audio capture + VAD
 * ffmpeg pulls the live HLS audio to raw s16le on stdout.
 *
 * VAD 有两档：
 *   · silero（默认，神经网络，能扛 BGM / 游戏音）—— 模型在 <modelDir>/../silero/silero_vad.onnx
 *   · energy（兜底，模型缺失时用能量阈值，安静房间够用）
 * 直播几乎不可能绝对安静，所以默认优先 silero。
 */
import fs from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { loadPackage } from './resolve.js';

const SR = 16000;
const FRAME = 320; // 20ms @ 16k

/**
 * 宿主被强杀（重启脚本就是强杀）时 ffmpeg 会变孤儿，继续拉流烧 CPU。
 * 所以每起一个记一行 PID，退出时划掉；下次装载时把台账里还活着的清掉。
 */
export function cleanupStaleFfmpeg(ledgerPath, log = () => {}) {
  let pids = [];
  try {
    pids = fs.readFileSync(ledgerPath, 'utf8').split(/\s+/).map(Number).filter((n) => n > 0);
  } catch {
    return 0;
  }
  fs.writeFileSync(ledgerPath, '', 'utf8');
  let killed = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, 0); // 还活着
    } catch {
      continue;
    }
    try {
      execFile('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true }, () => {});
      killed++;
    } catch {
      /* ignore */
    }
  }
  if (killed) log(`[audio] 清理了 ${killed} 个上次残留的 ffmpeg`);
  return killed;
}


export class AudioCapture extends EventEmitter {
  constructor({
    roomId,
    cred,
    ffmpegPath = 'ffmpeg',
    getStreams,
    log = () => {},
    vadModel = '',
    vadThreshold = 0.5,
    minSpeechMs = 240,
    cutSilenceMs = 600,
    maxUtteranceMs = 20000,
    threshold = 380,
    pidLedger = '',
  }) {
    super();
    this.roomId = roomId;
    this.cred = cred;
    this.ffmpegPath = ffmpegPath;
    this.getStreams = getStreams;
    this.log = log;
    this.pidLedger = pidLedger;
    this.vadModel = vadModel;
    this.vadThreshold = vadThreshold;
    this.minSpeechFrames = Math.round(minSpeechMs / 20);
    this.cutSilenceFrames = Math.round(cutSilenceMs / 20);
    this.maxFrames = Math.round(maxUtteranceMs / 20);
    this.threshold = threshold;
    this.proc = null;
    this.stopped = true;
    this.retry = null;
    this.urlIndex = 0;
    this.status = 'idle';
    this.segments = 0;
    this.vadKind = 'none';
  }

  /** 把 PID 记进台账/从台账划掉（宿主被强杀时靠它兜底清理）。 */
  ledgerAdd(pid) {
    if (!this.pidLedger || !pid) return;
    try {
      fs.appendFileSync(this.pidLedger, `${pid}\n`, 'utf8');
    } catch {
      /* ignore */
    }
  }

  ledgerRemove(pid) {
    if (!this.pidLedger || !pid) return;
    try {
      const rest = fs
        .readFileSync(this.pidLedger, 'utf8')
        .split(/\s+/)
        .map(Number)
        .filter((n) => n > 0 && n !== pid);
      fs.writeFileSync(this.pidLedger, rest.length ? rest.join('\n') + '\n' : '', 'utf8');
    } catch {
      /* ignore */
    }
  }

  /** 建一个 silero VAD；失败返回 null，让调用方退回能量 VAD。 */
  makeSileroVad() {
    if (!this.vadModel || !fs.existsSync(this.vadModel)) return null;
    try {
      const sherpa = loadPackage('sherpa-onnx-node');
      const vad = new sherpa.Vad(
        {
          sileroVad: {
            model: this.vadModel,
            threshold: this.vadThreshold,
            minSpeechDuration: Math.max(0.1, this.minSpeechFrames * 0.02),
            minSilenceDuration: Math.max(0.1, this.cutSilenceFrames * 0.02),
            windowSize: 512,
            maxSpeechDuration: this.maxFrames * 0.02,
          },
          sampleRate: SR,
          numThreads: 1,
          provider: 'cpu',
          debug: 0,
        },
        60,
      );
      this.vadKind = 'silero';
      this.log('[audio] VAD = silero');
      return vad;
    } catch (e) {
      this.log(`[audio] silero VAD 起不来（${e.message}），退回能量 VAD`);
      return null;
    }
  }

  async start() {
    this.stopped = false;
    await this.loop();
  }

  async loop() {
    if (this.stopped) return;
    let streams;
    try {
      streams = await this.getStreams();
    } catch (e) {
      this.status = 'error';
      this.log(`[audio] 取流失败: ${e.message}`);
      return this.retryLater(15000);
    }
    if (!streams.live || !streams.urls.length) {
      this.status = 'offline';
      this.emit('offline', streams.title || '');
      return this.retryLater(30000);
    }
    const pick = streams.urls[this.urlIndex % streams.urls.length];
    this.urlIndex++;
    this.spawnFfmpeg(pick.url);
  }

  spawnFfmpeg(url) {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-rw_timeout', '20000000',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-headers', 'Referer: https://live.bilibili.com/\r\n',
      '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      '-i', url,
      '-vn', '-ac', '1', '-ar', String(SR), '-f', 's16le', '-acodec', 'pcm_s16le',
      // 兜底自愈：即使成为孤儿，最多拉一小时也会自己退出
      '-t', '3600', '-',
    ];
    let p;
    try {
      p = spawn(this.ffmpegPath, args, { windowsHide: true });
    } catch (e) {
      this.status = 'error';
      this.log(`[audio] 起不了 ffmpeg(${this.ffmpegPath}): ${e.code || e.message}`);
      return this.retryLater(20000);
    }
    this.proc = p;
    this.ledgerAdd(p.pid);
    this.status = 'running';
    this.log('[audio] ffmpeg 已启动');

    const vad = this.makeSileroVad();
    const emitSegment = (samples, seconds) => {
      this.segments++;
      this.emit('segment', { samples, seconds });
    };

    // ── 能量 VAD 的兜底状态
    let buf = Buffer.alloc(0);
    let pending = [];
    let inSpeech = false;
    let silence = 0;
    let speech = 0;
    let noise = 300;

    const flushEnergy = () => {
      if (speech >= this.minSpeechFrames) {
        const samples = new Float32Array(pending.length * FRAME);
        let k = 0;
        for (const f of pending) for (let i = 0; i < FRAME; i++) samples[k++] = f.readInt16LE(i * 2) / 32768;
        emitSegment(samples, pending.length * 0.02);
      }
      pending = [];
      inSpeech = false;
      speech = 0;
      silence = 0;
    };

    p.stdout.on('data', (chunk) => {
      if (vad) {
        const s = new Float32Array(chunk.length >> 1);
        for (let i = 0; i < s.length; i++) s[i] = chunk.readInt16LE(i * 2) / 32768;
        try {
          vad.acceptWaveform(s);
          while (!vad.isEmpty()) {
            const seg = vad.front();
            if (seg && seg.samples && seg.samples.length) emitSegment(new Float32Array(seg.samples), seg.samples.length / SR);
            vad.pop();
          }
        } catch (e) {
          this.log(`[audio] VAD 出错: ${e.message}`);
        }
        return;
      }

      // 兜底：能量阈值
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= FRAME * 2) {
        const f = buf.subarray(0, FRAME * 2);
        buf = buf.subarray(FRAME * 2);
        let sum = 0;
        for (let i = 0; i < FRAME; i++) {
          const v = f.readInt16LE(i * 2) / 32768;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / FRAME) * 32768;
        const voice = rms > Math.max(noise * 2.2, this.threshold);
        if (!voice) noise = noise * 0.995 + rms * 0.005;
        if (voice) {
          inSpeech = true;
          silence = 0;
          speech++;
          pending.push(f);
        } else if (inSpeech) {
          silence++;
          pending.push(f);
          if (silence >= this.cutSilenceFrames) flushEnergy();
        }
        if (pending.length >= this.maxFrames) flushEnergy();
      }
    });

    p.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) this.log('[ffmpeg] ' + s.slice(0, 200));
    });

    p.on('error', (e) => {
      this.status = 'error';
      this.log(`[audio] ffmpeg error: ${e.code || e.message}`);
    });

    p.on('exit', (code) => {
      this.proc = null;
      this.ledgerRemove(p.pid);
      this.status = 'closed';
      this.log(`[audio] ffmpeg 退出 code=${code}`);
      if (!this.stopped) this.retryLater(4000);
    });
  }

  retryLater(ms) {
    if (this.stopped) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.loop(), ms);
    if (typeof this.retry.unref === 'function') this.retry.unref();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.status = 'stopped';
    const pid = this.proc?.pid;
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    // Windows 上 kill() 偶尔留根，补一刀整棵树
    if (pid) {
      try {
        execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }, () => {});
      } catch {
        /* ignore */
      }
      this.ledgerRemove(pid);
    }
  }
}
