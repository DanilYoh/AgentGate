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
});
