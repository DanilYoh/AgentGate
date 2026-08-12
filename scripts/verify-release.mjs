import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseTag = process.argv[2];

function fail(message) {
  throw new Error(`Release verification failed: ${message}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(project, path), "utf8"));
}

function git(args) {
  return execFileSync("git", args, {
    cwd: project,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

if (
  !releaseTag ||
  !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
    releaseTag,
  )
) {
  fail("pass an immutable semantic-version tag such as v1.2.3.");
}

const manifest = readJson("package.json");
const lock = readJson("package-lock.json");
const expectedTag = `v${String(manifest.version)}`;
if (releaseTag !== expectedTag) {
  fail(`tag ${releaseTag} does not match package version ${expectedTag}.`);
}
if (manifest.name !== "@danilyoh/agentgate") {
  fail("package name must remain @danilyoh/agentgate.");
}
if (
  manifest.repository?.type !== "git" ||
  manifest.repository?.url !== "git+https://github.com/DanilYoh/AgentGate.git"
) {
  fail("package repository metadata does not match DanilYoh/AgentGate.");
}
if (
  lock.name !== manifest.name ||
  lock.version !== manifest.version ||
  lock.packages?.[""]?.name !== manifest.name ||
  lock.packages?.[""]?.version !== manifest.version
) {
  fail("package-lock.json root metadata does not match package.json.");
}

const versionSource = readFileSync(resolve(project, "src/version.ts"), "utf8");
if (
  versionSource !==
  `export const agentGateVersion = ${JSON.stringify(manifest.version)};\n`
) {
  fail("src/version.ts does not exactly match package.json.");
}

const escapedVersion = String(manifest.version).replaceAll(".", "\\.");
const changelog = readFileSync(resolve(project, "CHANGELOG.md"), "utf8");
if (
  !new RegExp(`^## ${escapedVersion} - \\d{4}-\\d{2}-\\d{2}$`, "mu").test(
    changelog,
  )
) {
  fail(`CHANGELOG.md has no dated ${String(manifest.version)} release.`);
}

let tagCommit;
try {
  tagCommit = git([
    "rev-parse",
    "--verify",
    "--end-of-options",
    `refs/tags/${releaseTag}^{commit}`,
  ]);
} catch {
  fail(`Git tag ${releaseTag} does not exist locally.`);
}
const headCommit = git(["rev-parse", "--verify", "HEAD^{commit}"]);
if (tagCommit !== headCommit) {
  fail(`tag ${releaseTag} does not point to the checked-out HEAD.`);
}

const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
if (status) fail("the Git working tree is not clean.");

console.log(
  `Verified release ${String(manifest.name)}@${String(manifest.version)} at ${headCommit}.`,
);
