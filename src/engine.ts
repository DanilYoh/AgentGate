import { severityOrder } from "./types.js";
import type {
  AgentGateConfig,
  DiffSet,
  ScanResult,
  Severity,
  SuppressedFinding,
} from "./types.js";
import { rules as defaultRules } from "./rules/index.js";
import { matchesPath } from "./path-match.js";
import type { Rule } from "./types.js";

export function isAtLeast(actual: Severity, threshold: Severity): boolean {
  return severityOrder.indexOf(actual) >= severityOrder.indexOf(threshold);
}

export function scan(
  diff: DiffSet,
  config: AgentGateConfig,
  rules: Rule[] = defaultRules,
): ScanResult {
  const findings = rules.flatMap((rule) => {
    const excludePaths = config.ruleExcludePaths[rule.id];
    const files = diff.files.filter((file) => {
      const paths = [file.oldPath, file.newPath, file.path].filter(
        (path): path is string => Boolean(path),
      );
      return !paths.some((path) => matchesPath(path, excludePaths));
    });
    const filteredDiff: DiffSet = {
      files,
      changedFiles: files.length,
      addedLines: files.reduce(
        (total, file) => total + file.additions.length,
        0,
      ),
      deletedLines: files.reduce(
        (total, file) => total + file.deletions.length,
        0,
      ),
    };
    return rule.check({ diff: filteredDiff, config });
  });
  findings.sort((a, b) => {
    const severity =
      severityOrder.indexOf(b.severity) - severityOrder.indexOf(a.severity);
    return (
      severity || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0)
    );
  });
  const activeFindings = [];
  const suppressedFindings: SuppressedFinding[] = [];
  for (const item of findings) {
    const suppressionIndex = config.suppressions.findIndex(
      (suppression) =>
        suppression.ruleId === item.ruleId &&
        matchesPath(item.file, [suppression.path]) &&
        (suppression.line === undefined || suppression.line === item.line),
    );
    if (suppressionIndex === -1) {
      activeFindings.push(item);
      continue;
    }
    const suppression = config.suppressions[suppressionIndex];
    if (!suppression) continue;
    suppressedFindings.push({
      ...item,
      suppression: {
        reason: suppression.reason,
        source: {
          kind: "policy",
          location: `suppressions[${suppressionIndex}]`,
        },
      },
    });
  }
  return {
    findings: activeFindings,
    suppressedFindings,
    blockingFindings: activeFindings.filter((item) =>
      isAtLeast(item.severity, config.failOn),
    ).length,
    summary: {
      changedFiles: diff.changedFiles,
      addedLines: diff.addedLines,
      deletedLines: diff.deletedLines,
      findings: activeFindings.length,
      suppressedFindings: suppressedFindings.length,
    },
  };
}
