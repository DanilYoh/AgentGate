# Security policy

## Supported versions

Security fixes are provided for the latest stable AgentGate release. Upgrade to
that release before reporting an issue that may already have been corrected.

## Reporting a vulnerability

Report vulnerabilities privately through a
[GitHub security advisory](https://github.com/DanilYoh/AgentGate/security/advisories/new).
Include the affected version, impact, reproduction steps, and a minimal redacted
example. Do not include real credentials, proprietary source code, or other
sensitive data.

Do not open a public issue for an unpatched vulnerability. A public issue is
appropriate only when it contains no sensitive details and cannot help someone
exploit users before a fix is available.

AgentGate is a deterministic diff-policy gate, not a sandbox or a complete
secret scanner. Its security boundaries and assumptions are documented in the
[threat model](docs/threat-model.md).
