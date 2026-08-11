import { describe, expect, it } from "vitest";
import { dependencyAddedRule } from "../src/rules/dependency-added.js";
import { addedFile, config } from "./fixtures.js";

describe("dependency-added", () => {
  it.each([
    ["package.json", ['  "dependencies": {', '    "yaml": "^2.8.1"', "  }"]],
    ["requirements.txt", ["requests==2.32.4"]],
    ["requirements.txt", ["requests"]],
    ["pyproject.toml", ['dependencies = ["httpx>=0.28"]']],
    ["pyproject.toml", ['dependencies = ["httpx"]']],
    [
      "pyproject.toml",
      [
        "[tool.poetry.dependencies]",
        'httpx = { version = "^0.28", optional = true }',
      ],
    ],
  ])("finds a dependency in %s", (path, lines) => {
    const findings = dependencyAddedRule.check({
      diff: addedFile(path, lines),
      config: config(),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("New dependency");
  });

  it("does not treat unrelated pyproject settings as dependencies", () => {
    const diff = addedFile("pyproject.toml", [
      "[tool.ruff]",
      'target-version = "py311"',
    ]);
    expect(dependencyAddedRule.check({ diff, config: config() })).toEqual([]);
  });

  it("finds multiple inline pyproject dependencies", () => {
    const diff = addedFile("pyproject.toml", [
      'dependencies = ["httpx", "rich>=13"]',
    ]);
    expect(dependencyAddedRule.check({ diff, config: config() })).toHaveLength(
      2,
    );
  });

  it("does not report a version update as a newly added dependency", () => {
    const diff = {
      files: [
        {
          path: "requirements.txt",
          isNew: false,
          isDeleted: false,
          isBinary: false,
          lines: [
            {
              content: "requests==2.31.0",
              oldLine: 1,
              kind: "delete" as const,
            },
            { content: "requests==2.32.4", newLine: 1, kind: "add" as const },
          ],
          additions: [
            { content: "requests==2.32.4", newLine: 1, kind: "add" as const },
          ],
          deletions: [
            {
              content: "requests==2.31.0",
              oldLine: 1,
              kind: "delete" as const,
            },
          ],
        },
      ],
      changedFiles: 1,
      addedLines: 1,
      deletedLines: 1,
    };
    expect(dependencyAddedRule.check({ diff, config: config() })).toEqual([]);
  });

  it("does not report package metadata or engine versions", () => {
    const diff = addedFile("package.json", [
      "{",
      '  "homepage": "https://example.invalid/project",',
      '  "scripts": {',
      '    "release": "1"',
      "  },",
      '  "engines": {',
      '    "deno": ">=1"',
      "  }",
      "}",
    ]);
    expect(dependencyAddedRule.check({ diff, config: config() })).toEqual([]);
  });

  it("resets pyproject section state between hunks", () => {
    const diff = addedFile("pyproject.toml", [
      "[tool.poetry.dependencies]",
      'requests = "^2"',
      "[tool.ruff]",
      'target-version = "py311"',
    ]);
    diff.files[0]?.lines.slice(2).forEach((line) => {
      line.hunk = 2;
    });
    expect(dependencyAddedRule.check({ diff, config: config() })).toHaveLength(
      1,
    );
  });
});
