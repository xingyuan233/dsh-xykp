// dsh-xykp · 客户端半边（会话永久删除 UI + xykp 配置控制台）
window.__ModuleLoader__.load({
  id: 'dsh-xykp',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const inject = ['slots', 'locale', 'remote', 'sessions']

    // ===== 合并自 storage/session-delete 的浏览器端 UI（2026-10-27）=====
    // 为什么合并：client bundle 只按包名加载，子路径插件（dsh-xykp/storage/xxx）不会触发
    // 自己的 client.js，所以 UI 必须都放进这一个文件。
    var sessionDeleteUI = (function () {
    "use strict";

    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    /** 插件包名（同时是客户端模块 id）。 */
    var PLUGIN_ID = "dsh-session-delete";
    /** 词条命名空间。 */
    var NS = "sessionDelete";
    /** Remote 命名空间，必须与宿主 SessionDeleteService 的服务键一致。 */
    var REMOTE_NS = "sessionDelete";

    //#region Remote 契约（与宿主 lib/index.js 的 deleteSession 逐字对齐）
    /** 极简校验器：只实现远端 codec 约定的 parse 形状。 */
    function vString(min, max) {
      return {
        parse: function (value) {
          if (typeof value !== "string" || value.length < min || value.length > max) {
            throw new TypeError("期望长度在 " + min + "~" + max + " 之间的字符串");
          }
          return value;
        },
      };
    }
    function vBoolean() {
      return {
        parse: function (value) {
          if (typeof value !== "boolean") throw new TypeError("期望布尔值");
          return value;
        },
      };
    }
    function vObject(shape) {
      return {
        parse: function (value) {
          if (value === null || typeof value !== "object" || Array.isArray(value)) {
            throw new TypeError("期望对象");
          }
          var out = {};
          for (var key of Object.keys(shape)) out[key] = shape[key].parse(value[key]);
          return out;
        },
      };
    }
    /** deleteSession 的返回值：{ deleted, deferred, sessionId }。 */
    var deleteResultSchema = vObject({
      deleted: vBoolean(),
      deferred: vBoolean(),
      sessionId: vString(1, 200),
    });
    /** 参数校验：会话 id 只允许安全字符（与宿主同一规则）。 */
    var sessionIdSchema = vString(1, 200);

    function strictCodec(typeSymbol, schema) {
      return { mode: "strict", typeSymbol: typeSymbol, create: () => schema, schema: schema };
    }

    var DESCRIPTORS = [
      {
        id: PLUGIN_ID + "#" + REMOTE_NS + "/deleteSession",
        service: REMOTE_NS,
        namespace: REMOTE_NS,
        method: "deleteSession",
        invocation: { kind: "direct" },
        parameters: [
          {
            name: "sessionId",
            wire: "sessionId",
            source: "json",
            codec: strictCodec("string", sessionIdSchema),
          },
        ],
        result: strictCodec("SessionDeleteResult", deleteResultSchema),
      },
    ];
    var REMOTE = { package: PLUGIN_ID, descriptors: DESCRIPTORS };
    //#endregion

    //#region 词条（zh 为键集真相源，en 逐键对齐）
    var zh = {
      "menu.deleteSession": "永久删除会话",
      "dialog.title": "永久删除会话？",
      "dialog.desc": "「{title}」的聊天记录会从磁盘上永久删除，无法恢复。",
      "dialog.warning": "此操作不可撤销；如果只是不想在侧栏看到它，请改用「归档会话」。",
      "dialog.cancel": "取消",
      "dialog.confirm": "永久删除",
      "dialog.pending": "正在删除…",
      "dialog.openInView": "这个会话正在主界面打开，请先切换到其他会话再删除。",
      "toast.deleted": "会话已永久删除",
      "toast.deferred": "会话已归档；重启 dsh web 后会完成磁盘清理",
    };
    var en = {
      "menu.deleteSession": "Delete conversation permanently",
      "dialog.title": "Delete this conversation permanently?",
      "dialog.desc": "The chat history of “{title}” will be removed from disk. This cannot be undone.",
      "dialog.warning": "This action cannot be undone. If you only want to hide it, use Archive instead.",
      "dialog.cancel": "Cancel",
      "dialog.confirm": "Delete permanently",
      "dialog.pending": "Deleting…",
      "dialog.openInView": "This conversation is open in the main view. Switch to another conversation before deleting it.",
      "toast.deleted": "Conversation permanently deleted",
      "toast.deferred": "Conversation archived; disk cleanup finishes after dsh web restarts",
    };
    //#endregion

    /** 删除确认框和提示条共用的最小状态容器（模块内闭包，随插件实例销毁）。 */
    function createDeleteStore() {
      var listeners = new Set();
      var pending = null;
      var toast = null;
      var seq = 0;
      function emit() {
        for (var listener of Array.from(listeners)) listener();
      }
      return {
        subscribe: function (listener) {
          listeners.add(listener);
          return function () {
            listeners.delete(listener);
          };
        },
        getPending: function () {
          return pending;
        },
        request: function (sessionId, displayTitle) {
          pending = { sessionId: sessionId, displayTitle: displayTitle };
          emit();
        },
        settle: function () {
          pending = null;
          emit();
        },
        getToast: function () {
          return toast;
        },
        dismissToast: function () {
          toast = null;
          emit();
        },
        raise: function (text, tone, holdMs) {
          seq += 1;
          toast = { seq: seq, text: text, tone: tone, holdMs: holdMs };
          emit();
        },
      };
    }

    /** 把错误折叠成一行可读文本。 */
    function messageOf(cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }

    /** RemoteResult 解包：{ok:true,value} | {ok:false,error}。 */
    function unwrap(result) {
      if (result !== null && result !== undefined && result.ok === true) return result.value;
      var detail =
        result !== null && result !== undefined && result.error !== null && result.error !== undefined
          ? result.error.message
          : "未知的 Remote 错误";
      var error = new Error(detail);
      if (result !== null && result !== undefined && result.error != null && result.error.code != null) {
        error.code = result.error.code;
      }
      throw error;
    }

    //#region 组件
    /**
     * 菜单项：点击后关闭菜单并请求删除。
     * 宿主把 `requestDelete` 通过 registration 的 inject 工厂注入。
     */
    function DeleteSessionMenuItem(props) {
      var sessionId = props.sessionId;
      var displayTitle = props.displayTitle;
      var setMenuOpen = props.useMenuOpenState()[1];
      var requestDelete = props.requestDelete;
      var t = props.t;
      return React.createElement(
        primitives.MenuItemButton,
        {
          separatorBefore: true,
          icon: React.createElement(primitives.IconTrashOutlineRegular, { size: 14 }),
          onSelect: function () {
            setMenuOpen(false);
            requestDelete(sessionId, displayTitle);
          },
        },
        t("menu.deleteSession"),
      );
    }

    /**
     * 确认框（shell.overlay 条目）：没有待确认请求时渲染 null。
     * 确认后调用宿主删除；宿主拒绝时把错误留在弹窗里。
     */
    function DeleteSessionDialog(props) {
      var pending = React.useSyncExternalStore(props.store.subscribe, props.store.getPending);
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var t = props.t;

      if (pending === null) return null;

      var close = function () {
        if (busy) return;
        setError(null);
        props.settle();
      };
      var confirm = function () {
        if (busy) return;
        setBusy(true);
        setError(null);
        props
          .deleteSession(pending.sessionId)
          .then(function () {
            setBusy(false);
            props.settle();
          })
          .catch(function (cause) {
            setBusy(false);
            setError(messageOf(cause));
          });
      };

      return React.createElement(
        primitives.Modal,
        {
          open: true,
          onClose: close,
          closeLabel: t("dialog.cancel"),
          title: t("dialog.title"),
          description: t("dialog.desc", { title: pending.displayTitle }),
          footer: React.createElement(
            React.Fragment,
            null,
            React.createElement(
              primitives.Button,
              { variant: "outline", disabled: busy, onClick: close },
              t("dialog.cancel"),
            ),
            React.createElement(
              primitives.Button,
              { variant: "outline", className: "sd-danger", disabled: busy, onClick: confirm },
              t("dialog.confirm"),
            ),
          ),
        },
        React.createElement("p", { className: "sd-note" }, t("dialog.warning")),
        busy
          ? React.createElement("div", { className: "sd-status", role: "status" }, t("dialog.pending"))
          : null,
        error !== null
          ? React.createElement("div", { className: "sd-error", role: "alert" }, error)
          : null,
      );
    }

    /** 结果提示条（shell.overlay 条目）。 */
    function DeleteSessionToast(props) {
      var toast = React.useSyncExternalStore(props.store.subscribe, props.store.getToast);
      if (toast === null) return null;
      return React.createElement(primitives.Toast, {
        key: toast.seq,
        text: toast.text,
        onDone: props.dismissToast,
        ...(toast.tone === "success" ? { tone: "success" } : {}),
        ...(toast.tone === "warning"
          ? { icon: React.createElement(primitives.IconWarningOutlineRegular, {}) }
          : {}),
        ...(toast.holdMs === undefined ? {} : { holdMs: toast.holdMs }),
      });
    }
    //#endregion

    //#region 样式
    var CSS =
      ".sd-danger:not(:disabled){color:var(--dsw-alias-state-error-primary)}" +
      ".sd-note{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;margin:0 0 8px}" +
      ".sd-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}" +
      ".sd-error{color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px;margin-top:8px}";
    //#endregion

    //#region 客户端入口
    var inject = ["slots", "locale", "remote", "sessions"];

    /**
     * 客户端入口。
     * @param ctx - 客户端根 Context。
     * @returns 卸载函数（只回收 Remote 挂载；样式/词条/slot 由宿主 fiber 回收）。
     */
    async function apply(ctx) {
      ctx.effect(function () {
        var tag = document.createElement("style");
        tag.dataset.plugin = PLUGIN_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return function () {
          tag.remove();
        };
      }, "dsh-session-delete: style");

      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "dsh-session-delete: dictionaries");
      var t = ctx.locale.bind(NS);

      // 命名空间是独立 cordis 服务：先挂载再 ctx.get()，不能直接读 ctx.remote.xxx。
      var disposeRemote = await ctx.remote.$mount(REMOTE);
      var remote = ctx.get("remote." + REMOTE_NS);
      if (remote === undefined) throw new Error("dsh-session-delete: Remote 挂载后不可用");

      var store = createDeleteStore();

      /** 宿主删除完成后的列表刷新；失败只记日志，不影响删除结果。 */
      async function refreshSessions() {
        try {
          await ctx.sessions.refresh();
        } catch (error) {
          console.warn("[dsh-session-delete] 刷新会话列表失败：", error);
        }
      }

      /**
       * 执行删除：主界面正打开该会话时拒绝（避免主视图停留在已删除的会话上）。
       * @param sessionId - 目标会话。
       * @returns 宿主返回的 { deleted, deferred, sessionId }。
       */
      async function deleteSession(sessionId) {
        var retained = 0;
        try {
          var info = ctx.sessions.retainInfo(sessionId);
          retained = info.getSnapshot().referenceCount;
        } catch (error) {
          retained = 0;
        }
        if (retained > 0) throw new Error(t("dialog.openInView"));

        var result = unwrap(await remote.deleteSession(sessionId));
        await refreshSessions();
        if (result !== null && result !== undefined && result.deferred === true) {
          store.raise(t("toast.deferred"), "warning", 6000);
        } else {
          store.raise(t("toast.deleted"), "success", 4000);
        }
        return result;
      }

      // 会话行「…」菜单：永久删除。
      ctx.slots.inject("sidebar.workspaces.session.menu.item", function () {
        return ctx.slots.register(
          {
            name: "sidebar.workspaces.session.menu.item",
            id: "session-delete",
            order: 500,
            locale: NS,
            inject: function () {
              return {
                requestDelete: function (sessionId, displayTitle) {
                  store.request(sessionId, displayTitle);
                },
              };
            },
          },
          DeleteSessionMenuItem,
        );
      });

      // 浮层：确认框 + 结果提示条。
      ctx.slots.inject("shell.overlay", function* () {
        yield ctx.slots.register(
          {
            name: "shell.overlay",
            id: "session-delete.dialog",
            locale: NS,
            inject: function () {
              return { store: store, settle: store.settle, deleteSession: deleteSession };
            },
          },
          DeleteSessionDialog,
        );
        yield ctx.slots.register(
          {
            name: "shell.overlay",
            id: "session-delete.toast",
            locale: NS,
            inject: function () {
              return { store: store, dismissToast: store.dismissToast };
            },
          },
          DeleteSessionToast,
        );
      });

      return function () {
        void disposeRemote();
      };
    }
    //#endregion

    exports.inject = inject;
    exports.apply = apply;
    exports.DESCRIPTORS = DESCRIPTORS;
    exports.REMOTE = REMOTE;
      return { apply: apply, inject: inject };
    })();


    // ─────────────────────────────────────────────────────────────
    // 插件配置控制台：设置 → 插件配置
    //   左栏：dsh-xykp 的子插件（按模块分组）
    //   右栏：选中行的配置，按值类型渲染成可编辑控件
    // 宿主半边是 ui/console/index.js（/xykp-console/*）。
    // ─────────────────────────────────────────────────────────────
    const XS = {
      wrap: { display: 'flex', gap: 0, flex: 1, minHeight: 0, alignItems: 'stretch', overflow: 'hidden' },
      left: {
        overflow: 'auto',
        overscrollBehavior: 'contain',
        minHeight: 0,
        height: '100%',
        paddingRight: 8,
      },
      divider: {
        flex: '0 0 9px',
        width: 9,
        cursor: 'col-resize',
        alignSelf: 'stretch',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'stretch',
        background: 'transparent',
      },
      dividerLine: {
        width: 3,
        borderRadius: 2,
        background: 'rgba(127,127,127,.22)',
        margin: '2px 0',
      },
      right: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        height: '100%',
        overflow: 'auto',
        overscrollBehavior: 'contain',
        paddingLeft: 6,
        paddingRight: 4,
      },
      group: {
        fontSize: 11,
        letterSpacing: 0.4,
        opacity: 0.55,
        margin: '10px 0 4px 2px',
      },
      item: (on) => ({
        padding: '6px 8px',
        marginBottom: 2,
        borderRadius: 6,
        cursor: 'pointer',
        background: on ? 'rgba(120,170,255,.16)' : 'transparent',
        border: on ? '1px solid rgba(120,170,255,.45)' : '1px solid transparent',
      }),
      inp: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 8px',
        borderRadius: 6,
        border: '1px solid rgba(127,127,127,.35)',
        background: 'rgba(127,127,127,.08)',
        color: 'inherit',
        font: 'inherit',
        fontSize: 13,
      },
      mono: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 8px',
        borderRadius: 6,
        border: '1px solid rgba(127,127,127,.35)',
        background: 'rgba(127,127,127,.08)',
        color: 'inherit',
        fontFamily: 'ui-monospace, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.45,
        resize: 'vertical',
      },
      label: { fontSize: 12, fontWeight: 550, marginBottom: 3, opacity: 0.92 },
      hint: { fontSize: 11, opacity: 0.5, marginTop: 2 },
      fieldRow: { marginBottom: 12 },
      btn: {
        padding: '4px 9px',
        borderRadius: 6,
        border: '1px solid rgba(127,127,127,.35)',
        background: 'rgba(127,127,127,.1)',
        color: 'inherit',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      btnMain: {
        padding: '5px 12px',
        borderRadius: 6,
        border: '1px solid rgba(120,170,255,.6)',
        background: 'rgba(120,170,255,.2)',
        color: 'inherit',
        font: 'inherit',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
      },
      badge: {
        fontSize: 11,
        padding: '1px 6px',
        borderRadius: 999,
        border: '1px solid rgba(127,127,127,.35)',
        opacity: 0.85,
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        paddingBottom: 8,
        marginBottom: 10,
        borderBottom: '1px solid rgba(127,127,127,.2)',
      },
      groupBox: {
        border: '1px solid rgba(127,127,127,.22)',
        borderRadius: 8,
        padding: '8px 10px',
        marginBottom: 10,
        background: 'rgba(127,127,127,.045)',
      },
      rowCard: {
        border: '1px solid rgba(127,127,127,.22)',
        borderRadius: 7,
        marginBottom: 6,
        background: 'rgba(127,127,127,.05)',
        overflow: 'hidden',
      },
      rowHead: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px' },
      rowBody: { padding: '6px 10px 8px', borderTop: '1px solid rgba(127,127,127,.16)' },
      chev: {
        background: 'none',
        border: 'none',
        color: 'inherit',
        opacity: 0.7,
        cursor: 'pointer',
        width: 18,
        padding: 0,
        fontSize: 12,
      },
      nameInput: {
        width: 190,
        padding: '2px 6px',
        borderRadius: 5,
        border: '1px solid rgba(127,127,127,.3)',
        background: 'rgba(127,127,127,.06)',
        color: 'inherit',
        font: 'inherit',
        fontFamily: 'ui-monospace, Consolas, monospace',
        fontSize: 12,
      },
    }

    const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
    const isPrim = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    const isPrimArr = (v) => Array.isArray(v) && v.length > 0 && v.every(isPrim)
    const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

    function ConsoleSection() {
      const [rows, setRows] = React.useState(null)
      const [fieldLabels, setFieldLabels] = React.useState({})
      const [docPath, setDocPath] = React.useState('')
      const [sel, setSel] = React.useState('')
      const [draft, setDraft] = React.useState(null)
      const [base, setBase] = React.useState(null)
      const [texts, setTexts] = React.useState({})
      const [errs, setErrs] = React.useState({})
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const [bad, setBad] = React.useState(false)
      const [rawMode, setRawMode] = React.useState(false)
      const [rawText, setRawText] = React.useState('')
      const [query, setQuery] = React.useState('')
      const boxRef = React.useRef(null)
      const kindsRef = React.useRef({})
      const [leftW, setLeftW] = React.useState(() => {
        try {
          const v = Number(localStorage.getItem('xykp.console.leftW'))
          if (v >= 150 && v <= 460) return v
        } catch (e) {}
        return 200
      })
      const [viewH, setViewH] = React.useState(0)
      const [openPaths, setOpenPaths] = React.useState({})
      const [nameDrafts, setNameDrafts] = React.useState({})
      const [editingName, setEditingName] = React.useState('')
      const [editingLeft, setEditingLeft] = React.useState('')
      const [leftDraft, setLeftDraft] = React.useState('')
      const [editingField, setEditingField] = React.useState('')
      const [fieldDraft, setFieldDraft] = React.useState('')

      // 让两栏铺满设置/插件页内容区（而不是固定 60vh 截断）。
      // 注意：直接父节点可能只是插槽的壳，高度是 auto；要往上找到真正的滚动容器。
      React.useEffect(() => {
        const el = boxRef.current
        if (!el) return
        const findScroller = () => {
          let p = el.parentElement
          while (p && p !== document.body) {
            const cs = window.getComputedStyle(p)
            if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && p.clientHeight > 120) return p
            p = p.parentElement
          }
          return null
        }
        const calc = () => {
          const target = findScroller()
          let h = 0
          if (target) {
            const cs = window.getComputedStyle(target)
            const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
            h = target.clientHeight - pad - 12
          } else {
            const r = el.getBoundingClientRect()
            h = window.innerHeight - r.top - 24
          }
          if (h > 160) setViewH(Math.max(300, h))
        }
        calc()
        let ro = null
        if (typeof ResizeObserver !== 'undefined') {
          ro = new ResizeObserver(calc)
          ro.observe(document.body)
          const t = findScroller()
          if (t) ro.observe(t)
        }
        window.addEventListener('resize', calc)
        return () => {
          if (ro) ro.disconnect()
          window.removeEventListener('resize', calc)
        }
      }, [])

      const startDrag = (e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const startX = e.clientX
        const startW = leftW
        const move = (ev) => setLeftW(Math.min(460, Math.max(150, startW + ev.clientX - startX)))
        const up = () => {
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
          document.body.style.cursor = ''
          try {
            setLeftW((w) => {
              localStorage.setItem('xykp.console.leftW', String(w))
              return w
            })
          } catch (e2) {}
        }
        document.body.style.cursor = 'col-resize'
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      }

      const applyRows = (list, keepSel) => {
        setRows(list)
        kindsRef.current = {}
        const want = list.some((r) => r.id === (keepSel || sel)) ? keepSel || sel : list[0] && list[0].id
        if (want) {
          const row = list.find((r) => r.id === want)
          setSel(want)
          setDraft(clone(row.config || {}))
          setBase(clone(row.config || {}))
          setTexts({})
          setErrs({})
          setRawMode(false)
        }
      }

      const load = async (keepSel) => {
        setMsg('')
        setBad(false)
        try {
          const r = await fetch('/xykp-console/rows', { cache: 'no-store' }).then((x) => x.json())
          if (!r.ok) throw new Error(r.error || '读取失败')
          setFieldLabels(r.fields || {})
          setDocPath(r.documentPath || '')
          if (!r.rows || r.rows.length === 0) {
            setRows([])
            setMsg('宿主没找到 dsh-xykp 的行，确认 ui/console 已挂上并重启过 dsh web')
            return
          }
          applyRows(r.rows, keepSel)
        } catch (error) {
          setRows([])
          setBad(true)
          setMsg(String((error && error.message) || error))
        }
      }

      React.useEffect(() => {
        load()
      }, [])

      const row = rows && rows.find((r) => r.id === sel)
      const dirty = row && draft && !same(draft, row.config)

      const pick = (id) => {
        const r = rows.find((x) => x.id === id)
        kindsRef.current = {}
        setSel(id)
        setDraft(clone(r.config || {}))
        setBase(clone(r.config || {}))
        setTexts({})
        setErrs({})
        setMsg('')
        setBad(false)
        setRawMode(false)
      }

      const commitLeftName = async (id, original) => {
        const next = String(leftDraft || '').trim()
        setEditingLeft('')
        if (next === original) return
        try {
          const r = await fetch('/xykp-console/label', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, title: next }),
          }).then((x) => x.json())
          if (r.ok) applyRows(r.rows, id)
          else {
            setBad(true)
            setMsg('改名失败：' + (r.error || '未知错误'))
          }
        } catch (error) {
          setBad(true)
          setMsg('改名失败：' + String((error && error.message) || error))
        }
      }

      const setField = (k, v) => {
        setDraft((d) => ({ ...d, [k]: v }))
        setErrs((e) => ({ ...e, [k]: '' }))
      }

      const save = async () => {
        if (!row || busy) return
        if (Object.keys(errs).some((k) => errs[k])) {
          setBad(true)
          return setMsg('还有字段格式不对，先改好再保存')
        }
        setBusy(true)
        setMsg('')
        try {
          const r = await fetch('/xykp-console/save', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: row.id, config: cleanDraft() }),
          }).then((x) => x.json())
          if (!r.ok) {
            setBad(true)
            setMsg('保存失败：' + (r.error || '未知错误'))
          } else {
            setBad(false)
            setMsg('已保存，宿主已重载该插件')
            applyRows(r.rows, row.id)
          }
        } catch (error) {
          setBad(true)
          setMsg('保存失败：' + String((error && error.message) || error))
        }
        setBusy(false)
      }

      const reset = async () => {
        if (!row || busy) return
        setBusy(true)
        setMsg('')
        try {
          const r = await fetch('/xykp-console/reset', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: row.id }),
          }).then((x) => x.json())
          if (!r.ok) {
            setBad(true)
            setMsg('恢复失败：' + (r.error || '未知错误'))
          } else {
            setBad(false)
            setMsg('已恢复成默认值')
            applyRows(r.rows, row.id)
          }
        } catch (error) {
          setBad(true)
          setMsg('恢复失败：' + String((error && error.message) || error))
        }
        setBusy(false)
      }

      const labelOf = (k) => (row && row.fields && row.fields[k]) || k

      const commitFieldLabel = async (k, original) => {
        const next = String(fieldDraft || '').trim()
        setEditingField('')
        if (next === original) return
        try {
          const r = await fetch('/xykp-console/label', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: row.id, field: k, title: next }),
          }).then((x) => x.json())
          if (r.ok) applyRows(r.rows, row.id)
          else {
            setBad(true)
            setMsg('改名失败：' + (r.error || '未知错误'))
          }
        } catch (error) {
          setBad(true)
          setMsg('改名失败：' + String((error && error.message) || error))
        }
      }

      // 字段的「显示名字」：只影响界面文字，不碰字段 key。
      const labelEl = (k, text) => {
        const ek = (row ? row.id : '') + '|' + k
        if (editingField === ek) {
          return React.createElement('input', {
            autoFocus: true,
            value: fieldDraft,
            spellCheck: false,
            onClick: (e) => e.stopPropagation(),
            onChange: (e) => setFieldDraft(e.target.value),
            onBlur: () => commitFieldLabel(k, text),
            onKeyDown: (e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setEditingField('')
            },
            style: { ...XS.inp, width: 150, padding: '1px 5px', fontSize: 12 },
          })
        }
        return React.createElement(
          'span',
          {
            title: '双击改显示名（留空恢复默认）',
            onDoubleClick: (e) => {
              e.stopPropagation()
              setFieldDraft(text)
              setEditingField(ek)
            },
            style: { cursor: 'text' },
          },
          text,
        )
      }
      const pkOf = (path) => path.join('\u0001')
      const getAt = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj)
      const isOpen = (path, def) => (pkOf(path) in openPaths ? !!openPaths[pkOf(path)] : def)
      const toggleOpen = (path) =>
        setOpenPaths((s) => ({ ...s, [pkOf(path)]: !(pkOf(path) in s ? s[pkOf(path)] : false) }))

      const setAt = (path, v) => {
        setDraft((prev) => {
          const copy = clone(prev || {})
          let o = copy
          for (let i = 0; i < path.length - 1; i++) {
            const k = path[i]
            // 数组路径不能按对象重建，否则会把整条列表换成 {"0": {...}}
            if (Array.isArray(o[k])) {
              o = o[k]
              continue
            }
            if (!isPlainObj(o[k])) o[k] = {}
            o = o[k]
          }
          o[path[path.length - 1]] = v
          return copy
        })
        setErrs((e) => ({ ...e, [pkOf(path)]: '' }))
      }

      const delAt = (path) => {
        setDraft((prev) => {
          const copy = clone(prev || {})
          const parent = getAt(copy, path.slice(0, -1))
          if (!parent) return prev
          const last = path[path.length - 1]
          if (Array.isArray(parent)) parent.splice(Number(last), 1)
          else delete parent[last]
          return copy
        })
      }

      const commitName = (parentPath, oldName) => {
        const nk = pkOf(parentPath) + '|' + oldName
        const raw = nameDrafts[nk]
        setNameDrafts((s) => {
          const n = { ...s }
          delete n[nk]
          return n
        })
        if (raw === undefined) return
        const next = String(raw).trim()
        if (!next || next === oldName) return
        setDraft((prev) => {
          const copy = clone(prev || {})
          const parent = getAt(copy, parentPath)
          if (!isPlainObj(parent) || parent[next] !== undefined) return prev
          parent[next] = parent[oldName]
          delete parent[oldName]
          return copy
        })
      }

      const fieldWrap = (path, lab, control, hint, err) =>
        React.createElement(
          'div',
          { key: pkOf(path), style: XS.fieldRow },
          React.createElement(
            'div',
            { style: XS.label },
            labelEl(path[path.length - 1], lab),
            ' ',
            React.createElement('code', { style: { fontSize: 11, opacity: 0.45 } }, path[path.length - 1]),
          ),
          control,
          err
            ? React.createElement('div', { style: { ...XS.hint, color: '#f88' } }, err)
            : hint
              ? React.createElement('div', { style: XS.hint }, hint)
              : null,
        )

      const renderArray = (path, arr, lab) => {
        // 对象列表：卡片式，可展开 / 删除 / 添加
        const pk0 = pkOf(path)
        if (arr.length > 0 && arr.every(isPlainObj)) {
          kindsRef.current[pk0] = 'object'
          return renderObjectList(path, arr, lab)
        }
        // 删空之后别退回字符串模式：本会话内记得它原来是对象列表
        if (arr.length === 0 && kindsRef.current[pk0] === 'object') return renderObjectList(path, arr, lab)
        const pk = pkOf(path)
        const numeric = arr.length > 0 && arr.every((x) => typeof x === 'number')
        const text = pk in texts ? texts[pk] : arr.map((x) => (isPlainObj(x) ? JSON.stringify(x) : String(x))).join('\n')
        // 解析一行：像 JSON 对象/数组才解析；最后一行（还在输入）先不解析，
        // 等换行或失焦再提交，避免刚打出 {} 就被切成对象卡片。
        const parseLine = (line) => {
          const s = line.trim()
          if (!s) return undefined
          if (numeric) return Number(s)
          if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) return JSON.parse(s)
          return s
        }
        const commit = (t, all) => {
          const rawLines = t.split('\n')
          const doneCount = all ? rawLines.length : Math.max(0, rawLines.length - 1)
          const lines = rawLines.slice(0, doneCount)
          const parsed = []
          const bad = []
          for (const line of lines) {
            if (!line.trim()) continue
            try {
              parsed.push(parseLine(line))
            } catch (e) {
              bad.push(line)
            }
          }
          if (!all) {
            const pending = rawLines[rawLines.length - 1]
            if (pending && pending.trim()) parsed.push(pending.trim())
          }
          if (bad.length) {
            setErrs((s) => ({ ...s, [pk]: '有行不是合法 JSON' }))
            return
          }
          setErrs((e) => ({ ...e, [pk]: '' }))
          setAt(path, parsed)
        }
        const onChange = (t) => {
          setTexts((s) => ({ ...s, [pk]: t }))
          commit(t, false)
        }
        const control = React.createElement('textarea', {
          rows: Math.min(8, Math.max(2, arr.length + 1)),
          value: text,
          spellCheck: false,
          placeholder: '一行一个，留空就是不设置',
          onChange: (e) => onChange(e.target.value),
          onBlur: (e) => {
            const t = e.target.value
            setTexts((s) => {
              const n = { ...s }
              delete n[pk]
              return n
            })
            commit(t, true)
          },
          style: XS.mono,
        })
        return fieldWrap(path, lab, control, '一行一个；对象/数组写成 JSON 也会解析', errs[pk])
      }

      /** 对象数组：每条一张卡，可展开改字段、删除、按第一条的字段结构新增 */
      const renderObjectList = (path, arr, lab) => {
        const templateOf = (v) => {
          if (Array.isArray(v)) return []
          if (isPlainObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, templateOf(x)]))
          if (typeof v === 'number') return 0
          if (typeof v === 'boolean') return false
          return ''
        }
        const addItem = () => {
          const seed = arr.length ? templateOf(arr[0]) : {}
          const nextPath = path.concat(arr.length)
          setAt(path, [...arr, seed])
          setOpenPaths((s) => ({ ...s, [pkOf(nextPath)]: true }))
        }
        const summaryOf = (item) => {
          const parts = []
          for (const [k, v] of Object.entries(item)) {
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') parts.push(k + '=' + String(v))
            if (parts.length >= 3) break
          }
          return parts.join('  ') || '（空对象）'
        }
        return React.createElement(
          'div',
          { key: pkOf(path), style: { marginBottom: 12 } },
          React.createElement(
            'div',
            { style: XS.label },
            labelEl(path[path.length - 1], lab),
            ' ',
            React.createElement('code', { style: { fontSize: 11, opacity: 0.45 } }, path[path.length - 1]),
            React.createElement('span', { style: { ...XS.hint, marginTop: 0, marginLeft: 6 } }, arr.length + ' 项'),
          ),
          arr.map((item, index) => {
            const itemPath = path.concat(index)
            const open = isOpen(itemPath, false)
            return React.createElement(
              'div',
              { key: pkOf(itemPath), style: XS.rowCard },
              React.createElement(
                'div',
                { style: XS.rowHead },
                React.createElement('button', { style: XS.chev, onClick: () => toggleOpen(itemPath) }, open ? '▾' : '▸'),
                React.createElement('span', { style: { ...XS.badge, fontFamily: 'monospace' } }, '#' + (index + 1)),
                React.createElement(
                  'span',
                  { style: { ...XS.hint, marginTop: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  summaryOf(item),
                ),
                React.createElement('button', { style: { ...XS.btn, padding: '1px 8px', fontSize: 11 }, onClick: () => delAt(itemPath) }, '删除'),
              ),
              open
                ? React.createElement(
                    'div',
                    { style: XS.rowBody },
                    Object.keys(item).length
                      ? Object.keys(item).map((k) => renderValue(itemPath.concat(k), item[k], labelOf(k), 2))
                      : React.createElement('textarea', {
                          rows: 2,
                          style: XS.mono,
                          placeholder: '{"key": "value"}',
                          value: pkOf(itemPath) in texts ? texts[pkOf(itemPath)] : '{}',
                          onChange: (e) => {
                            const t = e.target.value
                            setTexts((s) => ({ ...s, [pkOf(itemPath)]: t }))
                            try {
                              const v = JSON.parse(t)
                              if (isPlainObj(v)) setAt(itemPath, v)
                            } catch (e2) {}
                          },
                        }),
                  )
                : null,
            )
          }),
          React.createElement('button', { style: { ...XS.btn, marginTop: 4 }, onClick: addItem }, '＋ 添加一条'),
        )
      }

      const renderPrimitive = (path, value, lab) => {
        const pk = pkOf(path)
        if (typeof value === 'boolean') {
          return React.createElement(
            'div',
            { key: pk, style: { ...XS.fieldRow, display: 'flex', alignItems: 'center', gap: 8 } },
            React.createElement('input', {
              type: 'checkbox',
              checked: value,
              onChange: (e) => setAt(path, e.target.checked),
            }),
            React.createElement('span', { style: { fontWeight: 550, fontSize: 13 } }, labelEl(path[path.length - 1], lab)),
            React.createElement('code', { style: { fontSize: 11, opacity: 0.45 } }, path[path.length - 1]),
          )
        }
        if (typeof value === 'number') {
          return fieldWrap(
            path,
            lab,
            React.createElement('input', {
              type: 'number',
              value: Number.isFinite(value) ? value : '',
              onChange: (e) => setAt(path, e.target.value === '' ? '' : Number(e.target.value)),
              style: XS.inp,
            }),
          )
        }
        const str = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
        const key = String(path[path.length - 1])
        const big = str.length > 48 || str.indexOf('\n') >= 0 || /path|dir|root/i.test(key)
        const control = big
          ? React.createElement('textarea', {
              rows: str.indexOf('\n') >= 0 ? 3 : 2,
              value: str,
              spellCheck: false,
              onChange: (e) => setAt(path, e.target.value),
              style: XS.mono,
            })
          : React.createElement('input', {
              value: str,
              spellCheck: false,
              onChange: (e) => setAt(path, e.target.value),
              style: XS.inp,
            })
        return fieldWrap(path, lab, control)
      }

      const renderRows = (path, obj, lab) => {
        const entries = Object.entries(obj)
        const addRow = () => {
          let name = '新工具'
          let i = 2
          while (obj[name] !== undefined) name = '新工具 ' + i++
          setAt(path, { ...obj, [name]: { keys: [], cooldown: 8, system: 1 } })
          setOpenPaths((s) => ({ ...s, [pkOf(path.concat(name))]: true }))
        }
        return React.createElement(
          'div',
          { key: pkOf(path), style: { marginBottom: 12 } },
          React.createElement(
            'div',
            { style: XS.label },
            labelEl(path[path.length - 1], lab),
            ' ',
            React.createElement('code', { style: { fontSize: 11, opacity: 0.45 } }, path[path.length - 1]),
          ),
          entries.map(([name, val]) => {
            const rowPath = path.concat(name)
            const open = isOpen(rowPath, false)
            const nk = pkOf(path) + '|' + name
            const summary =
              isPlainObj(val) && Array.isArray(val.keys) && val.keys.length ? val.keys.join(' / ') : '（未填，保存时删除）'
            return React.createElement(
              'div',
              { key: nk, style: XS.rowCard },
              React.createElement(
                'div',
                { style: XS.rowHead },
                React.createElement(
                  'button',
                  { style: XS.chev, onClick: () => toggleOpen(rowPath), title: open ? '折叠' : '展开' },
                  open ? '▾' : '▸',
                ),
                React.createElement(
                  'span',
                  {
                    title: name,
                    style: {
                      fontFamily: 'ui-monospace, Consolas, monospace',
                      fontSize: 12,
                      padding: '1px 5px',
                      whiteSpace: 'nowrap',
                    },
                  },
                  name,
                ),
                React.createElement('span', { style: { ...XS.hint, marginTop: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, summary),
                React.createElement(
                  'button',
                  { style: { ...XS.btn, padding: '1px 8px', fontSize: 11 }, onClick: () => delAt(rowPath) },
                  '删除',
                ),
              ),
              open && isPlainObj(val)
                ? React.createElement(
                    'div',
                    { style: XS.rowBody },
                    Object.keys(val).map((k) => renderValue(rowPath.concat(k), val[k], labelOf(k), 2)),
                  )
                : null,
            )
          }),
          React.createElement('button', { style: { ...XS.btn, marginTop: 2 }, onClick: addRow }, '＋ 添加一条'),
        )
      }

      const renderObject = (path, obj, lab, depth) => {
        const entries = Object.entries(obj)
        const rowMap = entries.length > 0 && entries.every(([, v]) => isPlainObj(v))
        const forceRows = path[path.length - 1] === 'rules'
        if (rowMap || (forceRows && entries.length === 0)) return renderRows(path, obj, lab)
        const open = isOpen(path, depth <= 1)
        return React.createElement(
          'div',
          { key: pkOf(path), style: XS.groupBox },
          React.createElement(
            'div',
            {
              style: { ...XS.rowHead, marginBottom: open ? 6 : 0 },
            },
            React.createElement('button', { style: XS.chev, onClick: () => toggleOpen(path) }, open ? '▾' : '▸'),
            React.createElement('span', { style: { fontWeight: 600, fontSize: 12.5 } }, labelEl(path[path.length - 1], lab)),
            React.createElement('code', { style: { fontSize: 10.5, opacity: 0.4 } }, path[path.length - 1]),
            React.createElement('span', { style: { ...XS.hint, marginTop: 0, flex: 1 } }, entries.length + ' 项'),
          ),
          open
            ? React.createElement(
                'div',
                null,
                entries.map(([k, v]) => renderValue(path.concat(k), v, labelOf(k), depth + 1)),
              )
            : null,
        )
      }

      const renderValue = (path, value, lab, depth) => {
        if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
          return renderPrimitive(path, value, lab)
        }
        if (Array.isArray(value)) return renderArray(path, value, lab)
        if (isPlainObj(value)) return renderObject(path, value, lab, depth)
        return renderPrimitive(path, value == null ? '' : value, lab)
      }

      // 保存前把「没填关键词的工具规则」和空行清掉
      const cleanDraft = () => {
        const copy = clone(draft || {})
        const rules = copy.rules
        if (isPlainObj(rules)) {
          for (const [name, val] of Object.entries(rules)) {
            const keys = isPlainObj(val) && Array.isArray(val.keys) ? val.keys.filter((x) => String(x).trim()) : []
            if (!isPlainObj(val) || keys.length === 0) delete rules[name]
          }
        }
        return copy
      }
      const renderLeft = () => {
        const q = query.trim().toLowerCase()
        const list = (rows || []).filter(
          (r) => !q || r.id.toLowerCase().indexOf(q) >= 0 || r.title.toLowerCase().indexOf(q) >= 0 || r.spec.toLowerCase().indexOf(q) >= 0,
        )
        const out = []
        let lastGroup = null
        for (const r of list) {
          if (r.group !== lastGroup) {
            lastGroup = r.group
            out.push(React.createElement('div', { key: 'g:' + r.group, style: XS.group }, r.group))
          }
          out.push(
            React.createElement(
              'div',
              {
                key: r.id,
                style: XS.item(sel === r.id),
                onClick: () => pick(r.id),
                title: r.spec,
              },
              React.createElement(
                'div',
                { style: { fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                editingLeft === r.id
                  ? React.createElement('input', {
                      autoFocus: true,
                      value: leftDraft,
                      spellCheck: false,
                      onClick: (e) => e.stopPropagation(),
                      onChange: (e) => setLeftDraft(e.target.value),
                      onBlur: () => commitLeftName(r.id, r.title),
                      onKeyDown: (e) => {
                        if (e.key === 'Enter') e.currentTarget.blur()
                        if (e.key === 'Escape') setEditingLeft('')
                      },
                      style: { ...XS.inp, fontSize: 12, padding: '1px 5px', width: '100%' },
                    })
                  : React.createElement(
                      'span',
                      {
                        title: '双击改名（留空恢复默认）',
                        onDoubleClick: (e) => {
                          e.stopPropagation()
                          setLeftDraft(r.title)
                          setEditingLeft(r.id)
                        },
                      },
                      r.title,
                    ),
              ),
              React.createElement(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 4, marginTop: 2, minWidth: 0 } },
                React.createElement(
                  'span',
                  {
                    style: {
                      fontSize: 10.5,
                      opacity: 0.45,
                      fontFamily: 'ui-monospace, Consolas, monospace',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    },
                  },
                  r.spec.replace('dsh-xykp/', ''),
                ),
                r.disabled ? React.createElement('span', { style: { ...XS.badge, fontSize: 10, padding: '0 4px', whiteSpace: 'nowrap', opacity: 0.5 } }, '停用') : null,
              ),
            ),
          )
        }
        if (out.length === 0) out.push(React.createElement('div', { key: 'none', style: { ...XS.hint, padding: 8 } }, '没有匹配的插件'))
        return out
      }

      const right = () => {
        if (!row) return React.createElement('div', { style: XS.hint }, '左边选一个插件')
        const changed = Object.keys(draft || {}).filter((k) => !same(base && base[k], draft[k]))
        return React.createElement(
          'div',
          null,
          React.createElement(
            'div',
            { style: XS.head },
            React.createElement('div', { style: { fontSize: 15, fontWeight: 650 } }, row.title),
            React.createElement('code', { style: { fontSize: 11, opacity: 0.55 } }, row.spec),
            dirty ? React.createElement('span', { style: { ...XS.badge, borderColor: 'rgba(255,190,90,.6)' } }, '未保存 ' + changed.length + ' 项') : null,
            React.createElement('span', { style: { flex: 1 } }),
            React.createElement('button', { style: XS.btn, disabled: busy, onClick: () => load(row.id) }, '刷新'),
            React.createElement('button', { style: XS.btn, disabled: busy || !dirty, onClick: () => { setDraft(clone(row.config || {})); setTexts({}); setErrs({}); setMsg('') } }, '撤销'),
            React.createElement('button', { style: XS.btn, disabled: busy || !row.config || Object.keys(row.config).length === 0, onClick: reset }, '恢复默认'),
            React.createElement('button', { style: XS.btnMain, disabled: busy || !dirty, onClick: save }, busy ? '保存中…' : '保存'),
          ),
          row.desc ? React.createElement('div', { style: { ...XS.hint, marginTop: 0, marginBottom: 10 } }, row.desc) : null,
          row.note ? React.createElement('div', { style: { ...XS.hint, marginBottom: 10, color: 'rgba(255,190,90,.9)' } }, row.note) : null,
          msg
            ? React.createElement('div', { style: { fontSize: 12, marginBottom: 10, color: bad ? '#f88' : 'rgba(120,200,130,.95)' } }, msg)
            : null,
          React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8, fontSize: 12 } },
            React.createElement(
              'button',
              {
                style: { ...XS.btn, alignSelf: 'flex-start', whiteSpace: 'nowrap' },
                onClick: () => {
                  const next = !rawMode
                  if (next) setRawText(JSON.stringify(draft, null, 2))
                  setRawMode(next)
                },
              },
              rawMode ? '字段视图' : 'JSON 源码',
            ),
            docPath
              ? React.createElement(
                  'span',
                  {
                    style: {
                      opacity: 0.45,
                      fontSize: 11,
                      display: 'block',
                      width: '100%',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    },
                    title: docPath,
                  },
                  '写入 ' + docPath,
                )
              : null,
          ),
          rawMode
            ? React.createElement(
                'div',
                null,
                React.createElement('textarea', {
                  rows: 14,
                  value: rawText,
                  spellCheck: false,
                  onChange: (e) => {
                    setRawText(e.target.value)
                    try {
                      const v = JSON.parse(e.target.value)
                      if (isPlainObj(v)) {
                        setDraft(v)
                        setErrs((s) => ({ ...s, __raw: '' }))
                      } else {
                        setErrs((s) => ({ ...s, __raw: '顶层必须是对象' }))
                      }
                    } catch (e2) {
                      setErrs((s) => ({ ...s, __raw: 'JSON 不合法' }))
                    }
                  },
                  style: XS.mono,
                }),
                errs.__raw ? React.createElement('div', { style: { ...XS.hint, color: '#f88' } }, errs.__raw) : null,
              )
            : React.createElement('div', null, Object.keys(draft || {}).map((k) => renderValue([k], draft[k], labelOf(k), 0))),
        )
      }

      return React.createElement(
        'div',
        {
          ref: boxRef,
          // 滚轮只在本控制台内部消化，别让外层设置页跟着滚
          onWheel: (e) => e.stopPropagation(),
          style: {
            padding: '2px 0',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            overflow: 'hidden',
            height: viewH > 0 ? viewH : undefined,
          },
        },
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flex: '0 0 auto' } },
          React.createElement('span', { style: { fontSize: 11, opacity: 0.5 } }, rows ? '共 ' + rows.length + ' 个插件 · 存取都在 home\\xykp\\config.yml' : ''),
          React.createElement('span', { style: { flex: 1 } }),
          React.createElement('input', {
            value: query,
            placeholder: '过滤…',
            onChange: (e) => setQuery(e.target.value),
            style: { ...XS.inp, width: 140, padding: '3px 8px' },
          }),
        ),
        React.createElement(
          'div',
          { style: XS.wrap },
          React.createElement(
            'div',
            { style: { ...XS.left, flex: '0 0 ' + leftW + 'px', width: leftW } },
            rows === null ? React.createElement('div', { style: XS.hint }, '读取中…') : renderLeft(),
          ),
          React.createElement(
            'div',
            { style: XS.divider, onMouseDown: startDrag, title: '拖动调整宽度' },
            React.createElement('div', { style: XS.dividerLine }),
          ),
          React.createElement('div', { style: XS.right }, right()),
        ),
      )
    }

    // ── 对话里：每轮尾部的「注入」条（数据来自 chat/injection-shower 的 /injection-shower/state）──
    // 一屏可能有几十轮，所有 turn tail 共用一个 3s 轮询器，不然每轮各拉一次
    const IS = {
      wrap: { marginTop: 6, fontSize: 12, lineHeight: '18px' },
      head: {
        background: 'transparent',
        border: 0,
        padding: 0,
        cursor: 'pointer',
        color: 'inherit',
        opacity: 0.55,
        fontSize: 12,
        fontFamily: 'inherit',
      },
      list: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 },
      item: { borderLeft: '2px solid rgba(255,255,255,.16)', padding: '2px 0 2px 8px' },
      name: { fontSize: 11, opacity: 0.6, fontFamily: 'ui-monospace,monospace' },
      pre: {
        margin: '4px 0 0',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        font: '12px/1.5 ui-monospace,monospace',
        opacity: 0.85,
        maxHeight: 260,
        overflow: 'auto',
      },
    }

    let injectionState = null
    const injectionSubs = new Set()
    let injectionTimer = null

    function injectionSubscribe(fn) {
      injectionSubs.add(fn)
      if (injectionTimer === null) {
        const load = () => {
          fetch('/injection-shower/state', { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
              if (!d) return
              injectionState = d
              for (const sub of injectionSubs) {
                try {
                  sub(d)
                } catch {}
              }
            })
            .catch(() => {})
        }
        load()
        injectionTimer = setInterval(load, 3000)
      }
      return () => {
        injectionSubs.delete(fn)
        if (injectionSubs.size === 0 && injectionTimer !== null) {
          clearInterval(injectionTimer)
          injectionTimer = null
        }
      }
    }

    function InjectionTail(props) {
      const turn = props ? props.turn : undefined
      const [state, setState] = React.useState(injectionState)
      const [open, setOpen] = React.useState(false)
      React.useEffect(() => injectionSubscribe(setState), [])

      if (!state || !Array.isArray(state.sessions) || turn === undefined) return null
      let snap = null
      let session = null
      for (const s of state.sessions) {
        for (const one of s.snapshots || []) {
          if (one.turn !== turn) continue
          if (!snap || one.at > snap.at) {
            snap = one
            session = s
          }
        }
      }
      const notices = []
      if (session) {
        for (const n of session.notices || []) if (n.turn === turn) notices.push(n)
      }
      if (!snap && notices.length === 0) return null
      const ctxs = (snap && snap.contexts) || []
      const secs = (snap && snap.sections) || []
      const total = ctxs.length + secs.length + notices.length
      if (total === 0) return null

      const row = (key, label, item) =>
        React.createElement(
          'div',
          { key, style: IS.item },
          React.createElement('div', { style: IS.name }, label + (item.name ? ' · ' + item.name : '')),
          React.createElement('pre', { style: IS.pre }, item.text),
        )

      return React.createElement(
        'div',
        { style: IS.wrap },
        React.createElement(
          'button',
          { style: IS.head, onClick: () => setOpen(!open) },
          (open ? '▾ ' : '▸ ') +
            '注入 ' +
            total +
            ' 项 · context ' +
            ctxs.length +
            ' · section ' +
            secs.length +
            ' · 通知 ' +
            notices.length,
        ),
        open
          ? React.createElement(
              'div',
              { style: IS.list },
              ctxs.map((c, i) => row('c' + i, 'context', c)),
              secs.map((c, i) => row('s' + i, 'section', c)),
              notices.map((n, i) => row('n' + i, '通知', { name: '', text: n.text })),
            )
          : null,
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      // 对话里每轮尾部的「注入」条
      try {
        slots.inject('conversation.chat.turnTail', () =>
          slots.register(
            { name: 'conversation.chat.turnTail', id: 'xykp-injection', order: 90 },
            (props) => React.createElement(InjectionTail, props),
          ),
        )
      } catch (e) {
        console.warn('[dsh-xykp] 注入条注册失败：', e)
      }

      // 会话永久删除 —— 合并进来的 UI（原来是 storage/session-delete 的 client.js）
      try {
        var p = sessionDeleteUI.apply(ctx)
        if (p && typeof p.catch === 'function') {
          p.catch(function (e) { console.warn('[dsh-xykp] session-delete 初始化失败：', e) })
        }
      } catch (e) {
        console.warn('[dsh-xykp] session-delete 初始化失败：', e)
      }

      // 插件配置控制台（所有 dsh-xykp 行的配置）
      try {
        slots.inject('settings.section', () =>
          slots.register(
            { name: 'settings.section', id: 'xykp-config', order: 53, label: () => 'xykp 配置' },
            () => React.createElement(ConsoleSection),
          ),
        )
      } catch (e) {
        console.warn('[dsh-xykp] 插件配置页注册失败：', e)
      }

      // 插件页 → 配置：同一个控制台，放在整页里更宽敞
      try {
        slots.inject('plugins.tab', () =>
          slots.register(
            { name: 'plugins.tab', id: 'xykp-config', order: 5, label: () => 'xykp 配置' },
            () => React.createElement(ConsoleSection),
          ),
        )
      } catch (e) {
        console.warn('[dsh-xykp] 插件页配置页签注册失败：', e)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
