import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];

interface WorkflowStep {
  env?: Record<string, string>;
  uses?: string;
  run?: string;
}

interface WorkflowJob {
  needs?: string | string[];
  environment?: string | { name?: string };
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface ReleaseWorkflow {
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, { required?: boolean; type?: string }>;
    };
  };
  permissions?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

async function createReleaseRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentgate-release-test-"));
  temporaryDirectories.push(root);
  await Promise.all([
    mkdir(join(root, "scripts"), { recursive: true }),
    mkdir(join(root, "src"), { recursive: true }),
  ]);

  const packageManifest = {
    name: "@danilyoh/agentgate",
    version: "1.2.3",
    repository: {
      type: "git",
      url: "git+https://github.com/DanilYoh/AgentGate.git",
    },
  };
  const packageLock = {
    name: packageManifest.name,
    version: packageManifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: packageManifest.name,
        version: packageManifest.version,
      },
    },
  };

  await Promise.all([
    copyFile(
      join(projectRoot, "scripts", "verify-release.mjs"),
      join(root, "scripts", "verify-release.mjs"),
    ),
    writeFile(
      join(root, "package.json"),
      `${JSON.stringify(packageManifest, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      join(root, "package-lock.json"),
      `${JSON.stringify(packageLock, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      join(root, "src", "version.ts"),
      'export const agentGateVersion = "1.2.3";\n',
      "utf8",
    ),
    writeFile(
      join(root, "CHANGELOG.md"),
      "# Changelog\n\n## 1.2.3 - 2026-08-12\n",
      "utf8",
    ),
  ]);

  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "AgentGate release test"]);
  git(root, ["config", "user.email", "release-test@example.invalid"]);
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "release 1.2.3"]);
  git(root, ["tag", "v1.2.3"]);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("release workflow", () => {
  it("keeps verification and OIDC publishing separated around one tarball", async () => {
    const source = await readFile(
      join(projectRoot, ".github", "workflows", "release.yml"),
      "utf8",
    );
    const document = parseDocument(source);
    expect(document.errors).toEqual([]);
    const workflow = document.toJS() as ReleaseWorkflow;

    expect(workflow.on?.workflow_dispatch?.inputs?.tag).toMatchObject({
      required: true,
      type: "string",
    });

    const verify = workflow.jobs?.verify;
    const publish = workflow.jobs?.publish;
    expect(verify).toBeDefined();
    expect(publish).toBeDefined();
    expect(workflow.permissions?.["id-token"]).toBeUndefined();
    expect(verify?.permissions?.["id-token"]).toBeUndefined();
    expect(publish?.needs).toBe("verify");
    expect(publish?.environment).toBe("npm");
    expect(publish?.permissions?.["id-token"]).toBe("write");

    const publishUses = (publish?.steps ?? [])
      .map((step) => step.uses)
      .filter((uses): uses is string => uses !== undefined);
    expect(
      publishUses.some((uses) => uses.startsWith("actions/checkout@")),
    ).toBe(false);

    const allUses = Object.values(workflow.jobs ?? {}).flatMap((job) =>
      (job.steps ?? [])
        .map((step) => step.uses)
        .filter((uses): uses is string => uses !== undefined),
    );
    expect(allUses.length).toBeGreaterThan(0);
    for (const uses of allUses) {
      expect(uses).toMatch(/^[^@\s]+@[0-9a-f]{40}$/u);
    }

    const allRunScripts = Object.values(workflow.jobs ?? {}).flatMap((job) =>
      (job.steps ?? [])
        .map((step) => step.run)
        .filter((run): run is string => run !== undefined),
    );
    expect(allRunScripts.join("\n")).not.toMatch(
      /\bnpm\s+(?:install|i)\b[^\n]*\s--global(?:\s|$)/u,
    );

    const publishSteps = publish?.steps ?? [];
    const identityStepIndex = publishSteps.findIndex((step) =>
      step.run?.includes("package/package.json"),
    );
    const publishStepIndex = publishSteps.findIndex((step) =>
      step.run?.includes("npm publish"),
    );
    expect(identityStepIndex).toBeGreaterThanOrEqual(0);
    expect(publishStepIndex).toBeGreaterThan(identityStepIndex);

    const identityStep = publishSteps[identityStepIndex];
    expect(identityStep?.env?.RELEASE_TAG).toBe("${{ inputs.tag }}");
    expect(identityStep?.run).toContain(
      'tar -xOf "${tarballs[0]}" package/package.json',
    );
    expect(identityStep?.run).toContain('release_version="${RELEASE_TAG#v}"');
    expect(identityStep?.run).toContain(
      'test "$RELEASE_TAG" = "v$release_version"',
    );
    expect(identityStep?.run).toContain(
      'test "$package_identity" = "@danilyoh/agentgate@$release_version"',
    );

    const publishRunScripts = publishSteps
      .map((step) => step.run)
      .filter((run): run is string => run !== undefined)
      .join("\n");
    expect(publishRunScripts).not.toMatch(
      /\bnpm\s+(?:ci|install|i|run|exec|test|start)\b/u,
    );
    expect(publishRunScripts).not.toMatch(/\bnpx\b/u);

    const publishCommands = Object.values(workflow.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .flatMap((step) => (step.run ?? "").split(/\r?\n/u))
      .map((line) => line.trim())
      .filter((line) => line.startsWith("npm publish"));
    expect(publishCommands).toEqual([
      'npm publish "${tarballs[0]}" --ignore-scripts --access public',
    ]);
    const artifactPublishStep = (publish?.steps ?? []).find((step) =>
      step.run?.includes("npm publish"),
    );
    expect(artifactPublishStep?.run).toContain("-name '*.tgz'");
    expect(artifactPublishStep?.run).toContain('test "${#tarballs[@]}" -eq 1');
  });
});

describe("dogfood policy", () => {
  it("pins the policy to the trusted comparison ref", async () => {
    const source = await readFile(
      join(projectRoot, "scripts", "dogfood.mjs"),
      "utf8",
    );

    expect(source).toContain(
      '[cli, "check", "--base", base, "--policy-ref", base]',
    );
    expect(source).not.toContain('"--config"');
    expect(source).not.toContain("createHash");
  });
});

describe("release verifier", () => {
  it("accepts a clean tagged release and rejects mismatched or dirty state", async () => {
    const root = await createReleaseRepository();
    const script = join(root, "scripts", "verify-release.mjs");

    const valid = spawnSync(process.execPath, [script, "v1.2.3"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    expect(valid.status, valid.stderr).toBe(0);
    expect(valid.stdout).toMatch(
      /^Verified release @danilyoh\/agentgate@1\.2\.3 at [0-9a-f]{40}\.\n$/u,
    );

    const mismatched = spawnSync(process.execPath, [script, "v1.2.4"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    expect(mismatched.status).not.toBe(0);
    expect(mismatched.stderr).toContain(
      "tag v1.2.4 does not match package version v1.2.3",
    );

    await writeFile(join(root, "untracked.txt"), "dirty\n", "utf8");
    const dirty = spawnSync(process.execPath, [script, "v1.2.3"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    expect(dirty.status).not.toBe(0);
    expect(dirty.stderr).toContain("the Git working tree is not clean");
  });
});
