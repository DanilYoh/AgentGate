import { describe, expect, it } from "vitest";
import { testDisabledRule } from "../src/rules/test-disabled.js";
import { addedFile, config } from "./fixtures.js";

describe("test-disabled", () => {
  it.each([
    "it.skip('works', () => {})",
    "test.skip.each(cases)('works', () => {})",
    "xit('works', () => {})",
    "@pytest.mark.skip",
    "@unittest.skipIf(condition, 'reason')",
    "@Disabled",
  ])("finds %s", (source) => {
    expect(
      testDisabledRule.check({
        diff: addedFile("tests/a.ts", [source]),
        config: config(),
      }),
    ).toHaveLength(1);
  });

  it("ignores documentation examples", () => {
    expect(
      testDisabledRule.check({
        diff: addedFile("docs/testing.md", ["Example: test.skip('reason')"]),
        config: config(),
      }),
    ).toEqual([]);
  });
});
