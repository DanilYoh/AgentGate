import { finding } from "./helpers.js";
import { hasLikelySecret } from "../security/redact.js";
import type { Rule } from "../types.js";

export const secretAddedRule: Rule = {
  id: "secret-added",
  check({ diff, config }) {
    const findings = [];
    for (const file of diff.files) {
      for (const line of file.additions) {
        if (!hasLikelySecret(line.content)) continue;
        const item = finding(config, this.id, {
          file: file.path,
          ...(line.newLine === undefined ? {} : { line: line.newLine }),
          message: "A value resembling a secret was added.",
          evidence: line.content,
          recommendation:
            "Remove the secret from the change and load it from a secure secret store or environment variable.",
        });
        if (item) findings.push(item);
      }
    }
    return findings;
  },
};
