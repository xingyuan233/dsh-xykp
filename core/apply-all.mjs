// dsh 核心补丁的总入口（apply-all）
//
// 约定：plugins\core\ 下的每一个 *.mjs 就是一个「功能补丁」，文件名就是功能名。
// 每个补丁模块导出：
//   export const id          功能标识（打印用）
//   export const description 一句话说明
//   export const edits = [{ target, marker, apply(text) -> text }]
//     target  被改的宿主文件绝对路径
//     marker  幂等标记：文件里已经有它就跳过
//     apply   纯文本变换，必须只改自己那一段
//
// 这个脚本不认识任何具体补丁名：扫目录、按文件名排序、逐个应用。
// 旧格式（plugins\core\<名字>\apply.ps1）也自动兼容，动态枚举，不写死。
//
// 用法：
//   node apply-all.mjs            应用全部（幂等）
//   node apply-all.mjs --check    只列状态
//   node apply-all.mjs --restore  从 .backup\ 还原全部

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, renameSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const CORE = dirname(fileURLToPath(import.meta.url))
const BACKUPS = join(CORE, '.backup')
const args = new Set(process.argv.slice(2))
const CHECK = args.has('--check')
const RESTORE = args.has('--restore')

/** 备份文件名：只保留 node_modules 之后的路径，避免超长。 */
function backupPath(target) {
  const parts = target.split(/[\\/]+/)
  const i = parts.lastIndexOf('node_modules')
  const rel = i >= 0 ? parts.slice(i + 1) : parts.slice(-3)
  return join(BACKUPS, rel.join('_').replace(/[^A-Za-z0-9._-]/g, '_') + '.orig')
}

function loadModules() {
  return readdirSync(CORE)
    .filter((f) => f.endsWith('.mjs') && f !== basename(fileURLToPath(import.meta.url)))
    .sort()
    .map((f) => ({ file: f, path: join(CORE, f) }))
}

function loadLegacy() {
  return readdirSync(CORE, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .filter((d) => existsSync(join(CORE, d.name, 'apply.ps1')))
    .map((d) => d.name)
    .sort()
}

let problems = 0

if (RESTORE) {
  let restored = 0
  let failed = 0
  for (const { file, path } of loadModules()) {
    const mod = await import(pathToFileURL(path).href)
    for (const edit of mod.edits ?? []) {
      const bak = backupPath(edit.target)
      if (existsSync(bak)) {
        copyFileSync(bak, edit.target)
        console.log(`restored  ${mod.id}  备份还原 -> ${edit.target}`)
        restored++
        continue
      }
      // 没有备份（补丁是在装好的版本上直接打的）：用 edit.revert() 反推原文
      if (typeof edit.revert === 'function' && existsSync(edit.target)) {
        const cur = readFileSync(edit.target, 'utf8')
        if (!cur.includes(edit.marker)) continue
        try {
          const next = edit.revert(cur)
          if (typeof next !== 'string' || next === cur || next.includes(edit.marker)) throw new Error('revert() 没有产生预期结果')
          mkdirSync(BACKUPS, { recursive: true })
          writeFileSync(edit.target, next, 'utf8')
          console.log(`restored  ${mod.id}  revert() -> ${edit.target}`)
          restored++
        } catch (error) {
          console.log(`✗ 还原失败 ${mod.id}：${error.message}`)
          failed++
        }
        continue
      }
      console.log(`· 跳过 ${mod.id}：没有备份也没有 revert()（${file}）`)
    }
  }
  console.log(restored === 0 ? '没有可还原的补丁' : `已还原 ${restored} 个文件`)
  process.exit(failed === 0 ? 0 : 1)
}

const modules = loadModules()
console.log(`=== 功能补丁（${modules.length} 个 .mjs）===`)
for (const { file, path } of modules) {
  let mod
  try {
    mod = await import(pathToFileURL(path).href)
  } catch (error) {
    console.log(`✗ ${file} 加载失败：${error.message}`)
    problems++
    continue
  }
  const edits = mod.edits ?? []
  if (edits.length === 0) {
    console.log(`✗ ${file} 没有 edits`)
    problems++
    continue
  }
  for (const edit of edits) {
    if (!existsSync(edit.target)) {
      console.log(`✗ ${mod.id}：目标不存在 ${edit.target}（npm 结构变了？）`)
      problems++
      continue
    }
    const text = readFileSync(edit.target, 'utf8')
    const applied = text.includes(edit.marker)
    if (CHECK) {
      console.log(`${applied ? '✓' : '·'} ${mod.id.padEnd(28)} ${applied ? '已应用' : '未应用'}  ${edit.target}`)
      continue
    }
    if (applied) {
      console.log(`✓ ${mod.id.padEnd(28)} 已是补丁版，跳过`)
      continue
    }
    let next
    try {
      next = edit.apply(text)
    } catch (error) {
      console.log(`✗ ${mod.id}：打补丁失败 ${error.message}`)
      problems++
      continue
    }
    if (typeof next !== 'string' || next === text || !next.includes(edit.marker)) {
      console.log(`✗ ${mod.id}：apply() 没有产生预期改动（拒绝写入）`)
      problems++
      continue
    }
    const bak = backupPath(edit.target)
    mkdirSync(BACKUPS, { recursive: true })
    // 备份只在「目标文件没被换过」时才有意义：宿主升级/重装后旧备份属于旧版本，
    // 拿它 -Restore 会把旧版本源码写回去。内容对不上就留档旧备份、按当前版本重新备份。
    if (!existsSync(bak)) {
      copyFileSync(edit.target, bak)
    } else if (readFileSync(bak, 'utf8') !== text) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      renameSync(bak, join(BACKUPS, `${basename(bak).replace(/\.orig$/, '')}.${stamp}.old`))
      copyFileSync(edit.target, bak)
      console.log(`! ${mod.id.padEnd(28)} 目标已换版本，旧备份留档 ${stamp}.old`)
    }
    writeFileSync(edit.target, next, 'utf8')
    console.log(`+ ${mod.id.padEnd(28)} 已应用  ${text.length} -> ${next.length} 字节`)
  }
}

const legacy = loadLegacy()
if (legacy.length > 0) {
  console.log(`=== 旧格式补丁（${legacy.length} 个目录）===`)
  for (const name of legacy) {
    const script = join(CORE, name, 'apply.ps1')
    if (CHECK) {
      console.log(`· ${name.padEnd(28)} 旧格式（幂等 apply，重跑可确认）`)
      continue
    }
    const r = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: 'inherit' })
    if (r.status !== 0) {
      console.log(`✗ ${name}：apply.ps1 退出码 ${r.status}`)
      problems++
    }
  }
}

if (CHECK) {
  console.log(problems === 0 ? '\n检查通过。' : `\n有 ${problems} 个问题。`)
  process.exit(problems === 0 ? 0 : 1)
}
if (problems > 0) {
  console.log(`\n完成，但有 ${problems} 个问题。`)
  process.exit(1)
}
console.log('\n全部功能补丁已就绪。重启 dsh web 后生效。')


