// prosecutor：常驻守护进程，监听 ntfy 指令频道，远程检查 DSH 存活 / 拉起 / 往对话发消息。
//
// 指令（2026-10-27 新语义）：
//   /check [标识]   → 检查 DSH(3080) 是否在跑，不在就用 restart-dsh.ps1 拉起；
//                     跟了标识就必须等于 machineId，不然静默忽略。
//   /notify [标识] [-p 预设] [-s 会话] [-m 消息]
//                   → 先确保 DSH 在跑，再把 -m 的消息送进目标对话（走插件端点），
//                     回执只报「DSH 状态 + 发没发成功」，不输出模型回复。
//
// 用法：
//   node prosecutor.mjs           常驻
//   node prosecutor.mjs --once    只跑一次本地检查并退出（不订阅）
//   node prosecutor.mjs --parse-test 只打印参数解析结果
//
// 包内版（2026-10-27）：脚本和 config.json 跟着插件包走；
// 日志 / 状态 / pid 放 <DSH_HOME>/prosecutor/，不往 node_modules 里写。
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.DSH_HOME || 'D:\\AI\\DeepseekHarness\\home';
const RUN_DIR = join(HOME, 'xykp', 'prosecutor');
const CFG_PATH = join(HERE, 'config.json');
const LOG_PATH = join(RUN_DIR, 'prosecutor.log');
const STATE_PATH = join(RUN_DIR, 'state.json');

mkdirSync(RUN_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString();
const log = (msg) => {
  const line = `${ts()} ${msg}`;
  try { console.log(line); } catch {}
  try { appendFileSync(LOG_PATH, line + '\n', 'utf8'); } catch {}
};

const cfg = JSON.parse(readFileSync(CFG_PATH, 'utf8'));

// 插件（dsh-prosecutor）通过环境变量覆盖关键配置 —— cordis 那边为准，config.json 只是兜底。
// 2026-10-27：加入 ntfy 频道 / 机器标识 / 定时检查间隔（0 = 不主动检查）。
const envVal = (k) => (process.env[k] === undefined || process.env[k] === '' ? undefined : String(process.env[k]));
for (const [key, name] of [
  ['topic', 'DSH_PROSECUTOR_TOPIC'],
  ['machineId', 'DSH_PROSECUTOR_MACHINE_ID'],
  ['checkIntervalMinutes', 'DSH_PROSECUTOR_CHECK_INTERVAL_MINUTES'],
  ['dshPort', 'DSH_PROSECUTOR_DSH_PORT'],
  ['sendEndpoint', 'DSH_PROSECUTOR_SEND_ENDPOINT'],
]) {
  const v = envVal(name);
  if (v !== undefined) cfg[key] = v;
}
cfg.machineId = String(cfg.machineId || '');
cfg.checkIntervalMinutes = Number(cfg.checkIntervalMinutes) || 0;
cfg.sendEndpoint = String(cfg.sendEndpoint || 'http://127.0.0.1:' + (cfg.dshPort || 3080) + '/dsh-prosecutor/send');

const PID_PATH = join(RUN_DIR, 'prosecutor.pid');
const argv = process.argv.slice(2);

// PowerShell 7 的绝对路径：WMI/服务环境里 PATH 可能和登录会话不一致，不靠 PATH 碰运气
const PWSH = existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
  ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
  : 'pwsh';

// ---------- 状态 ----------
function readState() {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  try { writeFileSync(STATE_PATH, JSON.stringify(s, null, 2), 'utf8'); } catch {}
}

// ---------- 端口探测 ----------
function isPortOpen(port, timeoutMs = 900) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        try { sock.destroy(); } catch {}
        resolve(v);
      }
    };
    const sock = net.connect({ port, host: '127.0.0.1' });
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });
}

// ---------- ntfy ----------
function ntfyRequest(headers, body) {
  return new Promise((resolve) => {
    const server = String(cfg.ntfyServer || 'https://ntfy.sh').replace(/\/+$/, '');
    const url = new URL(server + '/' + encodeURIComponent(cfg.topic));
    const httpMod = url.protocol === 'http:' ? import_http() : import_https();
    const h = { ...headers };
    h['Content-Length'] = body.length;
    Promise.resolve(httpMod).then((mod) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        const req = mod.request(
          { method: 'POST', hostname: url.hostname, port: url.port || (url.protocol === 'http:' ? 80 : 443), path: url.pathname + url.search, headers: h },
          (res) => { res.resume(); res.on('end', () => finish(res.statusCode)); }
        );
        req.on('error', () => finish(0));
        req.setTimeout(15000, () => { try { req.destroy(); } catch {} finish(0); });
        req.end(body);
      } catch { finish(0); }
    });
  });
}
function import_http() { return import('node:http').then((m) => m.default); }
function import_https() { return import('node:https').then((m) => m.default); }

const utf8h = (s) => Buffer.from(String(s), 'utf8').toString('latin1');

async function notify(title, message, tags = 'robot') {
  const headers = {
    Title: utf8h(title),
    Priority: '4',
    Tags: utf8h(tags),
    'Content-Type': 'text/plain; charset=utf-8'
  };
  const code = await ntfyRequest(headers, Buffer.from(message, 'utf8'));
  log('[notify] ' + title + ' -> ' + code);
  return code;
}

// ---------- 动作 ----------
// 注意（2026-10-26 修）：以前这里是 detached:true + stdio:'ignore'。
// 在 Windows / WMI 环境下，Node 这样起的 pwsh.exe 会立刻 exit 0、脚本一行都不执行
// （实测：detached+ignore 0.4s 静默退出；改成 pipe 就正常输出并写入 restart-status.log）。
// restart-dsh.ps1 自己会用 WMI 把 worker 分离出去，所以这里根本不需要 detached，
// 用 pipe 收集输出反而能确认它到底跑没跑。
async function startDsh(reason, opts = {}) {
  log('动作：启动 DSH（' + reason + '）');
  const args = [
    '-NoLogo', '-NoProfile', '-NonInteractive',
    '-File', cfg.restartDshScript,
    '-DelaySeconds', String(opts.delaySeconds ?? 10)
  ];
  if (opts.dryRun) args.push('-DryRun');

  return await new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let child;
    try {
      child = spawn(PWSH, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      log('启动 DSH 失败: ' + e.message);
      return finish({ ok: false, error: e.message });
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      log('启动 DSH 失败: 启动器 60s 未退出');
      finish({ ok: false, error: '启动器 60s 未退出' });
    }, 60000);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      log('启动 DSH 失败: ' + e.message);
      finish({ ok: false, error: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = (out + (err ? '\n[stderr] ' + err : '')).trim();
      log('restart-dsh 退出 code=' + code + (text ? ' 输出：' + text.replace(/\s+/g, ' ').slice(0, 300) : '（无输出）'));
      finish({ ok: code === 0, code, text });
    });
  });
}

async function waitForPort(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true;
    await sleep(3000);
  }
  return false;
}

// ---------- /check ----------
async function doCheck(origin) {
  const st = readState();
  const lines = [];
  const dshOk = await isPortOpen(cfg.dshPort);
  if (dshOk) {
    lines.push('DSH：运行中');
  } else {
    const r = await startDsh(origin);
    if (!r.ok) {
      lines.push('DSH：没在跑，重启命令失败（' + (r.error || 'exit=' + r.code) + '）');
    } else {
      const waitMs = Number(cfg.checkRestartWaitMs) || 60000;
      const up = await waitForPort(cfg.dshPort, waitMs);
      lines.push(up
        ? 'DSH：没在跑 → 已重启并确认在线'
        : 'DSH：没在跑 → 重启已发起，但 ' + Math.round(waitMs / 1000) + ' 秒内没起来，看 restart-status.log');
    }
  }
  const body = `【prosecutor ${new Date().toLocaleString('zh-CN')}】\n${lines.join('\n')}`;
  await notify('prosecutor 检查结果', body, 'white_check_mark,robot');
  st.lastCheckAt = Date.now();
  writeState(st);
  return body;
}

// ---------- /notify ----------
// headless 要的 API key 从 api-key.txt 读（限制过 ACL），启动时注入环境变量
function readApiKey() {
  try {
    const k = readFileSync(cfg.apiKeyFile, 'utf8').trim();
    if (k) return k;
  } catch (e) {
    log('读 API key 失败: ' + e.message);
  }
  return '';
}

// 异步跑 headless：自检那几分钟不阻塞主循环，期间照样能收 /check
function runHeadlessAsync(prompt) {
  log('发起 headless 自检…');
  const apiKey = readApiKey();
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let child;
    try {
      const env = { ...process.env, DSH_HOME: 'D:\\AI\\DeepseekHarness\\home' };
      if (apiKey) env.DEEPSEEK_API_KEY = apiKey;
      child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', cfg.dshPs1, 'headless', prompt], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env
      });
    } catch (e) {
      return finish('headless 启动失败: ' + e.message);
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(('headless 超时（' + cfg.headlessTimeoutMs + 'ms）\n' + out).slice(-4000));
    }, cfg.headlessTimeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(('exit=' + code + '\n' + out + (err ? '\n[stderr]\n' + err : '')).trim());
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      finish('headless 启动失败: ' + e.message);
    });
  });
}

let notifyBusy = false;

// 自检计划从指定文件读；读不到就用 config 里的兜底提示词
// （2026-10-27 起 /notify 不再跑模型自检，这个函数留给以后的手动自检用）
function loadPlan() {
  try {
    const text = readFileSync(cfg.selfCheckFile, 'utf8').trim();
    if (text) {
      log('读取计划文件 ' + cfg.selfCheckFile + '（' + text.length + ' 字）');
      return text;
    }
  } catch (e) {
    log('读计划文件失败，用内置提示词兜底: ' + e.message);
  }
  return cfg.selfCheckPrompt;
}

// ---------- /notify（新语义 2026-10-27）----------
// /notify [标识] [-p 预设] [-s 会话] [-m 消息]
//   1. 先检查 DSH 活着没，没活就启动
//   2. -p：找预设「当前绑定的对话」（preset-binder 的 active）；-s：直接找对话
//   3. -m 给消息，就发到那个对话（走 dsh-prosecutor 插件的本地端点）
//   回执只报「DSH 状态 + 有没有发成功」，不输出模型的回复。
async function doNotify(origin, parsed = {}) {
  if (notifyBusy) {
    log('已有一轮 /notify 在跑，本次忽略');
    await notify('prosecutor 忙', '上一轮还在跑，本次 /notify 已忽略', 'hourglass,robot');
    return '';
  }
  notifyBusy = true;
  try {
    const st = readState();
    const lines = [];

    // ① 检查 DSH，不在就启动
    let dshOk = await isPortOpen(cfg.dshPort);
    if (dshOk) {
      lines.push('DSH：运行中');
    } else {
      const r = await startDsh(origin);
      if (!r.ok) {
        lines.push('DSH：没在跑，启动命令失败（' + (r.error || 'exit=' + r.code) + '）');
      } else {
        const waitMs = Number(cfg.checkRestartWaitMs) || 60000;
        const up = await waitForPort(cfg.dshPort, waitMs);
        lines.push(up
          ? 'DSH：没在跑 → 已启动并确认在线'
          : 'DSH：没在跑 → 启动已发起，但 ' + Math.round(waitMs / 1000) + ' 秒内没起来');
        dshOk = up;
      }
    }

    // ② 找会话：按 -p / -s 出现的顺序试，第一个找到的用
    let target = null;
    let createPreset = null; // -p 找不到绑定对话时记下预设，交给宿主按预设新开一个对话
    const tries = [];
    for (const [flag, value] of parsed.ops || []) {
      const v = String(value || '').trim();
      if (!v) continue; // 没跟参数 → 忽略
      if (flag === '-p') {
        const pid = findPreset(v);
        if (!pid) {
          // 内置预设（standard/ptc/minimal/cordis）被 preset-binder 的 ignore 列表过滤，
          // 永远不进绑定表 —— 直接让宿主按预设新开一个对话
          tries.push('-p ' + v + '：绑定表里没有（内置预设不跟踪），新开一个对话');
          createPreset = v;
          break;
        }
        const b = readBinder();
        const active = b && b.presets && b.presets[pid] && b.presets[pid].active;
        if (!active) {
          tries.push('-p ' + v + '（' + pid + '）：这个预设没有绑定的对话，新开一个');
          createPreset = pid;
          break;
        }
        target = listSessions().find((s) => s.sid === active) || { sid: active, title: '' };
        break;
      }
      if (flag === '-s') {
        const info = findSession(v);
        if (!info) {
          tries.push('-s ' + v + '：没找到这个对话');
          continue;
        }
        target = info;
        break;
      }
    }

    // ③ 发消息
    const message = String(parsed.message || '').trim();
    if (!message) {
      lines.push('消息：没给 -m，没发');
    } else if (!dshOk) {
      lines.push('消息：DSH 没起来，没法发');
    } else if (target) {
      const r = await postSend(target.sid, message);
      lines.push(r.ok
        ? '消息：已发送到「' + (target.title || target.sid) + '」'
        : '消息：发送失败（' + (r.reason || '？') + '）');
    } else if (createPreset) {
      const r = await postCreate(createPreset, message);
      lines.push(r.ok
        ? '消息：已新开「' + (r.agentPreset || createPreset) + '」对话并发送（' + (r.session || '?') + '）'
        : '消息：新建对话没成（' + (r.reason || '？') + '）');
    } else {
      lines.push('消息：没给 -p/-s（或都没找到），没发' + (tries.length ? '\n' + tries.join('\n') : ''));
    }

    const body = `【prosecutor ${new Date().toLocaleString('zh-CN')}】\n` + lines.join('\n');
    await notify('prosecutor 检查结果', body, 'white_check_mark,robot');
    st.lastNotifyAt = Date.now();
    writeState(st);
    return body;
  } finally {
    notifyBusy = false;
  }
}

// 从计划文件里抽 ```powershell / ```ps1 代码块，逐个执行
function extractScripts(md) {
  const out = [];
  const re = /```(?:powershell|ps1|pwsh)\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(md))) {
    const s = m[1].trim();
    if (s) out.push(s);
  }
  return out;
}

function runPowerShell(script, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let child;
    try {
      child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DSH_HOME: 'D:\\AI\\DeepseekHarness\\home' }
      });
    } catch (e) {
      return finish('启动失败: ' + e.message);
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(('超时\n' + out).trim());
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(((out + (err ? '\n[stderr] ' + err : '')).trim()) || ('exit=' + code + '（无输出）'));
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      finish('启动失败: ' + e.message);
    });
  });
}

// 脚本级自检：不依赖模型，端口 + 日志 + 待办文件
async function scriptLevelCheck() {
  const lines = [];
  const dsh = await isPortOpen(cfg.dshPort);
  const me = await isPortOpen(cfg.lockPort);
  lines.push(`DSH(${cfg.dshPort})=${dsh ? 'ok' : 'DOWN'}  prosecutor(${cfg.lockPort})=${me ? 'ok' : 'DOWN'}`);

  const tailOf = (file, n) => {
    try {
      const text = readFileSync(file, 'utf8');
      const arr = text.split(/\r?\n/).filter(Boolean);
      return arr.slice(-n);
    } catch {
      return [];
    }
  };
  const logTail = tailOf(LOG_PATH, 20);
  const logFail = logTail.filter((l) => /失败|异常|error/i.test(l)).length;
  lines.push(`prosecutor 最近 20 行：失败/异常 ${logFail} 条`);

  const tasksDir = join(HOME, 'tasks');
  let pending = [];
  try {
    pending = readdirSync(tasksDir).filter((f) => /\.(todo|pending)\.md$/i.test(f));
  } catch {}
  lines.push(`待办文件：${pending.length ? pending.join('、') : '无'}`);
  return lines.join('\n');
}

// ---------- 会话查找（-p / -s）----------
function readBinder() {
  try { return JSON.parse(readFileSync(cfg.binderPath || (HOME + '\\storages\\preset-binder.json'), 'utf8')); } catch { return null; }
}

// -p：name（英文 id）→ 中文名 → 纯数字索引（1 开始）
function findPreset(name) {
  const b = readBinder();
  const presets = (b && b.presets) || {};
  const ids = Object.keys(presets);
  const key = String(name || '').trim();
  if (!key) return null;
  if (presets[key]) return key;
  const byName = ids.find((id) => String(presets[id].name || '') === key);
  if (byName) return byName;
  const byNameLoose = ids.find((id) => String(presets[id].name || '').toLowerCase() === key.toLowerCase());
  if (byNameLoose) return byNameLoose;
  if (/^\d+$/.test(key)) {
    const i = Number(key) - 1;
    if (i >= 0 && i < ids.length) return ids[i];
  }
  return null;
}

// 所有预设下的会话，按最近活动倒序（「最近对话排序」）
function listSessions() {
  const b = readBinder();
  const out = [];
  for (const [pid, row] of Object.entries((b && b.presets) || {})) {
    for (const [sid, s] of Object.entries(row.sessions || {})) {
      out.push({ sid, title: s.title || '', last: Date.parse(s.lastActivityAt || '') || 0, preset: pid, active: row.active === sid });
    }
  }
  return out.sort((a, b2) => b2.last - a.last);
}

// -s：中文名字（标题）→ ≤4 位纯整数索引（按最近活动排）→ session-id
function findSession(name) {
  const key = String(name || '').trim();
  if (!key) return null;
  const list = listSessions();
  const exact = list.find((s) => s.title === key);
  if (exact) return exact;
  const loose = list.find((s) => s.title && s.title.includes(key));
  if (loose) return loose;
  if (/^\d{1,4}$/.test(key)) {
    const i = Number(key) - 1;
    if (i >= 0 && i < list.length) return list[i];
  }
  const sid = /^session-/.test(key) ? key : 'session-' + key;
  const hit = list.find((s) => s.sid === key) || list.find((s) => s.sid === sid);
  if (hit) return hit;
  // 表里没有也认 —— 可能是个还没进 preset-binder 表的新会话，交给插件端点去判断
  return { sid, title: '' };
}

// ---------- 发消息到会话（走 dsh-prosecutor 插件的本地端点）----------
function postJson(payload, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(cfg.sendEndpoint); } catch { return resolve({ ok: false, reason: 'sendEndpoint 配错了' }); }
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const mod = url.protocol === 'http:' ? import_http() : import_https();
    Promise.resolve(mod).then((m) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        const req = m.request(
          {
            method: 'POST',
            hostname: url.hostname,
            port: url.port || (url.protocol === 'http:' ? 80 : 443),
            path: url.pathname,
            headers: { 'content-type': 'application/json', 'content-length': body.length },
          },
          (res) => {
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { buf += d; });
            res.on('end', () => {
              try { finish(JSON.parse(buf)); } catch { finish({ ok: false, reason: '端点回应不是 JSON（' + res.statusCode + '）' }); }
            });
          },
        );
        req.on('error', (e) => finish({ ok: false, reason: '连不上 DSH 插件端点：' + e.message }));
        req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} finish({ ok: false, reason: '插件端点 ' + Math.round(timeoutMs / 1000) + 's 没回应' }); });
        req.end(body);
      } catch (e) { finish({ ok: false, reason: '发请求失败：' + e.message }); }
    });
  });
}

// 发到已有会话
const postSend = (session, text) => postJson({ session, text });

// -p 在 binder 里查不到（内置预设被 preset-binder 的 ignore 列表过滤掉了）或那个预设没有绑定对话：
// 让宿主按这个预设新开一个对话，再把消息塞进去；预设不存在时宿主回「没有这个预设」
const postCreate = (preset, text) => postJson({ preset, text });

// ---------- 分发 ----------
// 只认 /check、/notify 开头的消息。
//   /check            → 本机直接执行
//   /check xy         → 标识跟配置的 machineId 比，一样才执行
//   /notify [标识] [-p 预设] [-s 会话] [-m 消息]
function identMatches(ident) {
  const mine = String(cfg.machineId || '').trim().toLowerCase();
  if (!mine) return false; // 没配标识 → 带标识的一律不认
  return String(ident || '').trim().toLowerCase() === mine;
}

// 解析 /notify 的参数：标识可选，-p/-s/-m 按出现顺序收集；
// -m 后面剩下的都算消息（消息里可以有空格），-p/-s 没跟参数就记空值（后面忽略）。
function parseNotifyArgs(tokens) {
  const out = { ident: '', ops: [], message: '' };
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '-p' || t === '-s' || t === '-m') break;
    out.ident = t;
    i++;
    break;
  }
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '-m') {
      out.message = tokens.slice(i + 1).join(' ').trim();
      i = tokens.length;
      continue;
    }
    if (t === '-p' || t === '-s') {
      const v = tokens[i + 1];
      if (v && !v.startsWith('-')) { out.ops.push([t, v]); i += 2; }
      else { out.ops.push([t, '']); i += 1; } // 没跟参数 → 后面忽略
      continue;
    }
    i++;
  }
  return out;
}

async function dispatch(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const parts = raw.split(/[\s,，]+/).filter(Boolean);
  const head = (parts[0] || '').toLowerCase();
  const isCheck = head === String(cfg.checkCommand || '/check').toLowerCase();
  const isNotify = head === String(cfg.notifyCommand || '/notify').toLowerCase();
  if (!isCheck && !isNotify) return false;

  if (isCheck) {
    const ident = (parts[1] || '').trim();
    if (ident && !identMatches(ident)) {
      // ⚠ 标识不符就**静默忽略**，不回任何东西 —— 多台机器绑同一个频道时回复会刷屏
      log('收到 ' + cfg.checkCommand + '，标识「' + ident + '」不是本机（' + (cfg.machineId || '未配置') + '），静默忽略');
      return false;
    }
    log('收到 ' + cfg.checkCommand + (ident ? '（标识：' + ident + '）' : ''));
    try { await doCheck('/check'); } catch (e) { log('check 异常: ' + (e?.stack || e)); }
    return true;
  }

  const parsed = parseNotifyArgs(parts.slice(1));
  if (parsed.ident && !identMatches(parsed.ident)) {
    log('收到 ' + cfg.notifyCommand + '，标识「' + parsed.ident + '」不是本机，忽略');
    return false;
  }
  log('收到 ' + cfg.notifyCommand + '：' + JSON.stringify(parsed));
  try { await doNotify('/notify', parsed); } catch (e) { log('notify 异常: ' + (e?.stack || e)); }
  return true;
}

// ---------- 订阅 ----------
async function subscribeLoop() {
  const server = String(cfg.ntfyServer || 'https://ntfy.sh').replace(/\/+$/, '');
  const mod = server.startsWith('http:') ? await import_http() : await import_https();
  let since = Math.floor(Date.now() / 1000);
  for (;;) {
    await new Promise((resolve) => {
      let url;
      try {
        url = new URL(server + '/' + encodeURIComponent(cfg.topic) + '/json?since=' + since);
      } catch {
        resolve();
        return;
      }
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      const req = mod.request(
        { method: 'GET', hostname: url.hostname, port: url.port || (url.protocol === 'http:' ? 80 : 443), path: url.pathname + url.search, headers: { Accept: 'application/json' } },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            log('订阅失败 http ' + res.statusCode);
            finish();
            return;
          }
          log('已订阅指令频道，等待 ' + cfg.checkCommand + ' / ' + cfg.notifyCommand);
          let buf = '';
          let chain = Promise.resolve();
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            buf += chunk;
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              let msg;
              try { msg = JSON.parse(line); } catch { continue; }
              if (msg && msg.time) since = Math.max(since, msg.time + 1);
              if (!msg || msg.event !== 'message') continue;
              const text = String(msg.message || '').trim();
              if (!text) continue;
              chain = chain.then(() => dispatch(text)).catch((e) => log('dispatch 异常: ' + e.message));
            }
          });
          res.on('end', finish);
          res.on('close', finish);
          res.on('error', finish);
        }
      );
      req.on('error', finish);
      req.end();
    });
    await sleep(5000);
  }
}

// ---------- 入口 ----------
// 只跑一遍「启动 DSH」这条链路，带 -DryRun（worker 只写日志、不动服务），用来验证 spawn 没坏
if (argv.includes('--test-restart-dry')) {
  log('测试 startDsh（DryRun，不会停/起任何服务）');
  const r = await startDsh('--test-restart-dry', { delaySeconds: 1, dryRun: true });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

if (argv.includes('--once') || argv.includes('--selftest')) {
  const selftest = argv.includes('--selftest');
  log('单次模式 selftest=' + selftest);
  const dsh = await isPortOpen(cfg.dshPort);
  console.log('DSH(' + cfg.dshPort + ')=' + dsh);
  if (selftest) {
    console.log('selftest：不发通知、不重启任何服务');
  } else {
    console.log(JSON.stringify({ dsh }));
  }
  process.exit(0);
}

// 解析自测：--parse-test 只打印解析结果（不连 ntfy、不占锁）
if (argv.includes('--parse-test')) {
  const cases = [
    ['/check'],
    ['/check', 'xy'],
    ['/check', 'nginx'],
    ['/notify', '-p', 'alive', '-m', '你好 世界'],
    ['/notify', 'xy', '-s', '2', '-m', 'hi'],
    ['/notify', '-s', 'session-abc', '-p'],
    ['/notify', '-p', '记忆', '-s', '3'],
  ];
  for (const c of cases) {
    const parsed = parseNotifyArgs(c.slice(1));
    console.log(JSON.stringify({ cmd: c[0], ident: parsed.ident, ops: parsed.ops, message: parsed.message }));
  }
  console.log('ident xy ->', identMatches('xy'), '| ident abc ->', identMatches('abc'));
  const b = readBinder();
  const presets = Object.keys((b && b.presets) || {});
  console.log('presets:', presets.join(',') || '（没有 binder）');
  console.log('sessions(最近3):', listSessions().slice(0, 3).map((s) => (s.title || '(无名)') + '|' + s.sid.slice(0, 20)).join(' , ') || '（无）');
  if (presets[0]) console.log('findPreset(' + presets[0] + ') ->', findPreset(presets[0]), '| findPreset(1) ->', findPreset('1'));
  process.exit(0);
}

// 单实例锁
const lock = net.createServer();
lock.once('error', () => { log('已有 prosecutor 在跑，本进程退出'); process.exit(0); });
await new Promise((resolve) => lock.listen(cfg.lockPort, '127.0.0.1', resolve));
try { writeFileSync(PID_PATH, String(process.pid), 'utf8'); } catch {}
log('prosecutor 启动，锁 127.0.0.1:' + cfg.lockPort + ' 标识=' + (cfg.machineId || '未配') + ' 频道=' + cfg.topic);

// 定时检查（0 = 不主动检查）：DSH 不在就启动，结果发频道
if (cfg.checkIntervalMinutes > 0) {
  const every = cfg.checkIntervalMinutes;
  log('定时检查：每 ' + every + ' 分钟探一次 DSH');
  setInterval(async () => {
    try {
      if (await isPortOpen(cfg.dshPort)) return;
      log('定时检查：DSH 不在，拉起');
      const r = await startDsh('定时检查');
      const up = r.ok ? await waitForPort(cfg.dshPort, Number(cfg.checkRestartWaitMs) || 60000) : false;
      await notify(
        'prosecutor 定时检查',
        'DSH 没在跑 → ' + (up ? '已启动并确认在线' : '启动失败或未确认') + (r.error ? '（' + r.error + '）' : ''),
        up ? 'white_check_mark,robot' : 'warning,robot'
      );
    } catch (e) { log('定时检查异常: ' + (e?.message || e)); }
  }, every * 60000).unref();
}

await subscribeLoop();
