// qq-adapter · 浏览器端：在「设置 → 插件」里加一页 QQ 通道
//
// 宿主那半边（lib/index.js）已经把 Config 暴露成 settings 命名空间了，
// 这里只做三件事：
//   1. 把两个实例（qq-adapter / qq-adapter-whale）的配置读出来渲染
//   2. 允许改标量字段（bridgeUrl / defaultTarget / selfUid / mode / 前缀…）
//   3. 允许改数组字段（blocked / allowed / mappings，按 JSON 编辑）
// 所有写入都走 ctx.configForms（宿主校验 + 落配置层），不自己写文件。
//
// 这个文件是「已经打包好」的形状：window.__ModuleLoader__.load({ id, factory })。
// 不要写成 ESM，浏览器侧靠 factory(require) 拿依赖。

window.__ModuleLoader__.load({
  id: 'dsh-qq-adapter',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement
    const module = { exports: {} }
    const exports = module.exports

    const NAMESPACES = [
      { ns: 'qq-adapter', title: 'QQ 通道 · 鲸鱼娘 2909433072（39273）', prefix: 'qq_' },
    ]

    const SCALARS = [
      ['enabled', '启用（不启用就只保留工具）', 'boolean'],
      ['bridgeUrl', '桥地址', 'string'],
      ['selfUid', '自己的 uid（自己的消息不转发）', 'string'],
      ['defaultTarget', '默认目标（p-预设 / s-会话id）', 'string'],
      ['mode', '名单模式（blacklist / whitelist）', 'string'],
      ['toolPrefix', '工具名前缀', 'string'],
      ['deliverMode', '投递方式（steer 插队 / followup 排队）', 'string'],
      ['pollMs', '轮询间隔（毫秒）', 'number'],
      ['skipBacklog', '启动时跳过积压', 'boolean'],
      ['autoStartShell', '桥挂了自动拉起壳', 'boolean'],
      ['notifyTopic', '登录失效时推二维码的 ntfy 主题', 'string'],
      ['notifyEveryMinutes', '推码间隔（分钟）', 'number'],
      ['notifyMax', '最多推几次', 'number'],
    ]

    const ARRAYS = [
      ['ownerUids', '能发管理指令的人（每行一个 u-…）'],
      ['blocked', '禁用的私聊/群聊（每行一个 u-… / g-…）'],
      ['allowed', '启用的私聊/群聊（白名单模式用）'],
      ['mappings', '自定义映射（每行：u-uid → p-预设 或 s-会话id）'],
    ]

    const css = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '820px' },
      card: { border: '1px solid var(--dsw-alias-border-l2, #333)', borderRadius: '10px', padding: '14px 16px' },
      title: { fontSize: '15px', fontWeight: 600, margin: '0 0 10px' },
      row: { display: 'grid', gridTemplateColumns: '260px 1fr', gap: '10px', alignItems: 'center', marginBottom: '8px' },
      label: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #aaa)' },
      input: { width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2, #444)', background: 'transparent', color: 'inherit', fontSize: '13px' },
      area: { width: '100%', minHeight: '64px', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2, #444)', background: 'transparent', color: 'inherit', fontSize: '13px', fontFamily: 'ui-monospace, monospace' },
      btn: { padding: '6px 14px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2, #444)', background: 'var(--dsw-alias-bg-l2, #222)', color: 'inherit', cursor: 'pointer', fontSize: '13px' },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #888)', margin: '6px 0 0' },
      err: { fontSize: '12px', color: '#e8604a', margin: '6px 0 0' },
    }

    function arrowOfLine(line) {
      const m = String(line).split(/->|→|:/).map((s) => s.trim()).filter(Boolean)
      if (m.length < 2) return null
      return { chat: m[0], target: m[1] }
    }

    function lineOfArrow(m) {
      return String(m?.chat || '') + ' → ' + String(m?.target || '')
    }

    function InstanceCard(props) {
      const { spec, form } = props
      const [, force] = react.useReducer((n) => n + 1, 0)
      const [busy, setBusy] = react.useState(false)
      const [notice, setNotice] = react.useState('')
      const [draft, setDraft] = react.useState({})

      react.useEffect(() => form.subscribe(() => force()), [form])

      const snap = form.getSnapshot()
      const value = (snap && snap.value) || {}
      const status = snap?.status || 'loading'
      const writable = snap?.writable !== false

      const get = (key) => {
        if (Object.prototype.hasOwnProperty.call(draft, key)) return draft[key]
        const v = value[key]
        if (Array.isArray(v)) {
          return key === 'mappings' ? v.map(lineOfArrow).join('\n') : v.join('\n')
        }
        return v === undefined || v === null ? '' : String(v)
      }

      const editField = (key, v) => setDraft((d) => ({ ...d, [key]: v }))

      async function save() {
        if (busy) return
        setBusy(true)
        setNotice('')
        const failed = []
        try {
          for (const [key, , kind] of SCALARS) {
            if (!Object.prototype.hasOwnProperty.call(draft, key)) continue
            let v = draft[key]
            if (kind === 'boolean') v = String(v) === 'true'
            else if (kind === 'number') v = Number(v) || 0
            try {
              const ok = await form.set(key, v)
              if (ok !== true) failed.push(key)
            } catch (e) { failed.push(key + '(' + (e?.message || 'err') + ')') }
          }
          for (const [key] of ARRAYS) {
            if (!Object.prototype.hasOwnProperty.call(draft, key)) continue
            const lines = String(draft[key] || '').split('\n').map((s) => s.trim()).filter(Boolean)
            const arr = key === 'mappings' ? lines.map(arrowOfLine).filter(Boolean) : lines
            try {
              const ok = await form.set(key, arr)
              if (ok !== true) failed.push(key)
            } catch (e) { failed.push(key + '(' + (e?.message || 'err') + ')') }
          }
          setNotice(failed.length ? '没写进去：' + failed.join('、') : '已保存 ✓')
          if (!failed.length) setDraft({})
        } finally {
          setBusy(false)
        }
      }

      if (status === 'unavailable') {
        return h('div', { style: css.card },
          h('h3', { style: css.title }, spec.title),
          h('p', { style: css.hint }, '宿主没有暴露这个命名空间（' + spec.ns + '），说明这份配置现在不是可编辑状态。'))
      }

      return h('div', { style: css.card },
        h('h3', { style: css.title }, spec.title),
        h('p', { style: css.hint }, '命名空间 ' + spec.ns + ' · 状态 ' + status + (writable ? '' : ' · 只读')),
        SCALARS.map(([key, label, kind]) => {
          const v = get(key)
          if (kind === 'boolean') {
            return h('div', { key, style: css.row },
              h('span', { style: css.label }, label),
              h('select', {
                style: css.input,
                value: String(v) === 'true' ? 'true' : 'false',
                disabled: !writable,
                onChange: (e) => editField(key, e.target.value),
              }, h('option', { value: 'true' }, '开'), h('option', { value: 'false' }, '关')))
          }
          return h('div', { key, style: css.row },
            h('span', { style: css.label }, label),
            h('input', {
              style: css.input,
              value: v,
              disabled: !writable,
              onChange: (e) => editField(key, e.target.value),
            }))
        }),
        ARRAYS.map(([key, label]) => h('div', { key, style: { marginTop: '10px' } },
          h('div', { style: css.label }, label),
          h('textarea', {
            style: css.area,
            value: get(key),
            disabled: !writable,
            onChange: (e) => editField(key, e.target.value),
          }))),
        h('div', { style: { marginTop: '12px', display: 'flex', gap: '10px', alignItems: 'center' } },
          h('button', { style: css.btn, onClick: save, disabled: busy || !writable }, busy ? '保存中…' : '保存'),
          notice ? h('span', { style: notice.startsWith('已保存') ? css.hint : css.err }, notice) : null),
        h('p', { style: css.hint }, '映射一行一个：' + ' u-<uid> → p-alive'))
    }

    function Section() {
      return h('div', { style: css.wrap },
        h('p', { style: css.hint },
          '两个 QQ 壳的配置都在这里改：樱（端口 39272，工具前缀 qq_）和鲸鱼娘（端口 39273，前缀 qq2_）。改完点保存，宿主立刻生效。'),
        h(CardList))
    }

    function CardList() {
      const forms = react.useMemo(() => NAMESPACES.map((spec) => ({
        spec,
        form: window.__qqAdapterForms && window.__qqAdapterForms[spec.ns],
      })), [])
      const missing = forms.filter((x) => !x.form)
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
        forms.filter((x) => x.form).map(({ spec, form }) => h(InstanceCard, { key: spec.ns, spec, form })),
        missing.length
          ? h('p', { style: css.hint }, '还没接上的命名空间：' + missing.map((x) => x.spec.ns).join('、'))
          : null)
    }

    const inject = ['slots', 'locale', 'configForms']

    function apply(ctx) {
      // 把两个命名空间的 form 挂到 window 上，Section 里就不用再碰 ctx
      window.__qqAdapterForms = window.__qqAdapterForms || {}
      for (const spec of NAMESPACES) {
        try { window.__qqAdapterForms[spec.ns] = ctx.configForms.get(spec.ns) } catch (e) { /* 没有就算了 */ }
      }
      // 不套 whileServed：命名空间对不上时页面也要能露出来，好让人看见「没接上」而不是整页消失
      ctx.effect(() => ctx.slots.inject('plugins.item', () => ctx.slots.register({
        name: 'plugins.item',
        id: 'qq-adapter',
        order: 40,
        label: () => 'QQ 通道',
        inject: () => ({}),
      }, Section)))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
