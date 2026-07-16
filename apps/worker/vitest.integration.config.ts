import { defineConfig } from "vitest/config";
import { createV8CoverageConfig } from "../../vitest.coverage.config";

export default defineConfig({
  test: {
    coverage: createV8CoverageConfig("worker-integration"),
    environment: "node",
    hookTimeout: 30_000,
    include: ["test/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
