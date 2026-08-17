import { basename } from "node:path";
import { finding } from "./helpers.js";
import type { ChangedLine, FileDiff, Rule } from "../types.js";

interface Dependency {
  identity: string;
  name: string;
  version: string;
  line?: number;
}

type ManifestSide = "before" | "after";

const packageSections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const composerSections = ["require", "require-dev"] as const;

function manifestName(path: string): string {
  return basename(path).toLowerCase();
}

export function isDependencyManifest(path: string): boolean {
  const name = manifestName(path);
  return (
    name === "package.json" ||
    name === "pyproject.toml" ||
    name === "composer.json" ||
    name === "go.mod" ||
    name === "cargo.toml" ||
    name === "gemfile" ||
    /^requirements(?:[-_.][a-z0-9._-]+)?\.(?:txt|in)$/u.test(name)
  );
}

function linesFor(file: FileDiff, side: ManifestSide): ChangedLine[] {
  return file.lines.filter((line) =>
    side === "before" ? line.kind !== "add" : line.kind !== "delete",
  );
}

function sourceLine(line: ChangedLine, side: ManifestSide): number | undefined {
  return side === "before" ? line.oldLine : line.newLine;
}

function normalizePythonName(name: string): string {
  return name.toLowerCase().replaceAll(/[-_.]+/gu, "-");
}

function dependency(
  name: string,
  version: string,
  line: number | undefined,
  normalize: (value: string) => string = (value) => value,
): Dependency {
  return {
    identity: normalize(name),
    name,
    version,
    ...(line === undefined ? {} : { line }),
  };
}

function unique(items: Dependency[]): Dependency[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.identity)) return false;
    seen.add(item.identity);
    return true;
  });
}

function propertyLine(
  file: FileDiff,
  name: string,
  side: ManifestSide,
): number | undefined {
  const serialized = JSON.stringify(name);
  const candidate = linesFor(file, side).find((line) =>
    line.content.trimStart().startsWith(`${serialized}:`),
  );
  return candidate ? sourceLine(candidate, side) : undefined;
}

function jsonObject(lines: ChangedLine[]): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(
      lines.map((line) => line.content).join("\n"),
    ) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function jsonDependencies(
  file: FileDiff,
  side: ManifestSide,
  sections: readonly string[],
): Dependency[] | undefined {
  const root = jsonObject(linesFor(file, side));
  if (!root) return undefined;
  const results: Dependency[] = [];
  for (const section of sections) {
    const values = root[section];
    if (
      typeof values !== "object" ||
      values === null ||
      Array.isArray(values)
    ) {
      continue;
    }
    for (const [name, version] of Object.entries(values)) {
      if (typeof version !== "string") continue;
      results.push(
        dependency(name, version, propertyLine(file, name, side), (value) =>
          value.toLowerCase(),
        ),
      );
    }
  }
  return results;
}

function packageFallback(file: FileDiff, side: ManifestSide): Dependency[] {
  const results: Dependency[] = [];
  let inDependencySection = false;
  for (const line of linesFor(file, side)) {
    const objectStart = /^\s*"([^"]+)"\s*:\s*\{\s*$/u.exec(line.content);
    if (objectStart?.[1]) {
      inDependencySection = packageSections.includes(
        objectStart[1] as (typeof packageSections)[number],
      );
      continue;
    }
    if (/^\s*\}\s*,?\s*$/u.test(line.content)) {
      inDependencySection = false;
      continue;
    }
    if (!inDependencySection) continue;
    const match = /^\s*"([^"]+)"\s*:\s*"([^"]+)"\s*,?\s*$/u.exec(line.content);
    if (!match?.[1] || !match[2]) continue;
    results.push(
      dependency(match[1], match[2], sourceLine(line, side), (value) =>
        value.toLowerCase(),
      ),
    );
  }
  return results;
}

function packageDependencies(file: FileDiff, side: ManifestSide): Dependency[] {
  return (
    jsonDependencies(file, side, packageSections) ?? packageFallback(file, side)
  );
}

function requirement(
  line: ChangedLine,
  side: ManifestSide,
): Dependency | undefined {
  const vcsMatch =
    /^\s*(?:(?:-e|--editable)(?:\s+|=))?((?:git|hg|svn|bzr)\+\S+?)(?:\s+#.*)?\s*$/iu.exec(
      line.content,
    );
  if (vcsMatch?.[1]) {
    const source = vcsMatch[1];
    const egg = /[#&]egg=([^&\s]+)/iu.exec(source)?.[1];
    let displayName: string | undefined;
    if (egg) {
      try {
        displayName = decodeURIComponent(egg);
      } catch {
        displayName = egg;
      }
    } else {
      const path = source.split("#", 1)[0]?.split("?", 1)[0] ?? source;
      const segment = path.split("/").at(-1)?.split("@", 1)[0];
      if (segment) {
        try {
          displayName = decodeURIComponent(segment).replace(/\.git$/iu, "");
        } catch {
          displayName = segment.replace(/\.git$/iu, "");
        }
      }
    }
    if (
      displayName &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]+\])?$/u.test(displayName)
    ) {
      const identityName = displayName.replace(/\[[^\]]+\]$/u, "");
      return dependency(displayName, source, sourceLine(line, side), () =>
        normalizePythonName(identityName),
      );
    }
  }

  const match =
    /^\s*([A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]+\])?)(?:\s*((?:===|==|~=|>=|<=|>|<|!=).+?|@\s*\S+))?\s*(?:;.*)?$/u.exec(
      line.content,
    );
  if (!match?.[1]) return undefined;
  const displayName = match[1];
  const identityName = displayName.replace(/\[[^\]]+\]$/u, "");
  return dependency(
    displayName,
    match[2] ?? "unversioned",
    sourceLine(line, side),
    () => normalizePythonName(identityName),
  );
}

function requirementDependencies(
  file: FileDiff,
  side: ManifestSide,
): Dependency[] {
  return linesFor(file, side).flatMap((line) => requirement(line, side) ?? []);
}

function pyprojectArrayDependencies(
  line: ChangedLine,
  side: ManifestSide,
): Dependency[] {
  const results: Dependency[] = [];
  const pattern =
    /["']([A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]+\])?)(\s*(?:(?:===|==|~=|>=|<=|>|<|!=)[^"']+?|@\s*[^"']+))?["']/gu;
  for (const match of line.content.matchAll(pattern)) {
    if (!match[1]) continue;
    const prefix = line.content.slice(0, match.index);
    if (/include-group\s*=\s*$/u.test(prefix)) continue;
    const displayName = match[1];
    const identityName = displayName.replace(/\[[^\]]+\]$/u, "");
    results.push(
      dependency(
        displayName,
        match[2]?.trim() ?? "unversioned",
        sourceLine(line, side),
        () => normalizePythonName(identityName),
      ),
    );
  }
  return results;
}

function pyprojectMapDependency(
  line: ChangedLine,
  side: ManifestSide,
): Dependency | undefined {
  const mapMatch =
    /^\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*=\s*["']([^"']+)["']/u.exec(
      line.content,
    );
  if (mapMatch?.[1] && mapMatch[2] && mapMatch[1] !== "python") {
    return dependency(
      mapMatch[1],
      mapMatch[2],
      sourceLine(line, side),
      normalizePythonName,
    );
  }
  const inlineMatch =
    /^\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*=\s*\{([^}]*)\}\s*$/u.exec(
      line.content,
    );
  if (!inlineMatch?.[1] || !inlineMatch[2] || inlineMatch[1] === "python") {
    return undefined;
  }
  const version = /\bversion\s*=\s*["']([^"']+)["']/u.exec(inlineMatch[2])?.[1];
  const source = /\b(git|url|path)\s*=\s*["']([^"']+)["']/u.exec(
    inlineMatch[2],
  );
  return dependency(
    inlineMatch[1],
    version ??
      (source?.[1] && source[2] ? `${source[1]}:${source[2]}` : "unversioned"),
    sourceLine(line, side),
    normalizePythonName,
  );
}

function tomlSquareBracketDelta(content: string): number {
  let delta = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const character of content) {
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "#") break;
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[") {
      delta += 1;
    } else if (character === "]") {
      delta -= 1;
    }
  }
  return delta;
}

function pyprojectDependencies(
  file: FileDiff,
  side: ManifestSide,
): Dependency[] {
  const results: Dependency[] = [];
  let section = "";
  let projectDependenciesDepth = 0;
  for (const line of linesFor(file, side)) {
    const heading = /^\s*\[([^\]]+)\]\s*$/u.exec(line.content);
    if (heading?.[1]) {
      section = heading[1].toLowerCase();
      projectDependenciesDepth = 0;
      continue;
    }
    const projectDependenciesStart =
      section === "project" && /^\s*dependencies\s*=\s*\[/u.test(line.content);
    const inProjectDependencies =
      projectDependenciesDepth > 0 || projectDependenciesStart;
    const arraySection =
      inProjectDependencies ||
      section === "project.optional-dependencies" ||
      section === "dependency-groups";
    if (arraySection) {
      results.push(...pyprojectArrayDependencies(line, side));
    }
    if (
      section === "tool.poetry.dependencies" ||
      /^tool\.poetry\.group\.[^.]+\.dependencies$/u.test(section)
    ) {
      const item = pyprojectMapDependency(line, side);
      if (item) results.push(item);
    }
    if (projectDependenciesStart) {
      projectDependenciesDepth = Math.max(
        0,
        tomlSquareBracketDelta(line.content),
      );
    } else if (projectDependenciesDepth > 0) {
      projectDependenciesDepth = Math.max(
        0,
        projectDependenciesDepth + tomlSquareBracketDelta(line.content),
      );
    }
  }
  return results;
}

function goModDependencies(file: FileDiff, side: ManifestSide): Dependency[] {
  const results: Dependency[] = [];
  let inRequireBlock = false;
  for (const line of linesFor(file, side)) {
    const content = line.content.replace(/\/\/.*$/u, "").trim();
    if (/^require\s*\($/u.test(content)) {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && content === ")") {
      inRequireBlock = false;
      continue;
    }
    const match = inRequireBlock
      ? /^(\S+)\s+(\S+)$/u.exec(content)
      : /^require\s+(\S+)\s+(\S+)$/u.exec(content);
    if (!match?.[1] || !match[2]) continue;
    results.push(dependency(match[1], match[2], sourceLine(line, side)));
  }
  return results;
}

function cargoSectionIsDependencies(section: string): boolean {
  return (
    /^(?:dev-|build-)?dependencies$/u.test(section) ||
    section === "workspace.dependencies" ||
    /^target\..+\.(?:dev-|build-)?dependencies$/u.test(section)
  );
}

function tomlDependencyKey(value: string): string | undefined {
  const trimmed = value.trim();
  const quoted = /^(?:"([^"]+)"|'([^']+)')$/u.exec(trimmed);
  if (quoted) return quoted[1] ?? quoted[2];
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(trimmed) ? trimmed : undefined;
}

function cargoDependencyTableName(section: string): string | undefined {
  const match =
    /^(?:dev-|build-)?dependencies\.(.+)$/iu.exec(section) ??
    /^workspace\.dependencies\.(.+)$/iu.exec(section) ??
    /^target\..+\.(?:dev-|build-)?dependencies\.(.+)$/iu.exec(section);
  return match?.[1] ? tomlDependencyKey(match[1]) : undefined;
}

function cargoDottedDependency(
  line: ChangedLine,
  side: ManifestSide,
): Dependency | undefined {
  const match =
    /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9][A-Za-z0-9_-]*))\.([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/u.exec(
      line.content,
    );
  const name = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!name || !match?.[4] || !match[5]) return undefined;
  const field = match[4].toLowerCase();
  const quotedValue = /^(?:"([^"]+)"|'([^']+)')$/u.exec(match[5]);
  const value = quotedValue?.[1] ?? quotedValue?.[2];
  let version = "unversioned";
  if (field === "version" && value) {
    version = value;
  } else if (field === "workspace" && /^true$/iu.test(match[5])) {
    version = "workspace";
  } else if (["git", "path", "registry"].includes(field) && value) {
    version = `${field}:${value}`;
  }
  return dependency(name, version, sourceLine(line, side));
}

function cargoDependencies(file: FileDiff, side: ManifestSide): Dependency[] {
  const results: Dependency[] = [];
  let section = "";
  for (const line of linesFor(file, side)) {
    const heading = /^\s*\[([^\]]+)\]\s*$/u.exec(line.content);
    if (heading?.[1]) {
      section = heading[1].toLowerCase();
      const tableName = cargoDependencyTableName(heading[1]);
      if (tableName) {
        results.push(
          dependency(tableName, "unversioned", sourceLine(line, side)),
        );
      }
      continue;
    }
    if (!cargoSectionIsDependencies(section)) continue;
    const dotted = cargoDottedDependency(line, side);
    if (dotted) {
      results.push(dotted);
      continue;
    }
    const match =
      /^\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*=\s*(?:["']([^"']+)["']|\{([^}]*)\})\s*$/u.exec(
        line.content,
      );
    if (!match?.[1]) continue;
    const inlineVersion = match[3]
      ? /\bversion\s*=\s*["']([^"']+)["']/u.exec(match[3])?.[1]
      : undefined;
    results.push(
      dependency(
        match[1],
        match[2] ?? inlineVersion ?? "unversioned",
        sourceLine(line, side),
      ),
    );
  }
  return results;
}

function gemfileDependencies(file: FileDiff, side: ManifestSide): Dependency[] {
  return linesFor(file, side).flatMap((line) => {
    const match =
      /^\s*gem(?:\s+|\s*\(\s*)["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/u.exec(
        line.content,
      );
    return match?.[1]
      ? [
          dependency(
            match[1],
            match[2] ?? "unversioned",
            sourceLine(line, side),
          ),
        ]
      : [];
  });
}

function dependencies(file: FileDiff, side: ManifestSide): Dependency[] {
  const name = manifestName(file.path);
  let results: Dependency[];
  if (/^requirements(?:[-_.][a-z0-9._-]+)?\.(?:txt|in)$/u.test(name)) {
    results = requirementDependencies(file, side);
  } else if (name === "package.json") {
    results = packageDependencies(file, side);
  } else if (name === "pyproject.toml") {
    results = pyprojectDependencies(file, side);
  } else if (name === "composer.json") {
    results = jsonDependencies(file, side, composerSections) ?? [];
  } else if (name === "go.mod") {
    results = goModDependencies(file, side);
  } else if (name === "cargo.toml") {
    results = cargoDependencies(file, side);
  } else if (name === "gemfile") {
    results = gemfileDependencies(file, side);
  } else {
    results = [];
  }
  return unique(results);
}

export const dependencyAddedRule: Rule = {
  id: "dependency-added",
  check({ diff, config }) {
    const results = [];
    for (const file of diff.files) {
      if (!isDependencyManifest(file.path)) continue;
      const before = new Set(
        dependencies(file, "before").map((item) => item.identity),
      );
      for (const declaration of dependencies(file, "after")) {
        if (before.has(declaration.identity)) continue;
        const item = finding(config, this.id, {
          file: file.path,
          ...(declaration.line === undefined ? {} : { line: declaration.line }),
          message: `A dependency declaration for '${declaration.name}' (${declaration.version}) was added to a manifest.`,
          evidence: `${declaration.name}@${declaration.version}`,
          recommendation:
            "Confirm the dependency is necessary, trusted, licensed appropriately, and pinned according to project policy.",
        });
        if (item) results.push(item);
      }
    }
    return results;
  },
};
