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
    expect(result.summary.suppressedFindings).toBe(1);
  });
});
