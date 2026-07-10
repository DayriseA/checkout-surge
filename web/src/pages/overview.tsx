import { Link } from "react-router-dom";
import {
  browserUseStats,
  clusterModelSpan,
  clusters,
  comparisonReviewer,
  comparisonVerdictStats,
  findingById,
  independentBlindSpots,
  independentFindingById,
  independentModelStats,
  independentReviewClusters,
  independentReviewer,
  models,
  modelStats,
  type BrowsableFinding,
} from "@/lib/data";
import { SEVERITY_ORDER, type Cluster, type Verdict } from "@/lib/schema";
import { modelColorVar, severityColorVar, severityLabel } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ModelMark } from "@/components/model-mark";

export function OverviewPage() {
  const sharedIrClusters = independentReviewClusters.filter(
    (cluster) =>
      cluster.confidence === "high" &&
      clusterModelSpan(cluster, independentFindingById) === models.length,
  );
  const highConfSelfAuditClusters = clusters.filter((cluster) => cluster.confidence === "high");

  return (
    <div className="space-y-10">
      <header>
        <p className="font-mono text-[0.65rem] tracking-[0.2em] text-ink-3 uppercase">
          Phase 1–10 · Agent evaluation
        </p>
        <h1 className="mt-2 max-w-[70ch] text-3xl font-semibold tracking-tight text-balance">
          Three agents built Checkout-Surge. Then each audited its own work.
        </h1>
        <p className="mt-3 max-w-[70ch] text-sm leading-relaxed text-ink-2">
          From the same docs, specs, and roadmap, each agent independently implemented phases 1–10
          in an isolated worktree. Four evaluation passes followed — the pipeline below shows where
          each dataset comes from. Self-audit counts mix code quality with audit thoroughness; the
          fixed-reviewer and fixed-comparer passes are the ones that compare directly across
          agents.
        </p>
        <Pipeline />
      </header>

      <section aria-labelledby="tally-heading">
        <h2 id="tally-heading" className="sr-only">
          Findings per agent
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {models.map((model) => (
            <AgentCard key={model.id} modelId={model.id} />
          ))}
        </div>
        <p className="mt-2 text-[0.7rem] leading-relaxed text-ink-3">
          Headline counts are the fixed reviewer's post-fix findings — the one code-review count
          that compares across agents. Pre-fix self-audit totals are shown for context only.
        </p>
      </section>

      <Synthesis sharedClusterCount={sharedIrClusters.length} />

      <ComparisonVerdicts />

      <section aria-labelledby="ir-matrix-heading">
        <Card>
          <CardHeader>
            <CardTitle id="ir-matrix-heading">
              Shared issue classes — every branch, same defect
            </CardTitle>
            <p className="text-xs text-ink-2">
              High-confidence issue classes the fixed reviewer, {independentReviewer}, found in all
              three post-fix implementations. Three independent codebases converging on the same
              defect class points at systematic agent blind spots, not one-off mistakes.
            </p>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <CoverageMatrix
              clusters={sharedIrClusters}
              resolveFinding={independentFindingById}
              linkBase="/independent-review?view=code-clusters"
              footer={
                <>
                  {independentReviewClusters.filter(
                    (c) => clusterModelSpan(c, independentFindingById) === models.length,
                  ).length}{" "}
                  of {independentReviewClusters.length} independent-review classes span all three
                  branches; the {sharedIrClusters.length} high-confidence ones are shown here. Full
                  matrix in{" "}
                  <Link to="/independent-review?view=code-clusters" className="underline hover:text-ink">
                    Independent review › Code clusters
                  </Link>
                  .
                </>
              }
            />
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="matrix-heading">
        <Card>
          <CardHeader>
            <CardTitle id="matrix-heading">Who caught what — self-audits</CardTitle>
            <p className="text-xs text-ink-2">
              Issue classes reported by more than one self-audit, high-confidence groupings only.
              Each agent audited its own implementation, so an empty cell means the issue wasn't
              reported there — either it doesn't exist in that implementation or the audit missed
              it. ⊘ marks classes the report explicitly verified as sound.
            </p>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <CoverageMatrix
              clusters={highConfSelfAuditClusters}
              resolveFinding={findingById}
              linkBase="/auto-review?view=clusters"
              footer={
                <>
                  Showing {highConfSelfAuditClusters.length} of {clusters.length} multi-audit
                  classes (the mapping is editorial — see results/data/clusters.json). Full matrix
                  in{" "}
                  <Link to="/auto-review?view=clusters" className="underline hover:text-ink">
                    Auto-Review › Clusters
                  </Link>
                  .
                </>
              }
            />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

const PIPELINE_STEPS: Array<{ title: string; detail: string; to?: string }> = [
  {
    title: "Build",
    detail: "Each agent implemented phases 1–10 from the same docs, in an isolated worktree.",
  },
  {
    title: "Self-audit",
    detail: "Each agent code-reviewed its own implementation for bugs and oversights.",
    to: "/auto-review",
  },
  {
    title: "Fix attempt",
    detail: "Self-audit findings were filed as issues; each agent fixed them and claimed completion.",
  },
  {
    title: "Browser-use test",
    detail: "Independent testers exercised each claimed-fixed app through a real browser.",
    to: "/independent-review?view=browser-use",
  },
  {
    title: "Independent review",
    detail: "One fixed reviewer code-reviewed every post-fix branch with the same guide.",
    to: "/independent-review",
  },
];

function Pipeline() {
  return (
    <div className="mt-6 max-w-[900px]">
      <ol className="grid gap-px overflow-hidden rounded-lg border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-5">
        {PIPELINE_STEPS.map((step, index) => (
          <li key={step.title} className="bg-surface p-3">
            <p className="font-mono text-[0.62rem] tracking-[0.15em] text-ink-3 uppercase">
              Step {index + 1}
            </p>
            <p className="mt-1 text-sm font-medium">
              {step.to ? (
                <Link to={step.to} className="hover:underline">
                  {step.title}
                </Link>
              ) : (
                step.title
              )}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-ink-3">{step.detail}</p>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs leading-relaxed text-ink-3">
        In parallel, one fixed comparer — {comparisonReviewer} — graded each implementation
        topic-by-topic against the reference codebase; see{" "}
        <Link to="/comparisons" className="underline hover:text-ink">
          Comparisons
        </Link>
        .
      </p>
    </div>
  );
}

function AgentCard({ modelId }: { modelId: string }) {
  const independent = independentModelStats.find((s) => s.model.id === modelId);
  const selfAudit = modelStats.find((s) => s.model.id === modelId);
  const blindSpot = independentBlindSpots.find((s) => s.model.id === modelId);
  const browserUse = browserUseStats.find((s) => s.model.id === modelId);
  if (!independent || !selfAudit || !blindSpot || !browserUse) return null;

  const blindSpotPct = Math.round((blindSpot.missed / blindSpot.total) * 100);

  return (
    <Link to={`/models/${modelId}`} className="group">
      <Card className="h-full transition-colors group-hover:border-ink-3">
        <CardContent className="py-4">
          <ModelMark modelId={modelId} detail />
          <p className="mt-3 text-4xl font-semibold tracking-tight tabular-nums">
            {independent.total}
          </p>
          <p className="mt-0.5 text-xs text-ink-3">
            post-fix findings by the fixed reviewer
            {independent.notes > 0 && ` · +${independent.notes} notes`}
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
                <dd className="text-sm font-medium tabular-nums">
                  {independent.bySeverity[severity]}
                </dd>
              </div>
            ))}
          </dl>
          <div className="mt-3 space-y-1 border-t border-hairline pt-3 text-xs leading-relaxed text-ink-3">
            <p>
              <span className="font-medium text-ink-2 tabular-nums">
                {blindSpot.missed} of {blindSpot.total}
              </span>{" "}
              ({blindSpotPct}%) never flagged by its own self-audit
            </p>
            <p>
              <span className="font-medium text-ink-2 tabular-nums">{browserUse.total}</span>{" "}
              confirmed browser-use bugs post-fix
            </p>
            <p>
              Self-audit (pre-fix): {selfAudit.total} findings · {selfAudit.bySeverity.high} high
              {selfAudit.notes > 0 && ` · +${selfAudit.notes} notes`}
            </p>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function Synthesis({ sharedClusterCount }: { sharedClusterCount: number }) {
  const blindSpotPcts = independentBlindSpots.map((s) =>
    Math.round((s.missed / s.total) * 100),
  );
  const missedSum = independentBlindSpots.reduce((n, s) => n + s.missed, 0);
  const irSum = independentBlindSpots.reduce((n, s) => n + s.total, 0);
  const buTotal = browserUseStats.reduce((n, s) => n + s.total, 0);
  const buMissed = browserUseStats.reduce((n, s) => n + s.selfAuditMissed, 0);

  const fewestIr = [...independentModelStats].sort((a, b) => a.total - b.total)[0];
  const mostHigh = [...independentModelStats].sort(
    (a, b) => b.bySeverity.high - a.bySeverity.high,
  )[0];
  const nets = comparisonVerdictStats
    .map((s) => ({ model: s.model, net: s.byVerdict.better - s.byVerdict.worse }))
    .sort((a, b) => b.net - a.net);
  const formatNet = (net: number) => (net > 0 ? `+${net}` : `${net}`);

  return (
    <section aria-labelledby="synthesis-heading">
      <Card>
        <CardHeader>
          <CardTitle id="synthesis-heading">What the data says so far</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-ink-2">
          <div>
            <p className="font-medium text-ink">Self-audits have large blind spots.</p>
            <p className="mt-1">
              {Math.min(...blindSpotPcts)}–{Math.max(...blindSpotPcts)}% of what the fixed reviewer
              found on each post-fix branch ({missedSum} of {irSum} findings overall) had no
              counterpart in that branch's own self-audit, and {buMissed} of {buTotal} confirmed
              browser-use bugs were classes the self-audit never identified. Part of that gap is
              capability rather than self-blindness alone: the fixed reviewer,{" "}
              {independentReviewer}, is a stronger model than the three builders — so read these as
              what a stronger reviewer adds, not purely as what the agents refused to see.
            </p>
          </div>
          <div>
            <p className="font-medium text-ink">
              The three implementations share the same weak spots.
            </p>
            <p className="mt-1">
              {
                independentReviewClusters.filter(
                  (c) => clusterModelSpan(c, independentFindingById) === models.length,
                ).length
              }{" "}
              of {independentReviewClusters.length} independent-review issue classes appear in all
              three branches — external-confirmation idempotency, holds left without durable state,
              stale dashboard scope, admin auth hardening. Three independent codebases converging
              on the same defect classes reads as systematic blind spots of current agents, not
              individual slips; the {sharedClusterCount} high-confidence ones are tabled below.
            </p>
          </div>
          <div>
            <p className="font-medium text-ink">No branch leads on every lens.</p>
            <ul className="mt-1 space-y-1">
              <li>
                Fewest post-fix findings: <ModelMark modelId={fewestIr.model.id} className="text-xs" />{" "}
                ({independentModelStats.map((s) => `${s.model.name} ${s.total}`).join(" · ")})
              </li>
              <li>
                Most high-severity post-fix findings:{" "}
                <ModelMark modelId={mostHigh.model.id} className="text-xs" /> (
                {independentModelStats
                  .map((s) => `${s.model.name} ${s.bySeverity.high}`)
                  .join(" · ")}
                )
              </li>
              <li>
                Best verdict balance vs the reference:{" "}
                <ModelMark modelId={nets[0].model.id} className="text-xs" /> (net:{" "}
                {comparisonVerdictStats
                  .map((s) => `${s.model.name} ${formatNet(s.byVerdict.better - s.byVerdict.worse)}`)
                  .join(" · ")}
                )
              </li>
            </ul>
            <p className="mt-1 text-xs text-ink-3">
              Finding counts measure defect density under one reviewer; comparison verdicts measure
              capability against a reference. They rank the branches differently — which lens
              matters depends on the question being asked, and no cross-branch decision is implied
              here.
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

const VERDICT_BAR: Array<{ verdict: Verdict; label: string; color: string }> = [
  { verdict: "better", label: "Better", color: "#0ca30c" },
  { verdict: "same", label: "Same", color: "var(--ink-3)" },
  { verdict: "worse", label: "Worse", color: "var(--sev-medium)" },
  { verdict: "missing", label: "Missing", color: "var(--sev-high)" },
];

function ComparisonVerdicts() {
  return (
    <section aria-labelledby="verdicts-heading">
      <Card>
        <CardHeader>
          <CardTitle id="verdicts-heading">Verdicts vs the reference implementation</CardTitle>
          <p className="text-xs text-ink-2">
            Each implementation graded topic-by-topic against the reference codebase by the same
            fixed comparer — {comparisonReviewer} — so the verdict mixes compare across agents.
            Topic totals differ because each report merged concerns differently; bars show
            composition.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {comparisonVerdictStats.map(({ model, total, byVerdict }) => {
            const net = byVerdict.better - byVerdict.worse;
            return (
              <div key={model.id}>
                <div className="mb-1.5 flex items-baseline justify-between gap-2">
                  <ModelMark modelId={model.id} className="text-xs" />
                  <span className="font-mono text-[0.68rem] text-ink-3 tabular-nums">
                    {total} topics · net {net > 0 ? `+${net}` : net}
                  </span>
                </div>
                <div
                  role="img"
                  aria-label={`${model.name}: ${VERDICT_BAR.map(
                    ({ verdict, label }) => `${byVerdict[verdict]} ${label.toLowerCase()}`,
                  ).join(", ")} of ${total} topics`}
                  className="flex h-4 w-full overflow-hidden rounded-[4px]"
                >
                  {VERDICT_BAR.map(({ verdict, color }) =>
                    byVerdict[verdict] > 0 ? (
                      <span
                        key={verdict}
                        style={{ width: `${(byVerdict[verdict] / total) * 100}%`, background: color }}
                      />
                    ) : null,
                  )}
                </div>
                <p className="mt-1 text-[0.7rem] text-ink-3 tabular-nums">
                  {VERDICT_BAR.filter(({ verdict }) => byVerdict[verdict] > 0)
                    .map(({ verdict, label }) => `${byVerdict[verdict]} ${label.toLowerCase()}`)
                    .join(" · ")}
                  {byVerdict.unknown > 0 && ` · ${byVerdict.unknown} unknown`}
                </p>
              </div>
            );
          })}
          <p className="border-t border-hairline pt-3 text-[0.7rem] leading-relaxed text-ink-3">
            <span className="mr-3 inline-flex items-center gap-1.5">
              {VERDICT_BAR.map(({ verdict, label, color }) => (
                <span key={verdict} className="mr-2 inline-flex items-center gap-1">
                  <span aria-hidden className="size-2 rounded-[2px]" style={{ background: color }} />
                  {label}
                </span>
              ))}
            </span>
            <Link to="/comparisons" className="underline hover:text-ink">
              Browse every topic and rationale →
            </Link>
          </p>
        </CardContent>
      </Card>
    </section>
  );
}

function CoverageMatrix({
  clusters,
  resolveFinding,
  linkBase,
  footer,
}: {
  clusters: Cluster[];
  resolveFinding: (id: string) => BrowsableFinding;
  linkBase: string;
  footer: React.ReactNode;
}) {
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
                  to={`${linkBase}#${cluster.id}`}
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
                  .map((m) => resolveFinding(m.findingId))
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
      <p className="border-t border-hairline px-4 py-3 text-[0.7rem] text-ink-3">{footer}</p>
    </div>
  );
}
