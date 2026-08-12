import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { policyTemplate } from "../config/template.js";
import { AgentGateError } from "../errors.js";
import { GitClient } from "../git/git-client.js";
import { safeTextFragment } from "../security/redact.js";

export async function initializePolicy(cwd: string): Promise<string> {
  const root = await new GitClient(cwd).getRepositoryRoot();
  const path = join(root, ".agentgate.yml");
  try {
    await writeFile(path, policyTemplate, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    throw new AgentGateError(
      `Cannot create ${path}; AgentGate never overwrites an existing policy path.`,
      { cause: error, code: "IO_ERROR" },
    );
  }
  return `Created ${safeTextFragment(path)}. Review the policy, then commit it through normal code review before relying on it.`;
}
