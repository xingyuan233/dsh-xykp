# chat/toolret-forget

让模型自己决定「哪些工具结果不留在下一轮」。

```js
forget_tool_results({ step: 1, forget: [1, 3] })      // 忘掉第 1、3 条
forget_tool_results({ step: 1, keep: [2] })           // 只留第 2 条，其余忘
forget_tool_results({ step: 2, tool: 'bili_search' }) // 上上步里某个工具的结果
```

- 序号从 **1** 开始，按「最近一个已经跑完的步骤」里的调用顺序排
- 不填 `forget` / `keep` 就全忘
- 被忘掉的结果会变成 `⟨已折叠⟩ 这条工具结果没有保留`
- **这个工具自己的结果也会被折叠**，所以「选择本身」不会留到下一轮
  （assistant 消息里的调用参数还会在，很小；要连它一起藏得改 assistant 消息，会牵连同一批别的调用，暂时不做）

## 它怎么做到的

用的是会话表面的 `surfaceOp: 'replace'`（跟官方 `tool-result-pruner` 同一套）：

1. 先 append 一条 `compaction/prune`，记下被遮蔽节点的 token 估价
2. 再 append 一条**同 callId** 的 `tool/result`，把原节点替换成占位

这样 tool-call / tool-result 的配对不会断，原文也仍然在会话日志里（可回放、可审计）。

## 和其他工具联动

两种方式：

1. **按工具名默认不保留**（回合结束后生效，本轮里模型还能正常用到结果）：

```yaml
config:
  autoForget: [bili_search, bili_comments]   # 这些工具的结果，回合结束就折叠
  # autoForgetAll: true                     # 或者干脆全都不留
```

2. **工具自己声明**：某个工具返回的文本以 `⟨fold⟩` 开头，这条结果一落地就会被折叠
   （适合「只给模型看一眼，用完不该留」的工具）。写自己的工具时 return `` `${SELF_MARK} ...` `` 即可。

## 限制

- 只能折叠**已经有结果**的步骤；正在跑的那一步不算
- 还做不了「撤销折叠」（原文在日志里，但需要单独的恢复工具）
- 只挂在配置里的预设上（默认 `alive`），别的预设看不见这个工具

## 配置

```yaml
- insert:
    - id: toolret-forget
      name: 'dsh-xykp/chat/toolret-forget'
      config:
        presets: [alive]
```

## 自测

```powershell
node test/toolret-forget-test.mjs
```

离线跑（不启宿主），覆盖：按序号折叠、占位替换后 `callId` 仍在（配对不断）、`keep` 语义、重复折叠被跳过。
