# dsh-session-delete 交接文档

> 2026-11-11：已按用户要求**移除「删除末尾对话」功能**（它需要原地重写会话日志，会和其他
> 记录会话状态的插件打架）。现在这个插件只剩原本的能力：**永久删除整个会话**。
> 宿主 `/previewTurns` `/deleteTurnsFrom`、客户端轮次按钮/对话框、`pending-turns.json`
> 截断队列、核心补丁 `agent-close`/`user-footer-slot` 都已删除。

## 它做什么

侧栏会话行的「…」菜单多一项「永久删除会话」：

1. 主界面正打开该会话 → 直接拒绝（提示先切走）；确认框里没有待确认请求时不渲染。
2. 非活动会话 → `sessionPersistence` + 删目录 + 删 projection cache + 清 Workspace 记账/归档/置顶。
3. 本进程内仍活着（`agents.get(id)` 有实例）→ 归档该会话、停掉它的运行中工作、id 进
   `pending-turns.json` 同目录的延迟删除队列，宿主下次启动时前台消费，返回 `deferred: true`。

## 关键文件

| 文件 | 说明 |
|---|---|
| `lib/index.js` | 宿主半边：`SessionDeleteService.deleteSession`、`deleteNow`、Workspace 清理、延迟队列（`flushPending` 在 `apply()` 里 `await` 前执行） |
| `lib/client.js` | 客户端 UI：`sidebar.workspaces.session.menu.item` 菜单项、`shell.overlay` 确认框 + 提示条 |
| `deploy.ps1` | `tools\merge-session-delete-client.mjs` 合并 client bundle → 复制到 profile |
| `verify.ps1` | 跑 `test/offline.mjs` + 检查 profile 布局与注册行 |
| `test/offline.mjs` | 离线自测（假 cordis host；不要把测试写成需要真浏览器的 e2e） |
| `../client.js` | dsh-xykp 的包级 bundle（**生成物**，`sessionDeleteUI` 段由合并脚本维护） |

## 合并 bundle 的注意点

浏览器端只按包名加载 `dsh-xykp/client.js`，子路径插件不会触发自己的 `client.js`，所以
`lib/client.js` 必须内联进 bundle 的 `sessionDeleteUI` 段：

- 锚点：`// ===== 合并自 storage/session-delete 的浏览器端 UI（2026-10-27）=====` 到
  `      return { apply: apply, inject: inject };\n    })();`
- `node tools/merge-session-delete-client.mjs --check` 应显示「已是最新」；
- 手改 bundle 后一定要跑一次 `--check`，否则下次 deploy 会把它覆盖。

## 部署 / 重启

```powershell
pwsh deploy.ps1      # 合并 + 复制到 home\profiles\web\node_modules\dsh-xykp
pwsh verify.ps1      # 自检
pwsh D:\AI\DeepseekHarness\restart-dsh.ps1
```

改了 `lib/client.js` 只需刷新页面（bundle 是页面加载时取的）；改了 `lib/index.js` 或注册
配置要重启 dsh web。核心补丁已不需要（`plugins/core` 里没有这个插件的补丁）。

## 已知限制

- live 会话不能删，只能排队等下次启动；提示条会说明。
- 删除是物理删目录，不可恢复（确认框已写清楚）。
