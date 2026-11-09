// dsh-xykp/ui/console —— 「插件配置」控制台的宿主半边。
//
// 持久化：所有 dsh-xykp 行的配置统一放在
//   <home>/xykp/config.yml
// 一个文件里（宿主启动后用它覆盖 loader 里的值，保存时写文件 + 热重载该行）。
// profile 的 cordis.patch.yml 不再是这里的编辑对象。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import yaml from 'js-yaml'

export const name = 'xykp-console'
export const inject = ['configEditor', 'webServer', 'profileContext']

const GROUPS = {
  storage: '存储',
  chat: '对话',
  comms: '通信',
  senses: '感官',
  observer: '观察',
  ui: '界面',
}

// 行 id → 展示信息。名字只影响界面，不影响配置。
const META = {
  'log-cleaner': { title: '日志清理', desc: '按大小 / 行数 / 天数清理日志，先备份再截断。' },
  'session-archiver': { title: '会话归档', desc: '把闲置太久的旧对话自动归档，减少列表噪声。' },
  'dsh-session-delete': { title: '会话删除', desc: '侧边栏右键永久删除会话（带二次确认）。' },
  'preset-loader': { title: '预设文件加载', desc: '从预设目录加载 / 热更新预设，记录变更日志。' },
  'preset-binder': { title: '预设绑定', desc: '把当前对话和预设绑定，显示模型 / token / 上下文。' },
  'memory-refine': { title: '记忆整理', desc: '预设级记忆开关、记忆内容整理（设置里有单独页面）。' },
  'toolret-steward': { title: '工具结果管家', desc: '按黑/白名单把长工具结果折叠成存根，省上下文。' },
  'toolret-forget': { title: '工具结果折叠（旧）', desc: '已被 toolret-steward 取代，行本身是停用的。' },
  'token-reporter': { title: 'token 汇报', desc: '每轮统计 token / 费用 / 余额，可插入提示。' },
  'tooldesc-control': { title: '工具说明控制', desc: '工具说明懒加载、变更通知、按大轮重贴。' },
  'senses-screenshot': { title: '截屏', desc: 'screenshot_acquire：整屏 / 窗口 / 区域截图。' },
  'senses-keymouse': { title: '键鼠', desc: 'mouse_input / keyboard_input：鼠标键盘模拟。' },
  'senses-balance-reporter': { title: '余额挂件', desc: '页面右下角的 VK-1 余额宠物；balance_report 查余额/变动/节假日。' },
  'bili-reply': { title: 'B 站自动回复', desc: '定时拉 @ / 私信，绑定对话自动回复。' },
  'bili-rove': { title: 'B 站工具', desc: 'bili_rove：搜索、视频、评论、三连等。' },
  'qq-adapter': {
    title: 'QQ 通道',
    desc: 'QQ 桥接（收发消息、二维码登录、管理员权限）。',
  },
  ntfy: { title: 'ntfy 推送', desc: 'ntfy_push / ntfy_wait：往频道推消息、等消息。' },
  'search-engine': { title: '搜索 / 抓取', desc: 'web_search / web_fetch 的免费 provider（含 reader 正文清洗）。' },
  'dsh-prosecutor': { title: '监察', desc: '定时检查 dsh 是否活着，异常时发 ntfy 唤醒。' },
  'plugin-gate': { title: '安装安全闸', desc: '装插件前扫源码，BLOCK / WARN / PASS。' },
}

// 常用字段的中文标签。没写到的按 key 原样显示。
const FIELDS = {
  root: '根目录',
  dir: '目录',
  lockPath: '锁文件',
  changelogPath: '变更日志',
  backupRoot: '备份目录',
  pendingPath: '待删队列文件',
  seenPath: '已读记录文件',
  qrFile: '登录二维码图片',
  shellBootPath: 'NapCat 启动器',
  shellDir: 'NapCat 目录',
  ignoreDirs: '跳过的目录',
  ignoreFiles: '跳过的文件',
  ignoreWorkspaces: '跳过的会话',
  ignorePresets: '跳过的预设',
  ignoreSessions: '跳过的对话',
  patterns: '匹配的文件',
  minBytes: '最小字节',
  keepLines: '保留行数',
  keepDays: '保留天数',
  intervalHours: '间隔（小时）',
  refreshSeconds: '刷新间隔（秒）',
  lowBalance: '低余额提醒（元）',
  holidays: '后台更新节假日',
  holidayRefreshDays: '节假日刷新（天）',
  holidayUrl: '节假日数据源',
  idleDays: '闲置天数（归档）',
  maxSessions: '最多显示对话',
  ignore: '忽略的预设',
  presets: '预设范围',
  tools: '工具名单',
  minChars: '最小折叠字符',
  headChars: '保留开头字符',
  tailChars: '保留结尾字符',
  emptyStub: '空结果也折叠',
  mode: '模式',
  cost: '计费单价',
  prompt: '提示注入',
  fields: '字段列表',
  order: '插入位置',
  transferHint: '交接提示阈值',
  rules: '懒加载规则',
  keys: '触发关键词',
  cooldown: '冷却（大轮）',
  system: '系统说明位置',
  limit: '最多推送次数',
  systemText: '系统说明文本',
  descNoticeIgnore: '不看说明变化的工具',
  input: '输入价格',
  cacheRead: '缓存读价格',
  output: '输出价格',
  at: '交接阈值',
  everyTokens: '重贴间隔 token',
  withPrefix: '带前缀',
  withTools: '带工具清单',
  enabled: '启用',
  bridgeUrl: '桥地址',
  selfUid: '自己的 uid',
  adminUids: '管理员 uid',
  ownerUids: '管理员 uid（旧名）',
  defaultTarget: '默认发送目标',
  blocked: '黑名单',
  allowed: '白名单',
  mappings: '对话映射',
  pollMs: '轮询间隔（毫秒）',
  maxPerTick: '每轮最多',
  tickMinutes: '轮询间隔（分钟）',
  maxQueue: '队列上限',
  keepUids: '保留的 uid',
  notifyTopic: '通知频道',
  notifyEveryMinutes: '通知间隔（分钟）',
  notifyMax: '最多通知次数',
  autoStartShell: '自动拉起 NapCat',
  defaultTopic: '默认频道',
  preset: '绑定的预设',
  session: '绑定的对话',
  port: '端口',
  intervalMinutes: '检查间隔（分钟）',
  machineId: '机器标识',
  checkIntervalMinutes: '心跳间隔（分钟）',
  dshPort: 'dsh 端口',
  ntfyTopic: 'ntfy 频道',
  searchProvider: '搜索 provider',
  fetchProvider: '抓取 provider',
}

const specOf = (entry) => {
  const n = entry.options && entry.options.name
  if (typeof n === 'string') return n
  if (n && typeof n === 'object') return n.name || n.id || ''
  return ''
}

const isXykpSpec = (spec) => spec === 'dsh-xykp' || spec.startsWith('dsh-xykp/')

const isXykpRow = (entry) => {
  const spec = specOf(entry)
  return isXykpSpec(spec) && spec !== 'dsh-xykp' && entry.options.id !== 'xykp-console'
}

const moduleOf = (spec) => {
  const rest = spec.replace(/^dsh-xykp\/?/, '')
  const head = rest.split('/')[0] || 'ui'
  return rest.includes('/') ? head : 'ui'
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// 收集一段配置里出现过的所有键（含嵌套、含对象数组里的键）
const walkKeys = (value, out = new Set()) => {
  if (Array.isArray(value)) {
    for (const v of value) walkKeys(v, out)
    return out
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k)
      walkKeys(v, out)
    }
  }
  return out
}

export function apply(ctx) {
  const logger = ctx.logger('xykp-console')
  const homeDir = () => {
    const pc = ctx.profileContext
    const dir = pc && pc.dir ? pc.dir : 'D:/AI/DeepseekHarness/home/profiles/web'
    return join(dir, '..', '..')
  }
  const storePath = () => join(homeDir(), 'xykp', 'config.yml')
  const labelsPath = () => join(homeDir(), 'xykp', 'labels.yml')

  const loadLabels = () => {
    try {
      const parsed = yaml.load(readFileSync(labelsPath(), 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (e) {
      return {}
    }
  }
  const saveLabels = (data) => {
    const p = labelsPath()
    mkdirSync(dirname(p), { recursive: true })
    const tmp = p + '.tmp'
    writeFileSync(tmp, yaml.dump(data, { lineWidth: 120, noRefs: true }), 'utf8')
    renameSync(tmp, p)
  }
  // labels.yml 结构：{ <行 id>: { title: 显示名, fields: { <key>: 显示名 } } }
  // 兼容旧版直接写字符串的形式。
  const labelEntry = (labels, id) => {
    const v = labels[id]
    if (typeof v === 'string') return { title: v, fields: {} }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return {
        title: typeof v.title === 'string' ? v.title : '',
        fields: v.fields && typeof v.fields === 'object' && !Array.isArray(v.fields) ? { ...v.fields } : {},
      }
    }
    return { title: '', fields: {} }
  }

  const loadStore = () => {
    try {
      const parsed = yaml.load(readFileSync(storePath(), 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (e) {
      return {}
    }
  }
  const saveStore = (data) => {
    const p = storePath()
    mkdirSync(dirname(p), { recursive: true })
    const tmp = p + '.tmp'
    writeFileSync(tmp, yaml.dump(data, { lineWidth: 120, noRefs: true }), 'utf8')
    renameSync(tmp, p)
  }

  const rowsList = () => [...ctx.configEditor.entries()].filter(isXykpRow)

  // 第一次跑 / 新增插件：把当前运行时的配置补进总文件
  const bootstrap = () => {
    const data = loadStore()
    let changed = false
    for (const entry of rowsList()) {
      const id = entry.options.id
      if (!(id in data)) {
        data[id] = entry.options.config ?? {}
        changed = true
      }
    }
    if (changed) saveStore(data)
  }

  try {
    bootstrap()
  } catch (error) {
    logger.warn('初始化 config.yml 失败：' + String((error && error.message) || error))
  }

  // 一次性把内置中文名搬进 labels.yml：之后默认显示英文（行 id / 字段 key），
  // 新插件不会出现「默认英文、老插件中文」的割裂。
  const seedLabels = () => {
    const SEED = 2
    const labels = loadLabels()
    if (labels.__seed === SEED) return
    const data = loadStore()
    for (const entry of rowsList()) {
      const id = entry.options.id
      const cur = labelEntry(labels, id)
      const meta = META[id] || {}
      if (!cur.title && meta.title) cur.title = meta.title
      const cfg = id in data ? data[id] : entry.options.config ?? {}
      for (const key of walkKeys(cfg)) {
        if (FIELDS[key] && !cur.fields[key]) cur.fields[key] = FIELDS[key]
      }
      labels[id] = cur
    }
    labels.__seed = SEED
    saveLabels(labels)
  }
  try {
    seedLabels()
  } catch (error) {
    logger.warn('初始化 labels.yml 失败：' + String((error && error.message) || error))
  }

  // 各插件自己在 apply 开头用 ui/store.js 的 configFor() 读这个文件，
  // 所以启动时就是最终值，这里不需要再同步/重启一轮。

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  const route = (path, handler) => {
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try {
            await handler(req, res)
          } catch (error) {
            try {
              send(res, 500, { ok: false, error: String((error && error.message) || error) })
            } catch {}
          }
        },
      }),
    )
  }

  const collect = () => {
    const data = loadStore()
    const labels = loadLabels()
    const conf = new Map(
      (ctx.configEditor.configuration() || []).map((row) => [row.entry.options.id, row]),
    )
    const rows = []
    for (const entry of rowsList()) {
      const id = entry.options.id
      const spec = specOf(entry)
      const meta = META[id] || {}
      const lab = labelEntry(labels, id)
      const inherited = (conf.get(id) || {}).inherited || {}
      const stored = id in data ? data[id] : entry.options.config ?? {}
      rows.push({
        id,
        spec,
        module: moduleOf(spec),
        group: GROUPS[moduleOf(spec)] || '其它',
        title: lab.title || id,
        fields: lab.fields,
        desc: meta.desc || '',
        note: meta.note || '',
        disabled: entry.options.disabled === true,
        config: stored,
        inherited,
        override: !same(stored, inherited),
      })
    }
    const order = ['storage', 'chat', 'comms', 'senses', 'observer', 'ui']
    rows.sort(
      (a, b) =>
        order.indexOf(moduleOf(a.spec)) - order.indexOf(moduleOf(b.spec)) || a.id.localeCompare(b.id),
    )
    return rows
  }

  route('/xykp-console/rows', async (req, res) => {
    send(res, 200, { ok: true, rows: collect(), fields: FIELDS, documentPath: storePath() })
  })

  route('/xykp-console/save', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method' })
    const body = await readBody(req)
    const id = String(body.id || '')
    if (!id) return send(res, 400, { ok: false, error: 'missing id' })
    const entry = rowsList().find((e) => e.options.id === id)
    if (!entry) return send(res, 404, { ok: false, error: '未知的行：' + id })

    const next = body.config
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      return send(res, 400, { ok: false, error: 'config 必须是一个对象' })
    }

    try {
      const data = loadStore()
      data[id] = next
      saveStore(data)
      await entry.update({ config: next })
    } catch (error) {
      return send(res, 400, { ok: false, error: String((error && error.message) || error) })
    }
    send(res, 200, { ok: true, rows: collect() })
  })

  route('/xykp-console/reset', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method' })
    const body = await readBody(req)
    const id = String(body.id || '')
    const entry = rowsList().find((e) => e.options.id === id)
    if (!entry) return send(res, 404, { ok: false, error: '未知的行：' + id })
    const conf = new Map(
      (ctx.configEditor.configuration() || []).map((row) => [row.entry.options.id, row]),
    )
    const inherited = (conf.get(id) || {}).inherited || {}
    try {
      const data = loadStore()
      delete data[id]
      saveStore(data)
      await entry.update({ config: inherited })
      const fresh = loadStore()
      fresh[id] = inherited
      saveStore(fresh)
    } catch (error) {
      return send(res, 400, { ok: false, error: String((error && error.message) || error) })
    }
    send(res, 200, { ok: true, rows: collect() })
  })

  // 左边列表的显示名（只存 labels.yml，不影响插件实际配置）
  route('/xykp-console/label', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method' })
    const body = await readBody(req)
    const id = String(body.id || '')
    if (!id) return send(res, 400, { ok: false, error: 'missing id' })
    if (!rowsList().some((e) => e.options.id === id)) return send(res, 404, { ok: false, error: '未知的行：' + id })
    const field = String(body.field || '').trim()
    const title = String(body.title || '').trim()
    try {
      const labels = loadLabels()
      const cur = labelEntry(labels, id)
      if (field) {
        if (title) cur.fields[field] = title
        else delete cur.fields[field]
      } else {
        cur.title = title
      }
      if (!cur.title && Object.keys(cur.fields).length === 0) delete labels[id]
      else labels[id] = cur
      saveLabels(labels)
    } catch (error) {
      return send(res, 400, { ok: false, error: String((error && error.message) || error) })
    }
    send(res, 200, { ok: true, rows: collect() })
  })

  logger.info('插件配置控制台已挂载：' + storePath())
}
