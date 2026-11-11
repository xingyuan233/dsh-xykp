# dsh-prosecutor

把 `prosecutor.mjs` 变成插件（清单里的 `observer/dsh-prosecutor`）：
**宿主启动时探一下它在不在，不在就拉起来；之后每 10 分钟再探一次。**

数据（日志 / pid / state / 哈希）放在 `<DSH_HOME>/xykp/dsh-prosecutor/`。

## 关键点

- 拉起时**必须分离**（`detached: true` + `stdio` 落日志 + `unref`）—— dsh 挂了它不能跟着挂，
  它就是为「宿主挂了把它救回来」而存在的
- 插件只负责「确保它在跑」，进程本身活在宿主之外
- 探活方式：连它的锁端口（默认 `39997`），连上就算活着

## cwd 必须留在包外（2026-11-08 事故）

Windows 不允许删除/替换「某个进程的当前工作目录」。以前 `spawnDetached` 用的是
`cwd: join(script, '..')`，即 `node_modules\dsh-xykp\observer\dsh-prosecutor`。结果 `pnpm install`
想换掉 `dsh-xykp` 时，删到一半就报 `os error 32（另一个程序正在使用此文件）`，
`cordis.patch.yml / index.js / client.js / chat / comms` 被删掉，宿主直接
`skipping profile bundle "dsh-xykp"` 起不来。

现在固定 `cwd: <DSH_HOME>/xykp/dsh-prosecutor`（本来就在那儿写日志）。实测结论：

- 正在运行的 `.mjs` 文件本身**不**锁 —— 进程活着也能删掉脚本、删掉整个目录；
- 只有 cwd 会锁，而且锁的是**整条目录**，pnpm 的 swap 正好卡在这。

以后再加 detached 子进程，cwd 一律指到 `HOME` 下，不要指包目录；拉起时把
`pid / cwd / script` 打进宿主日志，出问题一眼能看出来。

## 配置

```yaml
- id: dsh-prosecutor
  name: dsh-xykp/observer/dsh-prosecutor
  config:
    port: 39997
    scriptPath: ''          # 空 = 插件包内的 prosecutor.mjs
    nodePath: ''            # 空 = 当前 node 的 execPath
    probeTimeoutMs: 1500
    intervalMinutes: 10     # 多久探一次「prosecutor 还在不在」
    afterStartWaitMs: 3000
    # 2026-10-27 新加：
    ntfyTopic: ''           # ntfy 频道（空 = 用 prosecutor 的 config.json）
    machineId: ''           # 机器标识（指令后面跟的标识要跟它一样）
    checkIntervalMinutes: 0 # 每隔多少分钟检查 DSH 存活（0 = 不主动检查）
    dshPort: 3080
    hashPath: ''            # 空 = <DSH_HOME>/xykp/dsh-prosecutor/.prosecutor-hash
    newSessionCwd: ''       # -p 开新对话用的目录（空 = <DSH_HOME>/../workspaces/default-workspace）
    dryRun: false
```

## 2026-10-27 晚加重

1. **配置全部通过环境变量传给 prosecutor 进程**（`DSH_PROSECUTOR_*`，优先级高于它的 `config.json`）
2. **配置/脚本哈希**：启动时算「prosecutor.mjs + config.json + 关键配置」的 sha256，存 `.prosecutor-hash`。
   下次启动哈希变了（或第一次没有这个文件）→ 按端口找到旧进程 kill 掉、等端口释放、再拉起新的。
   哈希没变就只探活，不动进程。
3. **消息端点**：`POST /dsh-prosecutor/send {session, text}` —— prosecutor 的 `/notify -m` 用它在宿主里
   `agent.followup(createUserMessage(...))` 把话塞进会话（带 `source.kind: plugin:dsh-prosecutor`，
   不然会话 projection 会崩，见 bili-reply 那次事故）。
4. **`/notify -p <预设>`**：先查 preset-binder 的绑定表，有 active 对话就发过去；
   查不到（`standard/ptc/minimal/cordis` 这些内置预设被 preset-binder 的 `ignore` 列表过滤，永远不进表）
   或那个预设没有绑定对话时，走 `POST /dsh-prosecutor/send {preset, text}` ——
   宿主用 `agentPresets.resolve` 验预设（不存在就回「没有这个预设」+ 可用列表），
   再 `sessionController.create({ cwd?, agentPreset })` 新开一个对话（返回 `sessionId`），
   用 `agents.get(sessionId).followup(...)` 把消息塞进去。

## 自测

```powershell
node test/ensure-test.mjs      # 探活 / 拉起 / dryRun / 哈希 / 环境变量
node test/endpoint-test.mjs    # 消息端点：发进会话、会话不在、没给消息
```

覆盖：端口探活（真开一个端口）、已在跑不重复拉起、没在跑→拉起→确认起来、拉起失败带原因、`dryRun` 不动手、
配置变了哈希就变、环境变量打包、端点 followup 带 source。

## ntfy（2026-10-30）

守护进程优先 import('dsh-ntfy')（仓库里跑退回 ../../comms/ntfy/lib/index.js），推送走 push()、指令订阅走流式 wait()；两条都拿不到才退回自带的 
tfyRequest / 原始订阅。

