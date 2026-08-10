import { severityOrder } from "./types.js";
import type {
  AgentGateConfig,
  DiffSet,
  ScanResult,
  Severity,
} from "./types.js";
import { rules as defaultRules } from "./rules/index.js";
import type { Rule } from "./types.js";

export function isAtLeast(actual: Severity, threshold: Severity): boolean {
  return severityOrder.indexOf(actual) >= severityOrder.indexOf(threshold);
}

export function scan(
  diff: DiffSet,
  config: AgentGateConfig,
  rules: Rule[] = defaultRules,
): ScanResult {
  const findings = rules.flatMap((rule) => rule.check({ diff, config }));
  findings.sort((a, b) => {
    const severity =
      severityOrder.indexOf(b.severity) - severityOrder.indexOf(a.severity);
    return (
      severity || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0)
    );
  });
  return {
    findings,
    blockingFindings: findings.filter((item) =>
      isAtLeast(item.severity, config.failOn),
    ).length,
    summary: {
      changedFiles: diff.changedFiles,
      addedLines: diff.addedLines,
      deletedLines: diff.deletedLines,
      findings: findings.length,
    },
  };
}
