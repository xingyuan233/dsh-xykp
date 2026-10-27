# dsh-plugin-gate 路线图（Roadmap）

> 基线：**v1.2.0**（已发布 npm / 已挂 vertical-toolkits profile）
> 范围：接下来 5 个版本 **v1.3.0 → v1.7.0**
> 规划原则：规则与扫描保持纯函数可单测；只读不执行被扫代码；每个 minor 交付 1–2 个可独立验证的能力。

## 版本总览

| 版本 | 主题 | 关键交付 |
|---|---|---|
| v1.3.0 | 基线与报告 | `gate_diff` 与上次扫描对比（新增/修复风险）+ `gate_report` 结构化导出（md/json） |
| v1.4.0 | 规则可配置 | 自定义签名 YAML + 白名单/忽略项（按规则 id、路径、仓库） |
| v1.5.0 | 安装前拦截 | 工具执行前钩子：识别 `dsh plugin add` 自动先扫描 |
| v1.6.0 | 依赖与 SBOM | 递归依赖扫描 + SBOM（SPDX-lite）导出 |
| v1.7.0 | 团队策略与 CI | 策略文件 + 阈值门禁 + CI 退出码 |

## v1.3.0 ✅ 已完成 — 基线与报告

### 新增能力
- **`gate_diff`**：把本次扫描结果与工作区基线（`.dsh/gate-baseline.json`）对比，输出**新增风险 / 已修复 / 未变**三张清单（按规则 id + 证据指纹），便于「修完再扫」的闭环。
- **`gate_report`**：把扫描结果导出为结构化报告（Markdown + JSON），含规则命中统计、按严重度分组、证据链与目标元信息。

### 实现位置
- `lib/baseline.js`（新增）：findings 指纹、基线合并、diff 计算（纯函数）
- `lib/report.js`（新增）：报告渲染（Markdown / JSON）
- `lib/index.js`：注册 `gate_diff` / `gate_report`，扫描后可写入基线

### 验收标准
- [ ] `node --check` 通过；新增单测 ≥ 8 个（指纹稳定性、diff 三分类、报告渲染、边界）
- [ ] 原有 4 个测试文件全绿
- [ ] README 更新（新工具、基线文件与工作区 containment 说明）
- [ ] vertical-toolkits dump-config 正常

## v1.4.0 — 规则可配置

- 自定义签名（YAML：正则/严重度/说明）+ 规则启停
- 白名单与忽略项（按规则 id、路径 glob、仓库），带过期时间

## v1.5.0 — 安装前拦截

- `tools/pre-execute` 钩子：检测 `dsh plugin add` / `pnpm add` 目标并自动先扫描
- 拦截策略：命中高危 → 建议阻断并给出替代方案

## v1.6.0 — 依赖与 SBOM

- 递归依赖扫描（transitive）+ 版本区间风险
- SBOM 导出（SPDX-lite JSON：包、版本、许可证、来源）

## v1.7.0 — 团队策略与 CI

- `gate.policy.yml`：严重度阈值、必须通过的规则集、豁免流程
- CI 模式：退出码与注释输出，便于流水线门禁

## 发布节奏

每个版本走完整 dsh-factory 流程：本地验证 → npm publish → GitHub topic → awesome PR。
