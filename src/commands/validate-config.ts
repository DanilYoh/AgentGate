import { join } from "node:path";
import { loadConfigWithMetadata } from "../config/load.js";
import { GitClient } from "../git/git-client.js";
import { safeTextFragment } from "../security/redact.js";

export interface ValidateConfigOptions {
  configPath?: string;
  configSha256?: string;
}

export async function validatePolicy(
  cwd: string,
  options: ValidateConfigOptions,
): Promise<string> {
  const requestedPath = options.configPath
    ? options.configPath
    : join(await new GitClient(cwd).getRepositoryRoot(), ".agentgate.yml");
  const loaded = await loadConfigWithMetadata(
    cwd,
    requestedPath,
    options.configSha256,
  );
  return `Valid AgentGate policy: ${safeTextFragment(loaded.path)}\nSHA-256: ${loaded.sha256}`;
}
