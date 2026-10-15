import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(__dirname, "../src");
const clientDirective = /^(?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/)*\s*["']use client["']/;
const namedImport = /(?:import|export)\s+(type\s+)?\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/g;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const sources = new Map(sourceFiles(sourceRoot).map((path) => [path, readFileSync(path, "utf8")]));

function resolveModule(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  return [".ts", ".tsx", "/index.ts", "/index.tsx"]
    .map((ext) => base + ext)
    .find((path) => sources.has(path));
}

describe("server and client module boundary", () => {
  it("lets server modules import only components from client modules", () => {
    const violations: string[] = [];
    for (const [path, source] of sources) {
      if (clientDirective.test(source)) continue;
      for (const [, typeOnly, names = "", specifier = ""] of source.matchAll(namedImport)) {
        const target = resolveModule(path, specifier);
        if (typeOnly || !target || !clientDirective.test(sources.get(target) ?? "")) continue;
        for (const name of names.split(",").map((part) => part.trim())) {
          if (/^[a-z]/.test(name) && !name.startsWith("type "))
            violations.push(`${relative(sourceRoot, path)}: ${name}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
