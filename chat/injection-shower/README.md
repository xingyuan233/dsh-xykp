# injection-shower

把**每轮真正拼进请求的注入内容**收在一个只读页面上，省得靠猜「她到底看到了什么」。

## 抓什么

| 通道 | 来源 | 典型内容 |
|---|---|---|
| `systemPrompt.context` | 每轮追加到对话末尾的上下文 | `memory-layer` 的【相关记忆】、`tooldesc-control` 的上下文重贴 |
| `systemPrompt.section` | 进系统提示词的段落 | `tooldesc-control` 的预设要点/工具清单重贴 |
| `agent/inbox/inserted` | 收件箱插入的消息 | `token-reporter` 的超限提醒、`tooldesc-control` 的工具变更通知 |

实现方式是在每个 agent 上挂 `system-prompt/assemble` 中间件（`await next()` 之后旁路记录），
以及 `agent/inbox/inserted`；**不改任何注入内容**，只记录最近 N 轮。

## 看哪里

```
http://127.0.0.1:3080/injection-shower
```

页面每 2 秒刷新，按会话分卡片：最新一轮展开，旧的折叠；收件箱通知单独一组。

## 配置（`HOME\xykp\config.yml`）

```yaml
injection-shower:
  maxSnapshots: 20   # 每个会话保留几轮 assembly
  maxNotices: 30     # 每个会话保留几条收件箱消息
  maxChars: 4000     # 单段文本最长保留多少字（超了截断）
```

数据只在内存里，宿主重启就清空；够看「刚才那轮注入了什么」。
