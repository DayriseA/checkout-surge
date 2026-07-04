import { comparisons, models } from "@/lib/data";
import type { Verdict } from "@/lib/schema";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/markdown";
import { ModelMark } from "@/components/model-mark";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const verdictStyle: Record<Verdict, string> = {
  better: "border-transparent bg-[color-mix(in_oklab,var(--sev-info)_0%,transparent)] text-ink [--dot:#0ca30c]",
  same: "text-ink-2 [--dot:var(--ink-3)]",
  worse: "text-ink-2 [--dot:var(--sev-medium)]",
  missing: "text-ink-2 [--dot:var(--sev-high)]",
  unknown: "text-ink-3 [--dot:transparent]",
};

/**
 * Per-topic implementation comparisons against the reference project.
 * Fed by results/data/comparisons/*.json — one file per topic.
 */
export function ComparisonsPage() {
  return (
    <div className="space-y-6">
      <header className="max-w-[70ch]">
        <h1 className="text-2xl font-semibold tracking-tight">Comparisons</h1>
        <p className="mt-1 text-sm leading-relaxed text-ink-2">
          How each implementation's choices compare to the original project that the docs, specs,
          and roadmap were derived from — better, same, worse, or feature lost.
        </p>
      </header>

      {comparisons.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm font-medium">No comparisons recorded yet</p>
            <p className="mx-auto mt-2 max-w-[52ch] text-xs leading-relaxed text-ink-2">
              This phase starts once the implementations are lined up against the reference
              project. Add one JSON file per topic in{" "}
              <code className="rounded bg-wash px-1 font-mono">results/data/comparisons/</code> —
              schema documented in{" "}
              <code className="rounded bg-wash px-1 font-mono">results/data/README.md</code> — and
              it appears here.
            </p>
          </CardContent>
        </Card>
      ) : (
        comparisons.map((comparison) => (
          <Card key={comparison.id} id={comparison.id}>
            <CardHeader>
              <CardTitle className="text-base">{comparison.topic}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {models.map((model) => {
                  const verdict = comparison.verdicts[model.id] ?? "unknown";
                  return (
                    <span
                      key={model.id}
                      className={cn(
                        "inline-flex items-center gap-2 rounded-md border border-hairline px-2.5 py-1.5 text-xs",
                        verdictStyle[verdict],
                      )}
                    >
                      <ModelMark modelId={model.id} className="text-xs" />
                      <span aria-hidden className="size-1.5 rounded-full bg-[var(--dot)]" />
                      <span className="font-mono uppercase tracking-wider">{verdict}</span>
                    </span>
                  );
                })}
              </div>
              <div>
                <p className="mb-1 font-mono text-[0.65rem] tracking-[0.15em] text-ink-3 uppercase">
                  Reference behavior
                </p>
                <Markdown className="text-sm">{comparison.reference}</Markdown>
              </div>
              <div>
                <p className="mb-1 font-mono text-[0.65rem] tracking-[0.15em] text-ink-3 uppercase">
                  Analysis
                </p>
                <Markdown className="text-sm">{comparison.notes}</Markdown>
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
