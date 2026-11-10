/**
 * 用户消息操作行里的插槽：`conversation.chat.user.footer`。
 *
 * 会话删除按钮原本挂在 `conversation.chat.turnTail`（整轮末尾）。用户要求把它做成
 * 用户泡泡右下角「时间 + 复制」那一行的红色垃圾桶图标（和复制图标并排，不另起一行）。
 * 所以这里给 user 节点声明子插槽，并把 renderSlot 的结果塞进 MessageIconActions 的
 * `extraActions`（ui-chat 已经在操作行里渲染这个 prop）。
 *
 * 只给 key=user 的节点声明子插槽；steering 节点复用同一个组件但拿不到 footer。
 */
export const id = 'user-footer-slot'

export const description =
  'conversation.chat.user.footer：用户消息操作行（复制图标旁）的插槽，供会话删除按钮使用'

const TARGET = 'D:\\AI\\DeepseekHarness\\npm\\node_modules\\@deepseek-ai\\dsh-client-ui-chat\\lib\\client.js'
const MARKER = '/* ykp patch · user-footer-slot */'

const REGISTRATION_OLD = `\t\t\tctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
\t\t\t\tname: "conversation.chat.node",
\t\t\t\tkey: "user",
\t\t\t\tlocale: NS
\t\t\t}, UserMessageNodeView));`

const REGISTRATION_NEW = `\t\t\tctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
\t\t\t\tname: "conversation.chat.node",
\t\t\t\tkey: "user",
\t\t\t\tlocale: NS,
\t\t\t\tchildren: {
\t\t\t\t\t${MARKER}
\t\t\t\t\t"conversation.chat.user.footer": {
\t\t\t\t\t\tkind: "list",
\t\t\t\t\t\tscope: "session"
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}, UserMessageNodeView));`

const VIEW_OLD = `\t\tconst UserMessageNodeView = (0, react.memo)(function UserMessageNodeView({ node, renderFactorySlot, loadImage, t }) {
\t\t\tconst data = node.data;
\t\t\treturn (0, react_jsx_runtime.jsx)(UserStyleBubble, {
\t\t\t\tcontent: data.content,
\t\t\t\tinteractive: true,
\t\t\t\trenderFactorySlot,
\t\t\t\tloadImage,
\t\t\t\t...data.referenceLabels === void 0 ? {} : { referenceLabels: data.referenceLabels },
\t\t\t\t...data.skillNames === void 0 ? {} : { skillNames: data.skillNames },
\t\t\t\tactions: (text) => (0, react_jsx_runtime.jsx)(MessageIconActions, {
\t\t\t\t\ttext,
\t\t\t\t\ttime: data.time,
\t\t\t\t\tclock: "start",
\t\t\t\t\tclassName: MessageItem_module_css_default.actions,
\t\t\t\t\tt
\t\t\t\t})
\t\t\t});
\t\t});`

const VIEW_NEW = `\t\tconst UserMessageNodeView = (0, react.memo)(function UserMessageNodeView({ node, renderFactorySlot, renderSlot, loadImage, t }) {
\t\t\tconst data = node.data;
\t\t\t${MARKER}
\t\t\tconst footerTurn = node.kind === "user" && typeof renderSlot === "function" ? turnOf$1(node) : void 0;
\t\t\tconst extraActions = footerTurn === void 0 ? void 0 : renderSlot("conversation.chat.user.footer", { turn: footerTurn });
\t\t\treturn (0, react_jsx_runtime.jsx)(UserStyleBubble, {
\t\t\t\tcontent: data.content,
\t\t\t\tinteractive: true,
\t\t\t\trenderFactorySlot,
\t\t\t\tloadImage,
\t\t\t\t...data.referenceLabels === void 0 ? {} : { referenceLabels: data.referenceLabels },
\t\t\t\t...data.skillNames === void 0 ? {} : { skillNames: data.skillNames },
\t\t\t\tactions: (text) => (0, react_jsx_runtime.jsx)(MessageIconActions, {
\t\t\t\t\ttext,
\t\t\t\t\ttime: data.time,
\t\t\t\t\tclock: "start",
\t\t\t\t\tclassName: MessageItem_module_css_default.actions,
\t\t\t\t\textraActions,
\t\t\t\t\tt
\t\t\t\t})
\t\t\t});
\t\t});`

/** 只替换一次；找不到就说明上游版本变了，直接报错而不是静默跳过。 */
function replaceOnce(text, from, to, label) {
  const index = text.indexOf(from)
  if (index < 0) throw new Error(`[ykp patch] 找不到锚点：${label}`)
  if (text.indexOf(from, index + 1) >= 0) throw new Error(`[ykp patch] 锚点不唯一：${label}`)
  return text.slice(0, index) + to + text.slice(index + from.length)
}

export const edits = [
  {
    target: TARGET,
    marker: MARKER,
    apply(text) {
      let next = replaceOnce(text, REGISTRATION_OLD, REGISTRATION_NEW, 'user 节点登记 children')
      next = replaceOnce(next, VIEW_OLD, VIEW_NEW, 'UserMessageNodeView 渲染 footer')
      return next
    },
    revert(text) {
      let next = replaceOnce(text, REGISTRATION_NEW, REGISTRATION_OLD, 'user 节点登记 children（回滚）')
      next = replaceOnce(next, VIEW_NEW, VIEW_OLD, 'UserMessageNodeView 渲染 footer（回滚）')
      return next
    },
  },
]
