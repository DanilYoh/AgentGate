import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requestedBase = process.argv[2];
const eventBase = process.env.GITHUB_BASE_REF;
const base = requestedBase || (eventBase ? `origin/${eventBase}` : "HEAD^");
const cli = join(project, "dist", "cli.js");
const result = spawnSync(
  process.execPath,
  [cli, "check", "--base", base, "--policy-ref", base],
  {
    cwd: project,
    encoding: "utf8",
    windowsHide: true,
  },
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
process.exitCode = result.status ?? 2;
