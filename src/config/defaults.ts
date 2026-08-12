import type { AgentGateConfig } from "../types.js";

export const defaultConfig: AgentGateConfig = {
  version: 1,
  failOn: "high",
  allowedPaths: [],
  deniedPaths: [],
  limits: {
    changedFiles: 20,
    addedLines: 500,
    deletedLines: 300,
  },
  rules: {
    "secret-added": "high",
    "test-disabled": "high",
    "placeholder-added": "medium",
    "dependency-added": "medium",
    "sensitive-file-changed": "medium",
    "scope-violation": "high",
    "large-change": "medium",
  },
  ruleExcludePaths: {
    "secret-added": [],
    "test-disabled": [],
    "placeholder-added": [],
    "dependency-added": [],
    "sensitive-file-changed": [],
    "scope-violation": [],
    "large-change": [],
  },
  suppressions: [],
  git: {
    commandTimeoutMs: 30_000,
    maxDiffBytes: 50 * 1024 * 1024,
  },
  untracked: {
    maxFiles: 10_000,
    maxFileBytes: 1024 * 1024,
    maxSymlinkBytes: 4 * 1024,
    maxTotalBytes: 8 * 1024 * 1024,
    readTimeoutMs: 2_000,
  },
};
