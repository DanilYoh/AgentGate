import { finding } from "./helpers.js";
import type { Rule } from "../types.js";

const patterns = [
  /\b(?:describe|it|test)\.skip\b/u,
  /\b(?:xit|xdescribe|xtest)\s*\(/u,
  /pytest\.mark\.skip(?:if)?\b/u,
  /@unittest\.skip(?:If|Unless)?\b/u,
  /@(?:Disabled|Ignore)\b/u,
  /\[(?:Ignore|Explicit)\b/u,
];

const nonSourceExtensions =
  /\.(?:csv|html?|jsonc?|lock|mdx?|rst|snap|toml|tsx?\.snap|txt|xml|ya?ml)$/iu;

export const testDisabledRule: Rule = {
  id: "test-disabled",
  check({ diff, config }) {
    return diff.files.flatMap((file) =>
      nonSourceExtensions.test(file.path)
        ? []
        : file.additions.flatMap((line) => {
            if (!patterns.some((pattern) => pattern.test(line.content)))
              return [];
            const item = finding(config, this.id, {
              file: file.path,
              ...(line.newLine === undefined ? {} : { line: line.newLine }),
              message: "A test appears to have been disabled.",
              evidence: line.content,
              recommendation:
                "Restore the test or document and review an intentional quarantine separately.",
            });
            return item ? [item] : [];
          }),
    );
  },
};
