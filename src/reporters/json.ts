import type { ScanResult } from "../types.js";
import { sanitizeFinding, sanitizeSuppressedFinding } from "./sanitize.js";

export function formatJson(result: ScanResult): string {
  const report = {
    version: 1,
    summary: result.summary,
    blockingFindings: result.blockingFindings,
    findings: result.findings.map(sanitizeFinding),
    suppressedFindings: result.suppressedFindings.map(
      sanitizeSuppressedFinding,
    ),
  };
  return JSON.stringify(report, null, 2);
}
