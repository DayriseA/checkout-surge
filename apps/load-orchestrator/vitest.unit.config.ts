import { defineConfig } from "vitest/config";
import { createV8CoverageConfig } from "../../vitest.coverage.config";

export default defineConfig({
  test: {
    coverage: createV8CoverageConfig("load-orchestrator-unit"),
    include: ["test/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    testTimeout: 15_000,
  },
});
