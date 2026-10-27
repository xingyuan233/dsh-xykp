/**
 * dsh-plugin-gate — data-protection module (v1.1).
 * Pure, unit-testable guards against accidental destructive operations:
 *  - evaluateCommand: shell-command signatures (device/root deletes, format,
 *    dd/mkfs, recursive deletes) -> BLOCK / WARN / PASS
 *  - evaluatePath: file-op targets vs the workspace boundary and critical
 *    files (memory.json, .git, ...) -> BLOCK / WARN / PASS
 * The gate never executes anything; this is static, conservative heuristics.
 */

/** High-severity: destroys data at device/root level. */
const BLOCK_PATTERNS = [
  { re: /\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)?\s+[\/](\s|$)/i, why: "rm targeting filesystem root (/)" },
  { re: /\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)?\s+[a-zA-Z]:\\\s*/i, why: "rm targeting a drive root (C:\)" },
  { re: /\brmdir\s+\/s(\s+\/q)?\b/i, why: "rmdir /s /q — recursive directory delete" },
  { re: /\bdel\s+\/(f\s+)?(s\s+)?(q\s+)?[a-zA-Z]:\\/i, why: "del on a drive root" },
  { re: /\bformat\s+[a-zA-Z]:/i, why: "format a drive" },
  { re: /\bdd\b[^|&]*\bof=\/dev\/(sd|nvme|hd)/i, why: "dd writing to a raw block device" },
  { re: /\bmkfs\./i, why: "mkfs — create a filesystem (destructive)" },
];

/** Medium: recursive/force deletes that need confirmation of the exact target. */
const WARN_PATTERNS = [
  { re: /\brm\s+-[a-z]*r/i, why: "recursive rm — confirm the exact target" },
  { re: /\bRemove-Item\b/i, why: "PowerShell Remove-Item — confirm scope" },
  { re: /\brmdir\b/i, why: "rmdir — confirm scope" },
  { re: /\bdel\s+\/[fqs]/i, why: "del with /f or /s flags" },
  { re: /\brd\s+\/s\b/i, why: "rd /s — recursive directory delete" },
];

/** Files whose accidental deletion/overwrite is costly. */
const CRITICAL_RE = /(^|[\/\\])(memory\.json|memory\.json\.bak|knowledge\.json|snapshots\.json|package\.json|\.git)([\/\\]|$)/i;

/** Evaluate a shell command string. Pure. */
export function evaluateCommand(cmd, { workspace } = {}) {
  const text = String(cmd ?? "");
  if (!text.trim()) return { verdict: "PASS", reasons: ["empty command"] };
  for (const p of BLOCK_PATTERNS) {
    if (p.re.test(text)) return { verdict: "BLOCK", reasons: [p.why] };
  }
  const warns = [];
  for (const p of WARN_PATTERNS) {
    if (p.re.test(text)) warns.push(p.why);
  }
  if (warns.length) return { verdict: "WARN", reasons: warns };
  return { verdict: "PASS", reasons: ["no destructive signature detected"] };
}

function normalize(p) {
  let s = String(p ?? "").replace(/\\/g, "/");
  if (s.length > 1) s = s.replace(/[\/]+$/, "");
  return s;
}

/** Evaluate a file-op target against the workspace boundary. Pure. */
export function evaluatePath(path, workspace, { action = "delete" } = {}) {
  const target = normalize(path);
  const ws = normalize(workspace);
  const reasons = [];
  if (!target) return { verdict: "WARN", reasons: ["empty target"] };
  if (!ws) return { verdict: "WARN", reasons: ["no workspace boundary available — confirm the target manually"] };

  const isRoot = target === "/" || /^[a-zA-Z]:[\/]?$/.test(target);
  if (isRoot) return { verdict: "BLOCK", reasons: ["target is a filesystem/drive root"] };
  if (CRITICAL_RE.test(target)) reasons.push("target is a critical file (" + action + " on " + target + ")");
  if (target === ws) return { verdict: "BLOCK", reasons: ["target is the workspace root itself"] };
  if (target.startsWith(ws + "/")) {
    reasons.push("target is inside the workspace — confirm the exact path");
    return { verdict: CRITICAL_RE.test(target) ? "WARN" : "WARN", reasons };
  }
  reasons.push("target is OUTSIDE the workspace — explicit user intent required");
  return { verdict: "WARN", reasons };
}
