import { describe, expect, it } from "vitest";
import { AgentGateError } from "../src/errors.js";
import { validateConfig } from "../src/config/load.js";

describe("configuration", () => {
  it("maps documented error and warning levels", () => {
    const config = validateConfig({
      version: 1,
      failOn: "high",
      rules: { "secret-added": "error", "placeholder-added": "warning" },
    });
    expect(config.rules["secret-added"]).toBe("high");
    expect(config.rules["placeholder-added"]).toBe("medium");
  });

  it("reports an actionable validation path", () => {
    expect(() =>
      validateConfig({ version: 1, limits: { addedLines: -1 } }),
    ).toThrowError(
      new AgentGateError("limits.addedLines must be a non-negative integer."),
    );
  });

  it("rejects unknown rules", () => {
    expect(() =>
      validateConfig({ version: 1, rules: { mystery: "error" } }),
    ).toThrow("rules contains unknown key 'mystery'");
  });
});
