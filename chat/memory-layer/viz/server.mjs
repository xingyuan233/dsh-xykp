// 本地服务：记忆视图 + 编辑台 + 实时推送
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { MemoryLayer } from '../lib/layer.mjs'
import { HAND } from './scenario.mjs'

const __dir = path.dirname(fileURLToPath(import.meta.url))
// 优先读插件真正在用的库目录（一个预设一个文件），没有才退回本地 data/
const DSH_HOME = process.env.DSH_HOME || path.join(homedir(), '.dsh')
let DATA = path.join(DSH_HOME, 'memory-layer', 'layers')
let SEED = true   // 手动起 dev server 时灌剧本；插件里起就关掉
const PUB = path.join(__dir, 'public')
const PORT = Number(process.env.ML_PORT || 3099)
const DAY = 86400000

fs.mkdirSync(DATA, { recursive: true })
fs.mkdirSync(PUB, { recursive: true })

const libs = new Map()

function snap(layer, log) {
  const now = Date.now() / DAY
  return {
    turn: layer.turn,
    log: log ?? null,
    concepts: [...layer.concepts.values()].map((c) => ({
      id: c.id, key: c.key, cm: +c.cm.value(layer.turn, now).toFixed(3), df: c.df,
    })),
    edges: [...layer.edgeIndex.values()].map((e) => ({
      a: e.a, b: e.b, wAB: +e.wAB.toFixed(3), wBA: +e.wBA.toFixed(3), count: e.count, hit: e.hit, pass: e.pass,
    })),
    events: [...layer.events.values()].map((e) => ({
      id: e.id, brief: e.brief, forgotten: e.forgotten,
      links: e.refs.map((l) => ({ cid: l.cid, ce: +l.ce.value(layer.turn, now).toFixed(3) })),
      cids: e.refs.map((l) => l.cid),
    })),
  }
}

function save(lib) {
  fs.writeFileSync(path.join(DATA, lib.name + '.json'), JSON.stringify(lib.layer.toJSON()), 'utf8')
  if (lib._t) return
  lib._t = setTimeout(() => {
    lib._t = null
    try {
      fs.writeFileSync(path.join(DATA, lib.name + '.frames.json'),
        JSON.stringify({ frames: lib.frames.slice(-300) }), 'utf8')
    } catch {}
  }, 1200)
}

function broadcast(lib, frame) {
  const payload = `data: ${JSON.stringify({ frame, stats: lib.layer.stats() })}\n\n`
  for (const res of lib.clients) {
    try { res.write(payload) } catch { lib.clients.delete(res) }
  }
}

function pushFrame(lib, log) {
  const f = snap(lib.layer, log)
  lib.frames.push(f)
  if (lib.frames.length > 500) lib.frames.shift()
  save(lib)
  broadcast(lib, f)
  return f
}

function lib(name = 'test') {
  if (libs.has(name)) return libs.get(name)
  const file = path.join(DATA, name + '.json')
  let layer
  if (fs.existsSync(file)) {
    layer = MemoryLayer.fromJSON(JSON.parse(fs.readFileSync(file, 'utf8')))
  } else {
    layer = new MemoryLayer()
  }
  const l = { name, layer, frames: [], clients: new Set() }
  libs.set(name, l)
  const hf = path.join(DATA, name + '.frames.json')
  if (fs.existsSync(hf)) {
    try {
      const h = JSON.parse(fs.readFileSync(hf, 'utf8'))
      if (Array.isArray(h.frames) && h.frames.length) l.frames = h.frames
    } catch {}
  }
  if (!l.frames.length) l.frames.push(snap(layer, null))
  if (!fs.existsSync(file) && SEED) seed(l)
  return l
}

/** 新库先喂剧本前 18 轮，不至于空着 */
function seed(l) {
  const L = l.layer
  for (const t of HAND) {
    L.nextTurn()
    for (const w of t.write ?? []) {
      L.addEvent({ brief: w.brief, concepts: w.c.map(([k, m]) => ({ key: k, match: m })) })
    }
    const rows = L.retrieve(t.u)
    L.markPushed(rows, L.turn)
    const fb = L.feedback(rows, t.r)
    l.frames.push(snap(L, {
      u: t.u, r: t.r, pushed: rows.map((x) => x.event.brief),
      hit: fb?.hit ?? 0, miss: fb?.miss ?? 0,
    }))
  }
  save(l)
}

function doTurn(l, body) {
  const L = l.layer
  L.nextTurn()
  for (const w of body.write ?? []) {
    L.addEvent({ brief: w.brief, concepts: (w.concepts ?? []).map(([k, m]) => ({ key: k, match: m })) })
  }
  const rows = L.retrieve(body.u ?? '')
  L.markPushed(rows, L.turn)
  const fb = L.feedback(rows, body.r ?? '')
  const log = {
    u: body.u ?? '', r: body.r ?? '',
    pushed: rows.map((x) => x.event.brief),
    hit: fb?.hit ?? 0, miss: fb?.miss ?? 0,
  }
  pushFrame(l, log)
  return {
    pushed: rows.map((x) => ({
      id: x.event.id, brief: x.event.brief, score: +x.score.toFixed(3), via: x.best?.key ?? null,
    })),
    hit: log.hit, miss: log.miss,
  }
}

function hardDelete(l, id) {
  const L = l.layer
  const ev = L.events.get(id)
  if (!ev) return false
  for (const link of ev.refs) {
    const c = L.concepts.get(link.cid)
    if (c) c.evs = c.evs.filter((x) => x !== link)
  }
  L.events.delete(id)
  return true
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}
const readBody = (req) => new Promise((ok) => {
  let b = ''
  req.on('data', (c) => { b += c })
  req.on('end', () => { try { ok(JSON.parse(b || '{}')) } catch { ok({}) } })
})

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname

  // ── 静态页 ──
  if (p === '/' || p === '/viz') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(fs.readFileSync(path.join(PUB, 'viz.html')))
  }
  if (p === '/edit') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(fs.readFileSync(path.join(PUB, 'edit.html')))
  }
  if (p.startsWith('/pub/')) {
    const f = path.join(PUB, p.slice(4))
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end('no') }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' })
    return res.end(fs.readFileSync(f))
  }

  // ── API ──
  if (p === '/api/presets') {
    const names = new Set(['test'])
    for (const f of fs.readdirSync(DATA)) {
      if (!f.endsWith('.json') || f.endsWith('.frames.json')) continue
      names.add(f.replace(/\.json$/, ''))
    }
    return json(res, 200, { presets: [...names], current: 'test' })
  }

  if (p === '/api/state') {
    const name = url.searchParams.get('preset') || 'test'
    const l = lib(name)
    // 磁盘上的文件比内存新，就重新读 —— 插件那边写进去的能直接看到
    try {
      const f = path.join(DATA, name + '.json')
      if (fs.existsSync(f)) {
        const m = fs.statSync(f).mtimeMs
        if (m > (l.mtime || 0)) {
          l.mtime = m
          l.layer = MemoryLayer.fromJSON(JSON.parse(fs.readFileSync(f, 'utf8')))
          l.frames = [snap(l.layer, null)]
        }
      }
    } catch {}
    return json(res, 200, { preset: l.name, frames: l.frames, stats: l.layer.stats() })
  }

  if (p === '/api/stream') {
    const l = lib(url.searchParams.get('preset') || 'test')
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache',
      connection: 'keep-alive', 'access-control-allow-origin': '*',
    })
    res.write(': hello\n\n')
    l.clients.add(res)
    req.on('close', () => l.clients.delete(res))
    return
  }

  if (p === '/api/turn' && req.method === 'POST') {
    const b = await readBody(req)
    return json(res, 200, doTurn(lib(b.preset), b))
  }

  if (p === '/api/event' && req.method === 'POST') {
    const b = await readBody(req)
    const l = lib(b.preset)
    const ev = l.layer.addEvent({
      brief: b.brief, concepts: (b.concepts ?? []).map(([k, m]) => ({ key: k, match: m })),
      importance: b.importance ?? 0.5,
    })
    pushFrame(l, { u: '（手动新增记忆）', r: '', pushed: [], hit: 0, miss: 0 })
    return json(res, 200, { ok: true, id: ev.id })
  }

  if (p === '/api/forget' && req.method === 'POST') {
    const b = await readBody(req)
    const l = lib(b.preset)
    l.layer.forget(b.id)
    pushFrame(l, { u: '（忘记一条）', r: '', pushed: [], hit: 0, miss: 0 })
    return json(res, 200, { ok: true })
  }

  if (p === '/api/delete' && req.method === 'POST') {
    const b = await readBody(req)
    const l = lib(b.preset)
    hardDelete(l, b.id)
    pushFrame(l, { u: '（删除一条）', r: '', pushed: [], hit: 0, miss: 0 })
    return json(res, 200, { ok: true })
  }

  if (p === '/api/next' && req.method === 'POST') {
    const b = await readBody(req)
    const l = lib(b.preset)
    l.layer.nextTurn()
    pushFrame(l, { u: '（推进一回合）', r: '', pushed: [], hit: 0, miss: 0 })
    return json(res, 200, { ok: true, turn: l.layer.turn })
  }

  res.writeHead(404)
  res.end('not found')
})

export function startVizServer(opts = {}) {
  const port = Number(opts.port || process.env.ML_PORT || 3099)
  if (opts.layersDir) DATA = opts.layersDir
  if (opts.seed === false) SEED = false
  fs.mkdirSync(DATA, { recursive: true })
  try {
    server.listen(port, '127.0.0.1', () => {
      console.log('[memory-layer] 可视化 http://127.0.0.1:' + port + '/')
    })
  } catch (e) {
    console.error('[memory-layer] 可视化起不来:', e?.message)
    return () => {}
  }
  server.on('error', (e) => console.error('[memory-layer] 可视化端口占用:', e?.message))
  return () => { try { server.close() } catch {} }
}