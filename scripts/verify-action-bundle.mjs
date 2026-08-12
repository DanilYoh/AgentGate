import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "agentgate-action-"));

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function outputs(path) {
  const source = readFileSync(path, "utf8");
  const values = new Map();
  const pattern = /^([^<\r\n]+)<<([^\r\n]+)\r?\n([\s\S]*?)\r?\n\2\r?$/gmu;
  for (const match of source.matchAll(pattern)) {
    if (match[1] && match[3] !== undefined) values.set(match[1], match[3]);
  }
  return values;
}

function isInside(root, path) {
  const local = relative(resolve(root), resolve(path));
  return (
    local === "" ||
    (local !== ".." &&
      !local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(local))
  );
}

function run(bundle, repository, runnerTemp, values, outputName) {
  const output = join(temporary, outputName);
  writeFileSync(output, "", "utf8");
  const environment = {
    ...process.env,
    "INPUT_HEAD-SHA": values.head,
    "INPUT_BASE-SHA": values.base,
    "INPUT_POLICY-SHA": values.policy,
    INPUT_FORMAT: "sarif",
    GITHUB_WORKSPACE: repository,
    RUNNER_TEMP: runnerTemp,
    GITHUB_OUTPUT: output,
  };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  const result = spawnSync(process.execPath, [bundle], {
    cwd: repository,
    env: environment,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    outputSource: readFileSync(output, "utf8"),
    result,
    outputs: outputs(output),
  };
}

function verifyManifest() {
  const document = parseDocument(
    readFileSync(join(project, "action.yml"), "utf8"),
  );
  if (document.errors.length > 0) {
    throw new Error(`Invalid action.yml: ${document.errors[0]?.message}`);
  }
  const manifest = document.toJS();
  if (
    manifest?.runs?.using !== "node24" ||
    manifest?.runs?.main !== "action/dist/index.js"
  ) {
    throw new Error(
      "action.yml must run action/dist/index.js with Node.js 24.",
    );
  }
  for (const name of ["head-sha", "base-sha", "policy-sha"]) {
    if (manifest?.inputs?.[name]?.required !== true) {
      throw new Error(`action.yml input ${name} must be required.`);
    }
  }
  if (
    manifest?.inputs?.format?.required !== false ||
    manifest?.inputs?.format?.default !== "sarif"
  ) {
    throw new Error("action.yml format input must default to optional SARIF.");
  }
  for (const name of ["report-path", "exit-code"]) {
    if (typeof manifest?.outputs?.[name]?.description !== "string") {
      throw new Error(`action.yml output ${name} must be declared.`);
    }
  }
}

try {
  verifyManifest();
  const isolated = join(temporary, "isolated");
  const repository = join(temporary, "repository");
  const runnerTemp = join(temporary, "runner-temp");
  mkdirSync(isolated);
  mkdirSync(repository);
  mkdirSync(runnerTemp);
  writeFileSync(join(isolated, "package.json"), '{"type":"module"}\n', "utf8");
  const bundle = join(isolated, "index.js");
  copyFileSync(join(project, "action", "dist", "index.js"), bundle);

  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.email", "agentgate@example.invalid"]);
  git(repository, ["config", "user.name", "AgentGate Action Test"]);
  git(repository, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(repository, ".agentgate.yml"), "version: 1\n", "utf8");
  writeFileSync(
    join(repository, "app.js"),
    "export const value = 1;\n",
    "utf8",
  );
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "base"]);
  const base = git(repository, ["rev-parse", "HEAD"]);
  const secret = `ghp_${"A7cK9mQ2vX5zB8nD4fH6jL0pR3sT1uW"}`;
  writeFileSync(
    join(repository, "app.js"),
    `export const token = "${secret}";\n`,
    "utf8",
  );
  git(repository, ["add", "app.js"]);
  git(repository, ["commit", "--quiet", "-m", "risky change"]);
  const head = git(repository, ["rev-parse", "HEAD"]);

  const finding = run(
    bundle,
    repository,
    runnerTemp,
    { head, base, policy: base },
    "finding-output.txt",
  );
  if (finding.result.status !== 1) {
    throw new Error(
      `Action finding smoke returned ${String(finding.result.status)}: ${finding.result.stderr}`,
    );
  }
  if (finding.outputs.get("exit-code") !== "1") {
    throw new Error(
      "Action did not expose exit-code 1 for a blocking finding.",
    );
  }
  const reportPath = finding.outputs.get("report-path");
  if (!reportPath || !isInside(runnerTemp, reportPath)) {
    throw new Error("Action report was not created under RUNNER_TEMP.");
  }
  if (isInside(repository, reportPath)) {
    throw new Error("Action report was written into the checked repository.");
  }
  const reportSource = readFileSync(reportPath, "utf8");
  const report = JSON.parse(reportSource);
  if (
    !report.runs?.[0]?.results?.some((item) => item.ruleId === "secret-added")
  ) {
    throw new Error("Action SARIF did not contain secret-added.");
  }
  const emitted = [
    reportSource,
    finding.result.stdout,
    finding.result.stderr,
    finding.outputSource,
  ].join("\n");
  if (emitted.includes(secret)) {
    throw new Error(
      "Action leaked a secret through a report or process channel.",
    );
  }

  const mismatch = run(
    bundle,
    repository,
    runnerTemp,
    { head: "0".repeat(40), base, policy: base },
    "mismatch-output.txt",
  );
  if (
    mismatch.result.status !== 1 ||
    mismatch.outputs.get("exit-code") !== "2"
  ) {
    throw new Error("Action did not fail closed for a mismatched pinned HEAD.");
  }
  console.log("Verified isolated GitHub Action bundle.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
