export const policyTemplate = `version: 1
failOn: high

allowedPaths:
  - "src/**"
  - "tests/**"

deniedPaths:
  - ".github/workflows/**"

limits:
  changedFiles: 20
  addedLines: 500
  deletedLines: 300

git:
  commandTimeoutMs: 30000
  maxDiffBytes: 52428800

untracked:
  maxFiles: 10000
  maxFileBytes: 1048576
  maxSymlinkBytes: 4096
  maxTotalBytes: 8388608
  readTimeoutMs: 2000

rules:
  secret-added:
    level: error
    excludePaths:
      - "tests/fixtures/**"
  test-disabled: error
  placeholder-added: warning
  dependency-added: warning
  sensitive-file-changed: warning
  scope-violation: error
  large-change: warning

suppressions:
  - ruleId: placeholder-added
    path: "src/generated.ts"
    line: 12
    reason: "Generated compatibility stub"
`;
