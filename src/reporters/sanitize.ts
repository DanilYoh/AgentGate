import {
  redactSecrets,
  safeEvidence,
  safeTextFragment,
} from "../security/redact.js";
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
      reason: safeTextFragment(safeEvidence(finding.suppression.reason, 240)),
      source: {
        kind: "policy",
        location: safeTextFragment(finding.suppression.source.location),
      },
    },
  };
}
