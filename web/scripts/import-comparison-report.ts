/**
 * Imports one consolidated comparison report into the lossless entry format.
 *
 * Usage:
 *   node scripts/import-comparison-report.ts gpt-5.5 comparison_vs_base/gpt-5.5_vs_base.md
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const verdicts = ["better", "same", "worse", "missing", "unknown"] as const;
type Verdict = (typeof verdicts)[number];

interface Entry {
  id: string;
  model: string;
  code: string;
  topic: string;
  verdict: Verdict;
  source: string;
  reference: string;
  compared: string;
  rationale: string;
}

const [model, source] = process.argv.slice(2);
if (!model || !source) {
  console.error("Usage: node scripts/import-comparison-report.ts <model-id> <source-relative-to-results>");
  process.exit(1);
}

const webDir = fileURLToPath(new URL("..", import.meta.url));
const repoDir = fileURLToPath(new URL("../..", import.meta.url));
const resultsDir = join(repoDir, "results");
const markdown = readFileSync(join(resultsDir, source), "utf8");

const entries = parseReport(markdown, model, source);
if (entries.length === 0) {
  throw new Error(`No comparison sections found in ${source}`);
}

const outputPath = join(resultsDir, "data", "comparison-entries", `${model}.json`);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `${JSON.stringify({ model, reviewType: "comparison-vs-base", source, entries }, null, 2)}\n`,
);

console.log(`Imported ${entries.length} comparison entries from ${source}`);
console.log(`Wrote ${outputPath.replace(webDir, "web")}`);

function parseReport(markdown: string, model: string, source: string): Entry[] {
  const lines = markdown.split(/\r?\n/);
  const starts: Array<{ index: number; code: string; topic: string; verdict: Verdict }> = [];
  const headingPattern = /^###\s+(C\d+)\s+—\s+(.+?)\s+\((better|same|worse|missing|unknown)\)\s*$/;

  lines.forEach((line, index) => {
    const match = headingPattern.exec(line);
    if (!match) return;
    starts.push({
      index,
      code: match[1],
      topic: match[2].trim(),
      verdict: match[3] as Verdict,
    });
  });

  return starts.map((start, position) => {
    const next = starts[position + 1]?.index ?? findAppendixStart(lines, start.index + 1) ?? lines.length;
    const body = stripSectionTail(lines.slice(start.index + 1, next).join("\n"));
    return {
      id: `${model}:${start.code}`,
      model,
      code: start.code,
      topic: start.topic,
      verdict: start.verdict,
      source,
      reference: extractSubsection(body, "Reference behavior", start.code),
      compared: extractSubsection(body, "Compared behavior", start.code),
      rationale: extractSubsection(body, "Verdict rationale", start.code),
    };
  });
}

function findAppendixStart(lines: string[], from: number): number | null {
  const index = lines.findIndex((line, i) => i >= from && /^##\s+Appendix\b/.test(line));
  return index === -1 ? null : index;
}

function extractSubsection(body: string, heading: string, code: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trim() === `#### ${heading}`);
  if (start === -1) {
    throw new Error(`${code}: missing subsection "${heading}"`);
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^####\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const content = stripSectionTail(lines.slice(start + 1, end).join("\n"));
  if (!content) throw new Error(`${code}: empty subsection "${heading}"`);
  return content;
}

function stripSectionTail(value: string): string {
  return value
    .replace(/\n-{3,}\s*$/g, "")
    .trim();
}
