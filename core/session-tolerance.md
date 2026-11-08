# 补丁：会话日志容错（session-tolerance）

## 背景

`dsh-session-persistence-jsonl` 在列举会话时，只要**有一个**日志文件读取失败
（典型场景：归档目录改名后 header id 对不上、文件被截断），整个 `list()` 就抛错，
于是 workspace / session-controller / directoryPicker 一串服务全部挂掉 —— 一个坏文件换掉整个界面。

## 改了什么

`dsh-session-persistence-jsonl/lib/index.js` 里那个 catch 块：

```js
// 官方版：只放过「格式不支持 / 损坏」两种，其余一律 rethrow
} catch (error) {
    if (error instanceof SessionFormatUnsupportedError || error instanceof SessionPersistenceCorruptionError) return {
        selected,
        metadata: void 0
    };
    throw error;
}

// 补丁版：整块兜住，打一行日志后跳过这个文件
} catch (error) {
    // [local patch] A single unreadable session log must never take down the
    // whole session/workspace registry. Log it and skip just that artifact.
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`dsh: warning: skipping unreadable session log ${selected.sourcePath}: ${reason}`);
    return {
        selected,
        metadata: void 0
    };
}
```

只动这一个 catch 块，周边逻辑不碰。

## 怎么验证

日志里出现：

```
dsh: warning: skipping unreadable session log <路径>: <原因>
```

同时会话列表照常返回（少那一条，其余都在）。

## 怎么还原

这个补丁是在「已经装好的版本」上直接打的，没有原始备份，
所以模块里实现了一个 `revert()`（把补丁块反推回官方 block）。跑：

```
pwsh -File plugins\core\apply-all.ps1 -Restore
```

即可退回官方行为。升级 dsh 后重跑 `apply-all.ps1` 会自动重新打上。

