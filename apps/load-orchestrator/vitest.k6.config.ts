import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/k6-compat.test.ts"],
    environment: "node",
  },
});
