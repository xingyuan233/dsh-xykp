// dsh-log-cleaner · 宿主半边
//
// 需求（任务-2026-10-27.md 第二节）：
//   1. 启动时跑一次，之后每 12 小时跑一次
//   2. 扫 <DSH_HOME> 下的匹配文件（默认 *.log，可加别的，取并集）
//   3. 尺寸小于阈值的跳过；超过的：旧的部分追加进历史日志，原文件只留最新 keepLines 行
//   4. 历史日志按原相对路径分层：a/b.log → <backupRoot>/a/b/yyyy-MM-dd.log（追加）
//   5. 历史日志超过 keepDays 天的删掉
//   6. 全部异步，不阻塞主线程；任何错误只记日志，绝不拖死宿主
import { readdir, stat, mkdir, readFile, writeFile, appendFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

export const name = 'log-cleaner'
export const inject = ['timer']

const PREFIX = '[log-cleaner]'
const log = (...a) => console.log(PREFIX, ...a)
const warn = (...a) => console.warn(PREFIX, ...a)

const DEFAULTS = {
  // 扫描根目录，空 = DSH_HOME
  root: '',
  // 匹配方式，取并集。glob（* / ?）或 re: 开头的正则
  patterns: ['*.log'],
  // 目录级忽略（最先判断）：名字、glob 或绝对路径
  ignoreDirs: ['node_modules'],
  // 文件级忽略（最后判断）：文件名 glob 或相对路径 glob
  ignoreFiles: [],
  // 旧日志保留根目录，空 = <root>/logs-archive
  backupRoot: '',
  // 触发清理的最小字节数（默认 30 KB）
  minBytes: 30 * 1024,
  // 原文件保留最新几行（0 = 一行不留）
  keepLines: 0,
  // 历史日志保留天数
  keepDays: 7,
  // 定时间隔（小时）
  intervalHours: 12,
  // 只报告不动手
  dryRun: false,
  // 单文件超过这个大小就不读（保护内存）
  maxFileMB: 64,
}

const globToRe = (g) =>
  new RegExp('^' + String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')

function matcherOf(pattern) {
  const p = String(pattern || '').trim()
  if (!p) return null
  try {
    if (p.startsWith('re:')) return new RegExp(p.slice(3), 'i')
    return globToRe(p)
  } catch {
    return null
  }
}

function hitAny(name, matchers) {
  return matchers.some((re) => re && re.test(name))
}

function expandHome(p) {
  if (!p) return ''
  if (!isAbsolute(p)) return resolve(process.env.DSH_HOME || join(homedir(), '.dsh'), p)
  return p
}

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const yieldNow = () => new Promise((r) => setImmediate(r))

// ── 扫目录 ────────────────────────────────────────────────────────────
async function collect(root, cfg, out) {
  const dirMatchers = (cfg.ignoreDirs || []).map(matcherOf)
  const fileMatchers = (cfg.patterns || []).map(matcherOf)
  const ignoreFileMatchers = (cfg.ignoreFiles || []).map(matcherOf)
  const backupRoot = expandHome(cfg.backupRoot) || join(root, 'logs-archive')

  async function walk(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        const rel = relative(root, full).replace(/\\/g, '/')
        // 目录名、相对路径、绝对路径都认（写整条 D:\...\node_modules 也生效）
        if (hitAny(e.name, dirMatchers) || hitAny(rel, dirMatchers) || hitAny(full, dirMatchers)) continue
        if (resolve(full) === resolve(backupRoot)) continue // 插件自己的旧日志目录，默认不碰
        await walk(full)
        continue
      }
      if (!e.isFile()) continue
      if (!hitAny(e.name, fileMatchers)) continue
      const rel = relative(root, full).replace(/\\/g, '/')
      if (hitAny(rel, ignoreFileMatchers) || hitAny(e.name, ignoreFileMatchers)) continue
      out.push({ path: full, rel })
    }
    await yieldNow()
  }

  await walk(root)
  return out
}

// ── 清理单个文件 ──────────────────────────────────────────────────────
async function cleanOne(file, root, cfg) {
  const st = await stat(file.path).catch(() => null)
  if (!st || !st.isFile()) return false
  if (st.size < cfg.minBytes) return false
  if (st.size > cfg.maxFileMB * 1048576) {
    warn(`${file.rel} 太大（${(st.size / 1048576).toFixed(1)} MB），跳过`)
    return false
  }

  const text = await readFile(file.path, 'utf8')
  const lines = text.split('\n')
  // 末尾通常是空行，先去掉，保持原来的换行习惯
  const trailingNL = lines.length && lines[lines.length - 1] === ''
  if (trailingNL) lines.pop()
  if (!lines.length) return false

  const keep = Math.max(0, Number(cfg.keepLines) || 0)
  const cut = Math.max(0, lines.length - keep)
  const oldPart = lines.slice(0, cut).join('\n')
  if (!oldPart) return false
  const newPart = lines.slice(cut).join('\n')

  const backupRoot = expandHome(cfg.backupRoot) || join(root, 'logs-archive')
  const relNoExt = file.rel.replace(/\.[^./\\]+$/, '')
  const historyDir = join(backupRoot, ...relNoExt.split('/'))
  const historyPath = join(historyDir, `${today()}.log`)

  if (cfg.dryRun) {
    log(`[dry] ${file.rel}：${(st.size / 1024).toFixed(0)} KB，会搬走 ${cut} 行 → ${historyPath}`)
    return true
  }

  await mkdir(historyDir, { recursive: true })
  await appendFile(historyPath, oldPart + '\n', 'utf8')
  await writeFile(file.path, keep > 0 ? newPart + (trailingNL ? '\n' : '') : '', 'utf8')
  log(`${file.rel}：${(st.size / 1024).toFixed(0)} KB，搬走 ${cut} 行，留 ${keep} 行`)
  return true
}

// ── 清理过期历史 ──────────────────────────────────────────────────────
async function pruneHistory(backupRoot, days) {
  if (!days || days <= 0) return 0
  const cutoff = Date.now() - days * 86400000
  let removed = 0
  async function walk(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full)
        continue
      }
      if (!/\.log$/i.test(e.name)) continue
      const st = await stat(full).catch(() => null)
      if (!st || st.mtimeMs >= cutoff) continue
      try {
        await unlink(full)
        removed++
      } catch (err) {
        warn(`删旧日志失败 ${full}：`, err?.message || err)
      }
    }
    await yieldNow()
  }
  await walk(backupRoot)
  return removed
}

// ── 一轮 ──────────────────────────────────────────────────────────────
export async function sweep(cfgInput = {}) {
  const cfg = { ...DEFAULTS, ...(cfgInput && typeof cfgInput === 'object' ? cfgInput : {}) }
  const root = expandHome(cfg.root) || process.env.DSH_HOME || join(homedir(), '.dsh')
  const files = await collect(root, cfg, [])
  let rotated = 0
  for (const f of files) {
    try {
      if (await cleanOne(f, root, cfg)) rotated++
    } catch (err) {
      warn(`处理 ${f.rel} 失败：`, err?.message || err)
    }
    await yieldNow()
  }
  let pruned = 0
  try {
    pruned = await pruneHistory(expandHome(cfg.backupRoot) || join(root, 'logs-archive'), Number(cfg.keepDays))
  } catch (err) {
    warn('清理过期历史失败：', err?.message || err)
  }
  return { root, scanned: files.length, rotated, pruned, dryRun: Boolean(cfg.dryRun) }
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  const run = async (label) => {
    try {
      const r = await sweep(cfg)
      log(`${label}：扫 ${r.scanned} 个、清理 ${r.rotated} 个、删旧 ${r.pruned} 个${r.dryRun ? '（dryRun）' : ''}`)
    } catch (err) {
      warn(`${label} 失败（已忽略）：`, err?.stack || err)
    }
  }
  // 启动跑一次（异步，不 await，别卡住宿主启动）
  void run('启动检查')

  const hours = Math.max(1, Number(cfg.intervalHours) || DEFAULTS.intervalHours)
  const timer = setInterval(() => void run('定时检查'), hours * 3600000)
  if (typeof timer.unref === 'function') timer.unref()
  try {
    ctx.on('dispose', () => clearInterval(timer))
  } catch {
    /* 收摊失败无所谓 */
  }
}

// 自测用
export const _internal = { sweep, collect, cleanOne, pruneHistory, globToRe, matcherOf, DEFAULTS }
