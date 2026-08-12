export type AgentGateErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_CONFIG"
  | "POLICY_ERROR"
  | "POLICY_HASH_MISMATCH"
  | "GIT_ERROR"
  | "RESOURCE_LIMIT"
  | "SNAPSHOT_CHANGED"
  | "IO_ERROR"
  | "INTERNAL_ERROR";

export interface AgentGateErrorOptions extends ErrorOptions {
  code?: AgentGateErrorCode;
}

export class AgentGateError extends Error {
  public readonly code: AgentGateErrorCode;

  public constructor(message: string, options?: AgentGateErrorOptions) {
    super(message, options);
    this.name = "AgentGateError";
    this.code = options?.code ?? "INTERNAL_ERROR";
  }
}
