# dsh-session-delete（dsh web 会话删除 / 末尾对话截断）

给 DeepSeek Harness 的 Web 界面补上两个官方没有的能力：

1. **永久删除会话**（官方只有「归档」）；
2. **删除会话末尾的若干轮对话**——保留会话 id，把聊天记录里最后几轮（一问一答）从日志里真正切掉。

## 效果

### 永久删除会话

- 侧栏任意会话行的 **「…」菜单** 里多一项 **「永久删除会话」**（垃圾桶图标）。
- 点击后弹确认框，写明「聊天记录会从磁盘上永久删除，无法恢复」。
- 确认后：
  - 会话不在宿主内存里：立即删除会话日志目录、projection cache、Workspace 记账/归档/置顶记录，侧栏行立刻消失。
  - 该会话在本进程里还活着：先 **归档并停止其运行中的工作**，把 id 记入延迟删除队列，返回 `deferred: true`；提示条说明「重启 dsh web 后会完成磁盘清理」。
- 主界面正打开着的会话不允许删除（提示先切换）。

### 删除末尾对话

- 同一菜单里多一项 **「删除末尾对话…」**；另外**每一轮的末尾**（时间/复制图标旁边）直接有 **「删除这轮及之后」** 按钮，点它就从那一轮删到末尾，不用去侧栏翻菜单。
- 对话框会列出该会话**最后 12 轮**（轮 = 一次用户提问 + 它触发的全部回答/工具调用），每行显示问/答摘要。
- 选中某一轮 = **从这一轮起到末尾全部删除**；默认选中最后一轮。
- 确认后宿主重写会话日志：保留目标轮 `turn/start` 之前的所有事件，会话 id 不变。
  - 非活动会话：**立即生效**，并刷新会话列表与投影；正在主界面打开的会话刷新后只剩保留下来的轮次。
  - 会话正开在主视图里：装了核心补丁（`plugins/core/agent-close.mjs`）后，插件先切到别的会话，调用 `agents.close()` 释放写句柄，再重写日志；完成后提示条会说明「点回原会话即可看到最新内容」。
  - 没装核心补丁（或 close 失败）：只能登记到 `pending-turns.json`，下次重启 dsh web 时自动完成（返回 `queued: true`）。
  - 从未打开过的会话：立即截断生效。
- 删掉第一轮会导致会话标题（`session/title` 在首轮里）一起消失，侧栏显示「未命名」；不想这样的话就从第 2 轮起删。

## 安装 / 更新

本插件是 `dsh-xykp` 包里的子插件，浏览器端 UI 合并进 `dsh-xykp` 的包级 `client.js`
（DSH 客户端加载器只认整包名，子路径插件不会触发浏览器 bundle）。

```powershell
# 0) 应用核心补丁（给 agents 服务加 close(sessionId)，用来释放写句柄）
node D:\AI\DeepseekHarness\plugins\core\apply-all.mjs

# 1) 部署：合并 client bundle + 复制宿主/客户端代码到 profile
pwsh -File D:\AI\DeepseekHarness\plugins\storage\session-delete\deploy.ps1

# 2) 重启 dsh web 生效
pwsh -File D:\AI\DeepseekHarness\restart-dsh.ps1
```

注册位置：`home\profiles\web\node_modules\dsh-xykp\cordis.patch.yml` 里应有一行

```yaml
- id: dsh-session-delete
```

部署目标：

- 宿主 / 客户端源码：`home\profiles\web\node_modules\dsh-xykp\storage\session-delete\`
- 浏览器 bundle：`home\profiles\web\node_modules\dsh-xykp\client.js`（由 `D:\AI\DeepseekHarness\tools\merge-session-delete-client.mjs` 从 `plugins\client.js` + 本插件的 `lib\client.js` 合并）

改完客户端代码（`lib/client.js`）必须重新合并 bundle 并重启 dsh web 才会重新加载。重启前不要刷新页面：刷新会加载新 bundle 而宿主还是旧代码。

## 配置（可选）

在 `home/profiles/web/cordis.patch.yml` 里给该条目加 `config`：

```yaml
- id: dsh-session-delete
  config:
    sessionsRoot: 'D:\AI\DeepseekHarness\home\sessions'
    projectionCacheRoot: 'D:\AI\DeepseekHarness\home\storages\session_projcache\sessions'
    pendingPath: 'D:\AI\DeepseekHarness\home\storages\session-delete\pending.json'
    pendingTurnsPath: 'D:\AI\DeepseekHarness\home\storages\session-delete\pending-turns.json'
```

默认值由宿主 `dshHomePath` 服务推导。

## 删除范围

永久删除会删除：

- `<sessionsRoot>/<工作目录键>/<sessionId>/`（JSONL 日志目录，含 lease/迁移临时文件）
- `<projectionCacheRoot>/<sessionId>.json`
- `workspace.json` 里的会话记账、归档集合、置顶集合（通过 `workspaceRegistry` 的正规 API 完成）

删除末尾对话会：

- 重写 `<...>/<sessionId>/session.v4.jsonl.zstd`：第一帧只保留 header，之后按约 1 MiB 分帧保留 `turn/start` 之前的事件（原始事件行逐字保留，只重新压缩；写临时文件 + fsync + rename）。
- 删除 `<projectionCacheRoot>/<sessionId>.json`，让投影重建。
- 切割点固定在 `turn/start` 上，因此保留的日志总以完整的一轮结束（`turn/end`），不需要合成收尾事件。

两者都不会删除：

- 会话引用的附件对象（`home/attachments` 是内容寻址、跨会话共享的）
- 工作区目录里的任何项目文件
- 其他会话

## 架构

| 半边 | 文件 | 作用 |
| --- | --- | --- |
| 宿主 | `lib/index.js` | 注册 Typert Remote 命名空间 `sessionDelete`，暴露 `deleteSession` / `previewTurns` / `deleteTurnsFrom`；执行删除、日志截断、延迟队列与启动清理 |
| 浏览器 | `lib/client.js` | `window.__ModuleLoader__` CJS 包裹；注册两个菜单项、两个对话框与提示条，调用 Remote 并刷新会话列表/投影 |

宿主 Remote 通过「`typertRemote` 绑定 + 原型上的 `remote-methods` 描述符」被网关的 SRC 回退发现，不依赖装饰器语法。

`previewTurns` 的折叠规则与 `@deepseek-ai/dsh-session-turn-outline` 的 `turnOutline` 投影同构：
每轮从 `turn/start` 开始、`turn/end` 结束；`prompt` 取该轮第一个 `source.kind === 'user'` 的
`user/message`（没有就退回本轮第一条 `user/message`）；`response` 取本轮最后一个有文本的
`assistant/message`。`turn` / `totalTurns` 等数字在 wire 上都是十进制字符串，避免依赖 number codec。

## 测试

```powershell
node test/offline.mjs   # 永久删除：离线单元测试（假 ctx + 真 cordis）
node test/tail.mjs      # 删除末尾对话：预览/立即截断/排队/启动消费/非法输入
```

`test/tail.mjs` 覆盖：轮次折叠、立即重写（seq 连续、header 不变、cache 删除）、
live 会话只登记、下次启动消费队列、目录穿越与不存在轮次的拒绝。

## 已知限制

- **轮**是删除单位，不能只删一条消息；删除一律从某一轮的 `turn/start` 起往后切。
- 打开过的会话靠核心补丁 `agents.close()` 即时释放写句柄；没装补丁的宿主只能排队到重启后。删除后客户端会切到别的会话，点回原会话即可看到截断后的内容（客户端 resident 实例需要重建）。
- 上下文压缩（`compaction/prune`）会把旧回答的正文从日志里剪掉，这类轮次在对话框里显示「暂无可预览的回答」，但不影响删除。
- 删除第一轮会一并删掉 `session/title`，标题变「未命名」。
- 不清理附件对象与图像 offload 产生的媒体文件。
- 插件被禁用时延迟队列保留，重新启用后继续。
