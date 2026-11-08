# dsh-xykp

DSH（DeepSeek Harness）的插件集合。一个仓库、一个包、内部按模块分——
目标是**不再往别人的 `node_modules` 上打补丁**，而是所有东西都有自己的源码、自己的版本。

> 目前是骨架：目录形式还没定，`package.json` 里也**故意没写 `exports`**。
> 等目录规划好了再补入口，profile 那边只装一条依赖，按子路径挂插件。

## 为什么是「一个包」

- DSH 侧只认一条依赖：`github:xingyuan233/dsh-xykp#<commit>`
- 模块之间可以直接共享代码，不用 `workspace:` 那种只能在 monorepo 里活着的协议
- 从 GitHub 子目录装（`#path:/packages/x`）也行，但那样每个子包都得自包含；现在这样更省事

## 约定（草稿，待补）

- 改动只进仓库，不进 `node_modules`；不再用 `restore.ps1` 那套
- 依赖 pin 到 commit，不 pin 分支
- 每个模块一个 README，写清楚：做什么、要哪些 DSH 服务、对 DSH 版本的要求
- 能上游就上游（bug 提给原仓库），不能才在本地实现

## 计划收进来的东西

| 模块 | 来源 | 状态 |
|---|---|---|
| `storage/preset-loader` | `tools\preset-folder` | **已搬（热重载 + 快照 diff）** |
| `chat/preset-binder` | `tools\preset-active` | **已搬（时间/模型/token/上下文明细）** |
| 记忆（预设池） | `dsh-fish-memory` 的本地补丁版 | 待搬 |
| QQ 通道 | `dsh-onebot-qq` 的本地补丁版 | 等 NapCat 换稳定版后重写 |
| B 站工具 | `dsh-plugin-bilibili` | 待重写（只做工具，不做定时强刷） |
| 安装安全闸 | `dsh-plugin-gate` | 待搬 |
| 会话工具 | `dsh-session-delete` | 待搬 |
| 截屏 / 输入 | `tools\screen-mcp` → `senses/screenshot`、`tools\input-mcp` → `senses/keymouse` | **已搬；原生工具 `screenshot_acquire` / `mouse_input` / `keyboard_input`（Python 后端 + stdio 桥接）** |
| token 用量 / 余额 | 新增 · `chat/token-reporter` | **已加（默认关：`token_report` 工具 + 可选每轮提示摘要）** |
| Web 配置控制台 | 新增 · `ui/console` | **已加（设置 → 插件配置：左栏子插件，右栏改 config）** |

## ui/console：Web 端改配置

- 宿主半边 `ui/console/index.js` 提供 `/xykp-console/rows|save|reset`。
- 持久化只有一个文件：`home\xykp\config.yml`（行 id → 该插件配置，YAML）。
  各插件在 `apply()` 开头用 `ui/store.js` 的 `configFor('<行 id>')` 读它，
  所以启动时拿到的就是文件里的值；保存时写文件 + `entry.update()` 热重载该行。
- 浏览器半边在根 `client.js`（设置 → **插件配置**）：
  左栏是 `dsh-xykp/*` 的各行，右栏按值类型渲染成控件
  （布尔开关 / 数字 / 文本 / 列表 / 复杂值走 JSON），也可以切「JSON 源码」。
- 新加插件时：在 `cordis.patch.yml` 的 insert 里加一行，再在
  `ui/console/index.js` 的 `META` 里补个中文名和说明即可。

## 许可

MIT
