import {
  countUnavailableLoadRunDiagnosticProbes,
  type LoadRunDiagnosticsSummary,
} from "@checkout-surge/contracts";
import type { ReactNode } from "react";
import { formatCount, formatInstantUtc } from "../lib/presentation/format";

const unavailable = "Could not determine";

export function RunDiagnostics({
  summary,
  warningCount = 0,
}: {
  summary: LoadRunDiagnosticsSummary | null;
  warningCount?: number;
}) {
  const unavailableCount = countUnavailableLoadRunDiagnosticProbes(summary);
  const fallbackCount = summary?.terminalMetricSources
    ? Object.values(summary.terminalMetricSources).filter((source) => source === "point_stream")
        .length
    : 0;
  return (
    <details className="rounded-lg border border-border bg-surface">
      <summary className="cursor-pointer px-4 py-3">
        <h2 className="m-0 inline text-base font-bold text-ink">Generator diagnostics</h2>
        <span
          className={`ml-3 text-xs font-bold uppercase ${warningCount > 0 ? "text-warning" : "text-muted"}`}
        >
          {formatNumber(warningCount)} warnings ·{" "}
          {formatNumber(summary?.stderrLineCountRetained ?? 0)} stderr retained ·{" "}
          {summary &&
          (summary.stderrLineTruncatedCount > 0 ||
            summary.stderrLineCountObserved > summary.stderrLineCountRetained)
            ? "truncated"
            : "not truncated"}{" "}
          · {formatNumber(unavailableCount)} unavailable probes · {formatNumber(fallbackCount)}{" "}
          fallback metric sources
        </span>
      </summary>
      {summary ? (
        <div className="grid grid-cols-3 gap-4 border-t border-border p-4 max-[1100px]:grid-cols-2 max-[700px]:grid-cols-1">
          <GeneratorHost summary={summary} />
          <GeneratorCapacity capacity={summary.generatorCapacity} />
          <GeneratorUtilisation utilisation={summary.generatorUtilisation} />
          <GeneratorNetwork network={summary.networkDiagnostics} />
          <K6Process summary={summary} />
          <MetricProvenance summary={summary} />
          <K6Stderr summary={summary} />
        </div>
      ) : (
        <p className="m-0 border-t border-border p-4 text-sm font-semibold text-muted">
          Generator diagnostics were unavailable for this run.
        </p>
      )}
    </details>
  );
}

function GeneratorHost({ summary }: { summary: LoadRunDiagnosticsSummary }) {
  if (
    summary.nproc === null &&
    summary.ulimitNofile === null &&
    summary.processMaxOpenFiles === null
  ) {
    return <UnavailableGroup title="Generator host" />;
  }

  const cgroupCpuQuota = summary.generatorCapacity?.cgroupCpuQuota;
  const cpuScopeNote =
    summary.nproc !== null &&
    cgroupCpuQuota !== null &&
    cgroupCpuQuota !== undefined &&
    cgroupCpuQuota < summary.nproc
      ? `Generator CPU scope differs: ${formatNumber(summary.nproc)} host logical CPUs; ${nullableNumber(cgroupCpuQuota)} cgroup CPU quota.`
      : undefined;

  return (
    <DiagnosticGroup
      title="Generator host"
      {...(cpuScopeNote ? { note: cpuScopeNote } : {})}
      facts={[
        ["Generator host logical CPUs", nullableNumber(summary.nproc)],
        ["Generator process ulimit -n", nullableNumber(summary.ulimitNofile)],
        [
          "k6 process open-files soft limit",
          nullableNumber(summary.processMaxOpenFiles?.soft ?? null),
        ],
        [
          "k6 process open-files hard limit",
          nullableNumber(summary.processMaxOpenFiles?.hard ?? null),
        ],
      ]}
    />
  );
}

function GeneratorCapacity({
  capacity,
}: {
  capacity: LoadRunDiagnosticsSummary["generatorCapacity"];
}) {
  if (!capacity) return <UnavailableGroup title="Generator capacity" />;

  return (
    <DiagnosticGroup
      title="Generator capacity"
      facts={[
        ["Generator host total memory", byteValue(capacity.memTotalBytes)],
        ["Generator host available memory", byteValue(capacity.memAvailableBytes)],
        ["Generator host swap", byteValue(capacity.swapTotalBytes)],
        [
          "Generator cgroup memory limit",
          limitValue(
            capacity.cgroupMemoryLimitBytes,
            capacity.cgroupMemoryLimitUnlimited,
            byteValue,
          ),
        ],
        [
          "Generator cgroup CPU quota",
          limitValue(capacity.cgroupCpuQuota, capacity.cgroupCpuQuotaUnlimited, nullableNumber),
        ],
      ]}
    />
  );
}

function GeneratorUtilisation({
  utilisation,
}: {
  utilisation: LoadRunDiagnosticsSummary["generatorUtilisation"];
}) {
  if (!utilisation) return <UnavailableGroup title="Generator utilisation" />;

  return (
    <DiagnosticGroup
      title="Generator utilisation"
      facts={[
        ["k6 process peak RSS", byteValue(utilisation.peakK6RssBytes)],
        ["Generator cgroup peak memory", byteValue(utilisation.peakCgroupMemoryBytes)],
        [
          "Generator host minimum available memory",
          byteValue(utilisation.minimumHostMemAvailableBytes),
        ],
        ["k6 process peak CPU utilisation", percentValue(utilisation.peakCpuUtilisationPercent)],
        ["k6 process mean CPU utilisation", percentValue(utilisation.meanCpuUtilisationPercent)],
        ["Generator cgroup peak swap", byteValue(utilisation.peakCgroupSwapBytes)],
        [
          "Generator cgroup memory high events",
          nullableNumber(utilisation.finalMemoryEventsHighCount),
        ],
        [
          "Generator cgroup memory max events",
          nullableNumber(utilisation.finalMemoryEventsMaxCount),
        ],
        ["Generator cgroup OOM kills", nullableNumber(utilisation.finalMemoryEventsOomKillCount)],
        ["Generator utilisation samples", formatNumber(utilisation.sampleCount)],
        ["Generator sampling interval", `${formatNumber(utilisation.effectiveIntervalMs)}ms`],
      ]}
    />
  );
}

function GeneratorNetwork({
  network,
}: {
  network: LoadRunDiagnosticsSummary["networkDiagnostics"];
}) {
  if (!network) return <UnavailableGroup title="Generator network" />;

  return (
    <DiagnosticGroup
      title="Generator network"
      facts={[
        ["Generator local TCP port range", network.ipLocalPortRange ?? unavailable],
        ["Generator tcp_tw_reuse", nullableNumber(network.tcpTwReuse)],
        ["Generator tcp_timestamps", nullableNumber(network.tcpTimestamps)],
      ]}
    />
  );
}

function K6Process({ summary }: { summary: LoadRunDiagnosticsSummary }) {
  const plan = summary.executionPlan;
  const planFacts: DiagnosticFact[] =
    plan.trafficMode === "buyer-spike"
      ? [
          ["k6 traffic mode", "buyer spike"],
          ["k6 buyer count", formatNumber(plan.buyerCount)],
          ["k6 duplicate each buyer attempt", plan.duplicateEachBuyerAttempt ? "yes" : "no"],
          ["k6 iterations per VU", formatNumber(plan.iterationsPerVu)],
          ["k6 planned emitted attempts", formatNumber(plan.plannedEmittedAttempts)],
          ["k6 start delay", `${formatNumber(plan.startDelaySeconds)}s`],
          ["k6 maximum duration", `${formatNumber(plan.maxDurationSeconds)}s`],
        ]
      : [
          ["k6 traffic mode", "constant arrival rate"],
          ["k6 scheduled rate", `${formatNumber(plan.ratePerSecond)}/s`],
          ["k6 duration", `${formatNumber(plan.durationSeconds)}s`],
          ["k6 planned emitted attempts", formatNumber(plan.plannedEmittedAttempts)],
          ["k6 start delay", `${formatNumber(plan.startDelaySeconds)}s`],
          ["k6 pre-allocated VUs", formatNumber(plan.preAllocatedVus)],
          ["k6 maximum VUs", formatNumber(plan.maxVus)],
        ];

  return (
    <DiagnosticGroup
      title="k6 process"
      facts={[
        [
          "k6 started",
          <time dateTime={summary.startedAt} key="started" title={summary.startedAt}>
            {formatInstantUtc(summary.startedAt)}
          </time>,
        ],
        [
          "k6 completed",
          <time dateTime={summary.completedAt} key="completed" title={summary.completedAt}>
            {formatInstantUtc(summary.completedAt)}
          </time>,
        ],
        ["k6 version", summary.k6Version ?? unavailable],
        ...planFacts,
      ]}
    />
  );
}

function MetricProvenance({ summary }: { summary: LoadRunDiagnosticsSummary }) {
  const sources = summary.terminalMetricSources;
  const warnings = summary.summaryExportWarnings;

  const facts: DiagnosticFact[] = sources
    ? [
        ["k6 started-request source", metricSource(sources.startedRequests)],
        ["k6 completed-request source", metricSource(sources.completedRequests)],
        ["k6 accepted-response source", metricSource(sources.acceptedResponses)],
        ["k6 sold-out-response source", metricSource(sources.soldOutResponses)],
        ["k6 transport-failure source", metricSource(sources.transportFailures)],
        ["k6 unexpected-response source", metricSource(sources.unexpectedResponses)],
        ["k6 dropped-iteration source", metricSource(sources.droppedIterations)],
        ["k6 completed-iteration source", metricSource(sources.completedIterations)],
      ]
    : [["k6 terminal metric sources", unavailable]];
  if (warnings?.length) {
    facts.push([
      "k6 summary-export warnings",
      <ul className="m-0 list-none p-0" key="warnings">
        {warnings.map((warning) => (
          <li key={warning}>
            {warningExplanation(warning)} <code>{warning}</code>
          </li>
        ))}
      </ul>,
    ]);
  }

  return <DiagnosticGroup title="k6 metric provenance" facts={facts} />;
}

function K6Stderr({ summary }: { summary: LoadRunDiagnosticsSummary }) {
  return (
    <section className="col-span-3 min-w-0 border-t border-border pt-3 max-[1100px]:col-span-2 max-[700px]:col-span-1">
      <h3 className="m-0 text-sm font-bold text-ink">k6 stderr</h3>
      <DiagnosticFacts
        facts={[
          ["k6 stderr lines observed", formatNumber(summary.stderrLineCountObserved)],
          ["k6 stderr lines retained", formatNumber(summary.stderrLineCountRetained)],
          ["k6 stderr retained-line limit", formatNumber(summary.stderrRetainedLineLimit)],
          [
            "k6 stderr line-length limit",
            `${formatNumber(summary.stderrLineTruncationLength)} characters`,
          ],
          ["k6 stderr lines truncated", formatNumber(summary.stderrLineTruncatedCount)],
        ]}
      />
      {summary.stderrLines.length > 0 ? (
        <pre className="m-0 mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-canvas p-3 text-xs leading-5 text-muted-strong [overflow-wrap:anywhere]">
          {summary.stderrLines.join("\n")}
        </pre>
      ) : (
        <p className="m-0 mt-3 text-sm font-semibold text-muted">
          No retained generator stderr lines.
        </p>
      )}
    </section>
  );
}

type DiagnosticFact = [string, ReactNode];

function DiagnosticGroup({
  facts,
  note,
  title,
}: {
  facts: DiagnosticFact[];
  note?: string;
  title: string;
}) {
  return (
    <section className="min-w-0 border-t border-border pt-3">
      <h3 className="m-0 text-sm font-bold text-ink">{title}</h3>
      {note ? <p className="m-0 mt-1 text-xs text-muted">{note}</p> : null}
      <DiagnosticFacts facts={facts} />
    </section>
  );
}

function DiagnosticFacts({ facts }: { facts: DiagnosticFact[] }) {
  return (
    <dl className="m-0 mt-3 grid gap-2">
      {facts.map(([label, value]) => (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3" key={label}>
          <dt className="text-sm text-muted">{label}</dt>
          <dd className="m-0 max-w-56 [overflow-wrap:anywhere] text-right text-sm font-semibold text-muted-strong">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function UnavailableGroup({ title }: { title: string }) {
  return (
    <section className="min-w-0 border-t border-border pt-3">
      <h3 className="m-0 text-sm font-bold text-ink">{title}</h3>
      <p className="m-0 mt-3 text-sm font-semibold text-muted">
        {title} diagnostics were unavailable.
      </p>
    </section>
  );
}

function byteValue(value: number | null): ReactNode {
  return value === null ? (
    unavailable
  ) : (
    <span title={`${value} bytes`}>{formatDiagnosticBytes(value)}</span>
  );
}

function percentValue(value: number | null): string {
  return value === null ? unavailable : `${formatDecimal(value)}%`;
}

function nullableNumber(value: number | null): string {
  if (value === null) return unavailable;
  return Number.isInteger(value) ? formatNumber(value) : formatDecimal(value);
}

function limitValue(
  value: number | null,
  unlimited: boolean | null,
  formatter: (value: number | null) => ReactNode,
): ReactNode {
  if (value !== null) return formatter(value);
  return unlimited === true ? "Unlimited" : unavailable;
}

function metricSource(value: "summary_export" | "point_stream" | null): ReactNode {
  if (value === null) return unavailable;
  return (
    <>
      {value === "summary_export" ? "k6 summary export" : "retained point-stream fallback"}{" "}
      <code>{value}</code>
    </>
  );
}

function warningExplanation(
  value: NonNullable<LoadRunDiagnosticsSummary["summaryExportWarnings"]>[number],
): string {
  switch (value) {
    case "summary_export_missing":
      return "The k6 summary export was not present.";
    case "summary_export_invalid":
      return "The k6 summary export could not be validated.";
    case "summary_export_read_failed":
      return "The k6 summary export could not be read.";
    case "k6_outcome_counter_point_stream_fallback_used":
      return "A retained point stream supplied an outcome counter.";
    case "k6_outcome_counter_summary_export_unavailable":
      return "A k6 outcome counter was unavailable from the summary export.";
  }
}

function formatNumber(value: number): string {
  return formatCount(value) ?? unavailable;
}

/**
 * Diagnostics is a technical-details block, so raw significant digits are retained here
 * deliberately: they support diagnosis rather than a public summary reading.
 */
function formatDecimal(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 }).format(value);
}

export function formatDiagnosticBytes(value: number): string {
  if (value < 1_024) return `${formatNumber(value)} B`;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1_024)), units.length - 1);
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(
    value / 1_024 ** exponent,
  )} ${units[exponent]}`;
}
