# chat/preset-binder

维护一张「预设 → 会话」的实时表：`<DSH_HOME>/storages/preset-binder.json`。

## 表里有什么

```json
{
  "version": 2,
  "updatedAt": "2026-10-26T21:40:00.000Z",
  "presets": {
    "alive": {
      "active": "session-29350911-…",
      "name": "千歌",
      "sessions": {
        "session-29350911-…": {
          "title": "千歌 (1)",
          "provider": "deepseek-account",
          "model": "deepseek-flash",
          "running": true,
          "startedAt": "2026-10-26T21:39:58.000Z",
          "endedAt": null,
          "lastActivityAt": "2026-10-26T21:39:58.000Z",
          "turns": 13,
          "tokens": {
            "uncachedInput": 1307,
            "cacheRead": 1254144,
            "cacheWrite": 0,
            "output": 65029,
            "total": 1320480
          },
          "context": { "window": 1048576, "pressureTokens": 176121 }
        }
      }
    }
  }
}
```

- `running`：这一轮对话还在不在跑；没跑完时 `endedAt` 是 `null`（旧值不冒充完成时间）
- `startedAt` / `endedAt`：这一轮的开始 / 完成时间
- `tokens` / `context` / `title` / `provider` / `model` / `turns`：全部来自 DSH 的 session projection，
  在内存里直接读，不用再去翻会话日志
- `active`：这个预设下「最后活动时间」最新的那个会话，别的模块（记忆、刷B站、主动搭话）按它投递

## 事件从哪来

- 消息进收件箱（`agent/inbox/inserted`）→ 记一次，标记 `running`
- 状态变化（`agent/status`）→ 更新 `running` / `endedAt`
- 跑着的会话每 3 秒刷一次 token（`refreshMs` 可调）
- 每 30 秒刷新一次预设显示名

## 配置

```yaml
- insert:
    - id: preset-binder
      name: 'dsh-xykp/chat/preset-binder'
      config:
        ignore: [standard, ptc, minimal, cordis]
        # track: []            # 非空时只跟这些预设
        # maxSessions: 30      # 每个预设最多留多少个会话
        # refreshMs: 3000
        # tablePath: …
```

## 给别的模块用

```js
import { readTable, activeSession, sessionInfo } from 'dsh-xykp/chat/preset-binder/table'
```

读文件就行，不用等这个插件起来之后再查服务。

## 自测

```powershell
node test/preset-binder-test.mjs
```

离线跑（不启宿主），覆盖：表字段是否齐全、跑着时 `endedAt` 为 `null`、结束后 `running=false` 且有结束时间、token 合计、`active` 指向。
