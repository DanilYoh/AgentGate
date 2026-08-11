import { safeEvidence } from "../security/redact.js";
import type { AgentGateConfig, FileDiff, Finding, RuleId } from "../types.js";

export function changedPaths(file: FileDiff): string[] {
  return [
    ...new Set(
      [file.oldPath, file.newPath, file.path].filter((path): path is string =>
        Boolean(path),
      ),
    ),
  ];
}

export function finding(
  config: AgentGateConfig,
  ruleId: RuleId,
  values: Omit<Finding, "ruleId" | "severity" | "evidence"> & {
    evidence: string;
  },
): Finding | undefined {
  const severity = config.rules[ruleId];
  if (severity === "off") return undefined;
  return {
    ruleId,
    severity,
    ...values,
    evidence: safeEvidence(values.evidence),
  };
}
