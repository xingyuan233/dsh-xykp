# Security Policy

dsh-plugin-gate is a heuristic scanner, not a formal antivirus or a
substitute for code review. It raises warnings from signature patterns and
can both miss novel malware and over-flag innocent code.

## Reporting a vulnerability

Open an issue at https://github.com/863683348/dsh-plugin-gate/issues with the
subject prefixed `[security]`. Do not include secrets or full malicious
payloads in the public issue; describe the pattern and, if needed, reach out
for a private channel.

## Scope

- Bugs in the scanner that cause missed detections or crashes.
- False positives that materially degrade the tool (rule too broad).
- Unsafe behavior of the gate itself (e.g. a rule that executes anything).

The gate itself never executes scanned code and never writes files.
