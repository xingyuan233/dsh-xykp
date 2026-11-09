# injection-shower

把**每轮真正拼进请求的注入内容**收在一个只读页面上，省得靠猜「她到底看到了什么」。

## 抓什么

| 通道 | 来源 | 典型内容 |
|---|---|---|
| `systemPrompt.context` | 每轮追加到对话末尾的上下文 | `memory-layer` 的【相关记忆】、`tooldesc-control` 的上下文重贴 |
| `systemPrompt.section` | 进系统提示词的段落 | `tooldesc-control` 的预设要点/工具清单重贴 |
| `agent/inbox/inserted` | 收件箱插入的消息 | `token-reporter` 的超限提醒、`tooldesc-control` 的工具变更通知 |

实现方式是在每个 agent 上挂 `system-prompt/assemble` 中间件（`prepend: true`，在 `await next()` **之前**留一份门控前的工具表，
之后记录真正发出去的版本），以及 `agent/inbox/inserted`；**不改任何注入内容**，只记录最近 N 轮。

## 提示词段落（section）状态

`tooldesc-control` 的「系统提示词懒加载规则」可以锁**任意段落**（`tool:workflow`、`tool:goal` 甚至非 `tool:` 的段落）。所以 assemble 时用 `prepend` 和门控后的结果对比：

- **初始**（绿）：现在就在提示词里、且没被摘过；
- **解锁**（蓝）：现在在提示词里、但历史上被摘过（说明关键词命中后被放开）；
- **锁定**（灰）：这次被摘掉的段落（文本取自门控前，照样能展开看）。

## 工具表

状态只分三种（面板和页面一致，颜色：初始绿 / 解锁蓝 / 锁定灰）：

- **初始**：`await next()` 之后 `assembly.tools` 里的结果，即真正发给模型的冻结表（tooldesc-control 门控后的）；
- **解锁**：读 `HOME\xykp\tooldesc-control\state.json` 里本会话命中过关键词解锁的工具名（历史），只会通过通知/描述注入，不进工具表；
- **锁定**：`prepend` 旁路拿到、但既不在冻结表、也没解锁过的（含被门控掉的）。

Web 聊天里的「消息前缀」面板（`client.js`）标题是「N 段 · M 工具」，正文两个默认折叠的分组：

- **工具**：`初始 / 解锁 / 锁定` 计数，逐条工具点开看描述；
- **系统提示词**：`初始 / 解锁 / 锁定` 逐段标注，被锁的段落也会列出来（灰）。

工具描述不跟着 3 秒轮询走，面板展开时按需从 `/injection-shower/tools?session=<id>` 拉。

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

数据落盘在 `HOME\xykp\injection-shower\state.json`（宿主重启后恢复）；够看「刚才那轮注入了什么」。
