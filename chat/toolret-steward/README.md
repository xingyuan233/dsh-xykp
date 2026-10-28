# dsh-tool-result-steward

工具结果的去留管家。每步的工具结果，模型当步已经看过；下一步留不留，由它自己决定。

## 做什么

1. 工具结果落地（≥ `minChars` 或含图片）→ 在最前面打上 `[#7]` 标签，同时记进 pending 和召回档案（**先不折叠**）；
2. 下一步模型看到一条很短的通知（`systemPrompt.context` 渲染进请求，不进历史）：
   `[steward] 上一步结果 #7 #8 默认折叠；keep永久保留,summarize概括保留,recall拿回之前`
3. 模型可以：
   - `steward(keep: [7])` —— 保留原文（永久，之后不会再进 pending）；
   - `steward(summarize: [{ id: 7, text: "..." }])` —— 换成自己的概括；
   - `steward(recall: [7])` —— 当场把这几次的原文放进这次调用的结果里（先查内存档案；档案没有就回扫会话日志找 `[#7]` 原节点）；**不动历史节点**，所以不会废掉前缀缓存。这份结果跟直接读一样**带新的 `[#id]`**：下一步默认折叠，想留就 `keep`，想压短就 `sublines`/`subbytes`/`summarize`；
   - `steward(sublines: [{ id: 7, offset: 24, limit: 20 }])` / `steward(subbytes: [{ id: 7, offset: 0, limit: 2000 }])` —— 只保留 #7 从 offset（0 基）开始的至多 limit 行 / 字节，不用自己写概括；
   - `steward(silence: 2)` —— 接下来 2 批结果不弹通知（结果照旧默认折叠），倒计时走完后第一条通知带「（silence 已结束）」；
   - 这些调用可以和别的工具调用放在**同一条消息**里，不额外占一轮；
   - 不表态 —— 默认折叠。
4. 下一条 assistant 消息出现时执行：没保留的替换成
   `⟨dropped #7 pwsh Get-ChildItem · 12345 chars⟩`

id 是**全局单调**的（不是每轮从 1 数），并且打在**结果本体**上，所以隔很多步也能准确引用。

## 特殊 id（不想翻编号时用）

- `0` —— **上一步的全部**结果：`keep:[0]` 全留、`recall:[0]` 全召回、`sublines/subbytes` 用 `id:0` 就是每条都切；
- `-1` / `-2` / `-3` —— 按 id **倒序**取最近第 1/2/3 条（`-1` = 最新那条结果，不限于上一步）；档案里没有的负数原样保留，回执里写 `未找到：#-5`；
- 正数照旧，就是结果本体上的 `[#id]`。

## 为什么不问也能量

通知是搭在本来就要发给模型的那次请求上的（不是额外一轮对话）；默认折叠时模型不用做任何事。

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
        emptyStub: false                       # true = 折叠成空串；默认 false 留 ⟨dropped #id⟩ 线索
        archiveEntries: 80                     # 召回档案保留多少条（FIFO）
```

- **`mode` / `presets` 管的是「哪些预设生效」**：`blacklist` 时对名单**以外**的预设生效，`whitelist` 时只对名单**以内**的生效；名单为空 = 全部。
- **`tools` 是「不碰的名单」**，两种模式下含义一样：这些工具的结果只做头尾保留，不参与决策。
- `emptyStub` 默认 `false`：留一行 `⟨dropped #id⟩`，模型才不会把「被折叠」误读成「工具失败」（失败会带错误码）。

## 时机（为什么这样设计）

- 结果落地时**不折叠**，只在结果前面加 `[#id]`：模型这一步还要看原文；
- 下一条 assistant 消息出现时**才折叠**：说明模型已经看过并回应了上一批结果；
- 只处理「上一步」的结果，改动落在历史末尾 → 前面的前缀缓存不受影响；
- 折叠用 `surfaceOp=replace`（跟官方 tool-result-pruner 同一套），tool-call / tool-result 配对不断；
- **召回不走 replace**：直接把这几次的原文放进 `steward` 工具的结果里（历史节点一律不动）。
  替换老节点等于改写前缀，后面整段缓存全废；折叠只动「上一步」的末尾几条，代价小得多；
- **通知不进历史**：每步渲染进请求的临时上下文，所以不会累积。

## 已知限制

- 每步只有被跟踪的结果（≥ `minChars` 或含图片）才有 id；
- 召回先查内存档案（默认 80 条 FIFO）；档案没有（比如宿主重启过）就**顺序扫一遍会话日志**找 `[#id]` 原节点——日志保留被替换前的完整事件，所以重启后也能找回。代价是单次 O(事件数)，大日志几百毫秒到几秒，且每个 id 只扫一次（找到后就进档案）；
- 召回结果与直接读一样带 `[#id]`，日志里也带标，重启后照样能按这个 id 找回；
- `sublines` / `subbytes` 和 keep/summarize 一样只作用于「上一步」的 pending 结果；
- `0` 依赖最近一次落定的批次（`lastBatch`）：宿主刚重启、还没有新结果时 `0` 解析不出 id（正数仍能走日志兜底），下一批结果落地后就恢复；
- `summarize` 内容上限 4000 字符（超出截断）；
- 模型只回文本、不调工具时，pending 按「默认折叠」处理；
- 依赖宿主事件 `session/event`、`systemPrompt.context` / `systemPrompt.section`，DSH 大版本升级后要复核。

## 工具定义（wire 形态）

走宿主 `defineTool`（`patches\core\tool-wire-slim.md`）：发给模型的只有一行
`params: (keep?; summarize?<[{id,text}]; recall?; sublines?<[{id,offset,limit}] lines; subbytes?<…> bytes; silence?)`
加两行散文，完整 JSON Schema 留在闭包里做校验。拿不到宿主 `@deepseek-ai/dsh-tools` 时自动退回
「直接发完整 JSON Schema」（自测/离线环境），不会把 DSL 原样发出去。

## 文件

- `lib/index.js` —— 插件主体（挂 agent、注册 `steward` 工具、打标、通知、折叠与召回）
- `lib/fold.js` —— 表面节点操作（列 surface、找结果、替换）

