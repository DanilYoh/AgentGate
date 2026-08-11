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
    expect(output.stdout[0]).toContain("Usage: agentgate check");
  });

  it("returns 0 for version", async () => {
    const output = capture();
    expect(await runCli(["--version"], process.cwd(), output.io)).toBe(0);
    expect(output.stdout).toEqual(["0.1.0"]);
  });

  it.each([
    [[], "Expected the `check` command"],
    [["unknown"], "Expected the `check` command"],
    [["check", "--staged", "--base", "HEAD"], "cannot be used together"],
    [["check", "--format", "xml"], "--format must be one of"],
    [["check", "--config"], "--config requires a path"],
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
});
