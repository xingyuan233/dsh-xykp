import { Trace } from './trace.mjs'
import { clamp01 } from './util.mjs'

/** 概念节点：一个「关键词」在记忆里的存在。自身值是 cm（递质） */
export class Concept {
  constructor(id, key, gramCount) {
    this.id = id
    this.key = key
    this.gramCount = gramCount   // 检索时判定「全中」用，建的时候算一次

    this.cm = new Trace('cm')    // 概念自身：短期按回合、长期按天
    this.evs = []                // EvLink[]，按长期值降序，独享
    this.edges = []              // ConceptEdge[]，和对端共享同一个对象
  }

  /** 还挂着的活事件数（忘掉的不算） */
  get df() {
    let n = 0
    for (const l of this.evs) if (!l.ev.forgotten) n++
    return n
  }
}

/**
 * 概念私有的「事件记忆」。
 * 同一个事件在不同概念名下各有一份，参数互不影响 —— 草莓 0.8、妹妹 0.5 就是这么来的。
 * ce 单通道、只按天：要按回合就得每轮重排整个数组，不现实。
 */
export class EvLink {
  constructor(ev, match, src = 0) {
    this.ev = ev
    this.cid = 0                        // 我属于哪个概念（维护用，落盘时由所属概念反推）
    this.ce = new Trace('ce', clamp01(match))
    this.src = src
    this.flags = 0
  }

  /** 排序键：长期印痕深度，只在被提及 / 每天整理时才变 */
  get w() {
    return this.ce.long
  }
}

/**
 * 概念↔概念，两端引用同一个对象。a < b 只保证唯一。
 * 不存时间、不算 exp：只有一个值，走过才变。所以排序永远是对的。
 */
export class ConceptEdge {
  constructor(a, b, wAB, wBA = wAB, src = 0) {
    this.a = a
    this.b = b
    this.wAB = wAB     // a -> b 的强度
    this.wBA = wBA     // b -> a 的强度，独立
    this.count = 1     // 共现次数
    this.pass = 0      // 被走过几次（两个方向合计）
    this.hit = 0       // 走过去的东西真被用上了几次
    this.miss = 0
    this.src = src
    this.flags = 0
  }

  other(id) {
    return this.a === id ? this.b : this.a
  }

  /** 从 from 出发走这条边，看到的是哪个方向的强度 */
  wFrom(from) {
    return from === this.a ? this.wAB : this.wBA
  }

  addFrom(from, delta, min = 0) {
    if (from === this.a) this.wAB = Math.max(min, this.wAB + delta)
    else this.wBA = Math.max(min, this.wBA + delta)
  }

  /** 排序键：两个方向取大的，保证节点自己的边表大致有序 */
  get w() {
    return Math.max(this.wAB, this.wBA)
  }
}

/** 事件本体，独立存在。自己不带激活度，衰减全由各概念名下的 ce 承担 */
export class Event {
  constructor(id, brief, detail, at, importance) {
    this.id = id
    this.brief = brief
    this.detail = detail            // { type: 'text'|'path'|'web', value: string }
    this.at = at                    // 事情发生的时间，只用于展示
    this.importance = importance
    this.pushedTurn = null          // 上次被推出去是第几回合（冷却按回合算）
    this.recalled = 0
    this.forgotten = false
    this.refs = []                  // EvLink[]，维护用，不走热路径
  }
}
