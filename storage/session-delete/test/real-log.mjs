import { readFileSync, readdirSync, statSync, mkdirSync, rmSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { truncateLogAtTurn } from '../lib/index.js'

const root = 'D:\\AI\\DeepseekHarness\\home\\sessions'
const pick = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p)
    else if (name === 'session.v4.jsonl.zstd') pick.push(p)
  }
}
walk(root)

const parse = (file) => {
  const text = zstdDecompressSync(readFileSync(file)).toString('utf8')
  const lines = text.split('\n').filter((l) => l.trim())
  return { headerLine: lines[0], events: lines.slice(1).map((l) => JSON.parse(l)) }
}

const candidates = []
for (const file of pick) {
  try {
    const { headerLine, events } = parse(file)
    const turns = events.filter((e) => e.type === 'turn/start').length
    const hasGapSplice = events.some((e) => e.type === 'agent/inbox/spliced')
    if (turns >= 3) candidates.push({ file, id: JSON.parse(headerLine).id, turns, hasGapSplice })
  } catch {}
}
candidates.sort((a, b) => b.turns - a.turns)
const chosen = []
for (const c of candidates) if (chosen.length < 4 && (c.hasGapSplice || chosen.length < 2)) chosen.push(c)
console.log('candidates', candidates.length, 'chosen', chosen.map((c) => `${c.id}:${c.turns}turns`).join(', '))

let failures = 0
const fail = (msg) => { failures++; console.log('  ✗', msg) }
const ok = (msg) => console.log('  ✓', msg)

for (const c of chosen) {
  const work = join(tmpdir(), 'dsh-trunc-' + c.id.slice(-8))
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const original = parse(c.file)
  const originalCount = original.events.length
  for (const fromTurn of [2, 3, 1]) {
    if (fromTurn > c.turns) continue
    console.log(`\n[${c.id}] delete from turn ${fromTurn}`)
    const file = join(work, `t${fromTurn}.zstd`)
    copyFileSync(c.file, file)
    let result
    try {
      result = await truncateLogAtTurn(file, c.id, fromTurn)
    } catch (error) {
      fail('truncate threw: ' + error.message)
      continue
    }
    const after = parse(file)
    const lines = readFileSync(file)
    if (after.headerLine !== original.headerLine) fail('header changed')
    else ok('header unchanged')
    const seqOk = after.events.every((e, i) => e.seq === i)
    seqOk ? ok(`seq contiguous (${after.events.length} events)`) : fail('seq not contiguous')
    let ts = -Infinity
    let tsOk = true
    for (const e of after.events) { if (typeof e.ts === 'number') { if (e.ts < ts) tsOk = false; ts = e.ts } }
    tsOk ? ok('ts monotonic') : fail('ts went backwards')
    const types = after.events.map((e) => e.type)
    const lastStart = types.lastIndexOf('turn/start')
    const dangling = after.events.some(
      (e, i) =>
        e.type === 'agent/inbox/spliced' &&
        e.data?.removedCount === undefined &&
        i > lastStart &&
        !types.slice(i + 1).includes('turn/start'),
    )
    dangling ? fail('dangling inbox after last turn/start') : ok('no dangling inbox')
    const remainingTurns = types.filter((t) => t === 'turn/start').length
    remainingTurns === fromTurn - 1 ? ok(`turns left = ${remainingTurns}`) : fail(`turns left = ${remainingTurns}, want ${fromTurn - 1}`)
    if (fromTurn === 1) {
      types.includes('session/title') ? ok('title kept') : fail('title lost')
    }
    if (result.remainingEvents !== after.events.length) fail(`remainingEvents mismatch ${result.remainingEvents} vs ${after.events.length}`)
    if (after.events.length === 0 && fromTurn > 1) fail('nothing left')
    console.log(`  compressed ${lines.length} bytes, events ${originalCount} -> ${after.events.length}`)
  }
  rmSync(work, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL REAL-LOG CHECKS PASSED' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)

