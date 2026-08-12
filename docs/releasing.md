# Releasing AgentGate

AgentGate releases are built from an immutable Git tag, verified without npm
publish credentials, transferred as one checksummed tarball, and published from
a separate GitHub-hosted job through npm trusted publishing. The publish job
does not check out or execute repository code.

Never add an `NPM_TOKEN` fallback to the release workflow. npm trusted
publishing uses short-lived OIDC credentials and automatically emits provenance
for public packages from public repositories. It requires Node.js 22.14 or newer
and npm 11.5.1 or newer. See the official
[trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

## One-time administrator setup

Before creating a release:

1. Require two-factor authentication for the npm maintainer account and confirm
   ownership of the `@danilyoh` scope.
2. Protect `main` and `v*` tags with GitHub rulesets. Require CI, code-owner
   review, and block force-pushes and deletion. `CODEOWNERS` does not enforce
   review without the matching branch rule.
3. Create a GitHub environment named `npm`, restrict it to protected release
   tags, and require a maintainer approval for deployments.
4. Keep `.github/workflows/release.yml`, package metadata, the generated Action
   bundle, and release scripts under code-owner review.

## Bootstrap release

The npm registry requires a package to exist before a trusted publisher can be
configured. Therefore the first `@danilyoh/agentgate` release is a one-time
interactive bootstrap; do not dispatch `release.yml` for that version.

From a clean checkout of the protected release tag, run the same verification as
CI, build once, and publish the resulting tarball with an npm account that has
2FA enabled:

```console
git switch --detach v1.0.0
node scripts/verify-release.mjs v1.0.0
npm ci --ignore-scripts
npm run format
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run check:action-bundle
npm run test:action-bundle
npm run test:package
npm run dogfood
npm audit --audit-level=high
npm pack --ignore-scripts --pack-destination release-artifact
npm publish release-artifact/danilyoh-agentgate-1.0.0.tgz --ignore-scripts --access public
```

Do not publish from a branch, a dirty tree, or a tarball that was rebuilt after
verification. The final command must prompt for the maintainer's normal npm
authentication and 2FA; do not create a CI token for this bootstrap.

After the package exists, use npm 11.15.0 or newer to bind publishing to the
exact repository, workflow filename, and protected environment:

```console
npm install --global npm@11.19.0 --ignore-scripts
npm trust github @danilyoh/agentgate --repo DanilYoh/AgentGate --file release.yml --env npm --allow-publish
npm trust list @danilyoh/agentgate
```

The package-existence and 2FA requirements are documented by the official
[`npm trust` reference](https://docs.npmjs.com/cli/v11/commands/npm-trust/).
After confirming OIDC publishing, configure npm publishing access to require 2FA
and disallow traditional tokens.

## Subsequent releases

1. Update `package.json`, `package-lock.json`, `src/version.ts`, and
   `CHANGELOG.md` together. Rebuild and commit `action/dist` because it embeds
   the CLI version.
2. Run the full CI command set and merge through the protected `main` branch.
3. Create a protected `v<version>` tag pointing at that exact merge commit.
4. Manually dispatch the `Release` workflow with the exact existing tag.
5. Approve the `npm` environment only after the verification job succeeds and
   its inputs identify the intended tag.
6. Confirm the npm version, provenance attestation, GitHub release notes, and
   install smoke test before announcing the release.

The workflow deliberately does not create tags, modify GitHub releases, or
choose a version. The credential-bearing job does not check out repository code
and independently confirms that the transferred tarball declares exactly
`@danilyoh/agentgate@<tag>`. Version and tag selection remain review decisions
outside that job.
