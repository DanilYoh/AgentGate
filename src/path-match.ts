function globToRegExp(glob: string): RegExp {
  const normalized = glob.replaceAll("\\", "/").replace(/^\.\//u, "");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character?.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&") ?? "";
  }
  return new RegExp(`${source}$`, "u");
}

export function matchesPath(path: string, patterns: string[]): boolean {
  const normalized = path.replace(/^\.\//u, "");
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}
