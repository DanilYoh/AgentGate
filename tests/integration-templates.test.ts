import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hooks = resolve(projectRoot, "examples", "hooks");

describe("hook templates", () => {
  const templates = [
    "husky-pre-commit",
    "lefthook.yml",
    "pre-commit-config.yaml",
  ];

  it.each(templates)(
    "runs the controlled offline staged check in %s",
    (name) => {
      const source = readFileSync(resolve(hooks, name), "utf8");
      expect(source).toContain(
        "npm exec --offline -- agentgate check --staged",
      );
    },
  );

  it.each(["lefthook.yml", "pre-commit-config.yaml"])(
    "contains valid YAML in %s",
    (name) => {
      const document = parseDocument(
        readFileSync(resolve(hooks, name), "utf8"),
      );
      expect(document.errors).toEqual([]);
    },
  );

  it("pre-commit does not pass filenames and always runs", () => {
    const source = readFileSync(
      resolve(hooks, "pre-commit-config.yaml"),
      "utf8",
    );
    expect(source).toContain("pass_filenames: false");
    expect(source).toContain("always_run: true");
    expect(source).toContain("language: system");
  });

  it.runIf(process.platform !== "win32")(
    "ships an executable, syntactically valid Husky script",
    () => {
      const path = resolve(hooks, "husky-pre-commit");
      expect(statSync(path).mode & 0o111).not.toBe(0);
      expect(() => execFileSync("sh", ["-n", path])).not.toThrow();
    },
  );
});
