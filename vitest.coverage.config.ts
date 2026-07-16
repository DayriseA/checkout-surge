import path from "node:path";

export const COVERAGE_FLOOR = {
  statements: 10,
  branches: 10,
  functions: 10,
  lines: 10,
} as const;

export function createV8CoverageConfig(reportName: string) {
  return {
    provider: "v8" as const,
    include: ["src/**/*.{ts,tsx}"],
    exclude: ["src/**/*.d.ts"],
    reportOnFailure: true,
    reporter: ["text", "json-summary"],
    reportsDirectory: path.join(import.meta.dirname, "coverage", reportName),
    thresholds: COVERAGE_FLOOR,
  };
}
