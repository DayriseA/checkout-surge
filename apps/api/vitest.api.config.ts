import { defineConfig } from "vitest/config";
import { createV8CoverageConfig } from "../../vitest.coverage.config";

export default defineConfig({
  test: {
    coverage: createV8CoverageConfig("api-service"),
    environment: "node",
    hookTimeout: 30_000,
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
