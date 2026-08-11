import { finding } from "./helpers.js";
import type { Rule } from "../types.js";

const patterns = [
  /\b(?:TODO|FIXME|IMPLEMENT\s+ME)\b/iu,
  /\b(?:NotImplementedException|NotImplementedError)\b/u,
  /\bunimplemented!\s*\(/u,
  /throw\s+new\s+Error\s*\(\s*["'][^"']*not implemented/iu,
  /panic!\s*\(\s*["'][^"']*(?:todo|not implemented)/iu,
];

export const placeholderAddedRule: Rule = {
  id: "placeholder-added",
  check({ diff, config }) {
    return diff.files.flatMap((file) =>
      file.additions.flatMap((line) => {
        if (!patterns.some((pattern) => pattern.test(line.content))) return [];
        const item = finding(config, this.id, {
          file: file.path,
          ...(line.newLine === undefined ? {} : { line: line.newLine }),
          message:
            "A placeholder or unfinished implementation marker was added.",
          evidence: line.content,
          recommendation:
            "Complete the implementation or remove the placeholder before committing.",
        });
        return item ? [item] : [];
      }),
    );
  },
};
