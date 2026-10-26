// 预设文件夹的纯逻辑：扫描、解析、指纹、锁文件与留痕。
// 不碰 Cordis，方便单独用 node 测：node test/scan-test.mjs
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

// 和 cordis 的 loader 对齐：`!!js` 解析成 { __jsExpr: '...' }，注册时由 registry 求值
export function makeYaml(yaml) {
  const jsType = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    construct: (data) => ({ __jsExpr: String(data) }),
  })
  return { load: (text) => yaml.load(text, { schema: yaml.DEFAULT_SCHEMA.extend([jsType]) }) }
}

export function sha256Of(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 解析一个 preset.yml；返回 { definition, error }，error 时 definition 为 undefined */
export function parsePreset(yaml, text, folderId) {
  if (!text || !text.trim()) return { error: `preset.yml 是空的（${folderId}）` }
  let raw
  try {
    raw = yaml.load(text)
  } catch (e) {
    return { error: `YAML 解析失败（${folderId}）：${e.message}` }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `preset.yml 顶层必须是对象（${folderId}）` }
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : folderId
  if (!id) return { error: `预设缺少 id（${folderId}）` }
  if (id !== folderId) {
    return { error: `预设 id「${id}」和文件夹名「${folderId}」不一致——id 必须跟文件夹同名，否则会分不清谁是谁` }
  }
  if (!Array.isArray(raw.plugins) || raw.plugins.length === 0) {
    return { error: `预设「${id}」的 plugins 必须是非空数组` }
  }
  const bad = raw.plugins.findIndex((row) => !row || typeof row !== 'object' || Array.isArray(row))
  if (bad >= 0) return { error: `预设「${id}」第 ${bad + 1} 行不是合法插件行` }
  const definition = { id }
  if (typeof raw.name === 'string') definition.name = raw.name
  if (typeof raw.description === 'string') definition.description = raw.description
  if (typeof raw.order === 'number' && Number.isFinite(raw.order)) definition.order = raw.order
  definition.plugins = raw.plugins
  return { definition }
}

/** 扫一层文件夹：每个子文件夹里找 preset.yml（子文件夹名 = 预设 id） */
export function scanDir(yaml, dir) {
  const out = []
  if (!existsSync(dir)) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue
    const file = join(dir, entry.name, 'preset.yml')
    if (!existsSync(file)) continue
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (e) {
      out.push({ id: entry.name, file, error: `读不出来：${e.message}` })
      continue
    }
    const parsed = parsePreset(yaml, text, entry.name)
    if (parsed.error) {
      out.push({ id: entry.name, file, error: parsed.error })
      continue
    }
    let mtime = ''
    let size = text.length
    try {
      const st = statSync(file)
      mtime = st.mtime.toISOString()
      size = st.size
    } catch (e) {}
    out.push({
      id: parsed.definition.id,
      file,
      definition: parsed.definition,
      sha256: sha256Of(text),
      mtime,
      size,
      rows: parsed.definition.plugins.length,
    })
  }
  return out.sort((a, b) => (a.definition?.order ?? 999) - (b.definition?.order ?? 999) || a.id.localeCompare(b.id))
}

export function readLock(lockPath) {
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (raw && typeof raw === 'object' && raw.presets && typeof raw.presets === 'object') return raw
  } catch (e) {}
  return { version: 1, presets: {} }
}

export function writeLock(lockPath, lock) {
  mkdirSync(join(lockPath, '..'), { recursive: true })
  const tmp = lockPath + '.tmp'
  writeFileSync(tmp, JSON.stringify(lock, null, 2) + '\n', 'utf8')
  renameSync(tmp, lockPath)
}

export function metaOf(entry) {
  return {
    sha256: entry.sha256,
    sha256Short: entry.sha256.slice(0, 12),
    mtime: entry.mtime,
    size: entry.size,
    name: entry.definition?.name ?? '',
    order: entry.definition?.order ?? null,
    rows: entry.rows ?? null,
  }
}

/** 跟旧锁比，算出 added / changed / removed（按 id） */
export function diffLock(prevLock, nextPresets) {
  const prev = prevLock?.presets ?? {}
  const diff = { added: [], changed: [], removed: [] }
  for (const [id, meta] of Object.entries(nextPresets)) {
    if (!prev[id]) diff.added.push(id)
    else if (prev[id].sha256 !== meta.sha256) diff.changed.push({ id, from: prev[id].sha256, to: meta.sha256 })
  }
  for (const id of Object.keys(prev)) {
    if (!(id in nextPresets)) diff.removed.push(id)
  }
  return diff
}

export function localStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  const off = -date.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** 把变化写成一行一行（只追加，不改历史） */
export function changelogLines(diff, nextPresets, date = new Date()) {
  const stamp = localStamp(date)
  const lines = []
  for (const id of diff.added) {
    const m = nextPresets[id]
    lines.push(`${stamp}  ${id}  added  ${m.sha256Short}  ${m.rows ?? '?'} rows  ${m.name || ''}`.trim())
  }
  for (const c of diff.changed) {
    const m = nextPresets[c.id]
    lines.push(`${stamp}  ${c.id}  changed  ${String(c.from).slice(0, 12)} -> ${m.sha256Short}  ${m.rows ?? '?'} rows`.trim())
  }
  for (const id of diff.removed) {
    lines.push(`${stamp}  ${id}  removed`)
  }
  return lines
}

export function appendChangelog(changelogPath, lines) {
  if (!lines.length) return
  mkdirSync(join(changelogPath, '..'), { recursive: true })
  appendFileSync(changelogPath, lines.join('\n') + '\n', 'utf8')
}
