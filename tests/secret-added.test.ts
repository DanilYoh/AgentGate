import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import { parseGitDiff } from "../src/git/diff-parser.js";
import { secretAddedRule } from "../src/rules/secret-added.js";
import { redactSecrets } from "../src/security/redact.js";
import { riskySyntheticSecret } from "./fixtures.js";

describe("secret-added", () => {
  it("finds and masks an added token", () => {
    const secret = riskySyntheticSecret;
    const diff = parseGitDiff(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -0,0 +1 @@
+const token = "${secret}";
`);
    const findings = secretAddedRule.check({ diff, config: defaultConfig });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence).not.toContain(secret);
    expect(findings[0]?.evidence).toContain("[REDACTED]");
  });

  it("ignores deleted secrets", () => {
    const diff = parseGitDiff(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +0,0 @@
-const token = "ghp_1234567890abcdefghijklmnop";
`);
    expect(secretAddedRule.check({ diff, config: defaultConfig })).toEqual([]);
  });

  it("does not flag an obvious example token but still redacts it", () => {
    const example = "ghp_1234567890abcdefghijklmnop";
    const source = `const token = "${example}";`;
    const diff = parseGitDiff(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -0,0 +1 @@
+${source}
`);
    expect(secretAddedRule.check({ diff, config: defaultConfig })).toEqual([]);
    expect(redactSecrets(source)).not.toContain(example);
  });

  it.each([
    "const token = process.env.TOKEN;",
    "const apiKey = config.apiKey;",
    "const password = secretService.fetchPassword();",
    "const token = SECRET_VALUE;",
    'const password = include_str!("password.txt");',
    'password: "vault://team/service/password"',
    'password: "example_password"',
    "token: ${TOKEN}",
  ])("does not flag a reference or placeholder: %s", (source) => {
    const diff = parseGitDiff(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -0,0 +1 @@
+${source}
`);
    expect(secretAddedRule.check({ diff, config: defaultConfig })).toEqual([]);
  });

  it.each([
    'client_secret = "s3cure-literal-value"',
    `password = "it's-a-secret-123"`,
    'password = "abc12345\\"rest67890"',
    "aws_secret_access_key: AbCdEf1234567890+/value",
    "database_password = correct-horse-123",
    "repository = https://abcdefghijklmnop@example.invalid/repo.git",
  ])("finds a likely assigned secret: %s", (source) => {
    const diff = parseGitDiff(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -0,0 +1 @@
+${source}
`);
    const findings = secretAddedRule.check({ diff, config: defaultConfig });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence).toContain("[REDACTED]");
  });
});
