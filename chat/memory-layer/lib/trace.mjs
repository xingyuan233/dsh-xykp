import { clamp01 } from './util.mjs'

/**
 * 短期 + 长期双通道的痕迹。
 *
 *   短期 short：按【回合】衰减，像化学递质，产生快、作用快、消散也快
 *   长期 long ：印痕深度，不自己衰减；当前可用 = long * exp(-Δ天 / S)
 *   取值 = short + long * timeWeight * (1 - short)
 *         短期说了算，短期落回 0 的时候底下还垫着一层长期，不会直接归零
 *
 * 长期只在【新的一天第一次提到】时增长，同一天反复提不给长期增益。
 * 连续第 n 天再乘 0.6^(n-1) —— 连着天天提那是在过日子，不是记事情。
 * mask 存近 8 天哪几天提过（bit0 = 最近一天）。
 */
export const TRACE = {
  // 概念：递质，快起快落，长期只当地板
  cm: {
    sInit: 1, sGrow: 1.6, sMax: 90, alpha: 1.6,
    shortDecay: 0.5, shortGain: 0.6, gainLogK: 0.1,
    longGain: 0.10, timeWeight: 0.35,
  },
  // 概念↔事件：突触，短期难改，长期才动；但刚长出来的要单独照顾
  // ce 单通道：只按【天】。要按回合就得每轮重排整个数组，不现实
  ce: {
    noShort: true, alpha: 2.0,
    sInit: 1, sGrow: 2.0, sMax: 720,
    longGain: 0.3,
  },
  // 概念↔概念：轮占大头，时间占小头
  cc: {
    sInit: 3, sGrow: 1.4, sMax: 365, alpha: 1.4,
    shortDecay: 0.66, shortGain: 0.5, gainLogK: 0.15,
    longGain: 0.12, timeWeight: 0.25,
  },
}

const popcount = (x) => {
  let n = 0
  while (x) { n += x & 1; x >>>= 1 }
  return n
}

const trailingOnes = (x) => {
  let n = 0
  while ((x >>> n) & 1) n++
  return n
}

export class Trace {
  constructor(kind, init = 0) {
    const p = TRACE[kind]
    if (!p) throw new Error(`未知的 trace 类型: ${kind}`)
    this.kind = kind
    this.p = p
    this.short = 0
    this.long = init
    this.S = p.sInit
    this.count = 0
    this.lastTurn = null
    this.lastAt = null
    this.mask = 0
    this.maskDay = null
  }

  /** 每回合剩多少（ce 刚长出来时掉得快，成熟后难改） */
  turnDecay() {
    const p = this.p
    return p.noShort ? 1 : p.shortDecay
  }

  /** 当前值 0-1 */
  value(turn, at) {
    const dtTurn = this.lastTurn == null ? 0 : Math.max(0, turn - this.lastTurn)
    const s = this.short * Math.pow(this.turnDecay(), dtTurn)
    const dtDay = this.lastAt == null ? 0 : Math.max(0, at - this.lastAt)
    // 幂律长尾：exp 会真的衰减到 0，幂律不会。忘了只是断开，不是抹掉
    const l = this.long * Math.pow(1 + dtDay / Math.max(this.S, 0.25), -this.p.alpha)
    if (this.p.noShort) return clamp01(l)
    return clamp01(s + l * this.p.timeWeight * (1 - s))
  }

  /** 直接落一个初值（写入时用，不算一次提及） */
  seed(v, turn, at) {
    this.long = clamp01(v)
    this.short = 0
    this.S = this.p.sInit
    this.count = 1
    this.lastTurn = turn
    this.lastAt = at
    this.maskDay = Math.floor(at)
    this.mask = 1
    return this
  }

  /** 被提及一次 */
  touch(turn, at) {
    const p = this.p
    const sameDay = this.lastAt != null && Math.floor(at) === Math.floor(this.lastAt)
    this._roll(at)
    const streak = trailingOnes(this.mask >> 1)   // 从昨天起连续几天提过（bit0 是今天，还没置位）

    // 短期：先推到此刻，再往上加（低的时候容易升，越高越难推）
    const dtTurn = this.lastTurn == null ? 0 : Math.max(0, turn - this.lastTurn)
    this.short *= Math.pow(this.turnDecay(), dtTurn)
    if (!p.noShort) {
      const gainShort = p.shortGain * (1 - this.short) / (1 + p.gainLogK * Math.max(0, this.count - 1))
      this.short = clamp01(this.short + gainShort)
    }

    // 长期：同一天重复提不算，连续天天提还要打折
    if (!sameDay) {
      const mult = Math.pow(0.6, streak)
      this.long = clamp01(this.long + p.longGain * mult * (1 - this.long))
      this.S = Math.min(p.sMax, Math.max(this.S, 0.5) * p.sGrow)
    }

    this.count++
    this.lastTurn = turn
    this.lastAt = at
    this.mask = (this.mask | 1) & 0xff
    return this
  }

  /** 按天滚动 bitset，bit0 永远是最新一天 */
  _roll(at) {
    const day = Math.floor(at)
    if (this.maskDay == null) { this.maskDay = day; return }
    const d = day - this.maskDay
    if (d <= 0) return
    this.mask = d >= 8 ? 0 : (this.mask << d) & 0xff
    this.maskDay = day
  }

  get days() {
    return popcount(this.mask)
  }

  toJSON() {
    return {
      k: this.kind, s: this.short, l: this.long, S: this.S,
      c: this.count, t: this.lastTurn, a: this.lastAt,
      m: this.mask, md: this.maskDay,
    }
  }

  static fromJSON(j) {
    const t = new Trace(j.k, j.l ?? 0)
    t.short = j.s ?? 0
    t.S = j.S ?? t.p.sInit
    t.count = j.c ?? 0
    t.lastTurn = j.t ?? null
    t.lastAt = j.a ?? null
    t.mask = j.m ?? 0
    t.maskDay = j.md ?? null
    return t
  }
}
