import { basename } from "node:path";
import { finding } from "./helpers.js";
import type { ChangedLine, FileDiff, Rule } from "../types.js";

interface Dependency {
  name: string;
  version: string;
  line?: number;
}

const packageRootKeys = new Set([
  "name",
  "version",
  "description",
  "main",
  "module",
  "types",
  "type",
  "license",
  "author",
  "bin",
  "bugs",
  "config",
  "directories",
  "engines",
  "exports",
  "files",
  "funding",
  "homepage",
  "imports",
  "man",
  "packageManager",
  "private",
  "publishConfig",
  "repository",
  "scripts",
  "workspaces",
  "node",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "python",
  "requires-python",
]);

const dependencySections = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);

function requirement(line: ChangedLine): Dependency | undefined {
  const match =
    /^\s*([A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]+\])?)(?:\s*((?:===|==|~=|>=|<=|>|<|!=).+?|@\s*\S+))?\s*(?:;.*)?$/u.exec(
      line.content,
    );
  if (!match?.[1]) return undefined;
  return {
    name: match[1],
    version: match[2] ?? "unversioned",
    ...(line.newLine === undefined ? {} : { line: line.newLine }),
  };
}

function packageDependency(
  line: ChangedLine,
  insideDependencySection: boolean,
): Dependency | undefined {
  const match = /^\s*"([^"]+)"\s*:\s*"([^"]+)"\s*,?\s*$/u.exec(line.content);
  if (!match?.[1] || !match[2] || packageRootKeys.has(match[1]))
    return undefined;
  const versionLike = insideDependencySection
    ? /\S/u
    : /^(?:[~^<>=*]|\d|v\d|workspace:|file:|link:|npm:)/u;
  if (!versionLike.test(match[2])) return undefined;
  return {
    name: match[1],
    version: match[2],
    ...(line.newLine === undefined ? {} : { line: line.newLine }),
  };
}

function packageDependencies(
  file: FileDiff,
  kind: "add" | "delete",
): Dependency[] {
  const results: Dependency[] = [];
  let currentHunk = -1;
  let insideDependencySection = false;
  let insideOtherObject = false;
  for (const line of file.lines) {
    const lineHunk = line.hunk ?? 0;
    if (lineHunk !== currentHunk) {
      currentHunk = lineHunk;
      insideDependencySection = false;
      insideOtherObject = false;
    }
    const objectStart = /^\s*"([^"]+)"\s*:\s*\{\s*$/u.exec(line.content);
    if (objectStart?.[1]) {
      insideDependencySection = dependencySections.has(objectStart[1]);
      insideOtherObject = !insideDependencySection;
      continue;
    }
    if (/^\s*\}\s*,?\s*$/u.test(line.content)) {
      insideDependencySection = false;
      insideOtherObject = false;
      continue;
    }
    if (line.kind !== kind || insideOtherObject) continue;
    const dependency = packageDependency(line, insideDependencySection);
    if (dependency) results.push(dependency);
  }
  return results;
}

function pyprojectArrayDependencies(line: ChangedLine): Dependency[] {
  const results: Dependency[] = [];
  const pattern =
    /["']([A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]+\])?)(\s*(?:(?:===|==|~=|>=|<=|>|<|!=)[^"']+?|@\s*[^"']+))?["']/gu;
  for (const match of line.content.matchAll(pattern)) {
    if (!match[1]) continue;
    results.push({
      name: match[1],
      version: match[2]?.trim() ?? "unversioned",
      ...(line.newLine === undefined ? {} : { line: line.newLine }),
    });
  }
  return results;
}

function pyprojectMapDependency(line: ChangedLine): Dependency | undefined {
  const mapMatch =
    /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*["']([^"']+)["']/u.exec(
      line.content,
    );
  if (mapMatch?.[1] && mapMatch[2] && !packageRootKeys.has(mapMatch[1])) {
    return {
      name: mapMatch[1],
      version: mapMatch[2],
      ...(line.newLine === undefined ? {} : { line: line.newLine }),
    };
  }
  const inlineMatch =
    /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*\{([^}]*)\}\s*$/u.exec(
      line.content,
    );
  if (
    !inlineMatch?.[1] ||
    !inlineMatch[2] ||
    packageRootKeys.has(inlineMatch[1])
  ) {
    return undefined;
  }
  const version = /\bversion\s*=\s*["']([^"']+)["']/u.exec(inlineMatch[2])?.[1];
  const source = /\b(git|url|path)\s*=\s*["']([^"']+)["']/u.exec(
    inlineMatch[2],
  );
  return {
    name: inlineMatch[1],
    version:
      version ??
      (source?.[1] && source[2] ? `${source[1]}:${source[2]}` : "unversioned"),
    ...(line.newLine === undefined ? {} : { line: line.newLine }),
  };
}

function pyprojectDependencies(
  file: FileDiff,
  kind: "add" | "delete",
): Dependency[] {
  const results: Dependency[] = [];
  let section = "";
  let inProjectDependencies = false;
  let currentHunk = -1;
  for (const line of file.lines) {
    const lineHunk = line.hunk ?? 0;
    if (lineHunk !== currentHunk) {
      currentHunk = lineHunk;
      section = "";
      inProjectDependencies = false;
    }
    const heading = /^\s*\[([^\]]+)\]\s*$/u.exec(line.content);
    if (heading?.[1]) {
      section = heading[1].toLowerCase();
      inProjectDependencies = false;
      continue;
    }
    if (/^\s*dependencies\s*=\s*\[/u.test(line.content))
      inProjectDependencies = true;
    const relevantLine = line.kind === kind;
    const arraySection =
      inProjectDependencies ||
      section === "project.optional-dependencies" ||
      section === "dependency-groups";
    if (relevantLine && arraySection) {
      results.push(...pyprojectArrayDependencies(line));
    }
    if (relevantLine && section === "tool.poetry.dependencies") {
      const dependency = pyprojectMapDependency(line);
      if (dependency) results.push(dependency);
    }
    if (inProjectDependencies && line.content.includes("]"))
      inProjectDependencies = false;
  }
  return results;
}

function dependencies(file: FileDiff, kind: "add" | "delete"): Dependency[] {
  const lines = kind === "add" ? file.additions : file.deletions;
  const name = basename(file.path).toLowerCase();
  if (name === "requirements.txt")
    return lines.flatMap((line) => requirement(line) ?? []);
  if (name === "package.json") return packageDependencies(file, kind);
  if (name === "pyproject.toml") return pyprojectDependencies(file, kind);
  return [];
}

export const dependencyAddedRule: Rule = {
  id: "dependency-added",
  check({ diff, config }) {
    const results = [];
    for (const file of diff.files) {
      const removedNames = new Set(
        dependencies(file, "delete").map((item) => item.name.toLowerCase()),
      );
      for (const dependency of dependencies(file, "add")) {
        if (removedNames.has(dependency.name.toLowerCase())) continue;
        const item = finding(config, this.id, {
          file: file.path,
          ...(dependency.line === undefined ? {} : { line: dependency.line }),
          message: `New dependency '${dependency.name}' (${dependency.version}) was added.`,
          evidence: `${dependency.name}@${dependency.version}`,
          recommendation:
            "Confirm the dependency is necessary, trusted, licensed appropriately, and pinned according to project policy.",
        });
        if (item) results.push(item);
      }
    }
    return results;
  },
};
