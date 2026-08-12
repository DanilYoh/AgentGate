import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { policyTemplate } from "../src/config/template.js";
import { ruleMetadata } from "../src/rules/metadata.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    },
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function repository(): Promise<string> {
  const root = await temporaryDirectory("agentgate-command-");
  execFileSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  return root;
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

describe("operator commands", () => {
  it("keeps the embedded starter policy identical to the packaged example", async () => {
    const example = await readFile(
      join(projectRoot, "examples", ".agentgate.yml"),
      "utf8",
    );
    expect(policyTemplate).toBe(example);
  });

  it("initializes the repository root without overwriting", async () => {
    const root = await repository();
    const child = join(root, "nested");
    await mkdir(child);
    const first = capture();
    expect(await runCli(["init"], child, first.io)).toBe(0);
    expect(await readFile(join(root, ".agentgate.yml"), "utf8")).toBe(
      policyTemplate,
    );
    expect(first.stdout[0]).toContain("Review the policy");

    const second = capture();
    expect(await runCli(["init"], root, second.io)).toBe(2);
    expect(second.stderr[0]).toContain("never overwrites");
    expect(await readFile(join(root, ".agentgate.yml"), "utf8")).toBe(
      policyTemplate,
    );
  });

  it.runIf(process.platform !== "win32")(
    "does not replace an existing policy symlink",
    async () => {
      const root = await repository();
      const target = join(root, "target.yml");
      await writeFile(target, "do-not-change\n", "utf8");
      await symlink(target, join(root, ".agentgate.yml"));
      const output = capture();
      expect(await runCli(["init"], root, output.io)).toBe(2);
      expect(await readFile(target, "utf8")).toBe("do-not-change\n");
    },
  );

  it("fails init outside a Git repository", async () => {
    const cwd = await temporaryDirectory("agentgate-init-nongit-");
    const output = capture();
    expect(await runCli(["init"], cwd, output.io)).toBe(2);
    expect(output.stderr[0]).toContain("Git failed");
  });

  it("validates the root policy from a subdirectory and prints its digest", async () => {
    const root = await repository();
    const child = join(root, "nested");
    await mkdir(child);
    await writeFile(join(root, ".agentgate.yml"), "version: 1\n", "utf8");
    const output = capture();
    expect(await runCli(["validate-config"], child, output.io)).toBe(0);
    expect(output.stdout[0]).toContain("Valid AgentGate policy");
    expect(output.stdout[0]).toContain(
      createHash("sha256").update("version: 1\n").digest("hex"),
    );
  });

  it("validates an explicit policy without requiring Git and enforces its digest", async () => {
    const cwd = await temporaryDirectory("agentgate-validate-");
    const path = join(cwd, "policy.yml");
    const source = "version: 1\n";
    const digest = createHash("sha256").update(source).digest("hex");
    await writeFile(path, source, "utf8");

    const valid = capture();
    expect(
      await runCli(
        ["validate-config", "--config", path, "--config-sha256", digest],
        cwd,
        valid.io,
      ),
    ).toBe(0);
    expect(valid.stdout[0]).toContain(digest);

    const invalid = capture();
    expect(
      await runCli(
        [
          "validate-config",
          "--config",
          path,
          "--config-sha256",
          "0".repeat(64),
        ],
        cwd,
        invalid.io,
      ),
    ).toBe(2);
    expect(invalid.stderr[0]).toContain("SHA-256 mismatch");
  });

  it("explains every registered rule without requiring Git", async () => {
    const cwd = await temporaryDirectory("agentgate-explain-");
    const output = capture();
    expect(await runCli(["explain"], cwd, output.io)).toBe(0);
    for (const metadata of ruleMetadata) {
      expect(output.stdout[0]).toContain(metadata.id);
    }

    const detail = capture();
    expect(await runCli(["explain", "dependency-added"], cwd, detail.io)).toBe(
      0,
    );
    expect(detail.stdout[0]).toContain("Inspects:");
    expect(detail.stdout[0]).toContain("Limitations:");

    const unknown = capture();
    expect(await runCli(["explain", "unknown-rule"], cwd, unknown.io)).toBe(2);
    expect(unknown.stderr[0]).toContain("Unknown rule");
  });
});
