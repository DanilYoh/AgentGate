export const severityOrder = [
  "info",
  "low",
  "medium",
  "high",
  "critical",
] as const;

export type Severity = (typeof severityOrder)[number];
export type RuleId =
  | "secret-added"
  | "test-disabled"
  | "placeholder-added"
  | "dependency-added"
  | "sensitive-file-changed"
  | "scope-violation"
  | "large-change";

export interface ChangedLine {
  content: string;
  hunk?: number;
  oldLine?: number;
  newLine?: number;
  kind: "add" | "delete" | "context";
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  newPath?: string;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
  lines: ChangedLine[];
  additions: ChangedLine[];
  deletions: ChangedLine[];
}

export interface DiffSet {
  files: FileDiff[];
  changedFiles: number;
  addedLines: number;
  deletedLines: number;
}

export interface Finding {
  ruleId: RuleId;
  severity: Severity;
  file: string;
  line?: number;
  message: string;
  evidence: string;
  recommendation: string;
}

export type RuleLevel = Severity | "off";

export interface FindingSuppression {
  ruleId: RuleId;
  path: string;
  line?: number;
  reason: string;
}

export interface AppliedSuppression {
  reason: string;
  source: {
    kind: "policy";
    location: string;
  };
}

export interface SuppressedFinding extends Finding {
  /** Optional so programmatic callers constructing legacy ScanResult values remain compatible. */
  suppression?: AppliedSuppression;
}

export interface AgentGateConfig {
  version: 1;
  failOn: Severity;
  allowedPaths: string[];
  deniedPaths: string[];
  limits: {
    changedFiles: number;
    addedLines: number;
    deletedLines: number;
  };
  rules: Record<RuleId, RuleLevel>;
  ruleExcludePaths: Record<RuleId, string[]>;
  suppressions: FindingSuppression[];
  git: {
    commandTimeoutMs: number;
    maxDiffBytes: number;
  };
  untracked: {
    maxFiles: number;
    maxFileBytes: number;
    maxSymlinkBytes: number;
    maxTotalBytes: number;
    readTimeoutMs: number;
  };
}

export interface RuleContext {
  diff: DiffSet;
  config: AgentGateConfig;
}

export interface Rule {
  id: RuleId;
  check(context: RuleContext): Finding[];
}

export interface ScanResult {
  findings: Finding[];
  suppressedFindings: SuppressedFinding[];
  blockingFindings: number;
  summary: {
    changedFiles: number;
    addedLines: number;
    deletedLines: number;
    findings: number;
    suppressedFindings: number;
  };
}
