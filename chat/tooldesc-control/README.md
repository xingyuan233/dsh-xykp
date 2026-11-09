# tooldesc-control · 工具门控 / 延迟注入

> 2026-11-09 重写。目标只有一个：**一个会话的请求前缀（tools + system + 消息）永不改变**，工具和说明只在命中关键词时以「追加消息」的形式出现。

## 1. 为什么这么较真

请求前缀长这样：

```
[tools 声明] → [system] → [messages]
```

`tools` 在最前面。它变一个字节，后面整段就全部 miss。DeepSeek 侧一次全 miss 等于把几十轮对话按全价重算一遍——所以这里的取舍是：**宁可让模型看不到新定义，也不动前缀**。

模型侧的两个相关能力（`dsh-llm-deepseek` 的模型定义）：

```js
systemPromptUpdate: "in-history"   // 系统提示词中途变化 → 追加成历史消息，不重写开头
toolUpdate: "addition-only"        // 工具中途变化 → 只认「新增」，删除不下发
```

## 2. 两条注入通道（都要知道）

| 通道 | 注册方式 | 落到请求哪里 | 本插件怎么处理 |
|---|---|---|---|
| ① 工具调用 | `ctx.tools.register(def)` | `tools` 字段（`name` / `description` / `parameters`） | 按 `rules` 决定第一次组装时给不给，然后整表冻结 |
| ② 工具说明 | `ctx.systemPrompt.section({ name: 'tool:xxx', order, text })` | system prompt 正文 | 不拦截；需要按需注入的说明走 `notes`（追加消息） |

一个工具在模型眼里因此有两份东西：`tools` 里的定义（② 里的 `tool:xxx` 段是它的使用说明）。**只藏 ① 不藏 ②** 时，模型仍然「知道有这个工具、知道怎么用」，只是调不了——这是刻意的，因为 ② 在 `in-history` 模式下本来就不炸缓存。

## 3. 配置：两套，互不相干

都在 `<DSH_HOME>/xykp/config.yml` → `tooldesc-control` 段。**改完不需要重启**（每次组装按 mtime 重新编译规则）。

```yaml
tooldesc-control:
  rules:                                  # 工具：命中才让它出现在 tools 里
    bili_rove:
      keys: [B站, bilibili, 视频]
      cooldown: 8                         # 按「大轮」算（一条用户消息 = 一轮）
      limit: 3                            # 可选，这个会话最多推几次；不填 = 无限
    create_goal: { keys: [goal, 长期目标], cooldown: 8 }

  notes:                                  # 说明：key = 系统提示词里那段 section 的名字（tool:goal 这种）
    tool:workflow:
      keys: [工作流, workflow, 编排]
      cooldown: 8
      text: |
        长流程用 workflow：写一个 JS 脚本一次编排多个 subagent……
```

字段语义：

| 字段 | 适用 | 说明 |
|---|---|---|
| `keys` | 都有 | 关键词，大小写不敏感，命中任一即可 |
| `cooldown` | 都有 | 距上次触发至少隔多少「轮」；默认 8 |
| `limit` | 都有 | 最多触发几次；默认无限 |
| `text` | notes 必填 | 注入的正文 |

> `system` / `systemText` 字段已删除（原本想表达「每 N 次推一次系统说明」，实现是错的，且说明现在由 `notes` 独立承担）。

## 4. 冻结机制（核心）

```
第一次组装:  按规则过滤一次 → 写盘 tool-gate-frozen.json → 发出去
之后每次:    直接从盘上读这份 → 原样发出去（不看注册表）
```

于是：改描述、改参数、删工具、改名、插件重载——**请求里的 `tools` 都是那一份**。新注册的工具也不会进表，只能靠消息补充。

「第一次组装」的过滤判据是**并集**：

```
declared = 会话里所有 request/header 出现过的工具 ∪ 所有 tool-addition 事件
保留条件 = 不在规则里 或 已在 declared 里
```

所以**新增规则对老会话无效**（历史里出现过的工具一律保留），只对新会话生效——这是防「加规则把老会话缓存炸掉」的护栏。

快照文件：

```
<DSH_HOME>\xykp\tooldesc-control\frozen-tools.json     { "<sid>": [ {name, description, parameters}, ... ] }
```

## 5. 什么时候扫描关键词

| 钩子 | 扫什么 |
|---|---|
| `agent/inbox/inserted` | 刚进来的**真人**用户消息（跳过 `tool-gate:notice` / `user-approval` / `schedule` / `reminder` / `system*` / `host` 等注入） |
| `agent/pre-step` | 最后一条真人用户消息（兜底） |
| `agent/assistant-stream` | 模型自己产出的文本 / 思考（不 dump 原始帧 JSON） |

工具结果、历史消息、注入内容**不参与**匹配（早期版本扫全量 + `JSON.stringify(frame)`，误匹配率极高）。

## 6. 通知

命中后攒进队列，在当前会话下一次有消息进出时 `steer` 一条追加消息（不动前缀）：

```
<notes 的 text，可多条，排在前面>

关键词「B站」命中（不是必须要调用），已解锁工具 「bili_rove」（不在 tools 列表里，如果需要直接按格式调用即可）
<该工具的 description>
```

- `notes` 的消息在前，工具解锁在后。`notes` 的 key 必须等于系统提示词里的 section 名：配了就**默认把那段说明从 system prompt 摘掉**，命中关键词再以消息形式注入（可反复注入）。`「xx」` 是实际命中的那个关键词（不是规则里全部关键词）。
- 同一段 note 文本在队列里只保留一份。

## 7. 文件与状态

| 路径 | 作用 |
|---|---|
| `chat/tooldesc-control/refresh.js` | 长对话重贴：每累计 `everyTokens`（默认 20 万）把 AGENTS.md + 角色预设 persona 再贴一遍，走 queueNotice 追加，不动前缀 |
| `chat/tooldesc-control/gate.js` | 钩子、扫描、通知、快照过滤 |
| `chat/tooldesc-control/registry.js` | 规则/说明的读取编译、快照读写、debug 日志 |
| `chat/tooldesc-control/index.js` | 入口，把 gate / refresh 挂一起 |
| `<home>\xykp\tooldesc-control\state.json` | 每个会话解锁过哪些工具（只影响「发不发通知」） |
| `<home>\xykp\tooldesc-control\frozen-tools.json` | 会话工具表快照（缓存保险，别删） |
| `<home>\xykp\tooldesc-control\tool-gate.log` | `dbg()` 日志：初始化、快照、注入、错误 |

## 8. 改工具会怎样

| 改动 | 请求前缀 | 说明 |
|---|---|---|
| 改 description | 不变 | 快照优先；`tool-desc-pin` 是第二道保险 |
| 改 parameters | 不变 | 但模型按旧 schema 调用，可能校验失败 |
| 删工具 / 改名 | 不变 | 旧名字与旧定义照发；运行时可能「工具不存在」 |
| 新增工具 | 不变 | 不进快照，只靠消息追加 |

## 9. 坑（都是踩过的）

1. **`dbg` 未定义**：gate.js 里调用 `dbg()` 但只在 registry 内部定义 → 每个请求必抛 `ReferenceError`，整轮失败。修法：`export function dbg` + gate 里 `const dbg = __R.dbg`。抓错误的那段自己不能抛。
2. **cordis waterfall 不认返回值**：`ctx.on('system-prompt/assemble', (assembly, ctx, next) => ...)` 里必须**原地改** `assembly.tools`，`next({...})` 的参数和返回值都会被丢掉。
3. **`session.surface.nodes` 存的是 seq 号**，不是消息对象；要消息用 `session.deriveMessages()` / `session.snapshotEvents()`。
4. **安装副本是 pnpm store 硬链接**：覆盖前先 `Remove-Item` 再 `Copy-Item`，否则会写坏 store。
5. **别随手清 `tooldesc-control\state.json` / `frozen-tools.json`**：前者清掉会让已解锁工具重新被藏（前缀变），后者清掉会重新生成快照（同样变）。
6. 改代码后：`node --check`（把 .js 复制成 .mjs 再 check），并用假 ctx 跑一遍 `apply()` 冒烟，别直接重启。

## 10. 与核心补丁的关系

| 补丁 | 作用 | 与本插件 |
|---|---|---|
| `core/tool-wire-slim.mjs` | 把工具 schema 压成 `params: (…)` 一行 + 散文 | 决定了通知里 `description` 的样子（装配层的版本） |
| `core/tool-wire-trims.mjs` | 内置工具的文案精简表 | 同上 |
| `core/tool-desc-pin.mjs` | 按工具名冻结**第一次注册**的 description 并落盘 | 第二道保险；只管 description，不管 parameters/name |

## 11. 排障速查

```powershell
# 看快照
Get-Content D:\AI\DeepseekHarness\home\xykp\tooldesc-control\frozen-tools.json -Raw | ConvertFrom-Json |
  ForEach-Object { $_.PSObject.Properties | ForEach-Object { "$($_.Name): $($_.Value.Count) 条" } }

# 看最近触发
Get-Content D:\AI\DeepseekHarness\home\xykp\tooldesc-control\tool-gate.log -Tail 20

# 看某会话实际发出去的 tools（会话日志是 zstd 压缩的 jsonl）
# request/header 事件 → data.header.tools
```
