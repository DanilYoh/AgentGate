import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/load.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(
  readFileSync(
    resolve(projectRoot, "schemas", "agentgate-v1.schema.json"),
    "utf8",
  ),
) as object;
const validateSchema = new Ajv2020({ allErrors: true }).compile(schema);

const validPolicies: unknown[] = [
  { version: 1 },
  {
    version: 1,
    failOn: "critical",
    allowedPaths: [],
    deniedPaths: [".github/**"],
    limits: {
      changedFiles: Number.MAX_SAFE_INTEGER,
      addedLines: 0,
      deletedLines: 42,
    },
    git: { commandTimeoutMs: 120_000, maxDiffBytes: 268_435_456 },
    untracked: {
      maxFiles: 100_000,
      maxFileBytes: 16_777_216,
      maxSymlinkBytes: 65_536,
      maxTotalBytes: 67_108_864,
      readTimeoutMs: 60_000,
    },
    rules: {
      "secret-added": "error",
      "test-disabled": "off",
      "placeholder-added": {
        level: "warning",
        excludePaths: ["fixtures/**"],
      },
      "dependency-added": {},
      "sensitive-file-changed": "info",
      "scope-violation": "low",
      "large-change": "medium",
    },
    suppressions: [
      {
        ruleId: "placeholder-added",
        path: "src/generated.ts",
        line: Number.MAX_SAFE_INTEGER,
        reason: "Generated source",
      },
    ],
  },
];

const invalidPolicies: unknown[] = [
  {},
  { version: 2 },
  { version: 1, unknown: true },
  { version: 1, failOn: "error" },
  { version: 1, allowedPaths: [""] },
  { version: 1, limits: { addedLines: -1 } },
  { version: 1, limits: { changedFiles: 1.5 } },
  { version: 1, git: { commandTimeoutMs: 0 } },
  { version: 1, git: { maxDiffBytes: 268_435_457 } },
  { version: 1, untracked: { maxFiles: 100_001 } },
  { version: 1, untracked: { maxSymlinkBytes: 0 } },
  { version: 1, rules: { mystery: "high" } },
  { version: 1, rules: { "secret-added": "fatal" } },
  {
    version: 1,
    rules: { "secret-added": { level: "high", unexpected: true } },
  },
  {
    version: 1,
    suppressions: [{ ruleId: "secret-added", path: "src/a.ts", reason: "" }],
  },
  {
    version: 1,
    suppressions: [
      {
        ruleId: "secret-added",
        path: "src/a.ts",
        reason: "False positive",
        line: 0,
      },
    ],
  },
];

function runtimeAccepts(policy: unknown): boolean {
  try {
    validateConfig(policy);
    return true;
  } catch {
    return false;
  }
}

describe("published policy schema", () => {
  it.each(validPolicies)("accepts a runtime-valid policy %#", (policy) => {
    expect(runtimeAccepts(policy)).toBe(true);
    expect(validateSchema(policy), JSON.stringify(validateSchema.errors)).toBe(
      true,
    );
  });

  it.each(invalidPolicies)("rejects a runtime-invalid policy %#", (policy) => {
    expect(runtimeAccepts(policy)).toBe(false);
    expect(validateSchema(policy)).toBe(false);
  });
});
