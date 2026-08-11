#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { defaultConfig } from "./config/defaults.js";
import { loadConfig, parseConfig } from "./config/load.js";
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
  configSha256?: string;
  policyRef?: string;
}

function usage(): string {
  return `Usage: agentgate check [options]\n\nOptions:\n  --staged                  Check staged changes only\n  --base <ref>               Compare the merge base of <ref> and HEAD\n  --format <format>          Output text, json, or sarif (default: text)\n  --policy-ref <ref>         Read .agentgate.yml from a trusted Git ref\n  --config <path>            Read an explicit external YAML policy\n  --config-sha256 <sha256>   Require the exact explicit policy content\n  -h, --help                 Show help\n  -v, --version              Show version`;
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
    } else if (argument === "--config-sha256") {
      const value = args[++index];
      if (!value || !/^[a-f0-9]{64}$/iu.test(value)) {
        throw new AgentGateError(
          "--config-sha256 requires a 64-character hexadecimal digest.",
        );
      }
      options.configSha256 = value.toLowerCase();
    } else if (argument === "--policy-ref") {
      const value = args[++index];
      if (!value) throw new AgentGateError("--policy-ref requires a Git ref.");
      options.policyRef = value;
    } else throw new AgentGateError(`Unknown option: ${argument}`);
  }
  if (options.staged && options.base)
    throw new AgentGateError("--staged and --base cannot be used together.");
  if (options.configPath && options.policyRef) {
    throw new AgentGateError(
      "--config and --policy-ref cannot be used together.",
    );
  }
  if (options.configSha256 && !options.configPath) {
    throw new AgentGateError("--config-sha256 requires --config.");
  }
  return options;
}

async function isInside(root: string, path: string): Promise<boolean> {
  let canonicalRoot: string;
  let canonicalPath: string;
  try {
    [canonicalRoot, canonicalPath] = await Promise.all([
      realpath(root),
      realpath(path),
    ]);
  } catch {
    canonicalRoot = resolve(root);
    canonicalPath = resolve(path);
  }
  const local = relative(canonicalRoot, canonicalPath);
  return (
    local === "" ||
    (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local))
  );
}

function changesDefaultPolicy(patch: ReturnType<typeof parseGitDiff>): boolean {
  return patch.files.some((file) =>
    [file.oldPath, file.newPath, file.path].some(
      (path) => path?.replaceAll("\\", "/") === ".agentgate.yml",
    ),
  );
}

async function loadTrustedConfig(
  git: GitClient,
  cwd: string,
  root: string,
  options: CliOptions,
) {
  if (options.configPath) {
    const path = isAbsolute(options.configPath)
      ? options.configPath
      : resolve(cwd, options.configPath);
    if ((await isInside(root, path)) && !options.configSha256) {
      throw new AgentGateError(
        "A policy inside the checked repository is mutable. Pass its expected --config-sha256, use an external protected --config, or use --policy-ref.",
      );
    }
    return loadConfig(cwd, path, options.configSha256);
  }

  const commit = options.policyRef
    ? await git.resolveCommit(options.policyRef)
    : options.base
      ? await git.getMergeBase(options.base)
      : await git.getHeadCommit();
  if (!commit) return structuredClone(defaultConfig);
  const source = await git.readFileAt(commit, ".agentgate.yml");
  if (source === undefined) {
    if (options.policyRef) {
      throw new AgentGateError(
        `.agentgate.yml does not exist at policy ref ${options.policyRef}.`,
      );
    }
    return structuredClone(defaultConfig);
  }
  return parseConfig(source, `.agentgate.yml at ${commit}`);
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
    const config = await loadTrustedConfig(git, cwd, root, options);
    const patch = parseGitDiff(await git.getDiff(options, config.untracked));
    if (!options.configPath && changesDefaultPolicy(patch)) {
      throw new AgentGateError(
        "The checked diff changes .agentgate.yml. Review policy changes separately, or pin an explicit trusted policy with --config and --config-sha256.",
      );
    }
    const result = scan(patch, config);
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

async function isEntryPoint(): Promise<boolean> {
  const entryPath = process.argv[1];
  if (!entryPath) return false;
  try {
    const [modulePath, executablePath] = await Promise.all([
      realpath(fileURLToPath(import.meta.url)),
      realpath(entryPath),
    ]);
    return modulePath === executablePath;
  } catch {
    return import.meta.url === pathToFileURL(entryPath).href;
  }
}

if (await isEntryPoint()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
