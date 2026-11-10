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

    //#region Remote 契约（与宿主 lib/index.js 的方法逐字对齐）
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
    function vArray(itemSchema) {
      return {
        parse: function (value) {
          if (!Array.isArray(value)) throw new TypeError("期望数组");
          return value.map(function (item) {
            return itemSchema.parse(item);
          });
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
    /** 预览里的一轮：turn/prompt/response 都是字符串（turn 是十进制数字文本）。 */
    var previewTurnSchema = vObject({
      turn: vString(1, 12),
      prompt: vString(0, 400),
      response: vString(0, 400),
    });
    /** previewTurns 的返回值。 */
    var previewResultSchema = vObject({
      sessionId: vString(1, 200),
      displayTitle: vString(0, 400),
      live: vBoolean(),
      canClose: vBoolean(),
      totalTurns: vString(1, 12),
      turns: vArray(previewTurnSchema),
    });
    /** deleteTurnsFrom 的返回值。 */
    var truncateResultSchema = vObject({
      sessionId: vString(1, 200),
      fromTurn: vString(1, 12),
      applied: vBoolean(),
      queued: vBoolean(),
      removedTurns: vString(0, 12),
      removedEvents: vString(0, 12),
      remainingEvents: vString(0, 12),
    });
    /** 参数校验：会话 id 只允许安全字符（与宿主同一规则）。 */
    var sessionIdSchema = vString(1, 200);
    /** 参数校验：轮次是十进制数字文本（避免依赖 number codec）。 */
    var turnSchema = vString(1, 12);

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
      {
        id: PLUGIN_ID + "#" + REMOTE_NS + "/previewTurns",
        service: REMOTE_NS,
        namespace: REMOTE_NS,
        method: "previewTurns",
        invocation: { kind: "direct" },
        parameters: [
          {
            name: "sessionId",
            wire: "sessionId",
            source: "json",
            codec: strictCodec("string", sessionIdSchema),
          },
          {
            name: "fromTurn",
            wire: "fromTurn",
            source: "json",
            codec: strictCodec("string", vString(0, 12)),
          },
        ],
        result: strictCodec("SessionPreviewResult", previewResultSchema),
      },
      {
        id: PLUGIN_ID + "#" + REMOTE_NS + "/deleteTurnsFrom",
        service: REMOTE_NS,
        namespace: REMOTE_NS,
        method: "deleteTurnsFrom",
        invocation: { kind: "direct" },
        parameters: [
          {
            name: "sessionId",
            wire: "sessionId",
            source: "json",
            codec: strictCodec("string", sessionIdSchema),
          },
          {
            name: "fromTurn",
            wire: "fromTurn",
            source: "json",
            codec: strictCodec("string", turnSchema),
          },
        ],
        result: strictCodec("SessionTruncateResult", truncateResultSchema),
      },
    ];
    var REMOTE = { package: PLUGIN_ID, descriptors: DESCRIPTORS };
    /** 老宿主（未重启、还没有 previewTurns/deleteTurnsFrom）的降级契约：只挂删除会话。 */
    var REMOTE_DELETE_ONLY = { package: PLUGIN_ID, descriptors: [DESCRIPTORS[0]] };
    //#endregion

    //#region 词条（zh 为键集真相源，en 逐键对齐）
    var zh = {
      "menu.deleteSession": "永久删除会话",
      "menu.deleteTurns": "删除末尾对话…",
      "turn.delete": "删除这轮及之后的对话",
      "turn.deleteShort": "删除这轮及之后",
      "dialog.title": "永久删除会话？",
      "dialog.desc": "「{title}」的聊天记录会从磁盘上永久删除，无法恢复。",
      "dialog.warning": "此操作不可撤销；如果只是不想在侧栏看到它，请改用「归档会话」。",
      "dialog.cancel": "取消",
      "dialog.confirm": "永久删除",
      "dialog.pending": "正在删除…",
      "dialog.openInView": "这个会话正在主界面打开，请先切换到其他会话再删除。",
      "toast.deleted": "会话已永久删除",
      "toast.deferred": "会话已归档；重启 dsh web 后会完成磁盘清理",
      "tail.title": "删除末尾对话",
      "tail.desc": "「{title}」：选择从哪一轮开始删除，选中的那一轮和它后面的所有内容都会消失。",
      "tail.loading": "正在读取对话……",
      "tail.empty": "这个会话还没有可删除的对话轮次。",
      "tail.liveNote":
        "这个会话在当前 dsh web 进程里已经激活过（打开会话会把它提升为 live agent 并一直持有写句柄，直到进程退出），日志不能原地重写：会登记到 pending-turns.json，重启 dsh web 后在任何 agent 恢复之前自动完成截断。重启前请不要在该会话继续对话（新内容也会被一起截掉）。",
      "tail.liveClosable":
        "这个会话正在运行：删除时会先切到别的会话、关闭它的实时连接（释放写句柄）再重写日志；完成后点回原会话即可看到最新内容。",
      "tail.summary": "将删除第 {from} 轮到最后（共 {count} 轮），点某一轮可以从那里开始删。",
      "tail.prompt": "问",
      "tail.response": "答",
      "tail.noResponse": "（暂无可预览的回答）",
      "tail.turn": "第 {turn} 轮",
      "tail.cancel": "取消",
      "tail.confirm": "删除这轮及之后",
      "tail.pending": "正在删除…",
      "tail.applied": "已删除第 {turn} 轮及之后的 {count} 轮对话",
      "tail.queued": "已登记：重启 dsh web 后会删除第 {turn} 轮及之后的 {count} 轮对话",
      "tail.clickBack": "（已切到别的会话，点回原会话即可看到最新内容）",
      "tail.hostOutdated": "宿主还没有加载新版本：请重启 dsh web 后再用「删除末尾对话」。",
    };
    var en = {
      "menu.deleteSession": "Delete conversation permanently",
      "menu.deleteTurns": "Delete trailing turns…",
      "turn.delete": "Delete this turn and all later turns",
      "turn.deleteShort": "Delete tail",
      "dialog.title": "Delete this conversation permanently?",
      "dialog.desc": "The chat history of “{title}” will be removed from disk. This cannot be undone.",
      "dialog.warning": "This action cannot be undone. If you only want to hide it, use Archive instead.",
      "dialog.cancel": "Cancel",
      "dialog.confirm": "Delete permanently",
      "dialog.pending": "Deleting…",
      "dialog.openInView": "This conversation is open in the main view. Switch to another conversation before deleting it.",
      "toast.deleted": "Conversation permanently deleted",
      "toast.deferred": "Conversation archived; disk cleanup finishes after dsh web restarts",
      "tail.title": "Delete trailing turns",
      "tail.desc": "“{title}”: pick the first turn to delete. That turn and everything after it will be removed.",
      "tail.loading": "Reading the conversation…",
      "tail.empty": "This conversation has no turns that can be deleted.",
      "tail.liveNote":
        "This conversation has already been activated in the current dsh web process (opening a conversation promotes it to a live agent that holds its write handle until the process exits), so its log cannot be rewritten in place. The truncation is queued in pending-turns.json and is applied after dsh web restarts, before any agent resumes. Do not keep chatting in it before the restart, or the new content will be removed too.",
      "tail.liveClosable":
        "This conversation is live: the plugin switches away, closes its live agent (releasing the write handle) and rewrites the log. Click the conversation again to see the update.",
      "tail.summary": "Will delete turn {from} through the end ({count} turn(s)). Pick another turn to start there.",
      "tail.prompt": "Q",
      "tail.response": "A",
      "tail.noResponse": "(no previewable answer)",
      "tail.turn": "Turn {turn}",
      "tail.cancel": "Cancel",
      "tail.confirm": "Delete this turn and later",
      "tail.pending": "Deleting…",
      "tail.applied": "Deleted turn {turn} and the {count} trailing turn(s)",
      "tail.queued": "Queued: turn {turn} and the {count} trailing turn(s) will be deleted after dsh web restarts",
      "tail.clickBack": "(switched away; click the conversation again to see the update)",
      "tail.hostOutdated": "The host has not loaded the new version yet. Restart dsh web and try again.",
    };
    //#endregion

    /** 确认框和提示条共用的最小状态容器（模块内闭包，随插件实例销毁）。 */
    function createStore() {
      var listeners = new Set();
      var pending = null;
      var tail = null;
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
        getTail: function () {
          return tail;
        },
        requestTail: function (sessionId, displayTitle, fromTurn) {
          tail = { sessionId: sessionId, displayTitle: displayTitle, fromTurn: fromTurn };
          emit();
        },
        settleTail: function () {
          tail = null;
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

    /** 截断预览的短文本（宿主也会截，这里兜底）。 */
    function clip(text, limit) {
      var value = typeof text === "string" ? text : "";
      value = value.replace(/\s+/g, " ").trim();
      return value.length > limit ? value.slice(0, limit) + "…" : value;
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

    /** 菜单项：删除末尾对话。 */
    function DeleteTurnsMenuItem(props) {
      var sessionId = props.sessionId;
      var displayTitle = props.displayTitle;
      var setMenuOpen = props.useMenuOpenState()[1];
      var requestDeleteTurns = props.requestDeleteTurns;
      var t = props.t;
      return React.createElement(
        primitives.MenuItemButton,
        {
          separatorBefore: true,
          icon: React.createElement(primitives.IconTrashOutlineRegular, { size: 14 }),
          onSelect: function () {
            setMenuOpen(false);
            requestDeleteTurns(sessionId, displayTitle);
          },
        },
        t("menu.deleteTurns"),
      );
    }

    /**
     * 会话视图：用户消息下方（泡泡右下角）的「删除这轮及之后」。
     * 通过 conversation.chat.user.footer 插槽注册（核心补丁 user-footer-slot 提供）；
     * 点击后打开对话框并预选这一轮，会话 id 由插槽的 inject(sessionId) 绑定。
     */
    function DeleteTailTurnButton(props) {
      var t = props.t;
      var raw = props.turn;
      var turn =
        typeof raw === "number"
          ? raw
          : raw !== null && typeof raw === "object" && typeof raw.turn === "number"
            ? raw.turn
            : NaN;
      var sessionId = typeof props.sessionId === "string" ? props.sessionId : null;
      var requestTail = props.requestTail;
      if (!Number.isFinite(turn) || sessionId === null || typeof requestTail !== "function") return null;
      return React.createElement(
        "button",
        {
          type: "button",
          className: "sd-turn-delete",
          title: t("turn.delete"),
          "aria-label": t("turn.delete"),
          onClick: function () {
            requestTail(sessionId, turn);
          },
        },
        React.createElement(primitives.IconTrashOutlineRegular, { size: 13 }),
        React.createElement("span", null, t("turn.deleteShort")),
      );
    }

    /** 用户消息操作行（conversation.chat.user.footer）：复制图标旁的红色垃圾桶。 */
    function DeleteUserTurnButton(props) {
      var t = props.t;
      var raw = props.turn;
      var turn =
        typeof raw === "number"
          ? raw
          : raw !== null && typeof raw === "object" && typeof raw.turn === "number"
            ? raw.turn
            : NaN;
      var sessionId = typeof props.sessionId === "string" ? props.sessionId : null;
      var requestTail = props.requestTail;
      if (!Number.isFinite(turn) || sessionId === null || typeof requestTail !== "function") return null;
      return React.createElement(
        "button",
        {
          type: "button",
          className: "sd-user-trash",
          title: t("turn.delete"),
          "aria-label": t("turn.delete"),
          onClick: function () {
            requestTail(sessionId, turn);
          },
        },
        React.createElement(primitives.IconTrashOutlineRegular, { size: 14 }),
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

    /**
     * 末尾对话删除框：打开时从宿主拉取末尾若干轮，选中某一轮表示「从这里删到末尾」。
     * 宿主返回的会话若仍活跃，会显示「重启后生效」的说明。
     */
    function DeleteTurnsDialog(props) {
      var pending = React.useSyncExternalStore(props.store.subscribe, props.store.getTail);
      var t = props.t;
      var previewState = React.useState(null);
      var preview = previewState[0];
      var setPreview = previewState[1];
      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var selectedState = React.useState(null);
      var selected = selectedState[0];
      var setSelected = selectedState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      var sessionId = pending === null ? null : pending.sessionId;
      var open = sessionId !== null;

      React.useEffect(
        function () {
          if (!open) return undefined;
          var alive = true;
          var requested = pending.fromTurn === null || pending.fromTurn === undefined ? null : String(pending.fromTurn);
          setPreview(null);
          setError(null);
          setSelected(null);
          props
            .previewTurns(sessionId, requested === null ? "" : requested)
            .then(function (value) {
              if (!alive) return;
              setPreview(value);
              if (value.turns.length > 0) {
                var hit =
                  requested === null
                    ? undefined
                    : value.turns.find(function (entry) {
                        return entry.turn === requested;
                      });
                setSelected(
                  hit !== undefined ? hit.turn : value.turns[value.turns.length - 1].turn,
                );
              }
            })
            .catch(function (cause) {
              if (alive) setError(messageOf(cause));
            });
          return function () {
            alive = false;
          };
        },
        [open, sessionId, pending === null ? null : pending.fromTurn],
      );

      if (!open) return null;

      var close = function () {
        if (busy) return;
        setError(null);
        props.settleTail();
      };
      var confirm = function () {
        if (busy || selected === null) return;
        setBusy(true);
        setError(null);
        props
          .deleteTurnsFrom(sessionId, selected)
          .then(function (result) {
            setBusy(false);
            props.settleTail();
            props.onApplied(result);
          })
          .catch(function (cause) {
            setBusy(false);
            setError(messageOf(cause));
          });
      };

      var body = [];
      if (preview === null && error === null) {
        body.push(
          React.createElement("div", { key: "loading", className: "sd-status", role: "status" }, t("tail.loading")),
        );
      }
      if (preview !== null && preview.turns.length === 0) {
        body.push(React.createElement("p", { key: "empty", className: "sd-note" }, t("tail.empty")));
      }
      if (preview !== null && preview.turns.length > 0) {
        var first = preview.turns[0];
        var last = preview.turns[preview.turns.length - 1];
        body.push(
          React.createElement(
            "p",
            { key: "summary", className: "sd-note sd-summary" },
            t("tail.summary", { from: first.turn, to: last.turn, count: String(preview.turns.length) }),
          ),
        );
        body.push(
          React.createElement(
            "div",
            { key: "list", className: "sd-turns", role: "listbox" },
            preview.turns.map(function (entry) {
              var on = entry.turn === selected;
              var drop = selected !== null && Number(entry.turn) >= Number(selected);
              return React.createElement(
                "button",
                {
                  key: entry.turn,
                  type: "button",
                  role: "option",
                  "aria-selected": on,
                  className: "sd-turn" + (on ? " sd-turn-on" : "") + (drop ? " sd-turn-drop" : ""),
                  onClick: function () {
                    if (!busy) setSelected(entry.turn);
                  },
                },
                React.createElement(
                  "span",
                  { className: "sd-turn-head" },
                  t("tail.turn", { turn: entry.turn }) + (on ? "  ✂" : ""),
                ),
                React.createElement(
                  "span",
                  { className: "sd-turn-row" },
                  React.createElement("span", { className: "sd-turn-tag" }, t("tail.prompt")),
                  React.createElement("span", { className: "sd-turn-text" }, clip(entry.prompt, 120) || "—"),
                ),
                React.createElement(
                  "span",
                  { className: "sd-turn-row" },
                  React.createElement("span", { className: "sd-turn-tag" }, t("tail.response")),
                  React.createElement(
                    "span",
                    { className: "sd-turn-text" },
                    entry.response.length > 0 ? clip(entry.response, 120) : t("tail.noResponse"),
                  ),
                ),
              );
            }),
          ),
        );
        if (preview.live) {
          body.push(
            React.createElement(
              "p",
              { key: "live", className: "sd-warn" },
              t(preview.canClose ? "tail.liveClosable" : "tail.liveNote"),
            ),
          );
        }
      }
      if (error !== null) {
        body.push(React.createElement("div", { key: "error", className: "sd-error", role: "alert" }, error));
      }
      if (busy) {
        body.push(
          React.createElement("div", { key: "busy", className: "sd-status", role: "status" }, t("tail.pending")),
        );
      }

      var confirmDisabled = busy || selected === null || preview === null || preview.turns.length === 0;
      var titleText =
        pending.displayTitle !== ""
          ? pending.displayTitle
          : preview !== null && preview.displayTitle !== ""
            ? preview.displayTitle
            : sessionId;

      return React.createElement(
        primitives.Modal,
        {
          open: true,
          onClose: close,
          closeLabel: t("tail.cancel"),
          title: t("tail.title"),
          description: t("tail.desc", { title: titleText }),
          footer: React.createElement(
            React.Fragment,
            null,
            React.createElement(
              primitives.Button,
              { variant: "outline", disabled: busy, onClick: close },
              t("tail.cancel"),
            ),
            React.createElement(
              primitives.Button,
              { variant: "outline", className: "sd-danger", disabled: confirmDisabled, onClick: confirm },
              t("tail.confirm"),
            ),
          ),
        },
        body,
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
      ".sd-warn{color:var(--dsw-alias-state-warning-primary,#a3670f);font-size:12px;line-height:18px;margin:10px 0 0}" +
      ".sd-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}" +
      ".sd-error{color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px;margin-top:8px}" +
      ".sd-turns{display:flex;flex-direction:column;gap:6px;max-height:46vh;overflow:auto;margin:4px 0 0}" +
      ".sd-turn{display:flex;flex-direction:column;gap:3px;text-align:left;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(32,49,112,.25));" +
      "border-radius:8px;background:transparent;cursor:pointer;font:inherit;color:inherit}" +
      ".sd-turn:hover{background:var(--dsw-alias-bg-layer-2,rgba(32,49,112,.06))}" +
      ".sd-turn.sd-turn-on{border-color:var(--dsw-alias-state-error-primary,#c0392b);box-shadow:0 0 0 1px var(--dsw-alias-state-error-primary,#c0392b) inset}" +
      ".sd-turn.sd-turn-drop{background:rgba(192,57,43,.07)}" +
      ".sd-turn:not(.sd-turn-drop){opacity:.55}" +
      ".sd-summary{font-weight:600}" +
      ".sd-turn-delete{display:inline-flex;align-items:center;gap:3px;border:none;background:transparent;cursor:pointer;font:inherit;" +
      "font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#7b86a6);padding:2px 5px;border-radius:5px;opacity:.8}" +
      ".sd-turn-delete:hover{opacity:1;color:var(--dsw-alias-state-error-primary,#c0392b);background:rgba(192,57,43,.1)}" +
      ".sd-user-trash{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-state-error-primary,#c0392b);cursor:pointer;opacity:.85;transition:background .12s ease,opacity .12s ease}" +
      ".sd-user-trash:hover{opacity:1;background:rgba(192,57,43,.12)}" +
      ".sd-turn-head{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}" +
      ".sd-turn-row{display:flex;gap:6px;font-size:12px;line-height:18px}" +
      ".sd-turn-tag{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}" +
      ".sd-turn-text{white-space:normal;word-break:break-word}";
    //#endregion

    //#region 客户端入口
    var inject = ["slots", "locale", "remote", "sessions", "uiWorkspace"];

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
      var disposeRemote;
      var tailAvailable = true;
      try {
        disposeRemote = await ctx.remote.$mount(REMOTE);
      } catch (error) {
        // 宿主还是旧版本（新增的两个方法还没有）：降级只挂删除会话，提示用户重启。
        console.warn("[dsh-session-delete] 宿主没有新的末尾截断方法，降级为只支持删除会话：", error);
        tailAvailable = false;
        disposeRemote = await ctx.remote.$mount(REMOTE_DELETE_ONLY);
      }
      var remote = ctx.get("remote." + REMOTE_NS);
      if (remote === undefined) throw new Error("dsh-session-delete: Remote 挂载后不可用");



      var store = createStore();

      /** 宿主改动完成后的列表/项目缓存刷新；失败只记日志，不影响结果。 */
      async function refreshSessions(sessionId) {
        try {
          if (typeof sessionId === "string") await ctx.sessions.refreshProjections(sessionId);
        } catch (error) {
          console.warn("[dsh-session-delete] 刷新会话投影失败：", error);
        }
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
        await refreshSessions(sessionId);
        if (result !== null && result !== undefined && result.deferred === true) {
          store.raise(t("toast.deferred"), "warning", 6000);
        } else {
          store.raise(t("toast.deleted"), "success", 4000);
        }
        return result;
      }

      /** 读取轮次预览（对话框打开时调用）。fromTurn 为空串表示不限制起始轮。 */
      async function previewTurns(sessionId, fromTurn) {
        if (!tailAvailable) throw new Error(t("tail.hostOutdated"));
        return unwrap(await remote.previewTurns(sessionId, fromTurn === undefined || fromTurn === null ? "" : String(fromTurn)));
      }

      /** 等待一小段（让 UI 完成会话切换）。 */
      function delay(ms) {
        return new Promise(function (resolve) {
          setTimeout(resolve, ms);
        });
      }

      /** 主视图当前是否正在显示这个会话。 */
      function sessionIsOpen(sessionId) {
        try {
          return ctx.sessions.retainInfo(sessionId).getSnapshot().referenceCount > 0;
        } catch (error) {
          return false;
        }
      }

      /** 结果提示文案。 */
      function toastTextOf(result) {
        var count = result.removedTurns === "" ? "?" : result.removedTurns;
        return result.queued
          ? t("tail.queued", { turn: result.fromTurn, count: count })
          : t("tail.applied", { turn: result.fromTurn, count: count });
      }

      /** 换一个别的会话 id（优先用侧栏里真实可见的会话）。 */
      function pickOtherSessionId(sessionId) {
        try {
          var rows = document.querySelectorAll('[data-row-key^="session:"]');
          for (var index = 0; index < rows.length; index += 1) {
            var key = rows[index].getAttribute("data-row-key");
            var id = key.slice("session:".length);
            if (id !== sessionId) return id;
          }
        } catch (error) {
          /* 退回 sessions.list */
        }
        try {
          var ids = ctx.sessions.list.getSnapshot().ids;
          for (var cursor = 0; cursor < ids.length; cursor += 1) {
            if (ids[cursor] !== sessionId) return ids[cursor];
          }
        } catch (error) {
          /* 没有可切换的会话 */
        }
        return undefined;
      }

      /**
       * 从某一轮起截断会话。
       *
       * 会话正开在主视图里时：先切到别的会话（宿主随后才能安全 dispose its live
       * agent/写句柄），调用宿主截断，再由用户点回原会话拿到最新内容（客户端会
       * 在切走后异步回收旧 resident 实例，点回即重建）。
       * @param sessionId - 目标会话。
       * @param fromTurn - 十进制数字文本，删除这一轮及之后的内容。
       * @returns 宿主返回的截断结果。
       */
      async function deleteTurnsFrom(sessionId, fromTurn) {
        if (!tailAvailable) throw new Error(t("tail.hostOutdated"));
        var open = sessionIsOpen(sessionId);
        if (open) {
          var other = pickOtherSessionId(sessionId);
          if (other !== undefined) {
            try {
              ctx.uiWorkspace.openSession(other);
            } catch (error) {
              console.warn("[dsh-session-delete] 切换会话失败：", error);
            }
            for (var attempt = 0; attempt < 20 && sessionIsOpen(sessionId); attempt += 1) {
              await delay(100);
            }
            await delay(600);
          }
        }
        var result = unwrap(await remote.deleteTurnsFrom(sessionId, String(fromTurn)));
        await delay(400);
        await refreshSessions(sessionId);
        var text = toastTextOf(result);
        if (result.applied && open) text += " " + t("tail.clickBack");
        store.raise(text, result.queued ? "warning" : "success", result.queued ? 8000 : 7000);
        return result;
      }

      // 会话行「…」菜单：删除末尾对话 + 永久删除。
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
      ctx.slots.inject("sidebar.workspaces.session.menu.item", function () {
        return ctx.slots.register(
          {
            name: "sidebar.workspaces.session.menu.item",
            id: "session-delete.turns",
            order: 480,
            locale: NS,
            inject: function () {
              return {
                requestDeleteTurns: function (sessionId, displayTitle) {
                  store.requestTail(sessionId, displayTitle, null);
                },
              };
            },
          },
          DeleteTurnsMenuItem,
        );
      });

      // 会话视图：用户消息下方的「删除这轮及之后」（conversation.chat.user.footer，核心补丁提供）。
      // 插槽缺失时退回老的轮末插槽，别让整个客户端插件因为一个 inject 挂掉。
      function registerTailAction() {
        return ctx.slots.register(
          {
            name: "conversation.chat.turnTail",
            id: "session-delete.turn-action",
            order: 900,
            locale: NS,
            inject: function () {
              return {
                requestTail: function (sessionId, turn) {
                  if (typeof sessionId !== "string") return;
                  store.requestTail(sessionId, "", turn);
                },
              };
            },
          },
          DeleteTailTurnButton,
        );
      }
      try {
        ctx.slots.inject("conversation.chat.user.footer", function () {
          return ctx.slots.register(
            {
              name: "conversation.chat.user.footer",
              id: "session-delete.user-action",
              order: 900,
              locale: NS,
              inject: function () {
                return {
                  requestTail: function (sessionId, turn) {
                    if (typeof sessionId !== "string") return;
                    store.requestTail(sessionId, "", turn);
                  },
                };
              },
            },
            DeleteUserTurnButton,
          );
        });
      } catch (error) {
        console.warn("[session-delete] conversation.chat.user.footer 不可用，回退到 turnTail", error);
        try {
          ctx.slots.inject("conversation.chat.turnTail", registerTailAction);
        } catch (fallbackError) {
          console.warn("[session-delete] turnTail 也不可用", fallbackError);
        }
      }

      // 浮层：两个对话框 + 结果提示条。
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
            id: "session-delete.turns-dialog",
            locale: NS,
            inject: function () {
              return {
                store: store,
                settleTail: store.settleTail,
                previewTurns: previewTurns,
                deleteTurnsFrom: deleteTurnsFrom,
                onApplied: function () {},
              };
            },
          },
          DeleteTurnsDialog,
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
    let injectionHint = null

    function injectionSubscribe(fn) {
      injectionSubs.add(fn)
      if (injectionTimer === null) {
        const load = () => {
          const url =
            injectionHint === null
              ? '/injection-shower/state'
              : '/injection-shower/state?session=' + encodeURIComponent(injectionHint)
          fetch(url, { cache: 'no-store' })
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
      const rawTurn = props ? props.turn : undefined
      // 宿主 slot 传的 turn 有时是数字、有时是带 turn/index 的对象，两种都认
      const turn =
        typeof rawTurn === 'number'
          ? rawTurn
          : rawTurn && typeof rawTurn === 'object'
            ? typeof rawTurn.turn === 'number'
              ? rawTurn.turn
              : typeof rawTurn.index === 'number'
                ? rawTurn.index
                : typeof rawTurn.number === 'number'
                  ? rawTurn.number
                  : undefined
            : undefined
      const [state, setState] = React.useState(injectionState)
      const [open, setOpen] = React.useState(false)
      React.useEffect(() => injectionSubscribe(setState), [])

      let snap = null
      let session = null
      if (state && Array.isArray(state.sessions) && turn !== undefined) {
        for (const s of state.sessions) {
          for (const one of s.snapshots || []) {
            if (one.turn !== turn) continue
            if (!snap || one.at > snap.at) {
              snap = one
              session = s
            }
          }
        }
      }
      const notices = []
      if (session) {
        for (const n of session.notices || []) if (n.turn === turn) notices.push(n)
      }

      // 调试探针已移除（turn 结构确认过：在 rawTurn.turn 里）
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

      const changed = (snap && snap.changedSections) || []
      const secHead = '系统提示词 ' + secs.length + ' 段（固定前缀，已经在最上面那条里）'
      const groupLabel = (text) => React.createElement('div', { style: { ...IS.name, marginTop: 4 } }, text)

      return React.createElement(
        'div',
        { style: IS.wrap },
        React.createElement(
          'button',
          { style: IS.head, onClick: () => setOpen(!open) },
          (open ? '▾ ' : '▸ ') +
            '本轮：单次 ' +
            ctxs.length +
            ' · 变化段落 ' +
            changed.length +
            ' · 持久 ' +
            notices.length,
        ),
        open
          ? React.createElement(
              'div',
              { style: IS.list },
              ctxs.length ? groupLabel('单次注入（下一份会取代）') : null,
              ctxs.map((c, i) => row('c' + i, '单次', c)),
              notices.length ? groupLabel('持久注入（插入后一直保留）') : null,
              notices.map((n, i) => row('n' + i, '持久', { name: '', text: n.text })),
              changed.length ? groupLabel('⚠ 本轮新增/变化的段落（会导致前缀缓存失效）') : null,
              changed.map((c, i) => row('d' + i, '变化', c)),
              secs.length
                ? React.createElement(
                    'details',
                    { style: { marginTop: 4 } },
                    React.createElement('summary', { style: IS.name }, secHead),
                    ...secs.map((c, i) => row('s' + i, 'section', c)),
                  )
                : null,
            )
          : null,
      )
    }

    // ── 每个 assistant step 前面的「这一步吃了什么注入」（宿主补丁提供 conversation.chat.injection 槽位）──
    /** 会话列表里带 parentSessionId：fork 出来的会话可以回退到父会话拿「复制历史」的注入 */
    let sessionsGetter = null
    function parentOfSession(sessionId) {
      try {
        const svc = sessionsGetter
        if (!svc || !svc.list) return undefined
        const snap = svc.list.getSnapshot()
        const row = snap && snap.byId ? snap.byId[sessionId] : undefined
        return row ? row.parentSessionId : undefined
      } catch {
        return undefined
      }
    }

    /** 按会话精确定位；老数据没有 sessionId 时退回「最近更新」的会话 */
    function pickInjectionSession(state, turn, step, sessionId) {
      const list = (state && state.sessions) || []
      if (sessionId !== undefined) {
        return list.find((s) => s && s.sessionId === sessionId) || null
      }
      let best = null
      for (const s of list) {
        if (!s || !Array.isArray(s.snapshots)) continue
        if (!s.snapshots.some((x) => x.turn === turn && x.step === step)) continue
        if (best === null || Number(s.updatedAt || 0) > Number(best.updatedAt || 0)) best = s
      }
      return best
    }

    function InjectionStep(props) {
      const turn = props ? props.turn : undefined
      const step = props ? props.step : undefined
      const answer = props ? props.answer : undefined
      const sessionId = props ? props.sessionId : undefined
      const [state, setState] = React.useState(injectionState)
      const [open, setOpen] = React.useState(false)
      React.useEffect(() => injectionSubscribe(setState), [])
      React.useEffect(() => {
        if (sessionId !== undefined) injectionHint = sessionId
      }, [sessionId])
      if (!state || turn === undefined || step === undefined) return null
      let s = pickInjectionSession(state, turn, step, sessionId)
      if (!s) return null
      let snap = (s.snapshots || []).find((x) => x.turn === turn && x.step === step)
      // 复制出来的历史轮在自己的会话里没有快照：逐级回退到父会话找
      if (!snap && sessionId !== undefined) {
        let pid = parentOfSession(sessionId)
        for (let depth = 0; pid !== undefined && depth < 5 && !snap; depth++) {
          const ps = (state.sessions || []).find((x) => x && x.sessionId === pid)
          if (ps) {
            const hit = (ps.snapshots || []).find((x) => x.turn === turn && x.step === step)
            if (hit) {
              s = ps
              snap = hit
            }
          }
          pid = parentOfSession(pid)
        }
      }
      if (!snap) return null
      // 有工具步骤的轮：最终回答那一步在折叠组之外，单独飘一行很突兀，不显示；
      // 纯回答轮（整轮只有 1 个 step）没有折叠组，这一步就是整轮，照常显示
      if (answer) {
        const stepCount = (s.snapshots || []).filter(
          (x) => x.turn === turn && x.step !== undefined,
        ).length
        if (stepCount > 1) return null
      }
      const singles = Array.isArray(snap.addedContexts) ? snap.addedContexts : []
      const kept = step === 1 && Array.isArray(snap.persistentContexts) ? snap.persistentContexts : []
      const notes = Array.isArray(snap.notices) ? snap.notices : []
      const changed = Array.isArray(snap.changedSections) ? snap.changedSections : []
      if (singles.length + notes.length + changed.length === 0) return null

      const row = (key, label, item) =>
        React.createElement(
          'div',
          { key, style: IS.item },
          React.createElement('div', { style: IS.name }, label + (item.name ? ' · ' + item.name : '')),
          React.createElement('pre', { style: IS.pre }, item.text),
        )

      const bits = []
      if (singles.length) bits.push('单次 ' + singles.length)
      if (notes.length) bits.push('持久 ' + notes.length)
      if (changed.length) bits.push('变更 ' + changed.length)
      // 折叠时只列名字（取前几个），不塞正文
      const names = []
      for (const c of singles) if (c.name) names.push(c.name)
      for (const n of notes) if (n.kind && n.kind !== 'notice') names.push(n.kind)
      for (const c of changed) if (c.name) names.push(c.name)
      const namePart = names.length
        ? ' · ' + names.slice(0, 3).join(' · ') + (names.length > 3 ? ' …' : '')
        : ''

      return React.createElement(
        'div',
        {
          style: {
            margin: '2px 0 4px',
            paddingLeft: 8,
            borderLeft: '2px solid rgba(110,160,240,.45)',
          },
        },
        React.createElement(
          'button',
          {
            type: 'button',
            style: { ...IS.head, opacity: 0.75, fontSize: 12, color: 'rgba(150,180,250,.95)' },
            onClick: () => setOpen(!open),
          },
          (open ? '▾ ' : '▸ ') + '注入 · ' + bits.join(' · ') + namePart,
        ),
        open
          ? React.createElement(
              'div',
              { style: IS.list },
              singles.map((c, i) => row('c' + i, '单次', c)),
              notes.map((n, i) =>
                row('n' + i, '持久', {
                  name: n.kind && n.kind !== 'notice' ? n.kind : '',
                  text: n.text,
                }),
              ),
              changed.map((c, i) => row('d' + i, '变更', c)),
              kept.length
                ? React.createElement(
                    'details',
                    { style: { marginTop: 4 } },
                    React.createElement('summary', { style: IS.name }, '持久 · 常驻 ' + kept.length + ' 段'),
                    ...kept.map((c, i) => row('k' + i, '持久', c)),
                  )
                : null,
            )
          : null,
      )
    }

    // ── 对话最前面：系统前缀（systemPrompt.section + tools）版本条 ──
    const PB = {
      wrap: {
        padding: '6px 12px',
        borderBottom: '1px solid rgba(255,255,255,.06)',
        fontSize: 12,
        lineHeight: '18px',
      },
      head: {
        background: 'transparent',
        border: 0,
        padding: 0,
        cursor: 'pointer',
        color: 'inherit',
        opacity: 0.6,
        fontSize: 12,
        fontFamily: 'inherit',
      },
      list: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 },
      item: { borderLeft: '2px solid rgba(255,255,255,.16)', padding: '2px 0 2px 8px' },
      name: { fontSize: 11, opacity: 0.65, fontFamily: 'ui-monospace,monospace' },
      pre: {
        margin: '4px 0 0',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        font: '12px/1.5 ui-monospace,monospace',
        opacity: 0.8,
      },
    }

    function PrefixBar() {
      const [state, setState] = React.useState(injectionState)
      const [open, setOpen] = React.useState(false)
      React.useEffect(() => injectionSubscribe(setState), [])

      const s = state && state.sessions && state.sessions[0]
      if (!s || !s.prefix) return null
      const p = s.prefix
      const versions = s.prefixVersions || []
      const latest = versions[versions.length - 1]
      const parts = latest ? latest.changed.length + latest.added.length + latest.removed.length : 0

      return React.createElement(
        'div',
        { style: PB.wrap },
        React.createElement(
          'button',
          { style: PB.head, onClick: () => setOpen(!open) },
          (open ? '▾ ' : '▸ ') +
            '消息前缀 ' +
            p.hash +
            ' · ' +
            p.sectionCount +
            ' 段 · ' +
            p.toolCount +
            ' 个工具' +
            (latest
              ? ' · 第 ' + latest.turn + ' 轮改过 ' + parts + ' 处' + (latest.toolsChanged ? '（工具定义也变了）' : '') + ' → 前缀缓存失效'
              : '（还没变化过）'),
        ),
        open
          ? React.createElement(
              'div',
              { style: PB.list },
              versions
                .slice()
                .reverse()
                .map((v, i) =>
                  React.createElement(
                    'div',
                    { key: 'v' + i, style: PB.item },
                    React.createElement(
                      'div',
                      { style: PB.name },
                      '第 ' +
                        v.turn +
                        ' 轮 · ' +
                        v.prevHash +
                        ' → ' +
                        v.hash +
                        ' · ' +
                        v.sectionCount +
                        ' 段 / ' +
                        v.toolCount +
                        ' 工具',
                    ),
                    v.added.length
                      ? React.createElement('div', null, '新增：' + v.added.map((x) => x.name + '(' + x.length + ')').join(', '))
                      : null,
                    v.changed.length
                      ? React.createElement(
                          'div',
                          null,
                          '变化：' + v.changed.map((x) => x.name + '(' + x.was + '→' + x.length + ')').join(', '),
                        )
                      : null,
                    v.removed.length ? React.createElement('div', null, '移除：' + v.removed.join(', ')) : null,
                    v.toolsChanged ? React.createElement('div', null, '工具定义变化（名称或描述）') : null,
                  ),
                ),
            )
          : null,
      )
    }

    // 前缀卡片：插在消息流最前面（conversation.chat.flow 是 display:contents 的锚点，
    // 0 尺寸但子节点就是消息行）。全程 try/catch，出错最多不显示，不会拖垮客户端。
    // 系统前缀面板（悬浮）：锚定在输入框容器（conversation.composer，真实盒子）上方，
    // 落在对话面板内部左侧，不挤动消息；右下角可拖拽缩放；每段独立折叠。
    function installPrefixCard(ctx) {
      try {
        ctx.effect(() => {
          const stop = injectionSubscribe(() => {})
          const styleTag = document.createElement('style')
          styleTag.textContent =
            '#xykp-prefix-panel.collapsed{height:auto!important;max-height:none!important;resize:none!important;width:auto!important}' +
            '#xykp-prefix-panel summary::-webkit-details-marker{display:none}' +
            '#xykp-prefix-panel summary{list-style:none}'
          document.head.appendChild(styleTag)
          let timer = null
          let cfgOn = true
          let cfgAt = 0
          let lastSig = ''
          let moved = false
          const sectionCache = new Map()
          let sectionLoading = false
          const loadSections = (sid) => {
            if (sectionLoading) return
            sectionLoading = true
            fetch('/injection-shower/state?full=1', { cache: 'no-store' })
              .then((r) => (r.ok ? r.json() : null))
              .then((d) => {
                for (const one of (d && d.sessions) || []) {
                  const oneSnap = one.snapshots && one.snapshots[one.snapshots.length - 1]
                  if (!oneSnap) continue
                  const pp = one.prefix || {}
                  sectionCache.set(one.sessionId, {
                    hash: pp.hash,
                    toolSig: pp.toolSig,
                    sections: Array.isArray(oneSnap.sections) ? oneSnap.sections : [],
                    tools: Array.isArray(one.originTools) ? one.originTools : [],
                    unlocked: Array.isArray(one.unlocked) ? one.unlocked : [],
                  })
                }
              })
              .catch(() => {})
              .finally(() => {
                sectionLoading = false
                lastSig = ''
                const el = document.getElementById('xykp-prefix-panel')
                if (el) render(el)
              })
          }

          // 工具表单独按会话拉：描述全文不跟着 3 秒轮询走
          const toolCache = new Map()
          let toolLoading = false
          let toolUnavailable = false
          const loadTools = (sid) => {
            if (toolLoading || toolUnavailable) return
            toolLoading = true
            fetch('/injection-shower/tools?session=' + encodeURIComponent(sid), { cache: 'no-store' })
              .then((r) => (r.ok ? r.json() : Promise.reject(new Error('http ' + r.status))))
              .then((d) => {
                if (!d || !d.ok) throw new Error('bad payload')
                toolCache.set(sid, {
                  hash: d.hash || '',
                  toolSig: d.toolSig || '',
                  tools: Array.isArray(d.tools) ? d.tools : [],
                  unlocked: Array.isArray(d.unlocked) ? d.unlocked : [],
                  unlockedKey: (Array.isArray(d.unlocked) ? d.unlocked : []).join(','),
                  droppedSections: Array.isArray(d.droppedSections) ? d.droppedSections : [],
                  everDropped: Array.isArray(d.everDropped) ? d.everDropped : [],
                  droppedKey: (Array.isArray(d.droppedSections) ? d.droppedSections : [])
                    .map((x) => x && x.name)
                    .join(','),
                  secKey: (Array.isArray(d.everDropped) ? d.everDropped : []).join(','),
                })
                lastSig = ''
                const el = document.getElementById('xykp-prefix-panel')
                if (el) render(el)
              })
              .catch(() => {
                // 接口暂时不可用（宿主没重启/正在重启）：先标一下，20 秒后再试
                toolUnavailable = true
                lastSig = ''
                const el = document.getElementById('xykp-prefix-panel')
                if (el) render(el)
                setTimeout(() => {
                  toolUnavailable = false
                  lastSig = ''
                  const again = document.getElementById('xykp-prefix-panel')
                  if (again) render(again)
                }, 20000)
              })
              .finally(() => {
                toolLoading = false
              })
          }

          const loadCfg = async () => {
            if (Date.now() - cfgAt < 5000) return
            cfgAt = Date.now()
            try {
              const r = await fetch('/xykp-console/rows', { cache: 'no-store' })
              const d = await r.json()
              const row = (d.rows || []).find((x) => x.id === 'injection-shower')
              if (row && row.config && typeof row.config.showPrefixPanel === 'boolean') cfgOn = row.config.showPrefixPanel
            } catch {}
          }

          const mkSection = (c) => {
            const d = document.createElement('details')
            d.dataset.key = c.name
            d.style.cssText =
              'flex:0 0 auto;border:1px solid rgba(255,255,255,.07);border-radius:8px;background:rgba(255,255,255,.025);overflow:hidden'
            const s = document.createElement('summary')
            s.style.cssText =
              'display:flex;align-items:center;gap:8px;padding:5px 8px;cursor:pointer;list-style:none;' +
              'font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;color:rgba(200,215,240,.85)'
            const nm = document.createElement('span')
            nm.textContent = c.name
            nm.style.cssText =
              'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
            const slot = document.createElement('span')
            slot.style.cssText =
              'flex:none;width:44px;box-sizing:border-box;text-align:center;font-size:9px;line-height:14px;' +
              'border-radius:999px;overflow:hidden;' +
              (c.tag ? 'color:' + c.tagColor + ';background:' + c.tagBg : 'color:transparent')
            slot.textContent = c.tag || '·'
            const sz = document.createElement('span')
            sz.textContent = c.length + ' 字'
            sz.style.cssText = 'flex:none;opacity:.4;font-size:10px'
            s.appendChild(slot)
            s.appendChild(nm)
            s.appendChild(sz)
            const pre = document.createElement('pre')
            pre.style.cssText =
              'margin:0;padding:8px;border-top:1px solid rgba(255,255,255,.05);background:rgba(0,0,0,.18);' +
              'white-space:pre-wrap;word-break:break-word;' +
              'font:11px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;' +
              'color:rgba(210,220,235,.8)'
            pre.textContent = c.text
            d.appendChild(s)
            d.appendChild(pre)
            return d
          }

          const render = (panel) => {
            const sessions = (injectionState && injectionState.sessions) || []
            // 跟着当前打开的对话走（injectionHint 由会话内的 InjectionStep 提供）；拿不到时才退回「最近更新」
            const hinted = injectionHint ? sessions.find((x) => x && x.sessionId === injectionHint) : null
            const withPrefix = sessions
              .filter((x) => x && x.prefix)
              .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            const s = hinted || withPrefix[0]
            if (!s) {
              if (lastSig !== 'none') {
                lastSig = 'none'
                panel.textContent = '注入面板：等待采集…'
              }
              return
            }
            const p = s.prefix
            const versions = s.prefixVersions || []
            const latest = versions[versions.length - 1]
            const collapsed = panel.dataset.collapsed === '1'
            const snap = s.snapshots && s.snapshots[s.snapshots.length - 1]
            let sect = (snap && snap.sections) || []
            // 轮询用的是精简数据（不带 sections / 工具描述），展开时按需补拉并缓存
            const cachedSecs = sectionCache.get(s.sessionId)
            const sectOk = cachedSecs && cachedSecs.hash === p.hash
            if (!sect.length && sectOk) sect = cachedSecs.sections
            const cachedTools = toolCache.get(s.sessionId)
            const toolsOk =
              cachedTools &&
              cachedTools.hash === p.hash &&
              cachedTools.unlockedKey === (s.unlocked || []).join(',') &&
              cachedTools.droppedKey === (s.droppedSections || []).map((x) => x && x.name).join(',')
            const originTools =
              (toolsOk && cachedTools.tools.length ? cachedTools.tools : null) ||
              (sectOk && cachedSecs.tools && cachedSecs.tools.length ? cachedSecs.tools : null) ||
              s.originTools ||
              []
            const unlockedNames =
              (toolsOk && cachedTools.unlocked.length ? cachedTools.unlocked : null) ||
              (sectOk && cachedSecs.unlocked && cachedSecs.unlocked.length ? cachedSecs.unlocked : null) ||
              s.unlocked ||
              []
            const droppedSections =
              (toolsOk && cachedTools.droppedSections.length ? cachedTools.droppedSections : null) ||
              s.droppedSections ||
              []
            const everDropped =
              (toolsOk && cachedTools.everDropped.length ? cachedTools.everDropped : null) ||
              s.everDropped ||
              []
            if (!collapsed && !sect.length && !sectOk) loadSections(s.sessionId)
            if (!collapsed && !toolsOk && !toolUnavailable) loadTools(s.sessionId)
            const changedCount = latest
              ? latest.changed.length + latest.added.length + latest.removed.length
              : 0
            const sig =
              p.hash +
              '|' +
              p.sectionCount +
              '|' +
              p.toolCount +
              '|' +
              sect.length +
              '|' +
              originTools.length +
              '|' +
              unlockedNames.length +
              '|' +
              (toolsOk ? 1 : 0) +
              '|' +
              droppedSections.length +
              '|' +
              everDropped.length +
              '|' +
              (latest ? latest.turn + '|' + changedCount : '') +
              '|' +
              (panel.dataset.collapsed === '1') +
              '|' +
              (panel.dataset.w || '') +
              '|' +
              s.sessionId
            if (sig === lastSig) return
            lastSig = sig

            const openMap = new Map()
            // 只继承同一会话内的展开状态：换会话时全部收起，免得上一段会话里展开的大段
            // 在新会话里又把面板撑满，连带把其它行挤扁
            if (panel.dataset.sid === s.sessionId) {
              for (const d of panel.querySelectorAll('details')) if (d.dataset.key) openMap.set(d.dataset.key, d.open)
            }
            panel.dataset.sid = s.sessionId

            panel.textContent = ''
            panel.style.width = collapsed
              ? 'auto'
              : panel.dataset.w || 'min(560px, calc(100vw - 48px))'

            const title = document.createElement('div')
            title.style.cssText =
              'display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:move;user-select:none;' +
              'background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.015));' +
              'border-bottom:1px solid rgba(255,255,255,.06)'
            let dragged = false
            const caret = document.createElement('span')
            caret.textContent = collapsed ? '▸' : '▾'
            caret.style.cssText =
              'flex:none;width:12px;text-align:center;font-size:11px;opacity:.7'
            const titleText = document.createElement('span')
            titleText.textContent = '消息前缀'
            titleText.style.cssText = 'flex:none;font-size:12px;font-weight:500;letter-spacing:.02em'
            const meta = document.createElement('span')
            meta.textContent = p.sectionCount + ' 段 · ' + p.toolCount + ' 工具'
            meta.style.cssText =
              'flex:none;font-size:11px;opacity:.45;font-family:ui-monospace,monospace'
            title.appendChild(caret)
            title.appendChild(titleText)
            title.appendChild(meta)
            if (latest && changedCount > 0) {
              const badge = document.createElement('span')
              badge.textContent = '第 ' + latest.turn + ' 轮 · 改动 ' + changedCount + ' 处'
              badge.style.cssText =
                'flex:none;font-size:10px;padding:1px 6px;border-radius:999px;' +
                'color:#f0c27a;background:rgba(240,194,122,.12);border:1px solid rgba(240,194,122,.2)'
              title.appendChild(badge)
            }
            const spacer = document.createElement('span')
            spacer.style.cssText = 'flex:1'
            title.appendChild(spacer)
            const hashEl = document.createElement('span')
            hashEl.textContent = String(p.hash || '').slice(0, 8)
            hashEl.style.cssText =
              'flex:none;font-size:10px;opacity:.28;font-family:ui-monospace,monospace'
            title.appendChild(hashEl)

            const togglePanel = () => {
              panel.dataset.collapsed = panel.dataset.collapsed === '1' ? '0' : '1'
              panel.classList.toggle('collapsed', panel.dataset.collapsed === '1')
              lastSig = ''
              render(panel)
            }
            caret.onclick = (ev) => {
              ev.stopPropagation()
              togglePanel()
            }
            title.onclick = () => {
              if (dragged) {
                dragged = false
                return
              }
              togglePanel()
            }
            // 双击标题：位置复位到默认右上角（拖飞了的兜底）
            title.ondblclick = (ev) => {
              ev.preventDefault()
              moved = false
              lastSig = ''
              render(panel)
            }
            title.onpointerdown = (ev) => {
              if (ev.button !== 0) return
              ev.preventDefault()
              dragged = false
              const pr = panel.getBoundingClientRect()
              const dx = ev.clientX - pr.left
              const dy = ev.clientY - pr.top
              const startX = ev.clientX
              const startY = ev.clientY
              const onMove = (e2) => {
                if (Math.abs(e2.clientX - startX) + Math.abs(e2.clientY - startY) > 3) {
                  dragged = true
                  moved = true
                }
                if (!moved) return
                // 拖动时就把位置夹在屏幕内，别让标题栏（唯一拖拽点）跑到视口外
                const pw = panel.offsetWidth
                const left = Math.min(
                  Math.max(e2.clientX - dx, -(pw - 140)),
                  window.innerWidth - 80,
                )
                const top = Math.min(Math.max(e2.clientY - dy, 0), window.innerHeight - 40)
                panel.style.left = Math.round(left) + 'px'
                panel.style.top = Math.round(top) + 'px'
                panel.style.right = ''
                panel.style.bottom = ''
              }
              const onUp = () => {
                window.removeEventListener('pointermove', onMove)
                window.removeEventListener('pointerup', onUp)
              }
              window.addEventListener('pointermove', onMove)
              window.addEventListener('pointerup', onUp)
            }
            panel.appendChild(title)
            // 工具行：初始（冻结表）∪ 解锁（关键词命中过）∪ 锁定（注册了但没进表也没解锁）；点开看描述
            let frozenList = Array.isArray(p.tools) ? p.tools : []
            if (!frozenList.length && typeof p.toolSig === 'string' && p.toolSig) {
              frozenList = p.toolSig.split('|').map((x, i) => {
                const at = x.lastIndexOf(':')
                return { name: x.slice(0, at), length: Number(x.slice(at + 1)) || 0, order: i }
              })
            }
            const frozenMap = new Map(frozenList.filter((t) => t && t.name).map((t) => [t.name, t]))
            const unlockedSet = new Set(unlockedNames)
            const originNameSet = new Set(originTools.filter((t) => t && t.name).map((t) => t.name))
            const known = new Set()
            const toolRows = []
            const pushTool = (name, length, text, state) => {
              if (!name || known.has(name)) return
              known.add(name)
              toolRows.push({ name, length: length || 0, text: text || '', state })
            }
            for (const t of originTools) {
              if (!t || !t.name) continue
              pushTool(
                t.name,
                t.length,
                t.text,
                frozenMap.has(t.name) ? 'init' : unlockedSet.has(t.name) ? 'unlocked' : 'locked',
              )
            }
            for (const t of frozenMap.values()) pushTool(t.name, t.length, '', 'init')
            for (const n of unlockedSet) {
              // 解锁历史里可能有已经不在注册表里的老工具（如 qq_send）：当前没注册就不显示
              if (originNameSet.size && !originNameSet.has(n)) continue
              pushTool(n, 0, '', 'unlocked')
            }
            const cntInit = toolRows.filter((t) => t.state === 'init').length
            const cntUnlocked = toolRows.filter((t) => t.state === 'unlocked').length
            const cntLocked = toolRows.filter((t) => t.state === 'locked').length
            const cnt = (value) => (originNameSet.size ? value : '?')

            const group = (key, label, extra) => {
              const d = document.createElement('details')
              d.dataset.key = 'group:' + key
              d.style.cssText =
                'flex:0 0 auto;border:1px solid rgba(255,255,255,.07);border-radius:8px;background:rgba(255,255,255,.02)'
              const head = document.createElement('summary')
              head.style.cssText =
                'display:flex;align-items:center;gap:8px;padding:5px 8px;cursor:pointer;list-style:none;' +
                'font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;color:rgba(200,215,240,.85)'
              const nm = document.createElement('span')
              nm.textContent = label
              const info = document.createElement('span')
              info.textContent = extra
              info.style.cssText = 'margin-left:auto;font-size:10px;color:rgba(160,180,205,.55)'
              head.appendChild(nm)
              head.appendChild(info)
              d.appendChild(head)
              return d
            }

            const toolsGroup = group(
              'tools',
              '工具',
              '初始 ' + cntInit + ' · 解锁 ' + cnt(cntUnlocked) + ' · 锁定 ' + cnt(cntLocked),
            )
            const tags = {
              init: ['初始', 'rgba(127,209,168,.9)', 'rgba(127,209,168,.10)'],
              unlocked: ['解锁', 'rgba(122,178,255,.9)', 'rgba(122,178,255,.10)'],
              locked: ['锁定', 'rgba(150,165,185,.7)', 'rgba(150,165,185,.08)'],
            }
            // section 状态：这次被摘掉的 = 锁定；历史上被摘过又回到提示词里的 = 解锁；其余 = 初始
            const secNames = new Set(sect.map((c) => c.name))
            const everDroppedSet = new Set(everDropped)
            const secRows = sect.map((c) => ({
              ...c,
              state: everDroppedSet.has(c.name) ? 'unlocked' : 'init',
            }))
            for (const d of droppedSections) {
              // 空段落（本来就没内容）不当作“锁定”列出
              if (d && d.name && !secNames.has(d.name) && (d.length || d.text)) {
                secRows.push({ ...d, state: 'locked' })
              }
            }
            const secLockedCount = secRows.filter((r) => r.state === 'locked').length
            for (const t of toolRows) {
              const row = document.createElement('details')
              row.dataset.key = 'tool:' + t.name
              row.style.cssText = 'border-top:1px solid rgba(255,255,255,.05)'
              const sum = document.createElement('summary')
              sum.style.cssText =
                'display:flex;align-items:center;gap:8px;padding:4px 10px;cursor:pointer;list-style:none;' +
                'font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;color:rgba(200,215,240,.8)'
              const slot = document.createElement('span')
              const style = tags[t.state] || tags.locked
              slot.textContent = style[0]
              slot.style.cssText =
                'flex:none;width:44px;box-sizing:border-box;text-align:center;font-size:9px;line-height:14px;' +
                'border-radius:999px;overflow:hidden;color:' +
                style[1] +
                ';background:' +
                style[2]
              const nm = document.createElement('span')
              nm.textContent = t.name
              nm.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
              const len = document.createElement('span')
              len.textContent = t.length + ' 字'
              len.style.cssText = 'flex:none;font-size:10px;color:rgba(160,180,205,.5)'
              sum.appendChild(slot)
              sum.appendChild(nm)
              sum.appendChild(len)
              const pre = document.createElement('pre')
              pre.textContent =
                t.text ||
                (toolsOk
                  ? '（这个工具发出去的描述为空）'
                  : toolUnavailable
                    ? '（宿主还是旧版，重启 dsh web 后这里会显示描述）'
                    : '（描述按需加载中…）')
              pre.style.cssText =
                'margin:0;padding:4px 10px 8px;white-space:pre-wrap;word-break:break-word;' +
                'font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;color:rgba(170,190,215,.8)'
              row.appendChild(sum)
              row.appendChild(pre)
              if (openMap.get(row.dataset.key)) row.open = true
              toolsGroup.appendChild(row)
            }
            if (openMap.get(toolsGroup.dataset.key)) toolsGroup.open = true

            const secGroup = group(
              'sections',
              '系统提示词',
              sect.length + ' 段' + (secLockedCount ? ' · 锁定 ' + secLockedCount : ''),
            )
            for (const c of secRows) {
              const tg = tags[c.state]
              const cc = tg ? { ...c, tag: tg[0], tagColor: tg[1], tagBg: tg[2] } : c
              const d = mkSection(cc)
              if (c.state === 'locked') d.style.opacity = '.72'
              if (openMap.get(c.name)) d.open = true
              secGroup.appendChild(d)
            }
            if (openMap.get(secGroup.dataset.key)) secGroup.open = true

            const body = document.createElement('div')
            body.style.cssText =
              'display:' +
              (collapsed ? 'none' : 'flex') +
              ';flex-direction:column;gap:6px;padding:8px;overflow:auto;min-height:0'
            body.appendChild(toolsGroup)
            body.appendChild(secGroup)
            panel.appendChild(body)
          }

          const tick = () => {
            try {
              loadCfg()
              let panel = document.getElementById('xykp-prefix-panel')
              if (!cfgOn) {
                if (panel) panel.remove()
                return
              }
              const comp = document.querySelector('[data-slot="conversation.composer"]')
              let box = comp
              while (box && box.getBoundingClientRect().width < 200) box = box.parentElement
              const r = box && box.getBoundingClientRect()
              if (!r || r.width < 200) {
                if (panel) panel.remove()
                return
              }
              if (!panel) {
                panel = document.createElement('div')
                panel.id = 'xykp-prefix-panel'
                if (panel.dataset.collapsed === '1') panel.classList.add('collapsed')
                panel.style.cssText =
                  'position:fixed;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;' +
                  'background:rgba(25,28,35,.94);backdrop-filter:blur(10px);' +
                  'border:1px solid rgba(255,255,255,.09);border-radius:12px;' +
                  'box-shadow:0 12px 32px rgba(0,0,0,.45);z-index:60;' +
                  'font:12px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#d7deea'
                // 默认折叠：只占标题一行，点开再看内容
                panel.dataset.collapsed = '1'
                panel.classList.add('collapsed')
                lastSig = ''
              }
              if (panel.parentElement !== document.body) document.body.appendChild(panel)
              // 左上角：x 用输入框容器的左边界（=对话面板左边界），y 用消息滚动容器的上边界
              let sc = document.querySelector('[data-slot="conversation.chat.flow"]')
              while (sc) {
                const sr = sc.getBoundingClientRect()
                const cs = window.getComputedStyle(sc)
                if (sr.height > 200 && (cs.overflowY === 'auto' || cs.overflowY === 'scroll')) break
                sc = sc.parentElement
              }
              const sr = sc ? sc.getBoundingClientRect() : r
              panel.dataset.w = Math.round(Math.min(620, Math.max(360, r.width - 24))) + 'px'
              panel.style.maxHeight =
                panel.dataset.collapsed === '1'
                  ? 'none'
                  : Math.round(
                      Math.max(180, Math.min(sr.height - 24, window.innerHeight * 0.62)),
                    ) + 'px'
              render(panel)
              if (!moved) {
                const pr = panel.getBoundingClientRect()
                panel.style.left = ''
                panel.style.top = Math.round(sr.top + 12) + 'px'
                panel.style.right =
                  Math.round(Math.max(12, window.innerWidth - sr.right + 12)) + 'px'
                panel.style.bottom = ''
              } else {
                // 兜底：已经把面板拖到屏幕外（标题栏看不见）时自动拉回来
                const pr = panel.getBoundingClientRect()
                let left = pr.left
                let top = pr.top
                if (top < 8) top = 8
                if (top > window.innerHeight - 48) top = window.innerHeight - 48
                if (left + pr.width < 120) left = 8
                if (left > window.innerWidth - 96) left = window.innerWidth - 96
                if (Math.round(left) !== Math.round(pr.left)) {
                  panel.style.left = Math.round(left) + 'px'
                  panel.style.right = ''
                }
                if (Math.round(top) !== Math.round(pr.top)) {
                  panel.style.top = Math.round(top) + 'px'
                }
              }
            } catch (e) {
              console.warn('[dsh-xykp] 前缀面板渲染失败：', e)
            }
          }

          timer = setInterval(tick, 1000)
          tick()
          return () => {
            clearInterval(timer)
            const panel = document.getElementById('xykp-prefix-panel')
            if (panel) panel.remove()
            styleTag.remove()
            stop()
          }
        }, 'dsh-xykp: prefix panel')
      } catch (e) {
        console.warn('[dsh-xykp] 前缀面板安装失败：', e)
      }
    }


    // 消息流里的注入行：宿主补丁在每条消息前渲染这个槽位，我们只在本轮第一条渲染一次
    let injShownTurn = null
    function InjectionRow(props) {
      const turn = props ? props.turn : undefined
      const [state, setState] = React.useState(injectionState)
      React.useEffect(() => injectionSubscribe(setState), [])
      if (turn === undefined || !state) return null
      if (injShownTurn === turn) return null
      injShownTurn = turn
      const s = (state.sessions || []).find((x) => x && x.prefix)
      if (!s) return null
      const snap = (s.snapshots || []).find((x) => x.turn === turn)
      const notes = (s.notices || []).filter((n) => n.turn === turn)
      if (!snap && notes.length === 0) return null
      const rows = []
      if (snap) {
        rows.push(
          React.createElement(
            'div',
            { key: 'snap', style: { margin: '2px 0' } },
            '单次注入 · context ' +
              (snap.contexts || []).length +
              ' 段' +
              ((snap.changedSections || []).length ? ' · 变化段落 ' + snap.changedSections.length : ''),
          ),
        )
      }
      for (const n of notes) {
        const t = new Date(n.at).toLocaleTimeString('zh-CN', { hour12: false })
        rows.push(
          React.createElement(
            'div',
            { key: 'n' + n.at, style: { margin: '2px 0' } },
            (n.kind === 'developer' ? '持久注入(dev)' : '持久注入') +
              ' ' +
              t +
              ' · ' +
              String(n.text || '').split('\n')[0].slice(0, 90),
          ),
        )
      }
      return React.createElement(
        'div',
        {
          style: {
            margin: '6px 12px',
            padding: '4px 10px',
            borderLeft: '2px solid #4b8f6a',
            background: 'rgba(75,143,106,.08)',
            borderRadius: 6,
            font: '11px/1.5 ui-monospace,monospace',
            opacity: 0.85,
            whiteSpace: 'pre-wrap',
          },
        },
        rows,
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      // 供注入行回退父会话（fork 出来的对话）用
      sessionsGetter = ctx.get('sessions') || null

      // 页面右下角的 VK-1 余额挂件（senses/balance-reporter 的客户端半边）
      try {
        installBalanceReporter(ctx)
      } catch (e) {
        console.warn('[balance-reporter] 挂件初始化失败：', e)
      }

      // 前缀卡片：直接插进消息流。conversation.chat.flow 是 display:contents 的锚点（0 尺寸），
      // 但它的子节点就是消息行，所以把卡片插成它的第一个子元素即可。
      installPrefixCard(ctx)

      // 每个 assistant step 前面的注入行（宿主补丁提供 conversation.chat.injection 槽位，带 turn/step）
      slots.inject('conversation.chat.injection', () => {
        try {
          return slots.register(
            { name: 'conversation.chat.injection', id: 'xykp-injection-step' },
            (props) => React.createElement(InjectionStep, props),
          )
        } catch (e) {
          console.warn('[dsh-xykp] 注入行注册失败：', e)
          return undefined
        }
      })

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
      slots.inject('settings.section', () => {
        try {
          return slots.register(
            { name: 'settings.section', id: 'xykp-config', order: 53, label: () => 'xykp 配置' },
            () => React.createElement(ConsoleSection),
          )
        } catch (e) {
          console.warn('[dsh-xykp] 插件配置页注册失败：', e)
          return undefined
        }
      })

      // 插件页 → 配置：同一个控制台，放在整页里更宽敞
      slots.inject('plugins.tab', () => {
        try {
          return slots.register(
            { name: 'plugins.tab', id: 'xykp-config', order: 5, label: () => 'xykp 配置' },
            () => React.createElement(ConsoleSection),
          )
        } catch (e) {
          console.warn('[dsh-xykp] 插件页配置页签注册失败：', e)
          return undefined
        }
      })
    }

    // ==== BEGIN GENERATED: senses/balance-reporter ====
    // 由 senses/balance-reporter/client/build.mjs 生成；改素材/挂件后重新跑，不要手改。
    var __xykpVk1Assets = {"expression_11":"data:image/webp;base64,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","expression_12":"data:image/webp;base64,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","expression_21":"data:image/webp;base64,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","expression_22":"data:image/webp;base64,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","rice":"data:image/webp;base64,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","iron_bowl":"data:image/webp;base64,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","hit":"data:audio/mpeg;base64,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OMcZKIuqW1LKl8YNfxL4EgAIpJ8yCQMKj7Dawr8KBLGVNB8MoTTBIAxzjqAt7QsRaMW6LSto8bJY0vFIl1X2nZVLqsZwprVWm3S8rWsbOqqIqKGhUVE2aKlxyYONly7VTEFNRTMuMTAxIChiZXRhIDIpVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUYApMiqXkNIvWPuRPVaZahYbhgbo/FZlo6OUyVCTrF6yj8R8YlYukIggqCwOhcD4cCGIBLO0cmUMDBAgcdDP/7smQfD/RuWiiRg06yAAANIAAAAQAAAaQAAAAgAAA0gAAABIyWWWUj///VrLLLZcy/zVlaggYUEdOLoG3NIkJEIREMjA2MDQfDxcgRsPZQrKpLqTc9pCiISxUoXKDR0ojQPZaVisqkmkupMMWS00VTP+qpTEFNRTMuMTAxIChiZXRhIDIpVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVQ==","feed":"data:audio/mpeg;base64,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ESSKHpOqlU7cORbmX5a/dSXRGdiMhuw1J38LTCix6Ako0NKqi8gcpOVlstpasZ9/m4w6XlT4AQnLhiRyp1kBK9F1dhqmVuXa0wyuLTmOArKd+TU8WkL9NdYeZxiYRod1IbjaZtOco2W2RUNScM9XNYiOi0EJUyopQ1DkuOERa9f5rLLLKai0OuUw4LCQsONGGMQZGgBABSsanH45TQ2CAoTDWBNstDDaGJf/+7BkWQ/4BU4ngxrHIAAADSAAAAEAAAGkAAAAIAAANIAAAASkGmRaZalsGGAkUw1IxaW6iL6KbJthwjI8gcGXBXQSJgbySu3cviIGgaBUNeJQVBUGgaBoGgr8SgqCoLA0DQNfiUFQVBUGga/UJQVBUFTtTEFNRTMuMTAxIChiZXRhIDIpVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVQ==","pot_land":"data:audio/mpeg;base64,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FTKiUaGDDRYeAQKDBAM0VMGHGdSKGbW6Xg0Ucc7u9zWNf39fY1tjLW7nHMd3TEFNRTMuMTAxIChiZXRhIDIpVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVSAAAcP7NXGU2KgZnYznqcQ0mZmJ7B5BiRpS2cXt4FnnVLwZmVC9Ga8qfTGGphnJiDwSuQwRjB2YmKAQJRSiJoKj5Gjb3wbRtzeQBMHz5QEAfxAZyBzQ5nd6le7br//0f//ZriTYOnm8kTL3LaA0V1BBNLsBzjLWxhwx907CMurSFzb5lUky+4QtMhEMMTrwxjUS8//7smRJh/MWD5sr+0qQAAANIAAAAQ/4kFSP9YmAAAA0gAAABDggoDUEKxpzTJsADE4GAgjxkKQwCEEsQXMkMhKRWUGcmdlTWl3LuXc16HsDoQgSAkB4Rj650JQhA2EYnH1zklCUJQlGS72TEyEoyPnvZWolTEFNRTMuMTAxIChiZXRhIDIpVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7smQAD/AAAGkAAAAIAAANIAAAAQAAAaQAAAAgAAA0gAAABExBTUUzLjEwMSAoYmV0YSAyKVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAxIChiZXRhIDIpVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7smQAD/AAAGkAAAAIAAANIAAAAQAAAaQAAAAgAAA0gAAABExBTUUzLjEwMSAoYmV0YSAyKVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAxIChiZXRhIDIpVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7smQAD/AAAGkAAAAIAAANIAAAAQAAAaQAAAAgAAA0gAAABExBTUUzLjEwMSAoYmV0YSAyKVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAxIChiZXRhIDIpVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVQ==","pot_off":"data:audio/mpeg;base64,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","pat_hand_0":"data:image/webp;base64,UklGRgopAABXRUJQVlA4WAoAAAAQAAAAPwEAGAEAQUxQSNIPAAANDMeNJClShv9mL/bCwS8iJqAKOtHBQqcfaXLfMF2Vq8TTxFXiaeIirhpdky6JrtIV0TzRtNXG0QWhccumLRu22rRlV6Q/rR/Zth1Jsm2rj6lmiRGHc++abG5XZNefwchtzU6omm5sOjf0iJgAX9q2PU9r29p1P+8ngcA5EWzj1nN3G6UYxyjPqM3YHzVI5cixBYONTXIgSkKApO997g0EI9itD21GxATwt6lSAgtyzOzuX/zlny+6tp2N17Hf6s7jH/7q70fcvtNw26wtv8jOTCIhSqeJaK2FzmACUvJSBrJwPy9Eoc5wTsb1VhK/rAmyINNggHsvHzRkKk4PpoB4KbcF3Ft7ogzhtED9/dO81S9uEsvCyezy/PcrkZLGu58rSGleiATy4DffLclJkAry6M3u5JesBTBRmk6J1r7z/Gl3SqOcXLRGyLyQiZB7z1d7XFMkqD3eG6LG1TPqtPqXohK6lZkPfvWksVOaHAISs8WflAFIdDviugRo9WkPELYJPPz4ZWwLf/tCgOa4PH+9KosYb1+Z2eJPVXP7u3/87bKpFDIgj7d2Lk04v302Ddvt1qhN7qw86KQjmEwyjbAA/Uki4BkCQ2f9+aKckoThfO9jRWF/00LgJIG7v3pSwikujiUVoB8cpsKL2s3p2/0W9gogymACIee3TEjYBuL567VIocnOiKdJMIi+KkUOhBB5ahCeurmW/pbZCeosgpdWH3TSCqbTuo5SG2DQvCYxxVltj6ghzIPmsp20hW/o9mc5jdG9754WPDoylADy7Vnx4obz7g8s23q0sTrYPp4SJdPfHgmQBmLtDxtFl++H3KhNiKh5cf7shBwonFme/O7F4MedlhJZ+UY+zgRBncWAhZX7DdSLaSuwoFQBAXm1s3EETt1dedwZ7g8mE4e+FX3m+MF3TwqcHyeInCZESgrHebHC+UBlYeXZ8vGHoymlZP0m/Pmx8scX3Zy8H3JdwXVjn7z2YaP7f/xu+NNOS5RMfwu+PFNp7T2938mYXrwtSaoKCBcxcT1YWn/eGXzqT8dZxLfw52cSDZdfDHL/MVgJVzLQunQW154uHb0/aYkm69f3izPdVUx2zwHEJmm9FEAVae59/2r484eWEjW/vp+dkUA7qdVIVUGuZzbqlOW1F92zw5PpOAtf/6dnnmYLKAlXNJCmNAurK72T7ZOWKFm/Mv8CEcJWLqpLse3732+Mfti95vYrW6ciIBXAXFcFtdWd1efN+aeT6TT52s+ZXSD+Pyuw7dLprq4unWwftURx+zVtpw5VLm9V2jz846vzH3enRGR+Y3J5wuaaxtL6Wuf84+l0ksHXnD/vEge1S9NdW7lz/O6kEiXX381lr8DWg9cb5z/utJSoOiwprq2W1teb0cezydiFOCoB225Kd311+fjt6ZTaek3KPgq2Hv7hV2c/f6hsaZ0VEbRt6a2vds8/n43/1BtxVAiwuimL66tLR9vHLUWucxUgd5168MdX/TcfKiWqPS1FrfTW1xYGh2fjKxfmrYF0Ns3i2rM7h9snLYSOChChTB782cvBT7stih4XFbdt9NZXu8PD/qQ184LtbJqF1bWl/sHRFQZHBSjFNg9fbwy3PlxWyp6WFOtPZXl9ZfrhqEVhz1kCdqspC+q3gMwcNptNbVWY1yZ2Tptnzfl0mprPUNvy+LuV890vVyDPW0JlRufpb9cGm7uXKKjDAsHEvWcPrvYPq1Sc0xJMRkRHA+OG+QsgIzylA1IysG6cbrtPy2h82QZxXMJk1eNfPznZOq2U6jUtlMQLz36zdvZmd0pEnRUBKO48ftQdHQ4ux13EUUFgOUpnfW35y7vTRaKjcr3Y1sPvN87e7DxgY02LcLalt7qyMDr85R8fzbgG2m5iYW39ztnOl7EkOypAOrZ59Ppl/83uGBX3sLjJdVKW1p7Vj0cTAjOsAapp1F2cTFusucs+JNNOu0WJNTBW2NleRgckD4xsmdpOOlBwz8t1KWybMM6LibAt3WNwdVlDeN5Cyu7b0189Ot48TkrJOneJi9vK71bP3uxWBc45S4hYdx8/7l6enI7GDuS5yj5R0V19uXy4dZwQ9ryloq1Hr1+cvdmfIpFzlhhr1fLT1YXx4eBqYjNvDdqU0qy/uHu6ezjGwlEBSnGmHv3xZX9r90oKe1hCuJ3GnWdPJ7sniUo7LAhnqpSioVBojQsQks24E7iYiaE4PV141gwvL2sxsAFtLau/enL802kloYdFhHFn9bcrJ5u7LWyLcZVRs/ToYXd62P/DmzgtASpR58Xz+6fbn8ehcI4KkNiOR69fnGztjRWy54W2jaWVx/nppEUxfwHSKmo606mRmccqZHLSFLDmM3JmO1noANY8BsjMUGGOK4Q9v7GiNJq2Bnke40qj6E3HzGUNUiKbmM9gRcftcDR5eBew5i12ZSE82Ny/9+vF4ppzF5yS8uPm58cPmk7azFWNIxra4eB43A1FYd5CTXcbD7b2Fl8KsJi3OkPkx61PK4uI7lkRqym0w/7x1SIqZS2Z1WzVaehv7fVegItlWpOA+mnry9MecpsZFSWlyemwf3q5qGiadmpm1QcLor+1u7ghXCwzrG0R9dPm0ZMeYlrFPFW6bpvT4dnpeFHqRNua+WomTWGwube4IQgyqhKZEvnpzdGTnsJvnVnBbhqmw7PjaVfqRF3NrK6qbjDc3FnaCBDIpApJofp588uTnsLTFLMqW+N2eHY8XZSapm3NqOrKvXiwtdN7GRCWmbNqkA+2Pj3tKTxNMT81BjVBOzg7nfSk5rbemjm10pnRdDzc3OltCISMqoUzhD9ufnnSQ7SPzIlxSBGR08HZ2WQRSlOnMqh2lkBBf2t3cQOQzbTaEvXL1pdHS4TbVvMTjSI0ORmZej7pSk2pU+aoyWk06Hzr/aXi0UuBMHNRIQbBUj18d3DlZv0usB4ZEWNMW6Wh7Z+e1U5ARONumVBpGiRdMdzcWXgVXFcgMxrZr0Ltl3efHvUkMJnMp7uwJZCt20H/uO1JTcfVmcyn6ZZsxT6eb77vbQQEZp5qRFP0p7efH/cUnrahuYcIRVXg7Ve/eqyteJxPe1LT1KmZf9pOVAJg9ObDpRD+6seCyJQG6ZSUX95+HJeqLF9/BKyVwRAkAiUETE6HSR3VBrkVsNEtk2nLYSGAi83tC+LRRmDM9chsBjBGaYI8fL935bJ6V9y4mEbxXFIFCE9OhxWfZxeIKDHD1mkA26MIqeJ49PbdCD3eKEASAUYi4yjhtIAIH7/bu1Ss3BPXa4JwGEJ9C0VIswy4PetPMoI6ykWZyrbBUhlFbQMyUILbX26+u4Bi398IQAJEplAiUAaEZZTgGcbgw+2DSZDoaU9C6IYwg7KPkCJhQLjtn01JpB9bkaN2IXCVpBLgkkF0T6AKt7zcejeCoonA/VcFbK6LmFGIEATsa0Zw/PZgDGCVTTxeEje6MoSCu6IqElhn/Qm4hlRH2RWsFCASJWTAmcwNu9l7Szj83fbmCIqq4f5GATkti+ueH1jIgJUYxMnbjxdCkSYeL4n/5pJ9uPzGs6JBFqie9a+qupmjdhGoEpYoBSRHdh9df6teM4oQMydvt4aSlfdeFszNFqdlDgUgbONU4OP3u+Mw+PGSuG0mBI/C5dcjKeKaqf3TcY3A5+0SuAWIBowAZ5pZtA2GIgGIq3ebw7CU9zY6gK/NN8NhhkkkTt4dXIQxj5bFjZmADGheIB5lS0RQ+ydXVnG9ql1wCxBlVqYBM1dMWxhKMHvydqtPkv7spzfAHRRNaXYz6BPJMgKMjfDZ9t64Gvjq04RDuwUMcygnCjPr4Hhc1eBRLlI+OlAbYLQ5YBJbD6Iwe7y9dSaCXH7ZpZGnhnEUSCQIJDZC/Xf7lyLFg2XxtBeEJqMg0aQqEsjB0VVSVC9zQXLrgGgOXAICToLpBmrjePpus+/AXn7VAcytg0xkMNjSbPjsw95Fk8L374gbM0ESRtF4hqQIXIdHV1UFRrWHeEtC3Q50CSDDWG1hKAVgsr11KlC983IBg5yVmZQwgpoOPNg+GBWndf9OCCTSfZDMgSIQhFLEzHp8MoFx7QItQDTM7PZgFF08j0Az2p2fjq27G9fmn8lOAjZOAvq7e+fm/sNyk+s1yQwInqiq8NSDw8ukRF54ESCiY0CuyWxnANoGioYt4flk5+dTELn8snctJWFAvmEIZQnACBIbsIUG2wfnhcYvPqsdLgiGCdRbEFLcon90aZRIjNsesBqoO9gtg2j6JhVxc7v74zFICV56tQDI3jCBnkm4bdqAEQw+7J8jBdXcvSMEIN1MoPEEFboph4cXBmeBq+yhTCSAaIyEbpwAWp/Vxi3bnZ+Pk6JMWH6xiDH/3ciFdxeBhH0QaBswgtHO3jkQqrB8J7ht1mty5QUkBklVAAn468ORwRnyOBckqiWA6Nyi2tcufiY3F4mb270fj0yR03z0wyeclSDZzaCUQYYdVGzLRuj8w8E5ODB88lkRjASx5eqLJ0JFRgjjweHI4NrApPYENjPrLulCcAngpaNbQBjUIK4L6sF/HdpFtHLvRQ8wswWIzGEBGIEzAdIhznf3h0Bg07sbgMBAej1LrpqeyS3hqc8PB9cING57QJqZ6kBCgN0AAsh1Xw0hDVtxMvd/PGylJlu89GKZ/+nIAFZALGhFSAIudvYHSYSd9O7ErdzqFtfbNhLY12SIInGjR4cDAzXEOD8EV3OYWxACtrrzmuF0SM5rMqAQN+fBD5+TCFdYfPEZkZMSEBK54j6RhLHEzXYasCUud/b7QJCweGeLeaILiFx24xERsq0IwAg8+jw0OENM62JAJhioO89tAbnwtgdRgMwIbs5PP3xqiXCahed3uK0EzEG46D4JBBnsdIRcbfmaLncP+kahTBbvBbrBuATcXXajQUhtYIHPPo8frC20n4/SUR2inS4FZIrrakApGbwYQBfHt3DYfviPi1ffPxz85/spKtW4++IeYGZbkGEHc0LphszEQpfv9q8e/Xrly/Zxyo2WD7/YIjHueMjea2fwDKmREXh02J+4CU/zTjmdlNop4CPscw9CAJeMoDNnRAEB+MsP+1UON7/psv9fR49WweCBFsYDplBCBmc6LTHZ3xugtHt3Qsc/HT3qiptlSYxAZqAWhZh58fmsdQmuciEgKxDN1fAKdYRA0FZA5rB1B4HARz/st5JqZ+0BN9oANgSQEKax2FmdBY33DvqiWt17RbPsROBq5rLx1eHpmBJM28WArIAazUqrYCdzzZOfPrRK1c76Q26UQBcGugyT2U4+fjxKpSh3igwRWAIC2DKb/9xmp4FsAZoAg8sTMB1/3Xm2ws1mBmFQ/6Zzr4NmmGpAZvULqGF2NfNZOyCDFPNYGbICyZz2jt1Mrkzv2/i8+//d/+/+f/f/u///RzhWUDggEhkAANCOAJ0BKkABGQE+USiPRiOioSGiVFrAcAoJZ27OqFAUhmgQ/T3ZNb7TnZRHG7yvbayGMvPyd+j6Meb76YPMB+xv7Ve9p6PP796M39V6w/0AP1V9OL9xvgw/tf/S/cr4Dv2A/+HsAf//1AP/r0w9wD5e9RPE/sl+23O7a//zvVB3e/NzQc/pfHqXfcE9my/qv++4Uv+l9wr+Nf2L/U/33+wfuV9Hv+X/vvvH90P5r/jf+r7gf8e/pP+9/s/tHewX9pfYU/VMbyIcvTOrPUI39Gg17BlYSE6cvvfFkG2iP3cph5kfvQZsWUii/sJ9LnEcctdgDZQQrr+ghR9XgvlYlfRPbUFaqUo7HyI3JCOH+n3VY3lrohbUPlUFgSGyQ9ayVguIgAKOLjsAp69FQRzoywdMYEcXga3P5G96Tl99wVDTmAAsRJZq3ziUecEk18F5Cl8a1lNPGSXEiVvlZFrHZq4MgDw6Dy1eNBV7Ozb2pCzmV76Eewv4XO5FehoMtFI8ybP/sMPw2K36Wi0i+WDYTWdodr4HL0QEPHD4JbUKt6hOG5WUPWhIO4RneIjTUW0JX/WfjMxMD8rHxOsa0AGMHCX0YxAMTxlN/yduHBCEdB+/BbTdEMKA7205az48D78VVPDJtSt2BWdgoK2FhnodgUHsil1m2UvO3zXntG+T4VyDCid/vAqZIngebDkWYhL0V9zPrf6yye8vASiemiAwT7ro9kLuaPEf9cNIszpOg/amdVQkgMD5sJ0so28NlRYTOWomW6h22XWwlVmSRI/EWK9ksss+cyO8ia33tuWY85HljoZjwKNdAluiq1ubVTUryq/W43ZVJaeGLoXW4U7m3rp9MyFJLUMr9YOqHiMWP9egJsWwhd9YeQQkYjB57lYYBUnshG+ISThVchmROzBwzQyA1jOeIUi51KyPlOGmvxy1PwgB9D2JVBwLhv9wLZhXxDA75/TYhl/SCI/xCrkQ57H7DiQs01gHQDyEp6NB+CbwvFl6uPiAi/btukDw+afPwyIrHrafPANpq29tKQx4C0lWW9WKAtIDZbvTxsphgKbhpfGVHgf0YY/RWl6/w1PLsy9Tqo/zXKd9EmKBWfRFKTN4zw2X0nE+WdH6CRy2jfrfVArBlPJO9iwrKTHwV6H+6Y8NihqJEIx5mUhjrvdbLzIShAXDln7JL6o9l4clMnOmYqmpI8vzPsujcma76pzHHsGzRVbCzlMF8wQpDqJXXk8y6V4u1kW7mq9YNZHHXfx7jQ/zCA50R3RltSRaU+Ch/4HI2DroxncuN2P1iaahNW56wfjgj/kq1izXoa7SKoDNxyW14MJ1uDV1GW7qcV0MJAH+JeT1IyIs15tZ7nH96tcOkUnVbic7b1ZO5HZlCopriT/aryNl98brC7SmUvgaUIsByZc56z4vzfCCFBgQxS8SKgyXLnyAUJRzCxRyYaAekyhzNGncvEioMt3gqosu+FRZd8Kiy74VFl3wqLLvhUWXfCosu+FRZd8Kiy74VFl3wqLLvhUWXfCosu+FRYQAAP728XX2p7asuxlSevj0NZTzosEkP6Br/ReIhSSJAOvN+I2MThSZiJYlnk3i/j/G5qSsHsbn92Vm4APsn+FE0sDbBlr7WVcAivfyMfhqWsVphvU4fXEJLSRUtazPeeZYv0tHsCmkfPW70U96uu3vzp8k6jrQ1N1OiGqJsOufO4fT+vn6zfQxcxB9snl21DNereW3Cgc8/AXrHnDcNla5pxtEMZEYmxDmvby5UCtiCtdbrO9DBGz5tGVbsen7Dtl+5Xxboe7vLA0kGIDsApW/dL727jFomiZrAtKWMK409hI/R0k3opNvRyu9crNRprDCD7O5RHJ+BmMj2f3f0e/3dELe4IDm7RUwg+5zx8EL6eDwSjL8nNJy6Dj1xtKQGpVTuu/KQNf5WTIfoljUKb0VVqm06yfYU/l9n9nX6F4wy8UbmRPXDfTJdQiCDrFosfQECgCDJaDy56KMMpDK3yb3tdBXMdPuyVFn6x68zMxfao6VXcXIYCZnYKRugRqdM/1Ro9+yhOUcGaFtG6V5N/ixCqbQHWcPOl/tnOycGBTFiOf3hm1PD0b7MkiIQBMvvbiYINlfTcp1zD2Wa/SDjGG76WbGfQ7SZflRX2gS7q8XV2RY1N/v9XLdm4qbtpRS69hQzRUKtPdLpQkSWQ3gqJhjVE6REZctO1KKXojxjMNv5r1cwGz1WnaNjroReH7f6DIZuCkUmrSAzm/se9h9Qf9yoAOT5eMk1Y0jxAMWOuRdO26bvLhDRk5XWCDs5Nhphrk91hMwKPs4p4NofxgI2ftaVmz9XG5Z8NsHgWHW87itQtHlw+6F9CV/lzYyToOyaS7y0l9MBnO/1s3SDwdkztv5GVSJHtKaD1k4aOxLRXqBiXdmKCib1eE1uiG3v55dhr6PKkqfayf6GBgeysAkFLeq+iPt6gobvj6SeGpsABDaCvFFoe++82pySEgKrtxoXwIQB0IwmSxFAOKTyydc/k8zbkA1x7+mEjz6WSa2EKHmhhgdD8eTDPzzmiP0GwPawgFjt2cYH03O0O5pjs7LUPUyjIPYN3s/331B01YyHwXT66HtFLTn9VwR+eapISImxX0+bbxN9OnaS1kgRFArSzOOnHsDTI2I0iCKFvHCc96S+ws37pM0noWs/wsdDpKeSjKhU2sgavG3NbWd+/r/+Qp4/GqY7SlaA05FVZE2hoRNa24SW8kQ4f5PqIazbD9GbBywgCHJ5i87vvN4Xa7lmNUgTj6A5zhV7dSfBd5HmBxCwpKyo8fh15iOG0Ip0NkeB+TOuWX8ebZskfqsi1eNSURuoHNY5jLrucipsdq1Kkx3sW7/NOZTVQxc99H96+qFkq5dykzblQ4pCzkF0Yf9aX2+offx9mYPl7tRyP1cR66kl2J5IyFqZ+VChLAfZ7OcrtQlGdwQ0uPSjocQ8W5RwqF0b+QEGrekxNnnQfQ1yZUmey4v4poeQqXPM7sr8Fwc3dcwQJGg90rXC7Xnkb2P9cHf1KV1i3+bDpZffpnUkro86cCwMd/KZt8romIJQDIgxazDVOsIDw/trbtlJ4PECbxfhviuk3NNKoOJdG55ay4ZErHH+2Qrurvau6zbkTojfr4/AR2FNSJCeAbY53socUIeGqqt6SDuqrH4O640Cy82J93n3yCRR8LiWUCzXefO6kUyLhWc63RIW4vu6EjSfin+NHF3RaWByETblYt4MoojfhvqTk9VS4fhVOrzaG8yV5kV5RFnRzsuniaDsiC4+85wA6tAXBZJ6GDMSutlv+TjL8tyTlnAtE6FBigYemUT7JN0Z6e+q3rCfN+jzl3GDkeH+QlLHsBiC3NCu03PgBZzRmgcdH1WUjiQJKmhhl1Eoilv7ZOYXn8d3ePq+bQay8a/rWVE5ol4Y8Bl5fBpAn2CLsEivgXK/VszUSLM1BYjdOXFVZk2gqOk6+qtDwMR5Kf6FA/Wrc8Azue5h9bl9opdk3uxX4fYnSxVx7qVW5h11jJ6zEiRQATVK5rxR8/KCPq+6835p8F/9FQb4M7NPGweARgRi8pC6YCyVLjALv9y94PLK9VqJtH9eRzZFc5c3LhVZAD+BxtPkWl61roPtgorncVVuQDT5Zhtnz3d4PwCsEObLcZgynuxP8gc+tW8dpzz+UT9p83e7yj5KHTEGj4vur/GXReWuR6ZEjiGTcEPddRbMZdZ7v/8FYGTQHdfazSloe9YMFzZPDtHKwpYlE1mF/wQWtKlamp6GY60dueinr7xYX4X4QlcpFkobf+uTt4vaZ4L+YOmSatOYzjbOuRWJiP4AwUQ0G6ndju4Ror28nA6uZq7xEbpMP6C768iVsP6DbnVN4vV/m+i8MB4EWbewqrBV2wFh3q6ZnSdpmDQz1jC8BWh+khlUD929NTW9zHA5EctoPI7wGDZeS4B29vS7cxp7LOTdXEqfWSaE4H/2qgIs8EYoz02s1F3IPv/ZVAO3q1r3MyPH1ANEFnOnd7nIReIhVhg9Pha+DfHPg1ppHOquWFzm2POAzDO9KzalFD6Pr75X4cAFEebDgq6vRJth1/az1ckzCYg+RmGMu4ejuRC534Q/bXoWnjjbaci7f309/EJddEb3ejZIheMXw2M5qIHcwNh0pCk7/nmkzXKTfUYVq2XLGf29lik6Lg5IGfzyMpf2rPzzLwaI8PUYY9BYGiL6JeNF9xSk+fpKxMl0ohKdJa19PC1Ht1wGeCmCuVlIpp9ZH+OEduJ14fAXZIB0hx4lNz4etgQ8+bRpgxhc/iCl8t2rUDH9QlJXAM0K+DptGe3DGsRy183qBG6iFF5e+OAepOn6Ssjw0VKPiYD7UlIW5aMbAMesl4aYAVg8CU67quApPsr6TVnIPzwC11IkliBU4p4/Sc4oxttZa1mi28FbaICW0lGKihGnGY/s7paBQnzqhcnKTEl7vDeOeSWjzbuCTLRo9mDINlTYCkvQEsIl/ReDJkbsMfAc/n2Bv0oGtWSyt3RXEO/BqVlUbEc2gMkXjIBbNd8XYR+/sZyQjzg3a7ryEibinDrmf+3fzwAQ/mIpeJvqH6Ar8shHg+/Mw0nDsQ9rYFGvWypBUQkK8Q+NHppL8hb0pSmqZu6YDuvt8oFOjIeDW1dgW9kbHdlxiFSca76OEGFICCzrKNoGP6fBJkuyNwNe8W11u4W6YcXXXvgkQsDwX3MN4CbkwsSfpPxO/EC3eShNW0tLTP2AJlg7mcNqGWzXDgSrGauae4t2zrlEmvpNncZoBYfBhD06Z8PfeDoev8B0djRMO0XeBh9vRJq78zX9Rs+M5cbYc8ELHSSGpxW13SeESrQoFuR/gHu2yGVmGbK5DtyrL/EGLPsLTJmH5PsSRQov2NfdcDnou/DLoLUVsrimiATVPfmvCEqJeRhfJabOHvDllNAJCb4uof9Yf+slOGp9PlvdiuFaa2zuzt7JRR1xf8q2178OzRUxVX0X2lHl/JH0fw1WgOAaTIkrbSfNt+YwzakyG7XNCbocfxMenujfu8Xo4zlmZmpZ61/oph1DeSzX6iPHA8E37b5nChp3f3WDYAbaCqEIyLDw+u1Bn7t+3f7H3fadDj51jFCShKXeAQUTC5gSnftXhzdfz8Ig1ze1WBqLhECB9+mVOXBz5NeLIbXuaVcbpPL9IHXKmK37+DNPXGoBekutD88ZjkCD8FVPmEd0w3t5/6z590vQz3J6xn8drEUzPMKv7gnxBs3/BB2zaf9Mx0TUV+ZTE3ZXylmhj57WRfiz5k9w7+QzvLNUSz44B2ZDAE8kosq0YDlXm2MudDHRNwl8/f6UnPYusdWXFYyWz9IzJq5iHxy/3QwK6fGy0YiZQ3Me2OpBTazQ5oPwW7rkpMj4KTx95hUDrysDjJXT8ZoZZCbQtWJVKSkki8d4TBxvz8r+Gg46BJoV9t2Vr+H51VcujXg+lbRxAXL5Nr8OB0P9L9auI3EIuc33bXzR+fhTLZvD/wX6A1a5mN5CfLJiQfC+v2I3yk42D7B6Pgwi1gepCBcW4XW6W700IFbnluO2HiIwG2yFGnAjqnII0URn8kf8ecJB72+N9eOuqb+aqjs+CnknmcBOhvJCH+ASYbUJWdJ7uAJtGW7eicVfw0ZosjBob1SK6/rqfsI/FC//TFhngUkChs4GIKrB17M4w6AyAqvhaIP78Swz3/kjEEcB6wXSJoyWMS2jQrB5CsjiQn+gkE3ZuorwS5fkZT3zTeXtZD5cr30FLXf0SXVrjclFABDqZCwMKBWqAiY5ovWfCtcwf9DwJ96V0DjzQM6L7kEjOyfGc0ncAlwKDL70GhoxqYdYI90IyZsjn19GqJrkHJYyih0Vv+v6rfB+gWonBdTvVw1RyGr8shJJx2KgigBi5s8Wqsa3z5bYCHpvcbo8MoP/p/53cvE+LkYKERYfFxjiVZeq0Azk/hPkZK+KgXDX/Fv8phmXQG812X9lt8tJvFY41/39qI5kY3WfoQIVaKbDrbf+Ng8cX3XyO0516CM9sCfuTvj9KCvvX1M7jWOqWdoeQyr0E4klW06B92frKMy5bhcPrwTkJTOUqSRP96YOZzge1OR0JS1ODhJT6MCO5Mils86cqD54dJilgp4vrdnDXDqh3e4VhVgU8BP4P17SQ+ScI06jcUsr/gNMaPdr09FWHQ49rrYMB2KdfZpJ6Rw2opTjdqJYDVKDnBMMnt+gbAISa8LpFeGCIReUe+aQuGvtDHRKzOV4S3qHn0HgKOsWUDSMf7tJddGD3ILugPTwZZIfriduZKj8KnmcX8QdrgP3EfkUQggmLMvG7pgjezrOYLpuXm7z46EiDi6Fuo0LoExzMXcY8VFFhNk5wsiB4WNfa6of4Fs+VL2WJ/tBYaKWnlmYYYpICY9AKsvhvm+u2qFqKUf3DP1kT4zNAfKsWcCMafboXUVVO8ppMpuA5Sk3v/2Z2zSng8e3w0VGpK3qplN8k1Erl5Fy5nEPB/McmNfw3xfBSMkhC85TE1fazf0o6WyvwnYpsm7ocDkQkZN961VEAG/u9hWfRdun/MhjWWAcW5MKsCxWJKlggY46nuGTCNkq1k0wiayIGUksyCoUWlbub/YWQL/M/Ia/aWR8FGtJKJd25BvzUqAZ5U0GbmLZSXdwoxAO3/UlE2EcOpoeWF5jJD9DYTws1YAYI92UNkPckQLc98FQzOvPVDwMhu4dDXlDATkxtKuKh9BmFV+6YL32uorGF3cGnt/NHN85aRCxInUMf9Ub71s1i45M7ds2/gNv3/mvCY7QFdEFsid9O4WHZ5LvJlmZyjuF0xVfGa5OXnZrQWE1tI4aCUa3nYyye6oOJGjtP/rGWl9X2jsQZwBFX70fgwphHu+OcAobcGjnfzq47BXSNMgdO+diBd/QGs0XKQ1J+0QmZoTrHoTus64Cv4aMud0QVEN3YeXGtyXKNAj3/DG11/tQSkp43grxL8Ifl9Ef7wbyzHr0qeZ4epbEcDnv2Ho4LC5rER78lzIvi39ARKqb64oEuYz59Ka3pBOn8tHAwGee7SgKrPVEQMWHr4rWXI+dUJNLcFpaeTHzrE3XMjWDoWkDgyC72XBrlBLoH7+kTryOCLooA9gaTf81Uhv5VfVWwwQNLMd+hGnXy7g8WhJe+2d7RZOo7J2zrarvO7iEEdLoIY0RIcS47H8WDc5EsCRp3IlsId8F5sAGRThWRZBfbbzIOU7exnLkSei/+ThAAIpnaz19rQepUXC9FFhVxn2LhW+suDJu8TWQMkV+BjAfXIcbmZHMZL0Yw3j7RGiEGyoHJyRubEVSyH2oURCE3oNbqa0IqfKeq8U0kMPQXRLCJ6y8iBPa7mClkxc0Y9srdmCj7gmSnu7XDcMt39FeSf4ZmK41KfbFxNC91gn5oY9UiEXzVez4j8aqz0esKg53Y2+3ULzoZWVrv500dWYGuv8HewIb7Hv/CjC9WJ72IjXc+6YJFbuprA/zlNY8DIGc+dCwtxj897zjzgPI31Mn0gY62CWhhRBoYqv+w2Z+uEX5EE8XsqEvqzBWuV8+EyOn95bZArxqKFGt2B/ST2jv1trLrTs+XB+DCh0nJLZBPYLM6Afty/1HEWcEe96i+gg9xkM94lum6vs0YNmLLdZni/0RSptLLyxNbOfc3W9fh87YQzBIFf9U72zW/BtyuljMidiNwdWbabjjiM8bdhCHuTydKZuH2oxWn6t77ffGZlDh5bfft9qVtvW6ANV8Ulyql5XhquYJtGICH3yzrB4oSahXcAN+5rbBroAovM1s8HRsB1rOhXujRj74oceL4qMveMGLllgGC1I9V6X5UKBB29vXxb+jYW13HQ2LBR8hU3Qo1L+AdAKSHASggd3/RzxNBaNNH/+X2db3Xg+gau9V/gJZAP5hAFP9yBkbirKaRCZG4djU8EfS5+QzIFIzifdlp7GUdSBPalyz65lIbIqDBwdZCb7LnZl5Mp872tYg6qPW69vtjV0yfKAy94tfq9BU7ZhE1I6m/zA8g+Hcel8cOR88QvlP+H+tI5YERvSY0nf81afAmx972o+Au2Vc/jEBw9dAa95ll1dQWy997fiCW139ZrCGpSR5Ls48in7hX98OQX8ZA5CtF4ok189Gej5SGez1mo/KTJWkXqNmiaJVg33TLH3+BK/FM5px+r5iKD/jD1P6szQySnNyuJvzTqY0rnMkLpLmXpgnEvPVjozIsj/yYuPpw14bU+19Smz822UG7EdSAXs8SeBh5TfXNQswAAJx90d3y2TmI5a7pPUYrFAcZ2yloQrhlKirmRAbNd/ZyOd82KKxSaCCGS22m1vjqT/f1QDPum711+UEIq8dJLZi/aNW9OAG4J0kUnpBpfEpbeRH9pG2cCOm1/tcKAM30GUbR1OS4OaTP2RPddTDjZeNToYm2sFc2PS1zUEo9J9iDWNJvEDlUPBUjq+jDbZg7vM+a6i/oWmg1JEQ9+fDo37MXNQZn2eN+SHoE7wisPA2hK8O4Li9w+J878w9hFE2GnisAAAAU0K0urdv47a/+X65J5Fes/vIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","pat_hand_1":"data:image/webp;base64,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","pat_hand_2":"data:image/webp;base64,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","pat_hand_3":"data:image/webp;base64,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","pat_hand_4":"data:image/webp;base64,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"}
    function __xykpVk1Start() {
// 峰谷判定：北京时间（UTC+8）。
//
// 峰时：周一至周五（不含中国法定节假日）09:00–12:00、14:00–18:00。
// 其余时间（含周末、法定节假日全天）谷时，谷时价格 = 峰时价格的一半。
//
// 法定节假日表由 client/make-holidays.mjs 从 NateScarlet/holiday-cn 生成，
// 内嵌快照覆盖 2025–2028；宿主插件会每周自动刷新，
// 页面也会用 /xykp/balance-reporter/holidays 或 localStorage 里的更新结果覆盖这张表。
var __xykpVk1Holidays = new Set(["2025-01-01","2025-01-28","2025-01-29","2025-01-30","2025-01-31","2025-02-01","2025-02-02","2025-02-03","2025-02-04","2025-04-04","2025-04-05","2025-04-06","2025-05-01","2025-05-02","2025-05-03","2025-05-04","2025-05-05","2025-05-31","2025-06-01","2025-06-02","2025-10-01","2025-10-02","2025-10-03","2025-10-04","2025-10-05","2025-10-06","2025-10-07","2025-10-08","2026-01-01","2026-01-02","2026-01-03","2026-02-15","2026-02-16","2026-02-17","2026-02-18","2026-02-19","2026-02-20","2026-02-21","2026-02-22","2026-02-23","2026-04-04","2026-04-05","2026-04-06","2026-05-01","2026-05-02","2026-05-03","2026-05-04","2026-05-05","2026-06-19","2026-06-20","2026-06-21","2026-09-25","2026-09-26","2026-09-27","2026-10-01","2026-10-02","2026-10-03","2026-10-04","2026-10-05","2026-10-06","2026-10-07","2027-01-01","2027-01-02","2027-01-03","2027-02-05","2027-02-06","2027-02-07","2027-02-08","2027-02-09","2027-02-10","2027-02-11","2027-02-12","2027-02-13","2027-04-03","2027-04-04","2027-04-05","2027-05-01","2027-05-02","2027-05-03","2027-05-04","2027-05-05","2027-06-09","2027-09-15","2027-10-01","2027-10-02","2027-10-03","2027-10-04","2027-10-05","2027-10-06","2027-10-07"])

function __xykpVk1SetHolidays(days) {
  if (!Array.isArray(days)) return false
  var next = new Set()
  for (var i = 0; i < days.length; i++) {
    var d = String(days[i] || '')
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) next.add(d)
  }
  if (!next.size) return false
  __xykpVk1Holidays = next
  return true
}

var __xykpVk1Peak = (function () {
  var DAY = 86400000
  var OFFSET = 8 * 3600000
  var PEAK = [9 * 3600, 12 * 3600, 14 * 3600, 18 * 3600]

  function pad2(n) { return n < 10 ? '0' + n : String(n) }
  function dayKey(t) {
    var d = new Date(t)
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
  }
  /** t 是「北京时间轴」上的毫秒（ts + 8h）。 */
  function isOffAt(t) {
    var d = new Date(t)
    var wd = d.getUTCDay()
    if (wd === 0 || wd === 6) return true
    if (__xykpVk1Holidays.has(dayKey(t))) return true
    var s = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()
    return !((s >= PEAK[0] && s < PEAK[1]) || (s >= PEAK[2] && s < PEAK[3]))
  }
  /** 下一个峰/谷切换点（北京时间轴毫秒）。 */
  function nextChange(t) {
    var dayStart = Math.floor(t / DAY) * DAY
    var current = isOffAt(t)
    for (var i = 0; i < 15; i++) {
      for (var j = 0; j < 5; j++) {
        var at = dayStart + i * DAY + [0, 9, 12, 14, 18][j] * 3600000
        if (at > t && isOffAt(at) !== current) return at
      }
    }
    return t + DAY
  }
  return {
    /** nowMs 是真实 UTC 毫秒；返回 { off, left(ms) }。 */
    info: function (nowMs) {
      var t = nowMs + OFFSET
      var target = nextChange(t)
      return { off: isOffAt(t), left: Math.max(0, target - OFFSET - nowMs) }
    },
    /** 用宿主/页面拉到的新表替换内嵌快照。 */
    setHolidays: __xykpVk1SetHolidays,
    holidayCount: function () { return __xykpVk1Holidays.size },
  }
})()

    ;
/* ===========================================================================
 * VK-1 余额挂件 —— dsh-xykp 页面内二次分发版（源自 YCTS-otree MIT 移植）
 * 素材 / 峰谷 / 余额 provider / 隐藏菜单由 build.mjs 打补丁；
 * 设置界面与滚轮交互由 dsh-xykp 在「显示 / 动画 / 声音」重排时手改。
 *
 * 原注释：
 * VK-1 余额挂件 —— 网页内挂件（纯插件形态）
 *
 * 上游：VKmich16/VK-1「大肥鱼桌宠现代化改_D-16BVM（2026）」571da3b。
 * 现代化移植新增：抚摸、铁盆堆叠、四页设置、分项音效、本地剪辑库、今日消费与峰谷时钟。
 * 本文件是它 dsh_pet.ps1 的网页移植：保留原本全部可观察行为，去掉「桌宠」
 * 相关的一切（置顶窗口 / 托盘 / 屏幕角吸附 / 点击穿透 / 独立进程）。
 *
 * v11 相对已移植的 v9（原版）新增，全部照搬：
 *   · 四种表情（expression_11 开心 / _22 紧张 / _12 傲娇 / _21 冷脸），按优先级
 *     自动切换——2026 版优先级为抚摸 > 零余额 > 铁盆扣头 > 扣费 > 米盆闲置 > 开心
 *   · 充值不再直接改数字：掉一盆米饭，拖到角色身上才入账（掉盆/弹跳/拖拽/碰撞）
 *   · 铁盆：吃掉米盆后掉出，可拖到她头上戴住（换冷脸），双击头部取下
 *   · 火控雷达目标名牌：绿括号 + 「白饭」+ 距离/接近率/相对高度 + 方向环，
 *     任一盆闲置满 10s → 全部锁定 → 1s 后磁吸，吸到身上即入账
 *
 * 定位模型沿用 dsh-whale-widget：四边四分之一吸附 + 锚点持久化 + 滚动条避让；
 * 吸附在右边缘时只镜像「美术」，文字靠重算仿射矩阵保持正向。
 *
 * 移植来源字面值（dsh_pet.ps1 行号）：
 *   平板四角 2527-2528 · 表情优先级 1973-1985 · 雷达读数 2106+ / 几何 2277-2460
 *   重力/弹性 1039-1040 · 空气阻力/滑动 1069-1075 · 弹跳档位 1104-1109
 *   掉盆 2660-2689 · 物理 3024-3165 · 喂食判定 3298-3330 · 进食 2740-2777
 *   爱心 2712-2733 / 3485-3499 · 铁盆 2844-2886 · 常量 857-918
 * =========================================================================== */
(function () {
  if (window.__dshVk1Widget) return
  window.__dshVk1Widget = true

  // A widget that dies silently is worse than one that complains — but the complaint has to
  // be OURS. Two rules keep that honest:
  //   · identity comes from document.currentScript at parse time, NOT from a hardcoded path.
  //     A path filter silently swallows every real error the day the widget is served from
  //     somewhere else — which would reintroduce exactly the silent death this exists for.
  //   · an error with no source at all is never attributed to us. The browser's own warnings
  //     (e.g. "ResizeObserver loop completed with undelivered notifications", which carries
  //     no script source) and cross-origin "Script error." land here.
  var SELF_SRC = ''
  try { SELF_SRC = (document.currentScript && document.currentScript.src) || '' } catch (e0) {}
  function isOurs(src) {
    var path = String(src || '').split('?')[0]
    if (!path) return false
    if (SELF_SRC) return path === String(SELF_SRC).split('?')[0]
    // Heuristic last resort, used only when currentScript is unavailable: any script whose
    // path ends in our route is treated as ours. It can in principle misattribute an
    // unrelated script served at the same path, which is why identity normally comes from
    // currentScript instead.
    return /dsh-vk1\/widget\.js$/.test(path)
  }
  function showFatal(text) {
    try {
      var existing = document.getElementById('dshvk1-fatal')
      if (existing) {
        // Keep the single box but do not swallow the new failure: show the latest message
        // plus how many have been seen. Stacking a box per error was the original bug.
        var n = (parseInt(existing.getAttribute('data-count') || '1', 10) || 1) + 1
        existing.setAttribute('data-count', String(n))
        existing.textContent = 'VK-1 widget error ×' + n + '（点击关闭）:\n' + text
        return
      }
      var d = document.createElement('div')
      d.id = 'dshvk1-fatal'
      d.setAttribute('data-count', '1')
      d.title = '点击关闭'
      d.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147483600;max-width:74vw;' +
        'background:#8d1111;color:#fff;font:16px/1.5 Consolas,monospace;padding:12px 14px;' +
        'border:2px solid #fff;border-radius:10px;white-space:pre-wrap;cursor:pointer'
      d.textContent = 'VK-1 widget error（点击关闭）:\n' + text
      d.addEventListener('click', function () {
        try { if (d.parentNode) d.parentNode.removeChild(d) } catch (e3) {}
      })
      document.body.appendChild(d)
    } catch (e2) {}
  }
  function onWidgetError(ev) {
    var src = String((ev && ev.filename) || '')
    var msg = String((ev && ev.message) || 'unknown')
    if (!isOurs(src)) return                      // not ours, or unattributable
    if (/ResizeObserver loop/i.test(msg)) return  // benign browser warning
    showFatal(msg + '   @' + (ev && ev.lineno) + ':' + (ev && ev.colno))
  }
  window.addEventListener('error', onWidgetError)

  var BASE = '/dsh-vk1'
  var EXPR_URL = {
    happy: __xykpVk1Assets.expression_11,
    nervous: __xykpVk1Assets.expression_22,
    aloof: __xykpVk1Assets.expression_12,
    calm: __xykpVk1Assets.expression_21,
  }
  var EXPR_ORDER = ['happy', 'nervous', 'aloof', 'calm']
  var RICE_URL = __xykpVk1Assets.rice
  var IRON_URL = __xykpVk1Assets.iron_bowl
  var ironDrawUrl = ''
  var HIT_SOUND = __xykpVk1Assets.hit
  var FEED_SOUND = __xykpVk1Assets.feed
  var BALANCE_URL = ''

  // ---- constants ported from dsh_pet.ps1 ----
  var STEP = 0.01
  var CUE_GAP = 0.2
  var MAX_CUES_PER_POLL = 40
  var HIT_DUR = 0.55
  var FLOAT_DUR = 1.05
  var POLL_MS = 12000
  var FLASH_COLOR = '#ff3022'
  var CUE_FILL = 'rgb(255,72,60)'
  var CUE_EDGE = 'rgb(92,8,8)'
  var GAIN_FILL = 'rgb(58,220,90)'
  var GAIN_EDGE = 'rgb(8,85,28)'
  var RADAR_GREEN = 'rgb(0,255,8)'
  var LABEL_TEXT = 'DSH 余额'
  var RADAR_TYPE = '白饭'

  // tablet screen quad in sprite-texture pixels (1024), dsh_pet.ps1:2527-2528
  var QX = [549.6, 949.7, 984.7, 584.6]
  var QY = [706.2, 642.0, 860.2, 924.3]

  var SIZES = [128, 192, 256, 384, 512]
  // 预设之外还有菜单里的「自定义」px 输入框（上游同样是「预设 + 自定义」的形状）。
  // 挂件是分辨率无关的等比布局，落在这个区间里都能正确排版。
  // 默认仍是上游大杯 454：没手动调过尺寸的安装不会被这次改预设悄悄缩小。
  var DEFAULT_SIZE = 340
  var MIN_SIZE = 96
  var MAX_SIZE = 1200

  var BOWL_WAIT = 10.0
  var LOCK_DELAY = 1.0
  var SUCK_ACCEL = 960.0
  var SUCK_MAX = 2400.0
  var GRAVITY = 2100.0
  var RESTITUTION = 0.5
  var AIR_DRAG = 0.30
  var SLIDE_FRICTION = 1.40
  var SLIDE_STOP = 14.0
  var SQUISH_DUR = 0.40
  var HEAD_SQUASH_DUR = 0.5
  var IRON_TILT_DEG = -6.23
  var BOWL_W = 0.44
  var IRON_W_LOOSE = 0.44
  var IRON_W_WORN = 0.7391
  var IRON_H_WORN = 0.2629
  var BOWL_DIE = 0.14
  var IRON_FADE = 0.45
  var BTN_GRACE_MS = 1500

  var POS_KEY = 'dsh-vk1-pos'
  var SIZE_KEY = 'dsh-vk1-size'
  var GAP_KEY = 'dsh-vk1-gap'
  var SOUND_KEY = 'dsh-vk1-sound'
  var OPTIONS_KEY = 'dsh-vk1-options'
  var USAGE_KEY = 'dsh-vk1-usage'

  function round4(v) { return Math.round(v * 10000) / 10000 }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v) }
  function amountText(v) { return String(Math.round(v * 10000) / 10000) }
  function fmt2(v) { return (Math.round(v * 100) / 100).toFixed(2) }
  function rnd(a, b) { return a + Math.random() * (b - a) }
  function svgEl(tag) { return document.createElementNS('http://www.w3.org/2000/svg', tag) }

  // --------------------------------------------------------------- styles ---
  var CSS = [
    // The bowl/rice layer must sit above every other appearance — dsh-whale-widget
    // sets no z-index at all (auto), so any positive value wins — and above this
    // plugin's own character, because upstream paints the bowls AFTER the sprite.
    // overflow:hidden keeps the above-the-viewport spawn from scrolling the page.
    '.dshvk1-stage{position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:10001;overflow:hidden}',
    // transform-origin:0 0 is load-bearing. renderBowls() emits the FULL transform
    // chain itself, in upstream's order (translate -> rotate -> scale -> anchor
    // offset), so the Q-bounce grows from the bowl's bottom edge and a worn pot tilts
    // about its own art centre. Any other origin re-anchors that chain and the art
    // ends up off the floor.
    '.dshvk1-bowl{position:absolute;left:0;top:0;pointer-events:none;will-change:transform;transform-origin:0 0}',
    '.dshvk1-heart{position:absolute;left:0;top:0;pointer-events:none;will-change:transform,opacity}',
    '.dshvk1-radar{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:visible}',
    '.dshvk1-root{position:fixed;left:0;top:0;width:var(--dshvk1-s);height:var(--dshvk1-s);pointer-events:none;user-select:none;-webkit-user-select:none;z-index:9998;font-family:inherit;transition:left .16s ease,top .16s ease}',
    '.dshvk1-root.dshvk1-dragging{transition:none;cursor:grabbing}',
    '.dshvk1-body{position:absolute;left:0;top:0;width:100%;height:100%;transform-origin:50% 100%}',
    '.dshvk1-art{position:absolute;left:0;top:0;width:100%;height:100%;transform-origin:50% 50%;transition:transform .3s ease}',
    '.dshvk1-root.dshvk1-mirror .dshvk1-art{transform:scaleX(-1)}',
    '.dshvk1-face{position:absolute;left:0;top:0;width:100%;height:100%;display:block;pointer-events:none;-webkit-user-drag:none}',
    '.dshvk1-flash{position:absolute;left:0;top:0;width:100%;height:100%;background:' + FLASH_COLOR + ';opacity:0;pointer-events:none;' +
      '-webkit-mask-size:100% 100%;-webkit-mask-repeat:no-repeat;mask-size:100% 100%;mask-repeat:no-repeat}',
    '.dshvk1-panel{position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;text-align:center}',
    '.dshvk1-label{position:absolute;left:0;right:0;top:4%;height:31.5%;display:flex;align-items:center;justify-content:center;' +
      'font-size:calc(var(--dshvk1-ph) * 0.21);font-weight:700;letter-spacing:.02em;color:rgba(158,182,224,.92);' +
      'text-shadow:calc(var(--dshvk1-ph) * 0.005) calc(var(--dshvk1-ph) * 0.005) 0 rgba(0,0,0,.59);white-space:nowrap}',
    '.dshvk1-countdown{position:absolute;left:0;right:0;top:7%;display:flex;align-items:center;justify-content:center;' +
      'font-size:calc(var(--dshvk1-ph) * 0.185);font-weight:800;letter-spacing:.01em;white-space:nowrap;' +
      'text-shadow:calc(var(--dshvk1-ph) * 0.005) calc(var(--dshvk1-ph) * 0.005) 0 rgba(0,0,0,.59)}',
    '.dshvk1-amount{position:absolute;left:0;right:0;top:44%;display:flex;align-items:center;justify-content:center;white-space:nowrap}',
    '.dshvk1-cur{font-size:calc(var(--dshvk1-ph) * 0.27);font-weight:700;color:rgba(158,184,230,.92);' +
      'text-shadow:calc(var(--dshvk1-ph) * 0.005) calc(var(--dshvk1-ph) * 0.005) 0 rgba(0,0,0,.63)}',
    '.dshvk1-num{font-size:calc(var(--dshvk1-ph) * 0.48);font-weight:800;color:#f0f6ff;line-height:1;' +
      'text-shadow:calc(var(--dshvk1-ph) * 0.005) calc(var(--dshvk1-ph) * 0.005) 0 rgba(0,0,0,.63)}',
    '.dshvk1-floater{position:absolute;left:0;top:0;font-weight:800;white-space:nowrap;pointer-events:none;transform-origin:0 0;font-family:Arial,sans-serif}',
    '.dshvk1-dot{position:absolute;border-radius:50%;background:rgba(228,62,52,.92);border:1px solid rgba(255,255,255,.82);display:none;pointer-events:none}',
    '.dshvk1-btn{position:absolute;top:4px;right:4px;width:26px;height:26px;border:none;border-radius:7px;background:rgba(32,49,112,.86);color:#fff;' +
      'font-size:16px;line-height:1;cursor:pointer;padding:0;pointer-events:none;opacity:0;transition:opacity .15s ease;z-index:2}',
    '.dshvk1-btn.dshvk1-btn-on{opacity:1;pointer-events:auto}',
    '.dshvk1-btn:hover{background:#203170}',
    '.dshvk1-menu{position:fixed;min-width:206px;max-height:84vh;overflow:auto;background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(32,49,112,.35));' +
      'border-radius:10px;padding:6px;box-shadow:0 8px 24px rgba(0,0,0,.18);z-index:10002;display:none;color-scheme:light dark}',
    '.dshvk1-menu.dshvk1-menu-open{display:block}',
    '.dshvk1-menu-row{display:block;width:100%;text-align:left;padding:6px 10px;border:none;border-radius:7px;background:transparent;' +
      'color:var(--dsw-alias-label-primary,#203170);font-size:12.5px;cursor:pointer;white-space:nowrap;box-sizing:border-box;font-family:inherit}',
    '.dshvk1-menu-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(32,49,112,.08))}',
    '.dshvk1-menu-row-flex{display:flex;align-items:center;justify-content:space-between;gap:10px}',
    '.dshvk1-menu-sep{height:1px;background:var(--dsw-alias-border-l1,rgba(32,49,112,.25));margin:5px 2px}',
    '.dshvk1-menu-cap{padding:4px 10px 2px;font-size:11px;color:var(--dsw-alias-label-secondary,#7b86a6);letter-spacing:.03em}',
    '.dshvk1-menu-grid{display:flex;flex-wrap:wrap;gap:4px;padding:0 6px 2px}',
    '.dshvk1-menu-chip{flex:0 0 auto;padding:3px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(32,49,112,.35));' +
      'background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#203170);font-size:11.5px;cursor:pointer;font-family:inherit}',
    '.dshvk1-menu-chip:hover{background:var(--dsw-alias-bg-layer-2,rgba(32,49,112,.14))}',
    '.dshvk1-menu-chip.dshvk1-chip-on{border-color:var(--dsw-alias-brand-primary,#203170);font-weight:700}',
    '.dshvk1-menu-num{width:56px;border:1px solid var(--dsw-alias-border-l2,rgba(32,49,112,.4));border-radius:6px;padding:2px 5px;' +
      'font-size:11.5px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#203170);box-sizing:border-box;font-family:inherit}',
    '.dshvk1-menu-num:disabled{opacity:.4;cursor:not-allowed}',
    '.dshvk1-menu-unit{font-size:11px;color:var(--dsw-alias-label-secondary,#7b86a6)}',
    '.dshvk1-update{position:fixed;right:16px;top:16px;max-width:min(340px,calc(100vw - 32px));padding:14px;border:1px solid #9eafd2;border-radius:12px;background:#f5f8ff;color:#203052;box-shadow:0 8px 24px #0003;z-index:10003;font:14px/1.5 system-ui,sans-serif;box-sizing:border-box}',
    '.dshvk1-update p{margin:0 0 10px}.dshvk1-update div{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.dshvk1-update a{color:#304fc8}.dshvk1-update button{padding:4px 9px;border:1px solid #9eafd2;border-radius:6px;background:white;color:#203052;cursor:pointer}',
  ].join('\n')

  var styleEl = document.createElement('style')
  styleEl.textContent = CSS
  document.head.appendChild(styleEl)

  // ------------------------------------------------------------------ DOM ---
  // Bowls / hearts / radar live in VIEWPORT coordinates (the pet's window was
  // screen-sized for the same reason), so they do not move with the widget.
  var stage = document.createElement('div')
  stage.className = 'dshvk1-stage'
  var radarSvg = svgEl('svg')
  radarSvg.setAttribute('class', 'dshvk1-radar')
  stage.appendChild(radarSvg)
  document.body.appendChild(stage)

  var root = document.createElement('div')
  root.className = 'dshvk1-root'
  var body = document.createElement('div')
  body.className = 'dshvk1-body'
  var art = document.createElement('div')
  art.className = 'dshvk1-art'

  var faces = {}
  var flashes = {}
  EXPR_ORDER.forEach(function (key) {
    var im = document.createElement('img')
    im.className = 'dshvk1-face'
    im.src = EXPR_URL[key]
    im.alt = LABEL_TEXT
    im.draggable = false
    im.style.display = key === 'happy' ? 'block' : 'none'
    art.appendChild(im)
    faces[key] = im

    var fl = document.createElement('div')
    fl.className = 'dshvk1-flash'
    fl.style.webkitMaskImage = 'url(' + EXPR_URL[key] + ')'
    fl.style.maskImage = 'url(' + EXPR_URL[key] + ')'
    fl.style.display = key === 'happy' ? 'block' : 'none'
    art.appendChild(fl)
    flashes[key] = fl
  })

  var panel = document.createElement('div')
  panel.className = 'dshvk1-panel'
  var labelEl = document.createElement('div')
  labelEl.className = 'dshvk1-label'
  labelEl.textContent = LABEL_TEXT
  var countdownEl = document.createElement('div')
  countdownEl.className = 'dshvk1-countdown'
  countdownEl.style.display = 'none'
  var amountEl = document.createElement('div')
  amountEl.className = 'dshvk1-amount'
  var curEl = document.createElement('span')
  curEl.className = 'dshvk1-cur'
  curEl.textContent = '\u00A5'
  var numEl = document.createElement('span')
  numEl.className = 'dshvk1-num'
  numEl.textContent = '--'
  amountEl.appendChild(curEl)
  amountEl.appendChild(numEl)
  panel.appendChild(labelEl)
  panel.appendChild(countdownEl)
  panel.appendChild(amountEl)

  var dot = document.createElement('div')
  dot.className = 'dshvk1-dot'

  body.appendChild(art)
  body.appendChild(panel)
  body.appendChild(dot)
  root.appendChild(body)

  var btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'dshvk1-btn'
  btn.title = '设置'
  btn.textContent = '\u2699'
  root.appendChild(btn)

  var menu = document.createElement('div')
  menu.className = 'dshvk1-menu'

  document.body.appendChild(root)
  document.body.appendChild(menu)

  // ----------------------------------------------------------------- state ---
  var state = {
    size: DEFAULT_SIZE,
    real: NaN,
    bookedAt: NaN,
    bookedBal: NaN,
    creditPending: 0,
    testOffset: 0,
    pending: 0,
    pendingStep: 0,
    dueGap: 0,
    demoLeft: 0,
    demoAmount: STEP,
    demoResetAt: 0,
    hits: [],
    floaters: [],
    hearts: [],
    bowls: [],
    expr: 'happy',
    bowlWait: 0,
    lockAll: false,
    lockT: 0,
    radarManual: false,
    headSquashT: HEAD_SQUASH_DUR,
    lastHeadClick: null,
    connected: false,
    soundOn: true,
    volume: 80,
    h: 'right', hOff: 0,
    v: 'bottom', vOff: 0,
    left: 0, top: 0,
    scrollGapOn: false,
    scrollGapPx: 17,
    snapRatio: 0.25,
    dragWidget: null,
    grab: null,
    menuOpen: false,
    fxBowl: true, fxPat: true, fxHurt: true,
    theme: 'auto',
    cueVolumes: [100, 100, 100, 100],
    usage: null,
    displayMode: 'both',
    pollSeconds: 12,
    yieldOn: true,
    yieldOpacity: 7,
    cloudOffset: 0,
    lastTabletClick: null,
  }

  function scaleOf() { return state.size / 1024 }
  function mirrored() {
    // 以前按 1/4 / 3/4 的吸附区决定朝向，还没过屏幕中心就翻面；现在按中心线，
    // 只有角色中心越过屏幕中心才翻。
    var vp = viewport()
    return state.left + state.size / 2 > vp.w / 2
  }
  function headXLocal() { return state.size * (mirrored() ? 0.33 : 0.67) }
  function headYLocal() { return state.size * 0.36 }
  function headScreen() { return { x: state.left + headXLocal(), y: state.top + headYLocal() } }
  function floaterStep() { return Math.max(18, 34 * scaleOf() * 1.7) }
  function drawnBalance() {
    if (!isFinite(state.bookedBal)) return NaN
    var v = state.bookedBal - state.testOffset
    return Math.round((v < 0 ? 0 : v) * 100) / 100
  }

  // ------------------------------------------------------- layout / screen ---
  function quad() {
    var sc = scaleOf()
    var P = []
    for (var i = 0; i < 4; i++) P.push({ x: QX[i] * sc, y: QY[i] * sc })
    var lw = Math.sqrt(Math.pow(P[1].x - P[0].x, 2) + Math.pow(P[1].y - P[0].y, 2))
    var lh = Math.sqrt(Math.pow(P[3].x - P[0].x, 2) + Math.pow(P[3].y - P[0].y, 2))
    return { P: P, lw: lw, lh: lh }
  }

  function layout() {
    root.style.setProperty('--dshvk1-s', state.size + 'px')
    var flip = mirrored()
    root.classList.toggle('dshvk1-mirror', flip)
    var q = quad()
    var P = q.P
    if (q.lw < 8 || q.lh < 8) return
    var pw = 520
    var ph = Math.max(24, Math.round(pw * (q.lh / q.lw)))
    var a = (P[1].x - P[0].x) / pw
    var b = (P[1].y - P[0].y) / pw
    var c = (P[3].x - P[0].x) / ph
    var d = (P[3].y - P[0].y) / ph
    // Mirrored: the artwork flipped about the widget centre, so map the panel onto
    // the mirrored quad instead of flipping the glyphs (det stays positive).
    var m = flip ? [a, -b, -c, d, state.size - P[1].x, P[1].y] : [a, b, c, d, P[0].x, P[0].y]
    panel.style.width = pw + 'px'
    panel.style.height = ph + 'px'
    panel.style.setProperty('--dshvk1-ph', ph + 'px')
    panel.style.transform = 'matrix(' + m.join(',') + ')'
    var r = Math.max(2.5, state.size * 0.032)
    var cx = (P[1].x + P[2].x) / 2
    if (flip) cx = state.size - cx
    var cy = (P[1].y + P[2].y) / 2 + state.size * 0.05
    dot.style.width = (r * 2) + 'px'
    dot.style.height = (r * 2) + 'px'
    dot.style.left = (cx - r) + 'px'
    dot.style.top = (cy - r) + 'px'
  }

  // --------------------------------------------------------------- sounds ---
  function makePool(url, n) {
    var pool = []
    for (var i = 0; i < n; i++) {
      try {
        var a = new Audio(url)
        a.preload = 'auto'
        pool.push(a)
      } catch (err) {}
    }
    return { pool: pool, idx: 0, cue: 0 }
  }
  var hitPool = makePool(HIT_SOUND, 4)
  var feedPool = makePool(FEED_SOUND, 2)
  feedPool.cue = 1
  var landPool = makePool(__xykpVk1Assets.pot_land, 2)
  landPool.cue = 2
  var offPool = makePool(__xykpVk1Assets.pot_off, 2)
  offPool.cue = 3
  var cuePools = [hitPool, feedPool, landPool, offPool]
  function playPool(p) {
    if (!state.soundOn || state.volume <= 0 || !p.pool.length || stopped) return
    try {
      var a = p.pool[p.idx++ % p.pool.length]
      a.volume = state.volume / 100 * state.cueVolumes[p.cue] / 100
      a.currentTime = p.clip ? p.clip.start : 0
      clearTimeout(a.trimTimer)
      if (p.clip) a.trimTimer = setTimeout(function () { a.pause() }, (p.clip.end - p.clip.start) * 1000)
      var r = a.play()
      if (r && typeof r.catch === 'function') r.catch(function () {})
    } catch (err) {}
  }

  // -------------------------------------------------------------- floaters ---
  function spawnFloater(text, x, y, gain) {
    var em = Math.max(13, 34 * scaleOf())
    var el = document.createElement('div')
    el.className = 'dshvk1-floater'
    el.textContent = text
    el.style.fontSize = em + 'px'
    el.style.color = gain ? GAIN_FILL : CUE_FILL
    el.style.textShadow = '1px 1px 0 ' + (gain ? GAIN_EDGE : CUE_EDGE)
    stage.appendChild(el)
    state.floaters.push({ T: 0, x: x, y: y, jitter: 7 * scaleOf(), tw: el.offsetWidth || 0, gain: !!gain, el: el })
    if (state.floaters.length > 20) {
      var old = state.floaters.shift()
      if (old.el && old.el.parentNode) old.el.parentNode.removeChild(old.el)
    }
  }

  function makeTick(amount, fromTest) {
    if (fromTest) {
      state.testOffset = round4(state.testOffset + amount)
      state.demoResetAt = Date.now() + 1400
    } else {
      state.testOffset = 0
      state.demoResetAt = 0
    }
    if (!state.fxHurt) return
    if (state.hits.length < 3) state.hits.push({ T: 0 })

    var trail = 0
    for (var i = 0; i < state.floaters.length; i++) if (state.floaters[i].T < 0.5) trail++
    if (trail > 3) trail = 3

    var h = headScreen()
    spawnFloater('-' + amountText(amount),
      h.x - state.size * 0.06,
      h.y - Math.round(trail * floaterStep()),
      false)
    playPool(hitPool)
  }

  // --------------------------------------------------------------- hearts ---
  function heartEl(size) {
    var el = document.createElement('div')
    el.className = 'dshvk1-heart'
    el.style.width = size + 'px'
    el.style.height = size + 'px'
    el.innerHTML =
      '<svg viewBox="0 0 16 16" width="100%" height="100%" aria-hidden="true">' +
      '<path d="M2 5h3V3h3V2h3v1h3v3h-1v2h-1v1h-1v1h-1v1h-1v1H9v-1H8v-1H7V9H6V8H5V7H4V5H2z" ' +
      'fill="#ff5f8d" stroke="#8e1240" stroke-width="0.7"/></svg>'
    return el
  }
  function spawnHearts(cx, cy) {
    var n = 5 + Math.floor(Math.random() * 3)
    for (var i = 0; i < n; i++) {
      var size = Math.round(Math.max(14, state.size * (0.090 + 0.050 * Math.random())))
      var el = heartEl(size)
      stage.appendChild(el)
      state.hearts.push({
        T: 0,
        Dur: 0.75 + Math.random() * 0.35,
        x: cx + rnd(-state.size / 8, state.size / 8),
        y: cy - rnd(0, state.size / 12),
        phase: Math.random() * 6.283,
        drift: (Math.random() - 0.5) * 36.0,
        el: el,
      })
    }
  }

  // ----------------------------------------------------------------- bowls ---
  function bouncesForDrop(dropPx) {
    if (dropPx < 60) return 0
    if (dropPx < 260) return 1
    if (dropPx < 700) return 2
    return 3
  }
  function viewportRect() {
    return {
      left: 0,
      top: 0,
      right: window.innerWidth || document.documentElement.clientWidth || 1280,
      bottom: window.innerHeight || document.documentElement.clientHeight || 800,
    }
  }
  function bowlEl(url, width, height) {
    var el = document.createElement('img')
    el.className = 'dshvk1-bowl'
    el.src = url === IRON_URL && ironDrawUrl ? ironDrawUrl : url
    if (url === IRON_URL && !potArtReady) el.style.visibility = 'hidden'
    el.draggable = false
    el.style.width = Math.max(8, Math.round(width)) + 'px'
    el.style.height = Math.max(8, Math.round(height)) + 'px'
    stage.appendChild(el)
    return el
  }
  function ironLooseSize() {
    var w = Math.max(24, Math.round(state.size * IRON_W_LOOSE))
    return { w: w, h: Math.max(8, Math.round(w * (IRON_H_WORN / IRON_W_WORN))) }
  }
  function ironWornSize() {
    return { w: Math.max(24, Math.round(state.size * IRON_W_WORN)), h: Math.max(8, Math.round(state.size * IRON_H_WORN)) }
  }
  var riceSizeCache = null
  function riceDims() {
    if (!riceSizeCache || riceSizeCache.size !== state.size) {
      var w = Math.max(24, Math.round(state.size * BOWL_W))
      riceSizeCache = { size: state.size, w: w, h: w }
    }
    return riceSizeCache
  }

  function newBowl(fields) {
    var base = {
      iron: false, fed: false, dieT: 0, amount: 0,
      artW: 40, artH: 40, url: RICE_URL, R: 17,
      X: 0, Y: 0, VX: 0, VY: 0, rot: 0,
      bounces: 0, maxBounces: 0,
      squish: 0, squishT: SQUISH_DUR, squishDur: SQUISH_DUR,
      grounded: false, dragging: false, beingSucked: false, suckSpeed: 0,
      onHead: false, headFalling: false, headY: 0, headTarget: 0, fadeT: 0, headT: 0,
      sampleVX: 0, sampleVY: 0, el: null,
    }
    for (var k in fields) if (Object.prototype.hasOwnProperty.call(fields, k)) base[k] = fields[k]
    base.el = bowlEl(base.url, base.artW, base.artH)
    state.bowls.push(base)
    return base
  }

  function startCredit(amount, demo) {
    if (!isFinite(amount) || amount <= 0) return
    if (demo) {
      // Rehearsals have their own bowls; real polling and today's usage never see fake money.
      if (!state.fxBowl) { state.testOffset = round4(state.testOffset - amount); updateScreen(); return }
    } else {
    state.creditPending = round4(state.creditPending + amount)
      if (!state.fxBowl) {
        applyCredit(amount)
        state.creditPending = Math.max(0, round4(state.creditPending - amount))
        updateScreen()
        return
      }
    }
    var vs = viewportRect()
    var d = riceDims()
    var R = d.w * 0.42
    newBowl({
      amount: amount,
      demo: !!demo,
      artW: d.w, artH: d.h, url: RICE_URL, R: R,
      X: vs.right - R * 1.2 - state.bowls.length * R * 0.5,
      Y: vs.top - R * 1.2,
      VX: -120, VY: 40,
      maxBounces: bouncesForDrop(vs.bottom - vs.top),
      el: null,
    })
  }

  function dropIronPot(x, y) {
    var d = ironLooseSize()
    var floor = viewportRect().bottom
    newBowl({
      iron: true,
      artW: d.w, artH: d.h, url: IRON_URL, R: d.w * 0.42,
      X: x, Y: y,
      maxBounces: bouncesForDrop(Math.max(0, floor - y)),
      el: null,
    })
  }

  function applyCredit(delta) {
    if (!(delta > 1e-9)) return
    state.bookedAt = round4(state.bookedAt + delta)
    state.bookedBal = round4(state.bookedBal + delta)
  }

  function onRiceFed(bowl) {
    if (bowl.fed) return
    bowl.fed = true
    bowl.dieT = 0
    bowl.dragging = false
    if (state.grab && state.grab.bowl === bowl) { state.grab = null; removeDragListeners() }
    var h = headScreen()
    spawnHearts(h.x, state.top + state.size * 0.20)
    playPool(feedPool)

    var haveFigures = isFinite(state.real) && isFinite(state.bookedBal)
    var shortfall = haveFigures ? Math.max(0, Math.round((state.real - state.bookedBal) * 100) / 100) : 0
    var owed = Math.max(state.creditPending, shortfall)
    var gain = bowl.demo ? bowl.amount : Math.min(bowl.amount, owed)
    if (gain <= 1e-9) gain = owed
    if (gain > 1e-9) {
      if (bowl.demo) state.testOffset = round4(state.testOffset - gain)
      else {
        applyCredit(gain)
        state.creditPending = Math.max(0, round4(state.creditPending - gain))
      }
      spawnFloater('+' + fmt2(gain), h.x - state.size * 0.06, h.y - Math.round(2 * floaterStep()), true)
    }
    dropIronPot(bowl.X, bowl.Y)
    // The original marks the canvas dirty on a credit; the readout must show the
    // money on this frame, not whenever the next cue happens to repaint it.
    updateScreen()
  }

  function charHitAt(x, y) {
    // Feed test uses the character's per-pixel alpha, exactly like RiceOnGirl.
    if (!hitCanvas || !hitReady) return false
    var w = state.size
    var lx = x - state.left
    var ly = y - state.top
    if (lx < 0 || ly < 0 || lx >= w || ly >= w) return false
    if (mirrored()) lx = w - lx
    try {
      var data = hitCanvas.getContext('2d').getImageData(
        Math.min(609, Math.max(0, Math.floor(lx / w * 610))),
        Math.min(609, Math.max(0, Math.floor(ly / w * 610))), 1, 1).data
      return data[3] > 8
    } catch (err) {
      return false
    }
  }
  function riceOnGirl(bowl) {
    var hw = bowl.artW / 2
    var r = hw * 0.45
    var r2 = r * r
    var need = Math.max(3, Math.round(r * 0.35))
    var hit = 0
    var x0 = Math.round(bowl.X - hw)
    var x1 = Math.round(bowl.X + hw)
    var y0 = Math.round(bowl.Y - hw)
    var y1 = Math.round(bowl.Y + hw)
    for (var y = y0; y <= y1; y += 2) {
      var dy = y - bowl.Y
      for (var x = x0; x <= x1; x += 2) {
        var dx = x - bowl.X
        if (dx * dx + dy * dy > r2) continue
        if (charHitAt(x, y)) { hit += 4; if (hit >= need) return true }
      }
    }
    return false
  }

  function ironAnchorX() { return state.left + state.size * (mirrored() ? (1 - 0.5558) : 0.5558) }
  var wornSequence = 0
  function ironStackIndex(p) {
    var index = 0
    for (var i = 0; i < state.bowls.length; i++) {
      var r = state.bowls[i]
      if (r !== p && r.iron && r.onHead && r.wornOrder < p.wornOrder) index++
    }
    return index
  }
  function ironHeadAnchor(p) {
    var worn = ironWornSize()
    var rimY = state.top + state.size * 0.3639
    return { x: Math.round(ironAnchorX()), y: Math.round(rimY - worn.h / 2 - (p ? ironStackIndex(p) : 0) * worn.h * 2 / 3), w: worn.w, h: worn.h }
  }
  function ironOnHead(p) {
    if (!p.iron || p.onHead || p.headFalling || p.fed || p.dragging) return false
    if (p.VY < 30) return false
    var rimX = p.X
    var rimY = p.Y + p.artH / 2
    var cx = ironAnchorX()
    var cy = state.top + state.size * 0.3639
    var top = null
    state.bowls.forEach(function (b) { if (b.onHead && (!top || b.Y < top.Y)) top = b })
    if (top) return Math.abs(p.X - top.X) <= p.artW / 2 && rimY >= top.Y - top.artH / 2 - 14 && rimY <= top.Y + top.artH / 2
    var halfW = state.size * 0.26
    var halfH = state.size * 0.18
    return rimX > cx - halfW && rimX < cx + halfW && rimY > cy - halfH && rimY < cy + halfH
  }
  function attachIronPot(p) {
    p.wornOrder = ++wornSequence
    var a = ironHeadAnchor(p)
    p.onHead = true
    p.headFalling = false
    p.Y = a.y
    p.headY = a.y
    p.headTarget = a.y
    p.X = a.x
    p.VX = 0
    p.VY = 0
    p.rot = 0
    p.grounded = false
    p.beingSucked = false
    var worn = ironWornSize()
    p.artW = worn.w
    p.artH = worn.h
    p.R = worn.w * 0.42
    p.el.style.width = worn.w + 'px'
    p.el.style.height = worn.h + 'px'
    state.headSquashT = 0
    playPool(landPool)
  }

  function knockPotOff() {
    var top = null
    state.bowls.forEach(function (p) {
      if (p.onHead && p.fadeT <= 0 && (!top || p.Y < top.Y)) top = p
    })
    if (!top) return false
    top.fadeT = 0.001
    state.headSquashT = 0
    playPool(offPool)
    return true
  }

  function updateBowls(dt) {
    var vs = viewportRect()
    for (var i = state.bowls.length - 1; i >= 0; i--) {
      var r = state.bowls[i]
      if (r.fed) {
        r.dieT += dt
        if (r.dieT > BOWL_DIE) {
          if (r.el.parentNode) r.el.parentNode.removeChild(r.el)
          state.bowls.splice(i, 1)
        }
        continue
      }
      if (r.squishT < r.squishDur) r.squishT += dt

      if (r.onHead) {
        var a = ironHeadAnchor(r)
        r.headTarget = a.y
        if (r.fadeT > 0) {
          r.fadeT += dt
          if (r.fadeT > IRON_FADE) {
            if (r.el.parentNode) r.el.parentNode.removeChild(r.el)
            state.bowls.splice(i, 1)
          }
          continue
        }
        if (r.headFalling) {
          r.headY += (r.headTarget - r.headY) * Math.min(1.0, dt * 9.0)
          if (Math.abs(r.headY - r.headTarget) < 0.6) { r.headY = r.headTarget; r.headFalling = false }
          r.Y = r.headY
        } else {
          r.Y = a.y
        }
        r.X = a.x
        r.VX = 0; r.VY = 0; r.squish = 0; r.rot = 0; r.grounded = false
        r.headT += dt
        continue
      }
      if (r.beingSucked) { r.squish = 0; continue }
      if (r.dragging) {
        r.squish = 0
      } else {
        // Arrival speed: the floor impact must be the speed the bowl CAME IN with, not
        // the speed after this frame's gravity. A coarse frame adds >90 px/s of gravity
        // on its own, so with the post-gravity value a bowl that is already sitting on
        // the floor registers a brand-new bounce — and restarts the Q-bounce squash —
        // on every single frame. That is the twitch seen on landing.
        var vBefore = r.VY
        r.VY += GRAVITY * dt
        r.VX *= (1.0 - AIR_DRAG * dt)
        r.X += r.VX * dt
        r.Y += r.VY * dt

        var floor = vs.bottom - r.R
        var left = vs.left + r.R
        var right = vs.right - r.R
        var top = vs.top + r.R
        if (r.Y >= floor) {
          r.Y = floor
          var impact = vBefore > 0 ? vBefore : 0
          var slide = Math.abs(r.VX) > SLIDE_STOP
          if (slide) r.VX *= 0.92
          r.VY = -impact * RESTITUTION
          if (impact > 90 && r.bounces < r.maxBounces) {
            r.bounces++
            r.squish = 1; r.squishT = 0; r.squishDur = SQUISH_DUR
          }
          if (r.bounces >= r.maxBounces || Math.abs(r.VY) < 45) {
            r.VY = 0
            if (!slide) { r.VX = 0; r.grounded = true; r.rot = 0 } else r.grounded = false
          } else r.grounded = false
        }
        if (!r.grounded && r.Y >= floor - 0.5 && Math.abs(r.VY) < 45) {
          r.VX *= (1.0 - SLIDE_FRICTION * dt)
          if (Math.abs(r.VX) <= SLIDE_STOP) { r.VX = 0; r.grounded = true; r.rot = 0 }
        }
        if (r.X < left) { r.X = left; r.VX = Math.abs(r.VX) * 0.5 }
        if (r.X > right) { r.X = right; r.VX = -Math.abs(r.VX) * 0.5 }
        if (r.Y < top) { r.Y = top; if (r.VY < 0) r.VY = 0 }
        if (ironOnHead(r)) attachIronPot(r)
      }

      if (!r.iron && !r.fed && riceOnGirl(r)) onRiceFed(r)
      if (r.squishT < r.squishDur) {
        var u = r.squishT / r.squishDur
        r.squish = Math.cos(u * 2.2 * Math.PI) * (1 - u) * 0.52
      } else r.squish = 0
    }

    // bowl-vs-bowl collisions (circles of radius R)
    for (var a2 = 0; a2 < state.bowls.length; a2++) {
      for (var b2 = a2 + 1; b2 < state.bowls.length; b2++) {
        var ra = state.bowls[a2], rb = state.bowls[b2]
        if (ra.fed || rb.fed || ra.onHead || rb.onHead) continue
        var dx = rb.X - ra.X, dy = rb.Y - ra.Y
        var d = Math.sqrt(dx * dx + dy * dy) || 0.001
        var minD = ra.R + rb.R
        if (d >= minD) continue
        var nx = dx / d, ny = dy / d
        var push = (minD - d) * 0.5
        var aFixed = ra.dragging || ra.beingSucked
        var bFixed = rb.dragging || rb.beingSucked
        var aw = aFixed ? 0 : (bFixed ? 1 : 0.5)
        var bw = bFixed ? 0 : (aFixed ? 1 : 0.5)
        ra.X -= nx * push * 2 * aw; ra.Y -= ny * push * 2 * aw
        rb.X += nx * push * 2 * bw; rb.Y += ny * push * 2 * bw
        var va = ra.VX * nx + ra.VY * ny
        var vb = rb.VX * nx + rb.VY * ny
        if (va - vb > 0 && !aFixed && !bFixed) {
          var imp = (va - vb) * 0.55
          ra.VX -= imp * nx; ra.VY -= imp * ny
          rb.VX += imp * nx; rb.VY += imp * ny
        }
      }
    }
  }

  // ---------------------------------------------------------------- radar ---
  function blip(bowl) {
    var G = headScreen()
    var dx = bowl.X - G.x
    var dy = bowl.Y - G.y
    var dist = Math.sqrt(dx * dx + dy * dy)
    var ux = dist > 0.001 ? dx / dist : 1
    var uy = dist > 0.001 ? dy / dist : 0
    var vx = bowl.dragging ? bowl.sampleVX : bowl.VX
    var vy = bowl.dragging ? bowl.sampleVY : bowl.VY
    var closure = -(vx * ux + vy * uy)
    var alt = -dy
    var ang = Math.atan2(uy, ux)
    var S = 1.33 * (2 * (bowl.artW * 0.42))
    function kpx(v) { return isFinite(v) ? (v / 1000).toFixed(1) + ' kpx' : '--' }
    function pxs(v) { return isFinite(v) ? (v === 0 ? '0' : String(Math.round(v))) + ' px/s' : '--' }
    function px(v) { return isFinite(v) ? (v === 0 ? '0' : String(Math.round(v))) + ' px' : '--' }
    return { S: S, Cx: bowl.X, Cy: bowl.Y, Dist: kpx(dist), Closure: pxs(closure), Alt: px(alt), Ang: ang }
  }
  function rectStr(x, y, w, h) {
    return '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) +
      '" height="' + h.toFixed(1) + '" fill="' + RADAR_GREEN + '"/>'
  }
  function labelStr(text, x, y, h, anchor) {
    var edge = Math.max(1, h * 0.05)
    var common = ' font-family="Consolas,Menlo,monospace" font-weight="bold" font-size="' + h.toFixed(1) +
      '" text-anchor="' + anchor + '"'
    return '<text x="' + (x + edge).toFixed(1) + '" y="' + (y + edge).toFixed(1) + '"' + common +
      ' fill="rgba(0,40,0,0.667)">' + text + '</text>' +
      '<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '"' + common + ' fill="' + RADAR_GREEN + '">' + text + '</text>'
  }
  function renderRadar(list) {
    var out = []
    for (var i = 0; i < list.length; i++) {
      var b = list[i]
      var S = b.S
      if (S < 24) continue
      var cx = b.Cx, cy = b.Cy
      var x0 = cx - S / 2, y0 = cy - S / 2, x1 = cx + S / 2, y1 = cy + S / 2
      var stroke = Math.max(2.0, 0.075 * S)
      var len = 0.30 * S
      var g = []
      g.push(rectStr(x0, y0, len, stroke))
      g.push(rectStr(x1 - len, y0, len, stroke))
      g.push(rectStr(x0, y1 - stroke, len, stroke))
      g.push(rectStr(x1 - len, y1 - stroke, len, stroke))
      g.push(rectStr(x0, y0, stroke, len))
      g.push(rectStr(x1 - stroke, y0, stroke, len))
      g.push(rectStr(x0, y1 - len, stroke, len))
      g.push(rectStr(x1 - stroke, y1 - len, stroke, len))

      var typeH = Math.max(11.0, 0.40 * S)
      var numH = Math.max(11.0, 0.30 * S)
      var gapX = 0.08 * S
      g.push(labelStr(RADAR_TYPE, cx, y0 - 0.06 * S - typeH * 0.78, typeH, 'middle'))
      g.push(labelStr(b.Dist, x1 + gapX, y0 + numH * 0.78, numH, 'start'))
      g.push(labelStr(b.Closure, x1 + gapX, y1, numH, 'start'))
      g.push(labelStr(b.Alt, x1 + 0.11 * S, y1 + 0.09 * S + numH, numH, 'end'))

      var ringR = 0.185 * S
      var ringStroke = 0.075 * S
      var rcx = cx, rcy = y1 + 0.70 * S
      g.push('<circle cx="' + rcx.toFixed(1) + '" cy="' + rcy.toFixed(1) + '" r="' + (ringR - ringStroke / 2).toFixed(1) +
        '" fill="none" stroke="' + RADAR_GREEN + '" stroke-width="' + ringStroke.toFixed(1) + '"/>')
      var ca = Math.cos(b.Ang), sa = Math.sin(b.Ang)
      g.push('<line x1="' + (rcx + ca * (ringR + ringStroke / 2)).toFixed(1) + '" y1="' + (rcy + sa * (ringR + ringStroke / 2)).toFixed(1) +
        '" x2="' + (rcx + ca * (ringR + 0.15 * S)).toFixed(1) + '" y2="' + (rcy + sa * (ringR + 0.15 * S)).toFixed(1) +
        '" stroke="' + RADAR_GREEN + '" stroke-width="' + ringStroke.toFixed(1) + '" stroke-linecap="square"/>')
      out.push('<g>' + g.join('') + '</g>')
    }
    radarSvg.innerHTML = out.join('')
  }

  function chargingBusy() {
    return state.pendingStep > 1e-9 || state.hits.length > 0 || state.demoLeft > 0
  }

  function updateRadar(dt) {
    var anyRice = false
    for (var i = 0; i < state.bowls.length; i++) {
      if (!state.bowls[i].iron && !state.bowls[i].fed) { anyRice = true; break }
    }
    if (!anyRice) {
      state.lockAll = false
      state.lockT = 0
      state.radarManual = false
      if (radarSvg.firstChild) radarSvg.innerHTML = ''
      return
    }
    if (state.bowlWait >= BOWL_WAIT) state.lockAll = true
    var showNow = state.lockAll || state.radarManual
    var blips = []
    for (var j = 0; j < state.bowls.length; j++) {
      var bowl = state.bowls[j]
      if (bowl.iron || bowl.fed) continue
      if (!showNow) continue
      blips.push(blip(bowl))
    }
    state.radarManual = state.radarManual && !state.lockAll
    if (!blips.length) {
      state.lockT = 0
      if (radarSvg.firstChild) radarSvg.innerHTML = ''
      return
    }

    // A charge that arrives now waits its turn: the pump pauses, it does not reset.
    if (!chargingBusy()) state.lockT += dt
    var magnet = state.lockAll && state.lockT >= LOCK_DELAY
    if (magnet) {
      var G = headScreen()
      for (var k = 0; k < state.bowls.length; k++) {
        var b = state.bowls[k]
        if (b.iron || b.fed) continue
        b.beingSucked = true
        var dx = G.x - b.X, dy = G.y - b.Y
        var d = Math.sqrt(dx * dx + dy * dy)
        b.suckSpeed = Math.min(SUCK_MAX, (b.suckSpeed || 0) + SUCK_ACCEL * dt)
        if (d <= Math.max(12, b.R) || d < 0.001) { onRiceFed(b); continue }
        var step = Math.min(d, b.suckSpeed * dt)
        b.X += dx / d * step
        b.Y += dy / d * step
      }
      // plates follow the bowls
      blips = []
      for (var m = 0; m < state.bowls.length; m++) {
        var bb = state.bowls[m]
        if (bb.iron || bb.fed) continue
        blips.push(blip(bb))
      }
    }
    renderRadar(blips)
  }

  // ----------------------------------------------------------- expression ---
  function setExpression(want) {
    if (state.expr === want) return
    state.expr = want
    for (var i = 0; i < EXPR_ORDER.length; i++) {
      var k = EXPR_ORDER[i]
      var on = k === want
      faces[k].style.display = on ? 'block' : 'none'
      flashes[k].style.display = on ? 'block' : 'none'
    }
    updateHitSource()
  }
  function updateExpression(dt) {
    var anyBowl = false
    for (var i = 0; i < state.bowls.length; i++) {
      if (!state.bowls[i].fed && !state.bowls[i].iron) { anyBowl = true; break }
    }
    var cueRunning = state.fxHurt && chargingBusy()
    if (anyBowl && !cueRunning && !state.lockAll) state.bowlWait += dt
    else if (!anyBowl) state.bowlWait = 0

    var headPotOn = false
    for (var j = 0; j < state.bowls.length; j++) {
      if (state.bowls[j].iron && state.bowls[j].onHead && state.bowls[j].fadeT <= 0) { headPotOn = true; break }
    }
    var want
    // Upstream 2026 UpdateExpression: the pat uses expression_22 (eyes shut),
    // even with an empty balance. Restore the ordinary state on the next frame.
    if (pat.active) want = 'nervous'
    else if (isFinite(state.real) && state.real <= 0.005) want = 'aloof'
    else if (headPotOn && !anyBowl) want = 'calm'
    else if (cueRunning) want = 'nervous'
    else if (state.bowlWait >= BOWL_WAIT) want = 'aloof'
    else want = 'happy'
    setExpression(want)
  }

  // ------------------------------------------------------- balance reading ---
  function applyBalance(bal, snap) {
    if (!isFinite(bal)) return
    noteUsage(bal)
    state.connected = true
    var first = !isFinite(state.real)
    var prev = state.real
    state.real = bal
    if (first) {
      state.bookedAt = bal
      state.bookedBal = bal
      state.pending = 0
    }
    if (snap) {
      state.bookedAt = bal
      state.bookedBal = bal
      state.testOffset = 0
      state.pending = 0
      state.pendingStep = 0
      state.dueGap = 0
      state.creditPending = 0
      state.bowls.filter(function (b) { return !b.iron }).forEach(function (b) { detach(b.el) })
      state.bowls = state.bowls.filter(function (b) { return b.iron })
    } else if (!first) {
      if (bal > prev + 1e-9) {
        // A top-up must NOT move the readout: it drops a bowl for you to collect.
        startCredit(round4(bal - prev))
      } else {
        var owed = round4(state.bookedAt - bal)
        if (owed < -1e-9) {
          owed = state.pending
          state.bookedAt = round4(bal + owed)
          state.bookedBal = round4(bal + owed)
        }
        if (owed >= state.pendingStep - 1e-9) owed = round4(owed - state.pendingStep)
        else owed = 0
        var cap = STEP * MAX_CUES_PER_POLL
        if (owed > cap) owed = cap
        state.pending = owed < 1e-9 ? 0 : owed
        if (state.pending > 1e-9 && state.dueGap <= 0) state.dueGap = 0
      }
    }
    updateScreen()
  }

  function updateScreen() {
    var v = drawnBalance()
    numEl.textContent = isFinite(v) ? v.toFixed(2) : '--'
    numEl.style.fontSize = 'calc(var(--dshvk1-ph) * ' + Math.min(0.48, 2.5 / Math.max(1, numEl.textContent.length)) + ')'
    updateTablet()
    dot.style.display = state.connected ? 'none' : 'block'
  }

  var busy = false
  function poll(snap) {
    if (busy) return
    busy = true
    Promise.resolve()
      .then(function () { return window.__xykpVk1BalanceProvider(!!snap) })
      .then(function (d) {
        if (stopped) return
        if (d && d.ok && d.totalBalance != null && isFinite(Number(d.totalBalance))) {
          if (d.serverTime && isFinite(Date.parse(d.serverTime))) state.cloudOffset = Date.parse(d.serverTime) - Date.now()
          applyBalance(Number(d.totalBalance), !!snap)
        }
        else { state.connected = false; updateScreen() }
      })
      .catch(function () { if (!stopped) { state.connected = false; updateScreen() } })
      .finally(function () { busy = false })
  }
  function pollIntervalMs() {
    var s = Number(state.pollSeconds)
    return (isFinite(s) ? clamp(s, 2, 300) : 12) * 1000
  }
  function restartPoll() {
    if (!pollTimer) return
    clearInterval(pollTimer)
    pollTimer = setInterval(function () { poll(false) }, pollIntervalMs())
  }

  // ----------------------------------------------------------------- draw ---
  function renderBowls() {
    var worn = false
    for (var i = 0; i < state.bowls.length; i++) {
      var r = state.bowls[i]
      if (!r.el) continue
      if (r.iron && r.onHead) worn = true
      var sq = r.squish || 0
      var sw = 1.0 + sq * 0.75
      var sh = 1.0 - sq * 0.75
      // Upstream draws with TranslateTransform(anchor) then Rotate/Scale and finally
      // DrawImage at a fixed art offset relative to that anchor. Emitting the same
      // chain as one CSS transform list keeps the two anchor rules honest:
      var tf
      if (r.onHead) {
        // Worn pot: anchored on the art CENTRE (IronHeadAnchor) and tilted about it. It has
        // to be mirrored together with her: she is drawn with scaleX(-1) when pinned to the
        // right edge, and a pot living in screen coordinates would otherwise lean the wrong
        // way against a mirrored head. Mirroring negates the rotation and flips the
        // horizontal scale: M' = T(2C-X, Y) R(-T) S(-sw, sh) T(-c).
        var flip = mirrored() ? -1 : 1
        tf = 'translate(' + Math.round(r.X) + 'px,' + Math.round(r.Y) + 'px)' +
          ' rotate(' + (flip * -IRON_TILT_DEG) + 'deg)' +
          ' scale(' + (flip * sw).toFixed(3) + ',' + sh.toFixed(3) + ')' +
          ' translate(' + (-r.artW / 2).toFixed(1) + 'px,' + (-r.artH / 2).toFixed(1) + 'px)'
      } else {
        // Loose prop: anchored on its BOTTOM edge at Y + R, so at rest the art sits
        // exactly on the screen floor (anchoring the art on Y instead pushes its
        // bottom 0.08*artW through the floor, where it gets clipped), and the squash
        // then grows upward from that same edge.
        tf = 'translate(' + Math.round(r.X) + 'px,' + Math.round(r.Y + r.R) + 'px)' +
          ' scale(' + sw.toFixed(3) + ',' + sh.toFixed(3) + ')' +
          ' translate(' + (-r.artW / 2).toFixed(1) + 'px,' + (-r.artH).toFixed(1) + 'px)'
      }
      r.el.style.transform = tf
      r.el.style.zIndex = r.onHead ? String(10 + ironStackIndex(r)) : '0'
      if (r.fed) {
        var e = 1.0 - r.dieT / BOWL_DIE
        r.el.style.opacity = String(e > 0 ? e : 0)
      } else if (r.fadeT > 0) {
        var f = 1.0 - r.fadeT / IRON_FADE
        r.el.style.opacity = String(f > 0 ? f : 0)
      } else {
        r.el.style.opacity = '1'
      }
    }
    applyPotMask(worn)
  }

  var last = 0
  var rafId = 0
  var stopped = false
  function frame(now) {
    if (stopped) return
    rafId = requestAnimationFrame(frame)
    if (!last) { last = now; return }
    var dt = Math.min(0.1, (now - last) / 1000)
    last = now

    // ---- settlement: the only place the printed number moves ----
    if (state.dueGap > 0) state.dueGap -= dt
    var take = 0
    if (state.dueGap <= 0 && state.pendingStep <= 0) {
      if (state.pending >= STEP - 1e-9) take = STEP
      else if (state.pending > 1e-9) take = Math.round(state.pending * 100) / 100
    }
    if (take > 0) {
      state.pending = round4(state.pending - take)
      if (state.pending < 1e-9) state.pending = 0
      state.bookedAt = round4(state.bookedAt - take)
      state.bookedBal = round4(state.bookedBal - take)
      state.pendingStep = take
      state.dueGap = CUE_GAP
    }
    if (state.pendingStep > 0) { makeTick(state.pendingStep, false); state.pendingStep = 0; updateScreen() }
    if (state.demoLeft > 0 && state.pendingStep <= 0 && state.dueGap <= 0) {
      makeTick(state.demoAmount, true)
      state.demoLeft--
      state.dueGap = CUE_GAP
      updateScreen()
    }
    // 演示是借位显示：全部动画放完 1.4s 后把借掉的数字还回去，别看着像真扣了。
    if (state.demoResetAt && state.demoLeft <= 0 && Date.now() >= state.demoResetAt) {
      state.demoResetAt = 0
      state.testOffset = 0
      updateScreen()
    }

    updateBowls(dt)
    updateRadar(dt)
    updatePat(dt)
    tickTablet(dt)
    updateExpression(dt)

    for (var i = state.hits.length - 1; i >= 0; i--) {
      state.hits[i].T += dt
      if (state.hits[i].T >= HIT_DUR) state.hits.splice(i, 1)
    }
    for (var j = state.floaters.length - 1; j >= 0; j--) {
      var fl = state.floaters[j]
      fl.T += dt
      if (fl.T >= FLOAT_DUR) {
        if (fl.el.parentNode) fl.el.parentNode.removeChild(fl.el)
        state.floaters.splice(j, 1)
      }
    }
    for (var k = state.hearts.length - 1; k >= 0; k--) {
      var hh = state.hearts[k]
      hh.T += dt
      if (hh.T >= hh.Dur) {
        if (hh.el.parentNode) hh.el.parentNode.removeChild(hh.el)
        state.hearts.splice(k, 1)
      }
    }

    var sx = 0, sy = 0
    for (var m = 0; m < state.hits.length; m++) {
      var h = state.hits[m]
      var e = Math.max(0, 1 - h.T / HIT_DUR)
      sx += Math.sin(h.T * 24) * 3.2 * e
      sy += Math.cos(h.T * 19) * 2.8 * e
    }
    var shakeMax = Math.min(12.0, state.size * 0.06)
    sx = clamp(sx, -shakeMax, shakeMax)
    sy = clamp(sy, -shakeMax, shakeMax)

    if (state.headSquashT < HEAD_SQUASH_DUR) state.headSquashT += dt
    var hu = state.headSquashT / HEAD_SQUASH_DUR
    var squash = hu < 1 ? Math.sin(Math.PI * hu) * (1 - hu) * 0.6 : 0
    var shakeTf = 'translate(' + Math.round(sx) + 'px,' + Math.round(sy) + 'px)'
    if (squash > 0.001) {
      shakeTf += ' scale(' + (1 + squash * 0.10).toFixed(4) + ',' + (1 - squash * 0.16).toFixed(4) + ')'
    }
    if (pat.active) {
      var pi = Math.floor(pat.t / 0.04) % 5
      // Upstream moves the compression pivot below her feet: displacement is shift*(1-scaleY).
      // Keep the feet inside the webpage when she is pinned against the viewport's bottom.
      var patShift = Math.min(state.size * pi * 0.05 * pi * 0.0625, Math.max(0, viewport().h - state.top - state.size))
      shakeTf += ' translateY(' + patShift.toFixed(2) + 'px) scale(' + (1 + pi * 0.025) + ',' + (1 - pi * 0.0625) + ')'
    }
    body.style.transform = shakeTf

    var flash = 0
    var maxTint = Math.max(0.30, 0.64 - scaleOf() * 0.75)
    for (var n = 0; n < state.hits.length; n++) {
      var hit = state.hits[n]
      var pulse
      if (hit.T < 0.20) pulse = 1.0
      else {
        var ee = Math.max(0, 1 - (hit.T - 0.20) / (HIT_DUR - 0.20))
        pulse = Math.sin((hit.T - 0.20) * 26) * 0.55 * ee * ee
      }
      if (pulse > 0.01) flash = Math.max(flash, Math.min(maxTint, maxTint * pulse))
    }
    var activeFlash = flashes[state.expr]
    if (activeFlash) activeFlash.style.opacity = String(flash)

    for (var p = 0; p < state.floaters.length; p++) {
      var f = state.floaters[p]
      var t = f.T / FLOAT_DUR
      var em = Math.max(13, 34 * scaleOf())
      var pop = t < 0.18 ? (0.62 + 0.38 * (t / 0.18)) : 1
      var alpha = t < 0.55 ? 1 : (1 - (t - 0.55) / 0.45)
      if (!f.el) continue
      if (alpha <= 0) { f.el.style.opacity = '0'; continue }
      var fx = f.x + Math.round(f.jitter * Math.sin(t * 9))
      if (mirrored()) fx = state.left + (state.size - (fx - state.left) - f.tw)
      var fy = f.y - Math.round(t * em * 2.7)
      f.el.style.opacity = String(alpha)
      f.el.style.transform = 'translate(' + fx + 'px,' + fy + 'px) scale(' + pop + ')'
    }

    for (var q = 0; q < state.hearts.length; q++) {
      var hd = state.hearts[q]
      var u = hd.T / hd.Dur
      var a = u < 0.15 ? u / 0.15 : 1.0 - (u - 0.15) / 0.85
      var rise = 46.0 * u
      var wob = Math.sin(hd.phase + u * 7.0) * 6.0
      hd.el.style.opacity = String(a > 0 ? a : 0)
      hd.el.style.transform = 'translate(' + Math.round(hd.x + hd.drift * u + wob) + 'px,' + Math.round(hd.y - rise) + 'px)'
    }

    renderBowls()
  }

  // ----------------------------------------------------------- hit testing ---
  var hitCanvas = null
  var hitReady = false
  var hitSrc = ''
  var potArt = null
  var potArtReady = false
  var potMask = { key: '', url: '', applied: '' }
  function updateHitSource() {
    var url = EXPR_URL[state.expr] || EXPR_URL.happy
    if (hitSrc === url) return
    hitSrc = url
    hitReady = false
    try {
      var probe = new Image()
      probe.onload = function () {
        if (stopped || hitSrc !== url) return
        try {
          hitCanvas.getContext('2d').clearRect(0, 0, 610, 610)
          hitCanvas.getContext('2d').drawImage(probe, 0, 0, 610, 610)
          hitReady = true
        } catch (err) {}
      }
      probe.src = url
    } catch (err) {}
  }
  function alphaBounds(pixels, width, height) {
    var x0 = width, y0 = height, x1 = -1, y1 = -1
    for (var y = 0; y < height; y++) for (var x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] <= 8) continue
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
    }
    return x1 < x0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
  }
  function setupHitTest() {
    try {
      hitCanvas = document.createElement('canvas')
      hitCanvas.width = 610
      hitCanvas.height = 610
      updateHitSource()
    } catch (err) {}
    try {
      potArt = new Image()
      potArt.onload = function () {
        if (stopped) return
        try {
          // The authorized HD source is a square canvas with transparent margins.
          // Match upstream TrimTransparent(alpha > 8), retaining every source pixel.
          var source = potArt
          var scan = document.createElement('canvas')
          scan.width = source.naturalWidth; scan.height = source.naturalHeight
          var ctx = scan.getContext('2d')
          ctx.drawImage(source, 0, 0)
          var pixels = ctx.getImageData(0, 0, scan.width, scan.height).data
          var bounds = alphaBounds(pixels, scan.width, scan.height)
          if (!bounds) throw new Error('Empty iron art')
          var cropped = document.createElement('canvas')
          cropped.width = bounds.w; cropped.height = bounds.h
          cropped.getContext('2d').drawImage(source, bounds.x, bounds.y, bounds.w, bounds.h, 0, 0, bounds.w, bounds.h)
          ironDrawUrl = cropped.toDataURL('image/png')
          potArt = cropped; potArtReady = true
          state.bowls.forEach(function (b) { if (b.iron) { b.el.src = ironDrawUrl; b.el.style.visibility = '' } })
          scan.width = scan.height = 0
        } catch (err) { showFatal('铁盆高清素材读取失败') }
      }
      potArt.src = IRON_URL
    } catch (err) {}
  }

  // Wearing the pot must not leave her hair showing above it. Upstream ships a
  // hand-drawn erase mask (EraseStrokes) that clears her pixels inside the pot's
  // column and above the pot's own OUTLINE — note it follows the dome (deep in the
  // middle, shallow at the ends), because a flat cut would bite a notch out of her
  // hair beside the dome. Here the same shape is derived from the pot art instead of
  // pasted coordinates, so it tracks every size preset and the worn tilt.
  function potMaskUrl() {
    // The erase shape IS the pot, so without its art step 3 cannot run and the mask
    // degenerates into a flat cut of the whole column above the rim — which bites a
    // notch out of her hair beside the dome, the very thing the dome-following shape
    // avoids. Returning '' leaves the mask off entirely; applyPotMask() re-asks every
    // frame, so the mask appears on its own once the art lands (and never gets cached
    // in the degraded form, because nothing is cached on this path).
    if (!potArtReady) return ''
    var worn = ironWornSize()
    var key = state.size + '/' + worn.w + 'x' + worn.h
    if (potMask.key === key) return potMask.url
    potMask.key = key
    potMask.url = ''
    try {
      var W = state.size
      var cx = W * 0.5558
      var rimY = W * 0.3639
      var pad = Math.ceil(W * 0.02)                 // covers the worn tilt
      var x0 = Math.floor(cx - worn.w / 2 - pad)
      // Rasterise the pot exactly where the worn pot is drawn — same centre, same tilt —
      // and read its ALPHA back, so the erase boundary is the pot's REAL outline in every
      // column instead of a guessed shape. This is the shape upstream encodes by hand in
      // EraseStrokes. Deriving it also removes the need to re-show the pot body, and that
      // re-show was what let her hair leak back through the pot's anti-aliased top edge
      // as the little spikes the user photographed.
      var t = document.createElement('canvas')
      t.width = Math.max(1, Math.ceil(worn.w + pad * 2))
      t.height = Math.max(1, Math.ceil(rimY))
      var tg = t.getContext('2d')
      tg.save()
      tg.translate(cx - x0, rimY - worn.h / 2)
      // The mask is applied to the ART, and the art is flipped as a whole when she is pinned
      // to the right edge, so the mask's content must be the UNMIRRORED pot placement in
      // every case. Mirroring it here as well would flip twice and leave the erase boundary
      // 2*6.23deg out of step with the pot.
      tg.rotate(-IRON_TILT_DEG * Math.PI / 180)
      tg.drawImage(potArt, -worn.w / 2, -worn.h / 2, worn.w, worn.h)
      tg.restore()
      var alpha = tg.getImageData(0, 0, t.width, t.height).data
      var margin = Math.max(2, Math.round(W * 0.008))   // swallow the AA fringe
      var c = document.createElement('canvas')
      c.width = W
      c.height = W
      var g = c.getContext('2d')
      // A CSS mask fed an IMAGE is read through its ALPHA channel (mask-mode:
      // match-source), so "hidden" means alpha 0. Painting a region black would leave it
      // fully opaque and the mask would silently do nothing at all — which is what the
      // first version did.
      g.fillStyle = '#fff'
      g.fillRect(0, 0, W, W)
      g.globalCompositeOperation = 'destination-out'
      for (var x = 0; x < t.width; x++) {
        var top = -1
        for (var y = 0; y < t.height; y++) {
          if (alpha[(y * t.width + x) * 4 + 3] > 128) { top = y; break }
        }
        // Where the pot has no pixel at all, nothing covers her, so the whole column down
        // to the rim goes. Otherwise everything above the outline, plus a margin so the
        // pot's own soft edge cannot leak her hair back through.
        var bottom = top < 0 ? t.height : Math.min(t.height, top + margin)
        if (bottom > 0) g.fillRect(x0 + x, 0, 1, bottom)
      }
      g.globalCompositeOperation = 'source-over'
      potMask.url = c.toDataURL()
    } catch (err) {
      potMask.url = ''
    }
    return potMask.url
  }

  function applyPotMask(worn) {
    var url = worn ? potMaskUrl() : ''
    if (url === potMask.applied) return
    potMask.applied = url
    var cssUrl = url ? 'url("' + url + '")' : ''
    art.style.webkitMaskImage = cssUrl
    art.style.maskImage = cssUrl
    // Pinned explicitly: the canvas mask encodes the erase as transparency, and alpha is
    // the reading that matches it (luminance would invert the meaning of the punch).
    art.style.webkitMaskMode = url ? 'alpha' : ''
    art.style.maskMode = url ? 'alpha' : ''
    art.style.webkitMaskSize = url ? '100% 100%' : ''
    art.style.maskSize = url ? '100% 100%' : ''
    art.style.webkitMaskRepeat = url ? 'no-repeat' : ''
    art.style.maskRepeat = url ? 'no-repeat' : ''
  }
  function isHit(e) {
    if (!hitCanvas || !hitReady) return false
    try {
      var r = root.getBoundingClientRect()
      if (!r || r.width <= 0 || r.height <= 0) return false
      var lx = (e.clientX - r.left) / r.width * 610
      var ly = (e.clientY - r.top) / r.height * 610
      if (lx < 0 || ly < 0 || lx >= 610 || ly >= 610) return false
      var data = hitCanvas.getContext('2d').getImageData(Math.floor(lx), Math.floor(ly), 1, 1).data
      return data[3] > 10
    } catch (err) {
      return false
    }
  }
  function bowlAt(x, y) {
    for (var i = state.bowls.length - 1; i >= 0; i--) {
      var b = state.bowls[i]
      // A worn pot is not grabbable: it is removed by double-clicking her head.
      if (b.fed || b.fadeT > 0 || b.beingSucked || b.onHead) continue
      // The art hangs from its bottom edge at Y + R, so the pick circle tracks the
      // drawn art rather than the physics footprint centre.
      var cy = b.Y + b.R - b.artH / 2
      var dx = x - b.X, dy = y - cy
      if (dx * dx + dy * dy <= Math.pow(b.R * 1.15, 2)) return b
    }
    return null
  }
  function inHeadBox(x, y) {
    var cx = state.left + state.size * (mirrored() ? (1 - 0.47) : 0.47)
    var cy = state.top + state.size * 0.30
    return Math.abs(x - cx) < state.size * 0.26 && Math.abs(y - cy) < state.size * 0.18
  }

  // ================================================== position (whale port) ==
  function viewport() {
    return {
      w: window.innerWidth || document.documentElement.clientWidth || 1280,
      h: window.innerHeight || document.documentElement.clientHeight || 800,
    }
  }
  function rightGap() {
    if (!state.scrollGapOn) return 0
    return state.scrollGapPx > 0 ? state.scrollGapPx : 0
  }
  function express() {
    root.style.left = state.left + 'px'
    root.style.top = state.top + 'px'
  }
  function settle() {
    var vp = viewport()
    var w = state.size, h = state.size
    if (state.dragWidget) {
      state.left = clamp(state.left, 0, Math.max(0, vp.w - w - rightGap()))
      state.top = clamp(state.top, 0, Math.max(0, vp.h - h))
      express(); layout(); return
    }
    if (state.h === 'right') state.left = Math.max(0, vp.w - w - state.hOff - rightGap() - 10)
    else if (state.h === 'left') state.left = state.hOff
    else state.left = clamp(state.left, 0, Math.max(0, vp.w - w - rightGap()))
    if (state.v === 'bottom') state.top = Math.max(0, vp.h - h - state.vOff - 8)
    else if (state.v === 'top') state.top = state.vOff
    else state.top = clamp(state.top, 0, Math.max(0, vp.h - h))
    express()
    layout()
  }
  function saveAnchor() {
    try {
      var vp = viewport()
      var w = state.size, h = state.size
      var leftDist = state.left, rightDist = vp.w - state.left - w
      var topDist = state.top, bottomDist = vp.h - state.top - h
      var hAnchor = leftDist <= rightDist ? 'left' : 'right'
      var hDistRaw = Math.round(Math.min(leftDist, rightDist))
      var hDist = hAnchor === 'right' && state.scrollGapOn ? Math.max(0, hDistRaw - rightGap()) : hDistRaw
      localStorage.setItem(POS_KEY, JSON.stringify({
        v: 2, hAnchor: hAnchor, hDist: hDist,
        vAnchor: topDist <= bottomDist ? 'top' : 'bottom',
        vDist: Math.round(Math.min(topDist, bottomDist)),
      }))
    } catch (err) {}
  }
  function applyAnchorPos() {
    try {
      var a = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
      if (!a || a.v !== 2 || (a.hAnchor !== 'left' && a.hAnchor !== 'right') || typeof a.hDist !== 'number' ||
          (a.vAnchor !== 'top' && a.vAnchor !== 'bottom') || typeof a.vDist !== 'number') return false
      var vp = viewport()
      var w = state.size, h = state.size
      var effectiveRightDist = a.hAnchor === 'right' ? a.hDist + (state.scrollGapOn ? rightGap() : 0) : a.hDist
      var l = a.hAnchor === 'left' ? a.hDist : vp.w - effectiveRightDist - w
      var t = a.vAnchor === 'top' ? a.vDist : vp.h - a.vDist - h
      state.left = clamp(l, 0, Math.max(0, vp.w - w))
      state.top = clamp(t, 0, Math.max(0, vp.h - h))
      state.h = a.hAnchor; state.hOff = 0
      state.v = a.vAnchor; state.vOff = 0
      express(); layout()
      return true
    } catch (err) {
      return false
    }
  }

  // ------------------------------------------------------ drag & snapping ---
  function addDragListeners() {
    document.addEventListener('pointermove', onMove, true)
    document.addEventListener('pointerup', onUp, true)
    document.addEventListener('pointercancel', onUp, true)
  }
  function removeDragListeners() {
    document.removeEventListener('pointermove', onMove, true)
    document.removeEventListener('pointerup', onUp, true)
    document.removeEventListener('pointercancel', onUp, true)
  }
  function onDragStart(e) {
    var r = root.getBoundingClientRect()
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
      try { e.preventDefault(); e.stopPropagation() } catch (err) {}
    }
  }
  function blockPageGesture(e) {
    if (settings.open) return
    var r = root.getBoundingClientRect()
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return
    if (e.target && e.target.closest && e.target.closest('.dshvk1-btn,.dshvk1-dialog,.dshvk1-menu,textarea,input,select,[contenteditable="true"],[role="textbox"]')) return
    try { e.preventDefault(); e.stopPropagation() } catch (err) {}
  }
  function onDown(e) {
    // 页面输入框在挂件下方时，把点击让给页面（挂件是 pointer-events:none，
    // 所以 e.target 是真正的输入控件；只放行文本输入，链接/按钮不穿透）。
    if (e.target && e.target.closest && e.target.closest('textarea,input,select,[contenteditable="true"],[role="textbox"]')) return
    blockPat()
    if (settings.open) return
    if (state.menuOpen) return
    if (e.button !== 0 && e.pointerType === 'mouse') return
    if (e.target && e.target.closest && e.target.closest('.dshvk1-menu,.dshvk1-btn')) return

    // 挂件覆盖的矩形里，指针事件别再漏到页面（尤其是文档预览的图片原生拖拽）。
    // 输入框 / 按钮 / 链接由 build.mjs 注入的守卫先放行，不影响页面交互。
    var rect = root.getBoundingClientRect()
    if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
      try { e.preventDefault(); e.stopPropagation() } catch (err) {}
    }

    var onArt = isHit(e)
    // Double-clicking her head (with the pot on it) is decided FIRST: the worn pot
    // is a wide circle sitting right on that spot, so a bowl grab would eat it.
    var now = Date.now()
    var isHead = onArt && inHeadBox(e.clientX, e.clientY)
    if (isHead && state.lastHeadClick && now - state.lastHeadClick.t < 400 &&
        Math.abs(e.clientX - state.lastHeadClick.x) < 24 && Math.abs(e.clientY - state.lastHeadClick.y) < 24) {
      state.lastHeadClick = null
      knockPotOff()
      try { e.preventDefault(); e.stopPropagation() } catch (err) {}
      return
    }
    if (isHead) state.lastHeadClick = { t: now, x: e.clientX, y: e.clientY }
    // 双击平板 = 立即刷新余额（原来右键菜单里的「立即刷新余额」）。
    if (onTablet(e.clientX, e.clientY)) {
      var tc = state.lastTabletClick
      if (tc && now - tc.t < 400 && Math.hypot(e.clientX - tc.x, e.clientY - tc.y) < 24) {
        state.lastTabletClick = null
        poll(true)
        showWheelBadge('刷新余额…', e.clientX, e.clientY)
        try { e.preventDefault(); e.stopPropagation() } catch (err) {}
        return
      }
      state.lastTabletClick = { t: now, x: e.clientX, y: e.clientY }
    }
    var bowl = bowlAt(e.clientX, e.clientY)
    if (bowl) {
      try { e.preventDefault(); e.stopPropagation() } catch (err) {}
      bowl.beingSucked = false
      bowl.dragging = true
      bowl.VX = 0
      bowl.VY = 0
      state.grab = { bowl: bowl, dx: bowl.X - e.clientX, dy: bowl.Y - e.clientY, moved: false, x: e.clientX, y: e.clientY }
      document.body.style.cursor = 'grabbing'
      root.style.cursor = 'grabbing'
      addDragListeners()
      return
    }
    if (!onArt) return

    try { e.preventDefault(); e.stopPropagation() } catch (err) {}
    state.dragWidget = { x: e.clientX, y: e.clientY, left: state.left, top: state.top, moved: false }
    root.classList.add('dshvk1-dragging')
    addDragListeners()
  }
  function onMove(e) {
    var g = state.grab
    if (g) {
      var b = g.bowl
      if (Math.abs(e.clientX - g.x) + Math.abs(e.clientY - g.y) >= 3) g.moved = true
      var nx = e.clientX + g.dx
      var ny = e.clientY + g.dy
      b.sampleVX = (nx - b.X) / 0.016
      b.sampleVY = (ny - b.Y) / 0.016
      b.X = nx
      b.Y = ny
      renderBowls()
      return
    }
    var d = state.dragWidget
    if (!d) return
    var dx = e.clientX - d.x
    var dy = e.clientY - d.y
    if (dx * dx + dy * dy >= 9) d.moved = true
    var vp = viewport()
    state.left = clamp(d.left + dx, 0, Math.max(0, vp.w - state.size - rightGap()))
    state.top = clamp(d.top + dy, 0, Math.max(0, vp.h - state.size))
    express()
  }
  function onUp(e) {
    // 拖拽/松开后把“按键还按着”的缓存状态清掉，否则 pat 会一直以为
    // 鼠标没松（p.buttons=1），摸头要等下一次移动才恢复。
    if (pat.pointer) pat.pointer.buttons = 0
    pat.blocked = 0
    pat.distance = 0
    pat.moveTime = 0
    root.style.cursor = ''
    document.body.style.cursor = ''
    var g = state.grab
    if (g) {
      var b = g.bowl
      b.dragging = false
      state.grab = null
      removeDragListeners()
      if (b.iron) {
          b.VX = b.sampleVX * 0.35
          b.VY = b.sampleVY * 0.35
          var floor = viewportRect().bottom
          b.maxBounces = bouncesForDrop(Math.max(0, floor - b.Y))
          b.bounces = 0
          b.grounded = false
      } else if (riceOnGirl(b)) {
        onRiceFed(b)
      } else {
        b.VX = b.sampleVX * 0.35
        b.VY = b.sampleVY * 0.35
        var fl = viewportRect().bottom
        b.maxBounces = bouncesForDrop(Math.max(0, fl - b.Y))
        b.bounces = 0
        b.grounded = false
      }
      return
    }
    var d = state.dragWidget
    if (!d) return
    state.dragWidget = null
    root.classList.remove('dshvk1-dragging')
    removeDragListeners()
    if (!d.moved) { poll(true); return }

    var vp = viewport()
    var w = state.size, h = state.size
    var left = state.left, top = state.top
    var centerX = left + w / 2
    var centerY = top + h / 2
    var ratio = state.snapRatio
    if (centerX < vp.w * ratio) { state.h = 'left'; state.hOff = 0 }
    else if (centerX > vp.w * (1 - ratio)) { state.h = 'right'; state.hOff = 0 }
    else { state.h = null; state.hOff = left }
    if (centerY < vp.h * ratio) { state.v = 'top'; state.vOff = 0 }
    else if (centerY > vp.h * (1 - ratio)) { state.v = 'bottom'; state.vOff = 0 }
    else { state.v = null; state.vOff = top }
    settle()
    saveAnchor()
  }
  function onCursor(e) {
    pat.pointer = { x: e.clientX, y: e.clientY, buttons: e.buttons || 0 }
    if (state.dragWidget || state.grab) return
    var onArt = isHit(e)
    var onBowl = !!bowlAt(e.clientX, e.clientY)
    var onBtn = !!(e.target && e.target.closest && e.target.closest('.dshvk1-btn'))
    var rr = root.getBoundingClientRect()
    var insideRoot = e.clientX >= rr.left && e.clientX <= rr.right && e.clientY >= rr.top && e.clientY <= rr.bottom
    if (onArt || onBowl || onBtn || insideRoot || state.menuOpen) {
      btnOnSolid = true
      keepBtn()
    } else if (btnOnSolid) {
      btnOnSolid = false
      releaseBtn()
    }
    // 平时不显示拖拽手型；只有真正拖的时候由 .dshvk1-dragging 显示 grabbing。
    root.style.cursor = ''
  }
  function onContextMenu(e) {
    if (settings.open) return
    if (state.dragWidget || state.grab) return
    if (!isHit(e)) return
    try { e.preventDefault(); e.stopPropagation() } catch (err) {}
    showSettings('display')
  }
  function onResize() {
    if (state.h === null && state.v === null && applyAnchorPos()) return
    settle()
  }
  var wheelBadge = document.createElement('div')
  wheelBadge.style.cssText = 'position:fixed;z-index:10003;padding:3px 8px;border-radius:6px;background:rgba(20,26,40,.92);color:#eaf1ff;font:600 12px/1.5 system-ui;pointer-events:none;opacity:0;transition:opacity .15s;white-space:nowrap;transform:translate(-50%,-130%)'
  document.body.appendChild(wheelBadge)
  var wheelBadgeTimer = 0
  function showWheelBadge(text, x, y) {
    wheelBadge.textContent = text
    wheelBadge.style.left = Math.round(x) + 'px'
    wheelBadge.style.top = Math.round(y) + 'px'
    wheelBadge.style.opacity = '1'
    clearTimeout(wheelBadgeTimer)
    wheelBadgeTimer = setTimeout(function () { wheelBadge.style.opacity = '0' }, 900)
  }
  var DISPLAY_MODES = ['balance', 'clock', 'both']
  function cycleDisplayMode(dir) {
    var i = DISPLAY_MODES.indexOf(state.displayMode)
    if (i < 0) i = DISPLAY_MODES.length - 1
    i = (i + (dir < 0 ? -1 : 1) + DISPLAY_MODES.length) % DISPLAY_MODES.length
    state.displayMode = DISPLAY_MODES[i]
    saveOptions()
    lastClockSec = -1
    updateTablet()
    var p = pat.pointer
    showWheelBadge(
      state.displayMode === 'balance' ? '显示余额' : state.displayMode === 'clock' ? '显示峰谷时钟' : '余额 + 倒计时',
      p ? p.x : state.left + state.size / 2,
      p ? p.y : state.top + state.size * 0.35,
    )
  }
  function zoomBy(factor) {
    var next = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(state.size * factor)))
    if (next === state.size) return
    setSize(next)
    var p = pat.pointer
    showWheelBadge(state.size + 'px', p ? p.x : state.left + state.size / 2, p ? p.y : state.top + state.size * 0.35)
  }
  function onWheel(e) {
    if (settings.open || state.menuOpen) return
    if (onTablet(e.clientX, e.clientY)) {
      e.preventDefault()
      cycleDisplayMode(e.deltaY < 0 ? 1 : -1)
      return
    }
    if (isHit(e)) {
      e.preventDefault()
      zoomBy(e.deltaY < 0 ? 1.05 : 0.952)
    }
  }
  window.addEventListener('pointerdown', onDown, true)
  document.addEventListener('mousedown', blockPageGesture, true)
  document.addEventListener('click', blockPageGesture, true)
  document.addEventListener('dblclick', blockPageGesture, true)
  document.addEventListener('pointermove', onCursor, true)
  document.addEventListener('contextmenu', onContextMenu, true)
  document.addEventListener('dragstart', onDragStart, true)
  document.addEventListener('wheel', onWheel, { passive: false, capture: true })
  window.addEventListener('resize', onResize)

  // ---------------------------------------------------------------- menu ----
  var btnOnSolid = false
  var btnHideTimer = null
  function keepBtn() {
    if (btnHideTimer) { clearTimeout(btnHideTimer); btnHideTimer = null }
    btn.classList.add('dshvk1-btn-on')
  }
  function releaseBtn() {
    if (btnHideTimer) clearTimeout(btnHideTimer)
    btnHideTimer = setTimeout(function () {
      btnHideTimer = null
      if (!state.menuOpen) { btn.classList.remove('dshvk1-btn-on'); btnOnSolid = false }
    }, BTN_GRACE_MS)
  }
  function menuRow(text, onClick) {
    var b = document.createElement('button')
    b.type = 'button'
    b.className = 'dshvk1-menu-row'
    b.textContent = text
    b.addEventListener('click', function (e) { e.stopPropagation(); closeMenu(); onClick() })
    menu.appendChild(b)
  }
  function buildMenu() {
    menu.textContent = ''
    if (updateStatus && updateStatus.available) menuRow('发现新版本 ' + updateStatus.latestVersion, function () { window.open(updateStatus.url, '_blank', 'noopener,noreferrer') })
    menuRow('立即刷新余额', function () { poll(true) })
    menuRow('隐藏挂件', function () { if (window.__xykpVk1Hide) window.__xykpVk1Hide() })
    menuRow('演示', function () { showSettings('anim') })
    menuRow('设置', function () { showSettings('display') })
    menuRow('切换显示方式', function () { cycleDisplayMode(1); closeMenu() })

  }
  function openMenu(clientX, clientY) {
    buildMenu()
    state.menuOpen = true
    menu.classList.add('dshvk1-menu-open')
    keepBtn()
    var mw = menu.offsetWidth || 220
    var mh = menu.offsetHeight || 300
    var vp = viewport()
    menu.style.left = clamp(clientX, 4, Math.max(4, vp.w - mw - 4)) + 'px'
    menu.style.top = clamp(clientY, 4, Math.max(4, vp.h - mh - 4)) + 'px'
  }
  function closeMenu() {
    state.menuOpen = false
    menu.classList.remove('dshvk1-menu-open')
    releaseBtn()
  }
  btn.addEventListener('click', function (e) {
    e.stopPropagation()
    showSettings('display')
  })
  btn.addEventListener('pointerenter', function () { btnOnSolid = true; keepBtn() })
  btn.addEventListener('pointerleave', function () { if (!state.menuOpen) { btnOnSolid = false; releaseBtn() } })
  function onDocMenuClose(e) {
    if (!state.menuOpen) return
    if (e.target && e.target.closest && (e.target.closest('.dshvk1-menu') || e.target.closest('.dshvk1-btn') || e.target.closest('.dshvk1-dialog'))) return
    closeMenu()
  }
  document.addEventListener('pointerdown', onDocMenuClose, true)

  // ------------------------------------------------------------ size & gap ---
  function setSize(v) {
    state.size = clamp(Math.round(v) || DEFAULT_SIZE, MIN_SIZE, MAX_SIZE)
    try { localStorage.setItem(SIZE_KEY, String(state.size)) } catch (err) {}
    riceSizeCache = null
    for (var i = 0; i < state.bowls.length; i++) {
      var b = state.bowls[i]
      var s = b.iron ? (b.onHead ? ironWornSize() : ironLooseSize()) : riceDims()
      b.artW = s.w; b.artH = s.h; b.R = s.w * 0.42
      b.el.style.width = s.w + 'px'
      b.el.style.height = s.h + 'px'
    }
    layout()
    settle()
    saveAnchor()
  }
  function setSnapPct(v) {
    state.snapRatio = Math.max(0, Math.min(50, Math.round(Number(v) || 0))) / 100
    saveGap()
  }
  function saveGap() {
    try { localStorage.setItem(GAP_KEY, JSON.stringify({ on: state.scrollGapOn, px: state.scrollGapPx, snap: state.snapRatio })) } catch (err) {}
  }
  function setScrollGapOn(on) { state.scrollGapOn = !!on; saveGap(); settle(); saveAnchor() }
  function setScrollGapPx(v) {
    if (!state.scrollGapOn) return
    state.scrollGapPx = Math.max(0, Math.round(Number(v) || 0))
    saveGap(); settle(); saveAnchor()
  }
  function saveSound() {
    try { localStorage.setItem(SOUND_KEY, JSON.stringify({ on: state.soundOn, vol: state.volume })) } catch (err) {}
  }

  // Modernized upstream 571da3b (2026-10-15): hover strokes, usage and tablet clock.
  var pat = { active: false, t: 0, distance: 0, moveTime: 0, idle: 0, blocked: 0, pointer: null, previous: null, waiting: false }
  var hands = []
  for (var hi = 0; hi < 5; hi++) {
    var hand = document.createElement('img')
    hand.src = __xykpVk1Assets['pat_hand_' + hi]
    hand.alt = ''
    hand.draggable = false
    hand.style.cssText = 'position:absolute;pointer-events:none;display:none;transform-origin:0 0'
    root.appendChild(hand)
    hands.push(hand)
  }
  function blockPat() {
    pat.active = false; pat.waiting = false; pat.t = 0
    pat.distance = 0; pat.moveTime = 0; pat.blocked = 1.16
    hands.forEach(function (h) { h.style.display = 'none' })
  }
  function pointerLeft() { pat.pointer = null }
  document.addEventListener('pointerleave', pointerLeft)
  window.addEventListener('blur', pointerLeft)
  function updatePat(dt) {
    var p = pat.pointer
    var onHer = p && charHitAt(p.x, p.y)
    var can = onHer && !p.buttons && !state.menuOpen && !settings.open && !state.dragWidget && !state.grab && state.fxPat
    var distance = p && pat.previous ? Math.hypot(p.x - pat.previous.x, p.y - pat.previous.y) : 0
    if (distance > 120) distance = 0
    pat.previous = p ? { x: p.x, y: p.y } : null
    if (state.dragWidget || state.grab || (p && p.buttons)) pat.blocked = 1.16
    else pat.blocked = Math.max(0, pat.blocked - dt)
    if (!can || pat.blocked > 0) {
      pat.distance = 0; pat.moveTime = 0
      if (!state.fxPat || pat.blocked > 0 || state.menuOpen || settings.open) pat.active = false
    }
    if (pat.waiting) {
      if (!can) pat.waiting = false
      else if (!state.bowls.some(function (b) { return b.onHead })) { pat.waiting = false; pat.active = true; pat.t = 0 }
      else if (!state.bowls.some(function (b) { return b.onHead && b.fadeT > 0 })) knockPotOff()
    }
    if (can && pat.blocked <= 0 && distance > 0) {
      pat.idle = 0
      pat.distance = Math.min(96, pat.distance + distance)
      if (pat.distance >= 24) pat.moveTime += dt
      if (!pat.active && !pat.waiting && pat.moveTime >= 0.5) {
        if (state.bowls.some(function (b) { return b.onHead })) { knockPotOff(); pat.waiting = true }
        else { pat.active = true; pat.t = 0 }
      }
    } else {
      pat.idle += dt
      if (!pat.active && pat.idle >= 0.15) { pat.distance = 0; pat.moveTime = 0 }
      if (pat.idle >= 0.15) { pat.active = false; pat.distance = 0; pat.moveTime = 0 }
    }
    if (pat.active) pat.t += dt
    var frameIndex = Math.floor(pat.t / 0.04) % 5
    hands.forEach(function (h, i) {
      h.style.display = pat.active && i === frameIndex ? 'block' : 'none'
    })
    if (!pat.active) return
    // Same measured palm anchors as PatGeometry; reflect the whole rectangle on the right.
    var k = state.size / 454
    var w = 446 * k, h = 392 * k
    var palmX = [0.319, 0.356, 0.318, 0.425, 0.298][frameIndex] + 0.393
    var palmY = [0.511, 0.720, 0.835, 0.744, 0.608][frameIndex] - 0.206
    var x = state.size * 0.67 - palmX * w
    if (mirrored()) x = state.size - x - w
    var y = 40 * (446 / 107) * k - palmY * h
    hands[frameIndex].style.width = w + 'px'
    hands[frameIndex].style.height = h + 'px'
    hands[frameIndex].style.left = x + 'px'
    hands[frameIndex].style.top = y + 'px'
    hands[frameIndex].style.transform = mirrored() ? 'scaleX(-1) translateX(-100%)' : ''
  }

  var clockEl = document.createElement('div')
  clockEl.style.cssText = 'position:absolute;inset:5% 0;display:none;flex-direction:column;justify-content:space-evenly;align-items:center;color:#ecf2fc;font-weight:bold;white-space:nowrap;font-size:calc(var(--dshvk1-ph) * .19)'
  var clockLines = [document.createElement('div'), document.createElement('div'), document.createElement('div')]
  clockLines.forEach(function (line) { clockEl.appendChild(line) })
  panel.appendChild(clockEl)
  function usageDay() {
    var d = new Date()
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
  }
  function saveUsage() { try { localStorage.setItem(USAGE_KEY, JSON.stringify(state.usage)) } catch (e) {} }
  function noteUsage(balance) {
    var u = state.usage
    if (!u || u.day !== usageDay() || !isFinite(u.base)) u = { day: usageDay(), base: balance, topup: 0, last: balance, used: 0 }
    else {
      if (balance > u.last) u.topup = round4(u.topup + balance - u.last)
      u.used = Math.max(0, round4(u.base + u.topup - balance))
      u.last = balance
    }
    state.usage = u
    saveUsage()
  }
  function onTablet(x, y) {
    var q = quad().P
    var lx = x - state.left, ly = y - state.top
    if (mirrored()) lx = state.size - lx
    var ax = q[1].x - q[0].x, ay = q[1].y - q[0].y
    var bx = q[3].x - q[0].x, by = q[3].y - q[0].y
    var det = ax * by - ay * bx
    var u = ((lx - q[0].x) * by - (ly - q[0].y) * bx) / det
    var v = (ax * (ly - q[0].y) - ay * (lx - q[0].x)) / det
    return u >= 0 && u <= 1 && v >= 0 && v <= 1
  }
  var lastClockSec = -1
  function updateTablet() {
    if (!clockEl) return
    var mode = state.displayMode || 'both'
    var showClock = mode === 'clock'
    labelEl.style.display = mode === 'balance' ? '' : 'none'
    amountEl.style.display = showClock ? 'none' : ''
    clockEl.style.display = showClock ? 'flex' : 'none'
    countdownEl.style.display = mode === 'both' ? 'flex' : 'none'
    if (mode === 'balance') {
      panel.title = ''
      return
    }
    var nowMs = Date.now() + state.cloudOffset
    var bj = new Date(nowMs + 8 * 3600000)
    var peak = __xykpVk1Peak.info(nowMs)
    function pad(n) { return String(n).padStart(2, '0') }
    var left = Math.max(0, Math.round(peak.left / 1000))
    var countdown = (peak.off ? '距峰时 ' : '距谷时 ') + Math.floor(left / 3600) + ':' + pad(Math.floor(left / 60) % 60) + ':' + pad(left % 60)
    var color = peak.off ? '#96e2aa' : '#f0be78'
    panel.title = '北京时间；周一至周五 09:00–12:00、14:00–18:00 峰时，其余时间（含周末和法定节假日）谷时，谷时价 = 峰时价的一半'
    if (showClock) {
      clockLines[0].textContent = pad(bj.getUTCHours()) + ':' + pad(bj.getUTCMinutes()) + ':' + pad(bj.getUTCSeconds())
      clockLines[1].textContent = peak.off ? '谷时 5折' : '峰时'
      clockLines[1].style.color = color
      clockLines[2].textContent = countdown
    } else {
      countdownEl.textContent = countdown
      countdownEl.style.color = color
    }
  }
  function tickTablet(dt) {
    if ((state.displayMode || 'both') === 'balance') return
    var sec = Math.floor(Date.now() / 1000)
    if (sec === lastClockSec) return
    lastClockSec = sec
    updateTablet()
  }
  function saveOptions() {
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify({
        fxBowl: state.fxBowl,
        fxPat: state.fxPat,
        fxHurt: state.fxHurt,
        theme: state.theme,
        cueVolumes: state.cueVolumes,
        displayMode: state.displayMode,
        pollSeconds: state.pollSeconds,
        yieldOn: state.yieldOn,
        yieldOpacity: state.yieldOpacity,
      }))
    } catch (e) {}
    applyYieldPrefs()
  }
  function applyYieldPrefs() {
    try {
      if (window.__xykpVk1Yield && typeof window.__xykpVk1Yield.set === 'function') {
        window.__xykpVk1Yield.set(state.yieldOn !== false, Number(state.yieldOpacity) / 100)
      }
    } catch (e) {}
  }

  // Four-page settings surface. All placement follows grid/flex layout, including narrow viewports.
  styleEl.textContent += '\n' + [
    '.dshvk1-dialog{--vk-bg:#fff;--vk-ink:#203052;--vk-muted:#65718b;--vk-border:#d9deea;--vk-card:#f2f5fa;--vk-accent:#3c5ddb;background:var(--vk-bg);color:var(--vk-ink);border:1px solid var(--vk-border);border-radius:16px;padding:0;width:min(650px,calc(100vw - 24px));max-height:calc(100dvh - 48px);box-sizing:border-box;box-shadow:0 18px 70px #0005;font:14px/1.5 system-ui,sans-serif}',
    '.dshvk1-dialog::backdrop{background:#0005}',
    '.dshvk1-dialog[data-theme=dark]{--vk-bg:#171e2d;--vk-ink:#edf2ff;--vk-muted:#a3b0ca;--vk-border:#3b4861;--vk-card:#232e43;--vk-accent:#9eb7ff;color-scheme:dark}',
    '@media(prefers-color-scheme:dark){.dshvk1-dialog[data-theme=auto]{--vk-bg:#171e2d;--vk-ink:#edf2ff;--vk-muted:#a3b0ca;--vk-border:#3b4861;--vk-card:#232e43;--vk-accent:#9eb7ff;color-scheme:dark}}',
    '.dshvk1-dialog header{position:sticky;top:0;z-index:2;background:var(--vk-bg);display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--vk-border)}',
    '.dshvk1-dialog h2{margin:0;font-size:18px}.dshvk1-dialog h3{margin:12px 0 8px;font-size:14px}',
    '.dshvk1-tabs{display:flex;flex-wrap:wrap;gap:6px;padding:12px 20px;border-bottom:1px solid var(--vk-border)}',
    '.dshvk1-dialog button,.dshvk1-dialog select,.dshvk1-dialog input{font:inherit;color:inherit;box-sizing:border-box}',
    '.dshvk1-dialog button,.dshvk1-dialog select{background:var(--vk-card);border:1px solid var(--vk-border);border-radius:8px;padding:7px 11px;cursor:pointer}',
    '.dshvk1-dialog button[aria-selected=true]{color:var(--vk-accent);border-color:var(--vk-accent);font-weight:700}',
    '.dshvk1-dialog button:focus-visible,.dshvk1-dialog input:focus-visible,.dshvk1-dialog select:focus-visible{outline:2px solid var(--vk-accent);outline-offset:2px}',
    '.dshvk1-dialog button:disabled{opacity:.5;cursor:default}.dshvk1-content{padding:4px 20px 20px;overflow-wrap:anywhere;max-height:calc(100dvh - 214px);overflow-y:auto;overscroll-behavior:contain}',
    '.dshvk1-subtitle{font-weight:700;margin:10px 0 2px;color:var(--vk-ink)}',
    '.dshvk1-setting{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:10px 0;border-bottom:1px solid var(--vk-border)}',
    '.dshvk1-setting label{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.dshvk1-setting input[type=number]{width:90px;padding:5px;background:var(--vk-card);border:1px solid var(--vk-border);border-radius:6px}',
    '.dshvk1-actions{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.dshvk1-hint{color:var(--vk-muted);font-size:12px}.dshvk1-status{min-height:1.5em;margin:8px 0;color:var(--vk-accent)}',
    '.dshvk1-clip{border:1px solid var(--vk-border);border-radius:10px;padding:12px;margin:10px 0}.dshvk1-dialog input[type=text]{max-width:100%;width:100%;padding:6px;background:var(--vk-card);border:1px solid var(--vk-border);border-radius:6px}',
    '.dshvk1-wave{display:block;width:100%;height:84px;background:var(--vk-card);border-radius:6px;margin:8px 0}',
    '.dshvk1-switch{appearance:none;-webkit-appearance:none;flex:none;width:40px;height:22px;border-radius:999px;background:var(--vk-border);position:relative;cursor:pointer;transition:background .16s ease;margin:0}',
    '.dshvk1-switch:checked{background:var(--vk-accent)}',
    '.dshvk1-switch::after{content:"";position:absolute;left:2px;top:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0003;transition:transform .16s ease}',
    '.dshvk1-switch:checked::after{transform:translateX(18px)}',
    '.dshvk1-radio{appearance:none;-webkit-appearance:none;flex:none;width:18px;height:18px;border-radius:50%;border:1.5px solid var(--vk-border);background:transparent;position:relative;cursor:pointer;margin:0}',
    '.dshvk1-radio:checked{border-color:var(--vk-accent)}',
    '.dshvk1-radio:checked::after{content:"";position:absolute;inset:3px;border-radius:50%;background:var(--vk-accent)}',
    '.dshvk1-choice label{display:flex;align-items:center;gap:10px;cursor:pointer}',
    '.dshvk1-choices .dshvk1-setting{justify-content:flex-start}',
    '.dshvk1-cue .dshvk1-cue-name{min-width:96px;font-weight:600}',
    '.dshvk1-cue label{flex:1;justify-content:flex-end}',
    '.dshvk1-cue label input[type=range]{max-width:110px}',
    '.dshvk1-stat{font-size:26px;font-weight:800;color:var(--vk-accent);margin:2px 0 4px}',
    '@media(max-width:420px){.dshvk1-dialog header,.dshvk1-tabs{padding:12px}.dshvk1-content{padding:4px 12px 12px}.dshvk1-setting{align-items:flex-start}.dshvk1-dialog input[type=range]{max-width:145px}}'
  ].join('\n')
  var settings = document.createElement('dialog')
  settings.className = 'dshvk1-dialog'
  settings.setAttribute('aria-labelledby', 'dshvk1-settings-title')
  var settingsHeader = document.createElement('header')
  var settingsTitle = document.createElement('h2')
  settingsTitle.id = 'dshvk1-settings-title'
  settingsTitle.textContent = '设置'
  settingsHeader.appendChild(settingsTitle)
  var closeSettings = document.createElement('button')
  closeSettings.textContent = '关闭'
  closeSettings.addEventListener('click', function () { settings.close(); stopPreview() })
  settingsHeader.appendChild(closeSettings)
  settings.appendChild(settingsHeader)
  var tabs = document.createElement('nav')
  tabs.className = 'dshvk1-tabs'
  tabs.setAttribute('aria-label', '设置分类')
  settings.appendChild(tabs)
  var content = document.createElement('div')
  content.className = 'dshvk1-content'
  settings.appendChild(content)
  document.body.appendChild(settings)
  var settingsPage = 'display'
  var libraryCue = 0
  var renderGeneration = 0
  function element(tag, text, parent, className) {
    var el = document.createElement(tag)
    if (text != null) el.textContent = text
    if (className) el.className = className
    if (parent) parent.appendChild(el)
    return el
  }
  function action(parent, text, fn) {
    var b = element('button', text, parent)
    b.type = 'button'; b.addEventListener('click', fn)
    return b
  }
  function hint(text, parent) { return element('p', text, parent || content, 'dshvk1-hint') }
  function toggle(text, checked, fn, parent) {
    var row = element('div', null, parent || content, 'dshvk1-setting')
    var label = element('label', null, row)
    var input = element('input', null, label)
    input.type = 'checkbox'; input.checked = checked; input.className = 'dshvk1-switch'
    element('span', text, label)
    input.addEventListener('change', function () { fn(input.checked) })
    return row
  }
  function choice(text, checked, onSelect) {
    var row = element('div', null, content, 'dshvk1-setting dshvk1-choice')
    var label = element('label', null, row)
    var input = element('input', null, label)
    input.type = 'radio'; input.name = 'dshvk1-display-mode'; input.checked = checked; input.className = 'dshvk1-radio'
    element('span', text, label)
    input.addEventListener('change', function () { if (input.checked) onSelect() })
    return input
  }
  function numeric(parent, text, value, min, max, step, fn, type) {
    var label = element('label', text, parent)
    var input = element('input', null, label)
    input.type = type || 'number'; input.min = min; input.max = max; input.step = step; input.value = value
    var output = type === 'range' ? element('span', value + '%', label) : null
    input.addEventListener('input', function () {
      if (input.value === '' || !input.validity.valid) return
      var v = Number(input.value)
      if (!isFinite(v) || v < min || v > max) return
      if (output) output.textContent = v + '%'
      fn(v)
    })
    return input
  }
  function onEscape(e) {
    if (e.key === 'Escape') { closeMenu(); if (settings.open) { settings.close(); stopPreview(); e.stopPropagation() } }
  }
  document.addEventListener('keydown', onEscape, true)
  settings.addEventListener('cancel', stopPreview)
  settings.addEventListener('close', stopPreview)
  function showSettings(page) {
    blockPat(); closeMenu()
    settingsPage = page || 'display'
    renderSettings()
    if (!settings.open) settings.showModal()
  }
  function renderSettings() {
    renderGeneration++
    settings.dataset.theme = state.theme
    tabs.textContent = ''; content.textContent = ''
    ;[['display', '显示'], ['anim', '动画'], ['sound', '声音']].forEach(function (tab) {
      var b = action(tabs, tab[1], function () { stopPreview(); settingsPage = tab[0]; renderSettings() })
      b.setAttribute('aria-selected', String(settingsPage === tab[0]))
    })
    if (settingsPage === 'display') {
      element('h3', '主题', content)
      var themes = element('div', null, content, 'dshvk1-actions')
      ;[['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].forEach(function (t) {
        var b = action(themes, t[1], function () { state.theme = t[0]; saveOptions(); renderSettings() })
        b.setAttribute('aria-selected', String(state.theme === t[0]))
      })
      hint('“跟随系统”会跟随 DSH / 操作系统的深浅色。')

      element('h3', '文本显示', content)
      ;[['balance', '显示余额'], ['clock', '显示峰谷时钟'], ['both', '显示余额和时钟']].forEach(function (m) {
        choice(m[1], state.displayMode === m[0], function () {
          state.displayMode = m[0]
          saveOptions()
          lastClockSec = -1
          updateTablet()
          renderSettings()
        })
      })
      hint('默认“显示余额和时钟”：上面是倒计时，峰时橙色、谷时绿色。滚轮在平板上切换显示方式。')

      element('h3', '余额刷新', content)
      numeric(element('div', null, content, 'dshvk1-setting'), '刷新间隔（秒）', state.pollSeconds, 2, 300, 1, function (v) {
        state.pollSeconds = v
        saveOptions()
        restartPoll()
      })
      hint('页面每隔这么久刷新一次余额；双击平板可立即刷新。')

      element('h3', '图形尺寸', content)
      var sizes = element('div', null, content, 'dshvk1-actions')
      SIZES.forEach(function (s) { action(sizes, s + 'px', function () { setSize(s); renderSettings() }) })
      numeric(element('div', null, content, 'dshvk1-setting'), '自定义尺寸（px）', state.size, MIN_SIZE, MAX_SIZE, 1, setSize)
      numeric(element('div', null, content, 'dshvk1-setting'), '缩放系数', Math.round(state.size / DEFAULT_SIZE * 100), 30, 200, 1, function (v) {
        setSize(Math.round(DEFAULT_SIZE * v / 100))
      }, 'range')
      hint('滚轮在角色身上直接缩放大小；在平板上切换显示方式。')

      element('h3', '虚化设置', content)
      toggle('靠近输入区时虚化', state.yieldOn, function (v) { state.yieldOn = v; saveOptions(); renderSettings() })
      numeric(element('div', null, content, 'dshvk1-setting'), '虚化程度', state.yieldOpacity, 0, 100, 1, function (v) { state.yieldOpacity = v; saveOptions() }, 'range')
      element('div', '避让条', content, 'dshvk1-subtitle')
      toggle('避让滚动条', state.scrollGapOn, setScrollGapOn)
      numeric(element('div', null, content, 'dshvk1-setting'), '避让宽度（px）', state.scrollGapPx, 0, 100, 1, setScrollGapPx)
      hint('虚化只影响鼠标靠近输入框/发送按钮时的透明度；避让条是右侧滚动条的留白。')

      element('h3', '贴边', content)
      numeric(element('div', null, content, 'dshvk1-setting'), '边缘吸附范围（视口百分比）', Math.round(state.snapRatio * 100), 0, 50, 1, setSnapPct, 'range')
      hint('挂件中心落在离边缘该比例的区域里松手才吸附；25% 即原来的 1/4 判定，0 表示不吸附。')

      element('h3', '数据统计', content)
      element('div', '今日余额', content, 'dshvk1-subtitle')
      element('div', isFinite(state.real) ? '¥' + fmt2(state.real) : '--', content, 'dshvk1-stat')
      var used = state.usage && state.usage.day === usageDay() ? state.usage.used : 0
      var topup = state.usage && state.usage.day === usageDay() ? state.usage.topup : 0
      hint('今日已用 ¥' + fmt2(used) + ' · 今日充值 ¥' + fmt2(topup))
      numeric(element('div', null, content, 'dshvk1-setting'), '校准今日已用（元）', used, 0, 1000000, 0.0001, function (v) {
        if (!isFinite(state.real)) return
        state.usage = { day: usageDay(), base: round4(state.real + v), topup: 0, last: state.real, used: v }
        saveUsage()
      }).disabled = !isFinite(state.real)
      hint('根据观察到的余额变化估算，充值和演示不计入消费。')

      element('h3', '挂件', content)
      action(content, '隐藏挂件', function () {
        if (window.__xykpVk1Hide) window.__xykpVk1Hide()
        settings.close()
      })
      hint('隐藏后右下角留一个 VK 圆钮，点一下恢复。')
    } else if (settingsPage === 'anim') {
      element('h3', '动画选项', content)
      var bowlRow = toggle('充值后掉落饭盆', state.fxBowl, function (v) { state.fxBowl = v; saveOptions() }, content)
      action(bowlRow, '演示', function () { startCredit(3, true); settings.close() })
      var hurtRow = toggle('扣费动画', state.fxHurt, function (v) { state.fxHurt = v; saveOptions() }, content)
      action(hurtRow, '单次扣费', function () { makeTick(STEP, true); updateScreen() })
      action(hurtRow, '十次扣费', function () { state.demoAmount = STEP; state.demoLeft = 10 })
      var count = 10, amount = 3
      numeric(element('div', null, content, 'dshvk1-setting'), '自定义扣费次数', count, 1, 10000, 1, function (v) { count = v })
      action(content, '演示自定义扣费', function () { state.demoAmount = STEP; state.demoLeft = count })
      numeric(element('div', null, content, 'dshvk1-setting'), '自定义充值金额（元）', amount, 0.01, 1000000, 0.01, function (v) { amount = v })
      action(content, '演示自定义充值', function () { startCredit(amount, true); settings.close() })
      var patRow = toggle('鼠标抚摸', state.fxPat, function (v) { state.fxPat = v; saveOptions(); if (!v) blockPat() }, content)
      action(patRow, '演示', function () {
        blockPat()
        if (!state.bowls.some(function (b) { return b.onHead })) { pat.active = true; pat.t = 0; pat.blocked = 0; pat.waiting = false }
        settings.close()
      })
      action(content, '打开火控雷达', function () { state.radarManual = true; settings.close() })
      hint('演示只在本地播放，不会实际扣费或充值。')
    } else if (settingsPage === 'sound') {
      toggle('开启声音', state.soundOn, function (on) { state.soundOn = on; saveSound(); if (!on) stopPlaying() })
      numeric(element('div', null, content, 'dshvk1-setting'), '总音量', state.volume, 0, 100, 1, function (v) { state.volume = v; saveSound() }, 'range')
      CUE_NAMES.forEach(function (name, i) {
        var row = element('div', null, content, 'dshvk1-setting dshvk1-cue')
        element('span', name, row, 'dshvk1-cue-name')
        action(row, '试听', function () { playPool(cuePools[i]) })
        numeric(row, '音量', state.cueVolumes[i], 0, 100, 1, function (v) { state.cueVolumes[i] = v; saveOptions() }, 'range')
        action(row, '恢复默认', function () {
          state.cueVolumes[i] = 100
          activateClip(i, '', true)
          saveOptions()
          renderSettings()
        })
      })
      hint('总音量 × 分项音量；调到 0% 单独静音。')
      element('h3', '自定义音效', content)
      renderLibrary()
    }
  }

  var CUE_NAMES = ['掉血音效', '回血音效', '铁盆落头音效', '双击取盆音效']
  var DEFAULT_SOUNDS = [HIT_SOUND, FEED_SOUND, __xykpVk1Assets.pot_land, __xykpVk1Assets.pot_off]
  var soundDb = null, audioContext = null, previewAudio = null, previewUrl = null
  var clips = [], activeClips = {}, libraryStatus = ''
  function stopPool(pool) {
    pool.pool.forEach(function (a) { clearTimeout(a.trimTimer); a.pause(); a.removeAttribute('src'); a.load() })
    if (pool.url) URL.revokeObjectURL(pool.url)
  }
  function stopPlaying() {
    cuePools.forEach(function (p) { p.pool.forEach(function (a) { clearTimeout(a.trimTimer); a.pause() }) })
    stopPreview()
  }
  function stopPreview() {
    if (previewAudio) { previewAudio.pause(); previewAudio.removeAttribute('src'); previewAudio.load(); previewAudio = null }
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null }
  }
  function stopAudio() {
    stopPreview(); cuePools.forEach(stopPool)
    if (audioContext) audioContext.close().catch(function () {})
  }
  function activateClip(cue, id, persist) {
    var clip = clips.find(function (c) { return c.id === id && c.cue === cue })
    stopPool(cuePools[cue])
    var url = clip ? URL.createObjectURL(clip.rendered) : DEFAULT_SOUNDS[cue]
    var p = makePool(url, cue === 0 ? 4 : 2)
    p.cue = cue; if (clip) p.url = url
    cuePools[cue] = p
    hitPool = cuePools[0]; feedPool = cuePools[1]; landPool = cuePools[2]; offPool = cuePools[3]
    activeClips[cue] = clip ? clip.id : ''
    if (persist) try { localStorage.setItem('dsh-vk1-active-clips', JSON.stringify(activeClips)) } catch (e) {}
  }
  function dbChange(mode, value) {
    return new Promise(function (resolve, reject) {
      if (!soundDb) return reject(new Error('浏览器音效存储不可用'))
      var tx = soundDb.transaction('clips', 'readwrite')
      var store = tx.objectStore('clips')
      if (mode === 'put') store.put(value)
      else store.delete(value)
      tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error || new Error('音效保存失败')) }
      tx.onabort = function () { reject(tx.error || new Error('音效保存中止')) }
    })
  }
  function initSoundLibrary() {
    try {
      activeClips = JSON.parse(localStorage.getItem('dsh-vk1-active-clips') || '{}') || {}
      var request = indexedDB.open('dsh-vk1-sounds', 1)
      request.onupgradeneeded = function () { request.result.createObjectStore('clips', { keyPath: 'id' }) }
      request.onerror = function () { libraryStatus = '浏览器音效存储不可用，仍可使用出厂音效。' }
      request.onsuccess = function () {
        if (stopped) { request.result.close(); return }
        soundDb = request.result
        soundDb.onversionchange = function () { soundDb.close(); soundDb = null }
        var get = soundDb.transaction('clips', 'readonly').objectStore('clips').getAll()
        get.onsuccess = function () {
          if (stopped) return
          clips = get.result
          CUE_NAMES.forEach(function (_, i) { activateClip(i, activeClips[i], false) })
          if (settings.open && settingsPage === 'sound') renderSettings()
        }
      }
    } catch (e) { libraryStatus = '浏览器音效存储不可用，仍可使用出厂音效。' }
  }
  async function decodeSound(blob) {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)()
    return audioContext.decodeAudioData(await blob.arrayBuffer())
  }
  function wavBlob(buffer, start, end, gain) {
    var first = Math.floor(start * buffer.sampleRate)
    var lastFrame = Math.min(buffer.length, Math.floor(end * buffer.sampleRate))
    var count = lastFrame - first, channels = Math.min(2, buffer.numberOfChannels)
    if (count <= 0) throw new Error('终点必须大于起点')
    var data = new ArrayBuffer(44 + count * channels * 2), view = new DataView(data)
    function chars(offset, s) { for (var i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)) }
    chars(0, 'RIFF'); view.setUint32(4, data.byteLength - 8, true); chars(8, 'WAVEfmt ')
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true)
    view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * channels * 2, true)
    view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); chars(36, 'data')
    view.setUint32(40, count * channels * 2, true)
    for (var c = 0; c < channels; c++) {
      var samples = buffer.getChannelData(c)
      for (var f = 0; f < count; f++) {
        var sample = clamp(samples[first + f] * gain / 100, -1, 1)
        view.setInt16(44 + (f * channels + c) * 2, sample * (sample < 0 ? 32768 : 32767), true)
      }
    }
    return new Blob([data], { type: 'audio/wav' })
  }
  function renderLibrary() {
    hint('音频只保存在本浏览器，不上传服务器。支持浏览器能解码的 MP3 / WAV / M4A / AAC / FLAC / OGG 等，单文件最大 50 MB。')
    var select = element('select', null, content)
    select.setAttribute('aria-label', '选择音效类别')
    CUE_NAMES.forEach(function (name, i) { var o = element('option', name, select); o.value = i })
    select.value = libraryCue
    select.addEventListener('change', function () { libraryCue = Number(select.value); renderSettings() })
    var actions = element('div', null, content, 'dshvk1-actions')
    action(actions, '恢复出厂音效', function () { activateClip(libraryCue, '', true); renderSettings() })
    action(actions, '试听当前音效', function () { playPool(cuePools[libraryCue]) })
    var status = element('p', libraryStatus, content, 'dshvk1-status'); status.setAttribute('role', 'status')
    var file = element('input', null, content)
    file.type = 'file'; file.accept = '.mp3,.wav,.m4a,.wma,.aac,.flac,.ogg,audio/*'
    file.setAttribute('aria-label', '导入本地音效')
    file.disabled = !soundDb
    file.addEventListener('change', async function () {
      var selected = file.files[0], cue = libraryCue, generation = renderGeneration
      if (!selected) return
      if (selected.size > 50 * 1024 * 1024) { status.textContent = '文件过大，最大 50 MB。'; return }
      file.disabled = true; status.textContent = '正在解码音频…'
      try {
        var buffer = await decodeSound(selected)
        if (stopped || generation !== renderGeneration || !settings.open) return
        if (!isFinite(buffer.duration) || buffer.duration <= 0) throw new Error('音频为空')
        editClip({ id: crypto.randomUUID(), cue: cue, name: selected.name.replace(/\.[^.]+$/, '').slice(0, 80), source: selected, start: 0, end: buffer.duration, gain: 100 }, buffer)
      } catch (e) { if (!stopped && generation === renderGeneration) { status.textContent = '无法读取音频：' + e.message; file.disabled = !soundDb } }
    })
    hint('当前：' + ((clips.find(function (c) { return c.id === activeClips[libraryCue] }) || {}).name || '出厂音效'))
    clips.filter(function (c) { return c.cue === libraryCue }).forEach(function (clip) {
      var row = element('div', null, content, 'dshvk1-clip')
      element('strong', clip.name + (activeClips[libraryCue] === clip.id ? ' · 使用中' : ''), row)
      var buttons = element('div', null, row, 'dshvk1-actions')
      action(buttons, '使用', function () { activateClip(clip.cue, clip.id, true); renderSettings() })
      action(buttons, '修改', async function () {
        var generation = renderGeneration
        try { var buffer = await decodeSound(clip.source); if (!stopped && generation === renderGeneration && settings.open) editClip(Object.assign({}, clip), buffer) }
        catch (e) { if (!stopped) status.textContent = '无法读取音频：' + e.message }
      })
      action(buttons, '删除', async function () {
        try {
          await dbChange('delete', clip.id)
          if (stopped) return
          clips = clips.filter(function (c) { return c.id !== clip.id })
          if (activeClips[clip.cue] === clip.id) activateClip(clip.cue, '', true)
          renderSettings()
        } catch (e) { status.textContent = '删除失败：' + e.message }
      })
    })
  }
  function editClip(clip, buffer) {
    content.textContent = ''; renderGeneration++
    element('h3', '剪辑音效 · ' + CUE_NAMES[clip.cue], content)
    var nameLabel = element('label', '音效名称', content)
    var name = element('input', null, nameLabel); name.type = 'text'; name.maxLength = 80; name.value = clip.name
    var canvas = element('canvas', null, content, 'dshvk1-wave'); canvas.width = 560; canvas.height = 100
    canvas.setAttribute('aria-label', '音频波形及裁剪范围')
    function drawWave() {
      var ctx = canvas.getContext('2d'), samples = buffer.getChannelData(0)
      ctx.clearRect(0, 0, 560, 100); ctx.fillStyle = '#7a8fd1'
      for (var x = 0; x < 560; x++) {
        var first = Math.floor(x * samples.length / 560), last = Math.floor((x + 1) * samples.length / 560), peak = 0
        for (var i = first; i < last; i++) peak = Math.max(peak, Math.abs(samples[i]))
        ctx.fillRect(x, 50 - peak * 46, 1, Math.max(1, peak * 92))
      }
      ctx.fillStyle = '#355ce833'
      ctx.fillRect(560 * clip.start / buffer.duration, 0, 560 * (clip.end - clip.start) / buffer.duration, 100)
    }
    var fields = element('div', null, content, 'dshvk1-setting')
    numeric(fields, '起点（秒）', clip.start, 0, buffer.duration, 0.001, function (v) { clip.start = v; drawWave() })
    numeric(fields, '终点（秒）', clip.end, 0, buffer.duration, 0.001, function (v) { clip.end = v; drawWave() })
    numeric(element('div', null, content, 'dshvk1-setting'), '音量增益', clip.gain, 0, 200, 1, function (v) { clip.gain = v }, 'range')
    var status = element('p', '', content, 'dshvk1-status'); status.setAttribute('role', 'status')
    var buttons = element('div', null, content, 'dshvk1-actions')
    action(buttons, '试听剪辑', function () {
      try { stopPreview(); previewUrl = URL.createObjectURL(wavBlob(buffer, clip.start, clip.end, clip.gain)); previewAudio = new Audio(previewUrl); previewAudio.volume = state.soundOn ? state.volume / 100 * state.cueVolumes[clip.cue] / 100 : 0; previewAudio.play().catch(function () { status.textContent = '浏览器暂时阻止了播放，请再次点击试听。' }) }
      catch (e) { status.textContent = e.message }
    })
    var save = action(buttons, '保存并使用', async function () {
      try {
        save.disabled = true
        clip.name = name.value.trim() || '自定义音效'
        clip.rendered = wavBlob(buffer, clip.start, clip.end, clip.gain)
        await dbChange('put', clip)
        if (stopped) return
        clips = clips.filter(function (c) { return c.id !== clip.id }); clips.push(clip)
        activateClip(clip.cue, clip.id, true); stopPreview(); renderSettings()
      } catch (e) { status.textContent = '保存失败：' + e.message; save.disabled = false }
    })
    action(buttons, '取消', function () { stopPreview(); renderSettings() })
    drawWave()
  }

  var updateStatus = null, updateNotice = null, updateRetryTimer = null, updateBusy = false
  function showUpdateNotice(status) {
    if (updateNotice) detach(updateNotice)
    updateNotice = null
    if (!status.available) return
    try { if (localStorage.getItem('dsh-vk1-update-dismissed') === status.latestVersion) return } catch (e) {}
    updateNotice = document.createElement('aside')
    updateNotice.className = 'dshvk1-update'
    updateNotice.setAttribute('role', 'status')
    var text = document.createElement('p')
    text.textContent = 'VK-1 有新版本 ' + status.latestVersion + '（当前 ' + status.currentVersion + '）'
    updateNotice.appendChild(text)
    var actions = document.createElement('div')
    var link = document.createElement('a')
    link.textContent = '查看更新'; link.href = status.url; link.target = '_blank'; link.rel = 'noopener noreferrer'
    actions.appendChild(link)
    var dismiss = document.createElement('button')
    dismiss.textContent = '稍后'
    dismiss.addEventListener('click', function () {
      try { localStorage.setItem('dsh-vk1-update-dismissed', status.latestVersion) } catch (e) {}
      detach(updateNotice); updateNotice = null
    })
    actions.appendChild(dismiss); updateNotice.appendChild(actions)
    document.body.appendChild(updateNotice)
  }
  function refreshUpdateStatus() {
    return // 由 dsh-xykp 管理更新，页面挂件不查 GitHub
    if (stopped || updateBusy) return
    updateBusy = true
    fetch(BASE + '/update.json', { cache: 'no-store' }).then(function (r) { return r.json() }).then(function (status) {
      if (stopped || !status || !status.ok) return
      // Only links to the maintained repository are accepted from the local status route.
      status.url = 'https://github.com/YCTS-otree/VK-1'
      if (!updateStatus || updateStatus.latestVersion !== status.latestVersion || updateStatus.available !== status.available) showUpdateNotice(status)
      updateStatus = status
      if (status.checking) updateRetryTimer = setTimeout(refreshUpdateStatus, 3000)
    }).catch(function () {}).finally(function () { updateBusy = false })
  }

  // ----------------------------------------------------------------- start ---
  try {
    var savedSize = parseInt(localStorage.getItem(SIZE_KEY) || '', 10)
    if (isFinite(savedSize) && savedSize >= MIN_SIZE && savedSize <= MAX_SIZE) state.size = savedSize
    var g = JSON.parse(localStorage.getItem(GAP_KEY) || 'null')
    if (g) { state.scrollGapOn = !!g.on; state.scrollGapPx = typeof g.px === 'number' && g.px > 0 ? Math.round(g.px) : 0; if (typeof g.snap === 'number' && g.snap >= 0) state.snapRatio = Math.max(0, Math.min(0.5, g.snap)) }
    var s = JSON.parse(localStorage.getItem(SOUND_KEY) || 'null')
    if (s) {
      state.soundOn = s.on !== false
      state.volume = typeof s.vol === 'number' && s.vol >= 0 && s.vol <= 100 ? s.vol : 80
    }
    var options = JSON.parse(localStorage.getItem(OPTIONS_KEY) || 'null')
    if (options) {
      ;['fxBowl', 'fxPat', 'fxHurt'].forEach(function (key) { state[key] = options[key] !== false })
      if (['auto', 'light', 'dark'].indexOf(options.theme) >= 0) state.theme = options.theme
      if (Array.isArray(options.cueVolumes) && options.cueVolumes.length === 4) state.cueVolumes = options.cueVolumes.map(function (n) { return isFinite(n) ? clamp(Number(n), 0, 100) : 100 })
      if (['balance', 'clock', 'both'].indexOf(options.displayMode) >= 0) state.displayMode = options.displayMode
      if (isFinite(options.pollSeconds)) state.pollSeconds = clamp(Number(options.pollSeconds), 2, 300)
      if (typeof options.yieldOn === 'boolean') state.yieldOn = options.yieldOn
      if (isFinite(options.yieldOpacity)) state.yieldOpacity = clamp(Number(options.yieldOpacity), 0, 100)
    }
    var usage = JSON.parse(localStorage.getItem(USAGE_KEY) || 'null')
    if (usage && usage.day === usageDay() && [usage.base, usage.topup, usage.last, usage.used].every(function (n) { return typeof n === 'number' && isFinite(n) })) state.usage = usage
  } catch (err) {}

  applyYieldPrefs()
  layout()
  if (!applyAnchorPos()) { state.h = 'right'; state.v = 'bottom'; state.hOff = 0; state.vOff = 0; settle() }
  updateScreen()
  setupHitTest()
  initSoundLibrary()

  rafId = requestAnimationFrame(frame)
  poll(false)
  var pollTimer = setInterval(function () { poll(false) }, pollIntervalMs())
  refreshUpdateStatus()
  var updatePollTimer = setInterval(refreshUpdateStatus, 60000)

  // ------------------------------------------------- live mount/unmount hook ---
  // The appearance manager mounts this script when the bundle is enabled and asks
  // it to tear itself down (then removes the tag) when it is disabled — that is
  // what makes 切换外观 take effect without a page refresh.
  function detach(el) {
    try { if (el && el.parentNode) el.parentNode.removeChild(el) } catch (err) {}
  }
  function stop() {
    stopped = true
    try { cancelAnimationFrame(rafId) } catch (err) {}
    try { clearInterval(pollTimer) } catch (err) {}
    clearInterval(updatePollTimer); clearTimeout(updateRetryTimer)
    if (btnHideTimer) { clearTimeout(btnHideTimer); btnHideTimer = null }
    window.removeEventListener('pointerdown', onDown, true)
    document.removeEventListener('mousedown', blockPageGesture, true)
    document.removeEventListener('click', blockPageGesture, true)
    document.removeEventListener('dblclick', blockPageGesture, true)
    document.removeEventListener('pointermove', onCursor, true)
    document.removeEventListener('contextmenu', onContextMenu, true)
    document.removeEventListener('dragstart', onDragStart, true)
    document.removeEventListener('wheel', onWheel, { capture: true })
    document.removeEventListener('pointerdown', onDocMenuClose, true)
    document.removeEventListener('pointerleave', pointerLeft)
    document.removeEventListener('keydown', onEscape, true)
    window.removeEventListener('blur', pointerLeft)
    window.removeEventListener('error', onWidgetError)
    removeDragListeners()
    window.removeEventListener('resize', onResize)
    try { if (document.body) document.body.style.cursor = '' } catch (err) {}
    detach(styleEl)
    detach(stage)
    detach(root)
    detach(menu)
    detach(settings)
    detach(updateNotice)
    clearTimeout(wheelBadgeTimer)
    detach(wheelBadge)
    stopAudio()
    if (soundDb) soundDb.close()
    window.__dshVk1Widget = false
  }
  window.__dshAppearanceWidgets = window.__dshAppearanceWidgets || {}
  window.__dshAppearanceWidgets['dsh-vk1-balance-widget'] = { stop: stop }
})()

    }
// senses/balance-reporter · 页面侧（VK-1 余额挂件）
//
// 这个文件会被 build.mjs 拼进包根 client.js 的生成段里，和 vendored widget.js
// 一起组成「页面右下角的余额宠物」。
//
// 余额来源有两条，按优先级：
//   1. 宿主插件 /xykp/balance-reporter/status（缓存 + 历史；重启后才存在）
//   2. 客户端 ctx.remote.account.getBalance()（现在就能用）
// 两条都失败时挂件会显示断线红点，下一轮自动重试。

function installBalanceReporter(ctx) {
  var KEY = '__xykpBalanceReporter'
  var prev = window[KEY]
  if (prev && typeof prev.stop === 'function') {
    try { prev.stop() } catch (e) {}
  }

  var stopped = false
  var restoreBtn = null
  var routeState = 'unknown' // unknown | ok | missing
  var routeNextTry = 0

  function stopWidget() {
    try {
      var table = window.__dshAppearanceWidgets
      if (table && table['dsh-vk1-balance-widget'] && typeof table['dsh-vk1-balance-widget'].stop === 'function') {
        table['dsh-vk1-balance-widget'].stop()
      }
    } catch (e) {}
  }

  // 挂件是 pointer-events:none，鼠标移到它下面时 elementFromPoint 拿到的是真正的页面控件。
  // 底部（输入框 / 发送按钮 / 模型选择）一旦被指到，就让挂件淡出，别挡输入。
  var yieldStyle = document.createElement('style')
  yieldStyle.id = 'xykp-balance-pet-yield-style'
  var yieldOn = true
  var yieldOpacity = 0.07
  function yieldCss() {
    return (
      '.dshvk1-stage{transition:opacity .55s cubic-bezier(.22,.61,.36,1)!important}' +
      // 让挂件矩形本身接住 hover / pointermove，页面不会再在下面跟着交互；
      // 需要输入框时，.dshvk1-yield 会把 pointer-events 关掉，让页面接管。
      '.dshvk1-root{pointer-events:auto!important;transition:left .16s ease,top .16s ease,opacity .55s cubic-bezier(.22,.61,.36,1)!important}' +
      '.dshvk1-root.dshvk1-dragging{transition:none!important}' +
      '.dshvk1-yield{opacity:' + yieldOpacity + ' !important;pointer-events:none!important}'
    )
  }
  function applyYieldStyle() {
    yieldStyle.textContent = yieldCss()
  }
  applyYieldStyle()
  var staleStyle = document.getElementById('xykp-balance-pet-yield-style')
  if (staleStyle) staleStyle.remove()
  document.head.appendChild(yieldStyle)
  var yielding = false
  function setYield(on) {
    if (yielding === on) return
    yielding = on
    var stage = document.querySelector('.dshvk1-stage')
    var root = document.querySelector('.dshvk1-root')
    if (stage) stage.classList.toggle('dshvk1-yield', on)
    if (root) root.classList.toggle('dshvk1-yield', on)
  }
  function onPointerMove(e) {
    if (stopped) return
    if (!yieldOn) {
      setYield(false)
      return
    }
    // 挂件自己接住了 hover，所以用 elementsFromPoint 看它下面真正是什么。
    var stack = document.elementsFromPoint(e.clientX, e.clientY)
    var el = null
    for (var i = 0; i < stack.length; i++) {
      if (!stack[i].closest || !stack[i].closest('.dshvk1-root,.dshvk1-stage,.dshvk1-menu,.dshvk1-dialog')) {
        el = stack[i]
        break
      }
    }
    var interactive = !!(el && el.closest && el.closest('textarea,input,select,[contenteditable="true"],[role="textbox"]'))
    setYield(interactive)
  }
  function onBlurYield() { setYield(false) }
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('blur', onBlurYield, true)
  var yieldApi = {
    set: function (on, opacity) {
      yieldOn = on !== false
      if (typeof opacity === 'number' && isFinite(opacity)) yieldOpacity = Math.max(0, Math.min(1, opacity))
      applyYieldStyle()
      if (!yieldOn) setYield(false)
    },
  }
  window.__xykpVk1Yield = yieldApi

  function localeTag() {
    try {
      var locale = ctx.get('locale')
      var snap = locale && locale.getSnapshot && locale.getSnapshot()
      if (snap && snap.active) return snap.active
    } catch (e) {}
    return 'zh-CN'
  }

  function clientMeta() {
    return {
      version: '0.2.1-rc.2',
      locale: localeTag(),
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    }
  }

  async function sleep(ms) {
    await new Promise(function (resolve) { setTimeout(resolve, ms) })
  }

  function pollSeconds() {
    try {
      var options = JSON.parse(localStorage.getItem('dsh-vk1-options') || 'null')
      var s = Number(options && options.pollSeconds)
      return isFinite(s) ? Math.max(2, Math.min(300, s)) : 12
    } catch (e) {
      return 12
    }
  }

  async function fromHost(force) {
    if (stopped) return null
    if (routeState === 'missing' && Date.now() < routeNextTry) return null
    try {
      var query = force ? '?force=1' : '?maxAge=' + pollSeconds()
      var res = await fetch('/xykp/balance-reporter/status' + query, { credentials: 'same-origin', cache: 'no-store' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      var data = await res.json()
      if (data && data.ok === true && data.total != null && isFinite(Number(data.total))) {
        routeState = 'ok'
        return {
          ok: true,
          totalBalance: Number(data.total),
          serverTime: new Date(Number(data.at) || Date.now()).toISOString(),
          origin: 'host',
        }
      }
      if (data && data.ok === false) {
        routeState = 'ok'
        return null
      }
      throw new Error('bad payload')
    } catch (e) {
      routeState = 'missing'
      routeNextTry = Date.now() + 5 * 60 * 1000
      return null
    }
  }

  async function fromAccount() {
    var lastErr = null
    for (var attempt = 0; attempt < 6; attempt++) {
      if (stopped) throw new Error('stopped')
      var account = ctx.get('remote.account')
      if (account && typeof account.getBalance === 'function') {
        try {
          var res = await account.getBalance(clientMeta())
          if (!res || !res.ok) throw new Error('账号余额请求失败')
          var value = res.value
          if (!value || value.status !== 'ready') throw new Error('账号还没登录')
          var total = 0
          var wallets = (value.value || []).concat(value.bonusWallets || [])
          for (var i = 0; i < wallets.length; i++) total += Number(wallets[i].balance) || 0
          return {
            ok: true,
            totalBalance: total,
            serverTime: new Date().toISOString(),
            origin: 'account',
          }
        } catch (err) {
          lastErr = err
        }
      } else {
        lastErr = lastErr || new Error('remote.account 还没就绪')
      }
      await sleep(800)
    }
    throw lastErr || new Error('拿不到余额')
  }

  window.__xykpVk1BalanceProvider = async function (force) {
    if (stopped) throw new Error('stopped')
    var host = await fromHost(!!force)
    if (host) return host
    return await fromAccount()
  }

  function showRestoreButton() {
    if (restoreBtn || stopped) return
    var btn = document.createElement('button')
    btn.id = 'xykp-balance-pet-restore'
    btn.type = 'button'
    btn.title = '显示 VK-1 余额挂件'
    btn.textContent = 'VK'
    btn.style.cssText = [
      'position:fixed', 'right:14px', 'bottom:14px', 'width:36px', 'height:36px',
      'border-radius:50%', 'border:1px solid rgba(255,255,255,.22)',
      'background:rgba(24,27,33,.86)', 'color:#ffd166',
      'font:700 12px/1 system-ui,sans-serif', 'z-index:2147483000',
      'cursor:pointer', 'box-shadow:0 6px 20px rgba(0,0,0,.35)',
      'backdrop-filter:blur(6px)', 'pointer-events:auto',
    ].join(';')
    btn.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      if (restoreBtn) {
        restoreBtn.remove()
        restoreBtn = null
      }
      startWidget()
    })
    document.body.appendChild(btn)
    restoreBtn = btn
  }

  function hideWidget() {
    if (stopped) return
    stopWidget()
    showRestoreButton()
  }

  function startWidget() {
    if (stopped) return
    if (window.__dshVk1Widget) stopWidget()
    try {
      __xykpVk1Start()
    } catch (err) {
      console.warn('[balance-reporter] 挂件启动失败：', err)
    }
  }

  window.__xykpVk1Hide = hideWidget

  var instance = {
    stop: function () {
      if (stopped) return
      stopped = true
      window.removeEventListener('pointermove', onPointerMove, true)
      window.removeEventListener('blur', onBlurYield, true)
      try { yieldStyle.remove() } catch (e) {}
      setYield(false)
      if (window.__xykpVk1Yield === yieldApi) window.__xykpVk1Yield = null
      stopWidget()
      if (restoreBtn) {
        restoreBtn.remove()
        restoreBtn = null
      }
      if (window.__xykpVk1Hide === hideWidget) window.__xykpVk1Hide = null
      if (window[KEY] === instance) window[KEY] = null
    },
    refresh: function () {
      try {
        var table = window.__dshAppearanceWidgets
        var api = table && table['dsh-vk1-balance-widget']
        if (api && typeof api.refresh === 'function') api.refresh()
      } catch (e) {}
    },
    hide: hideWidget,
  }
  window[KEY] = instance

  // ---- 节假日数据：内嵌表是兜底；优先宿主缓存，其次 7 天内的 localStorage，最后直连 GitHub。
  function holidayYear() {
    return new Date(Date.now() + 8 * 3600000).getUTCFullYear()
  }

  function applyHolidayDays(days) {
    try {
      var peak = window.__xykpVk1Peak
      if (peak && typeof peak.setHolidays === 'function') peak.setHolidays(days)
    } catch (e) {}
  }

  function readHolidayCache() {
    try {
      var raw = JSON.parse(localStorage.getItem('xykp-balance-reporter-holidays') || 'null')
      return raw && Array.isArray(raw.days) && raw.days.length ? raw : null
    } catch (e) {
      return null
    }
  }

  function saveHolidayCache(data) {
    try {
      localStorage.setItem('xykp-balance-reporter-holidays', JSON.stringify(data))
    } catch (e) {}
  }

  async function fetchHostHolidays() {
    try {
      var res = await fetch('/xykp/balance-reporter/holidays', { credentials: 'same-origin', cache: 'no-store' })
      if (!res.ok) return null
      var data = await res.json()
      if (data && data.ok === true && Array.isArray(data.days) && data.days.length) {
        return {
          updatedAt: Number(data.updatedAt) || Date.now(),
          years: Array.isArray(data.years) ? data.years : [],
          days: data.days,
          source: data.source || 'host',
        }
      }
    } catch (e) {}
    return null
  }

  async function fetchGithubHolidays(years) {
    var days = []
    for (var i = 0; i < years.length; i++) {
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null
      var timer = ctrl ? setTimeout(function () { ctrl.abort() }, 6000) : null
      try {
        var res = await fetch('https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/' + years[i] + '.json', {
          cache: 'no-store',
          signal: ctrl ? ctrl.signal : undefined,
        })
        if (timer) clearTimeout(timer)
        if (!res.ok) continue
        var data = await res.json()
        var list = data.days || []
        for (var j = 0; j < list.length; j++) {
          if (list[j].isOffDay && /^\d{4}-\d{2}-\d{2}$/.test(String(list[j].date))) days.push(list[j].date)
        }
      } catch (e) {
        if (timer) clearTimeout(timer)
      }
    }
    return days.length ? days : null
  }

  async function refreshHolidays() {
    if (stopped) return
    var host = await fetchHostHolidays()
    if (stopped) return
    if (host) {
      saveHolidayCache(host)
      applyHolidayDays(host.days)
      return
    }
    var cached = readHolidayCache()
    if (cached) applyHolidayDays(cached.days)
    var age = cached ? Date.now() - Number(cached.updatedAt || 0) : Infinity
    if (cached && age < 7 * 86400000) return
    var year = holidayYear()
    var days = await fetchGithubHolidays([year, year + 1, year + 2])
    if (stopped || !days) return
    var merged = Array.from(new Set([...(cached && cached.days ? cached.days : []), ...days])).sort()
    var data = { updatedAt: Date.now(), years: [year, year + 1, year + 2], days: merged, source: 'github' }
    saveHolidayCache(data)
    applyHolidayDays(data.days)
  }

  startWidget()

  try {
    var cachedNow = readHolidayCache()
    if (cachedNow) applyHolidayDays(cachedNow.days)
  } catch (e) {}
  refreshHolidays().catch(function () {})

  ctx.effect(function () {
    return function () {
      instance.stop()
    }
  })
}

    // ==== END GENERATED: senses/balance-reporter ====

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})




