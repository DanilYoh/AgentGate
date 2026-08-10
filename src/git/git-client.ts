import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { AgentGateError } from "../errors.js";

const execFileAsync = promisify(execFile);

export interface DiffOptions {
  staged?: boolean;
  base?: string;
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
          maxBuffer: 50 * 1024 * 1024,
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

  private async includeUntracked(patch: string, root: string): Promise<string> {
    const untrackedOutput = await this.run(
      ["ls-files", "--full-name", "--others", "--exclude-standard", "-z"],
      root,
    );
    const paths = untrackedOutput.split("\0").filter(Boolean);
    let result = patch;
    for (const path of paths) {
      try {
        const absolutePath = resolve(root, path);
        const stats = await lstat(absolutePath);
        const isSymbolicLink = stats.isSymbolicLink();
        const content = isSymbolicLink
          ? await readlink(absolutePath)
          : await readFile(absolutePath, "utf8");
        result += syntheticUntrackedPatch(
          path,
          content,
          isSymbolicLink ? "120000" : "100644",
        );
      } catch {
        const oldPath = quotePatchPath(path, "a");
        const newPath = quotePatchPath(path, "b");
        result += `diff --git ${oldPath} ${newPath}\nnew file mode 100644\nBinary files /dev/null and ${newPath} differ\n`;
      }
    }
    return result;
  }

  public async getDiff(options: DiffOptions): Promise<string> {
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
      const baseCommit = (
        await this.run(
          [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${options.base}^{commit}`,
          ],
          root,
        )
      ).trim();
      const mergeBase = (
        await this.run(["merge-base", baseCommit, "HEAD"], root)
      ).trim();
      const patch = await this.run([...common, mergeBase, "--"], root);
      return this.includeUntracked(patch, root);
    }

    const head = (
      await this.run(["rev-parse", "--verify", "--quiet", "HEAD"], root, [1])
    ).trim();
    const patch = head
      ? await this.run([...common, "HEAD", "--"], root)
      : await this.run([...common, "--cached", "--"], root);
    return this.includeUntracked(patch, root);
  }
}
