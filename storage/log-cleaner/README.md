# dsh-log-cleaner

日志清理工具（清单里的 `storage/log-cleaner`）：**启动时跑一次 + 每 12 小时跑一次**。
超过阈值的日志，把旧的部分追加进历史日志，原文件只留最新几行。

## 它做什么

1. 扫 `<DSH_HOME>`（可配）下的匹配文件（默认 `*.log`）
2. 小于 `minBytes`（默认 30 KB）→ 跳过
3. 超过的：
   - 原文件**只保留最新 `keepLines` 行**（默认 `0` = 一行不留）
   - 其余旧内容**追加**写入历史日志
4. 历史日志按原相对路径分层，按天分文件：

   ```
   <backupRoot>/a/b/2026-10-27.log      ← 由 a/b.log 搬过去
   ```

5. 历史日志超过 `keepDays`（默认 7 天）就删
6. 全程异步（`fs/promises` + 每个文件之间 `setImmediate`），不阻塞主线程
7. 任何异常只打日志，**绝不抛**，不会把宿主拖死

## 匹配与忽略（优先级）

1. **先忽略目录**：`ignoreDirs` 命中 → 整个目录跳过（默认 `node_modules`；`backupRoot` 自身也默认跳过）
2. 再在剩下的目录里找匹配 `patterns` 的文件（多个模式取**并集**）
3. **最后忽略文件**：`ignoreFiles` 命中文件名或相对路径 → 跳过

`patterns` / `ignoreDirs` / `ignoreFiles` 都支持 glob（`*`、`?`）或 `re:正则`。

## 配置

```yaml
- id: log-cleaner
  name: dsh-log-cleaner
  config:
    root: ''                  # 空 = DSH_HOME
    patterns: ['*.log']       # 取并集，可加 're:\.txt$'
    ignoreDirs: ['node_modules']
    ignoreFiles: []
    backupRoot: ''            # 空 = <root>/logs-archive
    minBytes: 30720           # 30 KB
    keepLines: 0              # 原文件留最新几行
    keepDays: 7               # 历史保留天数
    intervalHours: 12
    dryRun: false
    maxFileMB: 64             # 单文件超过就不读（保护内存）
```

## 自测

```powershell
node test/sweep-test.mjs
```

覆盖：超限清理、原文件保留行数、历史按路径分层、追加不覆盖、`node_modules` / `ignoreFiles` / 小文件不动、过期历史删除、`dryRun`。
