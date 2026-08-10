import { changedPaths, finding } from "./helpers.js";
import type { Rule } from "../types.js";

const patterns = [
  /^\.github\/workflows\//iu,
  /(?:^|\/)Dockerfile(?:\.[^/]*)?$/iu,
  /(?:^|\/)(?:migrations?|db\/migrate)(?:\/|$)/iu,
  /(?:^|\/)(?:auth|authentication|authorization|permissions?|rbac)(?:[./_-]|$)/iu,
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|Cargo\.lock|Gemfile\.lock|composer\.lock)$/iu,
];

export const sensitiveFileChangedRule: Rule = {
  id: "sensitive-file-changed",
  check({ diff, config }) {
    return diff.files.flatMap((file) => {
      const sensitivePath = changedPaths(file).find((path) =>
        patterns.some((pattern) => pattern.test(path)),
      );
      if (!sensitivePath) return [];
      const item = finding(config, this.id, {
        file: sensitivePath,
        message: "A security- or operations-sensitive file was changed.",
        evidence:
          file.oldPath && file.newPath && file.oldPath !== file.newPath
            ? `${file.oldPath} -> ${file.newPath}`
            : sensitivePath,
        recommendation:
          "Give this file focused review and verify the change against deployment and security policy.",
      });
      return item ? [item] : [];
    });
  },
};
