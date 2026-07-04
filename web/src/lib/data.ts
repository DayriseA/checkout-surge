/**
 * Loads and validates everything under results/data/ at module load.
 * A schema mismatch throws here, on purpose — bad data should be loud.
 */
import {
  clustersFileSchema,
  comparisonSchema,
  findingsFileSchema,
  manualFindingsFileSchema,
  modelsFileSchema,
  slicesFileSchema,
  SEVERITY_ORDER,
  type Cluster,
  type Comparison,
  type Finding,
  type FindingsFile,
  type ManualFindingsFile,
  type Model,
  type Severity,
  type Slice,
} from "./schema";

import modelsRaw from "../../../results/data/models.json";
import slicesRaw from "../../../results/data/slices.json";
import clustersRaw from "../../../results/data/clusters.json";

const findingsModules = import.meta.glob("../../../results/data/findings/*.json", {
  eager: true,
  import: "default",
});
const manualModules = import.meta.glob("../../../results/data/manual-findings/*.json", {
  eager: true,
  import: "default",
});
const comparisonModules = import.meta.glob("../../../results/data/comparisons/*.json", {
  eager: true,
  import: "default",
});
const reportModules = import.meta.glob("../../../results/*.md", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

function parseOrThrow<T>(label: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new Error(`Invalid data in ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const models: Model[] = parseOrThrow("models.json", () =>
  modelsFileSchema.parse(modelsRaw),
).models;

export const slices: Slice[] = parseOrThrow("slices.json", () =>
  slicesFileSchema.parse(slicesRaw),
).slices;

export const findingsFiles: FindingsFile[] = Object.entries(findingsModules).map(
  ([path, raw]) => parseOrThrow(path, () => findingsFileSchema.parse(raw)),
);

export const manualFiles: ManualFindingsFile[] = Object.entries(manualModules).map(
  ([path, raw]) => parseOrThrow(path, () => manualFindingsFileSchema.parse(raw)),
);

export const comparisons: Comparison[] = Object.entries(comparisonModules).map(
  ([path, raw]) => parseOrThrow(path, () => comparisonSchema.parse(raw)),
);

export const clusters: Cluster[] = parseOrThrow("clusters.json", () =>
  clustersFileSchema.parse(clustersRaw),
).clusters;

/* ---------- derived views ---------- */

export interface FindingWithModel extends Finding {
  model: string;
}

export const allFindings: FindingWithModel[] = findingsFiles.flatMap((file) =>
  file.findings.map((finding) => ({ ...finding, model: file.model })),
);

const findingIndex = new Map(allFindings.map((finding) => [finding.id, finding]));

export function findingById(id: string): FindingWithModel {
  const finding = findingIndex.get(id);
  if (!finding) throw new Error(`Unknown finding id referenced: ${id}`);
  return finding;
}

export function modelById(id: string): Model | undefined {
  return models.find((model) => model.id === id);
}

export function sliceById(id: number): Slice | undefined {
  return slices.find((slice) => slice.id === id);
}

export function reportMarkdown(model: Model): string {
  const entry = Object.entries(reportModules).find(([path]) =>
    path.endsWith(`/${model.reportFile}`),
  );
  if (!entry) throw new Error(`Report file not found for ${model.id}: ${model.reportFile}`);
  return entry[1];
}

export interface ModelStats {
  model: Model;
  total: number;
  bySeverity: Record<Severity, number>;
  notes: number;
}

export const modelStats: ModelStats[] = models.map((model) => {
  const findings = allFindings.filter((f) => f.model === model.id && f.tier === "finding");
  const bySeverity = Object.fromEntries(
    SEVERITY_ORDER.map((severity) => [
      severity,
      findings.filter((f) => f.severity === severity).length,
    ]),
  ) as Record<Severity, number>;
  return {
    model,
    total: findings.length,
    bySeverity,
    notes: allFindings.filter((f) => f.model === model.id && f.tier === "note").length,
  };
});

// referential integrity: every cluster member and notObserved model must exist
for (const cluster of clusters) {
  for (const member of cluster.members) findingById(member.findingId);
  for (const entry of cluster.notObserved ?? []) {
    if (!modelById(entry.model)) {
      throw new Error(`Cluster ${cluster.id} references unknown model ${entry.model}`);
    }
  }
}
