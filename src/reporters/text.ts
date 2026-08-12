import { safeEvidence, safeTextFragment } from "../security/redact.js";
import type { ScanResult } from "../types.js";

export function formatText(result: ScanResult): string {
  const lines = [
    `AgentGate checked ${result.summary.changedFiles} file(s): +${result.summary.addedLines} -${result.summary.deletedLines}`,
  ];
  if (result.findings.length === 0) {
    lines.push("No findings.");
  } else {
    for (const item of result.findings) {
      const location = `${safeTextFragment(item.file)}${item.line === undefined ? "" : `:${item.line}`}`;
      lines.push(
        "",
        `[${item.severity.toUpperCase()}] ${item.ruleId} at ${location}`,
        `  ${safeTextFragment(item.message)}`,
        `  Evidence: ${safeTextFragment(safeEvidence(item.evidence))}`,
        `  Fix: ${safeTextFragment(item.recommendation)}`,
      );
    }
    lines.push("", `${result.blockingFindings} blocking finding(s).`);
  }
  if (result.suppressedFindings.length > 0) {
    lines.push(
      "",
      `${result.suppressedFindings.length} finding(s) suppressed:`,
    );
    for (const item of result.suppressedFindings) {
      const location = `${safeTextFragment(item.file)}${item.line === undefined ? "" : `:${item.line}`}`;
      lines.push(
        `  [${item.severity.toUpperCase()}] ${item.ruleId} at ${location}`,
      );
      if (item.suppression) {
        lines.push(
          `    Reason: ${safeTextFragment(item.suppression.reason)}`,
          `    Source: ${safeTextFragment(item.suppression.source.kind)} ${safeTextFragment(item.suppression.source.location)}`,
        );
      }
    }
  }
  return lines.join("\n");
}
