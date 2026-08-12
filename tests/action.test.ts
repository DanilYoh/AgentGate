import { readFile, rm, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  runAction,
  type ActionCliRunner,
  type ActionCore,
  type ActionEnvironment,
} from "../action/src/action.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const policySha = "c".repeat(40);
const temporaryDirectories: string[] = [];

class TestCore implements ActionCore {
  readonly outputs = new Map<string, string>();
  readonly failures: string[] = [];
  readonly informationalMessages: string[] = [];

  constructor(private readonly inputs: Readonly<Record<string, string>>) {}

  getInput(name: string): string {
    return this.inputs[name] ?? "";
  }

  setOutput(name: string, value: string): void {
    this.outputs.set(name, value);
  }

  setFailed(message: string): void {
    this.failures.push(message);
  }

  info(message: string): void {
    this.informationalMessages.push(message);
  }
}

async function actionEnvironment(): Promise<{
  environment: ActionEnvironment;
  workspace: string;
  runnerTemp: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agentgate-action-test-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const runnerTemp = join(root, "runner-temp");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(runnerTemp, { recursive: true }),
  ]);
  return {
    environment: {
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: runnerTemp,
    },
    workspace,
    runnerTemp,
  };
}

function isWithin(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent !== "" &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("GitHub Action wrapper", () => {
  it("runs the pinned scan and writes a successful report under RUNNER_TEMP", async () => {
    const { environment, workspace, runnerTemp } = await actionEnvironment();
    const core = new TestCore({
      "head-sha": headSha.toUpperCase(),
      "base-sha": baseSha,
      "policy-sha": policySha,
    });
    const report = JSON.stringify({ version: "2.1.0", runs: [] });
    let invocation:
      | {
          args: string[];
          cwd: string;
          constraints: Parameters<ActionCliRunner>[3];
        }
      | undefined;
    const cli: ActionCliRunner = (args, cwd, io, constraints) => {
      invocation = { args, cwd, constraints };
      io.stdout(report);
      return Promise.resolve(0);
    };

    await runAction(core, environment, cli);

    expect(invocation).toEqual({
      args: [
        "check",
        "--base",
        baseSha,
        "--policy-ref",
        policySha,
        "--format",
        "sarif",
      ],
      cwd: await realpath(workspace),
      constraints: {
        expectedHead: headSha,
        expectedBaseCommit: baseSha,
        expectedPolicyCommit: policySha,
      },
    });
    expect(core.outputs.get("exit-code")).toBe("0");
    expect(core.failures).toEqual([]);
    expect(core.informationalMessages).toHaveLength(1);

    const reportPath = core.outputs.get("report-path");
    expect(reportPath).toBeDefined();
    expect(isWithin(await realpath(runnerTemp), reportPath ?? "")).toBe(true);
    expect(isWithin(await realpath(workspace), reportPath ?? "")).toBe(false);
    await expect(readFile(reportPath ?? "", "utf8")).resolves.toBe(
      `${report}\n`,
    );
  });

  it("fails closed with a structured report for a mutable head input", async () => {
    const { environment, runnerTemp } = await actionEnvironment();
    const core = new TestCore({
      "head-sha": "main",
      "base-sha": baseSha,
      "policy-sha": policySha,
    });
    let invoked = false;
    const cli: ActionCliRunner = () => {
      invoked = true;
      return Promise.resolve(0);
    };

    await runAction(core, environment, cli);

    expect(invoked).toBe(false);
    expect(core.outputs.get("exit-code")).toBe("2");
    expect(core.failures).toEqual([
      "AgentGate failed closed (exit code 2). See report-path.",
    ]);
    const reportPath = core.outputs.get("report-path");
    expect(reportPath).toBeDefined();
    expect(isWithin(await realpath(runnerTemp), reportPath ?? "")).toBe(true);
    const report = JSON.parse(await readFile(reportPath ?? "", "utf8")) as {
      runs: Array<{
        invocations: Array<{
          executionSuccessful: boolean;
          exitCode: number;
          toolExecutionNotifications: Array<{
            descriptor: { id: string };
          }>;
        }>;
      }>;
    };
    expect(report.runs[0]?.invocations[0]).toMatchObject({
      executionSuccessful: false,
      exitCode: 2,
    });
    expect(
      report.runs[0]?.invocations[0]?.toolExecutionNotifications[0]?.descriptor
        .id,
    ).toBe("INVALID_ARGUMENT");
  });

  it("refuses to place RUNNER_TEMP inside the checked repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentgate-action-test-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const runnerTemp = join(workspace, "runner-temp");
    await mkdir(runnerTemp, { recursive: true });
    const core = new TestCore({
      "head-sha": headSha,
      "base-sha": baseSha,
      "policy-sha": policySha,
    });
    let invoked = false;
    const cli: ActionCliRunner = () => {
      invoked = true;
      return Promise.resolve(0);
    };

    await runAction(
      core,
      { GITHUB_WORKSPACE: workspace, RUNNER_TEMP: runnerTemp },
      cli,
    );

    expect(invoked).toBe(false);
    expect(core.outputs.get("exit-code")).toBe("2");
    expect(core.outputs.has("report-path")).toBe(false);
    expect(core.failures).toEqual([
      "AgentGate failed closed (exit code 2). No report could be persisted.",
    ]);
  });

  it("marks the Action failed and preserves the report for CLI exit 1", async () => {
    const { environment } = await actionEnvironment();
    const core = new TestCore({
      "head-sha": headSha,
      "base-sha": baseSha,
      "policy-sha": policySha,
      format: "json",
    });
    const report = JSON.stringify({
      version: 1,
      findings: [{ blocking: true }],
    });
    const cli: ActionCliRunner = (_args, _cwd, io) => {
      io.stdout(report);
      return Promise.resolve(1);
    };

    await runAction(core, environment, cli);

    expect(core.outputs.get("exit-code")).toBe("1");
    expect(core.failures).toEqual([
      "AgentGate found blocking changes (exit code 1). See report-path.",
    ]);
    expect(core.informationalMessages).toEqual([]);
    const reportPath = core.outputs.get("report-path");
    expect(reportPath).toMatch(/report\.json$/u);
    await expect(readFile(reportPath ?? "", "utf8")).resolves.toBe(
      `${report}\n`,
    );
  });
});

describe("GitHub Action manifest", () => {
  it("uses Node 24 and requires every immutable commit input", async () => {
    const document = parseDocument(
      await readFile(resolve(projectRoot, "action.yml"), "utf8"),
    );
    expect(document.errors).toEqual([]);
    const manifest = document.toJS() as {
      inputs: Record<string, { required?: boolean; default?: string }>;
      runs: { using?: string; main?: string };
    };

    expect(manifest.runs).toEqual({
      using: "node24",
      main: "action/dist/index.js",
    });
    for (const input of ["head-sha", "base-sha", "policy-sha"]) {
      expect(manifest.inputs[input]?.required).toBe(true);
    }
    expect(manifest.inputs.format).toMatchObject({
      required: false,
      default: "sarif",
    });
  });
});
