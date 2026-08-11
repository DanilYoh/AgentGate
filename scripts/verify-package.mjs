import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "agentgate-package-"));
const packDirectory = join(temporary, "pack");
const repository = join(temporary, "repository");
const npmCli = process.env.npm_execpath;

if (!npmCli)
  throw new Error(
    "npm_execpath is unavailable; run this verification through npm.",
  );

function run(command, args, cwd, options = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    windowsHide: true,
  });
}

function npm(args, cwd) {
  return run(process.execPath, [npmCli, ...args], cwd);
}

try {
  mkdirSync(packDirectory);
  mkdirSync(repository);
  const packOutput = JSON.parse(
    npm(["pack", "--json", "--pack-destination", packDirectory], project),
  );
  const filename = packOutput[0]?.filename;
  if (!filename) throw new Error("npm pack did not report a package filename.");
  const tarball = join(packDirectory, filename);

  npm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    repository,
  );
  run("git", ["init", "--quiet"], repository);
  run("git", ["config", "user.email", "agentgate@example.invalid"], repository);
  run("git", ["config", "user.name", "AgentGate Package Test"], repository);
  run("git", ["config", "core.autocrlf", "false"], repository);
  writeFileSync(join(repository, ".gitignore"), "node_modules/\n", "utf8");
  writeFileSync(
    join(repository, "app.js"),
    "export const value = 1;\n",
    "utf8",
  );
  run("git", ["add", "."], repository);
  run("git", ["commit", "--quiet", "-m", "baseline"], repository);

  const secret = "ghp_A7cK9mQ2vX5zB8nD4fH6jL0pR3sT1uW";
  writeFileSync(
    join(repository, "app.js"),
    `export const token = "${secret}";\n`,
    "utf8",
  );
  const cli = join(
    repository,
    "node_modules",
    "@danilyoh",
    "agentgate",
    "dist",
    "cli.js",
  );
  const result = spawnSync(
    process.execPath,
    [cli, "check", "--format", "json"],
    {
      cwd: repository,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.status !== 1) {
    throw new Error(
      `Packed CLI returned ${String(result.status)} instead of 1: ${result.stderr}`,
    );
  }
  const report = JSON.parse(result.stdout);
  if (!report.findings?.some((item) => item.ruleId === "secret-added")) {
    throw new Error("Packed CLI did not report secret-added.");
  }
  if (result.stdout.includes(secret))
    throw new Error("Packed CLI leaked the test secret.");
  if (!readFileSync(cli, "utf8").startsWith("#!/usr/bin/env node")) {
    throw new Error("Packed CLI is missing its executable shebang.");
  }
  console.log(`Verified installable package ${filename}.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
