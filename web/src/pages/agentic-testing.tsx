import { Link } from "react-router-dom";
import { agenticTestFiles, findingById, modelById } from "@/lib/data";
import { Markdown } from "@/components/markdown";
import { ModelMark } from "@/components/model-mark";
import { SeverityBadge } from "@/components/severity-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Bugs found by AI agents running exploratory browser sessions against each
 * implementation. The headline metric is caughtInSelfAudit — did the model's
 * own review see this issue coming?
 */
export function AgenticTestingPage() {
  const total = agenticTestFiles.reduce((n, file) => n + file.findings.length, 0);
  const missed = agenticTestFiles.reduce(
    (n, file) => n + file.findings.filter((f) => !f.caughtInSelfAudit).length,
    0,
  );

  return (
    <div className="space-y-6">
      <header className="max-w-[70ch]">
        <h1 className="text-2xl font-semibold tracking-tight">Agentic exploratory testing</h1>
        <p className="mt-1 text-sm leading-relaxed text-ink-2">
          Issues found by AI agents taking control of the browser, simulating real user workflows,
          and reporting functional bugs, inconsistencies, broken flows, or unstable UI states. Every
          entry records whether the model's own self-audit had already caught it — the direct measure
          of audit blind spots.
        </p>
      </header>

      {total === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm font-medium">No agentic test findings recorded yet</p>
            <p className="mx-auto mt-2 max-w-[52ch] text-xs leading-relaxed text-ink-2">
              As AI tester agents explore the implementations, record issues in{" "}
              <code className="rounded bg-wash px-1 font-mono">
                results/data/agentic-test-findings/&lt;model&gt;.json
              </code>{" "}
              (schema in <code className="rounded bg-wash px-1 font-mono">results/data/README.md</code>).
              Set <code className="rounded bg-wash px-1 font-mono">caughtInSelfAudit</code> and link
              related auto-review findings to build the blind-spot picture.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="font-mono text-xs text-ink-3">
            {total} agentic test findings · {missed} missed by the self-audits
          </p>
          {agenticTestFiles
            .filter((file) => file.findings.length > 0)
            .map((file) => (
              <Card key={file.model}>
                <CardHeader>
                  <CardTitle>
                    <ModelMark modelId={file.model} />
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {file.findings.map((finding) => (
                    <article key={finding.id} className="border-b border-hairline pb-4 last:border-b-0 last:pb-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-ink-3">{finding.id.split(":")[1]}</span>
                        <h3 className="text-sm font-medium">{finding.title}</h3>
                        <SeverityBadge severity={finding.severity} />
                        <span className="rounded-full border border-hairline px-2 py-0.5 font-mono text-[0.62rem] tracking-wider uppercase">
                          {finding.status}
                        </span>
                        <span
                          className="rounded-full border border-hairline px-2 py-0.5 font-mono text-[0.62rem] tracking-wider uppercase"
                          title="Did the model's own audit report this?"
                        >
                          {finding.caughtInSelfAudit ? "caught in self-audit" : "missed in self-audit"}
                        </span>
                      </div>
                      <Markdown className="mt-2 text-sm">{finding.description}</Markdown>
                      {finding.relatedFindingIds.length > 0 && (
                        <p className="mt-1 text-xs text-ink-3">
                          related:{" "}
                          {finding.relatedFindingIds.map((id, i) => {
                            const related = findingById(id);
                            const model = modelById(related.model);
                            return (
                              <span key={id}>
                                {i > 0 && ", "}
                                <Link
                                  to={`/models/${related.model}`}
                                  className="font-mono underline hover:text-ink"
                                >
                                  {model?.name} {related.code}
                                </Link>
                              </span>
                            );
                          })}
                        </p>
                      )}
                    </article>
                  ))}
                </CardContent>
              </Card>
            ))}
        </>
      )}
    </div>
  );
}
