# dsh-session-delete（dsh web 会话永久删除）

给 DeepSeek Harness 的 Web 界面补上一个官方没有的能力：**永久删除会话**（官方只有「归档」）。

## 效果

- 侧栏任意会话行的 **「…」菜单** 里多一项 **「永久删除会话」**（垃圾桶图标）。
- 点击后弹确认框，写明「聊天记录会从磁盘上永久删除，无法恢复」。
- 确认后：
  - 会话不在宿主内存里：立即删除会话日志目录、projection cache、Workspace 记账/归档/置顶记录，侧栏行立刻消失。
  - 该会话在本进程里还活着：先 **归档并停止其运行中的工作**，把 id 记入延迟删除队列，返回 `deferred: true`；提示条说明「重启 dsh web 后会完成磁盘清理」。
- 主界面正打开着的会话不允许删除（提示先切换到其他会话）。

## 安装 / 更新

本插件是 `dsh-xykp` 包里的子插件，浏览器端 UI 合并进 `dsh-xykp` 的包级 `client.js`
（DSH 客户端加载器只认整包名，子路径插件不会触发浏览器 bundle）。

```powershell
# 1) 部署：合并 client bundle + 复制宿主/客户端代码到 profile
pwsh D:\AI\DeepseekHarness\plugins\storage\session-delete\deploy.ps1

# 2) 自检
pwsh D:\AI\DeepseekHarness\plugins\storage\session-delete\verify.ps1

# 3) 重启 dsh web 生效
pwsh D:\AI\DeepseekHarness\restart-dsh.ps1
```

`deploy.ps1` 会调用 `D:\AI\DeepseekHarness\tools\merge-session-delete-client.mjs`
把 `lib/client.js` 合并进 `plugins/client.js` 的 `sessionDeleteUI` 段，再复制到
`home\profiles\web\node_modules\dsh-xykp\`。

## 测试

```powershell
node test\offline.mjs
```

离线测试会构造一个假的 cordis host，覆盖：删除立即生效、live 会话登记延迟、
下次启动消费队列、非法 id / 不存在的会话、SRC 远程描述符等。

## 代码布局

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半边：`sessionDelete.deleteSession` 服务、删除实现、重启前消费延迟队列 |
| `lib/client.js` | 浏览器端：侧栏菜单项 + 确认对话框 + 提示条 |
| `plugins/client.js` | dsh-xykp 的包级浏览器 bundle（**生成物**：由 merge 脚本拼出，不要手改 `sessionDeleteUI` 段） |
| `deploy.ps1` / `verify.ps1` | 部署 / 自检 |
| `test/offline.mjs` | 离线自测 |
