import { Link } from "react-router-dom";
import { ArrowRight, GitBranch, ShieldAlert } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { ModelMark } from "@/components/model-mark";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { baseSelection, sourceMarkdown } from "@/lib/data";
import type { BaseSelectionRole, RepairRadius } from "@/lib/schema";
import { cn } from "@/lib/utils";

const roleLabel: Record<BaseSelectionRole, string> = {
  base: "Recommended base",
  "primary-donor": "Primary donor",
  "selective-donor": "Selective donor",
};

const roleStyle: Record<BaseSelectionRole, string> = {
  base: "border-ink-2 bg-ink text-paper",
  "primary-donor": "border-ink-2 text-ink",
  "selective-donor": "border-hairline text-ink-2",
};

const repairRadiusLabel: Record<RepairRadius, string> = {
  "medium-high": "medium–high",
  high: "high",
  "very-high": "very high",
};

export function BaseSelectionPage() {
  const candidates = [...baseSelection.candidates].sort((a, b) => a.rank - b.rank);
  const report = sourceMarkdown(baseSelection.source);

  return (
    <div className="space-y-8">
      <header className="max-w-[82ch]">
        <p className="font-mono text-[0.65rem] tracking-[0.2em] text-ink-3 uppercase">
          Decision synthesis · version {baseSelection.decisionVersion}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-balance">
          Base branch for consolidation
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-2">{baseSelection.question}</p>
        <p className="mt-2 font-mono text-[0.68rem] text-ink-3">
          {baseSelection.decisionDate} · {baseSelection.status} · {baseSelection.confidence} confidence
        </p>
      </header>

      <Card className="border-ink-2">
        <CardContent className="py-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[0.65rem] tracking-[0.16em] text-ink-3 uppercase">
                Recommendation
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <ModelMark modelId={baseSelection.recommendedBase} detail />
                <span className="rounded-md bg-ink px-2 py-1 font-mono text-[0.65rem] tracking-wide text-paper uppercase">
                  keep as base
                </span>
              </div>
              <p className="mt-3 max-w-[72ch] text-sm leading-relaxed text-ink-2">
                Preserve the strongest demonstrated vertical slice, harden its durable handoffs and
                lifecycle fencing first, then port selected Opus and GLM invariants through tested
                boundaries.
              </p>
            </div>
            <GitBranch aria-hidden className="size-7 text-ink-3" />
          </div>
        </CardContent>
      </Card>

      <section aria-labelledby="ranking-heading">
        <h2 id="ranking-heading" className="mb-3 text-lg font-semibold tracking-tight">
          Ranking and intended role
        </h2>
        <div className="grid gap-4 lg:grid-cols-3">
          {candidates.map((candidate) => (
            <Card key={candidate.model} className={candidate.role === "base" ? "border-ink-2" : undefined}>
              <CardContent className="flex h-full flex-col py-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-mono text-[0.65rem] text-ink-3">#{candidate.rank}</p>
                    <ModelMark modelId={candidate.model} detail className="mt-1" />
                  </div>
                  <span
                    className={cn(
                      "rounded-md border px-2 py-1 font-mono text-[0.62rem] tracking-wide uppercase",
                      roleStyle[candidate.role],
                    )}
                  >
                    {roleLabel[candidate.role]}
                  </span>
                </div>
                <p className="mt-4 text-sm font-medium leading-snug">{candidate.headline}</p>
                <p className="mt-2 text-xs leading-relaxed text-ink-2">{candidate.rationale}</p>
                <div className="mt-auto flex items-end justify-between gap-3 border-t border-hairline pt-4">
                  <p className="font-mono text-[0.65rem] text-ink-3">
                    repair radius · {repairRadiusLabel[candidate.repairRadius]}
                  </p>
                  <Link
                    to={`/models/${candidate.model}`}
                    className="inline-flex items-center gap-1 text-xs text-ink-2 hover:text-ink hover:underline"
                  >
                    Evidence <ArrowRight aria-hidden className="size-3" />
                  </Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section aria-labelledby="phases-heading">
        <Card>
          <CardHeader>
            <CardTitle id="phases-heading">Consolidation sequence</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="grid gap-px overflow-hidden rounded-md border border-hairline bg-hairline md:grid-cols-2 xl:grid-cols-4">
              {baseSelection.consolidationPhases.map((phase, index) => (
                <li key={phase.title} className="bg-surface p-3">
                  <p className="font-mono text-[0.62rem] tracking-[0.15em] text-ink-3 uppercase">
                    Phase {index + 1}
                  </p>
                  <p className="mt-1 text-sm font-medium">{phase.title}</p>
                  <p className="mt-1 text-xs leading-relaxed text-ink-3">{phase.summary}</p>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </section>

      <details className="rounded-lg border border-hairline bg-surface">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium">
          <ShieldAlert aria-hidden className="size-4 text-ink-3" />
          Evidence limitations and qualifications
        </summary>
        <ul className="space-y-2 border-t border-hairline px-5 py-4 text-xs leading-relaxed text-ink-2">
          {baseSelection.limitations.map((limitation) => (
            <li key={limitation} className="list-disc marker:text-ink-3">
              {limitation}
            </li>
          ))}
        </ul>
      </details>

      <section aria-labelledby="report-heading">
        <Card>
          <CardHeader>
            <CardTitle id="report-heading">Full decision narrative</CardTitle>
            <p className="text-xs text-ink-2">
              Canonical source: <code>results/{baseSelection.source}</code>
            </p>
          </CardHeader>
          <CardContent>
            <Markdown className="max-w-none">{report}</Markdown>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
