import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

function capture(): {
  stdout: string[];
  stderr: string[];
  io: { stdout(value: string): void; stderr(value: string): void };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
  };
}

describe("CLI argument handling", () => {
  it("returns 0 for help without requiring a repository", async () => {
    const output = capture();
    expect(await runCli(["--help"], process.cwd(), output.io)).toBe(0);
    expect(output.stdout[0]).toContain("Usage: agentgate <command>");
  });

  it("supports the short help flag", async () => {
    const output = capture();
    expect(await runCli(["-h"], process.cwd(), output.io)).toBe(0);
    expect(output.stdout[0]).toContain("Usage:");
  });

  it("returns 0 for version", async () => {
    const output = capture();
    expect(await runCli(["--version"], process.cwd(), output.io)).toBe(0);
    expect(output.stdout).toEqual(["1.0.0"]);
  });

  it("supports the short version flag", async () => {
    const output = capture();
    expect(await runCli(["-v"], process.cwd(), output.io)).toBe(0);
    expect(output.stdout).toEqual(["1.0.0"]);
  });

  it.each([
    [[], "Expected one of these commands"],
    [["unknown"], "Expected one of these commands"],
    [["check", "--unknown"], "Unknown option: --unknown"],
    [["check", "--base"], "--base requires a Git ref"],
    [["check", "--staged", "--base", "HEAD"], "cannot be used together"],
    [["check", "--format", "xml"], "--format must be one of"],
    [["check", "--config"], "--config requires a path"],
    [["check", "--policy-ref"], "--policy-ref requires a Git ref"],
    [["check", "--config-sha256", "abc"], "64-character"],
    [["check", "--config-sha256", "a".repeat(64)], "requires --config"],
    [
      ["check", "--config", "policy.yml", "--policy-ref", "main"],
      "cannot be used together",
    ],
  ])("returns 2 for invalid arguments %#", async (args, message) => {
    const output = capture();
    expect(await runCli(args, process.cwd(), output.io)).toBe(2);
    expect(output.stderr[0]).toContain(message);
  });

  it("returns structured JSON for an argument error when requested", async () => {
    const output = capture();
    expect(
      await runCli(
        ["check", "--format", "json", "--staged", "--base", "HEAD"],
        process.cwd(),
        output.io,
      ),
    ).toBe(2);
    expect(output.stderr).toEqual([]);
    expect(JSON.parse(output.stdout[0] ?? "")).toMatchObject({
      status: "error",
      exitCode: 2,
      error: { code: "INVALID_ARGUMENT" },
    });
  });

  it("returns failed SARIF for an argument error when requested", async () => {
    const output = capture();
    expect(
      await runCli(["unknown", "--format", "sarif"], process.cwd(), output.io),
    ).toBe(2);
    expect(output.stderr).toEqual([]);
    const report = JSON.parse(output.stdout[0] ?? "") as {
      runs: Array<{
        invocations: Array<{ executionSuccessful: boolean; exitCode: number }>;
      }>;
    };
    expect(report.runs[0]?.invocations[0]).toEqual(
      expect.objectContaining({ executionSuccessful: false, exitCode: 2 }),
    );
  });

  it("keeps an invalid format error on stderr", async () => {
    const output = capture();
    expect(
      await runCli(
        ["check", "--format", "json", "--format", "xml"],
        process.cwd(),
        output.io,
      ),
    ).toBe(2);
    expect(output.stdout).toEqual([]);
    expect(output.stderr[0]).toContain("--format must be one of");
  });
});
