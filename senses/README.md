# senses — 感官工具（看 / 动）

给 agent 装「眼睛」和「手」的三个**原生工具**（不是 `mcp__…` 那种桥接名）：

| 工具 | 模块 | 后端 | 作用 |
|---|---|---|---|
| `screenshot_acquire` | `senses/screenshot/` | `server.py`（dxcam / DXGI） | 抓屏，图片以 attachment 直接进对话，**不落盘** |
| `mouse_input` | `senses/keymouse/` | `server.py`（`SendInput`） | 移动/点击/长按/拖曳/滚轮/窗口聚焦/查光标 |
| `keyboard_input` | `senses/keymouse/` | `server.py`（`SendInput`） | 组合键、Unicode 文本输入 |

## 结构

```
senses/
├── lib/mcp-bridge.mjs      # 极简 MCP stdio 客户端（initialize + tools/call）
├── lib/test-bridge.mjs     # 不经过宿主，直接测 Python 后端 + 桥接
├── screenshot/
│   ├── index.js            # DSH 插件：注册 screenshot_acquire
│   ├── server.py           # 原 MCP server（dxcam），逻辑没改
│   ├── test_client.py / mount.yml / README.md
└── keymouse/
    ├── index.js            # DSH 插件：注册 mouse_input / keyboard_input
    ├── server.py           # 原 MCP server（SendInput），逻辑没改
    ├── test_input.py / e2e_window.py / mount.yml / README.md
```

## 为什么多一层 JS

`@deepseek-ai/dsh-mcp-client` 挂出来的工具名固定是 `mcp__<serverName>__<tool>`，
比如 `mcp__input__multi_click` —— 又长又难认。所以：

- **Python 侧不动**：抓屏（DXGI）和输入（`SendInput`）都是验证过的代码，继续提供服务；
- **JS 侧只用 `lib/mcp-bridge.mjs` 调它**：`initialize` 握手 + `tools/call`，不需要 MCP SDK；
- 对外注册三个干净的**原生工具名**，图片从 `ctx.attachments.saveImages()` 进对话，
  和 `read_image` 走同一条附件通路。

换工具名/收参数都在 `index.js` 里，改完 profile 热重载就生效（Python 进程按需拉起，第一次调用约 0.5s）。

## 挂载

`home\profiles\web\cordis.patch.yml`：

```yaml
- insert:
    - id: senses-screenshot
      name: 'dsh-xykp/senses/screenshot'
    - id: senses-keymouse
      name: 'dsh-xykp/senses/keymouse'
```

插件模块路径由仓库 `package.json` 的 `exports` 提供
（`./senses/screenshot`、`./senses/keymouse`），profile 里 `dsh-xykp` 是指向仓库的 junction。

## 坐标约定

- `mouse_input` 不传 `window`：虚拟桌面物理像素，原点在主屏左上角；
- 传 `window`：该窗口**客户区**物理像素（游戏内容区，不含标题栏）；
- `screenshot_acquire` 返回文本里带 `scale`：图上量到的坐标乘 `1/scale`、再加 region 原点
  才是屏幕坐标，可以直接交给 `mouse_input`。

典型循环：`screenshot_acquire(list_windows=true)` 挑窗口 → `screenshot_acquire(window=...)`
看 → `mouse_input(action="click", x, y)` → 再截一张确认。

## 依赖

全局 Python 3.12：`mcp`、`dxcam`、`opencv-python`（`keymouse` 只用标准库 `ctypes`）。
`DSH_SENSES_PYTHON` 可以覆盖 python 路径，默认 `D:\Program-Files\Python\312\python.exe`。

## 注意

- `screenshot_acquire` 走 DXGI 桌面复制：窗口被遮挡时是遮挡后的画面，最小化会停更，
  独占全屏抓不到（游戏请用无边框窗口）；空闲 15 秒释放复制会话。
- `mouse_input` / `keyboard_input` 走 `SendInput`：目标窗口以管理员权限运行时会被 UIPI 忽略；
  Raw Input / DirectInput 游戏可能不认合成输入。**没有撤销**，坐标先 `move` 确认再 `click`。
- 模型没声明图片输入时，`screenshot_acquire` 只返回文字说明，不会塞图。
- 仅 Windows。
