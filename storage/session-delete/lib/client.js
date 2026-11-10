/**
 * dsh-session-delete — 浏览器端（客户端插件）。
 *
 * 装载契约（对照 @deepseek-ai/dsh-client-modules 与 dsh-onebot-qq/lib/client.js）：
 *   - 必须是 `window.__ModuleLoader__.load({ id, factory })` 的 CJS 包裹；
 *   - `exports.inject` 声明 cordis 客户端服务依赖，`exports.apply(ctx)` 返回卸载函数；
 *   - 依赖只能 require 平台冻结模块表里的模块：react、react/jsx-runtime、
 *     @deepseek-ai/dsh-client-ui-primitives 等。
 *
 * 功能：
 *   1. 侧栏会话行的「…」菜单里加「永久删除会话」，确认后调用宿主 Remote
 *      `sessionDelete/deleteSession`，再刷新会话列表并提示结果。
 *   2. 同一菜单里加「删除末尾对话…」：弹出对话框列出末尾若干轮（问 + 答），
 *      选中某一轮表示「从这一轮起到末尾全部删除」；确认后调用宿主 Remote
 *      `sessionDelete/deleteTurnsFrom` 截断会话日志。
 *
 * 宿主侧行为（见 lib/index.js）：
 *   - 删除会话：非活动会话立即删除磁盘文件；本进程仍活着的会话先归档，排队到
 *     下次宿主启动时清理，返回 `deferred: true`。
 *   - 删除末尾轮次：非活动会话立即截断日志（同 id）；仍活着的会话排队到下次宿主
 *     启动时截断（返回 `queued: true`），因为追加写日志不能在被写句柄占用时重写。
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

    return module.exports;
  },
});