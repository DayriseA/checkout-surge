import { defineConfig } from "vitest/config";
import { createV8CoverageConfig } from "../../vitest.coverage.config";

export default defineConfig({
  test: {
    coverage: createV8CoverageConfig("mock-erp-integration"),
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
