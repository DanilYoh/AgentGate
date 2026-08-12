import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { AgentGateError } from "../../src/errors.js";
import {
  formatJsonError,
  formatSarifError,
  formatTextError,
  toReportedError,
} from "../../src/reporters/error.js";
import { runCli } from "../../src/run-cli.js";
import type { CliExecutionConstraints, CliIo } from "../../src/run-cli.js";
import type { OutputFormat } from "../../src/reporters/index.js";

export interface ActionCore {
  getInput(name: string): string;
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
  info(message: string): void;
}

export interface ActionEnvironment {
  GITHUB_WORKSPACE?: string;
  RUNNER_TEMP?: string;
}

export type ActionCliRunner = (
  args: string[],
  cwd: string,
  io: CliIo,
  constraints: CliExecutionConstraints,
) => Promise<number>;

function requiredEnvironment(
  environment: ActionEnvironment,
  name: keyof ActionEnvironment,
): string {
  const value = environment[name];
  if (!value) {
    throw new AgentGateError(
      `${name} is required by the GitHub Action runner.`,
      {
        code: "IO_ERROR",
      },
    );
  }
  return value;
}

function requiredInput(core: ActionCore, name: string): string {
  const value = core.getInput(name).trim();
  if (!value) {
    throw new AgentGateError(`Action input '${name}' is required.`, {
      code: "INVALID_ARGUMENT",
    });
  }
  return value;
}

function immutableCommit(value: string, name: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(value)) {
    throw new AgentGateError(
      `Action input '${name}' must be a full 40- or 64-character hexadecimal commit ID.`,
      { code: "INVALID_ARGUMENT" },
    );
  }
  return value.toLowerCase();
}

function outputFormat(value: string): OutputFormat {
  if (value === "text" || value === "json" || value === "sarif") return value;
  throw new AgentGateError(
    "Action input 'format' must be one of: text, json, sarif.",
    { code: "INVALID_ARGUMENT" },
  );
}

function errorDocument(error: unknown, format: OutputFormat): string {
  const reported = toReportedError(error);
  if (format === "json") return formatJsonError(reported);
  if (format === "sarif") return formatSarifError(reported);
  return formatTextError(reported);
}

function reportExtension(format: OutputFormat): string {
  if (format === "sarif") return "sarif";
  if (format === "json") return "json";
  return "txt";
}

function isInside(root: string, path: string): boolean {
  const local = relative(root, path);
  return (
    local === "" ||
    (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local))
  );
}

export async function runAction(
  core: ActionCore,
  environment: ActionEnvironment = process.env,
  cli: ActionCliRunner = runCli,
): Promise<void> {
  let format: OutputFormat = "sarif";
  let reportDirectory: string | undefined;
  let reportPath: string | undefined;
  let report: string;
  let exitCode: number;

  try {
    const workspace = await realpath(
      requiredEnvironment(environment, "GITHUB_WORKSPACE"),
    );
    const runnerTemp = await realpath(
      requiredEnvironment(environment, "RUNNER_TEMP"),
    );
    if (isInside(workspace, runnerTemp)) {
      throw new AgentGateError(
        "RUNNER_TEMP must resolve outside the checked Git repository.",
        { code: "IO_ERROR" },
      );
    }
    reportDirectory = await mkdtemp(join(runnerTemp, "agentgate-"));

    const requestedFormat = core.getInput("format").trim() || "sarif";
    format = outputFormat(requestedFormat);
    const head = immutableCommit(requiredInput(core, "head-sha"), "head-sha");
    const base = immutableCommit(requiredInput(core, "base-sha"), "base-sha");
    const policy = immutableCommit(
      requiredInput(core, "policy-sha"),
      "policy-sha",
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    exitCode = await cli(
      ["check", "--base", base, "--policy-ref", policy, "--format", format],
      workspace,
      {
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      },
      {
        expectedHead: head,
        expectedBaseCommit: base,
        expectedPolicyCommit: policy,
      },
    );
    if (exitCode !== 0 && exitCode !== 1 && exitCode !== 2) {
      throw new AgentGateError(
        "AgentGate returned an unsupported process exit code.",
        { code: "INTERNAL_ERROR" },
      );
    }
    report = (format === "text" && exitCode === 2 ? stderr : stdout).join("\n");
    if (!report) {
      throw new AgentGateError("AgentGate produced an empty Action report.", {
        code: "INTERNAL_ERROR",
      });
    }
  } catch (error) {
    exitCode = 2;
    report = errorDocument(error, format);
  }

  try {
    if (!reportDirectory) {
      throw new AgentGateError(
        "The GitHub Action could not create its protected report directory.",
        { code: "IO_ERROR" },
      );
    }
    reportPath = resolve(reportDirectory, `report.${reportExtension(format)}`);
    await writeFile(reportPath, `${report}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    core.setOutput("report-path", reportPath);
  } catch {
    exitCode = 2;
    reportPath = undefined;
  }

  core.setOutput("exit-code", String(exitCode));
  if (exitCode === 0) {
    core.info(
      `AgentGate completed successfully. Report: ${String(reportPath)}`,
    );
  } else if (exitCode === 1) {
    core.setFailed(
      "AgentGate found blocking changes (exit code 1). See report-path.",
    );
  } else {
    core.setFailed(
      `AgentGate failed closed (exit code 2).${reportPath ? " See report-path." : " No report could be persisted."}`,
    );
  }
}
