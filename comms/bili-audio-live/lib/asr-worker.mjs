/**
 * bili-audio-live :: ASR worker
 * SenseVoice decoding is CPU-bound and synchronous; keep it off the host event loop.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { LocalAsr } from './asr.js';

const asr = new LocalAsr({ ...workerData, log: (m) => parentPort.postMessage({ type: 'log', text: m }) });
const ok = asr.init();
parentPort.postMessage({ type: 'ready', ok, status: asr.status });

parentPort.on('message', (msg) => {
  if (!msg || msg.type !== 'transcribe') return;
  const samples = new Float32Array(msg.samples);
  const text = asr.transcribe(samples);
  parentPort.postMessage({ type: 'result', id: msg.id, text });
});
