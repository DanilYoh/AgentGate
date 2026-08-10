import { redactSecrets, safeEvidence } from "../security/redact.js";
import type { ScanResult } from "../types.js";

export function formatJson(result: ScanResult): string {
  const report = {
    version: 1,
    summary: result.summary,
    blockingFindings: result.blockingFindings,
    findings: result.findings.map((item) => ({
      ...item,
      evidence: safeEvidence(item.evidence),
    })),
  };
  return redactSecrets(JSON.stringify(report, null, 2));
}
