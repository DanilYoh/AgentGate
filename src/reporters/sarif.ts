import { safeEvidence } from "../security/redact.js";
import type { Finding, ScanResult, Severity } from "../types.js";
import type { Location, Log } from "sarif";
import { agentGateVersion } from "../version.js";
import { metadataForRule } from "../rules/metadata.js";
import { sanitizeFinding, sanitizeSuppressedFinding } from "./sanitize.js";

function sarifLevel(severity: Severity): "error" | "warning" | "note" {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium") return "warning";
  return "note";
}

function location(finding: Finding): Location {
  const uri = finding.file
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return {
    physicalLocation: {
      artifactLocation: {
        uri,
      },
      ...(finding.line === undefined
        ? {}
        : { region: { startLine: finding.line } }),
    },
  };
}

export function formatSarif(result: ScanResult): string {
  const findings = result.findings.map(sanitizeFinding);
  const suppressedFindings = result.suppressedFindings.map(
    sanitizeSuppressedFinding,
  );
  const firstByRule = new Map(findings.map((item) => [item.ruleId, item]));
  const descriptors = [...firstByRule.values()];
  const ruleIndexes = new Map(
    descriptors.map((item, index) => [item.ruleId, index]),
  );
  const report: Log = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "AgentGate",
            semanticVersion: agentGateVersion,
            rules: descriptors.map((item) => {
              const metadata = metadataForRule(item.ruleId);
              return {
                id: item.ruleId,
                shortDescription: { text: metadata.description },
                fullDescription: { text: metadata.inspection },
                help: {
                  text: `${metadata.recommendation} Limitation: ${metadata.limitations}`,
                },
                defaultConfiguration: { level: sarifLevel(item.severity) },
                properties: { severity: item.severity },
              };
            }),
          },
        },
        results: findings.map((item) => ({
          ruleId: item.ruleId,
          ruleIndex: ruleIndexes.get(item.ruleId),
          level: sarifLevel(item.severity),
          message: {
            text: `${item.message} Evidence: ${safeEvidence(item.evidence)} Fix: ${item.recommendation}`,
          },
          locations: [location(item)],
          properties: { severity: item.severity },
        })),
        properties: {
          blockingFindings: result.blockingFindings,
          suppressedFindings: result.summary.suppressedFindings,
          agentGate: {
            reportVersion: 1,
            suppressedFindings,
          },
        },
      },
    ],
  };
  return JSON.stringify(report, null, 2);
}
