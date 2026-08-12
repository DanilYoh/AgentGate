import { redactSecrets, safeEvidence } from "../security/redact.js";
import type { Finding, SuppressedFinding } from "../types.js";

export function sanitizeFinding(finding: Finding): Finding {
  return {
    ...finding,
    file: redactSecrets(finding.file),
    message: redactSecrets(finding.message),
    evidence: safeEvidence(finding.evidence),
    recommendation: redactSecrets(finding.recommendation),
  };
}

export function sanitizeSuppressedFinding(
  finding: SuppressedFinding,
): SuppressedFinding {
  const sanitized = sanitizeFinding(finding);
  if (!finding.suppression) return sanitized;
  return {
    ...sanitized,
    suppression: {
      reason: redactSecrets(finding.suppression.reason),
      source: {
        kind: "policy",
        location: redactSecrets(finding.suppression.source.location),
      },
    },
  };
}
