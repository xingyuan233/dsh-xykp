// session-archiver 自测（不启宿主）
//
// 覆盖任务文件的验收点：
//   1. 超过 idleDays 的会话进归档候选，近期的保留
//   2. ignoreWorkspaces 命中的工作区整片跳过
//   3. ignoreSessions 支持通配符
//   4. 已归档的不重复处理；没有活动时间的保守跳过
//   5. collectActivity 能从 <root>/<组>/<会话>/session*.jsonl.zstd 读出 mtime
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { plan, collectActivity } from '../lib/index.js'

let failed = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) failed++
}

const day = 86400000
const now = Date.now()
const cfg = { idleDays: 3, ignoreWorkspaces: ['alive-workspace'], ignoreSessions: ['test-*'] }

const workspaces = [
  {
    title: 'qq-workspace',
    path: 'D:\\x\\qq-workspace',
    sessionIds: ['old-session', 'recent-session', 'test-gone', 'session-archived'],
  },
  {
    title: 'alive-workspace',
    path: 'D:\\x\\alive-workspace',
    sessionIds: ['ancient-session', 'old-session-2'],
  },
]
const activity = new Map([
  ['old-session', now - 5 * day],
  ['recent-session', now - 1 * day],
  ['test-gone', now - 9 * day],
  ['session-archived', now - 9 * day],
  ['ancient-session', now - 30 * day],
  ['old-session-2', now - 30 * day],
  ['no-time-session', 0],
])
const archived = ['session-archived']

const { toArchive, keep } = plan(workspaces, archived, cfg, (id) => activity.get(id) || 0)

const ids = toArchive.map((x) => x.id)
check(ids.length === 1 && ids[0] === 'old-session', '只归档超过 3 天的那个', `→ ${ids.join(',')}`)
check(!ids.includes('recent-session'), '1 天前活动的没动')
check(!ids.includes('test-gone'), '通配符 test-* 被跳过')
check(!ids.includes('session-archived'), '已归档的不重复处理')
check(!ids.includes('ancient-session'), 'alive-workspace 整片跳过')
check(!ids.includes('old-session-2'), 'alive-workspace 的另一个也没动')

// 关掉工作区忽略 → 老会话应该进来
const r2 = plan(workspaces, archived, { ...cfg, ignoreWorkspaces: [] }, (id) => activity.get(id) || 0)
const ids2 = r2.toArchive.map((x) => x.id)
check(ids2.includes('ancient-session') && ids2.includes('old-session-2'), '去掉工作区忽略后老会话被归档')

// 没有活动时间 → 保守跳过
const r3 = plan(
  [{ title: 'w', path: 'D:\\x\\w', sessionIds: ['no-time-session'] }],
  [],
  { ...cfg, ignoreWorkspaces: [] },
  (id) => activity.get(id) || 0,
)
check(r3.toArchive.length === 0, '拿不到活动时间的保守跳过')
check(r3.keep.some((k) => k.reason === 'no-activity-time'), '跳过原因记录正确')

// collectActivity：真目录结构
const root = mkdtempSync(join(tmpdir(), 'archiver-'))
const group = join(root, '--D-AI-x--')
mkdirSync(join(group, 'session-a'), { recursive: true })
mkdirSync(join(group, 'session-b'), { recursive: true })
mkdirSync(join(group, 'session-c'), { recursive: true })
const fileA = join(group, 'session-a', 'session.v4.jsonl.zstd')
const fileB = join(group, 'session-b', 'session.v4.jsonl.zstd')
const junkC = join(group, 'session-c', 'notes.txt')
writeFileSync(fileA, 'x')
writeFileSync(fileB, 'y')
writeFileSync(junkC, 'z')
utimesSync(fileA, new Date(now - 10 * day), new Date(now - 10 * day))
utimesSync(fileB, new Date(now - 2 * day), new Date(now - 2 * day))
const act = await collectActivity({ sessionsRoot: root })
check(act.size === 2, 'collectActivity 只认出会话日志文件', `size=${act.size}`)
check(Math.abs((act.get('session-a') || 0) - (now - 10 * day)) < 5000, 'session-a 的 mtime 正确')
check(!act.has('session-c'), '非会话日志不算数')

rmSync(root, { recursive: true, force: true })
console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exitCode = failed ? 1 : 0
