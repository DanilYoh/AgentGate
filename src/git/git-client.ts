import { execFile } from "node:child_process";
import { lstat, open, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { AgentGateError } from "../errors.js";

const execFileAsync = promisify(execFile);

export interface DiffOptions {
  staged?: boolean;
  base?: string;
}

export interface UntrackedOptions {
  maxFileBytes: number;
  maxTotalBytes: number;
  readTimeoutMs: number;
}

const defaultUntrackedOptions: UntrackedOptions = {
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  readTimeoutMs: 2_000,
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
          () => reject(new AgentGateError(`${description} timed out.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readUntrackedFile(
  path: string,
  options: UntrackedOptions,
): Promise<string> {
  const stats = await withTimeout(
    lstat(path),
    options.readTimeoutMs,
    `Inspecting untracked file ${path}`,
  );
  if (!stats.isFile()) {
    throw new AgentGateError(
      `Refusing to read non-regular untracked file ${path}.`,
    );
  }
  if (stats.size > options.maxFileBytes) {
    throw new AgentGateError(
      `Untracked file ${path} exceeds the ${options.maxFileBytes}-byte scan limit.`,
    );
  }

  const handle = await withTimeout(
    open(path, "r"),
    options.readTimeoutMs,
    `Opening untracked file ${path}`,
  );
  try {
    const openedStats = await withTimeout(
      handle.stat(),
      options.readTimeoutMs,
      `Inspecting opened untracked file ${path}`,
    );
    if (!openedStats.isFile()) {
      throw new AgentGateError(
        `Refusing to read non-regular untracked file ${path}.`,
      );
    }
    if (openedStats.size > options.maxFileBytes) {
      throw new AgentGateError(
        `Untracked file ${path} exceeds the ${options.maxFileBytes}-byte scan limit.`,
      );
    }

    const buffer = Buffer.alloc(options.maxFileBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await withTimeout(
        handle.read(buffer, offset, buffer.length - offset, offset),
        options.readTimeoutMs,
        `Reading untracked file ${path}`,
      );
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > options.maxFileBytes) {
      throw new AgentGateError(
        `Untracked file ${path} exceeds the ${options.maxFileBytes}-byte scan limit.`,
      );
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await withTimeout(
      handle.close(),
      options.readTimeoutMs,
      `Closing untracked file ${path}`,
    );
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

  public constructor(private readonly cwd: string) {}

  private async run(
    args: string[],
    cwd = this.repositoryRoot ?? this.cwd,
    allowedExitCodes: readonly number[] = [],
    maxBuffer = 50 * 1024 * 1024,
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
          windowsHide: true,
        },
      );
      return result.stdout;
    } catch (error: unknown) {
      const candidate = error as {
        code?: number | string;
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
      const detail = candidate.stderr?.trim();
      throw new AgentGateError(
        detail ? `Git failed: ${detail}` : "Unable to run Git.",
        {
          cause: error,
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
      throw new AgentGateError("Git returned an empty repository root.");
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
    return (await this.run(["merge-base", commit, "HEAD"])).trim();
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
      throw new AgentGateError(`${path} at ${commit} is not a regular file.`);
    }
    return this.run(["show", object], undefined, [], maximumPolicyBytes + 1);
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
        : await readUntrackedFile(absolutePath, options);
      totalBytes += Buffer.byteLength(content);
      if (totalBytes > options.maxTotalBytes) {
        throw new AgentGateError(
          `Untracked files exceed the ${options.maxTotalBytes}-byte total scan limit.`,
        );
      }
      result += syntheticUntrackedPatch(
        path,
        content,
        isSymbolicLink ? "120000" : "100644",
      );
    }
    return result;
  }

  public async getDiff(
    options: DiffOptions,
    untrackedOptions: UntrackedOptions = defaultUntrackedOptions,
  ): Promise<string> {
    const root = await this.getRepositoryRoot();
    const common = [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--find-renames=50%",
      "--ignore-submodules=none",
      "--unified=3",
    ];

    if (options.staged) return this.run([...common, "--cached", "--"], root);
    if (options.base) {
      const mergeBase = await this.getMergeBase(options.base);
      const patch = await this.run([...common, mergeBase, "--"], root);
      return this.includeUntracked(patch, root, untrackedOptions);
    }

    const head = await this.getHeadCommit();
    const patch = head
      ? await this.run([...common, "HEAD", "--"], root)
      : await this.run([...common, "--cached", "--"], root);
    return this.includeUntracked(patch, root, untrackedOptions);
  }
}
