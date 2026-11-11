# senses/balance-reporter · VK-1 页面余额挂件

在 DSH 网页**右下角**养一只 VK-1 余额宠物：平板实时显示 DeepSeek 账号余额，扣费会红闪、震动、飘 `-0.01`，充值会掉一盆米饭，拖到她身上才入账。

这是 [VKmich16/VK-1](https://github.com/VKmich16/VK-1) 的 DSH 插件版，页面侧复用 [YCTS-otree](https://github.com/YCTS-otree/VK-1) 的 MIT 网页移植（widget.js 与美术/音效），再包进 `dsh-xykp` 的插件结构。

## 现在就能用（不用重启 dsh）

页面侧（`dsh-xykp/client.js` 里的生成段）已经接进客户端 bundle：

1. 在 DSH 页面按 **F5** 刷新（client bundle 改了以后需要刷新；不重启 dsh 服务）。
2. 右下角出现挂件。余额来自 `ctx.remote.account`，12 秒刷新一次。
3. **右键/长按她：直接打开设置**；**双击平板：立即刷新余额**；隐藏挂件在 设置 → 显示 → 挂件。
4. 隐藏后右下角留一个 **VK** 小圆钮，点一下回来。
5. 鼠标移到输入框 / 发送按钮 / 模型选择附近时她会平滑地淡出（0.55s 过渡），不挡点击；移开就回来。
6. **滚轮**：在平板上切换「余额 / 时钟 / 余额+倒计时」，在角色身上直接缩放大小。

## 设置界面

只有三个页签：**显示 / 动画 / 声音**。

- **显示**：主题（跟随系统 / 浅色 / 深色）、文本显示（三选一：显示余额 / 显示峰谷时钟 / 显示余额和时钟，默认第三个）、余额刷新（页面轮询间隔，2–300 秒；双击平板可立即刷新）、图形尺寸（预设 + 自定义 px + 缩放系数）、虚化设置（靠近输入区时平滑虚化 + 避让条）、贴边距离（松手吸附范围，按视口比例 0–50% 可调，默认 25% 即原来的 1/4）、数据统计（今日余额 / 今日已用 / 今日充值 / 校准）、挂件（隐藏）。
- **动画**：掉盆 / 扣费 / 抚摸三个开关放最前面，各自的「演示」就在对应功能下面。
- **声音**：总音量 + 每个音效的「试听 / 音量 / 恢复默认」，下面接自定义音效库。

## 峰谷时钟

右键菜单已删掉：滚轮在平板上 / 设置 → 显示 → 文本显示：

- **峰时**：北京时间周一至周五（不含中国法定节假日）**09:00–12:00、14:00–18:00**。
- **谷时**：其余时间（含周末、法定节假日全天），价格是峰时的一半（5 折）。

平板显示三种模式，默认「显示余额和时钟」：

- 显示余额：`DSH 余额` + 金额；
- 显示峰谷时钟：时钟 / 峰时或谷时 5 折 / 倒计时；
- 显示余额和时钟：**上面一行倒计时**（峰时橙色、谷时绿色），下面金额。

法定节假日表由 `client/make-holidays.mjs` 从 [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn) 生成，覆盖 **2025–2027**；新年份公布后重跑该脚本即可更新 `client/peak.js`，再跑 `build.mjs`。调休上班的周末不参与判定（周末本来就是谷时）。

> 旧版上游挂件用的是 00:30–08:30 谷时规则，和现在的峰谷定价不一致；这一版已按新规则改掉。

### 节假日数据怎么持久

按优先级叠了四层，任何一层挂了都还有兜底：

1. `client/peak.js` 里的内嵌快照（离线可用，覆盖生成时的年份）。
2. 宿主插件每周自动从 holiday-cn 拉取，落盘到 `$DSH_HOME/xykp/balance-reporter/holidays.json`，启动/每 6 小时检查。
3. 页面把宿主/直连拿到的表存到 `localStorage['xykp-balance-reporter-holidays']`（7 天内复用，跨刷新保留）。
4. 宿主没加载且缓存过期时，页面直接拉 `raw.githubusercontent.com`（只拉缺失年份，失败就继续用内嵌表）。

更新内嵌快照/兜底文件：

```powershell
node D:\AI\DeepseekHarness\plugins\senses\balance-reporter\client\make-holidays.mjs
node D:\AI\DeepseekHarness\plugins\senses\balance-reporter\client\build.mjs --install
```

`make-holidays.mjs` 自动取「去年～后年」，缺的年份跳过（例如 2028 还没公布就跳过）。`balance_report(action="holidays")` 可以看当前覆盖年份、更新时间和来源。

## 宿主半边（下一次重启后生效）

`senses/balance-reporter/index.js` 提供：

- `balance_report(action?)` 工具：`status` 当前余额 + 变化 / `history` 最近变动 / `refresh` 强制刷新 / `holidays` 节假日数据状态。
- `GET /xykp/balance-reporter/status`：给页面挂件用的缓存快照（含 `at/total/currency/low`）。
- `GET /xykp/balance-reporter/holidays`：节假日表（`days/updatedAt/years/source`）。
- 余额变动会记到 `$DSH_HOME/xykp/balance-reporter/state.json`（最多 400 条，只在数值变化时追加）。
- 节假日缓存写到 `$DSH_HOME/xykp/balance-reporter/holidays.json`；启动时读缓存，缺当前/下一年或超过 `holidayRefreshDays` 就后台从 holiday-cn 拉一次，之后每 6 小时检查。拉取失败保留旧缓存。

挂件的取值顺序：先走上面的 HTTP 快照（有 10 秒缓存、能拿到历史），404 时自动退回客户端 `remote.account`。所以**没重启时挂件照常工作**，重启后只是更省请求、多一份历史。

配置在 `$DSH_HOME/xykp/balance-reporter/config.yml`（行 id 和目录都是 `balance-reporter`）：

```yaml
enabled: true
tool: true
route: true
lowBalance: 20      # 低于这个数在工具输出里提醒
refreshSeconds: 10  # 宿主余额缓存 TTL
holidays: true      # 是否后台拉取节假日
holidayRefreshDays: 7
holidayUrl: https://raw.githubusercontent.com/NateScarlet/holiday-cn/master
```

> 刷新间隔只控制**页面**多久查一次余额。宿主 `/status` 默认有 10 秒缓存，页面会把 `maxAge=<刷新间隔>` 带过去，所以页面设 2 秒时宿主也会按 2 秒重新取；`balance_report` 工具仍用宿主的 `refreshSeconds` 缓存。

### 挂件外观/交互设置（统一配置）

挂件右键「设置」里的那些参数（主题、文本、尺寸、音效、让开、避让等）以前只存在
浏览器的 localStorage（`dsh-vk1-options` / `dsh-vk1-size` / `dsh-vk1-gap` /
`dsh-vk1-sound`），现在统一写进同一份插件配置 `config.yml`，控制台「插件配置」里也能改：

```yaml
theme: auto            # auto / light / dark
displayMode: both      # balance / clock / both
pollSeconds: 12
size: 340
yieldOn: true          # 鼠标移入时让开
yieldOpacity: 7
scrollGapOn: false
scrollGapPx: 17
scrollGapSnap: 0.25    # 数字=吸附比例，false=关闭
fxBowl: true
fxPat: true
fxHurt: true
soundOn: true
volume: 80
cueVolumes: [100, 100, 100, 100]
```

- 页面通过 `GET /xykp/balance-reporter/ui` 读、`POST` 回写（挂件改动会防抖 400ms 合并保存）。
- 第一次升级时会把浏览器里旧的 localStorage 设置整体迁到 `config.yml`（只迁一次）。
- 位置 `dsh-vk1-pos`、今日用量 `dsh-vk1-usage` 仍留在本地，属于每屏/每天的运行时状态，不算配置。

## 开发


```powershell
# 改完 widget.js / 素材 / client/mount.js 后重新生成 client.js 的生成段
node D:\AI\DeepseekHarness\plugins\senses\balance-reporter\client\build.mjs
# 同时同步到已安装的 dsh-xykp（运行中的宿主会热更新 client bundle）
node D:\AI\DeepseekHarness\plugins\senses\balance-reporter\client\build.mjs --install
```

- `client/widget.js` 是 YCTS 移植的原始文件；`build.mjs` 在构建时打补丁（素材改 data URI、余额走 provider、关更新检查、默认尺寸/边距、隐藏菜单）。
- `assets/*.webp` 是从上游 PNG 压到 640px 的版本，只为塞进单文件 bundle；原始素材见上游仓库。
- 改素材后需要重跑 build（会重新 base64 内联）。

## Credits

- 上游桌宠与美术：VKmich16/VK-1（MIT，见 `NOTICE`）。
- DSH 网页移植：YCTS-otree/VK-1 `dsh-plugin`（MIT）。
- 法定节假日数据：[NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn)（MIT）。
- 本目录的插件包装、宿主快照/工具、客户端接入：dsh-xykp。
