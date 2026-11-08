import { PARAMS } from './const.mjs'
import { normalizeKey, gramsOf, queryGrams } from './key.mjs'
import { Concept, ConceptEdge, EvLink, Event } from './types.mjs'
import { Trace } from './trace.mjs'
import { clamp01, insertSorted, bubbleUp, DAY } from './util.mjs'

const round3 = (x) => Math.round(x * 1000) / 1000
// 四个均匀分布求和近似正态，均值 0，标准差约 0.58
const gauss = () => (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 1.7
const loadTrace = (j, kind) => (j ? Trace.fromJSON(j) : new Trace(kind, 0))

export class MemoryLayer {
  constructor(params = {}) {
    this.p = { ...PARAMS, ...params }

    this.concepts = new Map()   // id -> Concept
    this.byKey = new Map()      // key -> Concept
    this.events = new Map()     // id -> Event
    this.edgeIndex = new Map()  // "a:b" -> ConceptEdge

    this.gramIndex = new Map()  // gram -> conceptId[]

    // 本轮走过的边先攒着，等这一轮结束（nextTurn）再统一结算：
    // 被命中的算 used，其余算 miss。不在这里边判定，否则会结算两次
    this.pending = []
    this._hitKeys = new Set()
    this.turn = 0               // 当前回合序号，冷却和 cm/cc 的短期项靠它
    this._cid = 0
    this._eid = 0
  }

  now() {
    return Date.now() / DAY
  }

  /** 每轮注入前调一次 */
  nextTurn() {
    this.settle()
    return ++this.turn
  }

  /** 把这一轮走过的边结算掉 */
  settle() {
    for (const [e, from] of this.pending) {
      this.passEdge(e, from, this._hitKeys.has(`${e.a}:${e.b}:${from}`))
    }
    this.pending = []
    this._hitKeys = new Set()
  }

  // ============ 写入 ============

  concept(key) {
    const k = normalizeKey(key)
    if (!k) return null
    let c = this.byKey.get(k)
    if (c) return c
    const grams = gramsOf(k)
    c = new Concept(++this._cid, k, grams.length)
    this.byKey.set(k, c)
    this.concepts.set(c.id, c)
    for (const g of grams) {
      let list = this.gramIndex.get(g)
      if (!list) this.gramIndex.set(g, (list = []))
      list.push(c.id)
    }
    return c
  }

  addEvent(input) {
    const now = input.now ?? this.now()
    const at = input.at ?? now
    const ev = new Event(++this._eid, input.brief, input.detail ?? null, at, clamp01(input.importance ?? 0.5))
    this.events.set(ev.id, ev)

    const touched = []
    for (const ref of input.concepts ?? []) {
      const c = this.concept(ref.key)
      if (!c) continue
      let link = c.evs.find((l) => l.ev === ev)
      if (!link) {
        const init = this.p.CE_INIT_MIN + this.p.CE_INIT_SPAN * clamp01(ref.match ?? 0.8)
        link = new EvLink(ev, init, input.src ?? 0)
        link.cid = c.id
        link.ce.seed(init, this.turn, now)
        insertSorted(c.evs, link, (x) => x.w)
        ev.refs.push(link)
      }
      c.cm.touch(this.turn, now)   // 概念是「现在被提到」的
      touched.push({ c, ce: link.ce.long })
    }

    if (input.cooccur !== false) {
      for (let i = 0; i < touched.length; i++) {
        for (let j = i + 1; j < touched.length; j++) {
          this.linkConcepts(touched[i].c, touched[j].c, touched[i].ce, touched[j].ce)
        }
      }
    }
    return ev
  }

  /**
   * 概念↔概念建边。共现只能说明「有个机会」，置信度很低：
   * 两个词跟这条事件的关联度越接近，越可能是一层的东西，所以初值按差值来；
   * 再各自摇一次正态噪声 —— 两个方向独立摇，所以一开始就微微不对称。
   */
  linkConcepts(a, b, ceA = 0.5, ceB = 0.5) {
    if (!a || !b || a === b) return null
    const [x, y] = a.id < b.id ? [a, b] : [b, a]
    const k = `${x.id}:${y.id}`
    const diff = Math.abs(ceA - ceB)
    const base = Math.max(0, this.p.EDGE_INIT_BASE * (1 - this.p.EDGE_INIT_K * diff))

    let e = this.edgeIndex.get(k)
    if (e) {
      // 已经建过的：共现次数越多越可信，但增益按 1/次数 递减（相当于对数增长），不锁上限
      e.count++
      const gain = this.p.COOC_ETA / e.count
      e.addFrom(e.a, gain * (1 - e.wAB), this.p.EDGE_W_MIN)
      e.addFrom(e.b, gain * (1 - e.wBA), this.p.EDGE_W_MIN)
    } else {
      // 新建立的：按公式算出来直接写，不做任何缩小
      const w1 = Math.max(this.p.EDGE_W_MIN, clamp01(base + gauss() * this.p.EDGE_INIT_SIGMA))
      const w2 = Math.max(this.p.EDGE_W_MIN, clamp01(base + gauss() * this.p.EDGE_INIT_SIGMA))
      e = new ConceptEdge(x.id, y.id, w1, w2, 0)
      this.edgeIndex.set(k, e)
      insertSorted(x.edges, e, (z) => z.w)
      insertSorted(y.edges, e, (z) => z.w)
    }
    return e
  }

  /**
   * 边被走过：掉一点。试过没对上也算 —— 试过本身就是信息。
   * 走出来的东西真被用上了再回血。
   */
  passEdge(edge, from, used = false) {
    if (!edge) return
    edge.pass++
    const cur = edge.wFrom(from)
    if (used) {
      edge.hit++
      // 命中次数越多，边际越小；但一次命中胜过很多次共现
      const gain = this.p.EDGE_HIT_GAIN / Math.sqrt(edge.hit)
      edge.addFrom(from, gain * (1 - cur), 0)
    } else {
      edge.miss++
      edge.addFrom(from, -(1 - this.p.EDGE_PASS_DECAY) * cur, 0)
    }
    // 两个方向都掉到没意义了，这条边就别占地方了
    if (edge.wAB + edge.wBA < this.p.EDGE_W_MIN) { this.removeEdge(edge); return }
    for (const cid of [edge.a, edge.b]) {
      const c = this.concepts.get(cid)
      if (!c) continue
      const i = c.edges.indexOf(edge)
      if (i > 0) bubbleUp(c.edges, i, (z) => z.w)
    }
  }

  // ============ 检索 ============

  retrieve(text, opts = {}) {
    const now = opts.now ?? this.now()
    const turn = this.turn
    if (!text || !this.events.size) return []

    // 1. bigram 倒排找候选，全中才算
    const counts = new Map()
    for (const g of queryGrams(text)) {
      const list = this.gramIndex.get(g)
      if (!list) continue
      for (const cid of list) counts.set(cid, (counts.get(cid) ?? 0) + 1)
    }

    const seeds = []
    for (const [cid, n] of counts) {
      const c = this.concepts.get(cid)
      if (n !== c.gramCount) continue
      const cm = c.cm.value(turn, now)
      if (cm < this.p.CM_FLOOR) continue
      seeds.push({ c, cm, chain: 1 })   // chain = 途经的 cc 连乘，种子恒为 1
    }
    // cm 不需要排序 —— 文本直接命中谁就是谁，各自都有概率
    const topSeeds = seeds

    // 2. 扩散（还没实现）：已经当过一次起点的概念不能再出发
    const visited = new Set(topSeeds.map((s) => s.c.id))
    const spread = this.expand(topSeeds, turn, now, visited)
    const all = topSeeds.concat(spread)

    // 3. 每个概念往下扫自己的 evs，按长期值降序，够数就 break
    //    同一个事件被多个概念命中只留一份，取综合关联度最高的那条
    const acc = new Map()
    for (const seed of all) {
      const c = seed.c
      let taken = 0
      for (const l of c.evs) {
        const ce = l.ce.value(turn, now)
        if (ce < this.p.W_MIN) break
        const gain = seed.cm * ce      // seed.cm 里已经含了途经各条 cc
        let h = acc.get(l.ev.id)
        if (!h) acc.set(l.ev.id, (h = { ev: l.ev, best: -1, bestVia: null, bestPath: null, via: [] }))
        const path = { key: c.key, cm: round3(seed.cm), ce: round3(ce), chain: round3(seed.chain) }
        h.via.push(path)
        if (gain > h.best) {
          h.best = gain
          h.bestVia = path
          h.bestPath = seed.path
        }
        if (++taken >= this.p.EV_PER_CONCEPT) break
      }
    }

    // 4. 冷却 + 预算
    const out = []
    for (const h of acc.values()) {
      const e = h.ev
      if (e.forgotten) continue
      if (e.pushedTurn != null) {
        const cd = this.p.COOLDOWN_TURNS * (1 + this.p.COOLDOWN_W_K * (h.bestVia?.ce ?? 0))
        if (turn - e.pushedTurn < cd) continue
      }
      const s = h.best * (0.85 + 0.15 * clamp01(e.importance))
      out.push({ event: e, score: s, via: h.via, best: h.bestVia, path: h.bestPath })
    }
    out.sort((x, y) => y.score - x.score)

    const budget = opts.eventBudget ?? this.p.EVENT_BUDGET
    const charBudget = opts.charBudget ?? this.p.CHAR_BUDGET
    const picked = []
    let chars = 0
    for (const r of out) {
      if (picked.length >= budget) break
      const len = r.event.brief.length
      if (chars + len > charBudget && picked.length > 0) continue
      picked.push(r)
      chars += len
    }
    return picked
  }

  /**
   * 扩散钩子。默认不扩散。
   * 走法：从种子出发沿 edges 走，每跳乘 HOP_DISCOUNT，扇出截断 HOP_FANOUT，
   * 激活值低于 HOP_THRESHOLD 就停；出发前查 visited，走过的概念不再出发。
   * 返回 { c, cm, chain }，chain = 途经各条边的 w 连乘。
   * 每走一条边都要 passEdge(edge, used)，use 与否等下一轮反馈再补记。
   */
  expand(seeds, _turn, _now, visited) {
    const p = this.p
    const out = []
    for (const s of seeds) if (!s.path) s.path = []
    let frontier = seeds
    for (let hop = 0; hop < p.HOP_MAX && frontier.length; hop++) {
      const next = []
      const walked = []
      for (const node of frontier) {
        // 想从这条路继续，至少得让 act 过阈值 —— 反推出 cc 的下限
        // 边是按 w 降序的，一旦低于下限，后面全都不用看
        const minCC = p.HOP_THRESHOLD / Math.max(node.cm, 1e-9)
        let fan = 0
        for (const e of node.c.edges) {
          const cw = e.wFrom(node.c.id)
          if (cw < minCC) break
          if (fan >= p.HOP_FANOUT) break
          fan++
          walked.push([e, node.c.id])
          const other = this.concepts.get(e.other(node.c.id))
          if (!other) continue
          const act = node.cm * cw * p.HOP_DISCOUNT
          if (act < p.HOP_THRESHOLD) continue
          if (visited.has(other.id)) continue   // 池里已经有了就不重复计
          visited.add(other.id)
          const s = { c: other, cm: act, chain: node.chain * cw, from: node.c.id,
            path: node.path.concat([[e, node.c.id]]) }
          out.push(s)
          next.push(s)
        }
      }
      // 走完了再动权，别在遍历中改数组
      for (const [e, from] of walked) this.pending.push([e, from])
      frontier = next
    }
    return out
  }

  /** 推出去之后标一下，冷却从这一回合开始算 */
  markPushed(rows, turn = this.turn) {
    for (const r of rows) r.event.pushedTurn = turn
  }

  /**
   * 反馈：推送出去之后，看下一轮有没有真的用到。
   * 事件本来就是由概念触发的，所以直接搜概念 ——「下一轮文本里出现了这条事件的任意一个关键词」就算命中。
   * 命中只做两件事：把走过的边记成 used（等 nextTurn 结算），概念 cm 回涨。
   * 绝不新建 ce —— 那是写入时定死的，不能靠联想补。
   */
  feedback(rows, nextText) {
    if (!rows?.length || !nextText) return null
    const hitCids = this.matchConcepts(nextText)
    const now = this.now()
    const report = { hit: 0, miss: 0, concepts: [] }
    for (const r of rows) {
      const cids = (r.event.refs ?? []).map((l) => l.cid)
      const hit = cids.some((id) => hitCids.has(id))
      if (hit) {
        report.hit++
        for (const [e, from] of r.path ?? []) {
          this._hitKeys.add(`${e.a}:${e.b}:${from}`)
        }
        for (const id of cids) {
          const c = this.concepts.get(id)
          if (c) { c.cm.touch(this.turn, now); report.concepts.push(c.key) }
        }
      } else {
        report.miss++
      }
    }
    return report
  }

  /** 文本命中了哪些概念（全 gram 命中才算） */
  matchConcepts(text) {
    const out = new Set()
    const counts = new Map()
    for (const g of queryGrams(text)) {
      const list = this.gramIndex.get(g)
      if (!list) continue
      for (const cid of list) counts.set(cid, (counts.get(cid) ?? 0) + 1)
    }
    for (const [cid, n] of counts) {
      const c = this.concepts.get(cid)
      if (c && n === c.gramCount) out.add(cid)
    }
    return out
  }

  // ============ 清空 / 取回 ============

  forget(eventId) {
    const ev = this.events.get(eventId)
    if (!ev) return false
    ev.forgotten = true
    const cs = new Set()
    for (const l of ev.refs) {
      l.ce.long = 0
      l.ce.short = 0
      const c = this.concepts.get(l.cid)
      if (c) cs.add(c)
    }
    for (const c of cs) c.evs.sort((x, y) => y.w - x.w)
    return true
  }

  /** 真删：事件和它所有的 ce 边一起消失（测试残留、记错的就用这个） */
  deleteEvent(eventId) {
    const ev = this.events.get(eventId)
    if (!ev) return false
    const touched = new Set()
    for (const l of ev.refs) {
      const c = this.concepts.get(l.cid)
      if (!c) continue
      c.evs = c.evs.filter((x) => x !== l)
      touched.add(c)
    }
    this.events.delete(eventId)
    // 删完顺手把变成空壳的概念和它的边一起收掉
    for (const c of touched) if (c.df === 0) this.pruneConcept(c)
    return true
  }

  removeEdge(edge) {
    if (!edge) return
    this.edgeIndex.delete(`${edge.a}:${edge.b}`)
    for (const cid of [edge.a, edge.b]) {
      const c = this.concepts.get(cid)
      if (c) c.edges = c.edges.filter((x) => x !== edge)
    }
  }

  /** 从一个概念身上摘掉所有边，再从索引里删除它 */
  pruneConcept(c) {
    for (const e of [...c.edges]) this.removeEdge(e)
    this.concepts.delete(c.id)
    this.byKey.delete(c.key)
    for (const g of gramsOf(c.key)) {
      const list = this.gramIndex.get(g)
      if (!list) continue
      const i = list.indexOf(c.id)
      if (i >= 0) list.splice(i, 1)
    }
  }

  /** 瘦身：删已忘记的事件、没有活事件的概念、以及悬空的边 */
  compact() {
    let events = 0
    for (const id of [...this.events.keys()]) {
      if (this.events.get(id)?.forgotten) { this.deleteEvent(id); events++ }
    }
    let concepts = 0
    for (const c of [...this.concepts.values()]) {
      if (c.df > 0) continue
      this.pruneConcept(c)
      concepts++
    }
    return { events, concepts }
  }

  /** 按 id 取完整经过；取回 = 想起来，各概念名下那份 ce 都要回血 */
  recall(eventId, now = this.now()) {
    const ev = this.events.get(eventId)
    if (!ev || ev.forgotten) return null
    ev.recalled++
    for (const l of ev.refs) {
      l.ce.touch(this.turn, now)
      const c = this.concepts.get(l.cid)
      if (c) c.cm.touch(this.turn, now)
    }
    return ev
  }

  // ============ 统计 / 存取 ============

  stats() {
    const cs = [...this.concepts.values()]
    const byDf = [...cs].sort((a, b) => b.df - a.df)
    return {
      concepts: cs.length,
      events: [...this.events.values()].filter((e) => !e.forgotten).length,
      edges: this.edgeIndex.size,
      postings: cs.reduce((n, c) => n + c.df, 0),
      isolated: cs.filter((c) => c.df === 0).length,
      top: byDf.slice(0, 12).map((c) => `${c.key}(${c.df})`),
    }
  }

  toJSON() {
    return {
      version: 2,
      params: this.p,
      turn: this.turn,
      cid: this._cid,
      eid: this._eid,
      events: [...this.events.values()].map((e) => ({
        id: e.id, brief: e.brief, detail: e.detail, at: e.at,
        importance: e.importance, pushedTurn: e.pushedTurn,
        recalled: e.recalled, forgotten: e.forgotten,
      })),
      concepts: [...this.concepts.values()].map((c) => ({
        id: c.id, key: c.key, cm: c.cm.toJSON(),
        evs: c.evs.map((l) => [l.ev.id, l.ce.toJSON(), l.src, l.flags]),
        edges: c.edges.filter((e) => e.a === c.id)
          .map((e) => [e.a, e.b, e.wAB, e.wBA, e.count, e.pass, e.hit, e.miss, e.src, e.flags]),
      })),
    }
  }

  static fromJSON(json) {
    const layer = new MemoryLayer(json.params ?? {})
    layer.turn = json.turn ?? 0
    layer._cid = json.cid ?? 0
    layer._eid = json.eid ?? 0

    for (const e of json.events ?? []) {
      const ev = new Event(e.id, e.brief, e.detail, e.at, e.importance)
      ev.pushedTurn = e.pushedTurn ?? null
      ev.recalled = e.recalled ?? 0
      ev.forgotten = e.forgotten ?? false
      layer.events.set(ev.id, ev)
    }
    for (const c of json.concepts ?? []) {
      const grams = gramsOf(c.key)
      const nc = new Concept(c.id, c.key, grams.length)
      nc.cm = loadTrace(c.cm, 'cm')
      layer.concepts.set(nc.id, nc)
      layer.byKey.set(nc.key, nc)
      for (const g of grams) {
        let list = layer.gramIndex.get(g)
        if (!list) layer.gramIndex.set(g, (list = []))
        list.push(nc.id)
      }
    }
    for (const c of json.concepts ?? []) {
      const nc = layer.concepts.get(c.id)
      for (const row of c.evs ?? []) {
        const [eid, ce, src, flags] = row
        const ev = layer.events.get(eid)
        if (!ev) continue
        const l = new EvLink(ev, 0, src)
        l.cid = nc.id
        l.ce = loadTrace(ce, 'ce')
        l.flags = flags ?? 0
        nc.evs.push(l)
        ev.refs.push(l)
      }
      for (const row of c.edges ?? []) {
        const [a, b, wAB, wBA, count, pass, hit, miss, src, flags] = row
        const k = `${a}:${b}`
        if (layer.edgeIndex.has(k)) continue
        const e = new ConceptEdge(a, b, wAB, wBA, src)
        e.count = count; e.pass = pass ?? 0; e.hit = hit ?? 0; e.miss = miss ?? 0
        e.flags = flags ?? 0
        layer.edgeIndex.set(k, e)
        layer.concepts.get(a)?.edges.push(e)
        layer.concepts.get(b)?.edges.push(e)
      }
    }
    for (const c of layer.concepts.values()) {
      c.evs.sort((x, y) => y.w - x.w)
      c.edges.sort((x, y) => y.w - x.w)
    }
    return layer
  }
}