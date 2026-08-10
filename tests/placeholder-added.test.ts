import { describe, expect, it } from "vitest";
import { placeholderAddedRule } from "../src/rules/placeholder-added.js";
import { addedFile, config } from "./fixtures.js";

describe("placeholder-added", () => {
  it.each([
    "// TODO: finish",
    "raise NotImplementedError()",
    "unimplemented!()",
  ])("finds %s", (source) => {
    expect(
      placeholderAddedRule.check({
        diff: addedFile("src/a.rs", [source]),
        config: config(),
      }),
    ).toHaveLength(1);
  });
});
