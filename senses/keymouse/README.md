# keymouse — 鼠标/键盘操作（原生工具 `mouse_input` / `keyboard_input`）

和 `screenshot` 配套：一个负责看，一个负责动。纯 `ctypes` 调 `SendInput`，
不依赖 pyautogui / pydirectinput。

## 对外工具

模型看到两个原生工具（`index.js` 注册，没有 `mcp__` 前缀）：

### `mouse_input`

`action` 决定动作，其余参数按需给：

| action | 需要的参数 | 说明 |
|---|---|---|
| `move` | `x,y`（`window?`） | 移动鼠标 |
| `click` | `x,y`（`button,count,interval,hold,window?`） | 单击；`count>1` 即连点 |
| `multi_click` | `x,y`（`count=3,interval,button,window?`） | 连点（`click` 的别名） |
| `long_press` | `x,y`（`duration=0.6,button,window?`） | 按下保持再松开 |
| `drag` | `x1,y1,x2,y2`（`duration,steps,button,window?`） | 按下→平滑移动→松开 |
| `scroll` | `amount`（`x,y,horizontal,window?`） | 滚轮，正数向上/右 |
| `focus_window` | `window` | 切前台（最小化会还原） |
| `info` | — | 虚拟屏幕范围、光标位置、前台窗口 |

### `keyboard_input`

| action | 参数 | 说明 |
|---|---|---|
| `key` | `keys`（默认 `enter`）、`hold=0.05` | 单键或组合键，如 `ctrl+c`、`alt+tab` |
| `type_text` | `text`、`interval=0.02` | Unicode 输入，支持中文 |

## 后端

`server.py` 还是原来那个 MCP server（`input_info`/`move`/`click`/`multi_click`/
`long_press`/`drag`/`scroll`/`key`/`type_text`/`focus_window`），
由 `senses/lib/mcp-bridge.mjs` 以 stdio 调起来，`index.js` 把 action 映射到对应后端工具。

## 坐标

- **不传 `window`**：虚拟桌面物理像素，原点在主屏左上角。
- **传 `window`**：相对该窗口**客户区**的物理像素（游戏内容区，不含标题栏）。
- 截图被 `max_side` 缩小过时，图上的坐标要先乘 `1/scale`（`screenshot_acquire` 的返回里带
  `scale=...`），再交给 `mouse_input`。

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

`dsh-xykp` 是 bundle 包，注册行在仓库根 `cordis.patch.yml`（`dsh.bundle.patch`），profile 里不重复 insert：

```yaml
- insert:
    - id: senses-keymouse
      name: 'dsh-xykp/senses/keymouse'
```

改了 `index.js` 要重启 `dsh web` 才生效（工具定义进的是宿主进程）；只改描述文字不用重启。
Python 进程按需拉起，cwd 固定在 `home\xykp\senses\keymouse`（插件目录保持干净）。

## 注意

- **UIPI**：目标窗口以管理员权限运行时，普通进程的 `SendInput` 会被系统忽略 →
  让游戏和 agent 用同一权限级别。
- **Raw Input / DirectInput 游戏**可能不认合成输入。真遇到就上 Interception 驱动
  （本工具没内置；PVZ 这类窗口消息游戏 `SendInput` 就够）。
- **联机游戏反作弊**：不要用；这是给单机/自己玩的游戏做自动化的。
- 没有“撤销”：坐标先 `move` 确认，再 `click`；拖曳前确认起点在可拖区域。
- `focus_window` 用 `AttachThreadInput` 绕过前台锁；如果系统仍拒绝，先手动点一下目标窗口。
- 测试脚本：`test_input.py`（Tk 窗口 + 真实事件）、`test_client.py`（MCP 协议）、
  `e2e_window.py`（端到端点击用的置顶窗口）、`..\lib\test-bridge.mjs`（桥接层）。
