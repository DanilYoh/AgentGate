# Changelog

All notable changes to this project will be documented here.

## Unreleased

- Emit sanitized, structured exit-code 2 reports on stdout for JSON and SARIF,
  with stable error categories and a published JSON report schema. Text errors
  remain on stderr.
- Include redacted suppression reasons and their deterministic policy-list
  source in text, JSON, and SARIF reports without treating suppressed findings
  as active SARIF results.

### Security

- Load automatic policy from a trusted Git snapshot, support protected policy
  refs and SHA-256-pinned external policy, and fail closed on mutable policy.
- Bound and time-limit untracked-file reads and reject special files.
- Redact individual JSON and SARIF fields before serialization.
- Pin each scan to one resolved commit/index snapshot, reject concurrent
  mutations, and bound Git execution, diff size, untracked count, and symlink
  targets.

### Changed

- Rename the npm package to `@danilyoh/agentgate` while retaining the
  `agentgate` binary.
- Add rule-level path exclusions, audited suppressions, and self-dogfooding.
- Normalize repository text to LF across operating systems and make the package
  smoke test execute the installed CLI deterministically.

## 0.1.0 - 2026-08-10

### Added

- Initial `agentgate check` CLI with working-tree, staged, and base-ref modes.
- Seven deterministic diff rules for secrets, disabled tests, placeholders,
  dependencies, sensitive files, path scope, and change size.
- Validated `.agentgate.yml` configuration.
- Text, JSON, and SARIF 2.1.0 reports with secret redaction.
- Cross-platform tests, package verification, and CI for Node.js 20 and 22.

### Changed

- Hardened Git invocation against shell/config-driven execution and made diff
  selection deterministic from repository subdirectories.
- Corrected rename, binary, empty-file, symlink, C-quoted path, and untracked
  file handling.
- Reduced secret and disabled-test false positives while applying redaction to
  every report field and CLI error.
- Added SARIF compile-time typing, encoded artifact URIs, and rule indexes.
