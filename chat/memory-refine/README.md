# chat/memory-refine

长期记忆：关键词召回 + 每轮注入 + 自己记/自己删。宿主端从 dsh-fish-memory 1.2.6 搬来，改了这些：

## 已改（宿主端）

- 模块名 `memory-refine`（不叫 memory，避免跟别的撞）
- 两组开关（都默认关）：
  - `c.presets[presetId] = true` —— 使用记忆的预设
  - `c.sessions[sessionId] = true` —— 使用记忆的会话
  - 生效规则：谁开着都算开
- 预设绑定（`c.bindPreset`）：列在里面的预设共用一份库 `preset_<id>.json`，仍然优先于会话
- 工具改名 + 拆分：
  - `memory_ins`：插入新记忆（原 remember）
  - `memory_rm`：按 id（前缀）或原文片段删除，移进「已删除」，可撤销
  - 注入时每条前面带 `#xxxxxxxx`，头部写了「觉得没用了就 memory_rm；要更新就删旧记新」
- 每天记忆上限默认 8 → 24（配置上限 30 → 100）
- 人称不再参与：用户称呼、自己的名字都不再读取（UI 待删）

## 待改（客户端）

- 客户端产物只能一个（`dsh.client` 只认一个入口），所以 UI 统一放仓库根的 `client.js`，id 用 `dsh-xykp`
- 设置页：删「检查更新」；两块开关（预设 / 会话）；「参数」→「配置」、去掉括号解释；删「用户的称呼」、单个记忆里的「她自己叫什么」
- 功能按钮重排：导出为存档 → 导出到其他会话或预设 → 从存档导入 → 从其他会话或预设导入 → 从会话提炼并导入 → 整体修改（扩词 / 人称替换 / 自定义提示词）→ 转移到下一个对话（仅预设；一次性注入，用完即无）→ 转移到文档（概括文件，路径固定、可编辑）
- 提炼时不要单独指定模型：用当前对话的 provider / model 和预设上下文

## 数据位置

沿用原来的 `home\fish-memory\`（`preset_<id>.json` 是预设池），配置 `home\fish-memory-config.json`。
切换时会把 `presets.alive` 置为 `true`，免得现有记忆停摆。

## 2026-10-27 · 客户端两处小修（`plugins/client.js`）

1. **导出存档后「从存档导入」的列表不刷新**：原来 `/archive/list` 只在整页 `load()` 里拉一次，
   导出成功只改提示文字 → 她得切一下窗口焦点（focus 重读）才看到新文件。
   现在把列表拉取抽成 `拉存档列表()`，`load()` 和「导出」成功回调都调它。
2. **记忆列表 / 已删掉的太长**：跟「最近一次召回」一个套路，各自装进可滚动框
   （`maxHeight` + `overflowY: auto` + 细边框，圆角 6）——
   - 记忆列表：`maxHeight: 360`
   - 「已删掉的」回收站：`maxHeight: 260`
   - 「被取代的」：`maxHeight: 260`
   工具条 / 检索框 / 确认条都在框外，不会被滚走（「不会淡的」那个折叠分组算列表内容，
   跟着列表一起在框里滚）。

## 2026-10-27 · 交接历史保留 + memory_movctx

1. **概括不再「用完就删」**：`/transfer/next` 生成后同时记进配置的 `transferHistory`（带全文），
   注入成功只标 `usedAt` / `session`，`transferNext` 照旧清空 —— 「只吃一次」不变 ✓
   设置页「鱼的记忆」里能看到全文、能手动删（接口 `/transfer/history`、`/transfer/history/delete`）。
   最多留 40 份，超了先丢「已经注入过」的最老的。
2. **新工具 `memory_movctx`**（全局注册，不用会话开着记忆）：把当前对话压成交接 →
   排给下一个新对话 → 用同一预设 / 模型 / 工作区 `ctx.agents.create` 一个新会话，
   再 `followup` 让它自己开跑。参数：`extra` 额外交代、`note` 新对话第一句、
   `start=false` 只建不跑、`preset` 换预设。交接注入还是走原来「新会话第一轮认领」那套，
   所以预设得绑记忆（`bindPreset`）才有交接效果。
3. 顺带：`chat/token-reporter` 加了 `prompt.transferHint`（占比过阈值就提醒她自己调
   `memory_movctx`），默认 50%。

