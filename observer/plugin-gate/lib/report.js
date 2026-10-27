/**
 * dsh-plugin-gate — structured scan reports (v1.3.0).
 *
 * Renders one scan result as Markdown or JSON for humans, tickets and CI.
 * Pure module: no fs, no network, no DSH imports.
 */

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

/** Group hits by severity then category, most severe first. */
export function groupHits(hits = []) {
  const list = (Array.isArray(hits) ? hits : []).filter((h) => h && h.rule);
  const sorted = [...list].sort((a, b) => {
    const s = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
    if (s !== 0) return s;
    const c = String(a.category || "").localeCompare(String(b.category || ""));
    if (c !== 0) return c;
    return String(a.file || "").localeCompare(String(b.file || ""));
  });
  const groups = [];
  for (const hit of sorted) {
    const key = (hit.severity || "?") + "/" + (hit.category || "?");
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, severity: hit.severity || "?", category: hit.category || "?", hits: [] }; groups.push(g); }
    g.hits.push(hit);
  }
  return groups;
}

/** Markdown report for one scan. */
export function renderMarkdownReport({ target = "", result = {}, date = new Date().toISOString(), diff = null, evidenceLines = 3 } = {}) {
  const summary = result.summary || {};
  const lines = [
    "# Gate scan report: " + (target || "(target)"),
    "",
    "- Generated: " + date,
    "- Verdict: **" + (result.verdict ?? "?") + "**" + (typeof result.score === "number" ? " (risk score " + result.score + ")" : ""),
    "- Findings: high " + (summary.high ?? 0) + " / medium " + (summary.medium ?? 0) + " / low " + (summary.low ?? 0),
    "- Files scanned: " + (result.filesScanned ?? result.scannedFiles ?? "n/a"),
  ];
  if (Array.isArray(result.hosts) && result.hosts.length > 0) lines.push("- Hosts referenced: " + result.hosts.join(", "));
  if (diff && diff.hasBaseline) {
    lines.push("- Baseline diff: " + (diff.clean ? "no new findings" : "new " + diff.counts.added + " / changed " + diff.counts.changed) + " vs " + (diff.baselineUpdatedAt ?? "baseline"));
  }
  const groups = groupHits(result.hits);
  if (groups.length === 0) {
    lines.push("", "No findings.");
  } else {
    for (const g of groups) {
      lines.push("", "## " + g.severity.toUpperCase() + " · " + g.category + " (" + g.hits.length + ")", "", "| Rule | File | Line | Count | Evidence |", "|---|---|---|---|---|");
      for (const h of g.hits) {
        const ev = String(h.evidence || "").replace(/\n/g, " ").slice(0, 120).replace(/\|/g, "\\|");
        lines.push("| " + h.rule + " | " + (h.file ?? "-") + " | " + (h.line ?? "-") + " | " + (h.count ?? 1) + " | " + ev + " |");
      }
    }
  }
  if (Array.isArray(result.recommendations) && result.recommendations.length > 0) {
    lines.push("", "## Recommendations", "");
    for (const r of result.recommendations) lines.push("- " + r);
  }
  lines.push("", "---", "", "Heuristic static scan by dsh-plugin-gate: read-only, never executes scanned code, not a formal guarantee.");
  return lines.join("\n");
}

/** JSON report (stable, CI-friendly). */
export function renderJsonReport({ target = "", result = {}, date = new Date().toISOString(), diff = null } = {}) {
  return JSON.stringify({
    generator: "dsh-plugin-gate",
    target,
    generatedAt: date,
    verdict: result.verdict ?? null,
    score: typeof result.score === "number" ? result.score : null,
    summary: result.summary ?? null,
    hosts: Array.isArray(result.hosts) ? result.hosts : [],
    findings: groupHits(result.hits).map((g) => ({
      severity: g.severity,
      category: g.category,
      count: g.hits.length,
      hits: g.hits.map((h) => ({ rule: h.rule, file: h.file ?? null, line: h.line ?? null, count: h.count ?? 1, evidence: h.evidence ?? null })),
    })),
    recommendations: Array.isArray(result.recommendations) ? result.recommendations : [],
    baselineDiff: diff ? { hasBaseline: diff.hasBaseline, clean: diff.clean, counts: diff.counts, verdictChange: diff.verdictChange } : null,
  }, null, 2);
}
