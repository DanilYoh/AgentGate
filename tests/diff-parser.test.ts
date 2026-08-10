import { describe, expect, it } from "vitest";
import { parseGitDiff } from "../src/git/diff-parser.js";

describe("parseGitDiff", () => {
  it("parses additions, deletions, paths, and line numbers", () => {
    const diff = parseGitDiff(`diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -2,2 +2,2 @@
-const old = true;
+const token = "secret-value";
 context
`);
    expect(diff).toMatchObject({
      changedFiles: 1,
      addedLines: 1,
      deletedLines: 1,
    });
    expect(diff.files[0]).toMatchObject({
      path: "src/a.ts",
      isNew: false,
      isDeleted: false,
    });
    expect(diff.files[0]?.additions[0]).toEqual({
      content: 'const token = "secret-value";',
      hunk: 1,
      newLine: 2,
      kind: "add",
    });
  });

  it("parses a new file", () => {
    const diff = parseGitDiff(`diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,1 @@
+hello
`);
    expect(diff.files[0]).toMatchObject({ path: "new.txt", isNew: true });
    expect(diff.files[0]?.oldPath).toBeUndefined();
  });

  it("keeps binary files that have no text headers", () => {
    const diff = parseGitDiff(`diff --git a/image.png b/image.png
new file mode 100644
Binary files /dev/null and b/image.png differ
`);
    expect(diff).toMatchObject({
      changedFiles: 1,
      addedLines: 0,
      deletedLines: 0,
    });
    expect(diff.files[0]).toMatchObject({
      path: "image.png",
      isNew: true,
      isBinary: true,
    });
  });

  it("parses quoted paths containing spaces", () => {
    const diff = parseGitDiff(`diff --git "a/my file.txt" "b/my file.txt"
--- "a/my file.txt"
+++ "b/my file.txt"
@@ -0,0 +1 @@
+hello
`);
    expect(diff.files[0]).toMatchObject({ path: "my file.txt" });
  });

  it("uses rename metadata for old and new paths", () => {
    const diff =
      parseGitDiff(`diff --git a/secure/old name.txt b/src/new name.txt
similarity index 100%
rename from secure/old name.txt
rename to src/new name.txt
`);
    expect(diff.files[0]).toMatchObject({
      path: "src/new name.txt",
      oldPath: "secure/old name.txt",
      newPath: "src/new name.txt",
      isNew: false,
      isDeleted: false,
    });
  });

  it("clears the synthetic header path for a deleted file", () => {
    const diff = parseGitDiff(`diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-old
`);
    expect(diff.files[0]).toMatchObject({
      path: "old.txt",
      oldPath: "old.txt",
      isDeleted: true,
    });
    expect(diff.files[0]?.newPath).toBeUndefined();
  });

  it("decodes Git C-style control escapes in rename paths", () => {
    const diff = parseGitDiff(`diff --git "a/odd\\aname.txt" "b/new\\nname.txt"
similarity index 100%
rename from "odd\\aname.txt"
rename to "new\\nname.txt"
`);
    expect(diff.files[0]?.oldPath).toBe("odd\u0007name.txt");
    expect(diff.files[0]?.newPath).toBe("new\nname.txt");
  });

  it("decodes JSON unicode escapes used by synthetic untracked patches", () => {
    const diff =
      parseGitDiff(`diff --git "a/odd\\u0007name.txt" "b/odd\\u0007name.txt"
new file mode 100644
--- /dev/null
+++ "b/odd\\u0007name.txt"
`);
    expect(diff.files[0]?.path).toBe("odd\u0007name.txt");
  });
});
