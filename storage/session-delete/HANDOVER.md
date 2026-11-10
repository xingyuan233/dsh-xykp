# session-delete「删除末尾轮次」交接文档

> 更新时间：2026-11-10 22:00（Asia/Shanghai）
> 新对话接手时请先通读本文件，再读插件 README 和 `home\documents\plugin-guide.md`。

## 0. 一句话现状

功能主体已经做完并**部署 + 重启生效**：聊天里每一轮末尾有「删除这轮及之后」，宿主用新加的核心补丁 `agents.close()` 释放写句柄后**当场截断会话日志**（不再需要重启）。
但有两个用户反馈的问题待修：

1. **删完之后，被保留的最后一条用户消息在 UI 上显示成了「注入」**（截图 `docs/bug-after-delete-injection.png`）。
2. 按钮位置要挪到**用户消息下方**（现在在 turn 末尾；没有模型输出的轮次就没有按钮）。

另有一个次要遗留：删完后客户端缓存的会话实例是旧的，现在靠「自动切走 + 提示点回原会话」绕过。

---

## 1. 代码位置与产物

| 东西 | 路径 |
| --- | --- |
| 插件源码 | `D:\AI\DeepseekHarness\plugins\storage\session-delete` |
| 宿主半边 | `lib/index.js`（Remote：`deleteSession` / `previewTurns` / `deleteTurnsFrom`） |
| 浏览器半边（源） | `lib/client.js` |
| 浏览器包级 bundle | `D:\AI\DeepseekHarness\plugins\client.js`（由工具合并生成） |
| 合并工具 | `D:\AI\DeepseekHarness\tools\merge-session-delete-client.mjs` |
| 核心补丁 | `D:\AI\DeepseekHarness\plugins\core\agent-close.mjs` |
| 部署脚本 | `...\session-delete\deploy.ps1`（合并 + 复制到 xykp 包 + 复制 bundle） |
| 自检脚本 | `...\session-delete\verify.ps1`（离线测试 + 安装布局 + bundle 内容 + 核心补丁检查） |
| 离线测试 | `...\session-delete\test\offline.mjs`（删除会话）、`test\tail.mjs`（末尾截断，含 live/排队/启动消费） |
| 安装位置 | `D:\AI\DeepseekHarness\home\profiles\web\node_modules\dsh-xykp\storage\session-delete\` |
| 包级 bundle 安装位置 | `D:\AI\DeepseekHarness\home\profiles\web\node_modules\dsh-xykp\client.js` |

**为什么有 bundle**：DSH 客户端加载器只认「整包名」的 Loader 行，子路径插件不会触发浏览器 bundle；`dsh-xykp` 根级 `client.js` 里手工合并了各子插件的浏览器 UI（合并段标记 `// ===== 合并自 storage/session-delete ...`）。
**改了 `lib/client.js` 必须**：`node tools\merge-session-delete-client.mjs`（或直接跑 `deploy.ps1`，它会先合并）→ 部署 → 重启 dsh web。

---

## 2. 现在的行为

### 入口
- 侧栏会话「…」菜单：**「删除末尾对话…」**（原「永久删除会话」保留）。
- 聊天视图：**每一轮 turn 末尾**（时间/复制图标旁）的 **「删除这轮及之后」** 按钮，通过客户端插槽 `conversation.chat.turnTail`（`kind: "list"`, `scope: "session"`）注册；插槽 props 有 `turn`（**对象**，轮次在 `turn.turn`）、`seq`、`sessionId`。

### 对话框
- 打开时调用 `previewTurns(sessionId, fromTurn?)`：
  - `fromTurn` 传空串表示「末尾 12 轮」；从 turn 按钮打开时传那一轮，只列**从该轮开始**的轮次。
  - 返回 `{ sessionId, displayTitle, live, canClose, totalTurns, turns: [{turn, prompt, response}] }`；`turn`/`totalTurns` 是十进制字符串（wire 上不用 number codec）。
- 选中的轮及之后都标红，顶部显示「将删除第 N 轮到最后（共 X 轮）」；`live` 时按 `canClose` 显示「会关掉实时连接再重写」或「只能重启后生效」。
- 确认 → `deleteTurnsFrom(sessionId, fromTurn)`。

### 宿主截断逻辑（`lib/index.js`）
- `truncateLogAtTurn(file, sessionId, fromTurn)`：
  - 读 `session.v4.jsonl.zstd`（`zstdDecompressSync`），首行 header、其余一行一个事件；
  - 找到 `data.turn === fromTurn` 的 `turn/start` 的**行下标**作为 cut；
  - 保留 `eventLines.slice(0, cut)`，用 `encodeLogFrames` 重压缩：**第一帧只能放 header 一行**（后端强校验 `assertZstdHeaderFrame`），之后约 1 MiB 一帧；
  - 临时文件 + fsync + rename；重读自检（事件数、seq 连续）；
  - 删除 projection cache `<home>\storages\session_projcache\sessions\<id>.json`。
- live 会话（`agents.get(id)` 或 `sessions.get(id)` 存在）：
  - **优先** `agents.close(sessionId)`（核心补丁）→ `waitWritable()` 轮询 `persistence.open(id,'write')`（最多 3s）→ 成功就原地截断，返回 `applied: true`；
  - 没补丁 / 释放失败 → 登记 `pending-turns.json`，下次启动在任何 agent 恢复前截断，返回 `queued: true`。
- 启动时 `flushPendingTurns` 消费队列。

### 客户端删除流程（`lib/client.js` 的 `deleteTurnsFrom`）
- 若目标正开在主视图：用侧栏可见行找另一个会话 → `ctx.uiWorkspace.openSession(other)` 切走 → 等 `retainInfo.referenceCount === 0` → **等 600ms** → 调 RPC。
- RPC 后 `refreshSessions`（`sessions.refreshProjections` + `sessions.refresh`），提示条：`已删除第 X 轮及之后的 N 轮对话 (已切到别的会话，点回原会话即可看到最新内容)`。
- **不自动切回**（原因见 §5）。
- 没有 `open`（会话不在主视图）时直接删除，不切换。

---

## 3. 核心补丁（关键）

文件：`plugins\core\agent-close.mjs`，目标：`D:\AI\DeepseekHarness\npm\node_modules\@deepseek-ai\dsh-agent\lib\index.js`。

作用：给 `AgentRegistry` 增加按 sessionId 记住 `AgentHandle`、并暴露 `async close(id)` 调用 `handle.dispose()`。
`AgentHandle.dispose()` 的语义（源码注释）：停 loop、等退出、从注册表摘除、关会话（释放写句柄）。

- 应用：`node D:\AI\DeepseekHarness\plugins\core\apply-all.mjs`（幂等，已应用会跳过）。
- 持久性：profile 的 postinstall `auto-restore.cmd --full` → `restore-all.ps1` → `apply-all.ps1`，补丁会被重新应用。
- 反转：`plugins\core\restore-all.ps1`（会恢复 `.orig`；注意其他核心补丁也会被一起处理）。
- 为什么必须：DSH 打开/跟随会话会把它 promote 成 live agent 并持有写句柄，**直到进程退出**；切换会话、归档、页内任何操作都不释放（实测探针见 §7）。没有这个补丁就只能排队到重启。

---

## 4. 待修 BUG #1：删完后用户消息显示成「注入」

**现象**（用户截图，已复制到 `docs/bug-after-delete-injection.png`）：
从某一轮开始删除后，保留下来的最后一条用户消息在聊天里渲染成「注入」样式（左侧一个 ↳ 图标），旁边是复制/删除图标；输入框上方只剩这条注入。

**最可能的根因**（待验证）：
`turn/start` **之前**会有 `agent/inbox/spliced` 事件（inbox 把消息插进下一轮）。示例日志（真实数据）：

```
... permission/preset, sandbox/mode, approval/policy,
    agent/inbox/spliced   <- 在 turn/start 之前
    turn/start {turn: 1}
```

我们的切割点是 `turn/start`，所以这个 **spliced 事件被保留**，而它对应的 turn 已经没了 → 注入渲染器（injection 投影/注入面板）把这条消息当成「注入」显示。

**建议修法**：
1. 先复现并确认：拿一份会话副本（放临时 home，见 §6），用 `deleteTurnsFrom` 删末尾轮次，解压日志看 cut 前的最后几条事件里是否有 `agent/inbox/spliced`、`user/message`、`system/message`。
2. 切割点改成：**cut 到上一个 `turn/end` 之后**（即保留到上一轮 turn/end 为止，丢掉两轮之间的所有事件），或者至少把 cut 之前**紧邻的 `agent/inbox/spliced`** 一起删掉。
   - 注意：`session/title` 事件常常也在轮次之间，丢掉会导致标题变回 id/「未命名」；如果在意，保留 `session/title` 而只删 inbox/spliced（实现上可以「保留到上一轮 turn/end + 单独保留 session/title」）。
   - 删第 1 轮时没有「上一轮 turn/end」：保留 header + permission/sandbox/approval 等前导，丢掉 inbox splice 和之后的全部。
3. 修改后必须重跑 `test/tail.mjs`，并补一个用例：cut 前有 `agent/inbox/spliced` 时日志尾部干净。

---

## 5. 待改 UI #2：按钮挪到「用户消息下」

用户的点：**对话可能没有模型输出，但一定有用户输入**。现在挂在 turn 末尾（`conversation.chat.turnTail` 插槽），没有 assistant 输出/没有 tail 节点的轮次就没有按钮。

建议：
- 在 `@deepseek-ai/dsh-client-ui-chat/lib/client.js`（**这是核心补丁目标，`plugins/core/*.mjs` 的写法**）找用户消息组件（renderSlot 列表里 7342 行附近有 `conversation.chat.user.i...`（attachments）；附近就是用户消息渲染）。
- 方案 A：如果用户消息附近有现成插槽（如 user actions），在插件里注册即可，不需要核心补丁。
- 方案 B：没有插槽就加一个小核心补丁（参考 `plugins/core/injection-slot.mjs` / `turn-tail-empty.mjs` 的写法），在用户消息下方渲染按钮；按钮点击通过：
  - 一个客户端服务（`ctx.provide('sessionTailDelete', {...})`，插件里注册），或
  - `document.dispatchEvent(new CustomEvent('dsh-session-tail-delete', {detail:{sessionId, turn}}))`，插件监听。
- 需要拿到该用户消息所属的 **turn 号**：turn 节点的 `data.turn`（用户消息在 turn 数据树里，turnTail 拿到的 `props.turn` 是对象，轮次在 `.turn`）。
- 按钮/文案可复用现有 `DeleteTailTurnButton` 组件与 `store.requestTail(sessionId, "", turn)`。

---

## 6. 待解决 #3：客户端 resident 实例刷新（公开接口线索）

**问题**：删完后，客户端缓存的会话实例还是旧事件；用 `uiWorkspace.openSession(sameId)` 重开会复用旧实例，表现为「会话不可用」或旧轮次。手动「切到别的会话 → 等 1~3s → 点回」是好的（已实测）。

**已经确认过的**：
- `ctx.uiWorkspace.openSession(id)`（客户端服务，`dsh-client-ui-workspace` 提供，签名 `openSession(target: SessionTarget): void`）能切会话，但**不能**强制重建同一会话的实例。
- `ctx.sessions.refreshProjections(id)` 只在投影未 ready 时拉投影，**不碰 history**；`ctx.sessions.refresh()` 只刷目录。
- 内部有 `manager.drop(id, session)` 和 `startScopeDrop/startSessionDisposal`（`dsh-api-session-controller/lib/client.js` 约 3049/3073/4116/4228），但**没有**从 `ISessions` 暴露出来的 drop/forget。
- 页面重载不可行：token 在首次进入后从 URL 里被剥掉，`location.reload()` 会 401/404。

**下一步可查**：
- `@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/service.d.ts`：`scope(...)`、`retain/release`、`SessionRetainOp` 的细节（是否能创建一个 scope 再 dispose 来触发 `manager.drop`）。
- `dsh-client-ui-workspace` 里 `replaceMain` / `retain({source:'mainView'})` 的流程：视图切换时 scope 何时 drop。
- 如果找到，删除后 `await dropScope` 再 `openSession(sessionId)`，就能自动重开而不需要用户点回。

---

## 7. 实测证据 / 结论（省得重复踩）

用临时 3081 实例 + 探针（`persistence.open(id,'write')`）测过：

| 操作 | agents/sessions | 写句柄 |
| --- | --- | --- |
| 打开会话 | true/true | 被占用 |
| 切到别的会话，等 12s | true/true | 仍被占用 |
| 新建空会话切走，等 15s | true/true | 仍被占用 |
| `archiveSession(stopActivity)` + 连探 5s | true/true | 仍未释放 |
| 应用核心补丁后 `agents.close(id)` | false | **释放**，随后可原地截断 |

- 日志格式：`session.v4.jsonl.zstd`，首行 header，一行一事件，seq 从 0；**第一帧只能 header 一行**；重压缩用 Node `zlib.zstdCompressSync` 多帧。
- 真实后端集成验证过：1208 事件/37 轮 → 1147 事件/35 轮，后端能正常打开、继续 append。
- 截断后客户端 view 刷新问题见 §6。

---

## 8. 构建 / 部署 / 验证（照抄即可）

```powershell
# 1) 离线测试
cd D:\AI\DeepseekHarness\plugins\storage\session-delete
node test\offline.mjs
node test\tail.mjs

# 2) 合并浏览器 UI + 部署到 profile（含核心补丁检查）
pwsh -File .\deploy.ps1
pwsh -File .\verify.ps1

# 3) 核心补丁（deploy 不负责这个，改核心补丁后单独跑）
node D:\AI\DeepseekHarness\plugins\core\apply-all.mjs

# 4) 重启（用户允许时）
pwsh -File D:\AI\DeepseekHarness\restart-dsh.ps1
```

注意：
- 重启前不要刷新页面（新客户端 bundle + 旧宿主会提示「宿主还没加载新版本」，删除会话本身不受影响）。
- 部署脚本只动 profile 的 `dsh-xykp` 副本，不改 `npm`（核心补丁除外）。
- 核心补丁改的是 `npm\node_modules\@deepseek-ai\dsh-agent\lib\index.js`；以后升级 dsh 跑 `apply-all.mjs` 重新打。

---

## 9. 临时 e2e 手册（真实浏览器）

之前用过的方式（临时实例与生产同代码，不碰 3080）：

1. 复制临时 home：`D:\askii\cache\sd-e2e\home`，至少要有
   - `profiles\web\{cordis.yml([]), package.json(bundles: @deepseek-ai/dsh-base + dsh-web-app), cordis.patch.yml}`，
   - `profiles\web\node_modules\dsh-xykp`（真实 profile 的副本，替换其中的 `storage\session-delete` 和 `client.js`），
   - `storages`、`.credentials.yaml`、`llm-deepseek`，
   - `sessions\<project>\<id>`（从真实 home 复制，勿动真实会话）。
2. 启动：`$env:DSH_HOME=<临时home>` + `node D:\AI\DeepseekHarness\npm\node_modules\@deepseek-ai\dsh\lib\bin.js web --no-open --port 3081`（会打印 token URL）。
3. Chrome：`chrome.exe --headless=new --remote-debugging-port=9333 --user-data-dir=<临时目录> "<token URL>"`。
4. CDP 小脚本：`/json/list` 拿 ws → `Runtime.evaluate`（`awaitPromise`）操作 DOM；常用表达式：
   - 侧栏行：`[data-row-key="session:<id>"]`；会话「…」按钮 aria-label 含 `的操作`；
   - 轮次按钮：`.sd-turn-delete`；
   - 弹窗：`[role=dialog]`，footer 最后一个按钮是确认。
   - 读日志：Node 里 `zstdDecompressSync` + `split('\n')`。
5. 用完删掉临时 home/Chrome 进程（不要杀 3080 的宿主）。

---

## 10. 其他注意事项

- 用户对「侧栏…菜单」的入口不满意，**主线入口以聊天内按钮为准**；侧栏入口保留即可。
- 删除粒度是「轮」（turn），不拆单条消息。
- 删第 1 轮会把 `session/title` 一起删掉（标题变「未命名」/id）——如果修切割点保留 title，可顺手解决。
- 上下文压缩（`compaction/prune`）会剪掉旧回答正文，预览显示「暂无可预览的回答」是正常的。
- AGENTS.md 的规矩照旧：临时文件放工作区/`D:\askii\cache`，用完清理；改插件前读 `home\documents\plugin-guide.md`。

---

## 11. 2026-11-10 续修状态（未重启，代码/bundle 已部署）

### 已修：删完最后一条 user 消息变「注入」

- 根因确认：真实日志里下一轮的提示词先以 `agent/inbox/spliced`（`target: "next-step"`）进 inbox，
  `turn/start` 之后才被消费。原来按 `turn/start` 切，会把这个 spliced 留在文件末尾；
  投影把它当成一条没被消费的排队消息，UI 就显示成输入框上方的「注入」。
- 修法（`lib/index.js` `truncateLogAtTurn`）：切点仍定位到目标轮 `turn/start`，但只保留到
  「上一轮 `turn/end`」；轮间区域里**丢掉所有 `agent/inbox/*`**，其余事件（`session/title`、
  权限/沙箱/审批变更等）保留。删到第 1 轮时从被删区间借回最早的 `session/title`，标题不再变「未命名」。
  借回事件导致下标不连续时按新顺序重排 `seq`，并把 `ts` 顶到末尾，保证日志合法。
- 测试：`test/tail.mjs` 新增场景 6/7（轮间 spliced + 标题），共 37 项；新增
  `test/real-log.mjs`（拿真实 home 里的多轮日志复制到临时目录逐轮截断，校验 header/seq/ts/
  不悬空 spliced/标题保留，全部通过）。

### 已改：按钮从轮末挪到用户消息下方（UI 待重启后目测）

- 新增核心补丁 `plugins/core/user-footer-slot.mjs`：给 `conversation.chat.node` 的 `key: "user"`
  声明子插槽 `conversation.chat.user.footer`（`kind: "list"`, `scope: "session"`），
  并把 `renderSlot(...)` 结果作为 `MessageIconActions` 的 `extraActions` 渲染——
  和用户消息右下角「时间 + 复制」同一行（数据 `{ turn }`，sessionId 由插槽注入）。
  已 `node apply-all.mjs` 应用到 npm 目录。
- `lib/client.js`：注册到 `conversation.chat.user.footer`，用 `DeleteUserTurnButton` 渲染**图标-only 的红色垃圾桶**
  （`IconTrashOutlineRegular`，`.sd-user-trash`）；核心补丁把 `renderSlot` 的结果塞进 `MessageIconActions`
  的 `extraActions`，所以它和「时间 + 复制」同一行、复制图标右边，不另起一行。
  插槽缺失时 try/catch 回退到旧 `conversation.chat.turnTail`。
- 注意：`conversation.chat.user.footer` 是自造插槽，**只做了静态检查，尚未在浏览器里目测**。
  重启后先看：用户消息下是否出现按钮；若没有，先怀疑 `renderSlot` 没传到 `UserMessageNodeView`
  或插槽声明位置不对（回退逻辑会保住插件其余功能）。

### 未做 / 下一步

- 重启 dsh web 后验证：①UI 按钮位置；②删最后一轮后不再出现「注入」（可复制一份真实会话试）；
  ③删第 1 轮后标题仍保留。
- 待解 3（删完客户端 resident 实例旧、要切走再点回）未动。
- 部署/测试命令不变：`node test/offline.mjs` + `node test/tail.mjs` + `node test/real-log.mjs`
  → `pwsh deploy.ps1` → `pwsh verify.ps1` → `node ../core/apply-all.mjs`（如改核心补丁）→ 重启。
