import { defaultConfig } from "../src/config/defaults.js";
import { parseGitDiff } from "../src/git/diff-parser.js";
import type { AgentGateConfig, DiffSet } from "../src/types.js";

export const riskySyntheticSecret = "ghp_A7cK9mQ2vX5zB8nD4fH6jL0pR3sT1uW";

type ConfigOverrides = Omit<Partial<AgentGateConfig>, "limits" | "rules"> & {
  limits?: Partial<AgentGateConfig["limits"]>;
  rules?: Partial<AgentGateConfig["rules"]>;
};

export function config(overrides: ConfigOverrides = {}): AgentGateConfig {
  return {
    ...structuredClone(defaultConfig),
    ...overrides,
    limits: { ...defaultConfig.limits, ...overrides.limits },
    rules: { ...defaultConfig.rules, ...overrides.rules },
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
