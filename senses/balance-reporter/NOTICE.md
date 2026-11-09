# 第三方素材与代码来源

本目录的页面挂件不是从零写的，而是把下面几个 MIT 项目的成果接进 `dsh-xykp`：

## 1. 桌宠与美术 / 音效

- 项目：**VKmich16/VK-1** —「大肥鱼桌宠现代化改_D-16BVM」
- 地址：https://github.com/VKmich16/VK-1
- 使用内容：`windows/` 桌宠的四个表情、米饭、铁盆、摸头手、四段音效，以及扣费/充值/铁盆/喂食等行为设计。
- 许可：MIT（见本目录 `LICENSE` 的上游版权行）。
- 本地改动：PNG 用 Pillow 等比缩到 640/384/320/192 并转 WebP（`assets/*.webp`），仅为把素材塞进单文件客户端 bundle；音效保持原样。

## 2. DSH 网页移植（widget.js）

- 项目：**YCTS-otree/VK-1** 的 `dsh-plugin/`
- 地址：https://github.com/YCTS-otree/VK-1
- 版本：dsh-plugin 1.0.2 之后的 main（本地取用 commit `84a4e7dbec9bef8de83b5fa5555aa8525f7ecc46`，2026-11）
- 使用内容：`widget.js`（页面内的角色、物理、表情、菜单、设置、音效库）与其 README 描述的行为。
- 许可：MIT；`widget.js` 文件头保留了上游的移植说明。
- 本地改动（全部由 `client/build.mjs` 在构建时完成，`client/widget.js` 保留原样）：
  - 素材 URL → `__xykpVk1Assets` 的 data URI；
  - `balance.json` 轮询 → `window.__xykpVk1BalanceProvider()`；
  - 关闭 GitHub 更新检查；
  - 轮询 2s → 12s；默认尺寸 454 → 340；右下角留 10px / 8px 边距；
  - 右键菜单增加「隐藏挂件」；
  - 峰谷时钟从上游的 00:30–08:30 谷时规则改为现行规则（由 `client/peak.js` 提供）。

## 3. 法定节假日数据

- 项目：**NateScarlet/holiday-cn**
- 地址：https://github.com/NateScarlet/holiday-cn
- 用途：`client/peak.js` 里 2025–2027 年中国法定节假日 `isOffDay` 日期（周末/节假日判谷时）。
- 许可：MIT。
- 重新生成：`node client/make-holidays.mjs`。

## 4. 本目录新增

- `index.js`：宿主插件（`balance_report` 工具、`/xykp/balance-reporter/status` 快照、变动历史、节假日缓存）。
- `client/mount.js`：客户端接入（余额 provider、隐藏/恢复、HMR 生命周期、节假日缓存、输入区虚化）。
- `client/build.mjs`：把 widget + 素材 + mount 拼进包根 `client.js`。
- `client/widget.js` 里的设置界面重排为「显示 / 动画 / 声音」、平板三种文本模式、滚轮切换/缩放、虚化与避让条分节，也是 dsh-xykp 改的。
- 以上为 dsh-xykp 原创，随本包 MIT 发布。
