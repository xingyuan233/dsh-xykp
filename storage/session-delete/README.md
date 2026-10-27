# dsh-session-delete（dsh web 会话永久删除插件）

给 DeepSeek Harness 的 Web 界面补上「永久删除会话」功能——官方只有「归档」，没有删除。

## 效果

- 侧栏任意会话行的 **「…」菜单** 最下方多一项 **「永久删除会话」**（垃圾桶图标）。
- 点击后弹出确认框，写明「聊天记录会从磁盘上永久删除，无法恢复」。
- 确认后：
  - 正常（会话不在宿主内存里）：立即删除会话日志目录、projection cache、Workspace 记账/归档/置顶记录，侧栏行立刻消失。
  - 该会话在本进程里还活着（本进程创建过、聊过、跑过回合）：宿主无法安全地原地删文件（JSONL 写入句柄属于创建它的 fiber），于是先 **归档并停止其运行中的工作**，把 id 记入延迟删除队列，返回 `deferred: true`；提示条会说明「重启 dsh web 后会完成磁盘清理」，下次宿主启动时插件自动物理删除。
- 主界面正打开着的会话不允许删除（会提示先切换），避免主视图停留在已删除的会话上。

## 安装 / 更新

```powershell
# 1) 把插件复制进 profile 的 node_modules
pwsh -File D:\devoding\dsh-session-delete\deploy.ps1

# 2) 确认 profile 的 cordis.patch.yml 末尾有这一行（只需一次）：
#    - insert:
#        - id: dsh-session-delete
#          name: 'dsh-session-delete'

# 3) 重启 dsh web
pwsh -File D:\AI\DeepseekHarness\restart-dsh.ps1
```

改完客户端代码（lib/client.js）后必须重启 dsh web 才会重新加载（本机约定）。

## 配置（可选）

在 `home/profiles/web/cordis.patch.yml` 里给该条目加 `config`，三个路径都可以覆盖：

```yaml
- id: dsh-session-delete
  config:
    sessionsRoot: 'D:\AI\DeepseekHarness\home\sessions'
    projectionCacheRoot: 'D:\AI\DeepseekHarness\home\storages\session_projcache\sessions'
    pendingPath: 'D:\AI\DeepseekHarness\home\storages\session-delete\pending.json'
```

默认值由宿主 `dshHomePath` 服务推导。

## 删除范围

会删除：

- `<sessionsRoot>/<工作目录键>/<sessionId>/`（JSONL 日志目录，含 lease/迁移临时文件）
- `<projectionCacheRoot>/<sessionId>.json`
- `workspace.json` 里的会话记账、归档集合、置顶集合（通过 `workspaceRegistry` 的正规 API 完成）

不会删除：

- 会话引用的附件对象（`home/attachments` 是内容寻址、跨会话共享的，按引用计数回收不在本插件范围内）
- 工作区目录里的任何项目文件
- 其他会话

## 架构

| 半边 | 文件 | 作用 |
| --- | --- | --- |
| 宿主 | `lib/index.js` | 注册 Typert Remote 命名空间 `sessionDelete`，暴露 `deleteSession(sessionId)`；执行删除、延迟队列与启动清理 |
| 浏览器 | `lib/client.js` | `window.__ModuleLoader__` CJS 包裹；注册菜单项、`shell.overlay` 确认框与提示条，调用 Remote 并刷新会话列表 |

宿主 Remote 通过「`typertRemote` 绑定 + 原型上的 `remote-methods` 描述符」被网关的 SRC 回退发现，
不依赖装饰器语法；这是与 `dsh-onebot-qq` 的 settings-remote 相同的路子，但协议模块改为
「裸导入失败时以 dsh 入口为锚点 `createRequire.resolve`」，避免 profile 插件解析不到
`@deepseek-ai/dsh-typert-protocol` 时静默降级。

## 已知限制

- 正在主界面打开的会话不能删（先切换）。
- 本进程内聊过的会话删除是「先归档、重启后落盘」，重启前在「全部对话（显示已归档）」里仍可看到。
- 不清理附件对象与图像 offload 产生的媒体文件。
- 宿主重启后才会清理延迟队列；插件被禁用则队列保留，重新启用后继续。
