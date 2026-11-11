# dsh-xykp

DeepSeek Harness 的个人插件集合：**一个 npm 包装二十来个子插件，外加一套宿主核心补丁。**

装一次、改一处——不用为每个小功能单独发一个包。

## 它是什么

- **单包多插件**：`package.json` 的 `exports` 把每个子插件当子路径暴露（`dsh-xykp/chat/toolret-steward` 这种）。
- **装配表随包走**：包自带 `cordis.patch.yml`（`dsh.bundle.patch`），每个子插件在这份表里用 `insert` 声明一行；
  profile 的 `cordis.patch.yml` 只写 `- id: <行id>` 覆盖参数，**不要**再 insert（同一 id 两处 insert = 双实例，直接崩）。
- **客户端 UI 只有一份**：客户端加载器只认整包名 `dsh-xykp`，所有前端都写在根级 `client.js` 里，子插件不要各建一份。

## 安装 / 生效

宿主实际加载的是 `HOME\profiles\web\node_modules\dsh-xykp`，由 pnpm 从 GitHub 拉取，profile 的 `package.json` 里 pin 一个 commit：

```json
"dsh-xykp": "github:xingyuan233/dsh-xykp#<commit>"
```

改完这里的代码：`git push` → 改 pin → `pnpm install` → 重启 `dsh web`。
临时调试也可以直接改 `node_modules\dsh-xykp` 里的文件再重启，但下次 `pnpm install` 会被覆盖。

> 从 GitHub 安装时 pnpm 按 `files` 白名单打包，**新目录记得加进 `files`**，否则装出来缺文件（`ui` 就栽过一次）。

## 装配树里的子插件

| 行 id | 包内路径 | 干什么 |
|---|---|---|
| `xykp` | `dsh-xykp`（根） | 客户端门面，加载根级 `client.js` |
| `xykp-console` | `ui/console` | 设置 → **xykp 配置**（读写 `HOME\xykp\<行 id>\config.yml`） |
| `log-cleaner` | `storage/log-cleaner` | 定时扫 `dsh-*.log`，备份、删旧 |
| `session-archiver` | `storage/session-archiver` | 归档很久没动过的会话 |
| `dsh-session-delete` | `storage/session-delete` | 侧边栏右键永久删除会话 |
| `preset-loader` | `storage/preset-loader` | 预设目录热加载（改 `preset.yml` 自动重注册，不用重启） |
| `preset-binder` | `chat/preset-binder` | 预设 ↔ 会话绑定表 |
| `memory-layer` | `chat/memory-layer` | 概念联想记忆：`memory_ctrl` + 可视化 `http://127.0.0.1:3099/` |
| `toolret-steward` | `chat/toolret-steward` | 工具结果去留管家（旧的 `toolret-forget` 已被它取代） |
| `token-reporter` | `chat/token-reporter` | token 用量 / 余额查询 |
| `tooldesc-control` | `chat/tooldesc-control` | 工具门控（关键词解锁 + 会话工具表快照，保前缀缓存）、说明注入（notes）、上下文重贴 |
| `injection-shower` | `chat/injection-shower` | 只读旁路：每轮注入的 context / section / 收件箱消息，看 `http://127.0.0.1:3080/injection-shower` |
| `senses-screenshot` | `senses/screenshot` | 截屏（Python MCP，带窗口/区域） |
| `senses-keymouse` | `senses/keymouse` | 鼠标键盘注入 |
| `balance-reporter` | `senses/balance-reporter` | 页面右下角的 VK-1 余额挂件 + `balance_report` |
| `bili-reply` | `comms/bili-reply` | B 站评论 / 私信自动回复（含队列、去重） |
| `bili-rove` | `comms/bili-rove` | B 站工具：搜索、视频、字幕、评论、弹幕、真帧、回复、三连 |
| `bili-audio-live` | `comms/bili-audio-live` | 直播语音识别 + 弹幕攒批投递 |
| `qq-adapter` | `comms/qq-adapter` | QQ 通道（桥 + 命令路由）。`/compact` 依赖 `memory_movctx` |
| `ntfy` | `comms/ntfy` | ntfy 推送 / 订阅 |
| `search-engine` | `comms/search-engine` | `web_search` / `web_fetch` 的 provider（free 搜索 + reader 正文） |
| `dsh-prosecutor` | `observer/dsh-prosecutor` | 常驻守护：ntfy 指令 `/check` `/notify`、DSH 挂了拉起来。**cwd 必须在包外**，见它自己的 README |
| `plugin-gate` | `observer/plugin-gate` | 装插件前扫描（BLOCK / WARN / PASS，只看不执行） |

## 配置与显示名

- `HOME\xykp\<行 id>\config.yml` —— 每个插件自己的配置（YAML，可手改；控制台保存只改这一行并热重载）
- `HOME\xykp\<行 id>\labels.yml` —— 只存这一行的界面显示名（左栏标题、字段中文名）

子插件读配置统一用 `ui/store.js` 的 `configFor('<行id>')`；**不要再把 xykp 的 config 写回 profile 的 patch**。

## 包结构

```
index.js / client.js       入口 + 客户端 UI（整包一份）
cordis.patch.yml           随包发布的装配表（只写 id/name/可选 disabled）
chat/ comms/ senses/ storage/ observer/    子插件
ui/store.js                共用配置读取器
ui/console/                设置页
core/                      宿主核心补丁（不在装配树里，见下）
deprecated/                退役代码：不在 files 里，不进安装包
```

## 宿主核心补丁 `core/`

`core/` 不在装配树里，它改的是**宿主本体**（`DSH\npm\node_modules\@deepseek-ai\*`），
所以不能用 `insert`，只能打完补丁重启。

- `core/apply-all.mjs` 扫 `core/*.mjs`，按文件顺序幂等应用（文件里有 `marker` 就跳过），
  原文件存 `core/.backup/`；目标文件换了版本时旧备份会留档成 `*.old` 再重新备份。
- `core/auto-restore.cmd` 给两个 `postinstall` 钩子调用：宿主 `npm install`（升级 dsh）后自动重打核心补丁，
  profile `pnpm install` 后自动跑 `core\restore-all.ps1`。永远 `exit 0`，日志在 `core\auto-restore.log`。
- `core/install-hooks.ps1` 幂等安装/修复这两个钩子（`-Check` 只看状态）。

```powershell
pwsh -File D:\AI\DeepseekHarness\plugins\core\apply-all.ps1 -Check    # 看状态
pwsh -File D:\AI\DeepseekHarness\plugins\core\apply-all.ps1           # 应用
pwsh -File D:\AI\DeepseekHarness\plugins\core\install-hooks.ps1 -Check
```

当前四个补丁：`tool-wire-slim`（工具定义线格式）、`tool-wire-trims`（自带工具文案瘦身）、
`tool-desc-pin`（工具定义钉住）、`session-tolerance`（坏会话日志跳过）。

## 加一个子插件

1. 建 `chat|comms|senses|storage|observer\<名字>\`，`index.js` 导出 `name` 和 `apply(ctx, config)`；
2. `package.json` 的 `exports` 加 `"./<分类>/<名>": "./<分类>/<名>/index.js"`；
3. `cordis.patch.yml` 的 `insert` 加一行 `- id: <行id>` + `name: 'dsh-xykp/<分类>/<名>'`；
4. 要配置：`apply` 里 `configFor('<行id>', config)`；可选在 `ui/console/index.js` 的 `META` 写说明；
5. 要 UI：写进根级 `client.js`。

坑（详细见 `HOME\documents\plugin-guide.md`）：同一 id 别 insert 两次；工具描述每个字都进首轮 prompt；
数据别写进包目录（更新即丢，放 `HOME\<插件名>\` 或 `HOME\xykp\`）；插件的脱离进程 cwd 不要指到包目录。

## 发布 / 验证

```powershell
cd D:\AI\DeepseekHarness\plugins
git push
# 改 HOME\profiles\web\package.json 里的 dsh-xykp pin → pnpm install → 重启 dsh web
# 起来后看 D:\AI\DeepseekHarness\dsh-web.log：有 failed to import / 挂载失败 就是炸了
```

## deprecated/

退役但保留下来的代码：`memory-refine`（鱼的记忆 + `memory_movctx`）、`toolret-forget`（被 `toolret-steward` 取代）。
它们不在 `files` 里、不随包安装；要恢复就 move 回 `chat/`，再补 `exports` 和 `insert` 行。

> 注意：`memory_movctx` 是 `memory-refine` 提供的，`qq-adapter` 的 `/compact` 和 `token-reporter` 的提示都指着它。
> 退役后这条链没了；要恢复只想要交接能力的话，可以把它拆成一个独立小插件。

