import { defineConfig } from "vitest/config";
import { createV8CoverageConfig } from "../../vitest.coverage.config";

export default defineConfig({
  test: {
    coverage: createV8CoverageConfig("gate-unit"),
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
