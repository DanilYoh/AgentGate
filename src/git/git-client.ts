import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, opendir, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { AgentGateError } from "../errors.js";

const execFileAsync = promisify(execFile);

export interface DiffOptions {
  staged?: boolean;
  base?: string;
}

export interface UntrackedOptions {
  maxFiles: number;
  maxFileBytes: number;
  maxSymlinkBytes: number;
  maxTotalBytes: number;
  readTimeoutMs: number;
}

export interface GitOptions {
  commandTimeoutMs: number;
  maxDiffBytes: number;
}

export interface GitSnapshot {
  staged: boolean;
  head?: string;
  baseCommit?: string;
  mergeBase?: string;
  indexFingerprint: string;
}

const defaultUntrackedOptions: UntrackedOptions = {
  maxFiles: 10_000,
  maxFileBytes: 1024 * 1024,
  maxSymlinkBytes: 4 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  readTimeoutMs: 2_000,
};
const defaultGitOptions: GitOptions = {
  commandTimeoutMs: 30_000,
  maxDiffBytes: 50 * 1024 * 1024,
};
const maximumPolicyBytes = 1024 * 1024;

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AgentGateError(`${description} timed out.`, {
                code: "RESOURCE_LIMIT",
              }),
            ),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof AgentGateError) throw error;
    throw new AgentGateError(`${description} failed.`, {
      cause: error,
      code: "IO_ERROR",
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readRegularFile(
  path: string,
  maxFileBytes: number,
  readTimeoutMs: number,
  description: string,
): Promise<string> {
  const stats = await withTimeout(
    lstat(path),
    readTimeoutMs,
    `Inspecting ${description}`,
  );
  if (!stats.isFile()) {
    throw new AgentGateError(`Refusing to read non-regular ${description}.`, {
      code: "IO_ERROR",
    });
  }
  if (stats.size > maxFileBytes) {
    throw new AgentGateError(
      `${description} exceeds the ${maxFileBytes}-byte scan limit.`,
      { code: "RESOURCE_LIMIT" },
    );
  }

  const handle = await withTimeout(
    open(path, "r"),
    readTimeoutMs,
    `Opening ${description}`,
  );
  try {
    const openedStats = await withTimeout(
      handle.stat(),
      readTimeoutMs,
      `Inspecting opened ${description}`,
    );
    if (!openedStats.isFile()) {
      throw new AgentGateError(`Refusing to read non-regular ${description}.`, {
        code: "IO_ERROR",
      });
    }
    if (openedStats.size > maxFileBytes) {
      throw new AgentGateError(
        `${description} exceeds the ${maxFileBytes}-byte scan limit.`,
        { code: "RESOURCE_LIMIT" },
      );
    }

    const buffer = Buffer.alloc(maxFileBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await withTimeout(
        handle.read(buffer, offset, buffer.length - offset, offset),
        readTimeoutMs,
        `Reading ${description}`,
      );
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > maxFileBytes) {
      throw new AgentGateError(
        `${description} exceeds the ${maxFileBytes}-byte scan limit.`,
        { code: "RESOURCE_LIMIT" },
      );
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await withTimeout(handle.close(), readTimeoutMs, `Closing ${description}`);
  }
}

function quotePatchPath(path: string, prefix: "a" | "b"): string {
  const value = `${prefix}/${path}`;
  return /[\s"\\]/u.test(value) ? JSON.stringify(value) : value;
}

function syntheticUntrackedPatch(
  path: string,
  content: string,
  mode = "100644",
): string {
  if (content.includes("\0")) {
    const oldPath = quotePatchPath(path, "a");
    const newPath = quotePatchPath(path, "b");
    return `diff --git ${oldPath} ${newPath}\nnew file mode ${mode}\nBinary files /dev/null and ${newPath} differ\n`;
  }
  const normalized = content.replaceAll("\r\n", "\n");
  const oldPath = quotePatchPath(path, "a");
  const newPath = quotePatchPath(path, "b");
  if (normalized.length === 0) {
    return `diff --git ${oldPath} ${newPath}\nnew file mode ${mode}\n--- /dev/null\n+++ ${newPath}\n`;
  }
  const lines = normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
  const body = lines.map((line) => `+${line}`).join("\n");
  return `diff --git ${oldPath} ${newPath}\nnew file mode ${mode}\n--- /dev/null\n+++ ${newPath}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`;
}

export class GitClient {
  private repositoryRoot?: string;
  private gitOptions: GitOptions = { ...defaultGitOptions };

  public constructor(private readonly cwd: string) {}

  public configure(options: GitOptions): void {
    this.gitOptions = { ...options };
  }

  private async run(
    args: string[],
    cwd = this.repositoryRoot ?? this.cwd,
    allowedExitCodes: readonly number[] = [],
    maxBuffer = 50 * 1024 * 1024,
    timeoutMs = this.gitOptions.commandTimeoutMs,
  ): Promise<string> {
    try {
      const result = await execFileAsync(
        "git",
        [
          "--no-pager",
          "-c",
          "core.quotepath=false",
          "-c",
          "core.fsmonitor=false",
          ...args,
        ],
        {
          cwd,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
          encoding: "utf8",
          maxBuffer,
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          windowsHide: true,
        },
      );
      return result.stdout;
    } catch (error: unknown) {
      const candidate = error as {
        code?: number | string;
        killed?: boolean;
        signal?: NodeJS.Signals;
        stdout?: string;
        stderr?: string;
      };
      if (
        typeof candidate.code === "number" &&
        allowedExitCodes.includes(candidate.code) &&
        candidate.stdout !== undefined
      ) {
        return candidate.stdout;
      }
      if (candidate.killed || candidate.signal) {
        throw new AgentGateError(
          `Git command timed out after ${timeoutMs} milliseconds.`,
          { cause: error, code: "RESOURCE_LIMIT" },
        );
      }
      if (candidate.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        throw new AgentGateError(
          `Git output exceeds the ${maxBuffer}-byte process limit.`,
          { cause: error, code: "RESOURCE_LIMIT" },
        );
      }
      const detail = candidate.stderr?.trim();
      throw new AgentGateError(
        detail ? `Git failed: ${detail}` : "Unable to run Git.",
        {
          cause: error,
          code: "GIT_ERROR",
        },
      );
    }
  }

  public async getRepositoryRoot(): Promise<string> {
    if (this.repositoryRoot) return this.repositoryRoot;
    const root = (
      await this.run(["rev-parse", "--show-toplevel"], this.cwd)
    ).trim();
    if (!root)
      throw new AgentGateError("Git returned an empty repository root.", {
        code: "GIT_ERROR",
      });
    this.repositoryRoot = root;
    return root;
  }

  public async getHeadCommit(): Promise<string | undefined> {
    const head = (
      await this.run(
        ["rev-parse", "--verify", "--quiet", "HEAD"],
        undefined,
        [1],
      )
    ).trim();
    return head || undefined;
  }

  private async getIndexFingerprint(): Promise<string> {
    const index = await this.run(["ls-files", "--stage", "-z"]);
    return createHash("sha256").update(index).digest("hex");
  }

  public async captureSnapshot(options: DiffOptions): Promise<GitSnapshot> {
    const head = await this.getHeadCommit();
    if (options.base) {
      if (!head) {
        throw new AgentGateError("--base requires a repository with HEAD.", {
          code: "INVALID_ARGUMENT",
        });
      }
      const baseCommit = await this.resolveCommit(options.base);
      const mergeBase = (
        await this.run(["merge-base", baseCommit, head])
      ).trim();
      if (!mergeBase) {
        throw new AgentGateError("Git returned an empty merge base.", {
          code: "GIT_ERROR",
        });
      }
      return {
        staged: false,
        head,
        baseCommit,
        mergeBase,
        indexFingerprint: await this.getIndexFingerprint(),
      };
    }
    return {
      staged: Boolean(options.staged),
      ...(head ? { head } : {}),
      indexFingerprint: await this.getIndexFingerprint(),
    };
  }

  public async assertSnapshotUnchanged(snapshot: GitSnapshot): Promise<void> {
    const [head, indexFingerprint] = await Promise.all([
      this.getHeadCommit(),
      this.getIndexFingerprint(),
    ]);
    if (
      head !== snapshot.head ||
      indexFingerprint !== snapshot.indexFingerprint
    ) {
      throw new AgentGateError(
        "Repository HEAD or index changed while AgentGate was scanning; retry the check.",
        { code: "SNAPSHOT_CHANGED" },
      );
    }
  }

  public async assertDiffUnchanged(
    snapshot: GitSnapshot,
    untrackedOptions: UntrackedOptions,
    expectedPatch: string,
  ): Promise<void> {
    const actualPatch = await this.getDiff(snapshot, untrackedOptions);
    const digest = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    if (digest(actualPatch) !== digest(expectedPatch)) {
      throw new AgentGateError(
        "Repository changes were modified while AgentGate was scanning; retry the check.",
        { code: "SNAPSHOT_CHANGED" },
      );
    }
  }

  public async assertFullContextDiffUnchanged(
    snapshot: GitSnapshot,
    paths: string[],
    expectedPatch: string,
    reservedBytes: number,
  ): Promise<void> {
    const actualPatch = await this.getFullContextDiff(
      snapshot,
      paths,
      reservedBytes,
    );
    const digest = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    if (digest(actualPatch) !== digest(expectedPatch)) {
      throw new AgentGateError(
        "A dependency manifest was modified while AgentGate was scanning; retry the check.",
        { code: "SNAPSHOT_CHANGED" },
      );
    }
  }

  public async resolveCommit(ref: string): Promise<string> {
    return (
      await this.run([
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${ref}^{commit}`,
      ])
    ).trim();
  }

  public async getMergeBase(ref: string): Promise<string> {
    const commit = await this.resolveCommit(ref);
    const head = await this.getHeadCommit();
    if (!head) {
      throw new AgentGateError("--base requires a repository with HEAD.", {
        code: "INVALID_ARGUMENT",
      });
    }
    return (await this.run(["merge-base", commit, head])).trim();
  }

  public async readFileAt(
    commit: string,
    path: string,
  ): Promise<string | undefined> {
    const object = `${commit}:${path}`;
    const type = (
      await this.run(["cat-file", "-t", object], undefined, [1, 128])
    ).trim();
    if (!type) return undefined;
    if (type !== "blob") {
      throw new AgentGateError(`${path} at ${commit} is not a regular file.`, {
        code: "POLICY_ERROR",
      });
    }
    const size = Number(
      (await this.run(["cat-file", "-s", object], undefined, [], 1024)).trim(),
    );
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new AgentGateError(`Git returned an invalid size for ${path}.`, {
        code: "GIT_ERROR",
      });
    }
    if (size > maximumPolicyBytes) {
      throw new AgentGateError(
        `${path} at ${commit} exceeds ${maximumPolicyBytes} bytes.`,
        { code: "RESOURCE_LIMIT" },
      );
    }
    const source = await this.run(
      ["cat-file", "blob", object],
      undefined,
      [],
      maximumPolicyBytes + 1,
    );
    if (Buffer.byteLength(source) > maximumPolicyBytes) {
      throw new AgentGateError(
        `${path} at ${commit} exceeds ${maximumPolicyBytes} bytes.`,
        { code: "RESOURCE_LIMIT" },
      );
    }
    return source;
  }

  private async assertNoSpecialFiles(root: string): Promise<void> {
    const ignoredOutput = await this.run(
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
      ],
      root,
    );
    const ignoredDirectories = new Set(
      ignoredOutput
        .split("\0")
        .filter((path) => path.endsWith("/"))
        .map((path) => path.slice(0, -1)),
    );

    const visit = async (directory: string, prefix: string): Promise<void> => {
      const entries = await opendir(directory);
      for await (const entry of entries) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (relativePath === ".git") continue;
        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(relativePath)) {
            await visit(join(directory, entry.name), relativePath);
          }
          continue;
        }
        if (entry.isFile() || entry.isSymbolicLink()) continue;
        const ignored = await this.run(
          ["check-ignore", "--", relativePath],
          root,
          [1],
        );
        if (!ignored) {
          throw new AgentGateError(
            `Refusing to inspect non-regular repository path ${relativePath}.`,
            { code: "IO_ERROR" },
          );
        }
      }
    };

    try {
      await visit(root, "");
    } catch (error) {
      if (error instanceof AgentGateError) throw error;
      throw new AgentGateError("Cannot inspect untracked repository paths.", {
        cause: error,
        code: "IO_ERROR",
      });
    }
  }

  private async includeUntracked(
    patch: string,
    root: string,
    options: UntrackedOptions,
  ): Promise<string> {
    const untrackedOutput = await this.run(
      ["ls-files", "--full-name", "--others", "--exclude-standard", "-z"],
      root,
    );
    const paths = untrackedOutput.split("\0").filter(Boolean);
    if (paths.length > options.maxFiles) {
      throw new AgentGateError(
        `Untracked files exceed the ${options.maxFiles}-file scan limit.`,
        { code: "RESOURCE_LIMIT" },
      );
    }
    let result = patch;
    let totalBytes = 0;
    for (const path of paths) {
      const absolutePath = resolve(root, path);
      const stats = await withTimeout(
        lstat(absolutePath),
        options.readTimeoutMs,
        `Inspecting untracked file ${path}`,
      );
      const isSymbolicLink = stats.isSymbolicLink();
      const content = isSymbolicLink
        ? await withTimeout(
            readlink(absolutePath),
            options.readTimeoutMs,
            `Reading untracked symlink ${path}`,
          )
        : await readRegularFile(
            absolutePath,
            options.maxFileBytes,
            options.readTimeoutMs,
            `untracked file ${path}`,
          );
      const contentBytes = Buffer.byteLength(content);
      if (isSymbolicLink && contentBytes > options.maxSymlinkBytes) {
        throw new AgentGateError(
          `Untracked symlink ${path} exceeds the ${options.maxSymlinkBytes}-byte scan limit.`,
          { code: "RESOURCE_LIMIT" },
        );
      }
      totalBytes += contentBytes;
      if (totalBytes > options.maxTotalBytes) {
        throw new AgentGateError(
          `Untracked files exceed the ${options.maxTotalBytes}-byte total scan limit.`,
          { code: "RESOURCE_LIMIT" },
        );
      }
      result += syntheticUntrackedPatch(
        path,
        content,
        isSymbolicLink ? "120000" : "100644",
      );
      if (Buffer.byteLength(result) > this.gitOptions.maxDiffBytes) {
        throw new AgentGateError(
          `Git diff exceeds the ${this.gitOptions.maxDiffBytes}-byte scan limit.`,
          { code: "RESOURCE_LIMIT" },
        );
      }
    }
    return result;
  }

  private assertDiffSize(patch: string): string {
    if (Buffer.byteLength(patch) > this.gitOptions.maxDiffBytes) {
      throw new AgentGateError(
        `Git diff exceeds the ${this.gitOptions.maxDiffBytes}-byte scan limit.`,
        { code: "RESOURCE_LIMIT" },
      );
    }
    return patch;
  }

  private async getUnbornWorkingTreeDiff(
    root: string,
    requestedPaths?: readonly string[],
    maxBytes = this.gitOptions.maxDiffBytes,
  ): Promise<string> {
    const entries = (
      await this.run(["ls-files", "--stage", "--full-name", "-z"], root)
    )
      .split("\0")
      .filter(Boolean);
    const requested = requestedPaths ? new Set(requestedPaths) : undefined;
    let patch = "";

    for (const entry of entries) {
      const divider = entry.indexOf("\t");
      if (divider < 0) {
        throw new AgentGateError("Git returned an invalid index entry.", {
          code: "GIT_ERROR",
        });
      }
      const metadata = entry.slice(0, divider).split(" ");
      const mode = metadata[0];
      const stage = metadata[2];
      const path = entry.slice(divider + 1);
      if (stage !== "0") {
        throw new AgentGateError(
          `Cannot inspect unmerged index-tracked path ${path}.`,
          { code: "GIT_ERROR" },
        );
      }
      if (requested && !requested.has(path)) continue;

      const absolutePath = resolve(root, path);
      let stats;
      try {
        stats = await withTimeout(
          lstat(absolutePath),
          this.gitOptions.commandTimeoutMs,
          `Inspecting index-tracked file ${path}`,
        );
      } catch (error) {
        const cause =
          error instanceof AgentGateError
            ? (error.cause as NodeJS.ErrnoException | undefined)
            : undefined;
        if (cause?.code === "ENOENT") continue;
        throw error;
      }
      if (stats.isDirectory()) {
        if (mode === "160000") {
          throw new AgentGateError(
            `Cannot inspect index-tracked submodule ${path} before the first commit.`,
            { code: "GIT_ERROR" },
          );
        }
        continue;
      }
      if (!stats.isFile() && !stats.isSymbolicLink()) {
        throw new AgentGateError(
          `Refusing to read non-regular index-tracked file ${path}.`,
          { code: "IO_ERROR" },
        );
      }

      const isSymbolicLink = stats.isSymbolicLink();
      const content = isSymbolicLink
        ? await withTimeout(
            readlink(absolutePath),
            this.gitOptions.commandTimeoutMs,
            `Reading index-tracked symlink ${path}`,
          )
        : await readRegularFile(
            absolutePath,
            maxBytes,
            this.gitOptions.commandTimeoutMs,
            `index-tracked file ${path}`,
          );
      patch += syntheticUntrackedPatch(
        path,
        content,
        isSymbolicLink ? "120000" : mode === "100755" ? mode : "100644",
      );
      if (Buffer.byteLength(patch) > maxBytes) {
        throw new AgentGateError(
          `Git diff exceeds the ${this.gitOptions.maxDiffBytes}-byte scan limit.`,
          { code: "RESOURCE_LIMIT" },
        );
      }
    }
    return patch;
  }

  public async getFullContextDiff(
    snapshot: GitSnapshot,
    paths: string[],
    reservedBytes = 0,
  ): Promise<string> {
    if (paths.length === 0) return "";
    const root = await this.getRepositoryRoot();
    const remainingBytes = this.gitOptions.maxDiffBytes - reservedBytes;
    if (remainingBytes <= 0) {
      throw new AgentGateError(
        `Dependency manifest context exceeds the ${this.gitOptions.maxDiffBytes}-byte scan limit.`,
        { code: "RESOURCE_LIMIT" },
      );
    }
    const common = [
      "diff",
      "--text",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--find-renames=50%",
      "--ignore-submodules=none",
      "--unified=2147483647",
    ];
    const literalPaths = [...new Set(paths)]
      .sort((left, right) => left.localeCompare(right))
      .map((path) => `:(literal)${path}`);
    const args = snapshot.staged
      ? [...common, "--cached", "--", ...literalPaths]
      : snapshot.mergeBase
        ? [...common, snapshot.mergeBase, "--", ...literalPaths]
        : snapshot.head
          ? [...common, snapshot.head, "--", ...literalPaths]
          : undefined;
    const patch = args
      ? await this.run(args, root, [], remainingBytes)
      : await this.getUnbornWorkingTreeDiff(
          root,
          literalPaths.map((path) => path.slice(10)),
          remainingBytes,
        );
    if (Buffer.byteLength(patch) > remainingBytes) {
      throw new AgentGateError(
        `Dependency manifest context exceeds the ${this.gitOptions.maxDiffBytes}-byte scan limit.`,
        { code: "RESOURCE_LIMIT" },
      );
    }
    return patch;
  }

  public async getDiff(
    options: DiffOptions | GitSnapshot,
    untrackedOptions: UntrackedOptions = defaultUntrackedOptions,
  ): Promise<string> {
    const root = await this.getRepositoryRoot();
    const snapshot =
      "indexFingerprint" in options
        ? options
        : await this.captureSnapshot(options);
    const common = [
      "diff",
      "--text",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--find-renames=50%",
      "--ignore-submodules=none",
      "--unified=3",
    ];

    if (snapshot.staged) {
      return this.assertDiffSize(
        await this.run(
          [...common, "--cached", "--"],
          root,
          [],
          this.gitOptions.maxDiffBytes,
        ),
      );
    }
    await this.assertNoSpecialFiles(root);
    if (snapshot.mergeBase) {
      const patch = this.assertDiffSize(
        await this.run(
          [...common, snapshot.mergeBase, "--"],
          root,
          [],
          this.gitOptions.maxDiffBytes,
        ),
      );
      return this.includeUntracked(patch, root, untrackedOptions);
    }

    const patch = this.assertDiffSize(
      snapshot.head
        ? await this.run(
            [...common, snapshot.head, "--"],
            root,
            [],
            this.gitOptions.maxDiffBytes,
          )
        : await this.getUnbornWorkingTreeDiff(root),
    );
    return this.includeUntracked(patch, root, untrackedOptions);
  }
}
