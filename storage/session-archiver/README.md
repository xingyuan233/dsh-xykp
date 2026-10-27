# dsh-session-archiver

自动归档（清单里的 `storage/session-archiver`）：**启动时跑一次 + 每 12 小时跑一次**，
把长时间没人动的会话归档掉（不是删除）。

## 规则

扫描范围固定：`<DSH_HOME>/sessions`（会话落盘目录），按工作区表逐个会话判断：

1. **工作区命中忽略表** → 整片跳过（默认 `alive-workspace`）
2. **会话名 / session id 命中忽略表** → 跳过（支持通配符，如 `test-*`）
3. **已经归档过** → 跳过
4. **拿不到最后活动时间** → 保守跳过
5. 距离最后活动超过 `idleDays`（默认 3 天）→ **归档**

「归档」走宿主自己的 `ctx.workspaceRegistry.archiveSession()`：

- 归档后会话从默认列表消失、内容完整、可以恢复
- 还在活动的会话宿主会拒绝（`WorkspaceActiveSessionError`），我们只记一笔跳过
- 不自己改 `workspace.json`

## 时间口径

最后活动时间 = 会话日志文件（`session*.jsonl` / `.zstd`）的 **mtime**，取该会话目录里最新的那个。

## 配置

```yaml
- id: session-archiver
  name: dsh-session-archiver
  config:
    ignoreWorkspaces: ['alive-workspace']   # 名字或路径，支持 glob
    ignoreSessions: []                       # 名称 / session id，支持通配符
    idleDays: 3
    intervalHours: 12
    dryRun: false
    sessionsRoot: ''                         # 空 = <DSH_HOME>/sessions
```

## 异步

全异步（`fs/promises`），每个会话之间 `setImmediate`，不阻塞主线程。

## 自测

```powershell
node test/plan-test.mjs
```

覆盖：闲置判定、工作区忽略、通配符忽略、已归档跳过、缺时间保守跳过、活动时间采集。
