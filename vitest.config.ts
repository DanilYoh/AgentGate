import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      reporter: ["text", "html"],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 94,
        lines: 92,
      },
    },
    testTimeout: 15_000,
  },
});
