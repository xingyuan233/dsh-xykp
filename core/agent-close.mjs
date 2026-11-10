/**
 * 功能补丁：给 AgentRegistry 增加显式释放能力 `close(sessionId)`。
 *
 * 背景：DSH 打开/跟随一个会话时会把它 promote 成 live agent（持有会话写句柄，
 * 直到进程退出才释放）。session-delete 要“删除末尾轮次”就必须在重写 JSONL
 * 日志前把这个写句柄放掉；切走会话、归档都不会释放它。
 *
 * 做法：AgentRegistry.create/resume 拿到的 AgentHandle 本来就带 `dispose()`
 * （停止 loop、等退出、从注册表摘除、关会话），这里把它按 sessionId 记下来，
 * 新增 `close(id)` 直接 dispose。插件在截断日志前调用 close，然后轮询
 * `persistence.open(id,'write')` 直到成功再重写。
 *
 * 只影响被显式 close 的 agent；正常生命周期不变。
 */
export const id = 'agent-close'
export const description = '给 agents 服务加 close(sessionId)：显式 dispose 一个 live agent（释放会话写句柄）'

const TARGET = 'D:\\AI\\DeepseekHarness\\npm\\node_modules\\@deepseek-ai\\dsh-agent\\lib\\index.js'
const MARKER = 'ykp patch · agent-close'
const CREATE_RETURN = '\t\treturn Reflect.apply(target.createAgent, receiver, [ownerCtx, options]);'
const RESUME_RETURN = '\t\treturn Reflect.apply(target.resume, receiver, [ownerCtx, options]);'

export const edits = [
  {
    target: TARGET,
    marker: MARKER,
    apply(text) {
      if (text.includes(MARKER)) return text

      // 1) 在 create 前插入 close() 方法
      const createAnchor = '\tasync create(options) {'
      if (!text.includes(createAnchor)) throw new Error('agent-close: 找不到 create 锚点')
      const closeMethod =
        `\t/** ${MARKER}：显式释放一个 live agent（关闭会话写句柄）。 */\n` +
        '\tasync close(id) {\n' +
        '\t\tconst handle = this.handles?.get(id);\n' +
        '\t\tif (handle === undefined) return false;\n' +
        '\t\tthis.handles.delete(id);\n' +
        '\t\tawait handle.dispose();\n' +
        '\t\treturn true;\n' +
        '\t}\n'
      text = text.replace(createAnchor, closeMethod + createAnchor)

      // 2) create：记住 handle
      if (!text.includes(CREATE_RETURN)) throw new Error('agent-close: 找不到 create 返回锚点')
      text = text.replace(
        CREATE_RETURN,
        '\t\tconst handle = await Reflect.apply(target.createAgent, receiver, [ownerCtx, options]);\n' +
          '\t\t(this.handles ??= /* @__PURE__ */ new Map()).set(handle.agent.session.id, handle);\n' +
          '\t\treturn handle;',
      )

      // 3) resume：记住 handle
      if (!text.includes(RESUME_RETURN)) throw new Error('agent-close: 找不到 resume 返回锚点')
      text = text.replace(
        RESUME_RETURN,
        '\t\tconst handle = await Reflect.apply(target.resume, receiver, [ownerCtx, options]);\n' +
          '\t\t(this.handles ??= /* @__PURE__ */ new Map()).set(handle.agent.session.id, handle);\n' +
          '\t\treturn handle;',
      )
      return text
    },
  },
]
