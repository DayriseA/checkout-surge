import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/{contracts,logger}/test/**/*.test.ts"],
  },
});
