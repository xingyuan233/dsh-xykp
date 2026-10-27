/**
 * dsh-plugin-gate — signature rules for the installation safety gate.
 *
 * Pure module: no DSH, Cordis or Node imports, fully unit-testable in
 * isolation. Rules are regex signatures over file text. Each rule reports a
 * line-level hit; count-threshold rules only fire when a line accumulates at
 * least minCount matches (obfuscation heuristics).
 *
 * Severity model:
 *   high   — patterns that are almost always malicious in a plugin package
 *            (exec on install, encoded PowerShell, eval/Function, webhooks,
 *            cloud-metadata probes, private keys, credential reads).
 *   medium — risky-but-common patterns that need context (fetch calls, socket
 *            APIs, writes to home/system-ish paths, chmod 777, base64 blobs).
 *   low    — informational (any http URL, any env access, IPv4 literals).
 *
 * The final verdict is computed by lib/scan.js aggregate(): any high => BLOCK,
 * any medium => WARN, otherwise PASS. Rules only read text; the gate never
 * executes scanned content.
 */

export const CATEGORY = {
  SCRIPTS: "scripts",
  OBFUSCATION: "obfuscation",
  PERMISSIONS: "permissions",
  NETWORK: "network",
  SECRETS: "secrets",
  BINARY: "binary",
};

export const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 };

/** @type {Rule[]} */
export const RULES = [
  {
    id: "exec_sync",
    category: CATEGORY.SCRIPTS,
    severity: "high",
    name: "Synchronous process execution",
    re: /\b(execSync|execFileSync|spawnSync|fork)\s*\(/g,
    hint: "Synchronous child-process execution runs inside the host at plugin runtime.",
  },
  {
    id: "exec_api",
    category: CATEGORY.SCRIPTS,
    severity: "high",
    name: "Process execution",
    re: /\b(exec|execFile)\s*\(/g,
    hint: "child_process.exec/execFile spawns OS commands; inspect the command string.",
  },
  {
    id: "spawn_call",
    category: CATEGORY.SCRIPTS,
    severity: "medium",
    name: "Process spawn",
    re: /\bspawn\s*\(/g,
    hint: "child_process.spawn is common in legit tools; verify arguments are not shell-interpolated.",
  },
  {
    id: "shell_true",
    category: CATEGORY.SCRIPTS,
    severity: "high",
    name: "Shell mode enabled",
    re: /\bshell\s*:\s*true\b/g,
    hint: "spawn/exec with shell:true runs strings through a shell; command injection risk.",
  },
  {
    id: "download_cmd",
    category: CATEGORY.SCRIPTS,
    severity: "high",
    name: "Download-and-run primitive",
    re: /\b(curl|wget|iwr|Invoke-WebRequest|DownloadString|bitsadmin|certutil|scrobj|mshta|regsvr32|rundll32)\b/g,
    hint: "Common download/execute utilities; combined with install scripts this is a classic payload drop.",
  },
  {
    id: "pipe_to_shell",
    category: CATEGORY.SCRIPTS,
    severity: "high",
    name: "Pipe to shell",
    re: /\|\s*(ba|z)?sh\b|\|\s*powershell\b|\|\s*(cmd|pwsh)\b/g,
    hint: "curl|sh style remote-code execution is a textbook malware pattern.",
  },
  {
    id: "ps_encoded",
    category: CATEGORY.SCRIPTS,
    severity: "high",
    name: "Encoded PowerShell",
    re: /powershell[^\r\n]{0,120}-enc(odedcommand)?\b/ig,
    hint: "Encoded PowerShell commands hide the real payload from inspection.",
  },
  {
    id: "ps_iex",
    category: CATEGORY.SCRIPTS,
    severity: "high",
    name: "PowerShell invoke-expression",
    re: /\b(Invoke-Expression|\bIEX\b|iex\s*\()/ig,
    hint: "IEX evaluates remote or constructed strings.",
  },
  {
    id: "cmd_launch",
    category: CATEGORY.SCRIPTS,
    severity: "medium",
    name: "Windows script host / cmd launch",
    re: /\b(cmd(\.exe)?\s*\/c|start\s+\/B|wscript|cscript)\b/ig,
    hint: "Launching cmd/WSH from a plugin is unusual.",
  },
  {
    id: "dynamic_require",
    category: CATEGORY.SCRIPTS,
    severity: "medium",
    name: "Dynamic require/import",
    re: /\brequire\s*\(\s*[\x60"'][^\x60"']*["'\x60]\s*\+|\bimport\s*\(\s*[^\x60"'\s)]/g,
    hint: "Non-literal module loading can smuggle in payloads from computed paths.",
  },
  {
    id: "env_in_cmd",
    category: CATEGORY.SCRIPTS,
    severity: "medium",
    name: "Environment in command string",
    re: /\b(execSync|exec|spawn|spawnSync)\s*\([^)\n]{0,200}process\.env/g,
    hint: "Environment variables flowing into command strings can be exfiltrated or abused.",
  },
  {
    id: "rm_recursive",
    category: CATEGORY.SCRIPTS,
    severity: "high",
    name: "Recursive delete",
    re: /\brm\s+-rf\b|\brmSync\s*\(/g,
    hint: "Destructive deletion; verify the target path before trusting it.",
  },

  {
    id: "eval_call",
    category: CATEGORY.OBFUSCATION,
    severity: "high",
    name: "eval()",
    re: /\beval\s*\(/g,
    hint: "eval of constructed strings is the classic obfuscation/payload entry.",
  },
  {
    id: "new_function",
    category: CATEGORY.OBFUSCATION,
    severity: "high",
    name: "new Function()",
    re: /\bnew\s+Function\s*\(/g,
    hint: "Function constructor compiles strings at runtime.",
  },
  {
    id: "function_ctor",
    category: CATEGORY.OBFUSCATION,
    severity: "high",
    name: "Function constructor",
    re: /\bFunction\s*\(\s*["'\x60]/g,
    hint: "Function('...') is string-compiled code.",
  },
  {
    id: "vm_run",
    category: CATEGORY.OBFUSCATION,
    severity: "high",
    name: "vm sandbox execution",
    re: /\bvm\.runIn(NewContext|ThisContext|Context)\s*\(/g,
    hint: "vm.runIn* executes strings; often used to hide payloads from static analysis.",
  },
  {
    id: "fromcharcode",
    category: CATEGORY.OBFUSCATION,
    severity: "medium",
    name: "String.fromCharCode",
    re: /\bString\.fromCharCode\s*\(/g,
    hint: "Common in packed payloads that decode strings at runtime.",
  },
  {
    id: "atob_call",
    category: CATEGORY.OBFUSCATION,
    severity: "medium",
    name: "base64 decode",
    re: /\batob\s*\(/g,
    hint: "Decoding base64 at runtime; check what is being decoded.",
  },
  {
    id: "hex_escapes",
    category: CATEGORY.OBFUSCATION,
    severity: "high",
    name: "Hex-escape flood",
    re: /\\x[0-9a-fA-F]{2}/g,
    minCount: 6,
    hint: "Lines packed with \\xNN escapes are typically encoded payloads.",
  },
  {
    id: "uni_escapes",
    category: CATEGORY.OBFUSCATION,
    severity: "medium",
    name: "Unicode-escape flood",
    re: /\\u[0-9a-fA-F]{4}/g,
    minCount: 10,
    hint: "Heavy \\uXXXX encoding hides string content from review.",
  },
  {
    id: "base64_blob",
    category: CATEGORY.OBFUSCATION,
    severity: "medium",
    name: "Large base64 blob",
    re: /[A-Za-z0-9+/]{240,}={0,2}/g,
    hint: "A 240+ char base64 literal may embed a payload; decode and review.",
  },
  {
    id: "char_array",
    category: CATEGORY.OBFUSCATION,
    severity: "medium",
    name: "Character-array packing",
    re: /\b(var|let|const)\s+\w+\s*=\s*\[[^;\n]{80,}\]\s*\.(join|map|reverse|fromCharCode)\s*\(/g,
    hint: "Array-of-chars packing is a common obfuscation primitive.",
  },

  {
    id: "env_secret_key",
    category: CATEGORY.PERMISSIONS,
    severity: "high",
    name: "Credential environment read",
    re: /\bprocess\.env\.(OPENAI|ANTHROPIC|DEEPSEEK|GEMINI|GOOGLE|OPENROUTER|GITHUB|GITLAB|NPM|AWS|AZURE|STRIPE|SLACK|TELEGRAM|DISCORD|HUGGING|REPLICATE|TOGETHER|FAL|MISTRAL|COHERE|GROQ)[_A-Z0-9]*\b/gi,
    hint: "Reading known API-credential environment variables; ensure they are not sent anywhere.",
  },
  {
    id: "env_any",
    category: CATEGORY.PERMISSIONS,
    severity: "low",
    name: "Environment access",
    re: /\bprocess\.env\b/g,
    hint: "Any environment access; inspect which keys are read.",
  },
  {
    id: "read_secrets_paths",
    category: CATEGORY.PERMISSIONS,
    severity: "medium",
    name: "Credential-file path",
    re: /(\.ssh|id_rsa|id_ed25519|\.aws[\\/]|credentials\.json|\.npmrc|_authToken|netrc)/g,
    hint: "Reading ssh keys, aws credentials, npm tokens or netrc is a credential-theft pattern.",
  },
  {
    id: "homedir",
    category: CATEGORY.PERMISSIONS,
    severity: "medium",
    name: "Home/profile path access",
    re: /\b(os\.homedir|USERPROFILE|APPDATA|LOCALAPPDATA|HOME)\b/g,
    hint: "Accessing user-profile locations; plugins usually only need the session workspace.",
  },
  {
    id: "write_system",
    category: CATEGORY.PERMISSIONS,
    severity: "high",
    name: "Write to system paths",
    re: /(writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|mkdir(?:Sync)?|unlink(?:Sync)?|rm(?:Sync)?|rename(?:Sync)?|copyFile(?:Sync)?)\s*\([^)\n]{0,160}(etc[\\/]|usr[\\/]|Windows[\\/]|System32|Program\s*Files|boot[\\/]|dev[\\/]|proc[\\/])/gi,
    hint: "Writes outside the package/workspace into system directories are very suspicious.",
  },
  {
    id: "write_home",
    category: CATEGORY.PERMISSIONS,
    severity: "medium",
    name: "Write to home paths",
    re: /(writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|mkdir(?:Sync)?)\s*\([^)\n]{0,160}(~[\\/]|\$HOME|os\.homedir|os\.userInfo|%APPDATA%|%USERPROFILE%|%LOCALAPPDATA%)/gi,
    hint: "Persisting to home/profile dirs at install time is a persistence pattern.",
  },
  {
    id: "dotfile_write",
    category: CATEGORY.PERMISSIONS,
    severity: "medium",
    name: "Shell/config dotfile write",
    re: /(writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream)[^\n]{0,120}(\.bashrc|\.zshrc|\.profile|\.npmrc|autoexec)/gi,
    hint: "Rewriting shell rc or npmrc grants persistence or token theft.",
  },
  {
    id: "chmod_suid",
    category: CATEGORY.PERMISSIONS,
    severity: "medium",
    name: "Permissive chmod",
    re: /chmod[^\n]*(777|4755|666|a\+[rwx])/g,
    hint: "World-writable or setuid permissions are dangerous.",
  },
  {
    id: "sandbox_escalation",
    category: CATEGORY.PERMISSIONS,
    severity: "medium",
    name: "Sandbox escalation request",
    re: /\b(danger-full-access|sandbox_permissions|workspace-write)\b/g,
    hint: "Code that requests wider sandbox permissions; review the justification strings.",
  },
  {
    id: "path_traversal",
    category: CATEGORY.PERMISSIONS,
    severity: "medium",
    name: "Path traversal",
    re: /["'\x60][^"'\x60]*(\.\.\/|\.\.\\){2,}/g,
    hint: "Multiple ../ segments escape the package root.",
  },

  {
    id: "http_url",
    category: CATEGORY.NETWORK,
    severity: "low",
    name: "HTTP(S) URL",
    re: /\bhttps?:\/\//g,
    hint: "External URL literal; hosts are collected and checked against the allowlist.",
  },
  {
    id: "ws_url",
    category: CATEGORY.NETWORK,
    severity: "medium",
    name: "WebSocket URL",
    re: /\bwss?:\/\//g,
    hint: "WebSocket endpoints can stream data out in real time.",
  },
  {
    id: "fetch_call",
    category: CATEGORY.NETWORK,
    severity: "medium",
    name: "fetch() call",
    re: /\bfetch\s*\(/g,
    hint: "Outbound HTTP from a plugin; check destinations, especially combined with file reads.",
  },
  {
    id: "http_client",
    category: CATEGORY.NETWORK,
    severity: "medium",
    name: "HTTP client library",
    re: /\b(axios|node-fetch|got|superagent|undici|request)\s*[.(]/g,
    hint: "HTTP client usage; verify every destination.",
  },
  {
    id: "socket_api",
    category: CATEGORY.NETWORK,
    severity: "medium",
    name: "Raw socket / websocket API",
    re: /\b(net\.(connect|createConnection|createServer)|dgram|tls\.connect|http2\.|WebSocket|io\s*\(|socket\.io)\b/g,
    hint: "Raw TCP/UDP/TLS or websocket listeners can be C2 (command-and-control) channels.",
  },
  {
    id: "dns_call",
    category: CATEGORY.NETWORK,
    severity: "medium",
    name: "DNS lookup",
    re: /\b(dns\.(lookup|resolve|promises)|nslookup\s)/g,
    hint: "Programmatic DNS queries are used for covert channel/exfil staging.",
  },
  {
    id: "cloud_metadata",
    category: CATEGORY.NETWORK,
    severity: "high",
    name: "Cloud metadata endpoint",
    re: /\b(169\.254\.169\.254|metadata\.google\.internal|metadata\.compute\.internal|100\.100\.100\.200)\b/g,
    hint: "Cloud metadata endpoints can leak IAM credentials; never legitimate in a plugin.",
  },
  {
    id: "webhook",
    category: CATEGORY.NETWORK,
    severity: "high",
    name: "Messaging webhook",
    re: /\b(discord(app)?\.com\/api\/webhooks|api\.telegram\.org\/bot|hooks\.slack\.com\/services)/g,
    hint: "Hardcoded Discord/Telegram/Slack webhooks are classic data-exfiltration sinks.",
  },
  {
    id: "onion",
    category: CATEGORY.NETWORK,
    severity: "high",
    name: "Tor hidden service",
    re: /\.onion\b/g,
    hint: ".onion destinations are anonymized exfiltration endpoints.",
  },
  {
    id: "suspicious_tld",
    category: CATEGORY.NETWORK,
    severity: "low",
    name: "Suspicious TLD",
    re: /\.(top|xyz|tk|ml|ga|cf|gq|pw|work|click|stream|icu|vip)\b/ig,
    hint: "Cheap-registration TLDs are over-represented in malware C2.",
  },
  {
    id: "ipv4",
    category: CATEGORY.NETWORK,
    severity: "low",
    name: "IPv4 literal",
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    hint: "Hardcoded IPs bypass DNS and can point straight at a C2 server.",
  },

  {
    id: "sk_key",
    category: CATEGORY.SECRETS,
    severity: "high",
    name: "sk- API key",
    re: /\bsk-[A-Za-z0-9]{16,}/g,
    hint: "Hardcoded OpenAI-style secret key in the package.",
  },
  {
    id: "gh_token",
    category: CATEGORY.SECRETS,
    severity: "high",
    name: "GitHub token",
    re: /\bghp_[A-Za-z0-9]{20,}/g,
    hint: "Hardcoded GitHub personal access token.",
  },
  {
    id: "aws_key",
    category: CATEGORY.SECRETS,
    severity: "high",
    name: "AWS access key",
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    hint: "Hardcoded AWS access key id.",
  },
  {
    id: "priv_key",
    category: CATEGORY.SECRETS,
    severity: "high",
    name: "Private key block",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    hint: "Embedded private key material.",
  },
  {
    id: "bearer",
    category: CATEGORY.SECRETS,
    severity: "medium",
    name: "Bearer token",
    re: /\bBearer\s+[A-Za-z0-9._-]{20,}/g,
    hint: "Hardcoded bearer token.",
  },
  {
    id: "pwd_assign",
    category: CATEGORY.SECRETS,
    severity: "medium",
    name: "Inline password/secret",
    re: /(password|passwd|api[_-]?key|secret)\s*[:=]\s*["'\x60][^"'\x60]{8,}["'\x60]/gi,
    hint: "Inline credential literal; verify it is a placeholder, not a live secret.",
  },
  {
    id: "reverse_shell",
    category: CATEGORY.NETWORK,
    severity: "high",
    name: "Reverse shell primitive",
    re: /(bash|sh|zsh)\s+-i[^;\n]*\/dev\/tcp\/|(\bnc\b|\bncat\b|\bsocat\b)\s+[^;]*(exec|-e\s+\/bin\/|-e\s+cmd)/gi,
    hint: "Reverse shell pattern - the plugin would open an outbound interactive shell.",
  },
  {
    id: "symlink_escape",
    category: CATEGORY.PERMISSIONS,
    severity: "high",
    name: "Symlink outside workspace",
    re: /(fs\.symlink(Sync)?\s*\(\s*["'"][^"']+["'"]\s*,\s*["'"][^"']+["'"]|\bln\s+-s\s+[^|&;\n]*\/)/g,
    hint: "Creates a symlink - if it points outside the workspace, recursive deletes on the link can wipe real data.",
  },
  {
    id: "rc_persistence",
    category: CATEGORY.PERMISSIONS,
    severity: "high",
    name: "Shell rc persistence",
    re: /(\.bashrc|\.zshrc|\.profile|\.bash_profile|\.zprofile)(\s*[<>]|["']\s*\+?=|\bappend\b|\bwriteFile\b)|([<>]{1,2}\s*~?\/?\.(bashrc|zshrc|profile|bash_profile|zprofile))/gi,
    hint: "Writing to shell rc files persists code across sessions.",
  },
  {
    id: "cron_persistence",
    category: CATEGORY.PERMISSIONS,
    severity: "high",
    name: "Scheduled-task persistence",
    re: /(\bcrontab\b|\/etc\/cron|\bschtasks\b|\bsystemctl\s+enable|\/etc\/systemd\/system|\/etc\/rc\.local)/gi,
    hint: "Installing scheduled tasks / system services persists execution.",
  },
  {
    id: "exfil_post",
    category: CATEGORY.NETWORK,
    severity: "high",
    name: "Credential/file exfiltration POST",
    re: /(\.(post|put|send|fetch)|(?<![A-Za-z0-9_])fetch)\s*\((?=[^)]*https?:\/\/)(?=[^)]*(process\.env|readFile|readFileSync|base64|btoa))/gi,
    hint: "Sends environment/file-derived data to an external host - the classic steal shape.",
  },
  {
    id: "encoded_pipe_sh",
    category: CATEGORY.OBFUSCATION,
    severity: "high",
    name: "Encoded command piped to shell",
    re: /(base64\s+-(d|decode)|echo\s+["'"][A-Za-z0-9+\/=]{20,}["'"])[^|&;\n]*\|[^|&;\n]*(sh|bash|powershell|cmd)/gi,
    hint: "Base64-decoded payload executed by a shell.",
  },
  {
    id: "node_eval",
    category: CATEGORY.SCRIPTS,
    severity: "medium",
    name: "Node inline eval",
    re: /\bnode\s+(-[ec]|--eval|--print)\s+["'"][^"']{8,}["'"]/g,
    hint: "Node evaluating inline code - verify the code string.",
  },
  {
    id: "wget_exec",
    category: CATEGORY.SCRIPTS,
    severity: "high",
    name: "wget download-and-execute",
    re: /\bwget\b[^|&;\n]*-(O-|-qO-|q-)\s+[^\s]+[^|&;\n]*\|[^|&;\n]*(sh|bash|zsh)/gi,
    hint: "wget piping a download straight into a shell.",
  },
  {
    id: "ps_download_exec",
    category: CATEGORY.SCRIPTS,
    severity: "high",
    name: "PowerShell download-and-execute",
    re: /(IEX\s*\(\s*\(?\s*New-Object\s+Net\.WebClient|(iwr|Invoke-WebRequest)[^|&;\n]*\|[^|&;\n]*iex\b)/gi,
    hint: "PowerShell downloading and executing remote content.",
  },
  {
    id: "ip_obfuscation",
    category: CATEGORY.NETWORK,
    severity: "low",
    name: "Obfuscated IP literal",
    re: /\b0x[0-9a-fA-F]{6,8}\b|\b\d{9,12}\b/g,
    hint: "Hex/alternate-notation IP literals are often used to evade allowlists.",
  },
  {
    id: "startup_registry",
    category: CATEGORY.PERMISSIONS,
    severity: "high",
    name: "Startup/registry persistence",
    re: /(HKCU\\[^"'\s]*\\Run|HKLM\\[^"'\s]*\\Run|Startup\\|reg\s+add[^|&;\n]*(Run|CurrentVersion))/gi,
    hint: "Registers the plugin to start on boot (Windows).",
  },
];

/** @type {Map<string, Rule>} */
const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));

/** Get a rule by id. */
export function ruleById(id) {
  return RULE_BY_ID.get(id);
}

/**
 * Apply every rule to one file's text, producing line-level hits.
 * Only rules with a global flag are used; each match maps to its line.
 * @param {string} fileName - basename/relative path for the report.
 * @param {string} content - file text.
 * @returns {Array<{rule:string, category:string, severity:string, file:string, line:number, evidence:string, hint:string}>}
 */
export function scanText(fileName, content) {
  const hits = [];
  const text = String(content);
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g");
    let match;
    const perLine = new Map();
    while ((match = re.exec(text)) !== null) {
      const line = lineOf(text, match.index);
      const key = line.number;
      const bucket = perLine.get(key) || { count: 0, index: line.start };
      bucket.count += 1;
      if (bucket.index > line.start) bucket.index = line.start;
      perLine.set(key, bucket);
    }
    for (const [lineNo, bucket] of perLine) {
      if (rule.minCount !== undefined && bucket.count < rule.minCount) continue;
      const lineText = lineTextAt(text, bucket.index).trim();
      hits.push({
        rule: rule.id,
        category: rule.category,
        severity: rule.severity,
        file: fileName,
        line: lineNo,
        count: bucket.count,
        evidence: (lineText || String(match)).slice(0, 200),
        hint: rule.hint,
      });
    }
  }
  return hits;
}

/** Line number + start index of the line containing byte offset index. */
function lineOf(text, index) {
  let line = 1;
  let start = 0;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      start = i + 1;
    }
  }
  return { number: line, start };
}

/** Extract the full line text at byte offset index. */
function lineTextAt(text, index) {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  let end = text.indexOf("\n", index);
  if (end === -1) end = text.length;
  return text.slice(start, end);
}

/**
 * Collect unique external hosts from a text blob.
 * @param {string} content - text to scan for URLs.
 * @returns {string[]} unique hostnames in appearance order.
 */
export function extractHosts(content) {
  const hosts = [];
  const seen = new Set();
  const urlRe = /\bhttps?:\/\/[^\s"'\x60<>()]+/g;
  let m;
  while ((m = urlRe.exec(content)) !== null) {
    let host;
    try {
      host = new URL(m[0]).hostname;
    } catch {
      continue;
    }
    const key = host.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hosts.push(host);
  }
  return hosts;
}

/**
 * Heuristic: does the same file read local files AND send data out?
 * @param {string} content - file text.
 * @returns {boolean}
 */
export function hasReadAndSend(content) {
  const reads = /\b(readFile|readFileSync|readText|readBytes|createReadStream|Get-Content)/g;
  const sends = /\b(fetch\s*\(|http\.(get|request)|https\.(get|request)|axios|WebSocket|net\.connect)/g;
  reads.lastIndex = 0;
  sends.lastIndex = 0;
  return reads.test(content) && sends.test(content);
}
