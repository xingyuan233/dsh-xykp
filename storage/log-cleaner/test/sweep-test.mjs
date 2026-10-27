// log-cleaner 自测（不启宿主）
//
// 对应任务文件的验收点：
//   1. 超阈值的旧日志被搬进历史、原文件按 keepLines 保留
//   2. 同一天多次清理是追加，不是覆盖
//   3. 小于阈值不动、node_modules 不碰、ignoreFiles 生效
//   4. 历史超过 keepDays 被删
//   5. dryRun 不动文件
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, utimesSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sweep } from '../lib/index.js'

let failed = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) failed++
}
const today = (() => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})()

const root = mkdtempSync(join(tmpdir(), 'log-cleaner-'))
const backupRoot = join(root, 'archive')

// 场景 1：超阈值 → 搬走全部，原文件空
const dirA = join(root, 'a')
mkdirSync(dirA, { recursive: true })
const big = join(dirA, 'b.log')
writeFileSync(big, Array.from({ length: 5000 }, (_, i) => `line-${i}`).join('\n') + '\n')

// 场景 3 的陪衬
const small = join(root, 'small.log')
writeFileSync(small, 'tiny\n')
const inNodeModules = join(root, 'node_modules', 'pkg')
mkdirSync(inNodeModules, { recursive: true })
const nm = join(inNodeModules, 'x.log')
writeFileSync(nm, Array.from({ length: 5000 }, (_, i) => `nm-${i}`).join('\n'))
const ignored = join(root, 'secret.log')
writeFileSync(ignored, 'x'.repeat(100 * 1024))

const cfg = { root, backupRoot, minBytes: 30 * 1024, keepLines: 0, keepDays: 7, ignoreFiles: ['secret.log'] }

const r1 = await sweep(cfg)
check(r1.rotated === 1, '只清理了超限的那一个', `rotated=${r1.rotated}`)
check(statSync(big).size === 0, '原文件被清空（keepLines=0）')
check(statSync(nm).size > 0, 'node_modules 里的没被动')
check(statSync(ignored).size > 0, 'ignoreFiles 里的没被动')
check(statSync(small).size > 0, '小于阈值的没被动')

const hist = join(backupRoot, 'a', 'b', `${today}.log`)
check(existsSync(hist), '历史日志按原路径分层生成', hist.replace(root, '<root>'))
const h1 = readFileSync(hist, 'utf8')
check(h1.includes('line-0') && h1.includes('line-4999'), '历史内容完整')
check(!h1.includes('nm-0'), '没把别的目录内容混进来')

// 场景 2：再写一次 → 追加
writeFileSync(big, 'second-batch-1\nsecond-batch-2\n' + 'y'.repeat(40 * 1024) + '\n')
const r2 = await sweep(cfg)
check(r2.rotated === 1, '第二次也清理', `rotated=${r2.rotated}`)
const h2 = readFileSync(hist, 'utf8')
check(h2.length > h1.length && h2.startsWith(h1), '历史是追加不是覆盖')

// 场景 4：keepLines=3 → 只留最后 3 行
const keep3 = join(root, 'keep3.log')
writeFileSync(keep3, Array.from({ length: 3000 }, (_, i) => `k-${i}`).join('\n') + '\n')
const r3 = await sweep({ ...cfg, keepLines: 3, minBytes: 4096 })
check(r3.rotated >= 1, 'keepLines=3 也清理了')
const keptLines = readFileSync(keep3, 'utf8').trim().split('\n')
check(keptLines.length === 3 && keptLines[2] === 'k-2999', '原文件只留最后 3 行', `lines=${keptLines.length}`)

// 场景 5：历史超过 keepDays 被删
const oldFile = join(backupRoot, 'a', 'b', '2000-01-01.log')
writeFileSync(oldFile, 'ancient\n')
const eightDaysAgo = new Date(Date.now() - 8 * 86400000)
utimesSync(oldFile, eightDaysAgo, eightDaysAgo)
const r4 = await sweep(cfg)
check(!existsSync(oldFile), '超过 7 天的历史被删')
check(existsSync(hist), '当天的历史还在')
check(r4.pruned >= 1, 'pruned 计数正确', `pruned=${r4.pruned}`)

// 场景 6：dryRun 不动
const dry = join(root, 'dry.log')
writeFileSync(dry, 'z'.repeat(50 * 1024))
const r5 = await sweep({ ...cfg, dryRun: true })
check(statSync(dry).size > 0, 'dryRun 不动文件')
check(r5.rotated >= 1, 'dryRun 也会报告', `rotated=${r5.rotated}`)

rmSync(root, { recursive: true, force: true })
console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exitCode = failed ? 1 : 0
