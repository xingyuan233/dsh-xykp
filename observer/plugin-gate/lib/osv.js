/**
 * dsh-plugin-gate — OSV supply-chain check.
 *
 * Pure module (network helpers take an injected fetch). Queries Google OSV
 * (api.osv.dev) for known vulnerabilities against EXACT dependency versions
 * only — ranges, wildcards, git/http/file specs and the unversioned main
 * package are skipped (mirroring dsh-plugin-vet's policy, avoiding stale
 * whole-history noise). Checks a capped number of direct dependencies,
 * skipping @deepseek-ai/* official packages. Network failures degrade
 * silently to a note; the gate never blocks on OSV availability.
 */

import { CATEGORY } from "./rules.js";

/** True when a spec is a bare exact version (e.g. "1.2.3", "1.2.3-alpha.1"). */
export function exactVersion(spec) {
  if (typeof spec !== "string") return null;
  const s = spec.trim();
  if (/^(git|file:|workspace:|link:|npm:|https?:)/i.test(s)) return null;
  if (/[\s*^~><|=]/.test(s)) return null;
  if (!/^\d+(\.\d+){0,2}([-+][0-9A-Za-z.-]+)?$/.test(s)) return null;
  return s;
}

/**
 * Extract exact-version direct dependencies for OSV checking.
 * @param {Record<string,string>} depMap - merged {name: spec} from the package fields.
 * @param {{max?:number, skipScope?:string}} [opts]
 * @returns {Array<{name:string, version:string}>}
 */
export function exactVersionDeps(depMap, opts = {}) {
  const { max = 8, skipScope = "@deepseek-ai" } = opts;
  const out = [];
  const seen = new Set();
  for (const [name, spec] of Object.entries(depMap || {})) {
    if (out.length >= max) break;
    if (skipScope && name.startsWith(skipScope)) continue;
    if (seen.has(name)) continue;
    const version = exactVersion(spec);
    if (!version) continue;
    seen.add(name);
    out.push({ name, version });
  }
  return out;
}

/**
 * Query OSV for one exact package version.
 * @param {Function} fetchImpl
 * @param {string} name - npm package name.
 * @param {string} version - exact version.
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, vulns?:Array<{id:string, summary?:string, aliases?:string[], modified?:string}>, error?:string}>}
 */
export async function queryOsv(fetchImpl, name, version, opts = {}) {
  const { timeoutMs = 10000 } = opts;
  try {
    const res = await fetchImpl("https://api.osv.dev/v1/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package: { name, ecosystem: "npm" }, version }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error("osv " + res.status);
    const data = await res.json();
    const vulns = (data.vulns || []).map((v) => ({
      id: v.id,
      summary: String(v.summary || "").slice(0, 200),
      aliases: v.aliases || [],
      modified: v.modified,
    }));
    return { ok: true, vulns };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/**
 * Check a dependency list against OSV and build gate hits/notes.
 * @param {Function} fetchImpl
 * @param {Array<{name:string, version:string}>} deps
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{hits:Array, notes:Array, checked:number, vulnerable:number}>}
 */
export async function checkOsvDeps(fetchImpl, deps, opts = {}) {
  const { timeoutMs = 10000 } = opts;
  const hits = [];
  const notes = [];
  let checked = 0;
  let vulnerable = 0;
  for (const dep of deps) {
    const r = await queryOsv(fetchImpl, dep.name, dep.version, { timeoutMs });
    if (!r.ok) {
      notes.push({ file: "package.json", kind: "osv", detail: dep.name + "@" + dep.version + ": " + r.error });
      continue;
    }
    checked += 1;
    for (const v of r.vulns) {
      vulnerable += 1;
      hits.push({
        rule: "osv_vulnerability",
        category: CATEGORY.SCRIPTS,
        severity: "medium",
        file: "package.json",
        line: 1,
        count: 1,
        evidence: dep.name + "@" + dep.version + " affected by " + v.id + (v.summary ? " — " + v.summary : ""),
        hint: "Known vulnerability from Google OSV for this exact dependency version; upgrade to a fixed version if one exists.",
      });
    }
  }
  if (deps.length > 0 && checked === 0) {
    notes.push({ file: "package.json", kind: "osv", detail: "OSV queries unavailable; skipped " + deps.length + " exact-version deps" });
  }
  return { hits, notes, checked, vulnerable };
}
