/**
 * Validates everything under results/data/ against the app schemas, checks
 * referential integrity, and verifies each finding's section can be located
 * in its source report. Run with: npm run check-data  (Node ≥ 23.6)
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  browserUseTestFindingsFileSchema,
  comparisonClustersFileSchema,
  comparisonEntriesFileSchema,
  clustersFileSchema,
  findingsFileSchema,
  independentFindingsFileSchema,
  modelsFileSchema,
  slicesFileSchema,
} from "../src/lib/schema.ts";
import { extractSection } from "../src/lib/report-sections.ts";

const dataDir = fileURLToPath(new URL("../../results/data", import.meta.url));
const resultsDir = fileURLToPath(new URL("../../results", import.meta.url));

let failures = 0;

function check(label: string, run: () => void) {
  try {
    run();
    console.log(`  ok  ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${label}`);
    console.error(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

const { models } = modelsFileSchema.parse(readJson(join(dataDir, "models.json")));
check("models.json", () => void models);
check("slices.json", () => slicesFileSchema.parse(readJson(join(dataDir, "slices.json"))));

const findingIds = new Set<string>();
for (const file of readdirSync(join(dataDir, "findings"))) {
  check(`findings/${file}`, () => {
    const parsed = findingsFileSchema.parse(readJson(join(dataDir, "findings", file)));
    const model = models.find((m) => m.id === parsed.model);
    if (!model) throw new Error(`unknown model ${parsed.model}`);
    const report = readFileSync(join(resultsDir, model.reportFile), "utf8");
    for (const finding of parsed.findings) {
      if (findingIds.has(finding.id)) throw new Error(`duplicate finding id ${finding.id}`);
      findingIds.add(finding.id);
      if (!finding.id.startsWith(`${parsed.model}:`)) {
        throw new Error(`${finding.id} does not match file model ${parsed.model}`);
      }
      if (!extractSection(report, finding.code)) {
        throw new Error(`${finding.id}: section not found in ${model.reportFile}`);
      }
    }
  });
}

const independentFindingIds = new Set<string>();
const independentFindingsDir = join(dataDir, "independent-review-findings");
for (const file of existsSync(independentFindingsDir)
  ? readdirSync(independentFindingsDir).filter((f) => f.endsWith(".json"))
  : []) {
  check(`independent-review-findings/${file}`, () => {
    const parsed = independentFindingsFileSchema.parse(readJson(join(independentFindingsDir, file)));
    if (!models.some((m) => m.id === parsed.model)) {
      throw new Error(`unknown model ${parsed.model}`);
    }
    const report = readFileSync(join(resultsDir, parsed.source), "utf8");
    for (const finding of parsed.findings) {
      if (independentFindingIds.has(finding.id)) {
        throw new Error(`duplicate independent finding id ${finding.id}`);
      }
      independentFindingIds.add(finding.id);
      if (finding.id !== `${parsed.model}:ir-${finding.code}`) {
        throw new Error(`${finding.id}: expected id ${parsed.model}:ir-${finding.code}`);
      }
      if (!extractSection(report, finding.code)) {
        throw new Error(`${finding.id}: section not found in ${parsed.source}`);
      }
      for (const related of finding.relatedFindingIds) {
        if (!findingIds.has(related)) {
          throw new Error(`${finding.id}: unknown related auto-review finding ${related}`);
        }
      }
    }
  });
}

check("independent-review-clusters.json", () => {
  const { clusters } = clustersFileSchema.parse(
    readJson(join(dataDir, "independent-review-clusters.json")),
  );
  const clusterIds = new Set<string>();
  for (const cluster of clusters) {
    if (clusterIds.has(cluster.id)) throw new Error(`duplicate cluster id ${cluster.id}`);
    clusterIds.add(cluster.id);
    for (const member of cluster.members) {
      if (!independentFindingIds.has(member.findingId)) {
        throw new Error(`cluster ${cluster.id}: unknown independent finding ${member.findingId}`);
      }
    }
    for (const entry of cluster.notObserved ?? []) {
      if (!models.some((m) => m.id === entry.model)) {
        throw new Error(`cluster ${cluster.id}: unknown model ${entry.model}`);
      }
    }
  }
});

const comparisonEntryIds = new Set<string>();
for (const file of readdirSync(join(dataDir, "comparison-entries")).filter((f) => f.endsWith(".json"))) {
  check(`comparison-entries/${file}`, () => {
    const parsed = comparisonEntriesFileSchema.parse(
      readJson(join(dataDir, "comparison-entries", file)),
    );
    if (!models.some((m) => m.id === parsed.model)) {
      throw new Error(`unknown model ${parsed.model}`);
    }
    const report = readFileSync(join(resultsDir, parsed.source), "utf8");
    for (const entry of parsed.entries) {
      if (comparisonEntryIds.has(entry.id)) throw new Error(`duplicate comparison entry id ${entry.id}`);
      comparisonEntryIds.add(entry.id);
      if (entry.model !== parsed.model) {
        throw new Error(`${entry.id}: entry model does not match file model ${parsed.model}`);
      }
      if (entry.source !== parsed.source) {
        throw new Error(`${entry.id}: entry source does not match file source ${parsed.source}`);
      }
      if (entry.id !== `${parsed.model}:${entry.code}`) {
        throw new Error(`${entry.id}: expected id ${parsed.model}:${entry.code}`);
      }
      if (!extractSection(report, entry.code)) {
        throw new Error(`${entry.id}: section not found in ${parsed.source}`);
      }
    }
  });
}

check("comparison-clusters.json", () => {
  const { clusters } = comparisonClustersFileSchema.parse(
    readJson(join(dataDir, "comparison-clusters.json")),
  );
  const clusterIds = new Set<string>();
  for (const cluster of clusters) {
    if (clusterIds.has(cluster.id)) throw new Error(`duplicate comparison cluster id ${cluster.id}`);
    clusterIds.add(cluster.id);
    const memberIds = new Set<string>();
    for (const member of cluster.members) {
      if (!comparisonEntryIds.has(member.entryId)) {
        throw new Error(`comparison cluster ${cluster.id}: unknown entry ${member.entryId}`);
      }
      if (memberIds.has(member.entryId)) {
        throw new Error(`comparison cluster ${cluster.id}: duplicate member ${member.entryId}`);
      }
      memberIds.add(member.entryId);
    }
  }
});

check("clusters.json", () => {
  const { clusters } = clustersFileSchema.parse(readJson(join(dataDir, "clusters.json")));
  for (const cluster of clusters) {
    for (const member of cluster.members) {
      if (!findingIds.has(member.findingId)) {
        throw new Error(`cluster ${cluster.id}: unknown finding ${member.findingId}`);
      }
    }
    for (const entry of cluster.notObserved ?? []) {
      if (!models.some((m) => m.id === entry.model)) {
        throw new Error(`cluster ${cluster.id}: unknown model ${entry.model}`);
      }
      if (
        cluster.members.some((m) => findingIds.has(m.findingId) && m.findingId.startsWith(`${entry.model}:`))
      ) {
        throw new Error(`cluster ${cluster.id}: ${entry.model} is both member and notObserved`);
      }
    }
  }
});

const browserUseFindingsDir = join(dataDir, "browser-use-test-findings");
for (const file of readdirSync(browserUseFindingsDir)) {
  check(`browser-use-test-findings/${file}`, () => {
    const parsed = browserUseTestFindingsFileSchema.parse(readJson(join(browserUseFindingsDir, file)));
    const model = models.find((m) => m.id === parsed.model);
    if (!model) throw new Error(`unknown model ${parsed.model}`);
    const report = readFileSync(join(resultsDir, parsed.source), "utf8");
    for (const finding of parsed.findings) {
      if (!finding.id.startsWith(`${parsed.model}:`)) {
        throw new Error(`${finding.id} does not match file model ${parsed.model}`);
      }
      for (const related of finding.relatedFindingIds) {
        if (!findingIds.has(related)) throw new Error(`${finding.id}: unknown related id ${related}`);
      }
      if (!extractSection(report, finding.id.split(":")[1])) {
        throw new Error(`${finding.id}: section not found in ${parsed.source}`);
      }
      for (const relation of finding.relatedIndependentReviewFindings) {
        if (!independentFindingIds.has(relation.findingId)) {
          throw new Error(`${finding.id}: unknown independent-review relation ${relation.findingId}`);
        }
        if (!relation.findingId.startsWith(`${parsed.model}:ir-`)) {
          throw new Error(`${finding.id}: cross-model relation ${relation.findingId}`);
        }
      }
    }
  });
}

console.log(
  failures === 0
    ? `\nAll data valid (${findingIds.size} findings, ${independentFindingIds.size} independent-review findings, ${comparisonEntryIds.size} comparison entries).`
    : `\n${failures} file(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
