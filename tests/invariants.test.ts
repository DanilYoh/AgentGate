import { describe, expect, it } from "vitest";
import { parseGitDiff } from "../src/git/diff-parser.js";
import { matchesPath } from "../src/path-match.js";
import {
  redactSecrets,
  safeEvidence,
  safeTextFragment,
} from "../src/security/redact.js";

function pseudoRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

describe("parser, glob, and redaction invariants", () => {
  it("never throws or returns inconsistent totals for deterministic fuzz input", () => {
    const random = pseudoRandom(0xa63e_2026);
    const alphabet =
      'diff --git a/b/\\"\n\r\t@+- context0123456789[]{}\u0000\u001bΩ';

    for (let sample = 0; sample < 512; sample += 1) {
      const length = random() % 512;
      let input = "";
      for (let index = 0; index < length; index += 1) {
        input += alphabet[random() % alphabet.length] ?? "";
      }
      const diff = parseGitDiff(input);
      expect(diff.changedFiles).toBe(diff.files.length);
      expect(diff.addedLines).toBe(
        diff.files.reduce((total, file) => total + file.additions.length, 0),
      );
      expect(diff.deletedLines).toBe(
        diff.files.reduce((total, file) => total + file.deletions.length, 0),
      );
      for (const file of diff.files) {
        expect(file.path.length).toBeGreaterThan(0);
        expect(file.additions.every((line) => line.kind === "add")).toBe(true);
        expect(file.deletions.every((line) => line.kind === "delete")).toBe(
          true,
        );
      }
    }
  });

  it("preserves generated line counts and positions across valid patches", () => {
    const random = pseudoRandom(0xd1ff_2026);
    for (let sample = 0; sample < 128; sample += 1) {
      const additions = (random() % 20) + 1;
      const oldStart = (random() % 100) + 1;
      const path = `src/generated-${sample}.ts`;
      const body = Array.from(
        { length: additions },
        (_, index) => `+export const value${index} = ${random()};`,
      ).join("\n");
      const patch = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${oldStart},0 +${oldStart},${additions} @@\n${body}\n`;
      const diff = parseGitDiff(patch);

      expect(diff).toMatchObject({
        changedFiles: 1,
        addedLines: additions,
        deletedLines: 0,
      });
      expect(diff.files[0]?.additions[0]?.newLine).toBe(oldStart);
      expect(diff.files[0]?.additions.at(-1)?.newLine).toBe(
        oldStart + additions - 1,
      );
    }
  });

  it("keeps glob stars within segments and double-stars across directories", () => {
    const random = pseudoRandom(0x610b_2026);
    for (let sample = 0; sample < 256; sample += 1) {
      const segment = `file-${random().toString(36)}`;
      expect(matchesPath(`src/${segment}.ts`, ["src/*.ts"])).toBe(true);
      expect(matchesPath(`src/nested/${segment}.ts`, ["src/*.ts"])).toBe(false);
      expect(matchesPath(`src/nested/${segment}.ts`, ["src/**/*.ts"])).toBe(
        true,
      );
      expect(matchesPath(`./src/${segment}.ts`, ["./src/*.ts"])).toBe(true);
    }
  });

  it("treats regular-expression metacharacters in globs literally", () => {
    expect(
      matchesPath("src/file[1]+(copy).ts", ["src/file[1]+(copy).ts"]),
    ).toBe(true);
    expect(matchesPath("src/file11copy.ts", ["src/file[1]+(copy).ts"])).toBe(
      false,
    );
  });

  const credentialSuffix = "A7cK9mQ2vX5zB8nD4fH6jL0pR3sT1uW";
  it.each([
    `AKIA${"QWERTYUIOPASDFGH"}`,
    `ghp_${credentialSuffix}`,
    `glpat-${credentialSuffix}`,
    `npm_${credentialSuffix}`,
    `xoxb-${credentialSuffix}`,
    `sk_live_${credentialSuffix}`,
    `AIza${credentialSuffix}XyZ9`,
    `eyJ${"A7cK9mQ2vX5z"}.${"B8nD4fH6jL0p"}.${"R3sT1uW9xY2z"}`,
  ])("redacts a complete known credential form: %s", (secret) => {
    const source = `prefix ${secret} suffix`;
    expect(redactSecrets(source)).not.toContain(secret);
    expect(safeEvidence(source)).not.toContain(secret);
    expect(safeTextFragment(source)).not.toContain(secret);
  });

  it.each([
    [
      "multiline PKCS#8 block",
      "-----BEGIN PRIVATE KEY-----\nMIIEAAAArealPayloadOne\n-----END PRIVATE KEY-----",
      "MIIEAAAArealPayloadOne",
    ],
    [
      "escaped-newline RSA block",
      String.raw`-----BEGIN RSA PRIVATE KEY-----\nMIIEAAAArealPayloadTwo\n-----END RSA PRIVATE KEY-----`,
      "MIIEAAAArealPayloadTwo",
    ],
    [
      "same-line OpenSSH material",
      "-----BEGIN OPENSSH PRIVATE KEY-----b3BlbnNzaC1rZXktdjEAAAAArealPayloadThree",
      "realPayloadThree",
    ],
  ])("redacts the payload from a %s", (_name, pem, payload) => {
    const source = `prefix ${pem} suffix`;
    for (const sanitized of [
      redactSecrets(source),
      safeEvidence(source),
      safeTextFragment(source),
    ]) {
      expect(sanitized).not.toContain(payload);
      expect(sanitized).toContain("[REDACTED]");
    }
  });

  it("bounds evidence and escapes every C0/C1 terminal control", () => {
    const controls = Array.from({ length: 160 }, (_, code) =>
      String.fromCodePoint(code),
    ).join("");
    const terminalSafe = safeTextFragment(controls);
    for (let code = 0; code < 160; code += 1) {
      const control = String.fromCodePoint(code);
      if (code <= 31 || code >= 127)
        expect(terminalSafe).not.toContain(control);
    }
    expect(safeEvidence("x".repeat(500), 160)).toHaveLength(160);
    expect(safeEvidence("x".repeat(500), 160).endsWith("…")).toBe(true);
  });
});
