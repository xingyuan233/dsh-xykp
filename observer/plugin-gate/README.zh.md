# dsh-plugin-gate（安装安全闸门）

**DeepSeek Harness 插件的安装安全闸门与数据保护闸 —— 在 `dsh plugin add` 之前，用 60 条静态签名规则（31 高危 / 24 中危 / 5 低危）扫描插件源码中的恶意安装脚本、凭据窃取、混淆与外传行为；并以 12 种危险命令模式与工作区边界检查，在 `rm -rf` 一类误删事故发生前将其拦截。**

插件市场膨胀迅速（数千条目），恶意代码混入插件只是时间问题。本插件为 agent 提供 `gate_scan` 工具，可扫描插件源码——**本地目录**或 **npm tarball**——检测经典恶意代码形态：

| 维度 | 检查内容 |
|---|---|
| **脚本** | npm 生命周期脚本（pre/install/postinstall）、exec/spawn/shell:true、curl\|sh、编码 PowerShell、cmd/WSH 启动、动态 require |
| **混淆** | eval / new Function / vm.runIn*、十六进制转义洪泛、base64 大块、字符数组打包 |
| **权限** | 读取凭据环境变量（OPENAI_API_KEY 等）、读取 ssh/aws/npmrc 文件、写入系统/家目录/点文件、chmod 777、沙箱权限升级请求 |
| **网络** | 外部 URL 与主机、fetch/axios/socket/WebSocket/DNS API、云元数据端点（169.254.169.254）、Discord/Telegram/Slack webhook、.onion、读文件后外发的"窃取"形态 |
| **密钥** | 硬编码 `sk-` 密钥、`ghp_` token、AWS key、私钥块、Bearer token |
| **供应链** | 精确版本直接依赖对接 **Google OSV** 漏洞库核查（range 与官方 @deepseek-ai 包跳过；可配置，离线静默降级） |

闸门**只读**：绝不执行被扫描的代码，绝不写文件。

## 安装

```bash
dsh plugin --profile <profile> add dsh-plugin-gate
```

## 使用

安装插件前让 agent 扫描（插件也会注入提示词，引导 agent 自动执行）：

```
gate_scan target: "npm:dsh-plugin-some-package"
gate_scan target: "npm:dsh-plugin-some-package@1.2.3"   # 固定版本
gate_scan target: "./downloaded-plugin"                 # 本地目录
```

### 判定语义

- **BLOCK**：存在高危特征（安装期执行、编码 PowerShell、eval/Function、云元数据探测、webhook、私钥、读取凭据）。修复并重新扫描前不要安装。
- **WARN**：中等风险特征需人工复核（网络 I/O、家目录写入、base64 大块）。逐条看证据再决定。
- **PASS**：未发现风险签名。仅为启发式结果，对陌生作者仍需保持警惕。

上下文感知：文件未 import `child_process` 时，`exec()`/正则 `RegExp#exec` 命中会被降级，减少误报；代码执行类规则（exec、eval、curl|sh、PowerShell…）出现在**注释或文档**中时自动降为 low（示例而非行为），而密钥与 webhook 即使在注释中仍保持高警示。依赖从 git/http/file 安装会标记为 `risky_dependency`，超 4000 字符的压缩单行标记为 `minified_line`（low）。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `maxFiles` | 1000 | 目录扫描文件数上限 |
| `maxFileBytes` | 2 MiB | 单文件文本上限 |
| `includeNodeModules` | false | 是否进入 node_modules |
| `maxTarballBytes` | 32 MiB | npm tarball 下载上限 |
| `allowlistHosts` | [] | 白名单主机（不出现在未白名单列表） |
| `osvCheck` | true | 对接 Google OSV 查询精确版本依赖的已知漏洞 |
| `osvMaxDeps` | 8 | 最多检查的精确版本直接依赖数 |
| `osvTimeoutMs` | 10000 | 单个依赖 OSV 查询超时 |
| `promptSection` | true | 注入 agent 使用指引 |
| `sectionOrder` | 5 | 提示词区块顺序 |

## 开发

```bash
node --check lib/*.js
node test/rules.test.mjs   # 主模块方式（DSH 沙箱内 node --test 会被拦截）
node test/scan.test.mjs
```

纯逻辑位于 `lib/rules.js`（签名规则）、`lib/targz.js`（内存 tar.gz 解压）、`lib/scan.js`（编排与判定）；Cordis 插件为 `lib/index.js`。

## 安全

闸门绝不执行被扫描内容，是启发式签名扫描器——可能漏报新型恶意代码，也可能误报正常代码。BLOCK/WARN 命中请人工复核，详见 [SECURITY.md](SECURITY.md)。

## 许可证

MIT
