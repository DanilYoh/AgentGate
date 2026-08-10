# Contributing to AgentGate

AgentGate is deliberately small, deterministic, local, and read-only. Changes
should preserve those properties and support Node.js 20 or newer on Windows,
macOS, and Linux.

## Development setup

```console
npm install
npm run build
npm test
```

Before submitting a change, run the same checks as CI:

```console
npm run format
npm run lint
npm run typecheck
npm test
npm run build
npm run test:package
```

New rules implement the `Rule` interface in `src/types.ts`, inspect the parsed
diff without writing to the repository, and return findings rather than writing
to the terminal. Add focused positive and negative tests. Evidence must be short
and must never expose a full secret.

Bug reports should include the operating system, Node.js version, command,
configuration, expected result, and a minimal redacted diff. Never include real
credentials or proprietary source code.
