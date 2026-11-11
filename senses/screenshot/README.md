# screenshot — 屏幕截图（原生工具 `screenshot_acquire`）

给 agent 的「看屏幕」工具：dxcam 抓帧 → 内存里编码成 PNG/JPEG → 作为附件直接进对话。
**没有临时文件、没有 `read_image`、没有清理。**

```
抓屏 -> PNG 编码 -> 写文件 -> read_image 读/解码 -> 图片附件   （旧的 set 文件方案）
抓屏 -> 字符网格 -> stdout -> 模型读文本                        （screen-read）
抓屏 -> PNG/JPEG 编码 -> attachment -> 对话里的图片             （现在）
```

## 对外工具

模型看到的是 **`screenshot_acquire`**（`index.js` 注册的原生工具，没有 `mcp__` 前缀）：

| 参数 | 说明 |
|---|---|
| `window` | 窗口标题子串（不分大小写）或纯数字 hwnd，抓该窗口；留空抓整屏 |
| `region` | `"x,y,w,h"`，物理像素，相对主屏左上角；与 `window` 二选一 |
| `capture` | `auto`（默认）/ `desktop` / `window`，见下节 |
| `client` | `window` 模式下只抓客户区（游戏内容区），默认 `true` |
| `child` | `window` 模式直接抓最大的子窗口（模拟器/内嵌画面）；默认先顶层，读不到再试子窗口 |
| `fmt` | `auto`（默认，按画面内容自选，见下节）／`png`（强制无损）／`jpg`（强制压缩，适合追帧） |
| `quality` | jpg 质量 1-100，默认 95 |
| `max_side` | 长边上限，超过用 `INTER_AREA` 缩小，默认 1568；`<=0` 不缩 |
| `list_windows` | `true` 时只列可见窗口（标题/hwnd/位置/大小/子窗口数），不截图——用来挑 `window` |

返回文本带 `capture=… fmt=… region=… image=… scale=…`（窗口抓取还有 `method`/`target`/`hwnd`，
`fmt=auto` 时 `note=` 里带判定依据）：
图上量到的坐标乘 `1/scale`、再加 region 原点就是屏幕坐标，可直接交给 `mouse_input`；
`capture=window` 且 `client=true` 时，图上坐标就是 `mouse_input(window=…)` 的客户区坐标。

## 两种抓法

| capture | 后端 | 被遮挡时 | 适用 |
|---|---|---|---|
| `desktop` | dxcam / DXGI 桌面复制，裁剪窗口所在区域 | 截到**遮挡物**（就是屏幕上现在看到的） | 窗口在前台、要屏幕真实画面 |
| `window` | `PrintWindow(PW_RENDERFULLCONTENT)` → `BitBlt` 窗口 DC 兜底（`way.py` 同款） | 直接读该窗口自己的表面，**被遮挡也能截** | 后台窗口、模拟器、要确定性画面 |

`auto`（默认）：给了 `window` 就先试 `window`，读不到再退回 `desktop`，返回文本里 `note=` 会说明原因。
顶层窗口读到空白时会自动试它最大的子窗口（模拟器画面常在子窗口里）；`child=true` 则直接只抓子窗口。

**局限**：DirectX 独占全屏、部分 GPU 合成窗口（某些游戏/浏览器）`PrintWindow`/`BitBlt` 只能拿到空白，
此时 `capture=window` 报错、`auto` 退回桌面裁剪；最小化窗口也基本抓不到画面。DPI 不感知的旧程序
用 `window` 抓可能会在右下留一条黑边（Windows 把它的内容按 96DPI 渲染）。


## 自动选格式（`fmt=auto`）

`fmt` 默认就是 `auto`：先在**缩略图**（默认 256 长边）上算三个廉价指标，
再编码选中的那一种，不会两种都编。想要稳定无损显式给 `png`，追帧显式给 `jpg`。

| 指标 | 含义 |
|---|---|
| `uniq` | 唯一色占比（UI/文字低，照片/视频帧高） |
| `flat` | `\|Laplacian\| < 2` 的像素占比（大片纯色 = UI） |
| `edge` | Canny 边缘占比（文字细边多） |

判定顺序（先命中先返回）：

1. `uniq < png_max_uniq` → **png**（纯 UI / 终端 / 图表）
2. `flat > flat_text` → **png**（带图的界面、网页、桌面，保住小字）
3. `uniq > jpg_min_uniq` → **jpg**（照片、视频帧、游戏画面）
4. `uniq < uniq_mid` 且 `edge > edge_dense` → **png**（文字密集）
5. 其余 → **jpg**

实测：白底文字 UI / 深色终端 / 照片+文字的网页 → png；纯照片 → jpg。
开销在缩略图上，4K 帧约 13ms、2560 宽约 6ms（`INTER_AREA` 缩放占大头）。

阈值在 `home/xykp/senses-screenshot/config.yml` 的 `auto` 下，**改完下一次调用就生效**，不用重启：

```yaml
auto:
  png_max_uniq: 0.12
  jpg_min_uniq: 0.55
  flat_text: 0.45
  edge_dense: 0.02
  uniq_mid: 0.35
  thumb: 256      # 判定用缩略图长边，越大越准也越慢
```

判定结果和依据写在返回文本里（`fmt=jpg note=auto->jpg(photo uniq=0.97 flat=0.12 edge=0.000)`），
判错了照这个调阈值就行。


## 后端

`server.py` 是原来那个 MCP server（工具 `screenshot` / `screen_info`）扩展而来：
`desktop` 仍走 dxcam，`window` 新增 PrintWindow/BitBlt 两条 GDI 路径。
由 `senses/lib/mcp-bridge.mjs` 以 stdio 调起来，`index.js` 负责包装成原生工具：
文本原样透传，图片块经 `ctx.attachments.saveImages()` 变成 durable attachment。
模型没声明图片输入时只回文字，不塞图。

## 挂载

`dsh-xykp` 是 bundle 包，注册行在仓库根 `cordis.patch.yml`（`dsh.bundle.patch`），profile 里不重复 insert：

```yaml
- insert:
    - id: senses-screenshot
      name: 'dsh-xykp/senses/screenshot'
```

改了 `index.js` 要重启 `dsh web` 才生效（工具定义进的是宿主进程）；只改描述文字不用重启。
Python 进程在第一次调用时拉起。


## 实测（这台机器）

| 场景 | 耗时 | 大小 |
|---|---|---|
| 640×360 JPEG q95 | ~10ms | 46KB |
| 1280×720 PNG | ~30~45ms | 140~230KB |
| 窗口截图（植物大战僵尸，1000×562 PNG） | ~50ms | — |

## 注意

- 子进程 cwd 固定在 `home\xykp\senses-screenshot`：驱动/库往 cwd 写的日志不会进插件目录（更新插件不丢数据）。
- `desktop` 抓的是**合成后的桌面**：窗口被遮挡，抓到的是遮挡后的画面；最小化会停更。
  `window` 抓的是窗口自己的表面，不受遮挡影响（局限见上节）。
- **DXGI 桌面复制是每个输出独占的**：本进程空闲 15 秒会释放复制会话，把主屏让给
  别的 dxcam 进程；下次调用重建只要 ~13ms。两边同时抓，后来的会拿到
  `DXGI_ERROR_NOT_CURRENTLY_AVAILABLE`，重试或错开即可。
- 独占全屏抓不到，游戏请用「无边框窗口」。
- 目前只挂主屏（`output 0`）；多屏要加 `output` 参数。
- `region` 是物理像素；进程已按 per-monitor DPI aware 设置。
- 依赖：`dxcam`、`mcp`、`opencv-python`（都已装在全局 Python 3.12）。

## 测试

```powershell
python test_client.py                 # 直接测后端 MCP server
node ..\lib\test-bridge.mjs           # 测桥接层（截图 + 输入状态）
```
