import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { scan } from "../src/engine.js";
import { AgentGateError } from "../src/errors.js";
import {
  formatJsonError,
  formatSarifError,
  toReportedError,
} from "../src/reporters/error.js";
import { formatJson } from "../src/reporters/json.js";
import { addedFile, config, riskySyntheticSecret } from "./fixtures.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportSchema = JSON.parse(
  readFileSync(
    resolve(projectRoot, "schemas", "agentgate-report-v1.schema.json"),
    "utf8",
  ),
) as object;
const validateReport = new Ajv2020({ allErrors: true }).compile(reportSchema);

describe("machine-readable errors", () => {
  it("emits a stable JSON exit-2 envelope accepted by the report schema", () => {
    const reported = toReportedError(
      new AgentGateError("Configuration version must be 1.", {
        code: "INVALID_CONFIG",
      }),
    );
    const report = JSON.parse(formatJsonError(reported)) as {
      version: number;
      status: string;
      exitCode: number;
      error: { code: string; message: string };
    };

    expect(report).toEqual({
      version: 1,
      status: "error",
      exitCode: 2,
      error: {
        code: "INVALID_CONFIG",
        message: "Configuration version must be 1.",
      },
    });
    expect(validateReport(report), JSON.stringify(validateReport.errors)).toBe(
      true,
    );
  });

  it("emits a failed SARIF invocation without active results", () => {
    const report = JSON.parse(
      formatSarifError(
        toReportedError(
          new AgentGateError("Git failed.", { code: "GIT_ERROR" }),
        ),
      ),
    ) as {
      version: string;
      runs: Array<{
        results: unknown[];
        invocations: Array<{
          executionSuccessful: boolean;
          exitCode: number;
          toolExecutionNotifications: Array<{
            descriptor: { id: string };
          }>;
        }>;
      }>;
    };

    expect(report.version).toBe("2.1.0");
    expect(report.runs[0]?.results).toEqual([]);
    expect(report.runs[0]?.invocations[0]).toMatchObject({
      executionSuccessful: false,
      exitCode: 2,
    });
    expect(
      report.runs[0]?.invocations[0]?.toolExecutionNotifications[0]?.descriptor
        .id,
    ).toBe("GIT_ERROR");
  });

  it("does not expose unknown exceptions or secrets in known exceptions", () => {
    const unknown = toReportedError(
      new Error(`private failure ${riskySyntheticSecret}`),
    );
    expect(unknown).toEqual({
      code: "INTERNAL_ERROR",
      message: "An unexpected internal error occurred.",
    });

    const known = toReportedError(
      new AgentGateError(`token = "${riskySyntheticSecret}"\n\u001b[31m`, {
        code: "POLICY_ERROR",
      }),
    );
    const output = formatJsonError(known);
    expect(output).not.toContain(riskySyntheticSecret);
    expect(output).not.toContain("\u001b");
    expect(output).toContain("REDACTED");
  });

  it("keeps the existing success JSON shape valid under schema v1", () => {
    const result = scan(addedFile("src/a.ts", ["// TODO: finish"]), config());
    const report = JSON.parse(formatJson(result)) as unknown;
    expect(validateReport(report), JSON.stringify(validateReport.errors)).toBe(
      true,
    );
    expect(report).not.toHaveProperty("status");
  });
});
