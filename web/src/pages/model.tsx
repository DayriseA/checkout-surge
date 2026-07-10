import { useMemo } from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";
import {
  allFindings,
  allIndependentFindings,
  independentModelStats,
  independentReviewFileFor,
  modelById,
  modelStats,
  reportMarkdown,
  sourceMarkdown,
  type BrowsableFinding,
} from "@/lib/data";
import { SEVERITY_ORDER } from "@/lib/schema";
import { severityColorVar, severityLabel } from "@/lib/utils";
import { FindingRow } from "@/components/finding-row";
import { Markdown } from "@/components/markdown";
import { ModelMark } from "@/components/model-mark";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function sortFindings<T extends BrowsableFinding>(findings: T[]): T[] {
  return findings.sort(
    (a, b) =>
      Number(a.tier === "note") - Number(b.tier === "note") ||
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.code.localeCompare(b.code, undefined, { numeric: true }),
  );
}

export function ModelPage() {
  const { modelId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const model = modelById(modelId);
  const independentFile = independentReviewFileFor(modelId);

  const findings = useMemo(
    () => sortFindings(allFindings.filter((f) => f.model === modelId)),
    [modelId],
  );
  const independentFindings = useMemo(
    () => sortFindings(allIndependentFindings.filter((f) => f.model === modelId)),
    [modelId],
  );

  if (!model) return <Navigate to="/" replace />;
  const stats = modelStats.find((s) => s.model.id === modelId);
  const independentStats = independentModelStats.find((s) => s.model.id === modelId);

  const tabValues = independentFile
    ? ["findings", "report", "independent", "independent-report"]
    : ["findings", "report"];
  const requestedTab = params.get("tab") ?? "findings";
  const tab = tabValues.includes(requestedTab) ? requestedTab : "findings";

  return (
    <div className="space-y-6">
      <header>
        <ModelMark modelId={model.id} className="text-xl font-semibold tracking-tight" detail />
        <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-ink-2">{model.notes}</p>
        {stats && (
          <dl className="mt-4 flex flex-wrap gap-6">
            <div>
              <dt className="text-[0.65rem] tracking-wider text-ink-3 uppercase">Findings</dt>
              <dd className="text-2xl font-semibold tabular-nums">{stats.total}</dd>
            </div>
            {SEVERITY_ORDER.filter((s) => s !== "info").map((severity) => (
              <div key={severity}>
                <dt className="flex items-center gap-1 text-[0.65rem] tracking-wider text-ink-3 uppercase">
                  <span
                    aria-hidden
                    className="size-1.5 rounded-full"
                    style={{ background: severityColorVar[severity] }}
                  />
                  {severityLabel[severity]}
                </dt>
                <dd className="text-2xl font-semibold tabular-nums">{stats.bySeverity[severity]}</dd>
              </div>
            ))}
            {stats.notes > 0 && (
              <div>
                <dt className="text-[0.65rem] tracking-wider text-ink-3 uppercase">Notes</dt>
                <dd className="text-2xl font-semibold tabular-nums">{stats.notes}</dd>
              </div>
            )}
            {independentStats && independentStats.total > 0 && (
              <div>
                <dt className="text-[0.65rem] tracking-wider text-ink-3 uppercase">
                  Independent findings
                </dt>
                <dd className="text-2xl font-semibold tabular-nums">{independentStats.total}</dd>
              </div>
            )}
          </dl>
        )}
      </header>

      <Tabs
        value={tab}
        onValueChange={(nextTab) => {
          const next = new URLSearchParams(params);
          if (nextTab === "findings") next.delete("tab");
          else next.set("tab", nextTab);
          setParams(next, { replace: true });
        }}
      >
        <TabsList>
          <TabsTrigger value="findings">Self-audit findings</TabsTrigger>
          <TabsTrigger value="report">Self-audit report</TabsTrigger>
          {independentFile && (
            <>
              <TabsTrigger value="independent">Independent review</TabsTrigger>
              <TabsTrigger value="independent-report">Independent report</TabsTrigger>
            </>
          )}
        </TabsList>

        <TabsContent value="findings">
          <Card>
            {findings.map((finding) => (
              <FindingRow key={finding.id} finding={finding} showModel={false} />
            ))}
          </Card>
        </TabsContent>

        <TabsContent value="report">
          <Card className="max-w-[90ch] px-6 py-2">
            <Markdown>{reportMarkdown(model)}</Markdown>
          </Card>
          <p className="mt-2 font-mono text-xs text-ink-3">source: results/{model.reportFile}</p>
        </TabsContent>

        {independentFile && (
          <>
            <TabsContent value="independent">
              <p className="mb-3 max-w-[70ch] text-xs leading-relaxed text-ink-2">
                Post-fix branch reviewed by the fixed reviewer, {independentFile.reviewer}. Each
                finding notes whether this agent's own self-audit caught the same issue class.
              </p>
              <Card>
                {independentFindings.map((finding) => (
                  <FindingRow key={finding.id} finding={finding} showModel={false} />
                ))}
              </Card>
            </TabsContent>

            <TabsContent value="independent-report">
              <Card className="max-w-[90ch] px-6 py-2">
                <Markdown>{sourceMarkdown(independentFile.source)}</Markdown>
              </Card>
              <p className="mt-2 font-mono text-xs text-ink-3">
                source: results/{independentFile.source}
              </p>
            </TabsContent>
          </>
        )}
      </Tabs>
    </div>
  );
}
