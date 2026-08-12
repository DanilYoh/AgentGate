import { describe, expect, it } from "vitest";
import { scan } from "../src/engine.js";
import { formatJson } from "../src/reporters/json.js";
import { formatSarif } from "../src/reporters/sarif.js";
import { formatText } from "../src/reporters/text.js";
import { metadataForRule } from "../src/rules/metadata.js";
import { addedFile, config, riskySyntheticSecret } from "./fixtures.js";

describe("reporters", () => {
  const secret = riskySyntheticSecret;
  const result = scan(
    addedFile("src/config.ts", [`const token = "${secret}";`]),
    config(),
  );

  it.each([
    ["text", formatText],
    ["json", formatJson],
    ["sarif", formatSarif],
  ])("never reveals a full secret in %s output", (_name, formatter) => {
    const output = formatter(result);
    expect(output).not.toContain(secret);
    expect(output).toContain("[REDACTED]");
  });

  it("produces parseable JSON", () => {
    const report = JSON.parse(formatJson(result)) as Record<string, unknown>;
    expect(report.version).toBe(1);
    expect(report.findings).toBeInstanceOf(Array);
  });

  it("redacts fields before JSON and SARIF serialization", () => {
    const unsafe = structuredClone(result);
    const first = unsafe.findings[0];
    if (!first) throw new Error("fixture did not produce a finding");
    first.file = "src/token=abcdefghijk";

    const json = formatJson(unsafe);
    const sarif = formatSarif(unsafe);
    expect(() => JSON.parse(json) as unknown).not.toThrow();
    expect(() => JSON.parse(sarif) as unknown).not.toThrow();
    expect(json).toContain("[REDACTED]");
    expect(sarif).toContain("REDACTED");
  });

  it("produces the required SARIF 2.1.0 structure", () => {
    const report = JSON.parse(formatSarif(result)) as {
      version: string;
      runs: Array<{
        tool: {
          driver: {
            name: string;
            rules: Array<{ shortDescription: { text: string } }>;
          };
        };
        results: unknown[];
        properties: { suppressedFindings: number };
      }>;
    };
    expect(report.version).toBe("2.1.0");
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]?.tool.driver.name).toBe("AgentGate");
    expect(report.runs[0]?.tool.driver.rules[0]?.shortDescription.text).toBe(
      metadataForRule("secret-added").description,
    );
    expect(report.runs[0]?.results).toHaveLength(1);
    expect(report.runs[0]?.properties.suppressedFindings).toBe(0);
  });

  it("redacts every text field, not only evidence", () => {
    const secret = riskySyntheticSecret;
    const unsafe = structuredClone(result);
    const first = unsafe.findings[0];
    if (!first) throw new Error("fixture did not produce a finding");
    first.file = `src/${secret}.ts`;
    first.message = `Dependency token = "${secret}"`;
    first.recommendation = `Remove ${secret}`;
    for (const formatter of [formatText, formatJson, formatSarif]) {
      const output = formatter(unsafe);
      expect(output).not.toContain(secret);
      expect(output).toContain("REDACTED");
    }
  });

  it("encodes SARIF artifact URIs and supplies rule indexes", () => {
    const unsafe = structuredClone(result);
    const first = unsafe.findings[0];
    if (!first) throw new Error("fixture did not produce a finding");
    first.file = "src/my file#1.ts";
    const report = JSON.parse(formatSarif(unsafe)) as {
      runs: Array<{
        results: Array<{
          ruleIndex: number;
          locations: Array<{
            physicalLocation: { artifactLocation: { uri: string } };
          }>;
        }>;
      }>;
    };
    const sarifResult = report.runs[0]?.results[0];
    expect(sarifResult?.ruleIndex).toBe(0);
    expect(
      sarifResult?.locations[0]?.physicalLocation.artifactLocation.uri,
    ).toBe("src/my%20file%231.ts");
  });

  it("escapes terminal control characters in paths", () => {
    const unsafe = structuredClone(result);
    const first = unsafe.findings[0];
    if (!first) throw new Error("fixture did not produce a finding");
    first.file = "src/line\nbreak\u001b[31m.ts";
    const output = formatText(unsafe);
    expect(output).toContain("src/line\\nbreak\\u001b[31m.ts");
    expect(output).not.toContain("\u001b");
  });

  it("reports audited suppression metadata without leaking its content", () => {
    const suppressed = scan(
      addedFile("src/generated.ts", ["// TODO: generated stub"]),
      config({
        suppressions: [
          {
            ruleId: "placeholder-added",
            path: "src/generated.ts",
            line: 1,
            reason: `Approved with token = "${riskySyntheticSecret}"\n\u001b[31m`,
          },
        ],
      }),
    );

    const text = formatText(suppressed);
    const json = JSON.parse(formatJson(suppressed)) as {
      suppressedFindings: Array<{
        suppression?: { reason: string; source: { location: string } };
      }>;
    };
    const sarif = JSON.parse(formatSarif(suppressed)) as {
      runs: Array<{
        results: unknown[];
        properties: {
          agentGate: { suppressedFindings: unknown[] };
        };
      }>;
    };

    for (const output of [text, JSON.stringify(json), JSON.stringify(sarif)]) {
      expect(output).not.toContain(riskySyntheticSecret);
      expect(output).toContain("REDACTED");
    }
    expect(text).toContain("Source: policy suppressions[0]");
    expect(text).toContain("\\u001b[31m");
    expect(json.suppressedFindings[0]?.suppression?.source.location).toBe(
      "suppressions[0]",
    );
    expect(sarif.runs[0]?.results).toEqual([]);
    expect(sarif.runs[0]?.properties.agentGate.suppressedFindings).toHaveLength(
      1,
    );
  });

  it.each([
    ["info", "note"],
    ["low", "note"],
    ["medium", "warning"],
    ["high", "error"],
    ["critical", "error"],
  ] as const)("maps %s severity to SARIF %s", (severity, expected) => {
    const adjusted = structuredClone(result);
    const first = adjusted.findings[0];
    if (!first) throw new Error("fixture did not produce a finding");
    first.severity = severity;
    const report = JSON.parse(formatSarif(adjusted)) as {
      runs: Array<{ results: Array<{ level: string }> }>;
    };
    expect(report.runs[0]?.results[0]?.level).toBe(expected);
  });
});
