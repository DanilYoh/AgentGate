import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { defaultConfig } from "./config/defaults.js";
import { loadConfig, parseConfig } from "./config/load.js";
import { AgentGateError } from "./errors.js";
import { scan } from "./engine.js";
import { GitClient } from "./git/git-client.js";
import type { GitSnapshot } from "./git/git-client.js";
import { parseGitDiff } from "./git/diff-parser.js";
import { isDependencyManifest } from "./rules/dependency-added.js";
import { matchesPath } from "./path-match.js";
import { formatReport } from "./reporters/index.js";
import {
  formatJsonError,
  formatSarifError,
  formatTextError,
  toReportedError,
} from "./reporters/error.js";
import { agentGateVersion } from "./version.js";
import { initializePolicy } from "./commands/init.js";
import { validatePolicy } from "./commands/validate-config.js";
import { explainRules } from "./commands/explain.js";
import type { OutputFormat } from "./reporters/index.js";

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface CliExecutionConstraints {
  expectedHead?: string;
  expectedBaseCommit?: string;
  expectedPolicyCommit?: string;
}

const defaultIo: CliIo = {
  stdout: (value) => console.log(value),
  stderr: (value) => console.error(value),
};

interface CheckOptions {
  command: "check";
  staged: boolean;
  format: OutputFormat;
  base?: string;
  configPath?: string;
  configSha256?: string;
  policyRef?: string;
}

interface InitOptions {
  command: "init";
}

interface ValidateOptions {
  command: "validate-config";
  configPath?: string;
  configSha256?: string;
}

interface ExplainOptions {
  command: "explain";
  ruleId?: string;
}

type CliOptions = CheckOptions | InitOptions | ValidateOptions | ExplainOptions;

function usage(): string {
  return `Usage: agentgate <command> [options]\n\nCommands:\n  check                       Inspect a Git change against policy\n  init                        Create .agentgate.yml without overwriting\n  validate-config             Validate a policy and print its SHA-256\n  explain [rule-id]           Describe all rules or one rule\n\nCheck options:\n  --staged                    Check staged changes only\n  --base <ref>                Compare the merge base of <ref> and HEAD\n  --format <format>           Output text, json, or sarif (default: text)\n  --policy-ref <ref>          Read .agentgate.yml from a trusted Git ref\n  --config <path>             Read an explicit external YAML policy\n  --config-sha256 <sha256>    Require the exact explicit policy content\n\nValidate-config options:\n  --config <path>             Validate an explicit policy path\n  --config-sha256 <sha256>    Require the exact explicit policy content\n\nGlobal options:\n  -h, --help                  Show help\n  -v, --version               Show version`;
}

function invalidArgument(message: string): AgentGateError {
  return new AgentGateError(message, { code: "INVALID_ARGUMENT" });
}

function requestedErrorFormat(args: string[]): "json" | "sarif" | undefined {
  let format: "json" | "sarif" | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--format") continue;
    const value = args[index + 1];
    if (value === "text") format = undefined;
    else if (value === "json" || value === "sarif") format = value;
    else return undefined;
    index += 1;
  }
  return format;
}

function parseDigest(value: string | undefined): string {
  if (!value || !/^[a-f0-9]{64}$/iu.test(value)) {
    throw invalidArgument(
      "--config-sha256 requires a 64-character hexadecimal digest.",
    );
  }
  return value.toLowerCase();
}

function parseCheckArgs(args: string[]): CheckOptions {
  const options: CheckOptions = {
    command: "check",
    staged: false,
    format: "text",
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--staged") options.staged = true;
    else if (argument === "--base") {
      const value = args[++index];
      if (!value) throw invalidArgument("--base requires a Git ref.");
      options.base = value;
    } else if (argument === "--format") {
      const value = args[++index];
      if (value !== "text" && value !== "json" && value !== "sarif") {
        throw invalidArgument("--format must be one of: text, json, sarif.");
      }
      options.format = value;
    } else if (argument === "--config") {
      const value = args[++index];
      if (!value) throw invalidArgument("--config requires a path.");
      options.configPath = value;
    } else if (argument === "--config-sha256") {
      options.configSha256 = parseDigest(args[++index]);
    } else if (argument === "--policy-ref") {
      const value = args[++index];
      if (!value) throw invalidArgument("--policy-ref requires a Git ref.");
      options.policyRef = value;
    } else throw invalidArgument(`Unknown option: ${argument}`);
  }
  if (options.staged && options.base)
    throw invalidArgument("--staged and --base cannot be used together.");
  if (options.configPath && options.policyRef) {
    throw invalidArgument("--config and --policy-ref cannot be used together.");
  }
  if (options.configSha256 && !options.configPath) {
    throw invalidArgument("--config-sha256 requires --config.");
  }
  return options;
}

function parseValidateArgs(args: string[]): ValidateOptions {
  const options: ValidateOptions = { command: "validate-config" };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--config") {
      const value = args[++index];
      if (!value) throw invalidArgument("--config requires a path.");
      options.configPath = value;
    } else if (argument === "--config-sha256") {
      options.configSha256 = parseDigest(args[++index]);
    } else throw invalidArgument(`Unknown option: ${argument}`);
  }
  if (options.configSha256 && !options.configPath) {
    throw invalidArgument("--config-sha256 requires --config.");
  }
  return options;
}

function parseArgs(args: string[]): CliOptions | "help" | "version" {
  if (args.includes("--help") || args.includes("-h")) return "help";
  if (args.includes("--version") || args.includes("-v")) return "version";
  const [command, ...rest] = args;
  if (command === "check") return parseCheckArgs(rest);
  if (command === "init") {
    if (rest.length > 0) throw invalidArgument(`Unknown option: ${rest[0]}`);
    return { command: "init" };
  }
  if (command === "validate-config") return parseValidateArgs(rest);
  if (command === "explain") {
    if (rest.length > 1)
      throw invalidArgument("explain accepts at most one rule ID.");
    return {
      command: "explain",
      ...(rest[0] === undefined ? {} : { ruleId: rest[0] }),
    };
  }
  throw invalidArgument(
    "Expected one of these commands: check, init, validate-config, explain.",
  );
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

function filePaths(
  file: ReturnType<typeof parseGitDiff>["files"][number],
): string[] {
  return [
    ...new Set(
      [file.oldPath, file.newPath, file.path].filter((path): path is string =>
        Boolean(path),
      ),
    ),
  ];
}

function dependencyManifestPaths(
  patch: ReturnType<typeof parseGitDiff>,
  excludePaths: string[],
): string[] {
  return [
    ...new Set(
      patch.files
        .filter((file) => !file.isNew && !file.isDeleted)
        .filter((file) => isDependencyManifest(file.path))
        .filter(
          (file) =>
            !filePaths(file).every((path) => matchesPath(path, excludePaths)),
        )
        .flatMap(filePaths)
        .filter(isDependencyManifest),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function applyFullManifestContext(
  patch: ReturnType<typeof parseGitDiff>,
  fullContext: ReturnType<typeof parseGitDiff>,
  requestedPaths: string[],
): ReturnType<typeof parseGitDiff> {
  const requested = new Set(requestedPaths);
  const files = patch.files.map((file) => {
    if (
      file.isNew ||
      file.isDeleted ||
      !filePaths(file).some((path) => requested.has(path))
    ) {
      return file;
    }
    const paths = new Set(filePaths(file));
    const replacement = fullContext.files.find((candidate) =>
      filePaths(candidate).some((path) => paths.has(path)),
    );
    if (!replacement) {
      throw new AgentGateError(
        "Git did not return complete context for a changed dependency manifest.",
        { code: "GIT_ERROR" },
      );
    }
    return replacement;
  });
  return { ...patch, files };
}

async function loadTrustedConfig(
  git: GitClient,
  cwd: string,
  root: string,
  options: CheckOptions,
  snapshot: GitSnapshot,
  constraints: CliExecutionConstraints,
) {
  if (options.configPath) {
    const path = isAbsolute(options.configPath)
      ? options.configPath
      : resolve(cwd, options.configPath);
    if ((await isInside(root, path)) && !options.configSha256) {
      throw new AgentGateError(
        "A policy inside the checked repository is mutable. Pass its expected --config-sha256, use an external protected --config, or use --policy-ref.",
        { code: "POLICY_ERROR" },
      );
    }
    return loadConfig(cwd, path, options.configSha256);
  }

  const commit = options.policyRef
    ? await git.resolveCommit(options.policyRef)
    : options.base
      ? snapshot.mergeBase
      : snapshot.head;
  if (
    constraints.expectedPolicyCommit &&
    commit?.toLowerCase() !== constraints.expectedPolicyCommit.toLowerCase()
  ) {
    throw new AgentGateError(
      "The resolved policy commit does not match the operator-pinned commit.",
      { code: "POLICY_ERROR" },
    );
  }
  if (!commit) return structuredClone(defaultConfig);
  const source = await git.readFileAt(commit, ".agentgate.yml");
  if (source === undefined) {
    if (options.policyRef) {
      throw new AgentGateError(
        `.agentgate.yml does not exist at policy ref ${options.policyRef}.`,
        { code: "POLICY_ERROR" },
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
  constraints: CliExecutionConstraints = {},
): Promise<number> {
  const errorFormat = requestedErrorFormat(args);
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
    if (options.command === "init") {
      io.stdout(await initializePolicy(cwd));
      return 0;
    }
    if (options.command === "validate-config") {
      io.stdout(
        await validatePolicy(cwd, {
          ...(options.configPath === undefined
            ? {}
            : { configPath: options.configPath }),
          ...(options.configSha256 === undefined
            ? {}
            : { configSha256: options.configSha256 }),
        }),
      );
      return 0;
    }
    if (options.command === "explain") {
      io.stdout(explainRules(options.ruleId));
      return 0;
    }
    const git = new GitClient(cwd);
    const root = await git.getRepositoryRoot();
    const snapshot = await git.captureSnapshot(options);
    if (
      constraints.expectedHead &&
      snapshot.head?.toLowerCase() !== constraints.expectedHead.toLowerCase()
    ) {
      throw new AgentGateError(
        "Repository HEAD does not match the operator-pinned commit.",
        { code: "SNAPSHOT_CHANGED" },
      );
    }
    if (
      constraints.expectedBaseCommit &&
      snapshot.baseCommit?.toLowerCase() !==
        constraints.expectedBaseCommit.toLowerCase()
    ) {
      throw new AgentGateError(
        "The resolved base does not match the operator-pinned commit.",
        { code: "SNAPSHOT_CHANGED" },
      );
    }
    const config = await loadTrustedConfig(
      git,
      cwd,
      root,
      options,
      snapshot,
      constraints,
    );
    git.configure(config.git);
    const sourcePatch = await git.getDiff(snapshot, config.untracked);
    let patch = parseGitDiff(sourcePatch);
    if (!options.configPath && changesDefaultPolicy(patch)) {
      throw new AgentGateError(
        "The checked diff changes .agentgate.yml. Review policy changes separately, or pin an explicit trusted policy with --config and --config-sha256.",
        { code: "POLICY_ERROR" },
      );
    }
    const manifestPaths =
      config.rules["dependency-added"] === "off"
        ? []
        : dependencyManifestPaths(
            patch,
            config.ruleExcludePaths["dependency-added"],
          );
    const fullManifestSource = await git.getFullContextDiff(
      snapshot,
      manifestPaths,
      Buffer.byteLength(sourcePatch),
    );
    if (manifestPaths.length > 0) {
      patch = applyFullManifestContext(
        patch,
        parseGitDiff(fullManifestSource),
        manifestPaths,
      );
    }
    const result = scan(patch, config);
    await git.assertSnapshotUnchanged(snapshot);
    await git.assertDiffUnchanged(snapshot, config.untracked, sourcePatch);
    await git.assertFullContextDiffUnchanged(
      snapshot,
      manifestPaths,
      fullManifestSource,
      Buffer.byteLength(sourcePatch),
    );
    io.stdout(formatReport(result, options.format));
    return result.blockingFindings > 0 ? 1 : 0;
  } catch (error) {
    const reported = toReportedError(error);
    if (errorFormat === "json") io.stdout(formatJsonError(reported));
    else if (errorFormat === "sarif") io.stdout(formatSarifError(reported));
    else io.stderr(formatTextError(reported));
    return 2;
  }
}
