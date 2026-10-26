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
| 截屏 / 输入 MCP | `tools\screen-mcp` → `senses/screenshot`、`tools\input-mcp` → `senses/keymouse` | **已搬（DXGI 抓屏不落盘 / SendInput 输入）** |

## 许可

MIT
