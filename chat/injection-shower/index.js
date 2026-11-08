// injection-shower：把「每轮真正拼进请求的注入内容」收集起来，Web 上直接看
//
// 抓三个通道：
//   · systemPrompt.context  → 每轮追加到对话末尾的上下文（memory-layer 的【相关记忆】等）
//   · systemPrompt.section  → 进系统提示词开头/中间的段落（tooldesc-control 的重贴等）
//   · agent/inbox/inserted  → 收件箱插消息（token-reporter 的超限提醒、tooldesc-control 的通知）
//
// 只读：不改任何注入内容，只是旁路记录 + 提供 /injection-shower 页面。
import { configFor } from '../../ui/store.js'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const name = 'injection-shower'

// 依赖宿主服务：agents（列已有 agent）+ agentPresets（显示预设名）+ webServer（挂页面）
export const inject = ['agents', 'agentPresets', 'webServer']

const MAX_SESSIONS = 12

const homeDir = () => process.env.DSH_HOME || 'D:\\AI\\DeepseekHarness\\home'
const stateFile = () => join(homeDir(), 'xykp', 'injection-shower', 'state.json')

function loadStore() {
    try {
        const raw = JSON.parse(readFileSync(stateFile(), 'utf8'))
        if (raw && Array.isArray(raw.sessions)) {
            const map = new Map()
            for (const s of raw.sessions) if (s && s.sessionId) map.set(s.sessionId, s)
            return map
        }
    } catch {}
    return new Map()
}

export function apply(ctx, config = {}) {
    config = configFor('injection-shower', config)
    const maxSnapshots = Math.max(1, Number(config.maxSnapshots) || 160)
    const maxNotices = Math.max(1, Number(config.maxNotices) || 30)
    const maxChars = Math.max(200, Number(config.maxChars) || 4000)

    /** sessionId -> { sessionId, preset, updatedAt, snapshots: [], notices: [] } */
    const store = loadStore()
    let saveTimer = null
    function save() {
        if (saveTimer) return
        saveTimer = setTimeout(() => {
            saveTimer = null
            try {
                const p = stateFile()
                mkdirSync(dirname(p), { recursive: true })
                const tmp = p + '.tmp'
                writeFileSync(tmp, JSON.stringify({ sessions: [...store.values()] }), 'utf8')
                renameSync(tmp, p)
            } catch (e) {
                console.warn('[injection-shower] 存盘失败：', e)
            }
        }, 800)
        if (saveTimer.unref) saveTimer.unref()
    }
    /** agent -> 当前轮次号（来自 session/event 的 turn/start），用来和对话里的 turn tail 对齐 */
    const turnOf = new Map()
    /** agent -> { turn, step }：本轮第几次 assemble（≈ 第几个 step），用来把注入按位置归位 */
    const stepOf = new Map()
    const disposers = new Map()

    function clip(text) {
        const s = String(text ?? '')
        return s.length > maxChars ? s.slice(0, maxChars) + `\n…（截断，共 ${s.length} 字）` : s
    }

    /** 和 dsh-system-prompt 的 renderContextSections 保持同一套形状：{ name, text } */
    function renderContexts(assembly) {
        const vars = assembly?.variables || {}
        const out = []
        for (const c of assembly?.contexts || []) {
            let text = typeof c?.text === 'function' ? '' : String(c?.text ?? '')
            if (!text) continue
            if (c.interpolate !== false) {
                text = text.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (m, k) =>
                    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m,
                )
            }
            out.push({ name: String(c.name ?? '?'), length: text.length, text: clip(text) })
        }
        return out
    }

    function renderSections(assembly) {
        const out = []
        for (const s of assembly?.sections || []) {
            const text = String(s?.text ?? '')
            if (!text.trim()) continue
            out.push({ name: String(s.name ?? '?'), order: s.order, length: text.length, text: clip(text) })
        }
        return out
    }

    function stateOf(agent) {
        const sid = String(agent?.sessionId ?? agent?.id ?? 'unknown')
        let st = store.get(sid)
        if (!st) {
            st = {
                sessionId: sid,
                preset: '',
                updatedAt: Date.now(),
                snapshots: [],
                notices: [],
                prefix: null,
                prefixVersions: [],
            }
            store.set(sid, st)
        }
        if (store.size > MAX_SESSIONS) {
            for (const key of store.keys()) {
                if (key === sid) continue
                store.delete(key)
                if (store.size <= MAX_SESSIONS) break
            }
        }
        return st
    }

    function presetOf(agent) {
        try {
            return ctx.agentPresets?.composedPreset?.(agent.ctx) || ''
        } catch {
            return ''
        }
    }

    function recordAssemble(agent, assembly) {
        const st = stateOf(agent)
        st.preset = presetOf(agent) || st.preset
        st.updatedAt = Date.now()
        const turn = turnOf.get(agent) ?? null
        // 每个 step 都会 assemble 一次：按 step 存，不覆盖，才能在对话里按位置显示
        let cur = stepOf.get(agent)
        if (!cur || cur.turn !== turn) {
            cur = { turn, step: 1 }
            stepOf.set(agent, cur)
        } else {
            cur.step += 1
        }
        const step = cur.step
        const last = st.snapshots[st.snapshots.length - 1]
        const prevStep = last && last.turn === turn ? last : null
        const base = prevStep || last || null
        const sections = renderSections(assembly)
        const tools = Array.isArray(assembly?.tools) ? assembly.tools : []
        trackPrefix(st, turn, sections, tools)
        const contexts = renderContexts(assembly)
        // 和上一个 step（本轮第一步则和上一轮最后一步）对比，算出「这一步新注入了什么」
        const baseCtx = new Map(((base && base.contexts) || []).map((c) => [c.name, c.text]))
        const addedContexts = contexts.filter((c) => baseCtx.get(c.name) !== c.text)
        // 一直在、这一步没变的 context 只在第一步露一次（持久层）
        const persistentContexts =
            step === 1 ? contexts.filter((c) => baseCtx.get(c.name) === c.text) : []
        const baseSec = new Map(((base && base.sections) || []).map((s) => [s.name, s.text]))
        const changedSections =
            baseSec.size === 0 ? [] : sections.filter((s) => baseSec.get(s.name) !== s.text)
        // 自上一个 step 之后新插进上下文的消息（持久注入），按时间归到这一步
        const since = base ? Number(base.at) : 0
        const notices = st.notices
            .filter((n) => Number(n.at) > since)
            .map((n) => ({ at: n.at, kind: n.kind || 'notice', text: n.text }))
        const snap = {
            at: Date.now(),
            turn,
            step,
            contexts,
            addedContexts,
            persistentContexts,
            notices,
            sections,
            changedSections,
        }
        st.snapshots.push(snap)
        if (st.snapshots.length > maxSnapshots) st.snapshots.splice(0, st.snapshots.length - maxSnapshots)
        save()
    }

    /** 系统前缀（section + tools）的版本跟踪：变了就记一条，用来定位「谁导致缓存失效」 */
    function trackPrefix(st, turn, sections, tools) {
        const toolSig = tools.map((t) => t.name + ':' + String(t.description ?? '').length).join('|')
        const hash = createHash('sha1')
            .update(sections.map((s) => s.name + '\u0000' + s.text).join('\u0001'))
            .update('\u0002')
            .update(tools.map((t) => t.name + '\u0000' + String(t.description ?? '')).join('\u0001'))
            .digest('hex')
            .slice(0, 12)
        const prev = st.prefix
        if (!prev) {
            st.prefix = {
                hash,
                turn,
                at: Date.now(),
                sectionCount: sections.length,
                toolCount: tools.length,
                toolSig,
                sections: sections.map((s) => ({ name: s.name, length: s.text.length, order: s.order })),
            }
            save()
            return
        }
        if (prev.hash === hash) return
        const prevText = new Map((prev.sections || []).map((s) => [s.name, s.length]))
        const changed = []
        const added = []
        for (const s of sections) {
            if (!prevText.has(s.name)) added.push({ name: s.name, length: s.text.length })
            else if (prevText.get(s.name) !== s.text.length) changed.push({ name: s.name, length: s.text.length, was: prevText.get(s.name) })
        }
        const removed = [...prevText.keys()].filter((name) => !sections.some((s) => s.name === name))
        st.prefixVersions.push({
            at: Date.now(),
            turn,
            hash,
            prevHash: prev.hash,
            sectionCount: sections.length,
            toolCount: tools.length,
            toolsChanged: prev.toolSig !== toolSig,
            changed,
            added,
            removed,
        })
        if (st.prefixVersions.length > 30) st.prefixVersions.splice(0, st.prefixVersions.length - 30)
        st.prefix = {
            hash,
            turn,
            at: Date.now(),
            sectionCount: sections.length,
            toolCount: tools.length,
            toolSig,
            sections: sections.map((s) => ({ name: s.name, length: s.text.length, order: s.order })),
        }
        save()
    }

    function recordNotice(agent, text, kind) {
        if (!text) return
        const st = stateOf(agent)
        st.preset = presetOf(agent) || st.preset
        st.updatedAt = Date.now()
        st.notices.push({
            at: Date.now(),
            turn: turnOf.get(agent) ?? null,
            step: stepOf.get(agent)?.step ?? null,
            kind: kind || 'notice',
            text: clip(text),
        })
        if (st.notices.length > maxNotices) st.notices.splice(0, st.notices.length - maxNotices)
        save()
    }

    function textOfMessage(message) {
        const content = message?.content
        if (typeof content === 'string') return content
        if (Array.isArray(content)) {
            return content
                .map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? String(b.text ?? '') : ''))
                .filter(Boolean)
                .join('\n')
        }
        return ''
    }

    function watch(agent) {
        if (!agent?.ctx) return
        const offs = []
        offs.push(
            agent.ctx.on('system-prompt/assemble', async (assembly, context, next) => {
                const out = await next()
                try {
                    recordAssemble(context?.agent || agent, out || assembly)
                } catch (e) {
                    console.warn('[injection-shower] assemble 记录失败：', e)
                }
                return out
            }),
        )
        offs.push(
            agent.ctx.on('session/event', (_subject, event) => {
                try {
                    if (event?.type === 'turn/start' && typeof event?.data?.turn === 'number') {
                        turnOf.set(agent, event.data.turn)
                    }
                    // developer 消息（工具表增删这类宿主提示）也算一种历史消息
                    if (event?.type === 'developer/message') {
                        const content = event?.data?.message?.content ?? event?.data?.content
                        const text = Array.isArray(content)
                            ? content
                                  .map((b) =>
                                      b?.type === 'tool-addition'
                                          ? '➕ 工具 ' + b.toolName
                                          : b?.type === 'tool-removal'
                                            ? '➖ 工具 ' + b.toolName
                                            : typeof b === 'string'
                                              ? b
                                              : String(b?.text ?? ''),
                                  )
                                  .filter(Boolean)
                                  .join('\n')
                            : String(content ?? '')
                        if (text) recordNotice(agent, '[developer] ' + text)
                    }
                } catch {}
            }),
        )
        offs.push(
            agent.ctx.on('agent/inbox/inserted', (payload) => {
                try {
                    const who = payload?.agent || agent
                    const list = payload?.messages || payload?.inserted || (payload?.message ? [payload.message] : [])
                    const msgs = (Array.isArray(list) ? list : [list]).filter((m) => {
                        const k = m && m.source && m.source.kind
                        return k !== 'user' && k !== 'model' && k !== 'tool'
                    })
                    if (!msgs.length) return
                    const text = msgs.map(textOfMessage).filter(Boolean).join('\n')
                    const kind = (msgs[0] && msgs[0].source && msgs[0].source.kind) || 'notice'
                    recordNotice(who, text, kind)
                } catch (e) {
                    console.warn('[injection-shower] notice 记录失败：', e)
                }
            }),
        )
        disposers.set(agent, () => offs.forEach((off) => { try { off() } catch {} }))
    }

    ctx.on('agent/created', ({ agent }) => watch(agent))
    try {
        for (const agent of ctx.agents.list()) watch(agent)
    } catch (e) {
        console.warn('[injection-shower] 列已有 agent 失败：', e)
    }
    ctx.on('dispose', () => {
        for (const off of disposers.values()) off()
        disposers.clear()
        store.clear()
    })

    if (ctx.webServer && typeof ctx.webServer.register === 'function') {
        ctx.effect(() =>
            ctx.webServer.register({
                kind: 'prefix',
                path: '/injection-shower',
                handler: async (req, res) => {
                    const url = new URL(req.url || '/injection-shower', 'http://127.0.0.1')
                    if (url.pathname === '/injection-shower/state') {
                        const full = url.searchParams.get('full') === '1'
                        const sessions = [...store.values()].sort((a, b) => b.updatedAt - a.updatedAt)
                        // 轮询（对话里的注入行）只要单次/持久/变化，不需要整份 sections 和累计 contexts，
                        // 否则每 3 秒拉几百 KB；调试页面用 ?full=1 拿全量。
                        const lists = full
                            ? sessions
                            : sessions.map((s) => ({
                                  ...s,
                                  snapshots: (s.snapshots || []).map((snap, i, arr) => {
                                      const { sections, contexts, ...rest } = snap
                                      // 悬浮的系统提示词面板展开时要看「最新一步」的 sections 全文，历史步不需要
                                      return i === arr.length - 1 ? { ...rest, sections } : rest
                                  }),
                              }))
                        const payload = { ok: true, now: Date.now(), sessions: lists }
                        res.writeHead(200, {
                            'content-type': 'application/json; charset=utf-8',
                            'cache-control': 'no-store',
                        })
                        res.end(JSON.stringify(payload))
                        return
                    }
                    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
                    res.end(PAGE)
                },
            }),
        )
    }
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>注入查看器 · dsh</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;padding:20px 24px;background:#16181d;color:#e6e6e6;font:14px/1.6 system-ui,"Segoe UI",sans-serif}
  h1{font-size:18px;margin:0 0 4px}
  .sub{color:#8b93a1;font-size:12px;margin-bottom:18px}
  .session{border:1px solid #2b2f38;border-radius:10px;padding:14px 16px;margin-bottom:16px;background:#1b1e24}
  .sid{font-family:ui-monospace,monospace;font-size:12px;color:#9aa4b2}
  .badge{display:inline-block;background:#2a3140;border-radius:6px;padding:1px 7px;margin-left:6px;font-size:12px;color:#b9c2d0}
  details{margin-top:10px;border-top:1px solid #262a33;padding-top:8px}
  summary{cursor:pointer;color:#9aa4b2;font-size:12px}
  .block{margin:10px 0 0}
  .name{font-size:12px;color:#7fd1a8;font-family:ui-monospace,monospace}
  pre{margin:6px 0 0;padding:10px 12px;background:#12141a;border:1px solid #262a33;border-radius:8px;
      white-space:pre-wrap;word-break:break-word;font:12px/1.55 ui-monospace,monospace;color:#cfd6e2;max-height:420px;overflow:auto}
  .notice{background:#1f2230;border-left:3px solid #c8a24a;padding:8px 12px;border-radius:6px;margin-top:8px;white-space:pre-wrap}
  .empty{color:#8b93a1}
  .tag{font-size:11px;color:#8b93a1;margin-left:8px}
</style></head>
<body>
<h1>注入查看器</h1>
<div class="sub">每 2 秒刷新 · 只读旁路，不改任何注入内容 · <span id="clock"></span></div>
<div id="root" class="empty">加载中…</div>
<script>
const root = document.getElementById('root')
const clock = document.getElementById('clock')
const fmt = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false })

function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

function block(title, text, tag) {
  const wrap = el('div', 'block')
  const name = el('div', 'name', title)
  if (tag) name.appendChild(el('span', 'tag', tag))
  wrap.appendChild(name)
  wrap.appendChild(el('pre', '', text))
  return wrap
}

function render(data) {
  root.textContent = ''
  root.className = ''
  const sessions = data.sessions || []
  if (!sessions.length) {
    root.className = 'empty'
    root.textContent = '还没有采集到注入 —— 在当前会话里发一句话（或等下一轮），这里就会冒出来。'
    return
  }
  for (const s of sessions) {
    const card = el('div', 'session')
    const head = el('div')
    const name = el('strong', '', s.preset || '未命名预设')
    head.appendChild(name)
    head.appendChild(el('span', 'badge', s.sessionId.slice(-12)))
    head.appendChild(el('span', 'tag', '最近 ' + fmt(s.updatedAt)))
    card.appendChild(head)

    if (s.notices && s.notices.length) {
      const d = el('details')
      d.appendChild(el('summary', '', '收件箱通知（' + s.notices.length + '）'))
      for (const n of s.notices.slice().reverse().slice(0, 10)) {
        d.appendChild(el('div', 'notice', '[' + fmt(n.at) + ']\\n' + n.text))
      }
      card.appendChild(d)
    }

    const snaps = (s.snapshots || []).slice().reverse()
    for (let i = 0; i < snaps.length; i++) {
      const snap = snaps[i]
      const d = el('details')
      if (i === 0) d.open = true
      const ctxCount = (snap.contexts || []).length
      const secCount = (snap.sections || []).length
      d.appendChild(el('summary', '', fmt(snap.at) + ' · 第 ' + (snap.step ?? '?') + ' 步 · 单次 ' + ((snap.addedContexts || []).length) + ' 段 / 系统提示词 ' + secCount + ' 段'))
      for (const c of snap.contexts || []) d.appendChild(block('context: ' + c.name, c.text, c.length + ' 字'))
      for (const c of snap.sections || []) d.appendChild(block('section: ' + c.name, c.text, c.length + ' 字'))
      if (!ctxCount && !secCount) d.appendChild(el('div', 'empty', '这一步没有任何注入'))
      card.appendChild(d)
    }
    root.appendChild(card)
  }
}

async function tick() {
  try {
    const r = await fetch('/injection-shower/state?full=1', { cache: 'no-store' })
    const d = await r.json()
    clock.textContent = '更新于 ' + fmt(d.now || Date.now())
    render(d)
  } catch (e) {
    root.className = 'empty'
    root.textContent = '读取失败：' + e
  }
}
tick()
setInterval(tick, 2000)
</script>
</body></html>`



