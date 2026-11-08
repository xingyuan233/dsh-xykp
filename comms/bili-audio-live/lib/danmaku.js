/**
 * bili-audio-live :: danmaku websocket client
 * Reconnecting client for the bilibili broadcastlv protocol (protover 3 / brotli).
 */
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import { loadPackage } from './resolve.js';

function loadWs() {
  return loadPackage('ws');
}

function packet(op, body) {
  const data = Buffer.from(JSON.stringify(body));
  const b = Buffer.alloc(16 + data.length);
  b.writeUInt32BE(16 + data.length, 0);
  b.writeUInt16BE(16, 4);
  b.writeUInt16BE(1, 6);
  b.writeUInt32BE(op, 8);
  b.writeUInt32BE(1, 12);
  data.copy(b, 16);
  return b;
}

/** Split a (already decompressed) op=5 body into individual JSON messages. */
function parseBody(buf) {
  const out = [];
  let off = 0;
  while (off + 16 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (len < 16 || off + len > buf.length) break;
    const ver = buf.readUInt16BE(off + 6);
    const op = buf.readUInt32BE(off + 8);
    let chunk = buf.subarray(off + 16, off + len);
    if (ver === 3) {
      try { chunk = zlib.brotliDecompressSync(chunk); } catch { off += len; continue; }
    } else if (ver === 2) {
      try { chunk = zlib.inflateSync(chunk); } catch { off += len; continue; }
    }
    if (op === 3) {
      try { out.push({ __op: 3, count: JSON.parse(chunk.toString()).count }); } catch { /* ignore */ }
    } else if (op === 5) {
      for (const s of chunk.toString().split(/[\x00-\x08\x0b-\x1f]+/)) {
        if (!s.startsWith('{')) continue;
        try { out.push(JSON.parse(s)); } catch { /* ignore */ }
      }
    }
    off += len;
  }
  return out;
}

/**
 * 从 DANMU_MSG 的 info 里抠出被 @ 的人。
 * 老字段 info[7] 只有一个人；新格式把 @ 列表塞在 info[0][15]
 * 的 JSON 里（extra.at），可能有多层字符串转义。
 */
function extractAts(info) {
  const names = new Set();
  const push = (v) => {
    if (!v) return;
    if (typeof v === 'string') {
      const s = v.trim();
      if (s) names.add(s);
    } else if (typeof v === 'object' && v.uname) {
      names.add(String(v.uname));
    }
  };
  try {
    if (Array.isArray(info?.[7])) for (const x of info[7]) push(x?.uname);
    else if (info?.[7] && typeof info[7] === 'object' && info[7].uname) push(info[7].uname);
  } catch {
    /* ignore */
  }
  try {
    const raw = info?.[0]?.[15];
    if (raw) {
      let cur = raw;
      for (let i = 0; i < 3; i++) {
        if (typeof cur === 'string') {
          try {
            cur = JSON.parse(cur);
          } catch {
            break;
          }
        } else break;
      }
      const at = cur?.extra ? (typeof cur.extra === 'string' ? JSON.parse(cur.extra) : cur.extra)?.at : cur?.at;
      if (at) {
        if (Array.isArray(at)) at.forEach(push);
        else push(at);
      }
    }
  } catch {
    /* ignore */
  }
  return [...names];
}

export class DanmakuClient extends EventEmitter {
  constructor({ roomId, cred, keys, getServer, log = () => {} }) {
    super();
    this.roomId = roomId;
    this.cred = cred;
    this.keys = keys;
    this.getServer = getServer;
    this.log = log;
    this.ws = null;
    this.timer = null;
    this.hb = null;
    this.closed = false;
    this.attempt = 0;
    this.hostIndex = 0;
    this.status = 'idle';
  }

  async connect() {
    if (this.closed) return;
    this.status = 'connecting';
    let server;
    try {
      server = await this.getServer();
    } catch (e) {
      this.log(`[danmaku] 取服务器失败: ${e.message}`);
      this.scheduleReconnect();
      return;
    }
    const host = server.hosts[this.hostIndex % server.hosts.length];
    this.hostIndex++;
    const WS = loadWs();
    const url = `wss://${host.host}:${host.port}/sub`;
    let ws;
    try {
      ws = new WS(url, { headers: { 'User-Agent': 'Mozilla/5.0', Origin: 'https://live.bilibili.com' } });
    } catch (e) {
      this.log(`[danmaku] 建连失败: ${e.message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    const guard = setTimeout(() => { try { ws.terminate(); } catch { /* ignore */ } }, 10000);

    ws.on('open', () => {
      clearTimeout(guard);
      this.status = 'open';
      this.attempt = 0;
      ws.send(packet(7, {
        uid: this.cred.uid || 0,
        roomid: this.roomId,
        protover: 3,
        platform: 'web',
        type: 2,
        key: server.token,
        buvid: this.cred.buvid,
      }));
      this.hb = setInterval(() => { try { ws.send(packet(2, {})); } catch { /* ignore */ } }, 30000);
      this.emit('open');
    });

    ws.on('message', (raw) => {
      const buf = Buffer.from(raw);
      for (const msg of parseBody(buf)) {
        if (msg.__op === 3) {
          this.emit('popularity', Number(msg.count) || 0);
          continue;
        }
        const cmd = String(msg.cmd || '');
        if (cmd.startsWith('DANMU_MSG')) {
          const info = msg.info || [];
          const text = info[1];
          const user = info?.[2]?.[1];
          if (text) this.emit('danmaku', { user, text, ats: extractAts(info) });
        } else if (cmd === 'SUPER_CHAT_MESSAGE') {
          this.emit('superchat', {
            user: msg?.data?.user_info?.uname,
            text: msg?.data?.message,
            price: msg?.data?.price,
          });
        } else if (cmd === 'SEND_GIFT') {
          this.emit('gift', {
            user: msg?.data?.uname,
            action: msg?.data?.action,
            giftName: msg?.data?.giftName,
            num: msg?.data?.num,
            price: Number(msg?.data?.price) / 1000,
            coinType: msg?.data?.coin_type,
          });
        } else if (cmd === 'GUARD_BUY') {
          this.emit('guard', {
            user: msg?.data?.username,
            level: msg?.data?.gift_name || msg?.data?.guard_level,
            num: msg?.data?.num,
            price: Number(msg?.data?.price) / 1000,
          });
        } else if (cmd === 'USER_TOAST_MSG') {
          this.emit('guard', {
            user: msg?.data?.username,
            level: msg?.data?.role_name || '',
            num: msg?.data?.num,
            price: Number(msg?.data?.price) / 1000,
          });
        }
      }
    });

    ws.on('error', (e) => {
      clearTimeout(guard);
      this.log(`[danmaku] ws 错误: ${e.message}`);
    });

    ws.on('close', () => {
      clearTimeout(guard);
      clearInterval(this.hb);
      this.hb = null;
      this.status = 'closed';
      if (!this.closed) this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.closed || this.timer) return;
    const delay = Math.min(30000, 1500 * Math.pow(2, Math.min(this.attempt++, 4)));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  close() {
    this.closed = true;
    this.status = 'closed';
    clearTimeout(this.timer);
    clearInterval(this.hb);
    try { this.ws?.terminate(); } catch { /* ignore */ }
  }
}
