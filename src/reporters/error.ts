import type { Log } from "sarif";
import { AgentGateError } from "../errors.js";
import type { AgentGateErrorCode } from "../errors.js";
import { safeEvidence, safeTextFragment } from "../security/redact.js";
import { agentGateVersion } from "../version.js";

export interface ReportedError {
  code: AgentGateErrorCode;
  message: string;
}

export function toReportedError(error: unknown): ReportedError {
  if (error instanceof AgentGateError) {
    return {
      code: error.code,
      message: safeTextFragment(safeEvidence(error.message, 1_000)),
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "An unexpected internal error occurred.",
  };
}

export function formatTextError(error: ReportedError): string {
  return `AgentGate error: ${error.message}`;
}

export function formatJsonError(error: ReportedError): string {
  return JSON.stringify(
    {
      version: 1,
      status: "error",
      exitCode: 2,
      error,
    },
    null,
    2,
  );
}

export function formatSarifError(error: ReportedError): string {
  const report: Log = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "AgentGate",
            semanticVersion: agentGateVersion,
          },
        },
        invocations: [
          {
            executionSuccessful: false,
            exitCode: 2,
            toolExecutionNotifications: [
              {
                descriptor: { id: error.code },
                level: "error",
                message: { text: error.message },
              },
            ],
          },
        ],
        results: [],
        properties: {
          agentGate: {
            reportVersion: 1,
            error,
          },
        },
      },
    ],
  };
  return JSON.stringify(report, null, 2);
}
