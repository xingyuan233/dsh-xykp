# screen-mcp — 屏幕截图 MCP（直接返回图片，不落盘）

给 agent 的「看屏幕」工具：dxcam 抓帧 → 内存里编码成 PNG/JPEG → 作为 MCP
`image` content block 直接返回。**没有临时文件、没有 `read_image`、没有清理。**

对比原来的两条路：

```
抓屏 -> PNG 编码 -> 写文件 -> read_image 读/解码 -> 图片附件   （文件方案）
抓屏 -> 字符网格 -> stdout -> 模型读文本                        （screen-read）
抓屏 -> PNG/JPEG 编码 -> MCP image block                        （本工具）
```

## 工具

| 工具 | 说明 |
|---|---|
| `screenshot(region?, window?, client=True, fmt="png", quality=95, max_side=1568)` | 截图并返回图片 |
| `screen_info()` | 列出显示器尺寸和可见窗口（标题/位置/大小），用来挑 `window` |

- `region`：`"x,y,w,h"`，物理像素，相对主屏左上角
- `window`：窗口标题子串，取面积最大的匹配窗口；`client=True` 只取客户区（游戏内容区）
- `fmt`：`png`（无损，适合文字/UI）或 `jpg`（快，适合追帧）
- `max_side`：长边上限，超过用 `INTER_AREA` 缩小；`<=0` 不缩

## 挂载

源码在 `dsh-xykp` 仓库的 `senses/screenshot/`（原 `tools\screen-mcp`），
挂载片段见同目录 `mount.yml`，已写进 `D:\AI\DeepseekHarness\home\profiles\web\cordis.patch.yml`：

```yaml
- insert:
    - id: mcp-screen
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: screen
        command: 'D:\Program-Files\Python\312\python.exe'
        args:
          - 'D:\AI\DeepseekHarness\plugins\senses\screenshot\server.py'
        cwd: 'D:\AI\DeepseekHarness\plugins\senses\screenshot'
        env:
          PYTHONUTF8: '1'
          PYTHONIOENCODING: 'utf-8'
        failOnStartupError: false
```

profile 层是热重载的，改完不用重启；工具名会变成
`mcp__screen__screenshot` / `mcp__screen__screen_info`。

## 实测（这台机器）

| 场景 | 耗时 | 大小 |
|---|---|---|
| 640×360 JPEG q95 | ~10ms | 46KB |
| 1280×720 PNG | ~30~45ms | 140~230KB |
| 窗口截图（植物大战僵尸，1000×562 PNG） | ~50ms | — |

## 注意

- DDA 抓的是**合成后的桌面**：窗口被遮挡，抓到的是遮挡后的画面；最小化会停更。
- **DXGI 桌面复制是每个输出独占的**：本进程空闲 15 秒会释放复制会话，把主屏让给
  别的 dxcam 进程；下次调用重建只要 ~13ms。如果两边同时抓，后来的那个会拿到
  `DXGI_ERROR_NOT_CURRENTLY_AVAILABLE`，重试或错开即可。
- 独占全屏抓不到，游戏请用「无边框窗口」。
- 目前只挂主屏（`output 0`）；多屏要加 `output` 参数。
- `region` 是物理像素；进程已按 per-monitor DPI aware 设置。
- 依赖：`dxcam`、`mcp`、`opencv-python`（都已装在全局 Python 3.12）。

## 测试

```powershell
python test_client.py     # 用官方 MCP client 起 server，调 screenshot，验证图片
```

