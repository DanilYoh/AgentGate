import { describe, expect, it } from "vitest";
import { scopeViolationRule } from "../src/rules/scope-violation.js";
import { addedFile, config } from "./fixtures.js";

describe("scope-violation", () => {
  it("enforces allowed and denied globs", () => {
    const policy = config({
      allowedPaths: ["src/**"],
      deniedPaths: ["src/admin/**"],
    });
    expect(
      scopeViolationRule.check({
        diff: addedFile("src/app.ts", ["ok"]),
        config: policy,
      }),
    ).toEqual([]);
    expect(
      scopeViolationRule.check({
        diff: addedFile("src/admin/a.ts", ["no"]),
        config: policy,
      }),
    ).toHaveLength(1);
    expect(
      scopeViolationRule.check({
        diff: addedFile("docs/a.md", ["no"]),
        config: policy,
      }),
    ).toHaveLength(1);
  });

  it("checks both sides of a rename", () => {
    const diff = addedFile("src/new.ts", ["ok"]);
    const file = diff.files[0];
    if (!file) throw new Error("fixture did not produce a file");
    file.isNew = false;
    file.oldPath = "secure/old.ts";
    file.newPath = "src/new.ts";
    const findings = scopeViolationRule.check({
      diff,
      config: config({ deniedPaths: ["secure/**"] }),
    });
    expect(findings.map((item) => item.file)).toEqual(["secure/old.ts"]);
  });

  it("does not treat a literal Unix backslash as a path separator", () => {
    const policy = config({ deniedPaths: ["src/admin/**"] });
    expect(
      scopeViolationRule.check({
        diff: addedFile("src\\admin/file.ts", ["ok"]),
        config: policy,
      }),
    ).toEqual([]);
  });
});
