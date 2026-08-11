import { redactSecrets, safeEvidence } from "../security/redact.js";
import type { Finding } from "../types.js";

export function sanitizeFinding(finding: Finding): Finding {
  return {
    ...finding,
    file: redactSecrets(finding.file),
    message: redactSecrets(finding.message),
    evidence: safeEvidence(finding.evidence),
    recommendation: redactSecrets(finding.recommendation),
  };
}
