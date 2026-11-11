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
//   node apply-all.mjs --restore  从 .backup\ 还原全部（只认与当前 dsh 版本匹配的备份）

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

/** 当前 dsh 的版本：备份按版本存，宿主升级后旧备份不再复用。 */
function hostVersion() {
  try {
    const pkg = join(CORE, '..', '..', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    return JSON.parse(readFileSync(pkg, 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 备份的版本记录文件（`.orig.version`）。 */
function versionPath(bak) {
  return `${bak}.version`
}

function readBackupVersion(bak) {
  try {
    return readFileSync(versionPath(bak), 'utf8').trim() || null
  } catch {
    return null
  }
}

/** 补丁写进文件后的标记字样；备份里出现就说明它已不是原文。 */
const PATCH_MARK = /dsh-patch |ykp patch /

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
        const ver = hostVersion()
        const bakVer = readBackupVersion(bak)
        // 老备份没记版本：内容干净（不含补丁标记）才认为原文还在
        if (bakVer === null && PATCH_MARK.test(readFileSync(bak, 'utf8'))) {
          console.log(`· 跳过 ${mod.id}：备份无版本记录且疑似中间态（${basename(bak)}）`)
          continue
        }
        if (bakVer !== null && bakVer !== ver) {
          console.log(`· 跳过 ${mod.id}：备份属于 dsh ${bakVer}，当前 dsh ${ver}`)
          continue
        }
        copyFileSync(bak, edit.target)
        if (bakVer === null) writeFileSync(versionPath(bak), ver, 'utf8')
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
    // 备份跟 dsh 版本绑定：同版本说明当前版本的原文已经存过，不再处理；
    // 版本变了（npm 升级/重装）才把当前文件重新备份，旧备份连同版本记录留档。
    const ver = hostVersion()
    const bakVer = existsSync(bak) ? readBackupVersion(bak) : null
    const bakOK = existsSync(bak) && !PATCH_MARK.test(readFileSync(bak, 'utf8'))
    if (bakVer === ver && existsSync(bak)) {
      // 同版本、备份已在：什么都不做
    } else if (bakOK && bakVer === null) {
      writeFileSync(versionPath(bak), ver, 'utf8')
      console.log(`· ${mod.id.padEnd(28)} 老备份补记 dsh ${ver}`)
    } else if (bakOK) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const stem = basename(bak).replace(/\.orig$/, '')
      renameSync(bak, join(BACKUPS, `${stem}.${stamp}.old`))
      if (existsSync(versionPath(bak))) renameSync(versionPath(bak), join(BACKUPS, `${stem}.${stamp}.version.old`))
      copyFileSync(edit.target, bak)
      writeFileSync(versionPath(bak), ver, 'utf8')
      console.log(`! ${mod.id.padEnd(28)} 目标已换版本（${bakVer ?? '未知'} -> ${ver}），旧备份留档 ${stamp}.old`)
    } else if (!PATCH_MARK.test(text)) {
      copyFileSync(edit.target, bak)
      writeFileSync(versionPath(bak), ver, 'utf8')
    } else {
      console.log(`! ${mod.id.padEnd(28)} 当前文件已含补丁且无干净备份，跳过备份`)
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


