# Threat model

AgentGate is intended to enforce a diff policy even when the process that
produced the diff is not trusted. The untrusted process may modify tracked,
staged, and untracked files in the repository. It may also place large files or
special filesystem objects in untracked paths.

## Trust boundary

The operator must control the AgentGate executable, its command-line arguments,
and at least one policy source. The Git executable and the selected Git object
database/ref must also be trustworthy when a Git-backed policy is used. If an
agent can replace the installed CLI, rewrite the hook or CI command, change the
expected policy hash, or move a supposedly trusted local ref, it can bypass the
gate.

Policy modes provide different guarantees:

| Mode                          | Policy source                            | Intended use                                           |
| ----------------------------- | ---------------------------------------- | ------------------------------------------------------ |
| Default `check` or `--staged` | `.agentgate.yml` blob from `HEAD`        | Pre-commit checks where the previous commit is trusted |
| `--base <ref>`                | Policy blob from the merge base          | PR checks against a protected base                     |
| `--policy-ref <ref>`          | Policy blob from the named commit        | CI with an operator-selected protected ref             |
| External `--config`           | File selected outside the repository     | Host-managed policy                                    |
| `--config-sha256`             | Exact bytes matching the supplied digest | Pinned policy content, including an in-repository file |

The working-tree `.agentgate.yml` is never the automatic policy source. In the
Git-backed policy modes, a checked change to that file fails closed. An explicit
config inside the checked repository is rejected unless its SHA-256 is pinned.
Bootstrap and policy updates should therefore be reviewed using an external or
pinned policy.

`HEAD` is not sufficient when an untrusted agent is allowed to create or rewrite
commits before the check. Use a protected ref selected by the caller, or an
external policy with an expected hash. A local `origin/main` ref is only as
trustworthy as the process permissions around the repository; high-assurance CI
should supply the policy or expected digest from protected runner configuration.

## Fail-closed behavior

Invalid/missing explicit policies, hash mismatches, changed automatic policy,
Git failures, unreadable untracked files, special files, oversized files, and
untracked read timeouts return exit code 2. Callers must treat both exit codes 1
and 2 as blocking.

Rule exclusions and finding suppressions live inside the trusted policy. A
suppression is auditable and requires a reason; it can be narrowed to an exact
line. Reports keep the number of suppressed findings separate from active
findings.

## Out of scope

AgentGate does not sandbox the coding agent, validate the semantics of safe
looking code, protect Git history by itself, or replace repository permissions,
CODEOWNERS, branch protection, secret scanning, dependency review, and normal
human review. It also cannot protect a secret already committed to history.
