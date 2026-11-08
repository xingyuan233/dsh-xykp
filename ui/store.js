// dsh-xykp 的共享配置读取器。
//
// 唯一持久化文件：<DSH_HOME>/xykp/config.yml
// 各插件在 apply 开头用 configFor('<行id>', config) 取自己的配置，
// 所以启动时就是最终值，不存在「先默认跑几秒」的问题。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import yaml from 'js-yaml'

const homeDir = () => process.env.DSH_HOME || 'D:\\AI\\DeepseekHarness\\home'

export const configFile = () => join(homeDir(), 'xykp', 'config.yml')

/** 整份配置（读失败就当空）。 */
export function readAll() {
  try {
    const parsed = yaml.load(readFileSync(configFile(), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const merge = (base, over) => {
  if (over === null || over === undefined) return base
  if (Array.isArray(over) || typeof over !== 'object') return over
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {}
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(out[k], v) : v
  }
  return out
}

/** 某一行插件的配置：文件里的值覆盖 loader 传进来的（旧）值。 */
export function configFor(id, fallback) {
  const value = readAll()[id]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback ?? {}
  return merge(fallback ?? {}, value)
}

/** 整份写回（原子替换；QQ 的 /cfg-* 命令改的就是这个文件）。 */
export function writeAll(all) {
  const p = configFile()
  mkdirSync(dirname(p), { recursive: true })
  const tmp = p + '.tmp'
  writeFileSync(tmp, yaml.dump(all && typeof all === 'object' ? all : {}, { lineWidth: 120, noRefs: true }), 'utf8')
  renameSync(tmp, p)
}
