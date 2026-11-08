# injection-slot · 每个 assistant step 前给 injection-shower 留一个渲染位

## 挨的哪个文件

`npm\node_modules\@deepseek-ai\dsh-client-ui-chat\lib\client.js`

两处：

1. `conversation.chat.node` 的 `assistant-step` 注册里，`children` 多声明一个槽位：
   `conversation.chat.injection`（`kind: "list"`, `scope: "session"`）
2. `AssistantNodeView` 的返回值包一层 Fragment，在正文前渲染这个槽位，并把 `turn` / `step` / `answer` 传下去

## 为什么要打

injection-shower 原来只能挂在 `conversation.chat.turnTail`（每轮末尾），而 `system-prompt/assemble` 是**每个 step 跑一次**的：
一轮里中间注入的 context、插入的消息，全被挤到轮末、只剩最后一份状态，看不出来"第几步吃了什么"。

宿主没有现成的"每个 step 前"的槽位，所以补一个。补上之后：

- 第 1 步那行在用户消息之后 → 用户尾部注入显示在轮首
- 第 k 步那行在该步正文之前 → 中间注入显示在发生位置
- `answer: true` 的那一步在 DSH 里渲染在思考折叠组之外，插件据此不显示注入行（避免孤零零一条飘在外面）

## 怎么验证

- `pwsh -File plugins\core\apply-all.ps1 -Check` 里 `dsh-client-ui-chat/injection-slot` 显示「已应用」
- 重启/刷新后，对话里每一步前面出现 `▸ 注入 · 单次 n · 持久 n · 名字…`
- 控制台无 `[dsh-xykp] 注入行注册失败` 警告（那说明槽位没声明上）

## 怎么还原

`pwsh -File plugins\core\apply-all.ps1 -Restore`，之后重启 dsh web。

本补丁带 `revert()`，没有备份也能反推原文；备份在 `.backup\_deepseek-ai_dsh-client-ui-chat_lib_client.js.orig`。

## 注意

- 改的是**构建产物**（`lib/client.js` 是打包后的单文件），锚点依赖当前版本的压缩输出。
  DSH 升级后 `npm install` 的 `postinstall` 会自动重打；如果锚点命中数不是 1，补丁会**拒绝写入**并报错（不会写出半截文件），看 `auto-restore.log` 修锚点即可。
- 插件（dsh-xykp）自身更新走 `pnpm add` / `dsh plugin add`，不碰宿主 `node_modules`，不影响本补丁。
- 槽位是可选渲染：插件没注册 / 注册失败时只返回 null，不会影响聊天正文。
