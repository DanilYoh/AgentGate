#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config/load.js";
import { AgentGateError } from "./errors.js";
import { scan } from "./engine.js";
import { GitClient } from "./git/git-client.js";
import { parseGitDiff } from "./git/diff-parser.js";
import { formatReport } from "./reporters/index.js";
import { safeTextFragment } from "./security/redact.js";
import { agentGateVersion } from "./version.js";
import type { OutputFormat } from "./reporters/index.js";

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

const defaultIo: CliIo = {
  stdout: (value) => console.log(value),
  stderr: (value) => console.error(value),
};

interface CliOptions {
  staged: boolean;
  format: OutputFormat;
  base?: string;
  configPath?: string;
}

function usage(): string {
  return `Usage: agentgate check [options]\n\nOptions:\n  --staged              Check staged changes only\n  --base <ref>           Compare the merge base of <ref> and HEAD\n  --format <format>      Output text, json, or sarif (default: text)\n  --config <path>        Read configuration from a YAML file\n  -h, --help             Show help\n  -v, --version          Show version`;
}

function parseArgs(args: string[]): CliOptions | "help" | "version" {
  if (args.includes("--help") || args.includes("-h")) return "help";
  if (args.includes("--version") || args.includes("-v")) return "version";
  if (args[0] !== "check")
    throw new AgentGateError("Expected the `check` command.");
  const options: CliOptions = { staged: false, format: "text" };
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--staged") options.staged = true;
    else if (argument === "--base") {
      const value = args[++index];
      if (!value) throw new AgentGateError("--base requires a Git ref.");
      options.base = value;
    } else if (argument === "--format") {
      const value = args[++index];
      if (value !== "text" && value !== "json" && value !== "sarif") {
        throw new AgentGateError("--format must be one of: text, json, sarif.");
      }
      options.format = value;
    } else if (argument === "--config") {
      const value = args[++index];
      if (!value) throw new AgentGateError("--config requires a path.");
      options.configPath = value;
    } else throw new AgentGateError(`Unknown option: ${argument}`);
  }
  if (options.staged && options.base)
    throw new AgentGateError("--staged and --base cannot be used together.");
  return options;
}

export async function runCli(
  args: string[],
  cwd = process.cwd(),
  io: CliIo = defaultIo,
): Promise<number> {
  try {
    const options = parseArgs(args);
    if (options === "help") {
      io.stdout(usage());
      return 0;
    }
    if (options === "version") {
      io.stdout(agentGateVersion);
      return 0;
    }
    const git = new GitClient(cwd);
    const root = await git.getRepositoryRoot();
    const config = await loadConfig(
      options.configPath ? cwd : root,
      options.configPath,
    );
    const patch = await git.getDiff(options);
    const result = scan(parseGitDiff(patch), config);
    io.stdout(formatReport(result, options.format));
    return result.blockingFindings > 0 ? 1 : 0;
  } catch (error) {
    io.stderr(
      safeTextFragment(
        `AgentGate error: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return 2;
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryUrl) {
  process.exitCode = await runCli(process.argv.slice(2));
}
