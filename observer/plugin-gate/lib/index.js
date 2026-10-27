/**
 * dsh-plugin-gate — installation safety gate for DeepSeek Harness plugins.
 *
 * A Cordis plugin. When this package is a profile layer (declares
 * dsh.bundle.patch), its cordis.patch.yml inserts this row into the launcher
 * composition: the host runner loads this file, registering the gate_scan
 * model tool plus prompt guidance. The gate acts as an "antivirus" review
 * step: before the agent runs 'dsh plugin add' on any marketplace plugin, it
 * scans the plugin source (a local directory or an npm tarball) for
 * malicious install scripts, dangerous permissions/fs usage, credential
 * reads, obfuscation, and network callbacks, and returns a BLOCK / WARN /
 * PASS verdict with per-line evidence.
 *
 * The gate is read-only: it never executes scanned code and never writes
 * files. It is a heuristic scanner, not a formal guarantee.
 *
 * @module dsh-plugin-gate
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { scanDirectory, scanNpmPackage } from "./scan.js";
import { evaluateCommand, evaluatePath } from "./protect.js";
import { buildBaseline, diffBaseline, renderDiff } from "./baseline.js";
import { renderJsonReport, renderMarkdownReport } from "./report.js";

/** Cordis plugin name (registered with the loader). */
const name = "gate";

/** Services this plugin must resolve before it applies (host face). */
const inject = ["tools", "fs", "systemPrompt"];

/** Composition-row configuration for the plugin entry. */
const Config = z.object({
  /** Hard cap on scanned files per directory walk. */
  maxFiles: z.number().default(1000),
  /** Per-file byte cap for text scanning. */
  maxFileBytes: z.number().default(2 * 1024 * 1024),
  /** Descend into node_modules when scanning a directory. */
  includeNodeModules: z.boolean().default(false),
  /** Hard cap on npm tarball download size. */
  maxTarballBytes: z.number().default(32 * 1024 * 1024),
  /** Hostnames considered trusted (never listed as unallowlisted). */
  allowlistHosts: z.array(z.string()).default([]),
  /** Query Google OSV for known vulnerabilities on exact-version deps. */
  osvCheck: z.boolean().default(true),
  /** Max exact-version direct deps checked against OSV. */
  osvMaxDeps: z.number().default(8),
  /** Per-dep OSV query timeout. */
  osvTimeoutMs: z.number().default(10000),
  /** Register the gate prompt-guidance section. */
  promptSection: z.boolean().default(true),
  /** Order of the gate prompt section (ascending; persona is 0). */
  sectionOrder: z.number().default(5),
  /** Baseline file for gate_diff, relative to the session workspace. */
  baselineFile: z.string().default(".dsh/gate-baseline.json"),
  /** Report file for gate_report writes, relative to the session workspace. */
  reportFile: z.string().default(".dsh/gate-report.md"),
});

/** Prompt section telling the agent when and how to use the gate. */
const GATE_SECTION_TEXT = "Installation safety gate: before installing any plugin from a marketplace, npm registry, or untrusted repository (e.g. before running 'dsh plugin add' or adding a bundle), call gate_scan on the plugin source — a local directory path, or an npm package with the npm: prefix (for example gate_scan with target \"npm:dsh-plugin-focus\" or \"npm:dsh-plugin-focus@1.0.1\").\n\nInterpret the verdict strictly:\n- BLOCK: high-severity patterns were found (install-time exec, encoded PowerShell, eval/Function, cloud-metadata probes, webhooks, private keys, credential reads). Refuse to install until the maintainer ships a clean version you can scan again; do not work around it.\n- WARN: medium-severity patterns need manual review (network I/O, home-path writes, base64 blobs). Inspect every hit in context before deciding; a legit plugin may need network access — verify destinations.\n- PASS: no risky signatures found. This is heuristic, not a guarantee; keep normal caution with unknown maintainers.\n\nThe gate never executes scanned code and never writes files.\n\nData-protection guard: BEFORE running any destructive command (rm -rf, Remove-Item -Recurse, rmdir /s, del /f /s, format, dd, mkfs) or deleting/overwriting a file, call gate_guard with the command or the target path. It returns BLOCK (device/root level — refuse), WARN (recursive/outside-workspace/critical file — confirm the exact target), or PASS.";

/** Resolve the tool's per-scan options from plugin config + call args. */
function scanOpts(config, args) {
  const opts = {
    maxFiles: config.maxFiles,
    maxFileBytes: config.maxFileBytes,
    includeNodeModules: typeof args.includeNodeModules === "boolean" ? args.includeNodeModules : config.includeNodeModules,
    allowlistHosts: config.allowlistHosts,
    osvCheck: config.osvCheck,
    osvMaxDeps: config.osvMaxDeps,
    osvTimeoutMs: config.osvTimeoutMs,
  };
  if (config.maxTarballBytes) opts.maxTarballBytes = config.maxTarballBytes;
  return opts;
}

/**
 * local patch (星鸢专属) 2026-10-27: fs-sandbox 的 per-call policy。
 *
 * `ctx.fs.writeText(target, content, expected, signal)` 不传第 5 个参数时，
 * dsh-fs-sandbox 会用 `ctx.sandboxPolicy.resolve()`（**不带 session**）→ 部署默认
 * workspace-write + 部署默认 workspace root。结果是：会话明明开了
 * danger-full-access，写自己工作区里的报告仍被拒（实测报
 * `file access denied under workspace-write mode`）。
 *
 * 这里按 dsh-tool-fs 的做法，把「当前会话」的 policy 传进去；拿不到就退回
 * undefined（与旧行为一致，不会更糟）。
 */
function sandboxPolicyOf(ctx, exec) {
  const sp = ctx.get("sandboxPolicy");
  if (!sp || typeof sp.resolve !== "function") return undefined;
  try {
    return sp.resolve(exec && exec.agent ? { session: exec.agent.session } : {});
  } catch {
    return undefined;
  }
}

/**
 * Register the gate_scan tool and (when configured) the prompt section.
 * @param ctx - registrant context carrying tools, fs, systemPrompt.
 * @param config - validated plugin configuration.
 */
async function resolveWorkspaceFile(ctx, file, cwd, signal) {
  const target = await ctx.fs.resolve(file, cwd !== undefined ? { cwd, signal } : { signal });
  if (cwd !== undefined) {
    const cwdTarget = await ctx.fs.resolve(".", { cwd, signal });
    if (!ctx.fs.contains(cwdTarget, target)) {
      throw new Error('gate: file "' + file + '" escapes the session workspace');
    }
  }
  return target;
}

function apply(ctx, config) {
  const { baselineFile, reportFile } = config;

  /** Scan one target (npm spec or directory) and canonicalize the result. */
  async function runScan(args, exec) {
    const opts = scanOpts(config, args);
    const spec = String(args.target || "").trim();
    if (spec.length === 0) throw new Error("gate: target is required");
    let result;
    if (spec.startsWith("npm:")) {
      const pkgSpec = spec.slice(4).trim();
      if (pkgSpec.length === 0) throw new Error("gate: npm: needs a package name, e.g. npm:dsh-plugin-focus");
      result = await scanNpmPackage(pkgSpec, {
        fetchImpl: fetch,
        maxTarballBytes: config.maxTarballBytes,
        maxFileBytes: config.maxFileBytes,
        allowlistHosts: config.allowlistHosts,
        timeoutMs: 25000,
      });
    } else {
      const cwd = exec.agent && exec.agent.session && exec.agent.session.header ? exec.agent.session.header.cwd : undefined;
      const target = await ctx.fs.resolve(spec, cwd !== undefined ? { cwd, signal: exec.signal } : { signal: exec.signal });
      result = await scanDirectory(ctx.fs, target, opts, exec.signal);
    }
    const canonical = { ...result };
    if (canonical.package == null) delete canonical.package;
    if (Array.isArray(canonical.hits)) {
      canonical.hits = canonical.hits.map((h) => ({
        rule: h.rule,
        category: h.category,
        severity: h.severity,
        file: h.file,
        line: h.line,
        count: h.count,
        evidence: (h.evidence || "").slice(0, 200),
        hint: (h.hint || "").slice(0, 160),
      }));
    }
    return canonical;
  }

  ctx.tools.register(defineTool({
    name: "gate_scan",
    description: "Installation safety gate for plugins: scan a plugin source (a local directory, or an npm package via the npm: prefix) for malicious install scripts, dangerous permissions and file writes, credential reads, obfuscation, and network callbacks, then return a verdict (BLOCK / WARN / PASS) with per-line evidence. Use it BEFORE installing any plugin from a marketplace or registry. Examples: target \"npm:dsh-plugin-focus\", target \"./downloaded-plugin\", or an absolute directory path.",
    parameters: {
      target: {
        type: "string",
        required: true,
        description: "Where to scan. A local directory path, or an npm spec prefixed with npm: (e.g. npm:dsh-plugin-focus, npm:dsh-plugin-focus@1.0.1).",
      },
      includeNodeModules: {
        type: "boolean",
        description: "Optional override: descend into node_modules when scanning a directory (default off).",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          verdict: { type: "string", enum: ["BLOCK", "WARN", "PASS"] },
          score: { type: "integer" },
          mode: { type: "string" },
          target: { type: "string" },
          filesScanned: { type: "integer" },
          filesTotal: { type: "integer" },
          summary: {
            type: "object",
            additionalProperties: true,
            properties: {
              high: { type: "integer" },
              medium: { type: "integer" },
              low: { type: "integer" },
              categories: { type: "object", additionalProperties: true },
            },
          },
          network: {
            type: "object",
            additionalProperties: true,
            properties: {
              hosts: { type: "array", items: { type: "string" } },
              unallowlisted: { type: "array", items: { type: "string" } },
              readAndSendFiles: { type: "array", items: { type: "string" } },
            },
          },
          package: {
            type: "object",
            additionalProperties: true,
            properties: {
              name: { type: "string" },
              version: { type: "string" },
              lifecycle: { type: "array", items: { type: "object", additionalProperties: true } },
              dependencyCount: { type: "integer" },
              hasDshBundle: { type: "boolean" },
            },
          },
          notes: { type: "array", items: { type: "object", additionalProperties: true } },
          hits: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
              properties: {
                rule: { type: "string" },
                category: { type: "string" },
                severity: { type: "string" },
                file: { type: "string" },
                line: { type: "integer" },
                count: { type: "integer" },
                evidence: { type: "string" },
                hint: { type: "string" },
              },
            },
          },
          recommendations: { type: "array", items: { type: "string" } },
        },
      },
      render: (_args, value) => {
        const lines = [];
        const banner = value.verdict === "BLOCK" ? "BLOCK — do not install" : value.verdict === "WARN" ? "WARN — review before install" : "PASS — no risky signatures";
        lines.push("[gate] " + banner + " (" + value.target + ", score " + value.score + ")");
        lines.push("Scanned " + value.filesScanned + "/" + value.filesTotal + " files. High: " + value.summary.high + ", medium: " + value.summary.medium + ", low: " + value.summary.low + ".");
        for (const h of value.hits.slice(0, 40)) {
          lines.push("  " + h.severity.toUpperCase() + " [" + h.category + "/" + h.rule + "] " + h.file + ":" + h.line + " — " + (h.evidence || "").slice(0, 120));
        }
        if (value.hits.length > 40) lines.push("  ... and " + (value.hits.length - 40) + " more hits (full list in JSON)");
        if (value.network.unallowlisted.length > 0) {
          lines.push("External hosts: " + value.network.unallowlisted.join(", "));
        }
        if (value.package && value.package.lifecycle && value.package.lifecycle.length > 0) {
          lines.push("Lifecycle scripts: " + value.package.lifecycle.map((l) => l.script).join(", "));
        }
        for (const r of value.recommendations) lines.push("- " + r);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    execute: async (args, exec) => {
      return await runScan(args, exec);
    },
    presentCall: (args) => ({
      card: "generic",
      title: "Gate scan: " + String(args.target || ""),
      kind: "other",
      rawInput: args,
    }),
  }));
  ctx.tools.register(defineTool({
    name: "gate_guard",
    description: "Data-protection guard: before ANY destructive operation, evaluate a shell command (gate_guard with command) or a file target (gate_guard with path + action) and get a BLOCK / WARN / PASS verdict with reasons. BLOCK = device/root-level destruction — refuse. WARN = recursive, outside-workspace, or critical file — confirm the exact target first. PASS = no destructive signature. Use it before rm -rf, Remove-Item -Recurse, rmdir /s, del /f /s, format, dd, mkfs, or deleting/overwriting files.",
    parameters: {
      command: { type: "string", description: "要评估的 shell 命令（如 rm -rf ./node_modules）" },
      path: { type: "string", description: "要删除/覆盖的文件或目录路径" },
      action: { type: "string", enum: ["delete", "overwrite", "move"], description: "路径操作类型，默认 delete" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          verdict: { type: "string", enum: ["BLOCK", "WARN", "PASS"] },
          reasons: { type: "array", items: { type: "string" } },
          suggestion: { type: "string" },
        },
      },
      render: (_a, v) => [{ type: "text", text: v.verdict + ": " + v.reasons.join("; ") + "\n" + v.suggestion }],
    },
    execute: async (args, exec) => {
      const cwd = exec.agent?.session?.header?.cwd;
      // 兼容两种入参形态：旧的 { input: { command } } 和标准的 { command }
      const input = args?.input && typeof args.input === "object" ? args.input : args;
      if (input?.command) {
        const r = evaluateCommand(input.command);
        const suggestion = r.verdict === "BLOCK" ? "Refuse: this destroys data at a device or root level. Do not run it." : r.verdict === "WARN" ? "Confirm the exact target before proceeding; it is a recursive/force delete." : "No destructive signature detected — proceed with normal caution.";
        return { verdict: r.verdict, reasons: r.reasons, suggestion };
      }
      if (input?.path) {
        const r = evaluatePath(input.path, cwd, { action: input.action || "delete" });
        const suggestion = r.verdict === "BLOCK" ? "Refuse: the target is a root or the workspace itself. Confirm intent." : "Confirm the exact path before proceeding. A critical file or workspace boundary is involved.";
        return { verdict: r.verdict, reasons: r.reasons, suggestion };
      }
      return { verdict: "WARN", reasons: ["provide either command or path"], suggestion: "Call gate_guard with a command string or a file path." };
    },
    presentCall: (args) => ({ card: "generic", title: "Gate guard", kind: "other", rawInput: args }),
  }));


  ctx.tools.register(defineTool({
    name: "gate_diff",
    description: "Compare a fresh scan of a target against the stored baseline (.dsh/gate-baseline.json in the session workspace): report findings that are NEW, RESOLVED, CHANGED (count differs) or UNCHANGED since the last baseline, plus the verdict transition. Use it after a fix to confirm the risk actually went away and nothing new appeared; pass update=true to store this scan as the new baseline. Findings are fingerprinted by rule + severity + file, so line shifts do not create false 'new' entries.",
    parameters: {
      target: {
        type: "string",
        required: true,
        description: "Where to scan: a local directory path, or an npm spec prefixed with npm: (e.g. npm:dsh-plugin-focus).",
      },
      update: { type: "boolean", description: "Store this scan as the new baseline (default false)." },
      includeNodeModules: { type: "boolean", description: "Descend into node_modules when scanning a directory." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          verdict: { type: "string" },
          added: { type: "integer", required: true },
          resolved: { type: "integer", required: true },
          changed: { type: "integer", required: true },
          unchanged: { type: "integer", required: true },
          clean: { type: "boolean", required: true },
          updated: { type: "boolean", required: true },
          path: { type: "string" },
          text: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    execute: async (args, exec) => {
      const result = await runScan(args, exec);
      const cwd = exec.agent && exec.agent.session && exec.agent.session.header ? exec.agent.session.header.cwd : undefined;
      const path = await resolveWorkspaceFile(ctx, baselineFile, cwd, exec.signal);
      let baseline = null;
      const info = await ctx.fs.stat(path, exec.signal);
      if (info !== undefined) {
        try { baseline = JSON.parse(await ctx.fs.readText(path, exec.signal)); } catch { baseline = null; }
      }
      const target = String(args.target || "");
      const diff = diffBaseline({ baseline, result, target });
      let updated = false;
      if (args.update === true) {
        await ctx.fs.writeText(path, JSON.stringify(buildBaseline({ target, result }), null, 2), undefined, exec.signal, sandboxPolicyOf(ctx, exec));
        updated = true;
      }
      return {
        verdict: result.verdict ?? null,
        added: diff.counts.added,
        resolved: diff.counts.resolved,
        changed: diff.counts.changed,
        unchanged: diff.counts.unchanged,
        clean: diff.clean,
        updated,
        path: ctx.fs.processPath(path),
        text: renderDiff({ diff, target }) + (updated ? "\n\nBaseline updated: " + ctx.fs.processPath(path) : ""),
      };
    },
    presentCall: (args) => ({ card: "generic", title: "Gate diff: " + String(args.target || ""), kind: "other", rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: "gate_report",
    description: "Scan a target and render a structured report — Markdown (default) or JSON — with findings grouped by severity and category, hosts, recommendations, and an optional baseline diff. Set write=true to store it in the session workspace (default .dsh/gate-report.md). Use it to attach evidence to a ticket, a PR or a CI job.",
    parameters: {
      target: {
        type: "string",
        required: true,
        description: "Where to scan: a local directory path, or an npm spec prefixed with npm:.",
      },
      format: { type: "string", enum: ["md", "json"], description: "Report format (default md)." },
      write: { type: "boolean", description: "Write the report to the session workspace (default false)." },
      path: { type: "string", description: "Custom write path inside the session workspace (optional)." },
      withBaseline: { type: "boolean", description: "Include the baseline diff when a baseline exists (default true)." },
      includeNodeModules: { type: "boolean", description: "Descend into node_modules when scanning a directory." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          verdict: { type: "string" },
          format: { type: "string", required: true },
          findings: { type: "integer", required: true },
          path: { type: "string" },
          text: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    execute: async (args, exec) => {
      const result = await runScan(args, exec);
      const format = args.format === "json" ? "json" : "md";
      const findings = Array.isArray(result.hits) ? result.hits.length : 0;
      const cwd = exec.agent && exec.agent.session && exec.agent.session.header ? exec.agent.session.header.cwd : undefined;
      let diff = null;
      if (args.withBaseline !== false) {
        const baselinePath = await resolveWorkspaceFile(ctx, baselineFile, cwd, exec.signal);
        const info = await ctx.fs.stat(baselinePath, exec.signal);
        if (info !== undefined) {
          try {
            const baseline = JSON.parse(await ctx.fs.readText(baselinePath, exec.signal));
            diff = diffBaseline({ baseline, result, target: String(args.target || "") });
          } catch { diff = null; }
        }
      }
      const date = new Date().toISOString();
      const target = String(args.target || "");
      const body = format === "json"
        ? renderJsonReport({ target, result, date, diff })
        : renderMarkdownReport({ target, result, date, diff });
      let writtenPath;
      if (args.write === true) {
        const outFile = args.path || (format === "json" ? reportFile.replace(/\.md$/, ".json") : reportFile);
        const outPath = await resolveWorkspaceFile(ctx, outFile, cwd, exec.signal);
        await ctx.fs.writeText(outPath, body, undefined, exec.signal, sandboxPolicyOf(ctx, exec));
        writtenPath = ctx.fs.processPath(outPath);
      }
      const text = writtenPath ? body + "\n\nWritten to " + writtenPath : body;
      return { verdict: result.verdict ?? null, format, findings, path: writtenPath, text };
    },
    presentCall: (args) => ({ card: "generic", title: "Gate report: " + String(args.target || ""), kind: "other", rawInput: args }),
  }));

  if (config.promptSection) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: "gate:instructions",
      order: config.sectionOrder,
      text: GATE_SECTION_TEXT,
    }), "gate.section()");
  }
}

export { Config, GATE_SECTION_TEXT, apply, inject, name };
