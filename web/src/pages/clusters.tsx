import { Link } from "react-router-dom";
import { clusters as autoReviewClusters, findingById, type BrowsableFinding } from "@/lib/data";
import type { Cluster } from "@/lib/schema";
import { FindingRow } from "@/components/finding-row";
import { ModelMark } from "@/components/model-mark";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const confidenceStyle: Record<string, string> = {
  high: "border-ink-2 text-ink",
  medium: "border-hairline text-ink-2",
  low: "border-dashed border-hairline text-ink-3",
};

/**
 * Cross-model issue classes over a cluster dataset (self-audit by default).
 * For the self-audits, a cluster reads as "this class of issue existed there
 * and the self-audit caught it"; for the independent reviews the single fixed
 * reviewer makes membership comparable across agents.
 */
export function ClustersView({
  showHeader = true,
  clusters = autoReviewClusters,
  resolveFinding = findingById,
  jsonPath = "results/data/clusters.json",
  explorerPath = "/auto-review",
}: {
  showHeader?: boolean;
  clusters?: Cluster[];
  resolveFinding?: (id: string) => BrowsableFinding;
  jsonPath?: string;
  explorerPath?: string;
}) {
  return (
    <div className="space-y-6">
      {showHeader && (
        <header className="max-w-[70ch]">
          <h1 className="text-2xl font-semibold tracking-tight">Clusters</h1>
          <p className="mt-1 text-sm leading-relaxed text-ink-2">
            Findings across models that describe the same underlying issue class. The grouping is
            editorial and AI-curated — each cluster carries a confidence grade, and the mapping is
            plain JSON (<code className="rounded bg-wash px-1 font-mono text-xs">{jsonPath}</code>)
            meant to be corrected as you learn more.
          </p>
        </header>
      )}

      {clusters.map((cluster) => (
        <Card key={cluster.id} id={cluster.id} className="scroll-mt-6">
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div>
              <CardTitle className="text-base">{cluster.title}</CardTitle>
              <p className="mt-1 max-w-[75ch] text-xs leading-relaxed text-ink-2">
                {cluster.description}
              </p>
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
            <div>
              {cluster.members.map((member) => {
                const finding = resolveFinding(member.findingId);
                return (
                  <div key={member.findingId} className="border-b border-hairline last:border-b-0">
                    <FindingRow finding={finding} />
                    {member.note && (
                      <p className="-mt-1 px-3 pb-2.5 pl-12 text-xs leading-relaxed text-ink-3">
                        <span className="font-mono text-[0.62rem] tracking-wider uppercase">variant · </span>
                        {member.note}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            {cluster.notObserved && cluster.notObserved.length > 0 && (
              <div className="border-t border-hairline bg-wash/50 px-4 py-3">
                {cluster.notObserved.map((entry) => (
                  <p key={entry.model} className="text-xs leading-relaxed text-ink-2">
                    <ModelMark modelId={entry.model} className="mr-1.5 text-xs" />
                    <span className="text-ink-3">not observed — {entry.note}</span>
                  </p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ))}

      <p className="text-xs text-ink-3">
        Findings outside any cluster are unique to one report — browse them in the{" "}
        <Link to={explorerPath} className="underline hover:text-ink">
          findings explorer
        </Link>
        .
      </p>
    </div>
  );
}
