import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const adminRouteRoot = join(process.cwd(), "src/app/api/admin");
const routeFiles = findRouteFiles(adminRouteRoot);

describe("admin route architecture", () => {
  it("keeps privileged proxy credentials behind the opaque capability", () => {
    const forbidden = ["requireAdminSession", "requireControlServiceToken", "controlTokenHeaders"];
    for (const file of routeFiles) {
      const source = readFileSync(file, "utf8");
      for (const symbol of forbidden)
        expect(source, relative(adminRouteRoot, file)).not.toContain(symbol);
    }
  });

  it("routes every private admin proxy method through the central capability", () => {
    for (const file of routeFiles.filter((file) => !file.endsWith("/session/route.ts"))) {
      const source = readFileSync(file, "utf8");
      expect(source, relative(adminRouteRoot, file)).toContain("authorizeAdminProxy");
      expect(source, relative(adminRouteRoot, file)).toContain("admin.proxyJson");
    }
    const erpChaos = readFileSync(join(adminRouteRoot, "erp-chaos/route.ts"), "utf8");
    expect(erpChaos).toContain("export async function GET");
    expect(erpChaos).toContain("return proxyJson");
  });
});

function findRouteFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? findRouteFiles(path) : entry.name === "route.ts" ? [path] : [];
  });
}
