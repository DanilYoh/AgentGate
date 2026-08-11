import { describe, expect, it } from "vitest";
import { sensitiveFileChangedRule } from "../src/rules/sensitive-file-changed.js";
import { addedFile, config } from "./fixtures.js";

describe("sensitive-file-changed", () => {
  it.each([
    ".agentgate.yml",
    ".github/workflows/ci.yml",
    "Dockerfile",
    "db/migrations/001.sql",
    "pnpm-lock.yaml",
  ])("finds %s", (path) => {
    expect(
      sensitiveFileChangedRule.check({
        diff: addedFile(path, ["change"]),
        config: config(),
      }),
    ).toHaveLength(1);
  });

  it("finds a rename out of a sensitive path", () => {
    const diff = addedFile("docs/ci.yml", ["name: CI"]);
    const file = diff.files[0];
    if (!file) throw new Error("fixture did not produce a file");
    file.isNew = false;
    file.oldPath = ".github/workflows/ci.yml";
    file.newPath = "docs/ci.yml";
    const findings = sensitiveFileChangedRule.check({ diff, config: config() });
    expect(findings[0]?.file).toBe(".github/workflows/ci.yml");
  });
});
