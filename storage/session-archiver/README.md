# dsh-session-archiver

自动归档（清单里的 `storage/session-archiver`）：**启动时跑一次 + 每 12 小时跑一次**，
把长时间没人动的会话归档掉（不是删除）。

## 规则

扫描范围固定：`<DSH_HOME>/sessions`（会话落盘目录），按工作区表逐个会话判断：

1. **工作区命中忽略表** → 整片跳过（默认 `alive-workspace`）
2. **会话名 / session id 命中忽略表** → 跳过（通配符如 `test-*`，正则写 `re:^onebot-`）
3. **预设 id / 预设名命中忽略表** → 跳过（`alive`、`千歌`、`re:^qq-` 都行）
4. **已经归档过** → 跳过
5. **拿不到最后活动时间** → 保守跳过
6. **配了忽略预设、但这条会话查不到预设** → 保守跳过（原因 `preset-unknown`），绝不误伤
7. 距离最后活动超过 `idleDays`（默认 3 天）→ **归档**

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
    ignoreSessions: []                       # 名称 / session id，通配符；正则写 re:...
    ignorePresets: []                        # 预设 id / 预设名，通配符或 re:...
    idleDays: 3
    intervalHours: 12
    dryRun: false
    sessionsRoot: ''                         # 空 = <DSH_HOME>/sessions
```

## 标题和预设从哪来

- 最后活动时间：会话日志文件的 mtime（见上）
- 会话标题 / 预设 id：宿主的投影缓存 `<DSH_HOME>/storages/session_projcache/sessions/<id>.json`（只读）
- 预设展示名：`<DSH_HOME>/profiles/<profile>/presets/<id>/preset.yml` 顶层的 `name:`

投影缓存读不到时：标题回退到活动会话对象，预设为空 → 配了 `ignorePresets` 就按 `preset-unknown` 保守跳过。

## 异步

全异步（`fs/promises`），每个会话之间 `setImmediate`，不阻塞主线程。

## 自测

```powershell
node test/plan-test.mjs
```

覆盖：闲置判定、工作区忽略、通配符/正则忽略、预设忽略、已归档跳过、缺时间保守跳过、活动时间采集。
