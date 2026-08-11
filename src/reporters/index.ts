import { AgentGateError } from "../errors.js";
import { formatJson } from "./json.js";
import { formatSarif } from "./sarif.js";
import { formatText } from "./text.js";
import type { ScanResult } from "../types.js";

export type OutputFormat = "text" | "json" | "sarif";

export function formatReport(result: ScanResult, format: OutputFormat): string {
  switch (format) {
    case "text":
      return formatText(result);
    case "json":
      return formatJson(result);
    case "sarif":
      return formatSarif(result);
    default:
      throw new AgentGateError(`Unsupported report format: ${String(format)}`);
  }
}
