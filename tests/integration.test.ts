import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { defaultConfig } from "../src/config/defaults.js";
import { scan } from "../src/engine.js";
import { GitClient } from "../src/git/git-client.js";
import { parseGitDiff } from "../src/git/diff-parser.js";
import { sensitiveFileChangedRule } from "../src/rules/sensitive-file-changed.js";
import { scopeViolationRule } from "../src/rules/scope-violation.js";
import { config, riskySyntheticSecret } from "./fixtures.js";

const temporaryDirectories: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
}

async function repository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "agentgate-test-"));
  temporaryDirectories.push(cwd);
  git(cwd, ["init", "--quiet"]);
  git(cwd, ["config", "user.email", "agentgate@example.invalid"]);
  git(cwd, ["config", "user.name", "AgentGate Test"]);
  git(cwd, ["config", "core.autocrlf", "false"]);
  await writeFile(join(cwd, "app.js"), "export const value = 1;\n", "utf8");
  git(cwd, ["add", "app.js"]);
  git(cwd, ["commit", "--quiet", "-m", "baseline"]);
  return cwd;
}

async function unbornRepository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "agentgate-unborn-"));
  temporaryDirectories.push(cwd);
  git(cwd, ["init", "--quiet"]);
  return cwd;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
  );
});

describe("Git and CLI integration", () => {
  it("finds a risky working-tree change in a temporary repository", async () => {
    const cwd = await repository();
    await writeFile(
      join(cwd, "app.js"),
      `export const value = 1;\nexport const token = "${riskySyntheticSecret}";\n`,
      "utf8",
    );
    const patch = await new GitClient(cwd).getDiff({});
    const result = scan(parseGitDiff(patch), defaultConfig);
    expect(result.findings.map((item) => item.ruleId)).toContain(
      "secret-added",
    );
    expect(result.blockingFindings).toBe(1);
  });

  it("is not broken by Git prefix configuration", async () => {
    const cwd = await repository();
    git(cwd, ["config", "diff.noprefix", "true"]);
    git(cwd, ["config", "diff.mnemonicPrefix", "true"]);
    await writeFile(join(cwd, "app.js"), "export const value = 2;\n", "utf8");
    const diff = parseGitDiff(await new GitClient(cwd).getDiff({}));
    expect(diff.files[0]?.path).toBe("app.js");
  });

  it("limits --staged to index changes", async () => {
    const cwd = await repository();
    await writeFile(
      join(cwd, "staged.test.js"),
      "it.skip('works', () => {});\n",
      "utf8",
    );
    git(cwd, ["add", "staged.test.js"]);
    await writeFile(join(cwd, "unstaged.js"), "// TODO: later\n", "utf8");
    const patch = await new GitClient(cwd).getDiff({ staged: true });
    const result = scan(parseGitDiff(patch), defaultConfig);
    expect(result.findings.map((item) => item.ruleId)).toEqual([
      "test-disabled",
    ]);
  });

  it("compares a base ref to committed changes", async () => {
    const cwd = await repository();
    await writeFile(
      join(cwd, "app.js"),
      "export const value = 1;\n// TODO: finish\n",
      "utf8",
    );
    git(cwd, ["add", "app.js"]);
    git(cwd, ["commit", "--quiet", "-m", "feature"]);
    const patch = await new GitClient(cwd).getDiff({ base: "HEAD~1" });
    expect(scan(parseGitDiff(patch), defaultConfig).findings[0]?.ruleId).toBe(
      "placeholder-added",
    );
  });

  it("includes repository-relative untracked files when invoked from a subdirectory", async () => {
    const cwd = await repository();
    const subdirectory = join(cwd, "sub");
    await mkdir(subdirectory);
    await writeFile(join(cwd, "root-untracked.js"), "// TODO: root\n", "utf8");
    await writeFile(join(subdirectory, "child.js"), "// TODO: child\n", "utf8");
    const diff = parseGitDiff(await new GitClient(subdirectory).getDiff({}));
    expect(diff.files.map((file) => file.path)).toEqual([
      "root-untracked.js",
      "sub/child.js",
    ]);
  });

  it("counts an empty untracked file without inventing an added line", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, "empty.txt"), "", "utf8");
    const diff = parseGitDiff(await new GitClient(cwd).getDiff({}));
    expect(diff.files.find((file) => file.path === "empty.txt")).toBeDefined();
    expect(diff.addedLines).toBe(0);
  });

  it("classifies an untracked NUL-containing file as binary", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, "payload.bin"), Buffer.from([65, 0, 66]));
    const diff = parseGitDiff(await new GitClient(cwd).getDiff({}));
    expect(
      diff.files.find((file) => file.path === "payload.bin"),
    ).toMatchObject({
      isBinary: true,
      additions: [],
    });
  });

  it.runIf(process.platform !== "win32")(
    "reads an untracked symlink target path rather than following the target",
    async () => {
      const cwd = await repository();
      await symlink("app.js", join(cwd, "link.js"));
      const diff = parseGitDiff(await new GitClient(cwd).getDiff({}));
      expect(
        diff.files.find((file) => file.path === "link.js")?.additions[0]
          ?.content,
      ).toBe("app.js");
    },
  );

  it("supports the default mode before the first commit", async () => {
    const cwd = await unbornRepository();
    await writeFile(
      join(cwd, "config.js"),
      `export const token = "${riskySyntheticSecret}";\n`,
      "utf8",
    );
    const output: string[] = [];
    const code = await runCli(["check"], cwd, {
      stdout: (value) => output.push(value),
      stderr: () => undefined,
    });
    expect(code).toBe(1);
    expect(output[0]).toContain("secret-added");
  });

  it("loads the default config from the repository root", async () => {
    const cwd = await repository();
    const subdirectory = join(cwd, "sub");
    await mkdir(subdirectory);
    await writeFile(
      join(cwd, ".agentgate.yml"),
      "version: 1\nrules:\n  secret-added: off\n",
      "utf8",
    );
    git(cwd, ["add", ".agentgate.yml"]);
    git(cwd, ["commit", "--quiet", "-m", "trusted policy"]);
    await writeFile(
      join(cwd, "app.js"),
      `export const token = "${riskySyntheticSecret}";\n`,
      "utf8",
    );
    const output: string[] = [];
    const code = await runCli(["check"], subdirectory, {
      stdout: (value) => output.push(value),
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(output[0]).toContain("No findings");
  });

  it("ignores an unstaged policy weakening during --staged checks", async () => {
    const cwd = await repository();
    await writeFile(
      join(cwd, ".agentgate.yml"),
      "version: 1\nrules:\n  secret-added: off\n",
      "utf8",
    );
    await writeFile(
      join(cwd, "app.js"),
      `export const token = "${riskySyntheticSecret}";\n`,
      "utf8",
    );
    git(cwd, ["add", "app.js"]);
    const errors: string[] = [];
    const code = await runCli(["check", "--staged"], cwd, {
      stdout: () => undefined,
      stderr: (value) => errors.push(value),
    });
    expect(code).toBe(1);
    expect(errors).toEqual([]);
  });

  it("fails closed when the checked diff changes the default policy", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, ".agentgate.yml"), "version: 1\n", "utf8");
    const errors: string[] = [];
    const code = await runCli(["check"], cwd, {
      stdout: () => undefined,
      stderr: (value) => errors.push(value),
    });
    expect(code).toBe(2);
    expect(errors[0]).toContain("changes .agentgate.yml");
  });

  it("loads policy from an explicitly trusted Git ref", async () => {
    const cwd = await repository();
    await writeFile(
      join(cwd, ".agentgate.yml"),
      "version: 1\nrules:\n  secret-added: off\n",
      "utf8",
    );
    git(cwd, ["add", ".agentgate.yml"]);
    git(cwd, ["commit", "--quiet", "-m", "trusted policy"]);
    git(cwd, ["branch", "trusted-policy"]);
    await writeFile(
      join(cwd, "app.js"),
      `export const token = "${riskySyntheticSecret}";\n`,
      "utf8",
    );
    expect(
      await runCli(["check", "--policy-ref", "trusted-policy"], cwd, {
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    ).toBe(0);
  });

  it("includes untracked files in --base mode", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, "untracked.js"), "// TODO: review\n", "utf8");
    const diff = parseGitDiff(
      await new GitClient(cwd).getDiff({ base: "HEAD" }),
    );
    expect(diff.files.map((file) => file.path)).toContain("untracked.js");
  });

  it("preserves both sides of a staged rename with spaces", async () => {
    const cwd = await repository();
    await mkdir(join(cwd, ".github", "workflows"), { recursive: true });
    await writeFile(
      join(cwd, ".github", "workflows", "old name.yml"),
      "name: CI\n",
      "utf8",
    );
    git(cwd, ["add", ".github/workflows/old name.yml"]);
    git(cwd, ["commit", "--quiet", "-m", "workflow"]);
    await mkdir(join(cwd, "docs"));
    git(cwd, ["mv", ".github/workflows/old name.yml", "docs/new name.yml"]);
    const diff = parseGitDiff(
      await new GitClient(cwd).getDiff({ staged: true }),
    );
    expect(diff.files[0]).toMatchObject({
      oldPath: ".github/workflows/old name.yml",
      newPath: "docs/new name.yml",
      path: "docs/new name.yml",
    });
    expect(
      sensitiveFileChangedRule.check({ diff, config: config() }),
    ).toHaveLength(1);
    expect(
      scopeViolationRule.check({
        diff,
        config: config({ deniedPaths: [".github/workflows/**"] }),
      }),
    ).toHaveLength(1);
  });

  it("retains a staged binary file and its sensitive path", async () => {
    const cwd = await repository();
    await mkdir(join(cwd, ".github", "workflows"), { recursive: true });
    await writeFile(
      join(cwd, ".github", "workflows", "payload.bin"),
      Buffer.from([0, 1, 2, 3]),
    );
    git(cwd, ["add", ".github/workflows/payload.bin"]);
    const diff = parseGitDiff(
      await new GitClient(cwd).getDiff({ staged: true }),
    );
    expect(diff.files[0]).toMatchObject({
      path: ".github/workflows/payload.bin",
      isBinary: true,
    });
    expect(
      sensitiveFileChangedRule.check({ diff, config: config() }),
    ).toHaveLength(1);
  });

  it("returns documented CLI exit codes and machine-readable output", async () => {
    const cwd = await repository();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };

    await writeFile(join(cwd, "app.js"), "export const value = 2;\n", "utf8");
    expect(await runCli(["check"], cwd, io)).toBe(0);

    await writeFile(
      join(cwd, "app.js"),
      "export const value = 2;\n// TODO: later\n",
      "utf8",
    );
    stdout.length = 0;
    expect(await runCli(["check"], cwd, io)).toBe(0);
    expect(stdout[0]).toContain("placeholder-added");
    expect(stdout[0]).toContain("0 blocking finding(s)");

    const secret = riskySyntheticSecret;
    await writeFile(
      join(cwd, "app.js"),
      `export const token = "${secret}";\n`,
      "utf8",
    );
    stdout.length = 0;
    expect(await runCli(["check", "--format", "json"], cwd, io)).toBe(1);
    expect(() => {
      JSON.parse(stdout[0] ?? "") as unknown;
    }).not.toThrow();
    expect(stdout[0]).not.toContain(secret);

    stdout.length = 0;
    expect(await runCli(["check", "--format", "sarif"], cwd, io)).toBe(1);
    expect((JSON.parse(stdout[0] ?? "") as { version: string }).version).toBe(
      "2.1.0",
    );

    expect(await runCli(["check", "--format", "xml"], cwd, io)).toBe(2);
    expect(stderr.at(-1)).toContain("--format must be one of");
  });

  it("returns 2 outside a Git repository", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentgate-nongit-"));
    temporaryDirectories.push(cwd);
    const errors: string[] = [];
    const code = await runCli(["check"], cwd, {
      stdout: () => undefined,
      stderr: (value) => errors.push(value),
    });
    expect(code).toBe(2);
    expect(errors[0]).toContain("Git failed");
  });

  it("returns a structured Git error outside a repository", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentgate-nongit-json-"));
    temporaryDirectories.push(cwd);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(["check", "--format", "json"], cwd, {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    });

    expect(code).toBe(2);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout[0] ?? "")).toMatchObject({
      status: "error",
      exitCode: 2,
      error: { code: "GIT_ERROR" },
    });
  });

  it("returns 2 for an invalid explicit configuration", async () => {
    const cwd = await repository();
    const source = "version: 2\n";
    await writeFile(join(cwd, "bad.yml"), source, "utf8");
    const digest = createHash("sha256").update(source).digest("hex");
    const errors: string[] = [];
    const code = await runCli(
      ["check", "--config", "bad.yml", "--config-sha256", digest],
      cwd,
      {
        stdout: () => undefined,
        stderr: (value) => errors.push(value),
      },
    );
    expect(code).toBe(2);
    expect(errors[0]).toContain("Configuration version must be 1");
  });

  it("returns a structured invalid-configuration error", async () => {
    const cwd = await repository();
    const source = "version: 2\n";
    await writeFile(join(cwd, "bad.yml"), source, "utf8");
    const digest = createHash("sha256").update(source).digest("hex");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(
      [
        "check",
        "--format",
        "json",
        "--config",
        "bad.yml",
        "--config-sha256",
        digest,
      ],
      cwd,
      {
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      },
    );

    expect(code).toBe(2);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout[0] ?? "") as {
      error: { code: string; message: string };
    };
    expect(report.error.code).toBe("INVALID_CONFIG");
    expect(report.error.message).toContain("Configuration version must be 1");
  });

  it("returns a structured resource-limit error", async () => {
    const cwd = await repository();
    await writeFile(
      join(cwd, "app.js"),
      `export const value = "${"x".repeat(512)}";\n`,
      "utf8",
    );
    const policyDirectory = await mkdtemp(
      join(tmpdir(), "agentgate-limit-policy-"),
    );
    temporaryDirectories.push(policyDirectory);
    const policy = join(policyDirectory, "policy.yml");
    await writeFile(
      policy,
      "version: 1\ngit:\n  commandTimeoutMs: 5000\n  maxDiffBytes: 128\n",
      "utf8",
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(
      ["check", "--format", "json", "--config", policy],
      cwd,
      {
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      },
    );

    expect(code).toBe(2);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout[0] ?? "")).toMatchObject({
      error: { code: "RESOURCE_LIMIT" },
    });
  });

  it("rejects an unpinned policy from inside the checked repository", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, "policy.yml"), "version: 1\n", "utf8");
    const errors: string[] = [];
    expect(
      await runCli(["check", "--config", "policy.yml"], cwd, {
        stdout: () => undefined,
        stderr: (value) => errors.push(value),
      }),
    ).toBe(2);
    expect(errors[0]).toContain("inside the checked repository is mutable");
  });

  it("rejects explicit policy content that does not match its pinned hash", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, "policy.yml"), "version: 1\n", "utf8");
    const errors: string[] = [];
    expect(
      await runCli(
        ["check", "--config", "policy.yml", "--config-sha256", "0".repeat(64)],
        cwd,
        {
          stdout: () => undefined,
          stderr: (value) => errors.push(value),
        },
      ),
    ).toBe(2);
    expect(errors[0]).toContain("SHA-256 mismatch");
  });

  it("fails closed for an oversized untracked file", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, "large.txt"), "123456789", "utf8");
    await expect(
      new GitClient(cwd).getDiff(
        {},
        {
          maxFiles: 10,
          maxFileBytes: 8,
          maxSymlinkBytes: 8,
          maxTotalBytes: 16,
          readTimeoutMs: 500,
        },
      ),
    ).rejects.toThrow("8-byte scan limit");
  });

  it("fails closed when aggregate untracked content exceeds its limit", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, "first.txt"), "12345", "utf8");
    await writeFile(join(cwd, "second.txt"), "67890", "utf8");
    await expect(
      new GitClient(cwd).getDiff(
        {},
        {
          maxFiles: 10,
          maxFileBytes: 8,
          maxSymlinkBytes: 8,
          maxTotalBytes: 8,
          readTimeoutMs: 500,
        },
      ),
    ).rejects.toThrow("8-byte total scan limit");
  });

  it("fails closed when the untracked file-count limit is exceeded", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, "first.txt"), "one", "utf8");
    await writeFile(join(cwd, "second.txt"), "two", "utf8");
    await expect(
      new GitClient(cwd).getDiff(
        {},
        {
          maxFiles: 1,
          maxFileBytes: 8,
          maxSymlinkBytes: 8,
          maxTotalBytes: 16,
          readTimeoutMs: 500,
        },
      ),
    ).rejects.toThrow("1-file scan limit");
  });

  it("fails closed when the configured diff-size limit is exceeded", async () => {
    const cwd = await repository();
    await writeFile(
      join(cwd, "app.js"),
      `export const value = "${"x".repeat(512)}";\n`,
      "utf8",
    );
    const client = new GitClient(cwd);
    client.configure({ commandTimeoutMs: 5_000, maxDiffBytes: 128 });
    await expect(client.getDiff({})).rejects.toThrow(/128-byte .*limit/u);
  });

  it("detects index mutation after a scan snapshot is captured", async () => {
    const cwd = await repository();
    const client = new GitClient(cwd);
    const snapshot = await client.captureSnapshot({ staged: true });
    await writeFile(join(cwd, "new.js"), "export const value = 2;\n", "utf8");
    git(cwd, ["add", "new.js"]);
    await expect(client.assertSnapshotUnchanged(snapshot)).rejects.toThrow(
      "HEAD or index changed",
    );
  });

  it("detects working-tree mutation after a diff is captured", async () => {
    const cwd = await repository();
    const client = new GitClient(cwd);
    const snapshot = await client.captureSnapshot({});
    const patch = await client.getDiff(snapshot);
    await writeFile(join(cwd, "app.js"), "export const value = 3;\n", "utf8");
    await expect(
      client.assertDiffUnchanged(snapshot, defaultConfig.untracked, patch),
    ).rejects.toThrow("modified while AgentGate was scanning");
  });

  it("rejects an oversized Git-backed policy before parsing it", async () => {
    const cwd = await repository();
    await writeFile(
      join(cwd, ".agentgate.yml"),
      "x".repeat(1024 * 1024 + 1),
      "utf8",
    );
    git(cwd, ["add", ".agentgate.yml"]);
    git(cwd, ["commit", "--quiet", "-m", "oversized policy"]);
    const errors: string[] = [];
    expect(
      await runCli(["check"], cwd, {
        stdout: () => undefined,
        stderr: (value) => errors.push(value),
      }),
    ).toBe(2);
    expect(errors[0]).toContain("exceeds 1048576 bytes");
  });

  it.runIf(process.platform !== "win32")(
    "refuses an untracked FIFO without opening it",
    async () => {
      const cwd = await repository();
      execFileSync("mkfifo", [join(cwd, "input.pipe")]);
      await expect(new GitClient(cwd).getDiff({})).rejects.toThrow(
        "non-regular repository path",
      );
    },
  );

  it("does not execute a base ref as shell syntax", async () => {
    const cwd = await repository();
    const marker = join(cwd, "agentgate-owned");
    const errors: string[] = [];
    const code = await runCli(
      ["check", "--base", "HEAD&echo owned>agentgate-owned"],
      cwd,
      {
        stdout: () => undefined,
        stderr: (value) => errors.push(value),
      },
    );
    expect(code).toBe(2);
    await expect(access(marker)).rejects.toThrow();
    expect(errors[0]).toContain("Git failed");
  });

  it("redacts secrets from CLI error messages", async () => {
    const cwd = await repository();
    const secret = riskySyntheticSecret;
    const policyDirectory = await mkdtemp(
      join(tmpdir(), "agentgate-policy-test-"),
    );
    temporaryDirectories.push(policyDirectory);
    const policy = join(policyDirectory, `${secret}.yml`);
    await writeFile(policy, "version: 2\n", "utf8");
    const errors: string[] = [];
    const code = await runCli(["check", "--config", policy], cwd, {
      stdout: () => undefined,
      stderr: (value) => errors.push(value),
    });
    expect(code).toBe(2);
    expect(errors[0]).not.toContain(secret);
    expect(errors[0]).toContain("[REDACTED]");
  });
});
