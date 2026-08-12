import { describe, expect, it } from "vitest";
import { scan } from "../src/engine.js";
import { placeholderAddedRule } from "../src/rules/placeholder-added.js";
import { addedFile, config } from "./fixtures.js";

describe("scan thresholds", () => {
  it("reports a finding below failOn without blocking", () => {
    const result = scan(addedFile("src/a.ts", ["// TODO: finish"]), config(), [
      placeholderAddedRule,
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe("medium");
    expect(result.blockingFindings).toBe(0);
  });

  it("supports disabling a rule", () => {
    const result = scan(
      addedFile("src/a.ts", ["// TODO: finish"]),
      config({ rules: { "placeholder-added": "off" } }),
      [placeholderAddedRule],
    );
    expect(result.findings).toEqual([]);
  });

  it("applies per-rule excludes without hiding the file from the summary", () => {
    const result = scan(
      addedFile("tests/fixture.ts", ["// TODO: fixture marker"]),
      config({
        ruleExcludePaths: { "placeholder-added": ["tests/**"] },
      }),
      [placeholderAddedRule],
    );
    expect(result.findings).toEqual([]);
    expect(result.summary.changedFiles).toBe(1);
  });

  it("does not let a rename escape a rule exclusion", () => {
    const diff = addedFile("src/runtime.ts", ["// TODO: production stub"]);
    const file = diff.files[0];
    if (!file) throw new Error("fixture did not produce a file");
    file.oldPath = "tests/fixtures/runtime.ts";
    file.newPath = "src/runtime.ts";

    const result = scan(
      diff,
      config({
        ruleExcludePaths: { "placeholder-added": ["tests/fixtures/**"] },
      }),
      [placeholderAddedRule],
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.file).toBe("src/runtime.ts");
  });

  it("excludes a rename only when every path is excluded", () => {
    const diff = addedFile("tests/fixtures/new.ts", ["// TODO: fixture"]);
    const file = diff.files[0];
    if (!file) throw new Error("fixture did not produce a file");
    file.oldPath = "tests/fixtures/old.ts";
    file.newPath = "tests/fixtures/new.ts";

    const result = scan(
      diff,
      config({
        ruleExcludePaths: { "placeholder-added": ["tests/fixtures/**"] },
      }),
      [placeholderAddedRule],
    );

    expect(result.findings).toEqual([]);
  });

  it("tracks policy suppressions separately from active findings", () => {
    const result = scan(
      addedFile("src/generated.ts", ["// TODO: generated stub"]),
      config({
        suppressions: [
          {
            ruleId: "placeholder-added",
            path: "src/generated.ts",
            line: 1,
            reason: "Generated compatibility stub",
          },
        ],
      }),
      [placeholderAddedRule],
    );
    expect(result.findings).toEqual([]);
    expect(result.suppressedFindings).toHaveLength(1);
    expect(result.suppressedFindings[0]?.suppression).toEqual({
      reason: "Generated compatibility stub",
      source: { kind: "policy", location: "suppressions[0]" },
    });
    expect(result.summary.suppressedFindings).toBe(1);
  });

  it("records the first matching suppression deterministically", () => {
    const result = scan(
      addedFile("src/generated.ts", ["// TODO: generated stub"]),
      config({
        suppressions: [
          {
            ruleId: "placeholder-added",
            path: "src/**",
            reason: "Approved generated sources",
          },
          {
            ruleId: "placeholder-added",
            path: "src/generated.ts",
            reason: "Second matching entry",
          },
        ],
      }),
      [placeholderAddedRule],
    );

    expect(result.suppressedFindings[0]?.suppression).toEqual({
      reason: "Approved generated sources",
      source: { kind: "policy", location: "suppressions[0]" },
    });
  });
});
