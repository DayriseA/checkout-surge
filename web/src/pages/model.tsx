import { useMemo } from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { allFindings, modelById, modelStats, reportMarkdown } from "@/lib/data";
import { SEVERITY_ORDER } from "@/lib/schema";
import { severityColorVar, severityLabel } from "@/lib/utils";
import { FindingRow } from "@/components/finding-row";
import { Markdown } from "@/components/markdown";
import { ModelMark } from "@/components/model-mark";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function ModelPage() {
  const { modelId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const model = modelById(modelId);

  const findings = useMemo(
    () =>
      allFindings
        .filter((f) => f.model === modelId)
        .sort(
          (a, b) =>
            Number(a.tier === "note") - Number(b.tier === "note") ||
            SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
            a.code.localeCompare(b.code, undefined, { numeric: true }),
        ),
    [modelId],
  );

  if (!model) return <Navigate to="/" replace />;
  const stats = modelStats.find((s) => s.model.id === modelId);

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
          </dl>
        )}
      </header>

      <Tabs
        value={params.get("tab") === "report" ? "report" : "findings"}
        onValueChange={(tab) => {
          const next = new URLSearchParams(params);
          if (tab === "report") next.set("tab", "report");
          else next.delete("tab");
          setParams(next, { replace: true });
        }}
      >
        <TabsList>
          <TabsTrigger value="findings">Findings</TabsTrigger>
          <TabsTrigger value="report">Full report</TabsTrigger>
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
      </Tabs>
    </div>
  );
}
