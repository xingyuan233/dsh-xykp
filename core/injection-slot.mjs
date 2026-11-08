// injection-slot —— 给对话里每个 assistant step 前面加一个「注入」渲染位
//
// 为什么：injection-shower 原来只能挂在每轮末尾的 turnTail，一轮里各 step 中途
// 注入的 context / 插入消息全被挤到最后，看不出「第几步吃了什么」。
// 这个补丁在 ui-chat 的 AssistantNodeView 里渲染 conversation.chat.injection，
// 并把 turn + step 传给插件；插件按 step 把注入行显示在该步内容之前。
//
// 注意：改的是宿主构建产物（lib/client.js），升级 DSH 后靠 core/auto-restore 重打。

const TARGET = 'D:\\AI\\DeepseekHarness\\npm\\node_modules\\@deepseek-ai\\dsh-client-ui-chat\\lib\\client.js'

const MARKER = 'ykp patch · injection-slot'

const ANCHOR_CHILDREN = `\t\t\t\tkey: "assistant-step",
\t\t\t\tlocale: NS,
\t\t\t\tchildren: {
`

const PATCHED_CHILDREN = `\t\t\t\tkey: "assistant-step",
\t\t\t\tlocale: NS,
\t\t\t\tchildren: {
\t\t\t\t\t/* ${MARKER} */
\t\t\t\t\t"conversation.chat.injection": {
\t\t\t\t\t\tkind: "list",
\t\t\t\t\t\tscope: "session"
\t\t\t\t\t},
`

const ANCHOR_RETURN = `\t\t\treturn (0, react_jsx_runtime.jsx)(AssistantMarkdown, {`

const PATCHED_RETURN = `\t\t\t/* ${MARKER} */
\t\t\tconst injection = turn === void 0 ? null : renderSlot("conversation.chat.injection", {
\t\t\t\tturn: turn.turn,
\t\t\t\tstep: data.step,
\t\t\t\tanswer: turnProcess !== void 0 && turnProcess.spec !== void 0 && turnProcess.spec.answerStep === data.step
\t\t\t});
\t\t\treturn (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, {
\t\t\t\tchildren: [injection, (0, react_jsx_runtime.jsx)(AssistantMarkdown, {`

const ANCHOR_CLOSE = `\t\t\t\tmentions,
\t\t\t\tt
\t\t\t});
\t\t});
\t\t//#endregion`

const PATCHED_CLOSE = `\t\t\t\tmentions,
\t\t\t\tt
\t\t\t})]
\t\t\t});
\t\t});
\t\t//#endregion`

export const id = 'dsh-client-ui-chat/injection-slot'

export const description = '每个 assistant step 前渲染 conversation.chat.injection 槽位（带 turn/step）'

export const edits = [{
  target: TARGET,
  marker: MARKER,
  apply(text) {
    const anchors = [
      [ANCHOR_CHILDREN, 'assistant-step children'],
      [ANCHOR_RETURN, 'AssistantMarkdown return'],
      [ANCHOR_CLOSE, 'AssistantMarkdown close'],
    ]
    for (const [anchor, name] of anchors) {
      const hits = text.split(anchor).length - 1
      if (hits !== 1) throw new Error(`${name} 锚点命中 ${hits} 次（要求正好 1 次）`)
    }
    return text
      .replace(ANCHOR_CHILDREN, PATCHED_CHILDREN)
      .replace(ANCHOR_RETURN, PATCHED_RETURN)
      .replace(ANCHOR_CLOSE, PATCHED_CLOSE)
  },
  revert(text) {
    if (!text.includes(MARKER)) return text
    return text
      .replace(PATCHED_CHILDREN, ANCHOR_CHILDREN)
      .replace(PATCHED_RETURN, ANCHOR_RETURN)
      .replace(PATCHED_CLOSE, ANCHOR_CLOSE)
  },
}]
