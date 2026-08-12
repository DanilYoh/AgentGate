import { defaultConfig } from "../config/defaults.js";
import type { RuleId, RuleLevel } from "../types.js";

export interface RuleMetadata {
  id: RuleId;
  defaultLevel: RuleLevel;
  description: string;
  inspection: string;
  limitations: string;
  recommendation: string;
}

function metadata(
  id: RuleId,
  values: Omit<RuleMetadata, "id" | "defaultLevel">,
): RuleMetadata {
  return { id, defaultLevel: defaultConfig.rules[id], ...values };
}

export const ruleMetadata: readonly RuleMetadata[] = [
  metadata("secret-added", {
    description: "Detects newly added values that resemble credentials.",
    inspection: "Added text lines in every changed non-binary file.",
    limitations:
      "Heuristic patterns can miss unfamiliar secret formats and intentionally ignore common placeholders and environment references.",
    recommendation:
      "Remove the value and load it from an environment variable or managed secret store.",
  }),
  metadata("test-disabled", {
    description: "Detects newly disabled or skipped tests.",
    inspection:
      "Added source lines containing common test-framework skip forms.",
    limitations:
      "Does not understand custom test frameworks and skips documentation and data-file extensions to reduce noise.",
    recommendation:
      "Restore the test or review and document an intentional quarantine separately.",
  }),
  metadata("placeholder-added", {
    description:
      "Detects unfinished implementation markers and explicit stubs.",
    inspection:
      "Added lines containing TODO/FIXME and common not-implemented forms.",
    limitations:
      "Text matching cannot determine whether a marker is acceptable project documentation.",
    recommendation:
      "Complete the implementation or remove the placeholder before committing.",
  }),
  metadata("dependency-added", {
    description: "Detects newly introduced direct dependency declarations.",
    inspection:
      "Complete bounded diff context for supported npm, Python, Composer, Go, Cargo, and Bundler manifests.",
    limitations:
      "Does not resolve dependency graphs or infer lockfile-only transitive changes.",
    recommendation:
      "Confirm necessity, provenance, license, maintenance, and version policy before accepting the declaration.",
  }),
  metadata("sensitive-file-changed", {
    description: "Flags changes to security- or operations-sensitive paths.",
    inspection:
      "Old and new paths for workflows, containers, migrations, auth/permission files, policies, and lockfiles.",
    limitations:
      "Path heuristics cannot determine whether the actual semantic change is safe.",
    recommendation:
      "Give the file focused human review against deployment and security policy.",
  }),
  metadata("scope-violation", {
    description: "Flags paths outside the configured change scope.",
    inspection: "Every old and new path against allowedPaths and deniedPaths.",
    limitations:
      "The custom glob syntax supports *, **, and ? but not brace or character-class expansion.",
    recommendation:
      "Move the change into approved scope or review a policy change separately.",
  }),
  metadata("large-change", {
    description: "Flags diffs that exceed configured review-size limits.",
    inspection: "Changed-file, added-line, and deleted-line totals.",
    limitations:
      "Size is a reviewability signal, not a measure of correctness or risk by itself.",
    recommendation:
      "Split the work into smaller changes or explicitly review a limit adjustment.",
  }),
] as const;

export function metadataForRule(id: RuleId): RuleMetadata {
  const result = ruleMetadata.find((item) => item.id === id);
  if (!result) throw new Error(`Missing metadata for rule ${id}.`);
  return result;
}
