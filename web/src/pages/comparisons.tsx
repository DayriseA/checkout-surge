import { ChevronRight } from "lucide-react";
import {
  comparisonClusters,
  comparisonEntries,
  comparisonEntryById,
  models,
} from "@/lib/data";
import type { ComparisonCluster, ComparisonEntry, Verdict } from "@/lib/schema";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/markdown";
import { ModelMark } from "@/components/model-mark";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const verdictStyle: Record<Verdict, string> = {
  better: "text-ink [--dot:#0ca30c]",
  same: "text-ink-2 [--dot:var(--ink-3)]",
  worse: "text-ink-2 [--dot:var(--sev-medium)]",
  missing: "text-ink-2 [--dot:var(--sev-high)]",
  unknown: "text-ink-3 [--dot:transparent]",
};

const confidenceStyle: Record<ComparisonCluster["confidence"], string> = {
  high: "border-ink-2 text-ink",
  medium: "border-hairline text-ink-2",
  low: "border-dashed border-hairline text-ink-3",
};

/**
 * Lossless implementation-comparison browser.
 *
 * Each original C{n} report section is stored as its own comparison entry.
 * Clusters are editorial groupings over those entries, so independently
 * written bodies remain visible instead of being merged into one synthetic
 * topic record.
 */
export function ComparisonsPage() {
  return (
    <div className="space-y-6">
      <header className="max-w-[76ch]">
        <h1 className="text-2xl font-semibold tracking-tight">Comparisons</h1>
        <p className="mt-1 text-sm leading-relaxed text-ink-2">
          Compared-codebase vs reference-codebase sections are stored as lossless entries, then
          grouped into editorial clusters when they clearly discuss the same concern. A cluster can
          contain several entries from one model when that report split the concern into smaller
          parts.
        </p>
        <p className="mt-2 font-mono text-xs text-ink-3">
          {comparisonEntries.length} entries in {comparisonClusters.length} clusters
        </p>
      </header>

      {comparisonClusters.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm font-medium">No comparison clusters recorded yet</p>
            <p className="mx-auto mt-2 max-w-[54ch] text-xs leading-relaxed text-ink-2">
              Import report sections into{" "}
              <code className="rounded bg-wash px-1 font-mono">results/data/comparison-entries/</code>
              , then group related entries in{" "}
              <code className="rounded bg-wash px-1 font-mono">results/data/comparison-clusters.json</code>
              .
            </p>
          </CardContent>
        </Card>
      ) : (
        comparisonClusters.map((cluster) => <ComparisonClusterCard key={cluster.id} cluster={cluster} />)
      )}
    </div>
  );
}

function ComparisonClusterCard({ cluster }: { cluster: ComparisonCluster }) {
  const members = cluster.members.map((member) => ({
    entry: comparisonEntryById(member.entryId),
    note: member.note,
  }));

  return (
    <Card id={cluster.id} className="scroll-mt-6">
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="text-base">{cluster.title}</CardTitle>
          <p className="mt-1 max-w-[78ch] text-xs leading-relaxed text-ink-2">
            {cluster.description}
          </p>
          {cluster.notes && (
            <p className="mt-1 max-w-[78ch] text-xs leading-relaxed text-ink-3">{cluster.notes}</p>
          )}
        </div>
        <span
          className={cn(
            "mt-0.5 shrink-0 rounded-full border px-2 py-0.5 font-mono text-[0.62rem] tracking-wider uppercase",
            confidenceStyle[cluster.confidence],
          )}
        >
          {cluster.confidence} confidence
        </span>
      </CardHeader>
      <CardContent className="space-y-4 px-0 pb-0">
        <ClusterModelSummary entries={members.map((member) => member.entry)} />
        <div className="border-t border-hairline">
          {members.map(({ entry, note }) => (
            <ComparisonEntryDetail key={entry.id} entry={entry} note={note} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ClusterModelSummary({ entries }: { entries: ComparisonEntry[] }) {
  return (
    <div className="grid gap-2 px-4 sm:grid-cols-3">
      {models.map((model) => {
        const modelEntries = entries.filter((entry) => entry.model === model.id);
        return (
          <div key={model.id} className="rounded-md border border-hairline px-3 py-2">
            <ModelMark modelId={model.id} className="text-xs" />
            {modelEntries.length === 0 ? (
              <p className="mt-1 font-mono text-xs text-ink-3">no entry</p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {modelEntries.map((entry) => (
                  <VerdictBadge key={entry.id} verdict={entry.verdict} label={`${entry.code} ${entry.verdict}`} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ComparisonEntryDetail({ entry, note }: { entry: ComparisonEntry; note?: string }) {
  return (
    <details className="group border-b border-hairline last:border-b-0">
      <summary
        className={cn(
          "grid cursor-pointer list-none grid-cols-[auto_1fr_auto] items-start gap-3 px-4 py-3 text-left",
          "hover:bg-wash focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink",
        )}
      >
        <ChevronRight
          aria-hidden
          className="mt-0.5 size-3.5 shrink-0 text-ink-3 transition-transform group-open:rotate-90"
        />
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <ModelMark modelId={entry.model} className="text-xs" />
            <span className="font-mono text-xs text-ink-3">{entry.code}</span>
            <VerdictBadge verdict={entry.verdict} label={entry.verdict} />
          </span>
          <span className="mt-1 block text-sm leading-snug font-medium text-ink">{entry.topic}</span>
          {note && (
            <span className="mt-1 block text-xs leading-relaxed text-ink-3">
              <span className="font-mono text-[0.62rem] tracking-wider uppercase">cluster note · </span>
              {note}
            </span>
          )}
        </span>
        <span className="mt-0.5 hidden font-mono text-[0.65rem] text-ink-3 sm:inline">
          results/{entry.source}
        </span>
      </summary>
      <div className="space-y-4 border-t border-dashed border-hairline bg-wash/40 px-4 py-4 pl-11">
        <ComparisonBodySection title="Reference behavior" body={entry.reference} />
        <ComparisonBodySection title="Compared behavior" body={entry.compared} />
        <ComparisonBodySection title="Verdict rationale" body={entry.rationale} />
        <p className="font-mono text-[0.68rem] break-all text-ink-3">
          source: results/{entry.source} · {entry.code}
        </p>
      </div>
    </details>
  );
}

function ComparisonBodySection({ title, body }: { title: string; body: string }) {
  return (
    <section>
      <p className="mb-1 font-mono text-[0.65rem] tracking-[0.15em] text-ink-3 uppercase">
        {title}
      </p>
      <Markdown className="max-w-[85ch] text-sm">{body}</Markdown>
    </section>
  );
}

function VerdictBadge({ verdict, label }: { verdict: Verdict; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-hairline px-2 py-1 font-mono text-[0.65rem] uppercase",
        verdictStyle[verdict],
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-[var(--dot)]" />
      {label}
    </span>
  );
}
