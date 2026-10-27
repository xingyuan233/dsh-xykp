/**
 * dsh-session-delete — 浏览器端（客户端插件）。
 *
 * 装载契约（对照 @deepseek-ai/dsh-client-modules 与 dsh-onebot-qq/lib/client.js）：
 *   - 必须是 `window.__ModuleLoader__.load({ id, factory })` 的 CJS 包裹；
 *   - `exports.inject` 声明 cordis 客户端服务依赖，`exports.apply(ctx)` 返回卸载函数；
 *   - 依赖只能 require 平台冻结模块表里的模块：react、react/jsx-runtime、
 *     @deepseek-ai/dsh-client-ui-primitives 等。
 *
 * 功能：在侧栏会话行的「…」菜单里加一项「永久删除会话」，点击后弹确认框，
 * 确认后调用宿主 Remote `sessionDelete/deleteSession`，再刷新会话列表并提示结果。
 *
 * 宿主侧行为（见 lib/index.js）：
 *   - 非活动会话：立即删除日志目录 + projection cache + Workspace 记账；
 *   - 本进程仍在内存里的会话（本进程聊过/跑过）：先归档，排队到下次宿主启动时清理，
 *     返回 `deferred: true`。
 */
window.__ModuleLoader__.load({
  id: "dsh-session-delete",
  factory: (require) => {
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

    return module.exports;
  },
});
