import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseDocument } from "yaml";
import { defaultConfig } from "./defaults.js";
import { AgentGateError } from "../errors.js";
import { severityOrder } from "../types.js";
import type {
  AgentGateConfig,
  FindingSuppression,
  RuleId,
  RuleLevel,
  Severity,
} from "../types.js";

const ruleIds = Object.keys(defaultConfig.rules) as RuleId[];
const rootKeys = new Set([
  "version",
  "failOn",
  "allowedPaths",
  "deniedPaths",
  "limits",
  "rules",
  "suppressions",
  "git",
  "untracked",
]);
const limitNames = ["changedFiles", "addedLines", "deletedLines"] as const;
const limitKeys = new Set<string>(limitNames);
const ruleKeys = new Set(["level", "excludePaths"]);
const suppressionKeys = new Set(["ruleId", "path", "line", "reason"]);
const gitKeys = new Set(["commandTimeoutMs", "maxDiffBytes"]);
const untrackedKeys = new Set([
  "maxFiles",
  "maxFileBytes",
  "maxSymlinkBytes",
  "maxTotalBytes",
  "readTimeoutMs",
]);
const maximumConfigBytes = 1024 * 1024;

function invalidConfig(
  message: string,
  options?: ErrorOptions,
): AgentGateError {
  return new AgentGateError(message, { ...options, code: "INVALID_CONFIG" });
}

function objectAt(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidConfig(`${location} must be a mapping.`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
  location: string,
): void {
  for (const key of Object.keys(value)) {
    if (!keys.has(key))
      throw invalidConfig(`${location} contains unknown key '${key}'.`);
  }
}

function stringArray(value: unknown, location: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw invalidConfig(`${location} must be a list of non-empty strings.`);
  }
  return value.map((item) => String(item));
}

function severity(value: unknown, location: string): Severity {
  if (typeof value !== "string" || !severityOrder.includes(value as Severity)) {
    throw invalidConfig(
      `${location} must be one of: ${severityOrder.join(", ")}.`,
    );
  }
  return value as Severity;
}

function ruleLevel(value: unknown, location: string): RuleLevel {
  if (value === "error") return "high";
  if (value === "warning") return "medium";
  if (value === "off") return "off";
  return severity(value, location);
}

function limit(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidConfig(`${location} must be a non-negative integer.`);
  }
  return value;
}

function boundedPositiveInteger(
  value: unknown,
  location: string,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw invalidConfig(
      `${location} must be an integer between 1 and ${maximum}.`,
    );
  }
  return value;
}

function ruleId(value: unknown, location: string): RuleId {
  if (typeof value !== "string" || !ruleIds.includes(value as RuleId)) {
    throw invalidConfig(`${location} must be one of: ${ruleIds.join(", ")}.`);
  }
  return value as RuleId;
}

function suppressions(value: unknown): FindingSuppression[] {
  if (!Array.isArray(value)) {
    throw invalidConfig("suppressions must be a list.");
  }
  return value.map((item, index) => {
    const location = `suppressions[${index}]`;
    const suppression = objectAt(item, location);
    assertKnownKeys(suppression, suppressionKeys, location);
    const path = stringArray([suppression.path], `${location}.path`)[0];
    const reason = stringArray([suppression.reason], `${location}.reason`)[0];
    if (!path || !reason) throw invalidConfig(`${location} is incomplete.`);
    const result: FindingSuppression = {
      ruleId: ruleId(suppression.ruleId, `${location}.ruleId`),
      path,
      reason,
    };
    if (suppression.line !== undefined) {
      result.line = boundedPositiveInteger(
        suppression.line,
        `${location}.line`,
        Number.MAX_SAFE_INTEGER,
      );
    }
    return result;
  });
}

export function validateConfig(input: unknown): AgentGateConfig {
  const root = objectAt(input, "Configuration");
  assertKnownKeys(root, rootKeys, "Configuration");
  if (root.version !== 1)
    throw invalidConfig("Configuration version must be 1.");

  const config: AgentGateConfig = structuredClone(defaultConfig);
  if (root.failOn !== undefined)
    config.failOn = severity(root.failOn, "failOn");
  if (root.allowedPaths !== undefined) {
    config.allowedPaths = stringArray(root.allowedPaths, "allowedPaths");
  }
  if (root.deniedPaths !== undefined) {
    config.deniedPaths = stringArray(root.deniedPaths, "deniedPaths");
  }
  if (root.limits !== undefined) {
    const limits = objectAt(root.limits, "limits");
    assertKnownKeys(limits, limitKeys, "limits");
    for (const key of limitNames) {
      if (limits[key] !== undefined)
        config.limits[key] = limit(limits[key], `limits.${key}`);
    }
  }
  if (root.rules !== undefined) {
    const rules = objectAt(root.rules, "rules");
    assertKnownKeys(rules, new Set(ruleIds), "rules");
    for (const id of ruleIds) {
      const value = rules[id];
      if (value === undefined) continue;
      if (typeof value === "string") {
        config.rules[id] = ruleLevel(value, `rules.${id}`);
        continue;
      }
      const settings = objectAt(value, `rules.${id}`);
      assertKnownKeys(settings, ruleKeys, `rules.${id}`);
      if (settings.level !== undefined) {
        config.rules[id] = ruleLevel(settings.level, `rules.${id}.level`);
      }
      if (settings.excludePaths !== undefined) {
        config.ruleExcludePaths[id] = stringArray(
          settings.excludePaths,
          `rules.${id}.excludePaths`,
        );
      }
    }
  }
  if (root.suppressions !== undefined) {
    config.suppressions = suppressions(root.suppressions);
  }
  if (root.git !== undefined) {
    const git = objectAt(root.git, "git");
    assertKnownKeys(git, gitKeys, "git");
    if (git.commandTimeoutMs !== undefined) {
      config.git.commandTimeoutMs = boundedPositiveInteger(
        git.commandTimeoutMs,
        "git.commandTimeoutMs",
        120_000,
      );
    }
    if (git.maxDiffBytes !== undefined) {
      config.git.maxDiffBytes = boundedPositiveInteger(
        git.maxDiffBytes,
        "git.maxDiffBytes",
        256 * 1024 * 1024,
      );
    }
  }
  if (root.untracked !== undefined) {
    const untracked = objectAt(root.untracked, "untracked");
    assertKnownKeys(untracked, untrackedKeys, "untracked");
    if (untracked.maxFiles !== undefined) {
      config.untracked.maxFiles = boundedPositiveInteger(
        untracked.maxFiles,
        "untracked.maxFiles",
        100_000,
      );
    }
    if (untracked.maxFileBytes !== undefined) {
      config.untracked.maxFileBytes = boundedPositiveInteger(
        untracked.maxFileBytes,
        "untracked.maxFileBytes",
        16 * 1024 * 1024,
      );
    }
    if (untracked.maxSymlinkBytes !== undefined) {
      config.untracked.maxSymlinkBytes = boundedPositiveInteger(
        untracked.maxSymlinkBytes,
        "untracked.maxSymlinkBytes",
        64 * 1024,
      );
    }
    if (untracked.maxTotalBytes !== undefined) {
      config.untracked.maxTotalBytes = boundedPositiveInteger(
        untracked.maxTotalBytes,
        "untracked.maxTotalBytes",
        64 * 1024 * 1024,
      );
    }
    if (untracked.readTimeoutMs !== undefined) {
      config.untracked.readTimeoutMs = boundedPositiveInteger(
        untracked.readTimeoutMs,
        "untracked.readTimeoutMs",
        60_000,
      );
    }
  }
  return config;
}

export function parseConfig(source: string, location: string): AgentGateConfig {
  const document = parseDocument(source, { prettyErrors: true });
  if (document.errors.length > 0) {
    throw invalidConfig(
      `Invalid YAML in ${location}: ${document.errors[0]?.message ?? "parse error"}`,
    );
  }
  try {
    return validateConfig(document.toJS() as unknown);
  } catch (error) {
    if (error instanceof AgentGateError) {
      throw invalidConfig(
        `Invalid configuration at ${location}: ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function loadConfig(
  cwd: string,
  requestedPath: string,
  expectedSha256?: string,
): Promise<AgentGateConfig> {
  const path = isAbsolute(requestedPath)
    ? requestedPath
    : resolve(cwd, requestedPath);

  let source: Buffer;
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) {
      throw new AgentGateError(
        `Configuration at ${path} must be a regular file.`,
        { code: "IO_ERROR" },
      );
    }
    if (stats.size > maximumConfigBytes) {
      throw new AgentGateError(
        `Configuration at ${path} exceeds ${maximumConfigBytes} bytes.`,
        { code: "RESOURCE_LIMIT" },
      );
    }
    source = await readFile(path, { signal: AbortSignal.timeout(2_000) });
  } catch (error) {
    if (error instanceof AgentGateError) throw error;
    throw new AgentGateError(`Cannot read configuration at ${path}.`, {
      cause: error,
      code: "IO_ERROR",
    });
  }
  if (source.length > maximumConfigBytes) {
    throw new AgentGateError(
      `Configuration at ${path} exceeds ${maximumConfigBytes} bytes.`,
      { code: "RESOURCE_LIMIT" },
    );
  }
  if (expectedSha256) {
    const actual = createHash("sha256").update(source).digest("hex");
    if (actual !== expectedSha256.toLowerCase()) {
      throw new AgentGateError(
        `Configuration SHA-256 mismatch at ${path}: expected ${expectedSha256.toLowerCase()}, got ${actual}.`,
        { code: "POLICY_HASH_MISMATCH" },
      );
    }
  }
  return parseConfig(source.toString("utf8"), path);
}
