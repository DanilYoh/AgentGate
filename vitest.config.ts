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
        // Windows skips POSIX-only filesystem tests and reports 91.92%.
        lines: 91.9,
      },
    },
    testTimeout: 15_000,
  },
});
