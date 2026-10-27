/**
 * dsh-plugin-gate — scan baselines and diffs (v1.3.0).
 *
 * A baseline is the fingerprint set of one scanned target, persisted under
 * the session workspace. Diffing a fresh scan against it answers the
 * question that matters after a fix: "did the risk actually go away, and did
 * anything new appear?" Pure module — no fs, no network, no DSH imports.
 */

export const BASELINE_VERSION = 1;

/**
 * Stable fingerprint for one hit. Line numbers are deliberately excluded:
 * editing a file shifts lines without changing the risk, which would make
 * every diff noisy. rule + severity + file is stable across such edits.
 */
export function hitFingerprint(hit = {}) {
  return [String(hit.rule || "?"), String(hit.severity || "?"), String(hit.file || "?")].join("|");
}

/** Fingerprint -> hit count for a scan result. */
export function fingerprintResult(result = {}) {
  const counts = new Map();
  for (const hit of (Array.isArray(result.hits) ? result.hits : [])) {
    const fp = hitFingerprint(hit);
    const n = typeof hit.count === "number" && Number.isFinite(hit.count) && hit.count > 0 ? hit.count : 1;
    counts.set(fp, (counts.get(fp) || 0) + n);
  }
  return counts;
}

/** Build the baseline document for one scanned target. */
export function buildBaseline({ target = "", result = {}, date = new Date().toISOString() } = {}) {
  return {
    version: BASELINE_VERSION,
    updatedAt: date,
    target,
    verdict: result.verdict ?? null,
    score: typeof result.score === "number" ? result.score : null,
    summary: result.summary ?? null,
    hits: [...fingerprintResult(result).entries()].map(([fp, count]) => ({ fp, count })),
  };
}

/** Diff a fresh scan against a stored baseline document. */
export function diffBaseline({ baseline = null, result = {}, target = "" } = {}) {
  const current = fingerprintResult(result);
  const hasBaseline = baseline !== null && baseline !== undefined && Array.isArray(baseline.hits);
  const prev = new Map((hasBaseline ? baseline.hits : []).map((h) => [h.fp, typeof h.count === "number" ? h.count : 1]));
  const added = [];
  const resolved = [];
  const changed = [];
  const unchanged = [];
  for (const [fp, count] of current) {
    if (!prev.has(fp)) added.push({ fp, count });
    else if (prev.get(fp) !== count) changed.push({ fp, count, was: prev.get(fp) });
    else unchanged.push({ fp, count });
  }
  for (const [fp, count] of prev) if (!current.has(fp)) resolved.push({ fp, count });
  const byKey = (a, b) => a.fp.localeCompare(b.fp);
  const fromVerdict = hasBaseline ? baseline.verdict ?? null : null;
  const toVerdict = result.verdict ?? null;
  return {
    target: target || (baseline && baseline.target) || "",
    hasBaseline,
    baselineUpdatedAt: hasBaseline ? baseline.updatedAt ?? null : null,
    added: added.sort(byKey),
    resolved: resolved.sort(byKey),
    changed: changed.sort(byKey),
    unchanged: unchanged.sort(byKey),
    counts: { added: added.length, resolved: resolved.length, changed: changed.length, unchanged: unchanged.length },
    verdictChange: hasBaseline && fromVerdict !== toVerdict ? { from: fromVerdict, to: toVerdict } : null,
    /** True when the new scan introduced no new or worsened risk. */
    clean: added.length === 0 && changed.length === 0,
  };
}

/** Markdown rendering of a diff. */
export function renderDiff({ diff = {}, target = "" } = {}) {
  const name = target || diff.target || "(target)";
  const lines = ["# Baseline diff: " + name, ""];
  if (!diff.hasBaseline) {
    lines.push("No baseline stored for this target yet — this scan becomes the baseline when you pass update=true.");
    lines.push("Current findings: " + (diff.counts.unchanged + diff.counts.added + diff.counts.changed) + ".");
    return lines.join("\n");
  }
  lines.push("Baseline from " + (diff.baselineUpdatedAt ?? "(unknown)") + " -> new scan.");
  if (diff.verdictChange) lines.push("Verdict: " + diff.verdictChange.from + " -> " + diff.verdictChange.to + ".");
  lines.push("New: " + diff.counts.added + " | resolved: " + diff.counts.resolved + " | changed: " + diff.counts.changed + " | unchanged: " + diff.counts.unchanged + ".");
  lines.push("");
  lines.push(diff.clean ? "No new or worsened findings. ✅" : "New or worsened findings detected — review before installing. 🚨");
  const section = (title, rows, fmt) => {
    if (rows.length === 0) return;
    lines.push("", "## " + title, "", "| Fingerprint (rule | severity | file) | Count |", "|---|---|");
    for (const r of rows) lines.push("| " + r.fp + " | " + (fmt ? fmt(r) : r.count) + " |");
  };
  section("Added", diff.added);
  section("Changed (count differs)", diff.changed, (r) => r.was + " -> " + r.count);
  section("Resolved", diff.resolved);
  return lines.join("\n");
}
