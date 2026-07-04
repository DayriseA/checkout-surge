import { Link } from "react-router-dom";
import { allFindings, clusters, findingById, models, modelStats } from "@/lib/data";
import { SEVERITY_ORDER, type Severity } from "@/lib/schema";
import { modelColorVar, severityColorVar, severityLabel } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ModelMark } from "@/components/model-mark";

export function OverviewPage() {
  return (
    <div className="space-y-10">
      <header className="max-w-[70ch]">
        <p className="font-mono text-[0.65rem] tracking-[0.2em] text-ink-3 uppercase">
          Phase 1–10 · Self-audit reports
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-balance">
          Three agents built Checkout-Surge. Then each audited its own work.
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-2">
          From the same docs, specs, and roadmap, each agent independently implemented phases 1–10
          in an isolated worktree, then reviewed its own implementation for bugs and oversights.
          Every number below describes an agent's findings <em>about its own codebase</em> — counts
          measure a mix of code quality and audit thoroughness, so read them alongside the{" "}
          <Link to="/clusters" className="underline hover:text-ink">
            cluster view
          </Link>{" "}
          and, later, the manual-testing results.
        </p>
      </header>

      <section aria-labelledby="tally-heading">
        <h2 id="tally-heading" className="sr-only">
          Findings per agent
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {modelStats.map(({ model, total, bySeverity, notes }) => (
            <Link key={model.id} to={`/models/${model.id}`} className="group">
              <Card className="h-full transition-colors group-hover:border-ink-3">
                <CardContent className="py-4">
                  <ModelMark modelId={model.id} detail />
                  <p className="mt-3 text-4xl font-semibold tracking-tight tabular-nums">{total}</p>
                  <p className="mt-0.5 text-xs text-ink-3">
                    findings{notes > 0 && ` · +${notes} lower-confidence notes`}
                  </p>
                  <dl className="mt-3 flex gap-4 border-t border-hairline pt-3">
                    {SEVERITY_ORDER.filter((s) => s !== "info").map((severity) => (
                      <div key={severity}>
                        <dt className="flex items-center gap-1 text-[0.65rem] text-ink-3">
                          <span
                            aria-hidden
                            className="size-1.5 rounded-full"
                            style={{ background: severityColorVar[severity] }}
                          />
                          {severityLabel[severity]}
                        </dt>
                        <dd className="text-sm font-medium tabular-nums">{bySeverity[severity]}</dd>
                      </div>
                    ))}
                  </dl>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <section aria-labelledby="dist-heading">
        <Card>
          <CardHeader>
            <CardTitle id="dist-heading">Severity distribution</CardTitle>
            <p className="text-xs text-ink-2">
              Normalized grades (each report's verbatim label is preserved on the finding itself).
              Lower-confidence notes excluded.
            </p>
          </CardHeader>
          <CardContent>
            <SeverityChart />
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="matrix-heading">
        <Card>
          <CardHeader>
            <CardTitle id="matrix-heading">Who caught what</CardTitle>
            <p className="text-xs text-ink-2">
              Issue classes reported by more than one self-audit. Each agent audited its own
              implementation, so an empty cell means the issue wasn't reported there — either it
              doesn't exist in that implementation or the audit missed it. ⊘ marks classes the
              report explicitly verified as sound.
            </p>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <CoverageMatrix />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function SeverityChart() {
  const visible: Severity[] = ["high", "medium", "low"];
  const max = Math.max(
    ...modelStats.flatMap(({ bySeverity }) => visible.map((s) => bySeverity[s])),
  );

  return (
    <div className="space-y-5">
      {visible.map((severity) => (
        <div key={severity}>
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-ink-2">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{ background: severityColorVar[severity] }}
            />
            {severityLabel[severity]}
          </p>
          <div className="space-y-[3px]">
            {modelStats.map(({ model, bySeverity }) => {
              const value = bySeverity[severity];
              return (
                <div key={model.id} className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
                  <span className="truncate text-right text-xs text-ink-3">{model.name}</span>
                  <div className="flex items-center gap-2">
                    <div
                      role="img"
                      aria-label={`${model.name}: ${value} ${severityLabel[severity].toLowerCase()}`}
                      className="h-4 rounded-r-[4px]"
                      style={{
                        width: `calc(${(value / max) * 100}% * 0.9)`,
                        minWidth: value > 0 ? "3px" : "0",
                        background: severityColorVar[severity],
                      }}
                    />
                    <span className="text-xs font-medium tabular-nums">{value}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <p className="border-t border-hairline pt-3 text-[0.7rem] leading-relaxed text-ink-3">
        Same scale across severities; bars measure each agent's report about its own code, not a
        shared benchmark.
      </p>
    </div>
  );
}

function CoverageMatrix() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-hairline">
            <th scope="col" className="px-4 py-2 text-left font-mono text-[0.65rem] tracking-[0.15em] text-ink-3 uppercase">
              Issue class
            </th>
            {models.map((model) => (
              <th key={model.id} scope="col" className="px-3 py-2 text-left font-normal whitespace-nowrap">
                <ModelMark modelId={model.id} className="text-xs" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {clusters.map((cluster) => (
            <tr key={cluster.id} className="border-b border-hairline last:border-b-0 hover:bg-wash">
              <th scope="row" className="max-w-[26rem] px-4 py-2.5 text-left font-normal">
                <Link
                  to={`/clusters#${cluster.id}`}
                  className="font-medium text-ink hover:underline"
                >
                  {cluster.title}
                </Link>
                <span className="ml-2 font-mono text-[0.62rem] tracking-wide text-ink-3 uppercase">
                  {cluster.confidence} conf.
                </span>
              </th>
              {models.map((model) => {
                const member = cluster.members
                  .map((m) => findingById(m.findingId))
                  .find((f) => f.model === model.id);
                const notObserved = cluster.notObserved?.find((n) => n.model === model.id);
                return (
                  <td key={model.id} className="px-3 py-2.5 whitespace-nowrap">
                    {member ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          aria-hidden
                          className="size-2.5 rounded-[3px]"
                          style={{ background: modelColorVar(model.id) }}
                        />
                        <span className="font-mono text-xs text-ink-2">{member.code}</span>
                        <span
                          aria-hidden
                          className="size-1.5 rounded-full"
                          style={{ background: severityColorVar[member.severity] }}
                        />
                        <span className="sr-only">{severityLabel[member.severity]}</span>
                      </span>
                    ) : notObserved ? (
                      <span className="text-xs text-ink-3" title={notObserved.note}>
                        ⊘ verified
                      </span>
                    ) : (
                      <span aria-label="not reported" className="text-ink-3">
                        —
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-hairline px-4 py-3 text-[0.7rem] text-ink-3">
        {clusters.length} clusters covering{" "}
        {clusters.reduce((n, c) => n + c.members.length, 0)} of {allFindings.length} findings — the
        mapping is editorial (see results/data/clusters.json) and worth reviewing as the experiment
        progresses.
      </p>
    </div>
  );
}
