# turn-tail-empty · 空回复的轮也保留底部栏

## 挨的哪个文件

`npm\node_modules\@deepseek-ai\dsh-client-ui-chat\lib\client.js`

三处：

1. `tailData()`：返回值多带 `last`（最后一个有 `finalNode` 的 assistant step，**不管有没有正文**）
2. `TurnTailNodeView`：`closing === null` 分支不再只渲染空的 turnTail 槽位，而是补一条 `MessageIconActions`
3. `MessageIconActions`：加 `hideCopy` 开关，空回复时隐藏复制按钮

## 为什么要打

`closing` 的判定是 `finalized.findLast(hasText)`——必须有一条**带正文**的 assistant 消息。
模型偶尔只输出 reasoning、没有 text 块（例如提示里写了"不用回复"，或模型自己决定静默），
这时 `closing === null`，整个底部栏（复制/赞踩/分享/用量/时间）一起消失，
看起来像整轮消息丢了。

## 空回复时显示什么

- 复制：隐藏（没有正文可复制）
- 赞踩：保留（`assistant-actions` 槽位，用最后一条 assistant 消息的 `messageId`）
- 分支：不显示（没有可分支的正文）
- 用量：保留（`detailed` 模式下显示本轮 token 明细）
- 时间：保留（取 `turn/end` 的时间）

## 怎么验证

- `pwsh -File plugins\core\apply-all.ps1 -Check` 里 `dsh-client-ui-chat/turn-tail-empty` 显示「已应用」
- 找一个只有思考、没有正文的轮（比如「鲸落协议」测试会话），底部应出现：赞踩 + 用量 + 时间，没有复制按钮
- 有正文的普通轮不受影响

## 怎么还原

`pwsh -File plugins\core\apply-all.ps1 -Restore`，之后重启 dsh web。

本补丁带 `revert()`；备份在 `.backup\_deepseek-ai_dsh-client-ui-chat_lib_client.js.orig`。

## 注意

- `injection-slot.mjs` 和本补丁改的是同一个文件，备份是两者都未打时的原文，`-Restore` 会一起还原掉。
- 改的是构建产物，DSH 升级后靠 `auto-restore` 重打；锚点对不上会拒绝写入（看 `auto-restore.log`）。
