import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    hookTimeout: 30_000,
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
