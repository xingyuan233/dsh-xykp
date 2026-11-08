/**
 * bili-audio-live :: ASR client
 * Thin wrapper that owns the worker thread and queues utterances through it.
 */
import { Worker } from 'node:worker_threads';
import { packageDir } from './resolve.js';

export class AsrClient {
  constructor({ modelDir, language = 'zh', numThreads = 4, log = () => {} }) {
    this.opts = { modelDir, language, numThreads, sherpaRoot: packageDir('sherpa-onnx-node') };
    this.log = log;
    this.ready = false;
    this.status = { ready: false, modelDir, sherpaRoot: this.opts.sherpaRoot };
    this.seq = 0;
    this.pending = new Map();
    this.worker = null;
    this.starting = null;
  }

  start() {
    if (this.worker || this.starting) return this.starting || Promise.resolve(this.ready);
    this.starting = new Promise((resolve) => {
      try {
        const w = new Worker(new URL('./asr-worker.mjs', import.meta.url), {
          workerData: this.opts,
          stderr: false,
        });
        this.worker = w;
        w.on('message', (msg) => {
          if (!msg) return;
          if (msg.type === 'log') this.log(msg.text);
          else if (msg.type === 'ready') {
            this.ready = Boolean(msg.ok);
            this.status = msg.status || this.status;
            this.starting = null;
            resolve(this.ready);
          } else if (msg.type === 'result') {
            const cb = this.pending.get(msg.id);
            if (cb) {
              this.pending.delete(msg.id);
              cb(msg.text);
            }
          }
        });
        w.on('error', (e) => {
          this.log(`[asr] worker 错误: ${e.message}`);
          this.ready = false;
          this.starting = null;
          resolve(false);
        });
        w.on('exit', (code) => {
          this.log(`[asr] worker 退出 code=${code}`);
          this.worker = null;
          this.ready = false;
        });
      } catch (e) {
        this.log(`[asr] 起不了 worker: ${e.message}`);
        this.starting = null;
        resolve(false);
      }
    });
    return this.starting;
  }

  /** Resolves with the transcript ('' on failure). Never throws. */
  transcribe(samples) {
    if (!this.worker || !this.ready) {
      if (!this.ready) void this.start();
      return Promise.resolve('');
    }
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve('');
        }
      }, 60000);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, (text) => {
        clearTimeout(timer);
        resolve(text);
      });
      try {
        const copy = new Float32Array(samples);
        this.worker.postMessage({ type: 'transcribe', id, samples: copy }, [copy.buffer]);
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve('');
      }
    });
  }

  close() {
    try {
      this.worker?.terminate();
    } catch {
      /* ignore */
    }
    this.worker = null;
    this.ready = false;
  }
}
