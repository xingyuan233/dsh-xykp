# input-mcp — 鼠标/键盘操作 MCP（SendInput）

和 `screen-mcp` 配套：一个负责看（截图），一个负责动（点击/长按/拖曳/连点）。
纯 `ctypes` 调 `SendInput`，不依赖 pyautogui / pydirectinput。

## 工具

| 工具 | 主要参数 | 说明 |
|---|---|---|
| `input_info()` | — | 虚拟屏幕范围、光标位置、前台窗口 |
| `move(x, y, window?)` | | 移动鼠标 |
| `click(x, y, button="left", count=1, interval=0.08, hold=0, window?)` | | 单击；`count` 即连点 |
| `multi_click(x, y, count=3, interval=0.08, button="left", window?)` | | 连点（`click` 的别名） |
| `long_press(x, y, duration=0.6, button="left", window?)` | | 按下保持再松开 |
| `drag(x1, y1, x2, y2, duration=0.4, steps=24, button="left", window?)` | | 按下→平滑移动→松开 |
| `scroll(amount=1, x?, y?, horizontal=False, window?)` | | 滚轮，正数向上/右 |
| `key(keys="enter", hold=0.05)` | | 单键或组合键，如 `ctrl+c`、`alt+tab` |
| `type_text(text, interval=0.02)` | | Unicode 输入，支持中文 |
| `focus_window(window)` | | 切前台（最小化会还原） |

## 坐标

- **不传 `window`**：虚拟桌面物理像素，原点在主屏左上角。
- **传 `window`**：相对该窗口**客户区**的物理像素（游戏内容区，不含标题栏）。
- 截图被 `max_side` 缩小过时，图上的坐标要先乘 `1/scale`（`screen-mcp` 的返回里带
  `scale=...`），再交给 `click`。

## 实测（这台机器，2560×1600 / 150%）

| 动作 | 结果 |
|---|---|
| `click` | 1 down / 1 up，光标落在目标点 |
| `long_press(0.35)` | 实际按住 **351ms** |
| `multi_click(3, 0.1)` | 3 次，间隔 **113 / 108ms** |
| `drag(250,250→450,350)` | 20 个 motion 事件，终点精确落在 (450,350) |
| `scroll(2)` | 1 个 wheel 事件 |
| `key("ctrl+c")` | ctrl + c 两个按键事件 |
| `type_text("ab")` | 收到 `ab` |

## 挂载

源码在 `dsh-xykp` 仓库的 `senses/keymouse/`（原 `tools\input-mcp`；目录名是
`keymouse`，`serverName` 仍是 `input`——工具名前缀已被会话引用，不改）。
挂载片段见同目录 `mount.yml`，已写进 `D:\AI\DeepseekHarness\home\profiles\web\cordis.patch.yml`：

```yaml
- insert:
    - id: mcp-input
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: input
        command: 'D:\Program-Files\Python\312\python.exe'
        args:
          - 'D:\AI\DeepseekHarness\plugins\senses\keymouse\server.py'
        cwd: 'D:\AI\DeepseekHarness\plugins\senses\keymouse'
        env:
          PYTHONUTF8: '1'
          PYTHONIOENCODING: 'utf-8'
        failOnStartupError: false
```

工具名：`mcp__input__click` / `mcp__input__drag` / …（profile 层热重载，改完即生效）。

## 注意

- **UIPI**：目标窗口以管理员权限运行时，普通进程的 `SendInput` 会被系统忽略 →
  让游戏和 agent 用同一权限级别。
- **Raw Input / DirectInput 游戏**可能不认合成输入。真遇到就上 Interception 驱动
  （本工具没内置；PVZ 这类窗口消息游戏 `SendInput` 就够）。
- **联机游戏反作弊**：不要用；这是给单机/自己玩的游戏做自动化的。
- 没有“撤销”：坐标先 `move` 确认，再 `click`；拖曳前确认起点在可拖区域。
- `focus_window` 用 `AttachThreadInput` 绕过前台锁；如果系统仍拒绝，先手动点一下目标窗口。
- 测试脚本：`test_input.py`（Tk 窗口 + 真实事件）、`test_client.py`（MCP 协议）、
  `e2e_window.py`（给 MCP 端到端点击用的置顶窗口）。
