import { AgentGateError } from "../errors.js";
import { ruleMetadata } from "../rules/metadata.js";
import type { RuleId } from "../types.js";

export function explainRules(requestedId?: string): string {
  if (!requestedId) {
    return [
      "AgentGate rules:",
      ...ruleMetadata.map(
        (item) =>
          `  ${item.id} [default: ${item.defaultLevel}] — ${item.description}`,
      ),
    ].join("\n");
  }
  const item = ruleMetadata.find((candidate) => candidate.id === requestedId);
  if (!item) {
    throw new AgentGateError(
      `Unknown rule '${requestedId}'. Expected one of: ${ruleMetadata.map((candidate) => candidate.id).join(", ")}.`,
      { code: "INVALID_ARGUMENT" },
    );
  }
  const id: RuleId = item.id;
  return [
    `${id} [default: ${item.defaultLevel}]`,
    item.description,
    `Inspects: ${item.inspection}`,
    `Limitations: ${item.limitations}`,
    `Recommendation: ${item.recommendation}`,
  ].join("\n");
}
