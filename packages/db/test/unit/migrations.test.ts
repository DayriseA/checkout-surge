import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveMigrationsFolder } from "../../src/migrations.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("migration folder resolution", () => {
  it("resolves the checked-in package folder independently of the process cwd", () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(path.parse(originalCwd).root);
      expect(resolveMigrationsFolder()).toBe(path.join(packageRoot, "drizzle"));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("preserves explicit migration folder overrides", () => {
    expect(resolveMigrationsFolder("/tmp/custom-drizzle")).toBe("/tmp/custom-drizzle");
  });
});
