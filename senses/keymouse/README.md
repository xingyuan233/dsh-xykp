# keymouse — 鼠标/键盘操作（原生工具 `mouse_input` / `keyboard_input`）

和 `screenshot` 配套：一个负责看，一个负责动。纯 `ctypes` 实现，不依赖 pyautogui / pydirectinput。

两种投递方式，由 `mode` 参数选：

- **sendinput**：`SendInput` 真实进系统输入队列，会移动光标、跟着前台焦点走（不传 `window` 时的默认）。
- **post**：`PostMessage` 直投指定窗口，光标不动、不抢前台（需要 `window`）。
- **auto**（默认）：给了 `window` 就先直投；点击/长按/滚轮靠“鼠标捕获 / 局部像素变化 / 目标进程冒新窗口”
  判断有没有反应，没反应才回退真实输入。键盘没法可靠判定，直投不会自动补发（避免重复输入）——
  要真实按键就显式 `mode="sendinput"`。

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
| `key` | `keys`（默认 `enter`）、`hold=0.05`、`window?` | 单键或组合键，如 `ctrl+c`、`alt+tab`；给了 `window` 默认直投 |
| `type_text` | `text`、`interval=0.02`、`window?` | Unicode 输入，支持中文；给了 `window` 默认直投 |

### `mode` / `child`（click / multi_click / long_press / scroll / key / type_text 共用）

| 参数 | 默认 | 说明 |
|---|---|---|
| `mode` | `auto` | 见上：`auto` 先直投再回退真实输入；`post` 只直投（需 `window`）；`sendinput` 只真实输入 |
| `child` | `true` | 直投时下钻子窗口：坐标类找该点最深的可见子窗口；键盘类优先目标线程的焦点子窗口，没有焦点就用客户区中心的子窗口 |

> 坐标始终按**顶层窗口**客户区给，`child` 下钻后的坐标会自动换算；`window` 也可以直接写数字 hwnd 精确定位。

## 不重启也能验证

`server.py` 带了个命令行入口，改完代码直接调，不用重启 `dsh web`：

```powershell
$py = 'D:\Program-Files\Python\312\python.exe'
$km = 'D:\AI\DeepseekHarness\plugins\senses\keymouse\server.py'
& $py $km --cli click '{"x":120,"y":80,"window":"记事本"}'
& $py $km --cli click '{"x":120,"y":80,"window":"记事本","mode":"post"}'
& $py $km --cli type_text '{"text":"你好","window":"记事本"}'
```

工具表里新增的 `mode` 参数要等 `dsh web` 重启后才出现在 schema 里（工具定义进的是宿主进程）。

## 后端

`server.py` 还是原来那个 MCP server（`input_info`/`move`/`click`/`multi_click`/
`long_press`/`drag`/`scroll`/`key`/`type_text`/`focus_window`，内部再按 `mode` 分
SendInput / PostMessage 两条路），
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
- **直投（post / auto）的局限**：PostMessage 不是系统输入队列，读 `GetAsyncKeyState`/Raw Input
  的程序（游戏、部分安全软件）收不到；目标最小化时消息能发进去但不一定重绘。`auto` 靠三个信号
  判断“有没有反应”，极少数“处理了但界面没变化、没捕获、也没开新窗口”的控件会被补一次真实点击
  （重复触发一次）。这种场景明确写 `mode="post"` 或 `mode="sendinput"`。
- `focus_window` 用 `AttachThreadInput` 绕过前台锁；如果系统仍拒绝，先手动点一下目标窗口。
- 测试脚本：`test_input.py`（Tk 窗口 + 真实事件）、`test_client.py`（MCP 协议）、
  `e2e_window.py`（端到端点击用的置顶窗口）、`..\lib\test-bridge.mjs`（桥接层）。
