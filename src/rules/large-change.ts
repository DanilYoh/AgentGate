import { finding } from "./helpers.js";
import type { Rule } from "../types.js";

export const largeChangeRule: Rule = {
  id: "large-change",
  check({ diff, config }) {
    const exceeded: string[] = [];
    if (diff.changedFiles > config.limits.changedFiles) {
      exceeded.push(
        `${diff.changedFiles} files > ${config.limits.changedFiles}`,
      );
    }
    if (diff.addedLines > config.limits.addedLines) {
      exceeded.push(
        `${diff.addedLines} additions > ${config.limits.addedLines}`,
      );
    }
    if (diff.deletedLines > config.limits.deletedLines) {
      exceeded.push(
        `${diff.deletedLines} deletions > ${config.limits.deletedLines}`,
      );
    }
    if (exceeded.length === 0) return [];
    const item = finding(config, this.id, {
      file: ".",
      message: "The change exceeds configured size limits.",
      evidence: exceeded.join("; "),
      recommendation:
        "Split the work into smaller reviewable changes or explicitly adjust the configured limits.",
    });
    return item ? [item] : [];
  },
};
