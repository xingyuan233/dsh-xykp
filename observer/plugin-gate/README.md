# dsh-plugin-gate

> ## ⚠️ 这是别人的库，我们只改了一点
>
> - 原始项目：<https://github.com/863683348/dsh-plugin-gate>（MIT，作者 863683348）
> - 本地改动（详见 `patches/plugins/dsh-plugin-gate/README.md`）：**只修了 `gate_guard` 工具的参数声明**。
>   原作者把参数包在 `input` 里（`parameters: { input: { command, path, action } }`），但 `execute` 直接读
>   `args.command` / `args.path`，两边对不上 → 不管怎么调用都返回 “provide either command or path”，工具实际不可用。
>   现在参数改成顶层 `command` / `path` / `action`，`execute` 里加兼容层，两种形态都认。这是上游 bug，官方修了就能还原。
> - **2026-10-27 补修：写文件没传 sandbox policy。** `gate_report write=true` / `gate_diff update=true`
>   调 `ctx.fs.writeText(...)` 时少传第 5 个参数，dsh-fs-sandbox 就退回「部署默认」workspace-write，
>   会话开着 danger-full-access 也照样被拒（`file access denied under workspace-write mode`）。
>   现在按 dsh-tool-fs 的做法补上 `ctx.sandboxPolicy.resolve({ session: exec.agent.session })`。
>   同样是上游 bug，官方修了就能还原。
> - 本仓库改成 `private`，只为自用，**不发布到 npm**；版权与 LICENSE 归原作者。
>
> ## ⚠️ 静态检查 ≠ 100% 准确
>
> 这些规则是**启发式签名匹配**，不是证明：
> - `PASS` 只代表「没匹配到已知的坏形状」，不代表安全
> - `WARN` 必须人工看上下文（正经插件也可能需要网络/写家目录）
> - `BLOCK` 是「高度可疑」，不等于已确认恶意
>
> 它是道闸，不是保证。


**Installation safety gate & data-protection guard for DeepSeek Harness — 60 static signature rules (31 high / 24 medium / 5 low) scan plugin sources for malicious install scripts, credential theft, obfuscation and network callbacks before you run `dsh plugin add`, and 12 destructive-command patterns plus workspace-boundary checks stop `rm -rf`-class accidents before they happen.**

The plugin marketplace is growing fast (thousands of entries), and malicious code mixed into a plugin is only a matter of time. `dsh-plugin-gate` gives the agent a `gate_scan` tool that inspects a plugin source — a **local directory** or an **npm tarball** — for the classic malware shapes:

| Domain | What it checks |
|---|---|
| **Scripts** | npm lifecycle scripts (pre/install/postinstall), exec/spawn/shell:true, curl|sh, encoded PowerShell, cmd/WSH launch, dynamic require |
| **Obfuscation** | eval / new Function / vm.runIn*, hex-escape floods, base64 blobs, char-array packing |
| **Permissions** | credential env reads (`OPENAI_API_KEY` etc.), ssh/aws/npmrc file reads, writes to system/home/dotfile paths, chmod 777, sandbox-escalation requests |
| **Network** | external URLs & hosts, fetch/axios/socket/WebSocket/DNS APIs, cloud-metadata endpoints (169.254.169.254), Discord/Telegram/Slack webhooks, .onion, read-then-send exfiltration shape |
| **Secrets** | hardcoded `sk-` keys, `ghp_` tokens, AWS keys, private key blocks, bearer tokens |
| **Supply chain** | exact-version direct dependencies checked against **Google OSV** (ranges and official @deepseek-ai packages skipped; configurable, offline-degrades) |

The gate is **read-only**: it never executes scanned code and never writes files.

## Compatibility

Tool schemas are validated against the `@deepseek-ai/dsh-tools` value-schema DSL at plugin load (checked against dsh-tools 0.1.0-rc.6 and 0.1.1-rc.2). Earlier releases used JSON-Schema `required` at the root of `output.schema` and closed nested objects without declared properties, which made the host abort the whole profile boot with `unsupported JSON schema: schema.required is not supported by the value schema DSL` and could reject the tool's own results. Current releases fix both; if an affected version left your DSH unable to start, remove the plugin from the profile (or upgrade) — no data is lost.

## Install

In your DSH profile:

```bash
dsh plugin --profile <profile> add dsh-plugin-gate
# or add the bundle patch manually:
#   dsh --profile <profile> --patch ./node_modules/dsh-plugin-gate/cordis.patch.yml
```

## Usage

Ask the agent to scan a plugin before installing it:

```
gate_scan target: "npm:dsh-plugin-some-package"
gate_scan target: "npm:dsh-plugin-some-package@1.2.3"   # pinned version
gate_scan target: "./downloaded-plugin"                 # local directory
```

### v1.3 - Baselines & reports

After a fix, prove the risk is gone — and that nothing new appeared:

    gate_diff target: "npm:dsh-plugin-some-package"          # new / resolved / changed / unchanged vs the stored baseline
    gate_diff target: "./downloaded-plugin" update: true     # store this scan as the new baseline

Findings are fingerprinted by **rule + severity + file** (line shifts do not create false "new" entries). The baseline lives at `.dsh/gate-baseline.json` inside the session workspace.

Attach evidence to a ticket, PR or CI job:

    gate_report target: "npm:dsh-plugin-some-package"                       # Markdown report
    gate_report target: "./plugin" format: "json" write: true               # JSON report written to .dsh/gate-report.json

### v1.1 - Data-protection guard

Before any destructive operation, ask the agent to evaluate it with gate_guard:

    gate_guard command: "rm -rf ./node_modules"
    gate_guard path: ".dsh-memory-setup/memory.json" action: "delete"

- **BLOCK** - device/root-level destruction (rm -rf /, rmdir /s /q, format, dd to a block device, mkfs, drive-root deletes): refuse.
- **WARN** - recursive/force deletes, targets outside the workspace, or critical files (memory.json, .git, ...): confirm the exact target first.
- **PASS** - no destructive signature detected.

Result shape:

```json
{
  "verdict": "BLOCK" | "WARN" | "PASS",
  "score": 254,
  "summary": { "high": 0, "medium": 1, "low": 3, "categories": { "network": 4 } },
  "network": { "hosts": [...], "unallowlisted": [...], "readAndSendFiles": [...] },
  "hits": [{ "rule": "fetch_call", "category": "network", "severity": "medium",
             "file": "lib/index.js", "line": 12, "evidence": "...", "hint": "..." }],
  "recommendations": [...]
}
```

### Verdict semantics

- **BLOCK** — at least one high-severity signature. Do not install until the maintainer ships a clean rebuild you can scan again.
- **WARN** — medium-severity patterns that need manual review (network I/O, home-path writes, base64 blobs). Inspect every hit in context.
- **PASS** — no risky signatures. Heuristic only — keep normal caution with unknown maintainers.

Context-aware rules: `exec()`/`execSync()` hits are downgraded when the file does not import `child_process` (typical `RegExp#exec` false positive); code-context rules (exec, eval, curl|sh, PowerShell…) are downgraded to low when found in **comments or documentation** (examples, not behavior) — while secrets and webhooks stay flagged even in comments. Dependencies installed from git/http/file URLs are flagged as `risky_dependency`, and >4000-char minified lines as `minified_line` (low).

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `maxFiles` | 1000 | hard cap on scanned files per directory walk |
| `maxFileBytes` | 2 MiB | per-file text cap |
| `includeNodeModules` | false | descend into node_modules |
| `maxTarballBytes` | 32 MiB | npm tarball download cap |
| `allowlistHosts` | [] | hosts never listed as unallowlisted |
| `osvCheck` | true | query Google OSV for known vulnerabilities on exact-version deps |
| `osvMaxDeps` | 8 | max exact-version direct deps checked |
| `osvTimeoutMs` | 10000 | per-dep OSV query timeout |

## Development

```bash
node --check lib/*.js
node test/rules.test.mjs   # main-module mode (node --test is blocked in the DSH sandbox)
node test/scan.test.mjs
```

Pure logic lives in `lib/rules.js` (signatures), `lib/targz.js` (in-memory tar.gz), `lib/scan.js` (orchestration + verdict). The Cordis plugin is `lib/index.js`.

## Security

The gate never executes scanned content. It is a heuristic signature scanner — it can miss novel malware and over-flag innocent code. Review BLOCK/WARN hits yourself; see [SECURITY.md](SECURITY.md).

## License

MIT


## Roadmap

See [ROADMAP.md](./ROADMAP.md) — next five versions (v1.3.0 – v1.7.0): baselines & reports, configurable rules, pre-install interception, dependency SBOM, team policy & CI.
