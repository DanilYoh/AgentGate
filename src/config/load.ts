import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseDocument } from "yaml";
import { defaultConfig } from "./defaults.js";
import { AgentGateError } from "../errors.js";
import { severityOrder } from "../types.js";
import type { AgentGateConfig, RuleId, RuleLevel, Severity } from "../types.js";

const ruleIds = Object.keys(defaultConfig.rules) as RuleId[];
const rootKeys = new Set([
  "version",
  "failOn",
  "allowedPaths",
  "deniedPaths",
  "limits",
  "rules",
]);
const limitNames = ["changedFiles", "addedLines", "deletedLines"] as const;
const limitKeys = new Set<string>(limitNames);

function objectAt(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentGateError(`${location} must be a mapping.`);
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
      throw new AgentGateError(`${location} contains unknown key '${key}'.`);
  }
}

function stringArray(value: unknown, location: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new AgentGateError(
      `${location} must be a list of non-empty strings.`,
    );
  }
  return value.map((item) => String(item));
}

function severity(value: unknown, location: string): Severity {
  if (typeof value !== "string" || !severityOrder.includes(value as Severity)) {
    throw new AgentGateError(
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
    throw new AgentGateError(`${location} must be a non-negative integer.`);
  }
  return value;
}

export function validateConfig(input: unknown): AgentGateConfig {
  const root = objectAt(input, "Configuration");
  assertKnownKeys(root, rootKeys, "Configuration");
  if (root.version !== 1)
    throw new AgentGateError("Configuration version must be 1.");

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
      if (rules[id] !== undefined)
        config.rules[id] = ruleLevel(rules[id], `rules.${id}`);
    }
  }
  return config;
}

export async function loadConfig(
  cwd: string,
  requestedPath?: string,
): Promise<AgentGateConfig> {
  const path = requestedPath
    ? isAbsolute(requestedPath)
      ? requestedPath
      : resolve(cwd, requestedPath)
    : resolve(cwd, ".agentgate.yml");

  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!requestedPath && code === "ENOENT")
      return structuredClone(defaultConfig);
    throw new AgentGateError(`Cannot read configuration at ${path}.`, {
      cause: error,
    });
  }

  const document = parseDocument(source, { prettyErrors: true });
  if (document.errors.length > 0) {
    throw new AgentGateError(
      `Invalid YAML in ${path}: ${document.errors[0]?.message ?? "parse error"}`,
    );
  }
  try {
    return validateConfig(document.toJS() as unknown);
  } catch (error) {
    if (error instanceof AgentGateError) {
      throw new AgentGateError(
        `Invalid configuration at ${path}: ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}
