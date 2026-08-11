import { describe, expect, it } from "vitest";
import { AgentGateError } from "../src/errors.js";
import { validateConfig } from "../src/config/load.js";

describe("configuration", () => {
  it("maps documented error and warning levels", () => {
    const config = validateConfig({
      version: 1,
      failOn: "high",
      rules: { "secret-added": "error", "placeholder-added": "warning" },
    });
    expect(config.rules["secret-added"]).toBe("high");
    expect(config.rules["placeholder-added"]).toBe("medium");
  });

  it("reports an actionable validation path", () => {
    expect(() =>
      validateConfig({ version: 1, limits: { addedLines: -1 } }),
    ).toThrowError(
      new AgentGateError("limits.addedLines must be a non-negative integer."),
    );
  });

  it("rejects unknown rules", () => {
    expect(() =>
      validateConfig({ version: 1, rules: { mystery: "error" } }),
    ).toThrow("rules contains unknown key 'mystery'");
  });

  it("accepts rule-level path exclusions and audited suppressions", () => {
    const config = validateConfig({
      version: 1,
      rules: {
        "secret-added": {
          level: "error",
          excludePaths: ["tests/fixtures/**"],
        },
      },
      suppressions: [
        {
          ruleId: "placeholder-added",
          path: "src/generated.ts",
          line: 12,
          reason: "Generated compatibility stub",
        },
      ],
      untracked: {
        maxFileBytes: 4096,
        maxTotalBytes: 8192,
        readTimeoutMs: 500,
      },
    });

    expect(config.rules["secret-added"]).toBe("high");
    expect(config.ruleExcludePaths["secret-added"]).toEqual([
      "tests/fixtures/**",
    ]);
    expect(config.suppressions[0]).toMatchObject({
      ruleId: "placeholder-added",
      line: 12,
    });
    expect(config.untracked).toEqual({
      maxFileBytes: 4096,
      maxTotalBytes: 8192,
      readTimeoutMs: 500,
    });
  });

  it("rejects unsafe untracked limits and incomplete suppressions", () => {
    expect(() =>
      validateConfig({ version: 1, untracked: { maxFileBytes: 0 } }),
    ).toThrow("untracked.maxFileBytes must be an integer between 1");
    expect(() =>
      validateConfig({
        version: 1,
        suppressions: [{ ruleId: "secret-added", path: "test.ts" }],
      }),
    ).toThrow("suppressions[0].reason");
  });
});
