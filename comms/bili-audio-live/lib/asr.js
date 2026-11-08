/**
 * bili-audio-live :: local ASR (sherpa-onnx + SenseVoice)
 * Loaded lazily: a missing model must only degrade audio, never break danmaku.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadPackage } from './resolve.js';

const SAMPLE_RATE = 16000;

function loadSherpa(sherpaRoot) {
  // worker 线程拿不到宿主的 argv，由主线程把包路径传进来
  if (sherpaRoot) {
    try {
      return createRequire(path.join(sherpaRoot, 'noop.js'))('sherpa-onnx-node');
    } catch {
      /* 落到通用查找 */
    }
  }
  return loadPackage('sherpa-onnx-node');
}

export class LocalAsr {
  constructor({ modelDir, language = 'zh', numThreads = 2, sherpaRoot = '', log = () => {} }) {
    this.modelDir = modelDir;
    this.language = language;
    this.numThreads = numThreads;
    this.sherpaRoot = sherpaRoot;
    this.log = log;
    this.rec = null;
    this.ready = false;
    this.lastError = '';
  }

  modelFile() {
    for (const f of ['model.int8.onnx', 'model.onnx']) {
      const p = path.join(this.modelDir, f);
      if (fs.existsSync(p)) return p;
    }
    return '';
  }

  init() {
    if (this.ready) return true;
    try {
      const model = this.modelFile();
      const tokens = path.join(this.modelDir, 'tokens.txt');
      if (!model) throw new Error(`模型缺失: ${this.modelDir}`);
      if (!fs.existsSync(tokens)) throw new Error(`tokens.txt 缺失: ${tokens}`);
      const sherpa = loadSherpa(this.sherpaRoot);
      this.rec = new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          senseVoice: {
            model,
            language: this.language,
            useInverseTextNormalization: 1,
          },
          tokens,
          numThreads: this.numThreads,
          provider: 'cpu',
          debug: 0,
        },
      });
      this.ready = true;
      this.log(`[asr] 就绪 ${path.basename(model)}`);
      return true;
    } catch (e) {
      this.lastError = e.message;
      this.log(`[asr] 初始化失败: ${e.message}`);
      return false;
    }
  }

  /** @param {Float32Array} samples 16k mono */
  transcribe(samples) {
    if (!this.ready && !this.init()) return '';
    try {
      const stream = this.rec.createStream();
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
      this.rec.decode(stream);
      const r = this.rec.getResult(stream);
      return (r?.text || '').trim();
    } catch (e) {
      this.lastError = e.message;
      this.log(`[asr] 识别失败: ${e.message}`);
      return '';
    }
  }

  get status() {
    return {
      ready: this.ready,
      modelDir: this.modelDir,
      model: this.modelFile(),
      language: this.language,
      lastError: this.lastError,
    };
  }
}
