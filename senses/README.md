# senses — 感官类工具（看 / 动）

给 agent 装「眼睛」和「手」的两个 MCP server。都是**独立 Python 进程**，由 DSH 的
`@deepseek-ai/dsh-mcp-client` 以 stdio 方式拉起，不是 JS 插件模块。

| 模块 | 做什么 | 工具名前缀 | 依赖 |
|---|---|---|---|
| `screenshot/` | dxcam 抓屏 → 内存编码 → MCP image block（**不落盘**） | `mcp__screen__*` | `dxcam`、`mcp`、`opencv-python` |
| `keymouse/` | `ctypes` 调 `SendInput`：移动/点击/长按/拖曳/滚轮/按键/输入文本 | `mcp__input__*` | `mcp` |

两个共用同一套坐标口径：

- 不传 `window`：虚拟桌面物理像素，原点在主屏左上角；
- 传 `window`：相对该窗口**客户区**（游戏内容区，不含标题栏）；
- 截图被 `max_side` 缩小过时，返回里带 `scale`，图上的坐标先乘 `1/scale` 再交给 `click`。

典型循环：`screen_info()` 挑窗口 → `screenshot(window=...)` 看 → 按图上的坐标
`click(x, y, window=...)` → 再截一张确认。

## 目录

```
senses/
├── screenshot/   screen-mcp  原 tools\screen-mcp
│   ├── server.py
│   ├── test_client.py      # 官方 MCP client 端到端测试（会存 mcp_test.jpg）
│   ├── mount.yml           # profile 层挂载片段
│   └── README.md
└── keymouse/     input-mcp   原 tools\input-mcp
    ├── server.py
    ├── test_client.py
    ├── test_input.py       # Tk 窗口 + 真实事件
    ├── e2e_window.py       # 端到端点击用的置顶窗口
    ├── mount.yml
    └── README.md
```

## 挂载

写进 `home\profiles\web\cordis.patch.yml`，profile 层热重载，改完不用重启宿主：

```yaml
- insert:
    - id: mcp-screen
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: screen
        command: 'D:\Program-Files\Python\312\python.exe'
        args: ['D:\AI\DeepseekHarness\plugins\senses\screenshot\server.py']
        cwd: 'D:\AI\DeepseekHarness\plugins\senses\screenshot'
        env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
        failOnStartupError: false

- insert:
    - id: mcp-input
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: input
        command: 'D:\Program-Files\Python\312\python.exe'
        args: ['D:\AI\DeepseekHarness\plugins\senses\keymouse\server.py']
        cwd: 'D:\AI\DeepseekHarness\plugins\senses\keymouse'
        env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
        failOnStartupError: false
```

`serverName` 保持 `screen` / `input`（目录名是 `screenshot` / `keymouse`）：工具名前缀
`mcp__screen__*`、`mcp__input__*` 已经被会话和提示词引用，改名会打断它们。

## 依赖

全局 Python 3.12：`py -3.12 -m pip install mcp dxcam opencv-python`。
`keymouse` 只用标准库 `ctypes`，不装额外包。

## 注意

- `screenshot` 走 DXGI 桌面复制：窗口被遮挡时抓到的是遮挡后的画面，最小化会停更；
  独占全屏抓不到，游戏请用「无边框窗口」。空闲 15 秒释放复制会话，让给别的 dxcam 进程。
- `keymouse` 走 `SendInput`：目标窗口以管理员权限运行时会被 UIPI 忽略，让两边同权限；
  Raw Input / DirectInput 游戏可能不认合成输入。
- 两个都只在 Windows 上有效。
