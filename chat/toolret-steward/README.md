# dsh-tool-result-steward

工具结果的去留管家。每步的工具结果，模型当步已经看过了；下一步要不要留着，由它自己决定。

## 做什么

1. 工具结果落地（≥ `minChars`，或含图片）→ 记进 pending，**先不动**；
2. 下一步模型会看到一条通知（`systemPrompt.context` 追加在对话末尾），列出这些结果和序号；
3. 模型可以：
   - `steward(keep: [1])` —— 保留原文；
   - `steward(summarize: [{ index: 2, text: "..." }])` —— 换成自己的概括；
   - 不表态 —— 默认丢弃；
4. 下一条 assistant 消息出现时执行：没保留的替换成占位（原文仍在会话日志里）：
   - 普通结果 → `⟨dropped⟩ read C:\a.md (5811 chars) — re-read/rerun if you need it`
   - 图片 → `⟨dropped image⟩ read_image C:\b.png`
   - `headTail` 里的工具 → 保留头 `headChars` + 尾 `tailChars`，不参与决策

## 为什么不问也能量

通知是**搭在本来就要发给模型的那次请求上**的（不是额外一轮对话）；默认丢弃时模型不用做任何事。

## 配置（profile `cordis.patch.yml` 那一行）

```yaml
- insert:
    - id: toolret-steward
      name: 'dsh-toolret-steward'
      config:
        mode: blacklist                        # 管「预设」：blacklist = 名单外的都生效；whitelist = 只有名单内的生效
        presets: []                            # 名单内容；空 = 全部预设
        tools: [ pwsh, job_output, web_fetch ] # 永远不碰：这些工具只留头尾，不参与决策
        minChars: 2000                         # 小结果不打扰
        headChars: 1200
        tailChars: 400
        emptyStub: true                        # 丢弃时换成空串（0 token，已实测上游接受）
```

- **`mode` / `presets` 管的是「哪些预设生效」**：`blacklist` 时对名单**以外**的预设生效，`whitelist` 时只对名单**以内**的生效；名单为空 = 全部。
- **`tools` 是「不碰的名单」**，两种模式下含义一样：这些工具的结果只做头尾保留，不参与决策。

`emptyStub: true` 时丢的结果是**空内容**（不是 `⟨dropped⟩` 占位）。实测上游接受空 `tool_result`，
模型的 tool-call 参数还在，需要细节时可以重读/重跑。想要「丢的时候还留一行线索」就设成 `false`。

## 时机（为什么这样设计）

- 结果落地时**不折叠**：模型这一步还要看原文；
- 下一条 assistant 消息出现时**才折叠**：说明模型已经看过并回应了上一批结果；
- 只处理「上一步」的结果，改动落在历史末尾 → 前面的前缀缓存不受影响；
- 折叠用 `surfaceOp=replace`（跟官方 tool-result-pruner 同一套），tool-call / tool-result 配对不断，原文留在会话日志里可回放。
- **通知不进历史**：它是每步渲染进请求的临时上下文（实测会话日志里没有任何 `[steward]` 消息），所以不会累积。

## 已知限制

- 模型要过一条通知才能表态，短结果（< minChars）直接跳过，连通知都不发；
- `summarize` 的内容上限 4000 字符（超出截断）；
- 收尾时如果模型只回文本不调工具，pending 会按「默认丢弃」处理；
- `emptyStub` 是全有全无：空内容不留任何线索，模型可能要多花一次调用重读；
- 依赖宿主事件 `session/event`（`assistant/message`、`tool/result`）与 `systemPrompt.context`，DSH 大版本升级后要复核。

## 文件

- `lib/index.js` —— 插件主体（挂 agent、注册 `steward` 工具、通知、折叠时机）
- `lib/fold.js` —— 表面节点操作（列 surface、找结果、替换）
