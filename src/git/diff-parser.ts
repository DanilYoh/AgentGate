import type { ChangedLine, DiffSet, FileDiff } from "../types.js";

function unquoteGitPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  const body = trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed.slice(1);
  let result = "";
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character !== "\\") {
      result += character;
      continue;
    }
    const escaped = body[++index];
    if (escaped === undefined) {
      result += "\\";
      break;
    }
    const namedEscapes: Record<string, string> = {
      a: "\u0007",
      b: "\b",
      t: "\t",
      n: "\n",
      v: "\u000b",
      f: "\f",
      r: "\r",
      '"': '"',
      "\\": "\\",
    };
    if (namedEscapes[escaped] !== undefined) {
      result += namedEscapes[escaped];
      continue;
    }
    if (
      escaped === "u" &&
      /^[0-9A-Fa-f]{4}$/u.test(body.slice(index + 1, index + 5))
    ) {
      result += String.fromCharCode(
        Number.parseInt(body.slice(index + 1, index + 5), 16),
      );
      index += 4;
      continue;
    }
    if (/[0-7]/u.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/u.test(body[index + 1] ?? "")) {
        octal += body[++index];
      }
      result += String.fromCharCode(Number.parseInt(octal, 8));
      continue;
    }
    result += escaped;
  }
  return result;
}

function stripPrefix(value: string): string | undefined {
  const path = unquoteGitPath(value.split("\t", 1)[0] ?? value);
  if (path === "/dev/null") return undefined;
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

function headerPaths(line: string): [string, string] | undefined {
  const value = line.slice("diff --git ".length);
  if (value.startsWith('"')) {
    const matches = value.match(/"(?:\\.|[^"])*"/gu);
    if (matches?.length === 2 && matches[0] && matches[1])
      return [matches[0], matches[1]];
    return undefined;
  }
  const divider = value.indexOf(" b/");
  if (divider < 0) return undefined;
  return [value.slice(0, divider), value.slice(divider + 1)];
}

function newFile(): FileDiff {
  return {
    path: "",
    isNew: false,
    isDeleted: false,
    isBinary: false,
    lines: [],
    additions: [],
    deletions: [],
  };
}

function pushFile(files: FileDiff[], file: FileDiff | undefined): void {
  if (!file) return;
  file.path = file.isDeleted
    ? (file.oldPath ?? file.path)
    : (file.newPath ?? file.oldPath ?? file.path);
  if (file.path) files.push(file);
}

export function parseGitDiff(input: string): DiffSet {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let oldLine = 0;
  let newLine = 0;
  let hunk = 0;
  let inHunk = false;
  let hasBinaryContent = false;

  for (const rawLine of input.replaceAll("\r\n", "\n").split("\n")) {
    if (rawLine.startsWith("diff --git ")) {
      pushFile(files, file);
      file = newFile();
      hasBinaryContent = false;
      const paths = headerPaths(rawLine);
      if (paths) {
        const oldPath = stripPrefix(paths[0]);
        const newPath = stripPrefix(paths[1]);
        if (oldPath) file.oldPath = oldPath;
        if (newPath) file.newPath = newPath;
      }
      inHunk = false;
      continue;
    }
    if (!file) continue;
    if (rawLine.includes("\0")) {
      file.isBinary = true;
      file.lines = [];
      file.additions = [];
      file.deletions = [];
      hasBinaryContent = true;
      inHunk = false;
      continue;
    }
    if (hasBinaryContent) continue;
    if (rawLine.startsWith("new file mode ")) {
      file.isNew = true;
      delete file.oldPath;
      continue;
    }
    if (rawLine.startsWith("deleted file mode ")) {
      file.isDeleted = true;
      delete file.newPath;
      continue;
    }
    if (
      rawLine.startsWith("rename from ") ||
      rawLine.startsWith("copy from ")
    ) {
      file.oldPath = unquoteGitPath(
        rawLine.slice(rawLine.indexOf(" from ") + 6),
      );
      continue;
    }
    if (rawLine.startsWith("rename to ") || rawLine.startsWith("copy to ")) {
      file.newPath = unquoteGitPath(rawLine.slice(rawLine.indexOf(" to ") + 4));
      continue;
    }
    if (
      rawLine.startsWith("Binary files ") ||
      rawLine.startsWith("GIT binary patch")
    ) {
      file.isBinary = true;
      continue;
    }
    if (!inHunk && rawLine.startsWith("--- ")) {
      const oldPath = stripPrefix(rawLine.slice(4));
      if (oldPath) file.oldPath = oldPath;
      else {
        file.isNew = true;
        delete file.oldPath;
      }
      continue;
    }
    if (!inHunk && rawLine.startsWith("+++ ")) {
      const newPath = stripPrefix(rawLine.slice(4));
      if (newPath) file.newPath = newPath;
      else {
        file.isDeleted = true;
        delete file.newPath;
      }
      continue;
    }
    if (rawLine.startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
        hunk += 1;
        inHunk = true;
      }
      continue;
    }
    if (!inHunk || rawLine === "\\ No newline at end of file") continue;

    let line: ChangedLine;
    if (rawLine.startsWith("+")) {
      line = { content: rawLine.slice(1), hunk, newLine, kind: "add" };
      file.lines.push(line);
      file.additions.push(line);
      newLine += 1;
    } else if (rawLine.startsWith("-")) {
      line = { content: rawLine.slice(1), hunk, oldLine, kind: "delete" };
      file.lines.push(line);
      file.deletions.push(line);
      oldLine += 1;
    } else if (rawLine.startsWith(" ")) {
      line = {
        content: rawLine.slice(1),
        hunk,
        oldLine,
        newLine,
        kind: "context",
      };
      file.lines.push(line);
      oldLine += 1;
      newLine += 1;
    }
  }
  pushFile(files, file);

  return {
    files,
    changedFiles: files.length,
    addedLines: files.reduce((total, item) => total + item.additions.length, 0),
    deletedLines: files.reduce(
      (total, item) => total + item.deletions.length,
      0,
    ),
  };
}
