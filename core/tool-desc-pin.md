# tool-desc-pin · 工具说明变更不要重写请求开头

## 挨的哪个文件

`npm\node_modules\@deepseek-ai\dsh-llm\lib\types\content.js` → `projectToolUpdates(messages, tools, toolUpdate, history)`

## 为什么要打

工具 `description` 一改，DSH 就把请求开头的 `tools` 整段换成新定义 → 前缀缓存全废 → 一整轮上下文按全价重算。

## 改动（两处，都在 `projectToolUpdates` 里）

1. **钉住开头**：路由没声明 `toolUpdate` 时（`deepseek-account/deepseek-flash` 就是这种），只要拿到会话历史基线，就按 `addition-only` 处理。
   请求开头永远是「这个会话第一次发出去的那套定义」；新工具（比如 tool-gate 推出来的）照旧靠 tool-addition 激活。
2. **把改动说清楚**：比对当前声明和钉住的那份，只把**改了的那个**工具的新说明拼成一条 `developer` 消息追加到消息末尾
   （id 固定 `ykp-tool-desc-notice:<名字>`，纯 text 块，不会被 tool-addition 过滤器吃掉）。模型以这条里的说明为准。

## 怎么验证

- `pwsh -File apply-all.ps1 -Check` 里 `dsh-llm/tool-desc-pin` 显示「已应用」
- 重启后同一会话连发两轮，看「本轮用量」的缓存命中回到 95%+
- 真改了某个工具说明时，下一轮对话末尾会多一条「### 工具说明已更新：<名字>」，而工具表里的旧定义不变

## 怎么还原

`pwsh -File apply-all.ps1 -Restore`（本补丁带 `revert()`，没有备份也能反推原文），之后重启 dsh web。

## 注意

- 说明变更的那条消息现在是每个请求带一次（内容稳定，尾巴这点 token 也能命中），没做「只推一次」的持久化。
- 参数结构真变了（不是文案），模型仍按旧 schema 调用——这种改动别指望本补丁，老老实实开新会话。
