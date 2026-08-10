# AgentGate

AgentGate is a local pre-commit firewall for changes produced by coding agents
such as Codex, Claude Code, and Cursor. One command inspects the current Git
diff for added secrets, disabled tests, unfinished placeholders, new
dependencies, sensitive files, scope violations, and unexpectedly large changes.

It is deterministic, read-only, and runs entirely on your machine. It sends no
source code or statistics over the network, has no telemetry, and uses no LLM or
API key. AgentGate is a focused diff-policy check, not a general AI code
reviewer.

## Quick start

AgentGate requires Node.js 20 or newer and Git. Once the package is installed in
a repository, run:

```console
npx agentgate check
```

To try this source checkout without publishing anything:

```console
npm install
npm run build
npm pack
# In a separate Git repository:
npm install --save-dev /path/to/agentgate-0.1.0.tgz
npx agentgate check
```

A clean result exits with 0:

```text
AgentGate checked 2 file(s): +14 -3
No findings.
```

A blocking result exits with 1 and masks the evidence:

```text
AgentGate checked 1 file(s): +1 -0

[HIGH] secret-added at src/config.ts:8
  A value resembling a secret was added.
  Evidence: const token = "[REDACTED]"
  Fix: Remove the secret from the change and load it from a secure secret store or environment variable.

1 blocking finding(s).
```

## What it checks

| Rule                     | Added or changed risk                                                              |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `secret-added`           | Common tokens, credential assignments, JWTs, and private-key headers               |
| `test-disabled`          | `.skip`, `xit`, `xdescribe`, pytest skip markers, `@Disabled`, and similar forms   |
| `placeholder-added`      | `TODO`, `FIXME`, not-implemented exceptions/macros, and explicit stubs             |
| `dependency-added`       | New names and versions in `package.json`, `requirements.txt`, and `pyproject.toml` |
| `sensitive-file-changed` | GitHub Actions, Dockerfiles, migrations, auth/permission files, and lockfiles      |
| `scope-violation`        | Files outside `allowedPaths` or inside `deniedPaths`                               |
| `large-change`           | Changed-file, added-line, or deleted-line limits                                   |

Content rules inspect added lines where possible to reduce false positives.
File-scope and size rules necessarily inspect change metadata. The checks are
heuristics: review findings in context and keep specialized linters and security
scanners in the toolchain.

## CLI

```console
agentgate check
agentgate check --staged
agentgate check --base main
agentgate check --format text
agentgate check --format json
agentgate check --format sarif
agentgate check --config .agentgate.yml
```

- The default mode checks staged and unstaged tracked changes against `HEAD`,
  plus untracked text files not ignored by Git.
- `--staged` checks only the index, which is suitable for a pre-commit hook.
- `--base <ref>` checks changes from the merge base of the ref and `HEAD`, plus
  current tracked and untracked working-tree changes.
- `--staged` and `--base` are mutually exclusive.

Exit codes are stable: 0 means no finding at or above `failOn`; 1 means at least
one blocking finding; 2 means invalid arguments/configuration or a tool/Git
error.

## Configuration

AgentGate automatically reads `.agentgate.yml` from the repository root, even
when invoked from a subdirectory. A path passed with `--config` stays relative
to the invocation directory. Start from
[`examples/.agentgate.yml`](examples/.agentgate.yml):

```yaml
version: 1
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

rules:
  secret-added: error
  test-disabled: error
  placeholder-added: warning
  dependency-added: warning
  sensitive-file-changed: warning
  scope-violation: error
  large-change: warning
```

Rule values may be `off`, `info`, `low`, `medium`, `high`, or `critical`. For
concise policy files, `warning` maps to `medium` and `error` maps to `high`.
`failOn` uses the five finding severities and blocks that level and above. An
empty `allowedPaths` permits every path; `deniedPaths` always takes precedence.

Configuration is validated before reporting. Unknown keys, invalid path-list
types, negative limits, unsupported versions, and unknown rules return exit code
2 with the failing configuration path.

## Reports and secret safety

Text is intended for local terminals. JSON provides stable structured fields for
scripts. SARIF 2.1.0 can be consumed by compatible code-scanning systems:

```console
npx agentgate check --format json > agentgate.json
npx agentgate check --format sarif > agentgate.sarif
```

Every finding includes a rule ID, severity, file, optional line, explanation,
short evidence, and remediation. Secret values are redacted when the finding is
created and again when each report is serialized. Avoid sharing raw diffs: a
scanner can reduce exposure in its own output but cannot remove a committed
secret from Git history.

Git is invoked directly without a shell. External diff and text-conversion
drivers, pagers, and filesystem monitors are disabled for the scan;
user-provided refs are resolved after Git's end-of-options marker. Text output
also escapes terminal control characters from paths and errors.

## AgentGate and ordinary linters

|                                      | AgentGate                                  | Typical linter                                  |
| ------------------------------------ | ------------------------------------------ | ----------------------------------------------- |
| Primary input                        | Git diff and changed-file policy           | Source files or syntax trees                    |
| Primary question                     | “Did this change introduce a review risk?” | “Does this code follow language/project rules?” |
| Scope controls and size limits       | Built in                                   | Usually outside its scope                       |
| Dependency and sensitive-file notice | Built in                                   | Usually separate tooling                        |
| Type/style correctness               | Not attempted                              | Core strength                                   |

Use both: linters catch code-level defects and conventions; AgentGate provides a
fast, explainable gate around the shape and policy of a change.

## Development

```console
npm run format
npm run lint
npm run typecheck
npm test
npm run build
npm run test:package
```

`test:package` runs `npm pack`, installs the tarball into a temporary Git
repository, and executes the packed CLI. The test suite also creates temporary
repositories for end-to-end diff and exit-code coverage. See
[`docs/demo-script.md`](docs/demo-script.md) for a short terminal recording
scenario and [`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution guidance.

## License

MIT
