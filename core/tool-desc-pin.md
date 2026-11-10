# tool-desc-pin · 工具说明变了只通知，不重写请求开头

## 挨的哪个文件

`npm\node_modules\@deepseek-ai\dsh-tools\lib\index.js` → `ToolRegistry.register(definition)`

> 2026-11-10 改版。旧版把每个工具的说明按名字**全局冻死在第一次注册的版本**并落盘
> （`home\xykp\tool-desc-pin\frozen.json`），结果是新会话也一直拿到旧说明。
> 现在全局冻结已删掉，前缀固定改成**按会话**做（由 `tooldesc-control` 在会话第一轮
> 装配时给 tools / sections 拍快照，见插件 README）。

## 为什么要打

工具 `description` / `parameters` 一改，DSH 会把请求开头的 `tools` 整段换成新定义 → 前缀缓存全废。
所以前缀必须按会话固定；但固定之后模型看不到新说明，得有人把「变了」这件事告诉模型。
本补丁负责**尽早发现变化**（注册那一刻，比下一次装配更早）。

## 改动

在 `register()` 开头插一段监视逻辑（不改 `definition`，不写任何冻结文件）：

1. 维护 `globalThis.__ykpToolLive`（name → 最新 `{description, parameters}`），
   给被门控工具的下一次解锁注入用。
2. 同名工具再注册时，如果 `description` 或 `parameters` 变了，把**完整**的新定义记进
   `globalThis.__ykpToolDescChanges`（`{at, name, builtin, before, after, params}`；
   `params` 只在参数变化时才有值；最多保留 80 条）。
3. 顺手追加一行到 `home\xykp\tool-desc-pin\changes.log`（纯诊断，不影响行为）。

## 配合方（tooldesc-control）

- **非门控工具**：说明/参数变了 → 下一条用户消息进来时，插件把
  「〔工具说明已更新 · 名字〕+ 完整新说明（参数变了再带参数 JSON）」插到本轮开头；
  请求开头的 tools 定义保持不变，缓存照样命中。
- **被 control 接管（门控规则 / `tool:<名字>` 注记）的工具**：不发这条通用通知；
  它们本来就不在 tools 列表里，等下一次解锁注入时直接用 `__ykpToolLive` 里的新定义。
- **新会话**：第一次请求直接按当前注册表取前缀，不补发历史变更通知。

## 怎么验证

- `node plugins\core\apply-all.mjs` 里 `dsh-tools/tool-desc-pin` 显示「已应用」
- 重启后开一个新会话：工具说明是**当前最新**的，不是旧会话冻住的那份
- 同一会话里改名某个工具说明 → 下一轮开头出现「〔工具说明已更新 · 名字〕…」，
  再看本轮请求开头的 tools 定义没变
- 门控工具改名后不发该通知；下一轮关键词解锁时，注入的说明是新的

## 怎么还原

`pwsh -File apply-all.ps1 -Restore`（本补丁带 `revert()`，没有备份也能反推原文），之后重启 dsh web。
