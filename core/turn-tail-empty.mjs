// turn-tail-empty —— 空回复（只有思考、没有正文）的轮也要有底部栏
//
// 为什么：TurnTailNodeView 只在 closing（最后一条带正文的 assistant 消息）存在时
// 才渲染复制/赞踩/分享/用量/时间那一栏。模型偶尔会只输出 reasoning、没有 text 块，
// 这时 closing === null，整个底部栏消失，看起来像整轮丢了。
//
// 改法：
//   1. tailData 多带一个 last（最后一个有 finalNode 的 step，不管有没有正文）
//   2. closing === null 时照样渲染 MessageIconActions：不显示复制（没正文），
//      但保留赞踩（assistant-actions 槽位）、用量、时间
//   3. MessageIconActions 增加 hideCopy 开关
//
// 升级 DSH 后靠 core/auto-restore 重打；锚点对不上会拒绝写入，不会写坏文件。

const TARGET = 'D:\\AI\\DeepseekHarness\\npm\\node_modules\\@deepseek-ai\\dsh-client-ui-chat\\lib\\client.js'

const MARKER = 'ykp patch · turn-tail-empty'

const SIGNATURE_OLD = `\t\tfunction MessageIconActions({ text, time, clock, onBranch, branchUnavailable = false, className, extraActions, usageAction, t }) {`
const SIGNATURE_NEW = `\t\tfunction MessageIconActions({ text, time, clock, onBranch, branchUnavailable = false, hideCopy = false, className, extraActions, usageAction, t }) {`

const COPY_OLD = `\t\t\t\t\t(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
\t\t\t\t\t\tlabel: copied ? t("copied") : t("copy"),
\t\t\t\t\t\tside: "bottom",`
const COPY_NEW = `\t\t\t\t\thideCopy ? null : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
\t\t\t\t\t\tlabel: copied ? t("copied") : t("copy"),
\t\t\t\t\t\tside: "bottom",`

const TAILDATA_OLD = `\t\t\tconst closing = finalized.findLast(hasText) ?? null;
\t\t\tlet latestTranscriptSeq`
const TAILDATA_NEW = `\t\t\tconst closing = finalized.findLast(hasText) ?? null;
\t\t\t/* ${MARKER} */
\t\t\tconst lastFinal = finalized.at(-1) ?? null;
\t\t\tlet latestTranscriptSeq`

const RETURN_OLD = `\t\t\t\tclosing,
\t\t\t\tbranchUnavailable:`
const RETURN_NEW = `\t\t\t\tclosing,
\t\t\t\tlast: lastFinal,
\t\t\t\tbranchUnavailable:`

const BRANCH_OLD = `\t\t\tif (closing === null) return tail === null ? null : (0, react_jsx_runtime.jsx)("div", {
\t\t\t\tclassName: TurnTailNodeView_module_css_default.root,
\t\t\t\t"data-turn-tail": data.turn,
\t\t\t\tchildren: tail
\t\t\t});`

const BRANCH_NEW = `\t\t\tif (closing === null) {
\t\t\t\t/* ${MARKER} */
\t\t\t\tconst lastMessageId = data.last?.finalNode?.messageId;
\t\t\t\tconst emptyActions = lastMessageId === void 0 ? null : renderSlot("conversation.chat.assistant-actions", { messageId: lastMessageId });
\t\t\t\tconst emptyUsage = detailed && data.tokenUsage !== void 0 ? (0, react_jsx_runtime.jsx)(TurnUsagePanel, {
\t\t\t\t\tusage: data.tokenUsage,
\t\t\t\t\tt
\t\t\t\t}) : null;
\t\t\t\tconst emptyBar = (0, react_jsx_runtime.jsx)(MessageIconActions, {
\t\t\t\t\ttext: "",
\t\t\t\t\thideCopy: true,
\t\t\t\t\ttime: data.time,
\t\t\t\t\tclock: "end",
\t\t\t\t\tbranchUnavailable: true,
\t\t\t\t\tclassName: TurnTailNodeView_module_css_default.actions,
\t\t\t\t\textraActions: emptyActions,
\t\t\t\t\tusageAction: emptyUsage,
\t\t\t\t\tt
\t\t\t\t});
\t\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\t\tclassName: TurnTailNodeView_module_css_default.root,
\t\t\t\t\t"data-turn-tail": data.turn,
\t\t\t\t\t"data-actions-reveal": "always",
\t\t\t\t\tchildren: [tail, emptyBar]
\t\t\t\t});
\t\t\t}`

const PAIRS = [
  ['MessageIconActions 签名', SIGNATURE_OLD, SIGNATURE_NEW],
  ['复制按钮', COPY_OLD, COPY_NEW],
  ['tailData closing', TAILDATA_OLD, TAILDATA_NEW],
  ['tailData 返回', RETURN_OLD, RETURN_NEW],
  ['closing === null 分支', BRANCH_OLD, BRANCH_NEW],
]

export const id = 'dsh-client-ui-chat/turn-tail-empty'

export const description = '空回复（只有思考）的轮也渲染底部栏：赞踩/用量/时间，复制隐藏'

export const edits = [{
  target: TARGET,
  marker: MARKER,
  apply(text) {
    for (const [name, anchor] of PAIRS) {
      const hits = text.split(anchor).length - 1
      if (hits !== 1) throw new Error(`${name} 锚点命中 ${hits} 次（要求正好 1 次）`)
    }
    let next = text
    for (const [, anchor, patched] of PAIRS) next = next.replace(anchor, patched)
    return next
  },
  revert(text) {
    if (!text.includes(MARKER)) return text
    let next = text
    for (const [, anchor, patched] of PAIRS) next = next.replace(patched, anchor)
    return next
  },
}]
