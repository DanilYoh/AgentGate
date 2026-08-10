import { matchesPath } from "../path-match.js";
import { changedPaths, finding } from "./helpers.js";
import type { Rule } from "../types.js";

export const scopeViolationRule: Rule = {
  id: "scope-violation",
  check({ diff, config }) {
    return diff.files.flatMap((file) =>
      changedPaths(file).flatMap((path) => {
        const denied = matchesPath(path, config.deniedPaths);
        const outsideAllowed =
          config.allowedPaths.length > 0 &&
          !matchesPath(path, config.allowedPaths);
        if (!denied && !outsideAllowed) return [];
        const reason = denied
          ? "matches deniedPaths"
          : "does not match allowedPaths";
        const item = finding(config, this.id, {
          file: path,
          message: `Changed file ${reason}.`,
          evidence: path,
          recommendation:
            "Move the change into the approved scope or update the policy through normal review.",
        });
        return item ? [item] : [];
      }),
    );
  },
};
