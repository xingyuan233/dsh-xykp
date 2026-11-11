// dsh-xykp 共享配置 / 路径存取（全局唯一入口）。
//
// 每个插件自己的东西都在 <DSH_HOME>/xykp/<行 id>/ 下：
//   config.yml   配置（插件 apply 开头用 configFor(id, config) 读）
//   labels.yml   界面显示名（控制台读写）
// 旧的统一文件 <DSH_HOME>/xykp/config.yml 只留给还没迁移完的行（whaleisle / 已弃用）。
//
// 约定：新增代码不要再自己拼 `xykp/<名字>`，用这里的 dataDir(id) / configFile(id)；
// bili 系列共用的 cookie 等放 dataDir('bilibili')。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import yaml from 'js-yaml'

// 这些行的代码还没迁移到独立文件（whaleisle 正在用旧文件 / 已弃用），继续读写统一文件。
const LEGACY_IDS = new Set(['whaleisle', 'qq-adapter', 'memory-refine'])
export const isLegacyId = (id) => LEGACY_IDS.has(id)

let homeOverride = ''
export const setHomeDir = (dir) => {
  if (dir) homeOverride = String(dir)
}
export const homeDir = () => homeOverride || process.env.DSH_HOME || 'D:\\AI\\DeepseekHarness\\home'

export const xykpRoot = () => join(homeDir(), 'xykp')
export const dataDir = (id) => join(xykpRoot(), id)
export const configFile = (id) => (id ? join(dataDir(id), 'config.yml') : join(xykpRoot(), 'config.yml'))
export const labelsFile = (id) => (id ? join(dataDir(id), 'labels.yml') : join(xykpRoot(), 'labels.yml'))
// bili-reply / bili-rove / bili-audio-live 共用：cookie、名字缓存、回复队列。
export const biliDir = () => join(xykpRoot(), 'bilibili')

const plain = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : undefined)

const readYaml = (file) => {
  try {
    return plain(yaml.load(readFileSync(file, 'utf8')))
  } catch {
    return undefined
  }
}

const writeYaml = (file, value) => {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, yaml.dump(plain(value) ?? {}, { lineWidth: 120, noRefs: true }), 'utf8')
  renameSync(tmp, file)
}

/** 旧的统一配置文件（现在只剩还没迁移的行）。 */
export const readAll = () => readYaml(configFile()) ?? {}
export const writeAll = (all) => writeYaml(configFile(), all)

export const hasConfig = (id) => existsSync(configFile(id))

/** 某一行自己的配置；没有自己的文件就回退到旧的统一文件（迁移期 / legacy 行）。 */
export function readConfig(id) {
  const own = readYaml(configFile(id))
  if (own !== undefined) return own
  return plain(readAll()[id])
}

export function writeConfig(id, value) {
  if (isLegacyId(id)) {
    const all = readAll()
    all[id] = plain(value) ?? {}
    writeAll(all)
    return
  }
  writeYaml(configFile(id), value)
}

/** 恢复默认：删掉这一行自己的文件（legacy 行删旧文件里的 key）。 */
export function clearConfig(id) {
  if (isLegacyId(id)) {
    const all = readAll()
    delete all[id]
    writeAll(all)
    return
  }
  try {
    rmSync(configFile(id), { force: true })
  } catch {}
}

function merge(base, over) {
  if (!plain(over)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(over)) {
    if (plain(value) && plain(out[key])) out[key] = merge(out[key], value)
    else out[key] = value
  }
  return out
}

/** 插件入口用：文件里的值覆盖 loader 传来的旧值（对象递归合并）。 */
export function configFor(id, fallback) {
  const value = readConfig(id)
  if (!plain(value)) return fallback ?? {}
  return merge(fallback ?? {}, value)
}

// —— labels.yml：{ title: '显示名', fields: { 字段 key: '中文名' } } ——
const labelEntry = (raw) => {
  if (typeof raw === 'string') return { title: raw, fields: {} }
  const value = plain(raw) ?? {}
  return {
    title: typeof value.title === 'string' ? value.title : '',
    fields: plain(value.fields) ? { ...value.fields } : {},
  }
}

export function readLabel(id) {
  if (isLegacyId(id)) return labelEntry(readYaml(labelsFile())?.[id])
  return labelEntry(readYaml(labelsFile(id)))
}

export function writeLabel(id, entry) {
  const value = labelEntry(entry)
  if (isLegacyId(id)) {
    const all = readYaml(labelsFile()) ?? {}
    if (!value.title && Object.keys(value.fields).length === 0) delete all[id]
    else all[id] = value
    writeYaml(labelsFile(), all)
    return
  }
  writeYaml(labelsFile(id), value)
}

/**
 * 一次性迁移旧的统一 config.yml / labels.yml → 每行自己的文件。幂等：
 * 已经有自己文件的行不会被覆盖；旧文件最后只留 LEGACY_IDS。
 */
export function migrateLegacy() {
  const legacyConfig = readYaml(configFile()) ?? {}
  const legacyLabels = readYaml(labelsFile()) ?? {}
  let configChanged = false
  let labelsChanged = false
  for (const [id, value] of Object.entries(legacyConfig)) {
    if (isLegacyId(id)) continue
    if (!hasConfig(id)) writeYaml(configFile(id), plain(value) ?? {})
    delete legacyConfig[id]
    configChanged = true
  }
  for (const [id, value] of Object.entries(legacyLabels)) {
    if (id === '__seed') {
      delete legacyLabels[id]
      labelsChanged = true
      continue
    }
    if (isLegacyId(id)) continue
    if (!existsSync(labelsFile(id))) writeYaml(labelsFile(id), plain(value) ?? {})
    delete legacyLabels[id]
    labelsChanged = true
  }
  if (configChanged) writeYaml(configFile(), legacyConfig)
  if (labelsChanged) writeYaml(labelsFile(), legacyLabels)
  return { config: configChanged, labels: labelsChanged }
}
