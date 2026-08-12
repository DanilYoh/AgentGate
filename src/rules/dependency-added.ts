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

function pyprojectDependencies(
  file: FileDiff,
  side: ManifestSide,
): Dependency[] {
  const results: Dependency[] = [];
  let section = "";
  let inProjectDependencies = false;
  for (const line of linesFor(file, side)) {
    const heading = /^\s*\[([^\]]+)\]\s*$/u.exec(line.content);
    if (heading?.[1]) {
      section = heading[1].toLowerCase();
      inProjectDependencies = false;
      continue;
    }
    if (
      section === "project" &&
      /^\s*dependencies\s*=\s*\[/u.test(line.content)
    ) {
      inProjectDependencies = true;
    }
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
    if (inProjectDependencies && line.content.includes("]")) {
      inProjectDependencies = false;
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

function cargoDependencies(file: FileDiff, side: ManifestSide): Dependency[] {
  const results: Dependency[] = [];
  let section = "";
  for (const line of linesFor(file, side)) {
    const heading = /^\s*\[([^\]]+)\]\s*$/u.exec(line.content);
    if (heading?.[1]) {
      section = heading[1].toLowerCase();
      continue;
    }
    if (!cargoSectionIsDependencies(section)) continue;
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
      /^\s*gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/u.exec(
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
