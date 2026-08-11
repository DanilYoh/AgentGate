import { defaultConfig } from "../src/config/defaults.js";
import { parseGitDiff } from "../src/git/diff-parser.js";
import type { AgentGateConfig, DiffSet } from "../src/types.js";

export const riskySyntheticSecret = "ghp_A7cK9mQ2vX5zB8nD4fH6jL0pR3sT1uW";

type ConfigOverrides = Omit<
  Partial<AgentGateConfig>,
  "limits" | "rules" | "ruleExcludePaths" | "untracked"
> & {
  limits?: Partial<AgentGateConfig["limits"]>;
  rules?: Partial<AgentGateConfig["rules"]>;
  ruleExcludePaths?: Partial<AgentGateConfig["ruleExcludePaths"]>;
  untracked?: Partial<AgentGateConfig["untracked"]>;
};

export function config(overrides: ConfigOverrides = {}): AgentGateConfig {
  return {
    ...structuredClone(defaultConfig),
    ...overrides,
    limits: { ...defaultConfig.limits, ...overrides.limits },
    rules: { ...defaultConfig.rules, ...overrides.rules },
    ruleExcludePaths: {
      ...defaultConfig.ruleExcludePaths,
      ...overrides.ruleExcludePaths,
    },
    untracked: { ...defaultConfig.untracked, ...overrides.untracked },
  };
}

export function addedFile(path: string, lines: string[]): DiffSet {
  return parseGitDiff(`diff --git a/${path} b/${path}
new file mode 100644
--- /dev/null
+++ b/${path}
@@ -0,0 +1,${lines.length} @@
${lines.map((line) => `+${line}`).join("\n")}
`);
}
