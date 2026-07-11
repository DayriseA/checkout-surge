/**
 * Loads and validates everything under results/data/ at module load.
 * A schema mismatch throws here, on purpose — bad data should be loud.
 */
import {
  baseSelectionSchema,
  browserUseTestFindingsFileSchema,
  comparisonClustersFileSchema,
  comparisonEntriesFileSchema,
  clustersFileSchema,
  findingsFileSchema,
  independentFindingsFileSchema,
  modelsFileSchema,
  slicesFileSchema,
  SEVERITY_ORDER,
  VERDICT_ORDER,
  type BrowserUseTestFindingsFile,
  type BaseSelection,
  type ComparisonCluster,
  type ComparisonEntry,
  type ComparisonEntriesFile,
  type Cluster,
  type Finding,
  type FindingsFile,
  type IndependentFinding,
  type IndependentFindingsFile,
  type Model,
  type Severity,
  type Slice,
  type Verdict,
} from "./schema";

import modelsRaw from "../../../results/data/models.json";
import baseSelectionRaw from "../../../results/data/base-selection.json";
import slicesRaw from "../../../results/data/slices.json";
import clustersRaw from "../../../results/data/clusters.json";
import comparisonClustersRaw from "../../../results/data/comparison-clusters.json";
import independentReviewClustersRaw from "../../../results/data/independent-review-clusters.json";

const findingsModules = import.meta.glob("../../../results/data/findings/*.json", {
  eager: true,
  import: "default",
});
const browserUseTestModules = import.meta.glob("../../../results/data/browser-use-test-findings/*.json", {
  eager: true,
  import: "default",
});
const independentFindingsModules = import.meta.glob(
  "../../../results/data/independent-review-findings/*.json",
  { eager: true, import: "default" },
);
const comparisonEntryModules = import.meta.glob("../../../results/data/comparison-entries/*.json", {
  eager: true,
  import: "default",
});
const reportModules = import.meta.glob("../../../results/**/*.md", {
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

export const baseSelection: BaseSelection = parseOrThrow("base-selection.json", () =>
  baseSelectionSchema.parse(baseSelectionRaw),
);

export const slices: Slice[] = parseOrThrow("slices.json", () =>
  slicesFileSchema.parse(slicesRaw),
).slices;

export const findingsFiles: FindingsFile[] = Object.entries(findingsModules).map(
  ([path, raw]) => parseOrThrow(path, () => findingsFileSchema.parse(raw)),
);

export const browserUseTestFiles: BrowserUseTestFindingsFile[] = Object.entries(browserUseTestModules).map(
  ([path, raw]) => parseOrThrow(path, () => browserUseTestFindingsFileSchema.parse(raw)),
);

export const independentFindingsFiles: IndependentFindingsFile[] = Object.entries(
  independentFindingsModules,
).map(([path, raw]) => parseOrThrow(path, () => independentFindingsFileSchema.parse(raw)));

export const comparisonEntryFiles: ComparisonEntriesFile[] = Object.entries(comparisonEntryModules).map(
  ([path, raw]) => parseOrThrow(path, () => comparisonEntriesFileSchema.parse(raw)),
);

export const clusters: Cluster[] = parseOrThrow("clusters.json", () =>
  clustersFileSchema.parse(clustersRaw),
).clusters;

export const comparisonClusters: ComparisonCluster[] = parseOrThrow("comparison-clusters.json", () =>
  comparisonClustersFileSchema.parse(comparisonClustersRaw),
).clusters;

export const independentReviewClusters: Cluster[] = parseOrThrow(
  "independent-review-clusters.json",
  () => clustersFileSchema.parse(independentReviewClustersRaw),
).clusters;

/* ---------- derived views ---------- */

export interface FindingWithModel extends Finding {
  model: string;
}

export const allFindings: FindingWithModel[] = findingsFiles.flatMap((file) =>
  file.findings.map((finding) => ({ ...finding, model: file.model })),
);

export const comparisonEntries: ComparisonEntry[] = comparisonEntryFiles.flatMap((file) =>
  file.entries,
);

export interface IndependentFindingWithContext extends IndependentFinding {
  model: string;
  reviewer: string;
  source: string;
}

export const allIndependentFindings: IndependentFindingWithContext[] =
  independentFindingsFiles.flatMap((file) =>
    file.findings.map((finding) => ({
      ...finding,
      model: file.model,
      reviewer: file.reviewer,
      source: file.source,
    })),
  );

/** Any finding the browser can render in a FindingRow. */
export type BrowsableFinding = FindingWithModel | IndependentFindingWithContext;

/** The fixed reviewer is the same across every independent-review file. */
export const independentReviewer: string | null =
  independentFindingsFiles[0]?.reviewer ?? null;

export function independentReviewFileFor(modelId: string): IndependentFindingsFile | undefined {
  return independentFindingsFiles.find((file) => file.model === modelId);
}

const findingIndex = new Map(allFindings.map((finding) => [finding.id, finding]));
const comparisonEntryIndex = new Map(comparisonEntries.map((entry) => [entry.id, entry]));
const independentFindingIndex = new Map(
  allIndependentFindings.map((finding) => [finding.id, finding]),
);
const browserUseFindingIndex = new Map(
  browserUseTestFiles.flatMap((file) => file.findings.map((finding) => [finding.id, finding])),
);

export function findingById(id: string): FindingWithModel {
  const finding = findingIndex.get(id);
  if (!finding) throw new Error(`Unknown finding id referenced: ${id}`);
  return finding;
}

export function independentFindingById(id: string): IndependentFindingWithContext {
  const finding = independentFindingIndex.get(id);
  if (!finding) throw new Error(`Unknown independent finding id referenced: ${id}`);
  return finding;
}

export function comparisonEntryById(id: string): ComparisonEntry {
  const entry = comparisonEntryIndex.get(id);
  if (!entry) throw new Error(`Unknown comparison entry id referenced: ${id}`);
  return entry;
}

export function browserUseFindingById(id: string) {
  const finding = browserUseFindingIndex.get(id);
  if (!finding) throw new Error(`Unknown browser-use finding id referenced: ${id}`);
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

/** Looks up any results/ markdown by its data-file `source` path (relative to results/). */
export function sourceMarkdown(source: string): string {
  const entry = Object.entries(reportModules).find(([path]) => path.endsWith(`/${source}`));
  if (!entry) throw new Error(`Report file not found: ${source}`);
  return entry[1];
}

export interface ModelStats {
  model: Model;
  total: number;
  bySeverity: Record<Severity, number>;
  notes: number;
}

function computeModelStats(source: BrowsableFinding[]): ModelStats[] {
  return models.map((model) => {
    const findings = source.filter((f) => f.model === model.id && f.tier === "finding");
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
      notes: source.filter((f) => f.model === model.id && f.tier === "note").length,
    };
  });
}

export const modelStats: ModelStats[] = computeModelStats(allFindings);
export const independentModelStats: ModelStats[] = computeModelStats(allIndependentFindings);

/** The fixed comparer is the same across every comparison-entries file. */
export const comparisonReviewer: string | null = comparisonEntryFiles[0]?.reviewer ?? null;

/**
 * Self-audit blind spots: independent-review findings whose issue class the
 * branch's own audit never identified (empty relatedFindingIds).
 */
export interface BlindSpotStats {
  model: Model;
  missed: number;
  total: number;
}

export const independentBlindSpots: BlindSpotStats[] = models.map((model) => {
  const findings = allIndependentFindings.filter(
    (finding) => finding.model === model.id && finding.tier === "finding",
  );
  return {
    model,
    missed: findings.filter((finding) => finding.relatedFindingIds.length === 0).length,
    total: findings.length,
  };
});

export interface BrowserUseStats {
  model: Model;
  total: number;
  selfAuditMissed: number;
  reproduced: number;
}

export const browserUseStats: BrowserUseStats[] = models.map((model) => {
  const findings = browserUseTestFiles.find((file) => file.model === model.id)?.findings ?? [];
  return {
    model,
    total: findings.length,
    selfAuditMissed: findings.filter((f) => f.postFixAssessment === "self-audit-missed").length,
    reproduced: findings.filter((f) => f.postFixAssessment === "self-audit-caught-but-reproduced")
      .length,
  };
});

export interface ComparisonVerdictStats {
  model: Model;
  total: number;
  byVerdict: Record<Verdict, number>;
}

export const comparisonVerdictStats: ComparisonVerdictStats[] = models.map((model) => {
  const entries = comparisonEntries.filter((entry) => entry.model === model.id);
  const byVerdict = Object.fromEntries(
    VERDICT_ORDER.map((verdict) => [
      verdict,
      entries.filter((entry) => entry.verdict === verdict).length,
    ]),
  ) as Record<Verdict, number>;
  return { model, total: entries.length, byVerdict };
});

/** Distinct models represented in a cluster's members. */
export function clusterModelSpan(cluster: Cluster, resolve: (id: string) => BrowsableFinding): number {
  return new Set(cluster.members.map((member) => resolve(member.findingId).model)).size;
}

// referential integrity: every cluster member and notObserved model must exist
for (const cluster of clusters) {
  for (const member of cluster.members) findingById(member.findingId);
  for (const entry of cluster.notObserved ?? []) {
    if (!modelById(entry.model)) {
      throw new Error(`Cluster ${cluster.id} references unknown model ${entry.model}`);
    }
  }
}

for (const cluster of comparisonClusters) {
  for (const member of cluster.members) comparisonEntryById(member.entryId);
}

for (const finding of allIndependentFindings) {
  for (const related of finding.relatedFindingIds) findingById(related);
}

for (const file of browserUseTestFiles) {
  for (const finding of file.findings) {
    for (const relation of finding.relatedIndependentReviewFindings) {
      const related = independentFindingById(relation.findingId);
      if (related.model !== file.model) {
        throw new Error(
          `${finding.id} links an independent-review finding from another model: ${relation.findingId}`,
        );
      }
    }
  }
}

for (const cluster of independentReviewClusters) {
  for (const member of cluster.members) independentFindingById(member.findingId);
  for (const entry of cluster.notObserved ?? []) {
    if (!modelById(entry.model)) {
      throw new Error(`Independent-review cluster ${cluster.id} references unknown model ${entry.model}`);
    }
  }
}

if (!modelById(baseSelection.recommendedBase)) {
  throw new Error(`Base selection references unknown recommended model ${baseSelection.recommendedBase}`);
}

const rankedModels = new Set<string>();
for (const candidate of baseSelection.candidates) {
  if (!modelById(candidate.model)) {
    throw new Error(`Base selection candidate references unknown model ${candidate.model}`);
  }
  if (rankedModels.has(candidate.model)) {
    throw new Error(`Base selection ranks model more than once: ${candidate.model}`);
  }
  rankedModels.add(candidate.model);
  for (const id of candidate.keyEvidence.independentFindingIds) independentFindingById(id);
  for (const id of candidate.keyEvidence.comparisonEntryIds) comparisonEntryById(id);
  for (const id of candidate.keyEvidence.browserFindingIds) browserUseFindingById(id);
}

for (const branchHead of baseSelection.branchHeads) {
  if (!modelById(branchHead.model)) {
    throw new Error(`Base selection branch head references unknown model ${branchHead.model}`);
  }
}

sourceMarkdown(baseSelection.source);
