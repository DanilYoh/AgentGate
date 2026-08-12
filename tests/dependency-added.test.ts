import { describe, expect, it } from "vitest";
import { parseGitDiff } from "../src/git/diff-parser.js";
import { dependencyAddedRule } from "../src/rules/dependency-added.js";
import { addedFile, config } from "./fixtures.js";

function changedManifest(path: string, before: string[], after: string[]) {
  return parseGitDiff(`diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1,${before.length} +1,${after.length} @@
${before.map((line) => `-${line}`).join("\n")}
${after.map((line) => `+${line}`).join("\n")}
`);
}

describe("dependency-added", () => {
  it.each([
    ["package.json", ['  "dependencies": {', '    "yaml": "^2.8.1"', "  }"]],
    ["requirements.txt", ["requests==2.32.4"]],
    ["requirements.txt", ["requests"]],
    ["pyproject.toml", ["[project]", 'dependencies = ["httpx>=0.28"]']],
    ["pyproject.toml", ["[project]", 'dependencies = ["httpx"]']],
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
    expect(findings[0]?.message).toContain("dependency declaration");
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
      "[project]",
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

  it.each([
    ["requirements-dev.txt", ["Requests[security]>=2"], "Requests[security]"],
    [
      "composer.json",
      ['{"require":{"vendor/package":"^1.0"}}'],
      "vendor/package",
    ],
    [
      "go.mod",
      ["module example.invalid/app", "", "require example.invalid/lib v1.2.3"],
      "example.invalid/lib",
    ],
    [
      "go.mod",
      [
        "module example.invalid/app",
        "require (",
        "  example.invalid/other v2.0.0",
        ")",
      ],
      "example.invalid/other",
    ],
    [
      "Cargo.toml",
      ["[dependencies]", 'serde = { version = "1", features = ["derive"] }'],
      "serde",
    ],
    [
      "Gemfile",
      ["source 'https://rubygems.org'", "gem 'rack', '~> 3.0'"],
      "rack",
    ],
  ])("finds a declaration in %s", (path, lines, expectedName) => {
    const findings = dependencyAddedRule.check({
      diff: addedFile(path, lines),
      config: config(),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(expectedName);
  });

  it("normalizes Python project names when comparing declarations", () => {
    const diff = changedManifest(
      "requirements-dev.txt",
      ["zope_interface==6.0"],
      ["zope-interface==7.0"],
    );
    expect(dependencyAddedRule.check({ diff, config: config() })).toEqual([]);
  });

  it("ignores requirement includes and index options", () => {
    const diff = addedFile("requirements-dev.in", [
      "-r base.txt",
      "--index-url https://example.invalid/simple",
    ]);
    expect(dependencyAddedRule.check({ diff, config: config() })).toEqual([]);
  });

  it("does not interpret unrelated dependency-shaped settings", () => {
    const manifests = [
      addedFile("package.json", [
        "{",
        '  "overrides": { "transitive": "2.0.0" }',
        "}",
      ]),
      addedFile("composer.json", [
        "{",
        '  "replace": { "vendor/package": "*" },',
        '  "config": { "platform": { "php": "8.4" } }',
        "}",
      ]),
      addedFile("pyproject.toml", [
        "[tool.ruff]",
        'dependencies = ["not-a-project-dependency"]',
      ]),
      addedFile("go.mod", [
        "module example.invalid/app",
        "replace example.invalid/lib => ../lib",
      ]),
      addedFile("Cargo.toml", [
        "[package.metadata.dependencies]",
        'not-a-crate = "1"',
      ]),
      addedFile("Gemfile", ["ruby '3.4.0'", "gemspec"]),
    ];
    for (const diff of manifests) {
      expect(dependencyAddedRule.check({ diff, config: config() })).toEqual([]);
    }
  });

  it("does not treat dependency-group includes as packages", () => {
    const diff = addedFile("pyproject.toml", [
      "[dependency-groups]",
      'test = [{ include-group = "lint" }, "pytest>=8"]',
    ]);
    const findings = dependencyAddedRule.check({ diff, config: config() });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("pytest");
  });

  it("does not report reorder, version updates, or section moves", () => {
    const before = [
      "{",
      '  "dependencies": { "alpha": "1", "beta": "1" },',
      '  "devDependencies": { "test-only": "1" }',
      "}",
    ];
    const after = [
      "{",
      '  "dependencies": { "beta": "2", "test-only": "1", "alpha": "1" }',
      "}",
    ];
    const diff = changedManifest("package.json", before, after);
    expect(dependencyAddedRule.check({ diff, config: config() })).toEqual([]);
  });
});
