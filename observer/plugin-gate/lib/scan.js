/**
 * dsh-plugin-gate — scan orchestration and verdict aggregation.
 *
 * Pure module apart from node:path: no DSH/Cordis imports, unit-testable in
 * isolation. Scans either a directory through an injected fs adapter (the
 * host's sandboxed ctx.fs in production, node:fs in tests) or an npm
 * tarball through lib/targz.js. Reads only; never executes scanned content
 * and never writes.
 */

import path from "node:path";
import { CATEGORY, SEVERITY_WEIGHT, extractHosts, hasReadAndSend, scanText } from "./rules.js";
import { checkOsvDeps, exactVersionDeps } from "./osv.js";

/** File extensions treated as opaque binary blobs (skipped for text scan). */
export const BINARY_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".class", ".pyc", ".pyo",
  ".jar", ".war", ".zip", ".gz", ".tgz", ".7z", ".rar", ".woff", ".woff2",
  ".ttf", ".otf", ".eot", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
  ".pdf", ".mp3", ".mp4", ".avi", ".mov", ".wasm", ".node", ".o", ".a",
]);

/** Directories never descended into during a scan. */
export const SKIP_DIRS = new Set([".git", ".npm-cache", ".venv", "__pycache__", ".hg", ".svn"]);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]"]);

/**
 * Rules whose hits depend on execution context: a hit in prose (docs) or a
 * comment is a description, not behavior, and is downgraded to low so
 * documentation examples do not BLOCK an otherwise clean package.
 */
export const CODE_CONTEXT_RULES = new Set([
  "exec_sync", "exec_api", "spawn_call", "shell_true", "download_cmd",
  "pipe_to_shell", "ps_encoded", "ps_iex", "cmd_launch", "rm_recursive",
  "eval_call", "new_function", "function_ctor", "vm_run", "fromcharcode",
  "atob_call", "hex_escapes", "uni_escapes", "char_array", "dynamic_require",
  "env_in_cmd",
]);

/** Documentation-ish extensions: code-context hits there are prose. */
const DOC_EXTS = new Set([".md", ".markdown", ".rst", ".txt", ".html", ".htm", ".mdx"]);

/** @param {string} rel - relative path. */
function isDocFile(rel) {
  return DOC_EXTS.has(path.extname(rel).toLowerCase());
}

/** @param {string|undefined} line - trimmed line text. */
function isCommentLine(line) {
  const t = String(line || "").trimStart();
  return /^(\/\/|#|\/\*|\*|;|--|<!--)/.test(t);
}

/** Extract one line of content (1-based). */
function lineTextOf(content, lineNo) {
  const lines = content.split(/\r?\n/);
  return lines[lineNo - 1] || "";
}

/** Dependency specs that install from git, http or local file paths. */
const RISKY_DEP_RE = /^(git(\+[\w-]+)?:|https?:\/\/|file:)/;

/** @param {string} rel - relative file path. */
export function isBinaryName(rel) {
  const ext = path.extname(rel).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Parse a package.json body for install-time risk surface.
 * @param {string} text - raw package.json content.
 * @returns {{ok:boolean, name?:string, version?:string, lifecycle?:Array<{script:string, body:string}>, hasDshBundle?:boolean, dependencyCount?:number, parseError?:string}}
 */
export function parsePackageJson(text) {
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch (e) {
    return { ok: false, parseError: String(e && e.message || e) };
  }
  const lifecycle = [];
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  for (const key of Object.keys(scripts)) {
    if (/^(pre|post)?(install|uninstall|prepare|prepublish|publish|link)\b/.test(key) || key === "install" || key === "preinstall" || key === "postinstall") {
      lifecycle.push({ script: key, body: String(scripts[key]).slice(0, 500) });
    }
  }
  const depCount = (pkg.dependencies ? Object.keys(pkg.dependencies).length : 0)
    + (pkg.devDependencies ? Object.keys(pkg.devDependencies).length : 0)
    + (pkg.peerDependencies ? Object.keys(pkg.peerDependencies).length : 0);
  const depMap = {};
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = pkg[field];
    if (deps && typeof deps === "object") {
      for (const [name, spec] of Object.entries(deps)) {
        if (depMap[name] === undefined) depMap[name] = spec;
      }
    }
  }
  const riskyDependencies = [];
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = pkg[field];
    if (deps && typeof deps === "object") {
      for (const [name, spec] of Object.entries(deps)) {
        if (typeof spec === "string" && RISKY_DEP_RE.test(spec)) {
          riskyDependencies.push({ name, spec: spec.slice(0, 200), field });
        }
      }
    }
  }
  return {
    ok: true,
    name: pkg.name,
    version: pkg.version,
    lifecycle,
    riskyDependencies,
    depMap,
    hasDshBundle: Boolean(pkg.dsh && pkg.dsh.bundle),
    dependencyCount: depCount,
  };
}

/**
 * Scan one file's text content. package.json gets an extra structural pass
 * (lifecycle scripts become hits).
 * @param {{rel:string, content:string}} file
 * @returns {{hits:Array, notes:Array}}
 */
export function scanFileText(file) {
  const hits = [];
  const notes = [];
  const docFile = isDocFile(file.rel);
  const usesChildProcess = /\b(child_process|node:child_process)\b/.test(file.content);
  const textHits = scanText(file.rel, file.content).map((h) => {
    if (h.rule === "exec_api" && !usesChildProcess) {
      return {
        ...h,
        severity: "low",
        hint: h.hint + " (no child_process import in this file — likely RegExp#exec or a custom function)",
      };
    }
    if (h.rule === "exec_sync" && !usesChildProcess) {
      return { ...h, severity: "medium", hint: h.hint + " (no child_process import in this file)" };
    }
    // Execution-context rules describe behavior only in code. In docs or
    // comments they are prose examples — downgrade so documentation does not
    // BLOCK an otherwise clean package. Secrets/network rules stay as-is
    // even in comments (a leaked key or webhook is still a leak).
    if (CODE_CONTEXT_RULES.has(h.rule) && (docFile || isCommentLine(lineTextOf(file.content, h.line)))) {
      return {
        ...h,
        severity: "low",
        hint: h.hint + " (found in " + (docFile ? "documentation" : "a comment") + " — likely an example, not behavior)",
      };
    }
    return h;
  });
  for (const h of textHits) hits.push(h);
  if (/package\.json$/.test(file.rel)) {
    const pkg = parsePackageJson(file.content);
    if (pkg.ok) {
      for (const l of pkg.lifecycle || []) {
        const sev = /(curl|wget|download|powershell|cmd|exec|eval|http)/i.test(l.body) ? "high" : "medium";
        hits.push({
          rule: "lifecycle_script",
          category: CATEGORY.SCRIPTS,
          severity: sev,
          file: file.rel,
          line: 1,
          count: 1,
          evidence: l.script + ": " + l.body.slice(0, 180),
          hint: "npm runs lifecycle scripts during install; execute only what you have audited.",
        });
      }
      for (const d of pkg.riskyDependencies || []) {
        hits.push({
          rule: "risky_dependency",
          category: CATEGORY.SCRIPTS,
          severity: "medium",
          file: file.rel,
          line: 1,
          count: 1,
          evidence: d.field + "." + d.name + ": " + d.spec,
          hint: "Dependency installed from git/http/file — supply-chain risk; pin a registry version instead.",
        });
      }
    } else {
      notes.push({ file: file.rel, kind: "package-parse", detail: pkg.parseError || "invalid package.json" });
    }
  }
  if (/\.[jt]sx?$/i.test(file.rel)) {
    const lines = file.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > 4000) {
        hits.push({
          rule: "minified_line",
          category: CATEGORY.OBFUSCATION,
          severity: "low",
          file: file.rel,
          line: i + 1,
          count: 1,
          evidence: "line of " + lines[i].length + " chars (>4000)",
          hint: "Very long minified line is hard to review; prefer source maps.",
        });
        break;
      }
    }
  }
  if (hasReadAndSend(file.content)) {
    hits.push({
      rule: "data_exfil_heuristic",
      category: CATEGORY.NETWORK,
      severity: "medium",
      file: file.rel,
      line: 1,
      count: 1,
      evidence: "same file reads local data and sends network requests",
      hint: "Reads local files and performs network I/O in one module — the classic exfiltration shape. Verify data flow.",
    });
  }
  let pkg;
  if (/package\.json$/.test(file.rel)) {
    const parsed = parsePackageJson(file.content);
    if (parsed.ok) pkg = parsed;
  }
  return { hits, notes, pkg };
}

/**
 * Walk a directory via an injected fs adapter and scan every file.
 * fs adapter surface (subset of ctx.fs):
 *   resolve(path, opts?) -> target
 *   processPath(target) -> string
 *   listDir(target, signal?) -> [{name, type, target, size?}]
 *   readText(target, signal?) -> string
 * @param {object} fs - fs adapter.
 * @param {object} rootTarget - resolved root target.
 * @param {{maxFiles?:number, maxFileBytes?:number, includeNodeModules?:boolean}} [opts]
 * @param {AbortSignal} [signal]
 * @returns {{files:Array<{rel:string, target:object, size?:number}>, truncatedDir:boolean, dirError?:string}}
 */
export async function collectFiles(fs, rootTarget, opts = {}, signal) {
  const { maxFiles = 1000, includeNodeModules = false } = opts;
  const files = [];
  const queue = [{ target: rootTarget, rel: "." }];
  let truncatedDir = false;
  while (queue.length > 0) {
    const { target, rel } = queue.shift();
    let entries;
    try {
      entries = await fs.listDir(target, signal);
    } catch (e) {
      return { files, truncatedDir, dirError: String(e && e.message || e) };
    }
    for (const entry of entries) {
      const childRel = rel === "." ? entry.name : rel + "/" + entry.name;
      if (entry.type === "directory") {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name === "node_modules" && !includeNodeModules) continue;
        queue.push({ target: entry.target, rel: childRel });
      } else if (entry.type === "file") {
        if (entry.name === ".DS_Store") continue;
        if (files.length >= maxFiles) {
          truncatedDir = true;
          return { files, truncatedDir };
        }
        files.push({ rel: childRel, target: entry.target, size: entry.size });
      }
    }
  }
  return { files, truncatedDir };
}

/**
 * Read one file as text through the fs adapter with a byte cap and binary
 * fallback. Returns null when the file is oversized or unreadable.
 * @param {object} fs - fs adapter.
 * @param {object} target - file target.
 * @param {number} maxFileBytes - inclusive cap.
 * @param {AbortSignal} [signal]
 * @returns {Promise<string|null>}
 */
export async function readFileCapped(fs, target, maxFileBytes, signal) {
  try {
    const text = await fs.readText(target, signal);
    return text.length <= maxFileBytes ? text : null;
  } catch {
    // binary or backend rejection: try raw bytes with a cap, reject NUL-heavy content
    try {
      const bytes = await fs.readBytes(target, signal, maxFileBytes);
      let nul = 0;
      for (let i = 0; i < bytes.length && i < 8192; i++) {
        if (bytes[i] === 0) nul += 1;
      }
      if (nul > 16) return null; // binary
      return Buffer.from(bytes).toString("utf8").slice(0, maxFileBytes);
    } catch {
      return null;
    }
  }
}

/**
 * Scan a directory end-to-end.
 * @param {object} fs - fs adapter (ctx.fs subset).
 * @param {string|object} root - path string (resolved with fs.resolve) or an already-resolved target.
 * @param {{maxFiles?:number, maxFileBytes?:number, includeNodeModules?:boolean, allowlistHosts?:string[]}} [opts]
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} full gate result.
 */
export async function scanDirectory(fs, root, opts = {}, signal) {
  const { maxFiles = 1000, maxFileBytes = 2 * 1024 * 1024, includeNodeModules = false, allowlistHosts = [] } = opts;
  const rootTarget = typeof root === "string" ? await fs.resolve(root, { signal }) : root;
  const rootPath = fs.processPath(rootTarget);

  const { files, truncatedDir, dirError } = await collectFiles(fs, rootTarget, { maxFiles, includeNodeModules }, signal);

  const hits = [];
  const notes = [];
  const hosts = new Set();
  const readAndSendFiles = [];
  let filesScanned = 0;
  let pkgInfo = null;

  for (const f of files) {
    if (isBinaryName(f.rel)) {
      hits.push({
        rule: "binary_blob",
        category: CATEGORY.BINARY,
        severity: "medium",
        file: f.rel,
        line: 1,
        count: 1,
        evidence: "binary file in package (" + path.extname(f.rel) + ")",
        hint: "Binary artifacts can hide compiled payloads; rebuild from source instead of shipping them.",
      });
      continue;
    }
    if (f.size !== undefined && f.size > maxFileBytes) {
      notes.push({ file: f.rel, kind: "oversized", detail: f.size + " bytes > " + maxFileBytes });
      continue;
    }
    const content = await readFileCapped(fs, f.target, maxFileBytes, signal);
    if (content === null) {
      notes.push({ file: f.rel, kind: "unreadable", detail: "binary or oversized or unreadable" });
      continue;
    }
    filesScanned += 1;
    const res = scanFileText({ rel: f.rel, content });
    hits.push(...res.hits);
    notes.push(...res.notes);
    if (res.pkg) pkgInfo = res.pkg;
    for (const h of extractHosts(content)) hosts.add(h);
    if (hasReadAndSend(content)) readAndSendFiles.push(f.rel);
  }

  if (truncatedDir) notes.push({ file: ".", kind: "truncated", detail: "file count exceeded maxFiles=" + maxFiles });
  if (dirError) notes.push({ file: ".", kind: "dir-error", detail: dirError });

  if (opts.osvCheck && pkgInfo) {
    const deps = exactVersionDeps(pkgInfo.depMap || {}, { max: opts.osvMaxDeps || 8 });
    const osv = await checkOsvDeps(opts.fetchImpl || fetch, deps, { timeoutMs: opts.osvTimeoutMs || 10000 });
    hits.push(...osv.hits);
    notes.push(...osv.notes);
  }

  return buildResult({
    mode: "dir",
    target: rootPath,
    hits,
    notes,
    hosts: [...hosts],
    readAndSendFiles,
    filesScanned,
    filesTotal: files.length,
    truncatedDir,
    allowlistHosts,
  });
}

/**
 * Scan an extracted tarball's file list (from lib/targz.js).
 * @param {Array<{path:string, data:Buffer}>} files
 * @param {{maxFileBytes?:number, allowlistHosts?:string[]}} [opts]
 * @returns {object} full gate result.
 */
export function scanTarballFiles(files, opts = {}) {
  const { maxFileBytes = 2 * 1024 * 1024, allowlistHosts = [] } = opts;
  const hits = [];
  const notes = [];
  const hosts = new Set();
  const readAndSendFiles = [];
  let filesScanned = 0;
  for (const f of files) {
    if (isBinaryName(f.path)) {
      hits.push({
        rule: "binary_blob",
        category: CATEGORY.BINARY,
        severity: "medium",
        file: f.path,
        line: 1,
        count: 1,
        evidence: "binary file in package (" + path.extname(f.path) + ")",
        hint: "Binary artifacts can hide compiled payloads; rebuild from source instead of shipping them.",
      });
      continue;
    }
    if (f.data.length > maxFileBytes) {
      notes.push({ file: f.path, kind: "oversized", detail: f.data.length + " bytes > " + maxFileBytes });
      continue;
    }
    const content = f.data.toString("utf8");
    if (content.includes("\u0000")) {
      notes.push({ file: f.path, kind: "binary", detail: "NUL bytes in text path" });
      continue;
    }
    filesScanned += 1;
    const res = scanFileText({ rel: f.path, content });
    hits.push(...res.hits);
    notes.push(...res.notes);
    for (const h of extractHosts(content)) hosts.add(h);
    if (hasReadAndSend(content)) readAndSendFiles.push(f.path);
  }
  return buildResult({
    mode: "npm",
    target: "tarball",
    hits,
    notes,
    hosts: [...hosts],
    readAndSendFiles,
    filesScanned,
    filesTotal: files.length,
    truncatedDir: false,
    allowlistHosts,
  });
}

/**
 * Resolve an npm spec ("name" or "name@version") against the registry and
 * scan the published tarball.
 * @param {string} spec - npm package spec.
 * @param {{fetchImpl?:Function, maxTarballBytes?:number, maxFileBytes?:number, allowlistHosts?:string[], timeoutMs?:number}} [opts]
 * @returns {Promise<{result:object, package:object|null}>}
 */
export async function scanNpmPackage(spec, opts = {}) {
  const { fetchImpl = fetch, maxTarballBytes = 32 * 1024 * 1024, maxFileBytes = 2 * 1024 * 1024, allowlistHosts = [], timeoutMs = 20000 } = opts;
  const at = spec.indexOf("@", 1);
  const name = at === -1 ? spec : spec.slice(0, at);
  const requested = at === -1 ? null : spec.slice(at + 1);
  const signal = AbortSignal.timeout(timeoutMs);

  const metaUrl = "https://registry.npmjs.org/" + encodeURIComponent(name);
  let meta;
  try {
    const res = await fetchImpl(metaUrl, { signal });
    if (!res.ok) throw new Error("registry " + res.status + " for " + name);
    meta = await res.json();
  } catch (e) {
    throw new Error("npm: cannot fetch " + name + ": " + (e && e.message || e));
  }
  if (meta.error) throw new Error("npm: " + name + ": " + meta.error);

  const distTags = meta["dist-tags"] || {};
  let versionMeta = null;
  if (requested) {
    versionMeta = meta.versions && meta.versions[requested] || null;
    if (!versionMeta) throw new Error("npm: version " + requested + " not found for " + name);
  } else {
    const latest = distTags.latest;
    versionMeta = (latest && meta.versions && meta.versions[latest]) || null;
    if (!versionMeta) {
      const keys = Object.keys(meta.versions || {});
      versionMeta = keys.length > 0 ? meta.versions[keys[keys.length - 1]] : null;
    }
    if (!versionMeta) throw new Error("npm: no versions for " + name);
  }

  const tarballUrl = versionMeta.dist && versionMeta.dist.tarball;
  if (!tarballUrl) throw new Error("npm: no tarball for " + name + "@" + versionMeta.version);

  let buf;
  try {
    const res = await fetchImpl(tarballUrl, { signal });
    if (!res.ok) throw new Error("tarball " + res.status);
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxTarballBytes) throw new Error("tarball too large (" + ab.byteLength + " bytes)");
    buf = Buffer.from(ab);
  } catch (e) {
    throw new Error("npm: cannot download tarball: " + (e && e.message || e));
  }

  const { extractTarball } = await import("./targz.js");
  const { files, truncated } = extractTarball(buf, { maxBytes: maxTarballBytes * 2, maxFiles: 2000 });

  const result = scanTarballFiles(files, { maxFileBytes, allowlistHosts });
  result.target = name + "@" + versionMeta.version;
  if (truncated.files || truncated.traversal || truncated.pax) {
    result.notes.push({ file: "tarball", kind: "truncated", detail: JSON.stringify(truncated) });
  }

  // lifecycle scripts from the registry metadata itself (belt and braces)
  const scripts = versionMeta.scripts || {};
  const lifecycle = Object.keys(scripts)
    .filter((k) => /^(pre|post)?(install|uninstall|prepare|prepublish|publish|link)\b/.test(k))
    .map((k) => ({ script: k, body: String(scripts[k]).slice(0, 500) }));
  const packageInfo = {
    name: versionMeta.name || name,
    version: versionMeta.version,
    lifecycle,
    dependencyCount: Object.keys(versionMeta.dependencies || {}).length + Object.keys(versionMeta.devDependencies || {}).length,
    hasDshBundle: Boolean(versionMeta.dsh && versionMeta.dsh.bundle),
  };
  for (const l of lifecycle) {
    const sev = /(curl|wget|download|powershell|cmd|exec|eval|http)/i.test(l.body) ? "high" : "medium";
    result.hits.push({
      rule: "lifecycle_script",
      category: CATEGORY.SCRIPTS,
      severity: sev,
      file: "package.json",
      line: 1,
      count: 1,
      evidence: l.script + ": " + l.body.slice(0, 180),
      hint: "npm runs lifecycle scripts during install; execute only what you have audited.",
    });
  }
  result.package = packageInfo;

  if (opts.osvCheck !== false) {
    const depMap = {};
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = versionMeta[field];
      if (deps && typeof deps === "object") {
        for (const [n, s] of Object.entries(deps)) if (depMap[n] === undefined) depMap[n] = s;
      }
    }
    const deps = exactVersionDeps(depMap, { max: opts.osvMaxDeps || 8 });
    const osv = await checkOsvDeps(opts.fetchImpl || fetch, deps, { timeoutMs: opts.osvTimeoutMs || 10000 });
    result.hits.push(...osv.hits);
    result.notes.push(...osv.notes);
  }

  return buildResult({ ...result, hosts: result.network ? result.network.hosts : [] }, { allowlistHosts });
}

/** Finalize counts, verdict, network summary and recommendations. */
function buildResult(base, overrides = {}) {
  const allowlistHosts = (overrides.allowlistHosts || base.allowlistHosts || []).map((h) => String(h).toLowerCase());
  const hits = dedupeHits(base.hits || []);
  const summary = { high: 0, medium: 0, low: 0, categories: {} };
  for (const h of hits) {
    summary[h.severity] += 1;
    summary.categories[h.category] = (summary.categories[h.category] || 0) + 1;
  }
  const score = (summary.high || 0) * SEVERITY_WEIGHT.high + (summary.medium || 0) * SEVERITY_WEIGHT.medium + (summary.low || 0) * SEVERITY_WEIGHT.low;
  const verdict = summary.high > 0 ? "BLOCK" : summary.medium > 0 ? "WARN" : "PASS";

  const hosts = [...new Set((base.hosts || []).map((h) => h.toLowerCase()))];
  const unallowlisted = hosts.filter((h) => !LOCAL_HOSTS.has(h) && !allowlistHosts.includes(h));

  const recommendations = [];
  if (verdict === "BLOCK") recommendations.push("BLOCK: high-severity patterns found. Do NOT install this package until every high hit is explained and resolved.");
  if (summary.medium > 0) recommendations.push("WARN: medium-severity patterns found. Review every hit in context before deciding to install.");
  if (summary.categories[CATEGORY.SCRIPTS] > 0) recommendations.push("Inspect npm lifecycle scripts (pre/install/postinstall) — they execute during install without your explicit action.");
  if (summary.categories[CATEGORY.NETWORK] > 0) recommendations.push("Network I/O detected: verify every destination, and confirm no data leaves the workspace without purpose.");
  if (summary.categories[CATEGORY.PERMISSIONS] > 0) recommendations.push("File/permission access detected: confirm reads/writes stay inside the session workspace and no credentials are touched.");
  if (summary.categories[CATEGORY.SECRETS] > 0) recommendations.push("Hardcoded credential material found — treat the package as compromised if any hit is a live secret.");
  if (summary.categories[CATEGORY.OBFUSCATION] > 0) recommendations.push("Obfuscated code paths found — decode and review before trusting runtime behavior.");
  if (summary.categories[CATEGORY.BINARY] > 0) recommendations.push("Binary artifacts shipped in the package — prefer building from source.");
  if (recommendations.length === 0) recommendations.push("No risky patterns detected by signature scan. This is a heuristic result, not a guarantee — review critical plugins manually too.");
  if (verdict === "BLOCK") recommendations.push("Gate policy: refuse installation on BLOCK verdicts unless the maintainer provides a clean rebuild you can scan again.");

  return {
    verdict,
    score,
    mode: base.mode,
    target: base.target,
    filesScanned: base.filesScanned,
    filesTotal: base.filesTotal,
    summary,
    network: {
      hosts,
      unallowlisted,
      readAndSendFiles: base.readAndSendFiles || [],
    },
    package: base.package || null,
    notes: base.notes || [],
    hits,
    recommendations,
  };
}

/** Deduplicate identical (rule, file, line, evidence) hits. */
function dedupeHits(hits) {
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const key = h.rule + "|" + h.file + "|" + h.line + "|" + h.evidence;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}
