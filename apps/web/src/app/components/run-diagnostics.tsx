"use client";

import {
  countUnavailableLoadRunDiagnosticProbes,
  type LoadRunDiagnosticsSummary,
} from "@checkout-surge/contracts";
import type { ReactNode } from "react";
import { useLocale, useTranslation } from "../lib/i18n/locale-context";
import { getTranslation, type Locale } from "../lib/i18n/translate";
import { formatCount, formatInstantUtc } from "../lib/presentation/format";

const unavailable = "Could not determine";

export function RunDiagnostics({
  summary,
  apiDroppedLiveMetricBatchCount,
  warningCount = 0,
}: {
  summary: LoadRunDiagnosticsSummary | null;
  apiDroppedLiveMetricBatchCount: number | null;
  warningCount?: number;
}) {
  const t = useTranslation();
  const locale = useLocale();
  const unavailableCount = countUnavailableLoadRunDiagnosticProbes(summary);
  const fallbackCount = summary?.terminalMetricSources
    ? Object.values(summary.terminalMetricSources).filter((source) => source === "point_stream")
        .length
    : 0;
  return (
    <details className="rounded-2xl border border-border bg-surface">
      <summary className="disclosure flex-wrap px-5 py-3.5">
        <h2 className="type-title m-0 inline text-base text-ink">{t("Generator diagnostics")}</h2>
        <span
          className={`text-xs font-semibold ${warningCount > 0 ? "text-warning" : "text-muted"}`}
        >
          {formatNumber(warningCount, locale)} {t("warnings ·")}{" "}
          {formatNumber(summary?.stderrLineCountRetained ?? 0, locale)} {t("stderr retained ·")}{" "}
          {summary &&
          (summary.stderrLineTruncatedCount > 0 ||
            summary.stderrLineCountObserved > summary.stderrLineCountRetained)
            ? t("truncated")
            : t("not truncated")}{" "}
          · {formatNumber(unavailableCount, locale)} {t("unavailable probes ·")}{" "}
          {formatNumber(fallbackCount, locale)} {t("fallback metric sources")}
        </span>
      </summary>
      {summary ? (
        <div className="grid grid-cols-3 gap-4 border-t border-border p-4 max-[1100px]:grid-cols-2 max-[700px]:grid-cols-1">
          <GeneratorHost summary={summary} />
          <GeneratorCapacity capacity={summary.generatorCapacity} />
          <GeneratorUtilisation
            utilisation={summary.generatorUtilisation}
            highEventsNotApplicable={
              summary.notApplicableProbes?.includes("finalMemoryEventsHighCount") === true
            }
          />
          <GeneratorNetwork network={summary.networkDiagnostics} />
          <K6Process summary={summary} />
          <MetricProvenance summary={summary} />
          <LiveMetricStream
            runnerLoss={summary.liveMetricLoss}
            apiDroppedBatchCount={apiDroppedLiveMetricBatchCount}
          />
          <K6Stderr summary={summary} />
        </div>
      ) : (
        <p className="m-0 border-t border-border p-4 text-sm font-semibold text-muted">
          {t("Generator diagnostics were unavailable for this run.")}
        </p>
      )}
    </details>
  );
}

function GeneratorHost({ summary }: { summary: LoadRunDiagnosticsSummary }) {
  const t = useTranslation();
  const locale = useLocale();
  if (
    summary.nproc === null &&
    summary.ulimitNofile === null &&
    summary.processMaxOpenFiles === null
  ) {
    return <UnavailableGroup title={t("Generator host")} />;
  }

  const cgroupCpuQuota = summary.generatorCapacity?.cgroupCpuQuota;
  const cpuScopeNote =
    summary.nproc !== null &&
    cgroupCpuQuota !== null &&
    cgroupCpuQuota !== undefined &&
    cgroupCpuQuota < summary.nproc
      ? t("Generator CPU scope differs: {v0} host logical CPUs; {v1} cgroup CPU quota.", {
          v0: String(formatNumber(summary.nproc, locale)),
          v1: String(nullableNumber(cgroupCpuQuota, locale)),
        })
      : undefined;

  return (
    <DiagnosticGroup
      title={t("Generator host")}
      {...(cpuScopeNote ? { note: cpuScopeNote } : {})}
      facts={[
        [t("Generator host logical CPUs"), nullableNumber(summary.nproc, locale)],
        [t("Generator process ulimit -n"), nullableNumber(summary.ulimitNofile, locale)],
        [
          t("k6 process open-files soft limit"),
          nullableNumber(summary.processMaxOpenFiles?.soft ?? null, locale),
        ],
        [
          t("k6 process open-files hard limit"),
          nullableNumber(summary.processMaxOpenFiles?.hard ?? null, locale),
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
  const t = useTranslation();
  const locale = useLocale();
  if (!capacity) return <UnavailableGroup title={t("Generator capacity")} />;

  return (
    <DiagnosticGroup
      title={t("Generator capacity")}
      facts={[
        [t("Generator host total memory"), byteValue(capacity.memTotalBytes, locale)],
        [t("Generator host available memory"), byteValue(capacity.memAvailableBytes, locale)],
        [t("Generator host swap"), byteValue(capacity.swapTotalBytes, locale)],
        [
          t("Generator cgroup memory limit"),
          limitValue(
            capacity.cgroupMemoryLimitBytes,
            capacity.cgroupMemoryLimitUnlimited,
            byteValue,
            locale,
          ),
        ],
        [
          t("Generator cgroup CPU quota"),
          limitValue(
            capacity.cgroupCpuQuota,
            capacity.cgroupCpuQuotaUnlimited,
            nullableNumber,
            locale,
          ),
        ],
      ]}
    />
  );
}

function GeneratorUtilisation({
  utilisation,
  highEventsNotApplicable,
}: {
  utilisation: LoadRunDiagnosticsSummary["generatorUtilisation"];
  highEventsNotApplicable: boolean;
}) {
  const t = useTranslation();
  const locale = useLocale();
  if (!utilisation) return <UnavailableGroup title={t("Generator utilisation")} />;

  return (
    <DiagnosticGroup
      title={t("Generator utilisation")}
      facts={[
        [t("k6 process peak RSS"), byteValue(utilisation.peakK6RssBytes, locale)],
        [t("Generator cgroup peak memory"), byteValue(utilisation.peakCgroupMemoryBytes, locale)],
        [
          t("Generator host minimum available memory"),
          byteValue(utilisation.minimumHostMemAvailableBytes, locale),
        ],
        [
          t("k6 process peak CPU utilisation"),
          percentValue(utilisation.peakCpuUtilisationPercent, locale),
        ],
        [
          t("k6 process mean CPU utilisation"),
          percentValue(utilisation.meanCpuUtilisationPercent, locale),
        ],
        [t("Generator cgroup peak swap"), byteValue(utilisation.peakCgroupSwapBytes, locale)],
        [
          t("Generator cgroup memory high events"),
          highEventsNotApplicable && utilisation.finalMemoryEventsHighCount === null
            ? t("Not applicable")
            : nullableNumber(utilisation.finalMemoryEventsHighCount, locale),
        ],
        [
          t("Generator cgroup memory max events"),
          nullableNumber(utilisation.finalMemoryEventsMaxCount, locale),
        ],
        [
          t("Generator cgroup OOM kills"),
          nullableNumber(utilisation.finalMemoryEventsOomKillCount, locale),
        ],
        [t("Generator utilisation samples"), formatNumber(utilisation.sampleCount, locale)],
        [
          t("Generator sampling interval"),
          `${formatNumber(utilisation.effectiveIntervalMs, locale)}ms`,
        ],
      ]}
    />
  );
}

function GeneratorNetwork({
  network,
}: {
  network: LoadRunDiagnosticsSummary["networkDiagnostics"];
}) {
  const t = useTranslation();
  const locale = useLocale();
  if (!network) return <UnavailableGroup title={t("Generator network")} />;

  return (
    <DiagnosticGroup
      title={t("Generator network")}
      facts={[
        [t("Generator local TCP port range"), network.ipLocalPortRange ?? unavailable],
        [t("Generator tcp_tw_reuse"), nullableNumber(network.tcpTwReuse, locale)],
        [t("Generator tcp_timestamps"), nullableNumber(network.tcpTimestamps, locale)],
      ]}
    />
  );
}

function K6Process({ summary }: { summary: LoadRunDiagnosticsSummary }) {
  const t = useTranslation();
  const locale = useLocale();
  const plan = summary.executionPlan;
  const planFacts: DiagnosticFact[] =
    plan.trafficMode === "buyer-spike"
      ? [
          [t("k6 traffic mode"), t("buyer spike")],
          [t("k6 buyer count"), formatNumber(plan.buyerCount, locale)],
          [t("k6 duplicate each buyer attempt"), plan.duplicateEachBuyerAttempt ? "yes" : "no"],
          [t("k6 iterations per VU"), formatNumber(plan.iterationsPerVu, locale)],
          [t("k6 planned emitted attempts"), formatNumber(plan.plannedEmittedAttempts, locale)],
          [t("k6 start delay"), `${formatNumber(plan.startDelaySeconds, locale)}s`],
          [t("k6 maximum duration"), `${formatNumber(plan.maxDurationSeconds, locale)}s`],
        ]
      : [
          [t("k6 traffic mode"), t("constant arrival rate")],
          [t("k6 scheduled rate"), `${formatNumber(plan.ratePerSecond, locale)}/s`],
          [t("k6 duration"), `${formatNumber(plan.durationSeconds, locale)}s`],
          [t("k6 planned emitted attempts"), formatNumber(plan.plannedEmittedAttempts, locale)],
          [t("k6 start delay"), `${formatNumber(plan.startDelaySeconds, locale)}s`],
          [t("k6 pre-allocated VUs"), formatNumber(plan.preAllocatedVus, locale)],
          [t("k6 maximum VUs"), formatNumber(plan.maxVus, locale)],
        ];

  return (
    <DiagnosticGroup
      title={t("k6 process")}
      facts={[
        [
          t("k6 started"),
          <time dateTime={summary.startedAt} key="started" title={summary.startedAt}>
            {formatInstantUtc(summary.startedAt, { locale })}
          </time>,
        ],
        [
          t("k6 completed"),
          <time dateTime={summary.completedAt} key="completed" title={summary.completedAt}>
            {formatInstantUtc(summary.completedAt, { locale })}
          </time>,
        ],
        [t("k6 version"), summary.k6Version ?? unavailable],
        ...planFacts,
      ]}
    />
  );
}

function MetricProvenance({ summary }: { summary: LoadRunDiagnosticsSummary }) {
  const t = useTranslation();
  const locale = useLocale();
  const sources = summary.terminalMetricSources;
  const warnings = summary.summaryExportWarnings;

  const facts: DiagnosticFact[] = sources
    ? [
        [t("k6 started-request source"), metricSource(sources.startedRequests, locale)],
        [t("k6 completed-request source"), metricSource(sources.completedRequests, locale)],
        [t("k6 accepted-response source"), metricSource(sources.acceptedResponses, locale)],
        [t("k6 sold-out-response source"), metricSource(sources.soldOutResponses, locale)],
        [t("k6 transport-failure source"), metricSource(sources.transportFailures, locale)],
        [t("k6 unexpected-response source"), metricSource(sources.unexpectedResponses, locale)],
        [t("k6 dropped-iteration source"), metricSource(sources.droppedIterations, locale)],
        [t("k6 completed-iteration source"), metricSource(sources.completedIterations, locale)],
      ]
    : [[t("k6 terminal metric sources"), unavailable]];
  if (warnings?.length) {
    facts.push([
      t("k6 summary-export warnings"),
      <ul className="m-0 list-none p-0" key="warnings">
        {warnings.map((warning) => (
          <li key={warning}>
            {warningExplanation(warning, locale)} <code>{warning}</code>
          </li>
        ))}
      </ul>,
    ]);
  }

  return <DiagnosticGroup title={t("k6 metric provenance")} facts={facts} />;
}

function LiveMetricStream({
  runnerLoss,
  apiDroppedBatchCount,
}: {
  runnerLoss: LoadRunDiagnosticsSummary["liveMetricLoss"];
  apiDroppedBatchCount: number | null;
}) {
  const t = useTranslation();
  const locale = useLocale();
  return (
    <DiagnosticGroup
      title={t("Live metric stream")}
      note="Only the live dashboard can miss these; the final report does not."
      facts={[
        [
          t("Runner dropped live metric batches"),
          nullableNumber(runnerLoss?.batchCount ?? null, locale),
        ],
        [
          t("Runner dropped live metric samples"),
          nullableNumber(runnerLoss?.sampleCount ?? null, locale),
        ],
        [t("API dropped live metric batches"), nullableNumber(apiDroppedBatchCount, locale)],
      ]}
    />
  );
}

function K6Stderr({ summary }: { summary: LoadRunDiagnosticsSummary }) {
  const t = useTranslation();
  const locale = useLocale();
  return (
    <section className="col-span-3 min-w-0 border-t border-border pt-3 max-[1100px]:col-span-2 max-[700px]:col-span-1">
      <h3 className="m-0 text-sm font-bold text-ink">{t("k6 stderr")}</h3>
      <DiagnosticFacts
        facts={[
          [t("k6 stderr lines observed"), formatNumber(summary.stderrLineCountObserved, locale)],
          [t("k6 stderr lines retained"), formatNumber(summary.stderrLineCountRetained, locale)],
          [
            t("k6 stderr retained-line limit"),
            formatNumber(summary.stderrRetainedLineLimit, locale),
          ],
          [
            t("k6 stderr line-length limit"),
            t("{v0} characters", {
              v0: String(formatNumber(summary.stderrLineTruncationLength, locale)),
            }),
          ],
          [t("k6 stderr lines truncated"), formatNumber(summary.stderrLineTruncatedCount, locale)],
        ]}
      />
      {summary.stderrLines.length > 0 ? (
        <pre className="m-0 mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-canvas p-3 text-xs leading-5 text-muted-strong [overflow-wrap:anywhere]">
          {summary.stderrLines.join("\n")}
        </pre>
      ) : (
        <p className="m-0 mt-3 text-sm font-semibold text-muted">
          {t("No retained generator stderr lines.")}
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
  const t = useTranslation();

  return (
    <section className="min-w-0 border-t border-border pt-3">
      <h3 className="m-0 text-sm font-bold text-ink">{t(title)}</h3>
      {note ? <p className="m-0 mt-1 text-xs text-muted">{note}</p> : null}
      <DiagnosticFacts facts={facts} />
    </section>
  );
}

function DiagnosticFacts({ facts }: { facts: DiagnosticFact[] }) {
  const t = useTranslation();

  return (
    <dl className="m-0 mt-3 grid gap-2">
      {facts.map(([label, value]) => (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3" key={label}>
          <dt className="text-sm text-muted">{t(label)}</dt>
          <dd className="m-0 max-w-56 [overflow-wrap:anywhere] text-right text-sm font-semibold text-muted-strong">
            {typeof value === "string" ? t(value) : value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function UnavailableGroup({ title }: { title: string }) {
  const t = useTranslation();

  return (
    <section className="min-w-0 border-t border-border pt-3">
      <h3 className="m-0 text-sm font-bold text-ink">{t(title)}</h3>
      <p className="m-0 mt-3 text-sm font-semibold text-muted">
        {t(title)} {t("diagnostics were unavailable.")}
      </p>
    </section>
  );
}

function byteValue(value: number | null, locale: Locale = "en"): ReactNode {
  const t = getTranslation(locale);
  return value === null ? (
    unavailable
  ) : (
    <span title={t("{v0} bytes", { v0: String(value) })}>
      {formatDiagnosticBytes(value, locale)}
    </span>
  );
}

function percentValue(value: number | null, locale: Locale = "en"): string {
  return value === null ? unavailable : `${formatDecimal(value, locale)}%`;
}

function nullableNumber(value: number | null, locale: Locale = "en"): string {
  if (value === null) return unavailable;
  return Number.isInteger(value) ? formatNumber(value, locale) : formatDecimal(value, locale);
}

function limitValue(
  value: number | null,
  unlimited: boolean | null,
  formatter: (value: number | null, locale: Locale) => ReactNode,
  locale: Locale = "en",
): ReactNode {
  const t = getTranslation(locale);
  if (value !== null) return formatter(value, locale);
  return unlimited === true ? t("Unlimited") : unavailable;
}

function metricSource(
  value: "summary_export" | "point_stream" | null,
  locale: Locale = "en",
): ReactNode {
  const t = getTranslation(locale);
  if (value === null) return unavailable;
  return (
    <>
      {value === "summary_export" ? t("k6 summary export") : t("retained point-stream fallback")}{" "}
      <code>{typeof value === "string" ? t(value) : value}</code>
    </>
  );
}

function warningExplanation(
  value: NonNullable<LoadRunDiagnosticsSummary["summaryExportWarnings"]>[number],
  locale: Locale = "en",
): string {
  const t = getTranslation(locale);
  switch (value) {
    case "summary_export_missing":
      return t("The k6 summary export was not present.");
    case "summary_export_invalid":
      return t("The k6 summary export could not be validated.");
    case "summary_export_read_failed":
      return t("The k6 summary export could not be read.");
    case "k6_outcome_counter_point_stream_fallback_used":
      return t("A retained point stream supplied an outcome counter.");
    case "k6_outcome_counter_summary_export_unavailable":
      return t("A k6 outcome counter was unavailable from the summary export.");
  }
}

function formatNumber(value: number, locale: Locale = "en"): string {
  return formatCount(value, locale) ?? unavailable;
}

/**
 * Diagnostics is a technical-details block, so raw significant digits are retained here
 * deliberately: they support diagnosis rather than a public summary reading.
 */
function formatDecimal(value: number, locale: Locale = "en"): string {
  return new Intl.NumberFormat(locale === "fr" ? "fr-FR" : "en-US", {
    maximumSignificantDigits: 4,
  }).format(value);
}

function formatDiagnosticBytes(value: number, locale: Locale = "en"): string {
  if (value < 1_024) return `${formatNumber(value, locale)} B`;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1_024)), units.length - 1);
  return `${new Intl.NumberFormat(locale === "fr" ? "fr-FR" : "en-US", {
    maximumFractionDigits: 1,
  }).format(value / 1_024 ** exponent)} ${units[exponent]}`;
}
