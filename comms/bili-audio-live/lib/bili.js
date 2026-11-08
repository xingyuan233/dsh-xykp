/**
 * bili-audio-live :: bilibili plumbing
 * Credentials, WBI signing, live play-url and danmaku-server discovery.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

function mixinKey(orig) {
  let out = '';
  for (const i of MIXIN_KEY_ENC_TAB) out += orig[i];
  return out.slice(0, 32);
}

export function wbiSign(params, imgKey, subKey, nowSec = Math.floor(Date.now() / 1000)) {
  const withWts = { ...params, wts: nowSec };
  const query = Object.keys(withWts)
    .sort()
    .map((k) => k + '=' + encodeURIComponent(String(withWts[k]).replace(/[!'()*]/g, '')))
    .join('&');
  const w_rid = createHash('md5').update(query + mixinKey(imgKey + subKey)).digest('hex');
  const signed = { w_rid };
  for (const [k, v] of Object.entries(withWts)) signed[k] = String(v);
  return signed;
}

export function homeDir() {
  return process.env.DSH_HOME || 'D:\\AI\\DeepseekHarness\\home';
}

/** Read the shared bilibili credential written by the bili-rove login flow. */
export function loadCredential(file) {
  const p = file || path.join(homeDir(), 'xykp', 'bilibili', 'bili_credential.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`读不到 B站 凭证 ${p}: ${e.message}`);
  }
  const cookie = [
    raw.sessdata ? `SESSDATA=${raw.sessdata}` : '',
    raw.bili_jct ? `bili_jct=${raw.bili_jct}` : '',
    raw.buvid3 ? `buvid3=${raw.buvid3}` : '',
    raw.dedeuserid ? `DedeUserID=${raw.dedeuserid}` : '',
  ].filter(Boolean).join('; ');
  return {
    cookie,
    buvid: raw.buvid3 || '',
    uid: Number(raw.dedeuserid) || 0,
    sessdata: raw.sessdata,
    jct: raw.bili_jct || '',
    path: p,
  };
}

export function headers(cred, referer = 'https://live.bilibili.com/') {
  return { 'User-Agent': UA, Referer: referer, Cookie: cred.cookie };
}

async function getJson(url, h) {
  const r = await fetch(url, { headers: h });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url.slice(0, 80)}`);
  return r.json();
}

export async function fetchWbiKeys(cred) {
  const nav = await getJson('https://api.bilibili.com/x/web-interface/nav', headers(cred));
  const imgUrl = nav?.data?.wbi_img?.img_url || '';
  const subUrl = nav?.data?.wbi_img?.sub_url || '';
  const stem = (u) => u.split('/').pop().split('.')[0];
  if (!imgUrl || !subUrl) throw new Error('nav 没有返回 wbi key');
  return { imgKey: stem(imgUrl), subKey: stem(subUrl), uname: nav?.data?.uname || '', isLogin: !!nav?.data?.isLogin };
}

/** Every HLS candidate for one live room, ts variant first (fmp4 CDNs reset TLS). */
export async function getLiveStreams(roomId, cred) {
  const h = headers(cred);
  const info = await getJson(
    `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${roomId}` +
      `&protocol=0,1&format=0,1,2&codec=0,1&qn=10000&platform=web&ptype=8&dolby=5&panorama=1`,
    h,
  );
  if (info.code !== 0) throw new Error(`playinfo code=${info.code} ${info.message || ''}`);
  const data = info.data || {};
  const live = Number(data.live_status) === 1;
  const out = [];
  for (const s of data?.playurl_info?.playurl?.stream || []) {
    if (s.protocol_name !== 'http_hls') continue;
    for (const f of s.format) {
      for (const cd of f.codec) {
        if (cd.codec_name !== 'avc') continue;
        const host = cd.url_info?.[0]?.host;
        if (!host) continue;
        out.push({ format: f.format_name, url: host + cd.base_url + (cd.url_info[0].extra || '') });
      }
    }
  }
  out.sort((a, b) => (a.format === 'ts' ? 0 : 1) - (b.format === 'ts' ? 0 : 1));
  return { live, urls: out, title: data?.room_info?.title || '' };
}

export async function getDanmuServer(roomId, cred, keys) {
  const h = headers(cred);
  const signed = new URLSearchParams(
    wbiSign({ id: roomId, type: 0, web_location: '444.8' }, keys.imgKey, keys.subKey),
  ).toString();
  const r = await getJson(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${signed}`, h);
  if (r.code !== 0) throw new Error(`getDanmuInfo code=${r.code}`);
  const hosts = (r.data.host_list || []).map((x) => ({ host: x.host, port: x.wss_port }));
  if (!hosts.length) hosts.push({ host: 'broadcastlv.chat.bilibili.com', port: 443 });
  return { token: r.data.token, hosts };
}

export async function getRoomInfo(roomId, cred) {
  const r = await getJson(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`, headers(cred));
  if (r.code !== 0) throw new Error(`get_info code=${r.code}`);
  return { live: Number(r.data.live_status) === 1, title: r.data.title, online: r.data.online };
}
