import { describe, expect, it } from "vitest";
import { largeChangeRule } from "../src/rules/large-change.js";
import { addedFile, config } from "./fixtures.js";

describe("large-change", () => {
  it("summarizes every exceeded limit", () => {
    const findings = largeChangeRule.check({
      diff: addedFile("a.ts", ["one", "two"]),
      config: config({
        limits: { changedFiles: 0, addedLines: 1, deletedLines: 0 },
      }),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence).toContain("files");
    expect(findings[0]?.evidence).toContain("additions");
  });
});
