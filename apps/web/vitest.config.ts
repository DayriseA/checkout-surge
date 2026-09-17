import { defineConfig } from "vitest/config";
import { createV8CoverageConfig } from "../../vitest.coverage.config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  oxc: false,
  test: {
    coverage: createV8CoverageConfig("web-unit"),
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/dialog-test-shim.ts", "./test/scroll-test-shim.ts"],
  },
});
