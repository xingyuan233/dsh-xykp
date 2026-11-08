/**
 * bili-audio-live :: 主动发送
 * 发弹幕 / 送礼 / 直播间自带表情。
 *
 * ⚠️ 这些都是「用账号真的发出去」的写操作：不做重试、不做循环，
 *    送礼前由调用方按配置校验金额/种类/上限。
 */
import { createHash } from 'node:crypto';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function headers(cred, roomId) {
  return {
    'User-Agent': UA,
    Referer: `https://live.bilibili.com/${roomId}`,
    Origin: 'https://live.bilibili.com',
    Cookie: cred.cookie,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

function form(obj) {
  return new URLSearchParams(obj).toString();
}

function rnd() {
  return Math.floor(Math.random() * 1e8).toString();
}

/** 发一条弹幕。表情就是文本 `[名字]`，跟普通弹幕同一条接口。 */
export async function sendDanmaku(cred, roomId, text) {
  const msg = String(text || '').trim();
  if (!msg) throw new Error('弹幕内容为空');
  if (msg.length > 20) throw new Error(`弹幕太长（${msg.length} > 20）`);
  const body = form({
    color: '16777215',
    fontsize: '25',
    mode: '1',
    msg,
    rnd: rnd(),
    roomid: String(roomId),
    csrf: cred.jct,
    csrf_token: cred.jct,
  });
  const r = await fetch('https://api.live.bilibili.com/msg/send', {
    method: 'POST',
    headers: headers(cred, roomId),
    body,
  });
  return r.json();
}

/** 直播间表情包（和评论区表情不是一套）。 */
export async function listEmoticons(cred, roomId) {
  const r = await fetch(
    `https://api.live.bilibili.com/xlive/web-ucenter/v2/emoticon/GetEmoticons?platform=pc&room_id=${roomId}`,
    { headers: { 'User-Agent': UA, Referer: `https://live.bilibili.com/${roomId}`, Cookie: cred.cookie } },
  );
  const j = await r.json();
  if (j.code !== 0) throw new Error(`GetEmoticons code=${j.code} ${j.message || ''}`);
  const packages = j?.data?.data || [];
  const out = [];
  for (const p of packages) {
    for (const e of p.emoticons || []) {
      out.push({
        name: e.emoji || e.descript || '',
        text: `[${e.emoji || e.descript || ''}]`,
        unique: e.emoticon_unique || '',
        pkg: p.pkg_name || '',
        url: e.url || '',
        width: e.width,
        height: e.height,
        locked: Number(e.perm) === 0,
      });
    }
  }
  return out;
}

/** 按名字找一个可用表情，返回它的弹幕文本。 */
export async function resolveEmoticon(cred, roomId, name) {
  const list = await listEmoticons(cred, roomId);
  const key = String(name || '').replace(/^\[|\]$/g, '').trim();
  const hit = list.find((e) => e.name === key) || list.find((e) => e.name.includes(key));
  if (!hit) throw new Error(`没有找到表情「${name}」（共 ${list.length} 个）`);
  if (hit.locked) throw new Error(`表情「${hit.name}」未解锁`);
  return hit;
}

/** 礼物面板（给「允许哪些礼物」做校验用）。 */
export async function listGifts(cred, roomId) {
  const r = await fetch(
    `https://api.live.bilibili.com/xlive/web-room/v1/giftPanel/giftConfig?platform=pc&room_id=${roomId}`,
    { headers: { 'User-Agent': UA, Referer: `https://live.bilibili.com/${roomId}`, Cookie: cred.cookie } },
  );
  const j = await r.json();
  if (j.code !== 0) throw new Error(`giftConfig code=${j.code} ${j.message || ''}`);
  const raw = j?.data?.list || j?.data?.gift || [];
  return raw.map((g) => ({
    id: g.id,
    name: g.name,
    price: Number(g.price) / 1000, // 金瓜子 → 元
    coinType: g.coin_type,
    type: g.type,
  }));
}

/**
 * 送礼。
 * policy: { enabled, minYuan, maxYuan, maxPerSend, allow: [礼物名或id...] }
 * 返回 { ok, sent:{...}, price }
 */
export async function sendGift(cred, roomId, { giftName, giftId, num = 1, policy = {} }) {
  if (policy.enabled === false) throw new Error('送礼未启用（policy.enabled=false）');
  const gifts = await listGifts(cred, roomId);
  let gift = null;
  if (giftId) gift = gifts.find((g) => String(g.id) === String(giftId));
  if (!gift && giftName) gift = gifts.find((g) => g.name === giftName) || gifts.find((g) => g.name.includes(giftName));
  if (!gift) throw new Error(`礼物面板里没有「${giftName || giftId}」`);

  const allow = Array.isArray(policy.allow) ? policy.allow.map(String) : [];
  if (allow.length && !allow.includes(String(gift.id)) && !allow.includes(gift.name)) {
    throw new Error(`礼物「${gift.name}」不在允许列表里`);
  }

  const count = Math.max(1, Math.floor(Number(num) || 1));
  const cap = Math.max(1, Number(policy.maxPerSend) || 1);
  if (count > cap) throw new Error(`一次最多送 ${cap} 个（要 ${count}）`);

  const total = gift.price * count;
  if (policy.minYuan != null && total < Number(policy.minYuan)) throw new Error(`金额 ${total} 低于下限 ${policy.minYuan}`);
  if (policy.maxYuan != null && total > Number(policy.maxYuan)) throw new Error(`金额 ${total} 超过上限 ${policy.maxYuan}`);

  const body = form({
    uid: String(cred.uid || 0),
    gift_id: String(gift.id),
    gift_num: String(count),
    coin_type: gift.coinType || 'gold',
    csrf: cred.jct,
    csrf_token: cred.jct,
    roomid: String(roomId),
    platform: 'pc',
    rnd: rnd(),
    num: String(count),
  });
  const r = await fetch('https://api.live.bilibili.com/xlive/revenue/v1/gift/send', {
    method: 'POST',
    headers: headers(cred, roomId),
    body,
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`送礼失败 code=${j.code} ${j.message || ''}`);
  return { ok: true, gift: gift.name, num: count, totalYuan: total, resp: j };
}

/** 生成一个不重复的去重键，给上层记录「这条已经发过」用。 */
export function digest(text) {
  return createHash('md5').update(String(text)).digest('hex').slice(0, 12);
}
