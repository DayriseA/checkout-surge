"use client";

import type {
  AdminRunHistoryDetailResponse,
  PublicRunHistoryDetailResponse,
} from "@checkout-surge/contracts";
import { deriveLoadExecutionPlan, deriveRunResult } from "@checkout-surge/contracts";
import Link from "next/link";
import type { ReactNode } from "react";
import { useLocale, useTranslation } from "../lib/i18n/locale-context";
import { getTranslation, type Locale } from "../lib/i18n/translate";
import {
  formatCount,
  formatDurationMs,
  formatInstantUtc,
  pluralize,
} from "../lib/presentation/format";
import { derivePublicRunSummary } from "../lib/presentation/public-run-summary";
import {
  durableCheckoutLens,
  publicFailureExplanation,
  publicStatusLabel,
  publicVocabulary,
  simulatedErpLens,
  trafficDeliveryStatusTone,
  trafficModeLabel,
} from "../lib/presentation/public-vocabulary";
import { runFailureExplanationEvidence } from "../lib/presentation/run-failure-explanation";
import { deriveTerminalSummaryPresentation } from "../lib/presentation/run-presentation-state";
import {
  evidenceFromRunHistoryDetail,
  oversoldUnitsFromTerminalInventory,
} from "../lib/presentation/run-result-presentation";
import {
  hasUnknownTrafficCounts,
  trafficEvidenceUnavailableText,
} from "../lib/presentation/traffic-evidence";
import { ConfigGroup, FieldRow } from "./config-presentation";
import { neutralLinkButtonClassName } from "./control-styles";
import { GoldSignals, PublicSignalChart } from "./gold-signals";
import { PublicRunConclusion, PublicRunConclusionProof, RunConclusion } from "./run-conclusion";
import { RunDiagnostics } from "./run-diagnostics";
import { StatusPill } from "./status-pill";
import {
  deriveSendingEndedAt,
  deriveTransportObservation,
  EnvironmentNote,
  formatHistogramBoundMilliseconds,
  formatMilliseconds,
  TransportObservationSection,
} from "./transport-observation";

interface RunHistoryDetailProps {
  actions?: ReactNode;
  detail: AdminRunHistoryDetailResponse;
  navigation?: ReactNode;
}

export function AdminRunHistoryDetail({ actions, detail, navigation }: RunHistoryDetailProps) {
  const t = useTranslation();
  const locale = useLocale();
  const { run, summary } = detail;
  if (summary.dataDiscarded) {
    return (
      <DiscardedRunDetail
        actions={actions}
        navigation={navigation}
        presetName={t(summary.presetName)}
        trafficEvidenceUnavailable={hasUnknownTrafficCounts(summary.transportAttemptCounts)}
        automatic={summary.failureCategory === "automatic_reset"}
      />
    );
  }
  const config = run.configSnapshot;
  const result = deriveRunResult(evidenceFromRunHistoryDetail(detail));
  const runPresentation = deriveTerminalSummaryPresentation(result, locale);
  const overallDuration =
    formatDurationMs(detail.overallDurationMs, locale) ??
    (summary.startedAt ? t("— unusable lifecycle boundary") : t("— no recorded start"));
  const failure = summary.failureCategory
    ? publicFailureExplanation(summary.failureCategory, locale)
    : null;

  return (
    <div className="grid grid-cols-1 gap-4">
      {navigation}
      <header className="rounded-2xl border border-border bg-surface px-5 py-3.5 max-[560px]:px-4 min-[900px]:sticky min-[900px]:top-14 min-[900px]:z-[5] min-[900px]:shadow-[0_8px_24px_-18px_rgb(13_27_42/0.5)]">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
            <p className="sr-only">{t("Run detail")}</p>
            <h1 className="type-display m-0 text-2xl leading-tight text-ink">
              {t(summary.presetName)}
            </h1>
            <p className="m-0 [overflow-wrap:anywhere] font-mono text-xs text-muted">
              {summary.runId}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 max-[700px]:justify-start">
            <StatusPill
              status={{
                ...runPresentation,
                label: publicStatusLabel(
                  {
                    family: "run",
                    status: summary.status,
                    displayLabel: runPresentation.label,
                  },
                  locale,
                ),
              }}
            />
            <StatusPill
              status={{ label: t("operator {value1}", { value1: run.operatorMode }), tone: "idle" }}
            />
            {hasUnknownTrafficCounts(summary.transportAttemptCounts) ? null : (
              <StatusPill
                status={{
                  label: adminDeliveryLabel(
                    summary.trafficDeliverySummary.trafficDeliveryStatus,
                    locale,
                  ),
                  tone: trafficDeliveryStatusTone(
                    summary.trafficDeliverySummary.trafficDeliveryStatus,
                  ),
                }}
              />
            )}
            {actions}
          </div>
        </div>
      </header>

      {detail.failureDiagnostic ? (
        <PublicRunConclusion
          result={result}
          runStatus={summary.status}
          showProof={false}
          failureExplanation={runFailureExplanationEvidence(detail)}
          stderrLines={detail.loadRunDiagnosticsSummary?.stderrLines ?? []}
          trafficDeliveryStatus={summary.trafficDeliverySummary.trafficDeliveryStatus}
          transportObservation={deriveTransportObservation(
            summary.transportAttemptCounts,
            summary.httpSummary.transportFailures,
          )}
        />
      ) : null}

      <section
        aria-label={t("Run overview")}
        className="rounded-2xl border border-border bg-surface p-5 max-[560px]:p-4"
      >
        <h2 className="type-title m-0 text-base leading-tight text-ink">{t("Run overview")}</h2>
        <div className="mt-3 grid grid-cols-4 gap-x-6 gap-y-4 max-[1100px]:grid-cols-2 max-[700px]:grid-cols-1">
          <FactList
            facts={[
              [t("Started"), formatDate(summary.startedAt, locale)],
              [t("Overall run duration"), overallDuration],
              [t("Traffic started"), formatDate(run.trafficStartedAt, locale)],
              [t("Sending ended"), formatSendingEnd(summary, locale)],
              [t("Finalized"), formatDate(run.finalizedAt, locale)],
              [t("Evidence recorded"), formatDate(summary.capturedAt, locale)],
              ...(run.runnerRegion
                ? [[t("Load generator region"), codeValue(run.runnerRegion)] as [string, ReactNode]]
                : []),
              ...(detail.internalFailureReason
                ? [
                    [t("Failure code"), codeValue(detail.internalFailureReason)] as [
                      string,
                      ReactNode,
                    ],
                  ]
                : []),
            ]}
            title={t("Lifecycle")}
          />
          <FactList
            caption={simulatedErpLens.caption}
            facts={[
              [
                t("Simulated ERP call attempts"),
                formatNumber(detail.erpAttemptSummary.totalCount, locale),
              ],
              [
                t("Succeeded attempts"),
                formatNumber(detail.erpAttemptSummary.byStatus.succeeded, locale),
              ],
              ...(detail.erpAttemptSummary.byStatus.failed > 0
                ? [
                    [
                      t("Failed attempts"),
                      formatNumber(detail.erpAttemptSummary.byStatus.failed, locale),
                    ] as [string, ReactNode],
                  ]
                : []),
              ...(detail.erpAttemptSummary.byStatus.timedOut > 0
                ? [
                    [
                      t("Timed-out attempts"),
                      formatNumber(detail.erpAttemptSummary.byStatus.timedOut, locale),
                    ] as [string, ReactNode],
                  ]
                : []),
              [
                t("Simulated ERP call average"),
                nullableMetricMs(detail.erpAttemptSummary.averageLatencyMs, locale),
              ],
              [
                t("Simulated ERP call p95"),
                nullableMetricMs(detail.erpAttemptSummary.p95LatencyMs, locale),
              ],
            ]}
            title={simulatedErpLens.title}
          />
          <FactList
            caption={durableCheckoutLens.caption}
            facts={[
              [
                publicVocabulary.uniqueReservationsSecured,
                formatNumber(summary.businessOutcomeSummary.acceptedReservations, locale),
              ],
              [t("Queued"), formatNumber(summary.businessOutcomeSummary.queuedOrders, locale)],
              [
                t("Processing"),
                formatNumber(summary.businessOutcomeSummary.processingOrders, locale),
              ],
              [t("Retrying"), formatNumber(summary.businessOutcomeSummary.retryingOrders, locale)],
              [
                t("Pending persistence"),
                formatNumber(summary.businessOutcomeSummary.pendingPersistenceCount, locale),
              ],
              [
                t("Confirmed"),
                formatNumber(summary.businessOutcomeSummary.confirmedOrders, locale),
              ],
              [t("Failed"), formatNumber(summary.businessOutcomeSummary.failedOrders, locale)],
              [
                publicVocabulary.notifications,
                formatNumber(summary.businessOutcomeSummary.notificationsRecorded, locale),
              ],
            ]}
            title={durableCheckoutLens.title}
          />
          <FactList
            facts={
              summary.terminalInventorySnapshot
                ? [
                    [
                      publicVocabulary.startingStock,
                      formatNumber(summary.terminalInventorySnapshot.startingStock, locale),
                    ],
                    [
                      t("Remaining stock"),
                      formatNumber(summary.terminalInventorySnapshot.remainingStock, locale),
                    ],
                    [
                      t("Reserved stock"),
                      formatNumber(summary.terminalInventorySnapshot.reservedStock, locale),
                    ],
                    [
                      publicVocabulary.soldOutRejectionsRecorded,
                      formatNumber(summary.terminalInventorySnapshot.soldOutRejections, locale),
                    ],
                    [
                      t("Held awaiting persistence"),
                      formatNumber(
                        summary.terminalInventorySnapshot.pendingPersistenceCount,
                        locale,
                      ),
                    ],
                  ]
                : [[t("Terminal inventory"), t("not recorded")]]
            }
            title={t("Terminal inventory")}
          />
        </div>
        <TransportObservationSection
          arrivalSummary={summary.trafficDeliverySummary.requestArrivalSummary}
          className="mt-5 gap-x-6 min-[900px]:columns-2 min-[1100px]:columns-3 [&>*]:break-inside-avoid"
          counts={summary.transportAttemptCounts}
          httpTimingBreakdownSummary={detail.httpTimingBreakdownSummary}
          httpSummary={summary.httpSummary}
          serverReservationTimingSummary={summary.serverReservationTimingSummary}
          startDelaySeconds={run.configSnapshot.trafficConfig.startDelaySeconds}
          surface="detail"
          {...(run.trafficStartedAt ? { trafficStartedAt: run.trafficStartedAt } : {})}
        />
        <EnvironmentNote runnerRegion={run.runnerRegion} trafficStartedAt={run.trafficStartedAt} />
      </section>

      <section className="rounded-2xl border border-border bg-surface p-5 max-[560px]:p-4">
        <h2 className="type-title m-0 text-base leading-tight text-ink">
          {t("Run configuration")}
        </h2>
        <div className="mt-3 grid grid-cols-4 gap-x-6 gap-y-4 max-[1100px]:grid-cols-2 max-[700px]:grid-cols-1">
          <FactList
            facts={[
              [
                t("Planned demand"),
                formatNumber(
                  deriveLoadExecutionPlan(config.trafficConfig).plannedEmittedAttempts,
                  locale,
                ),
              ],
              ...trafficConfigFacts(config.trafficConfig, locale),
            ]}
            title={t("Traffic")}
          />
          <FactList
            facts={[
              [t("Starting stock"), formatNumber(config.inventoryConfig.startingStock, locale)],
            ]}
            title={t("Inventory")}
          />
          <FactList
            facts={[
              [
                t("Simulated ERP delay per order"),
                formatDurationMs(config.erpConfig.latencyMs, locale) ?? t("n/a"),
              ],
              [
                t("Simulated ERP capacity (orders/s)"),
                formatNumber(config.erpConfig.maxTps, locale),
              ],
              [
                t("Simulated ERP failure rate (%)"),
                formatPercent(config.erpConfig.errorRate, locale),
              ],
              [t("Simulated ERP outage"), config.erpConfig.forcedOutage ? t("yes") : t("no")],
            ]}
            title={t("Simulated ERP")}
          />
          <FactList
            facts={[
              [
                t("Concurrency"),
                formatNumber(config.backpressureConfig.orderProcessConcurrency, locale),
              ],
              [t("Logical queue"), codeValue(config.backpressureConfig.queueName)],
              [t("Physical queue"), codeValue(config.backpressureConfig.physicalQueueName)],
            ]}
            title={t("Order processing")}
          />
        </div>
      </section>

      <RunConclusion
        result={result}
        runStatus={summary.status}
        showCanonicalCodes
        showReconciliationStatus
      />

      {failure && !detail.failureDiagnostic ? (
        <section className="rounded-2xl border border-warning-line bg-warning-soft p-5">
          <h2 className="type-title m-0 text-base text-ink">{t("What happened")}</h2>
          <p className="m-0 mt-2 text-sm text-muted-strong">{t(failure.explanation)}</p>
          <p className="m-0 mt-1 text-sm font-semibold text-muted-strong">{failure.action}</p>
        </section>
      ) : null}

      <ExceptionSummary outcome={result.outcome} summary={detail.exceptionSummary} />

      <GoldSignals
        acceptedReservations={summary.businessOutcomeSummary.acceptedReservations}
        arrivalSummary={summary.trafficDeliverySummary.requestArrivalSummary}
        csvFileName={`run-${run.runId}-signals.csv`}
        failedOrders={summary.businessOutcomeSummary.failedOrders}
        oversoldUnits={oversoldUnitsFromTerminalInventory(summary)}
        runStatus={run.status}
        terminalSummary={detail.runSignalTimelineSummary}
      />

      <RunDiagnostics
        summary={detail.loadRunDiagnosticsSummary}
        apiDroppedLiveMetricBatchCount={detail.apiDroppedLiveMetricBatchCount}
        warningCount={detail.exceptionSummary.generatorWarnings}
      />
    </div>
  );
}

function FactList({
  caption,
  facts,
  title,
}: {
  caption?: string;
  facts: Array<[string, ReactNode]>;
  title: string;
}) {
  const t = useTranslation();
  return (
    <ConfigGroup caption={caption} title={t(title)}>
      {facts.map(([label, value]) => (
        <FieldRow key={label} label={t(label)} value={value} />
      ))}
    </ConfigGroup>
  );
}

function ExceptionSummary({
  outcome,
  summary,
}: {
  outcome: ReturnType<typeof deriveRunResult>["outcome"];
  summary: AdminRunHistoryDetailResponse["exceptionSummary"];
}) {
  const t = useTranslation();
  const locale = useLocale();
  const exceptionEntries = [
    [t(pluralize(summary.brokenInvariants, "broken invariant")), summary.brokenInvariants],
    [t(pluralize(summary.failedOrders, "failed order")), summary.failedOrders],
    [t("pending work"), summary.pendingWork],
    [t(pluralize(summary.partialDelivery, "delivery exception")), summary.partialDelivery],
  ] as const;
  const exceptions = exceptionEntries.filter(([, count]) => count > 0);
  const limitationEntries = [
    [t("Instrumentation limitations"), summary.generatorWarnings],
  ] as const;
  const limitations = limitationEntries.filter(([, count]) => count > 0);
  const classification =
    summary.maximumClassification === "expected_population_difference"
      ? null
      : summary.maximumClassification;
  const classificationLabel =
    outcome === "failed"
      ? t("Run failed")
      : classification === "correctness_failure"
        ? t("Correctness failure")
        : classification === "warning"
          ? t("Reconciliation warning")
          : classification === "evidence_incomplete"
            ? t("Evidence incomplete")
            : null;
  const needsAttention = classificationLabel !== null || exceptions.length > 0;
  const isFailure = outcome === "failed" || classification === "correctness_failure";
  return (
    <section
      className={`rounded-2xl border px-5 py-4 ${
        isFailure
          ? "border-danger bg-danger-soft"
          : needsAttention
            ? "border-warning bg-warning-soft"
            : "border-border bg-surface"
      } flex flex-wrap items-baseline gap-x-4 gap-y-1`}
      aria-label={t("Exception summary")}
    >
      <h2 className="type-title m-0 text-base text-ink">{t("Exception summary")}</h2>
      <p
        className={`m-0 text-sm font-semibold ${
          isFailure ? "text-danger" : needsAttention ? "text-warning" : "text-accent"
        }`}
      >
        {!needsAttention
          ? t("Clean run · no exceptions require attention.")
          : [
              classificationLabel,
              ...exceptions.map(([label, count]) => `${formatNumber(count, locale)} ${t(label)}`),
            ]
              .filter(Boolean)
              .join(" · ")}
      </p>
      {limitations.length > 0 ? (
        <p className="m-0 text-sm text-muted-strong">
          {t("Limitations ·")}{" "}
          {limitations
            .map(([label, count]) => `${t(label)}: ${formatNumber(count, locale)}`)
            .join(" · ")}
        </p>
      ) : null}
    </section>
  );
}

function trafficConfigFacts(
  config: AdminRunHistoryDetailResponse["run"]["configSnapshot"]["trafficConfig"],
  locale: Locale = "en",
): Array<[string, ReactNode]> {
  const t = getTranslation(locale);
  if (config.mode === "buyer-spike") {
    return [
      [t("Scenario"), trafficModeLabel(config.mode)],
      [t("Buyer count"), formatNumber(config.buyerCount, locale)],
      [t("Duplicate attempts"), config.duplicateEachBuyerAttempt ? t("yes") : t("no")],
      [t("Configured start delay"), formatDurationSeconds(config.startDelaySeconds, locale)],
      [
        t("Configured maximum dispatch time"),
        formatDurationSeconds(config.maxDurationSeconds, locale),
      ],
      [t("Quantity"), formatNumber(config.quantityPerAttempt, locale)],
    ];
  }

  return [
    [t("Scenario"), trafficModeLabel(config.mode)],
    [t("Configured arrival rate (per second)"), formatNumber(config.ratePerSecond, locale)],
    [t("Configured start delay"), formatDurationSeconds(config.startDelaySeconds, locale)],
    [t("Configured traffic duration"), formatDurationSeconds(config.durationSeconds, locale)],
    ...(config.k6Vus
      ? [
          [t("Pre-allocated k6 VUs"), formatNumber(config.k6Vus.preAllocatedVus, locale)] as [
            string,
            ReactNode,
          ],
          [t("Maximum k6 VUs"), formatNumber(config.k6Vus.maxVus, locale)] as [string, ReactNode],
        ]
      : []),
    [t("Quantity"), formatNumber(config.quantityPerAttempt, locale)],
  ];
}

export function PublicRunHistoryDetail({ detail }: { detail: PublicRunHistoryDetailResponse }) {
  const t = useTranslation();
  const locale = useLocale();
  const { run, summary } = detail;
  if (summary.dataDiscarded) {
    return (
      <DiscardedRunDetail
        navigation={
          <Link className={neutralLinkButtonClassName} href="/run-history">
            {t("Back to run history")}
          </Link>
        }
        presetName={t(summary.presetName)}
        trafficEvidenceUnavailable={hasUnknownTrafficCounts(summary.transportAttemptCounts)}
        automatic={summary.failureCategory === "automatic_reset"}
      />
    );
  }
  const result = detail.result;
  const config = run.configSnapshot;
  const transportObservation = deriveTransportObservation(
    summary.transportAttemptCounts,
    summary.httpSummary.transportFailures,
  );
  const publicSummary = derivePublicRunSummary(
    {
      result,
      trafficDeliveryStatus: summary.trafficDeliverySummary.trafficDeliveryStatus,
      transportObservation,
    },
    locale,
  );
  const finalCounts: Array<[string, number | null]> = [
    [t("Units left"), publicSummary.counts.remainingStock],
    [t("Units reserved"), publicSummary.counts.reservedUnits],
    [t("Orders confirmed"), publicSummary.counts.confirmedOrders],
    [t("Awaiting confirmation"), publicSummary.counts.pendingOrders],
    [t("Orders failed"), publicSummary.counts.failedOrders],
    [t("Attempts turned away because stock ran out"), publicSummary.counts.soldOutDecisions],
  ];
  const deliveryFigures: Array<[string, string, string | undefined]> = [
    [
      t("Reply coverage"),
      transportObservation.coveragePercent === null
        ? t("n/a")
        : `${transportObservation.coveragePercent}%`,
      t("of dispatched attempts"),
    ],
    [
      t("Observed reservation p95"),
      formatHistogramBoundMilliseconds(
        summary.serverReservationTimingSummary.redisAtomicReservation.p95Ms,
        locale,
      ),
      t("bounded p95 estimate"),
    ],
    [
      t("Checkout response p95 (client-observed)"),
      formatMilliseconds(summary.httpSummary.p95LatencyMs, locale),
      transportObservation.hasUnrecordedReplies ? t("observed replies only") : undefined,
    ],
    [
      t("Reservation-to-confirmation p95"),
      nullableMetricMs(
        detail.runSignalTimelineSummary?.confirmationConvergence.p95LagMs ?? null,
        locale,
      ),
      undefined,
    ],
  ];
  return (
    <div className="grid grid-cols-1 gap-4">
      <PublicRunConclusion
        measurementsTargetId="report-advanced-measurements"
        failureExplanation={runFailureExplanationEvidence(detail)}
        result={result}
        runStatus={summary.status}
        showProof={false}
        trafficDeliveryStatus={summary.trafficDeliverySummary.trafficDeliveryStatus}
        transportObservation={transportObservation}
      />

      <section
        aria-labelledby="report-final-counts"
        className="rounded-2xl border border-border bg-surface p-5 max-[560px]:p-4"
      >
        <h2 id="report-final-counts" className="type-title m-0 text-base leading-tight text-ink">
          {t("Final stock and orders")}
        </h2>
        <div className="mt-3 grid grid-cols-6 gap-3 max-[900px]:grid-cols-3 max-[600px]:grid-cols-2">
          {finalCounts.map(([label, value]) => (
            <div className="rounded-xl border border-border bg-surface-muted p-3" key={label}>
              <p className="type-title m-0 text-xl text-ink">{formatCount(value, locale) ?? "—"}</p>
              <p className="m-0 mt-1 text-xs text-muted">{t(label)}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-surface p-5 max-[560px]:p-4">
        <h2 className="type-title m-0 text-base leading-tight text-ink">{t("What happened")}</h2>
        <ul className="mb-0 mt-3 grid gap-2 pl-5 text-sm leading-6 text-muted-strong">
          {runRecap(detail, publicSummary.counts, locale).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <section className="grid gap-3" id="report-advanced-signals">
        <h2 className="type-title m-0 text-base leading-tight text-ink">{t("Signals")}</h2>
        <PublicSignalChart
          acceptedReservations={summary.businessOutcomeSummary.acceptedReservations}
          arrivalSummary={summary.trafficDeliverySummary.requestArrivalSummary}
          failedOrders={summary.businessOutcomeSummary.failedOrders}
          oversoldUnits={oversoldUnitsFromTerminalInventory(summary)}
          runStatus={run.status}
          terminalSummary={detail.runSignalTimelineSummary}
        />
      </section>

      <PublicRunConclusionProof
        alwaysVisible
        result={result}
        targetId="report-advanced-consistency"
      />

      <section
        className="rounded-2xl border border-border bg-surface p-5 max-[560px]:p-4"
        id="report-advanced-scenario"
      >
        <h2 className="type-title m-0 text-base leading-tight text-ink">
          {t("Scenario settings")}
        </h2>
        <div className="mt-3 grid grid-cols-4 gap-4 max-[1100px]:grid-cols-2 max-[700px]:grid-cols-1">
          <FactList
            facts={[
              [t("Planned demand"), formatNumber(detail.plannedAttempts, locale)],
              ...trafficConfigFacts(config.trafficConfig, locale),
            ]}
            title={t("Traffic")}
          />
          <FactList
            facts={[
              [
                publicVocabulary.startingStock,
                formatNumber(config.inventoryConfig.startingStock, locale),
              ],
            ]}
            title={t("Inventory")}
          />
          <FactList
            facts={[
              [
                t("Delay per order"),
                formatDurationMs(config.erpConfig.latencyMs, locale) ?? t("not recorded"),
              ],
              [t("Capacity (orders/s)"), formatNumber(config.erpConfig.maxTps, locale)],
              [t("Failure rate"), formatPercent(config.erpConfig.errorRate, locale)],
              [t("Forced outage"), config.erpConfig.forcedOutage ? t("yes") : t("no")],
            ]}
            title={t("Simulated ERP")}
          />
          <FactList
            facts={[
              [
                t("Order-processing concurrency"),
                formatNumber(config.backpressureConfig.orderProcessConcurrency, locale),
              ],
            ]}
            title={t("Backpressure")}
          />
        </div>
      </section>

      <section
        className="rounded-2xl border border-border bg-surface p-5 max-[560px]:p-4"
        id="report-advanced-measurements"
        tabIndex={-1}
      >
        <h2 className="type-title m-0 text-base leading-tight text-ink">
          {t("Delivery and measurements")}
        </h2>
        {hasUnknownTrafficCounts(summary.transportAttemptCounts) ? null : (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-muted-strong">{t("Delivery quality")}</span>
            <StatusPill
              status={{
                label: publicStatusLabel(
                  {
                    family: "traffic-delivery",
                    status: summary.trafficDeliverySummary.trafficDeliveryStatus,
                  },
                  locale,
                ),
                tone: trafficDeliveryStatusTone(
                  summary.trafficDeliverySummary.trafficDeliveryStatus,
                ),
              }}
            />
          </div>
        )}
        <div
          className="mt-3 grid grid-cols-4 gap-3 max-[900px]:grid-cols-2 max-[560px]:grid-cols-1"
          data-delivery-summary=""
        >
          {deliveryFigures.map(([label, value, note]) => (
            <div className="rounded-xl border border-border bg-surface-muted p-3" key={label}>
              <p className="type-title m-0 text-xl text-ink">{value}</p>
              <p className="m-0 mt-1 text-xs text-muted">{t(label)}</p>
              {note ? <p className="m-0 mt-1 text-xs text-muted">{note}</p> : null}
            </div>
          ))}
        </div>
        {transportObservation.hasUnrecordedReplies ? (
          <p
            className="m-0 mt-3 rounded-lg border border-warning-line bg-warning-soft p-3 text-xs leading-5 text-warning"
            data-measurement-caveat=""
          >
            {t("Checkout response p95 (client-observed) covers only the")}{" "}
            {formatCount(transportObservation.repliesRecorded, locale) ?? t("unavailable")}{" "}
            {t("of")}{" "}
            {formatCount(transportObservation.counts.plannedRequests, locale) ?? t("unavailable")}{" "}
            {t("planned")} {t(pluralize(transportObservation.counts.plannedRequests, "attempt"))}{" "}
            {t(
              "that recorded a reply. Server-observed reservation timing and durable reservation-to-confirmation timing use separate evidence.",
            )}
          </p>
        ) : null}
        <EnvironmentNote runnerRegion={run.runnerRegion} trafficStartedAt={run.trafficStartedAt} />
        <details className="mt-4 rounded border border-border px-3 py-2">
          <summary className="disclosure font-semibold text-ink">{t("All measurements")}</summary>
          <div className="mt-3 grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
            <TransportObservationSection
              arrivalSummary={summary.trafficDeliverySummary.requestArrivalSummary}
              counts={summary.transportAttemptCounts}
              httpTimingBreakdownSummary={detail.httpTimingBreakdownSummary}
              httpSummary={summary.httpSummary}
              serverReservationTimingSummary={summary.serverReservationTimingSummary}
              startDelaySeconds={config.trafficConfig.startDelaySeconds}
              surface="detail"
              hideZeroExceptions
              {...(run.trafficStartedAt ? { trafficStartedAt: run.trafficStartedAt } : {})}
            />
            <FactList
              caption={simulatedErpLens.caption}
              facts={[
                [
                  t("Simulated ERP call attempts"),
                  formatNumber(detail.erpAttempts.totalCount, locale),
                ],
                [
                  t("Succeeded attempts"),
                  formatNumber(detail.erpAttempts.byStatus.succeeded, locale),
                ],
                ...(detail.erpAttempts.byStatus.failed > 0
                  ? [
                      [
                        t("Failed attempts"),
                        formatNumber(detail.erpAttempts.byStatus.failed, locale),
                      ] as [string, ReactNode],
                    ]
                  : []),
                ...(detail.erpAttempts.byStatus.timedOut > 0
                  ? [
                      [
                        t("Timed-out attempts"),
                        formatNumber(detail.erpAttempts.byStatus.timedOut, locale),
                      ] as [string, ReactNode],
                    ]
                  : []),
                [
                  t("Simulated ERP call average"),
                  nullableMetricMs(detail.erpAttempts.averageLatencyMs, locale),
                ],
                [
                  t("Simulated ERP call p95"),
                  nullableMetricMs(detail.erpAttempts.p95LatencyMs, locale),
                ],
                [
                  t("Reservation-to-confirmation p95"),
                  nullableMetricMs(
                    detail.runSignalTimelineSummary?.confirmationConvergence.p95LagMs ?? null,
                    locale,
                  ),
                ],
              ]}
              title={simulatedErpLens.title}
            />
          </div>
        </details>
      </section>

      <section id="report-advanced-lifecycle">
        <details className="rounded-2xl border border-border bg-surface px-5 py-3.5">
          <summary className="disclosure">
            <h2 className="type-title m-0 inline text-base leading-tight text-ink">
              {t("Lifecycle and reference")}
            </h2>
          </summary>
          <div className="mt-3 grid grid-cols-2 gap-4 max-[800px]:grid-cols-1">
            <FactList
              facts={[
                [t("Run accepted"), formatDate(summary.startedAt, locale)],
                [t("Checkout traffic started"), formatDate(run.trafficStartedAt, locale)],
                [t("Sending ended"), formatSendingEnd(summary, locale)],
                [t("Run ended"), formatDate(run.finalizedAt, locale)],
              ]}
              title={t("Lifecycle")}
            />
            <FactList
              facts={[
                ...(summary.terminalInventorySnapshot
                  ? [
                      [
                        publicVocabulary.startingStock,
                        formatNumber(summary.terminalInventorySnapshot.startingStock, locale),
                      ] as [string, ReactNode],
                      [
                        t("Remaining stock"),
                        formatNumber(summary.terminalInventorySnapshot.remainingStock, locale),
                      ] as [string, ReactNode],
                      [
                        t("Reserved stock"),
                        formatNumber(summary.terminalInventorySnapshot.reservedStock, locale),
                      ] as [string, ReactNode],
                    ]
                  : [
                      [publicVocabulary.startingStock, t("not recorded")] as [string, ReactNode],
                      [t("Remaining stock"), t("not recorded")] as [string, ReactNode],
                      [t("Reserved stock"), t("not recorded")] as [string, ReactNode],
                    ]),
                [
                  publicVocabulary.uniqueReservationsSecured,
                  formatNumber(summary.businessOutcomeSummary.acceptedReservations, locale),
                ],
                [
                  publicVocabulary.soldOutRejectionsRecorded,
                  formatNumber(summary.businessOutcomeSummary.soldOutRejections, locale),
                ],
                [
                  t("Confirmed orders"),
                  formatNumber(summary.businessOutcomeSummary.confirmedOrders, locale),
                ],
                [
                  t("Failed orders"),
                  formatNumber(summary.businessOutcomeSummary.failedOrders, locale),
                ],
              ]}
              title={t("Final evidence")}
            />
          </div>
          <dl className="m-0 mt-4 grid gap-2 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-muted">{t("Run UUID")}</dt>
              <dd className="m-0 [overflow-wrap:anywhere] text-sm font-semibold text-muted-strong">
                <code>{summary.runId}</code>
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted">{t("Aggregate evidence recorded")}</dt>
              <dd className="m-0 text-sm font-semibold text-muted-strong">
                {formatDate(summary.capturedAt, locale)}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted">{t("Logical queue")}</dt>
              <dd className="m-0 [overflow-wrap:anywhere] text-sm font-semibold text-muted-strong">
                <code>{config.backpressureConfig.queueName}</code>
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted">{t("Physical queue")}</dt>
              <dd className="m-0 [overflow-wrap:anywhere] text-sm font-semibold text-muted-strong">
                <code>{config.backpressureConfig.physicalQueueName}</code>
              </dd>
            </div>
          </dl>
        </details>
      </section>

      <nav aria-label={t("Report actions")} className="flex flex-wrap gap-3">
        <Link className={neutralLinkButtonClassName} href="/run-history">
          {t("Back to run history")}
        </Link>
        <Link className={neutralLinkButtonClassName} href="/demo">
          {t("Choose another scenario")}
        </Link>
        <a className={neutralLinkButtonClassName} href="#main-content">
          {t("Back to top")}
        </a>
      </nav>
    </div>
  );
}

function DiscardedRunDetail({
  automatic,
  actions,
  navigation,
  presetName,
  trafficEvidenceUnavailable,
}: {
  trafficEvidenceUnavailable: boolean;
  actions?: ReactNode;
  navigation?: ReactNode;
  presetName: string;
  automatic: boolean;
}) {
  const t = useTranslation();
  return (
    <section className="rounded-2xl border border-border bg-surface p-5 max-[560px]:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {navigation}
        {actions}
      </div>
      <p className="m-0 mt-3 text-xs font-medium text-muted">{t("Cancelled")}</p>
      <h1 className="type-display m-0 mt-1 text-[1.875rem] leading-tight text-ink">
        {t(presetName)}
      </h1>
      <p className="m-0 mt-3 text-sm leading-6 text-muted-strong">
        {t("This run was cancelled by")} {automatic ? t("an automatic") : t("an admin")}{" "}
        {t("reset. Its experiment data was discarded.")}
      </p>
      {trafficEvidenceUnavailable ? (
        <p className="m-0 mt-3 text-sm leading-6 text-muted-strong">
          {t(trafficEvidenceUnavailableText)}
        </p>
      ) : null}
    </section>
  );
}

export function scenarioRecap(
  detail: PublicRunHistoryDetailResponse,
  locale: Locale = "en",
): string {
  const t = getTranslation(locale);
  const { configSnapshot } = detail.run;
  const traffic = configSnapshot.trafficConfig;
  const demand =
    traffic.mode === "buyer-spike"
      ? `${formatNumber(traffic.buyerCount, locale)} ${t(pluralize(traffic.buyerCount, "buyer"))}`
      : t("{value1} planned {value2}", {
          value1: formatNumber(detail.plannedAttempts, locale),
          value2: t(pluralize(detail.plannedAttempts, "attempt")),
        });
  const startingStock = configSnapshot.inventoryConfig.startingStock;
  const details = [
    t("{value1} · {value2} · {value3} starting {value4}", {
      value1: t(trafficModeLabel(traffic.mode)),
      value2: demand,
      value3: formatNumber(startingStock, locale),
      value4: t(pluralize(startingStock, "unit")),
    }),
  ];
  if (traffic.mode === "buyer-spike" && traffic.duplicateEachBuyerAttempt) {
    details.push(t("duplicate attempts enabled"));
  }
  if (configSnapshot.erpConfig.forcedOutage) details.push(t("simulated ERP outage forced"));
  if (configSnapshot.erpConfig.errorRate > 0) {
    details.push(
      t("{value1} simulated ERP failure rate", {
        value1: formatPercent(configSnapshot.erpConfig.errorRate, locale),
      }),
    );
  }
  return details.join(" · ");
}

function runRecap(
  detail: PublicRunHistoryDetailResponse,
  counts: ReturnType<typeof derivePublicRunSummary>["counts"],
  locale: Locale = "en",
): string[] {
  const t = getTranslation(locale);
  const { run } = detail;
  const trafficSubject =
    run.configSnapshot.trafficConfig.mode === "buyer-spike"
      ? t("Buyer traffic")
      : t("Checkout attempts");
  const time = (value: string | undefined) =>
    formatInstantUtc(value, { variant: "timeOnly", locale }) ?? t("not recorded");
  const value = (count: number | null) => formatCount(count, locale) ?? t("not recorded");
  const count = (count: number | null, noun: string) =>
    `${value(count)} ${t(pluralize(count, noun))}`;
  const sendingEndedAt = deriveSendingEndedAt(
    detail.summary.trafficDeliverySummary.requestArrivalSummary,
  );
  const sentNothing = sentNoAttempt(detail.summary);
  const trafficRecap = run.trafficStartedAt
    ? sendingEndedAt
      ? t("{value1} started at {value2}; sending ended at {value3}.", {
          value1: trafficSubject,
          value2: time(run.trafficStartedAt),
          value3: time(sendingEndedAt),
        })
      : sentNothing
        ? t("{value1} started at {value2}; no checkout attempt was recorded.", {
            value1: trafficSubject,
            value2: time(run.trafficStartedAt),
          })
        : t("{value1} started at {value2}; the end of sending was not recorded.", {
            value1: trafficSubject,
            value2: time(run.trafficStartedAt),
          })
    : sendingEndedAt
      ? t("{value1} start was not recorded; sending ended at {value2}.", {
          value1: trafficSubject,
          value2: time(sendingEndedAt),
        })
      : sentNothing
        ? t("No checkout attempt was recorded for this run.")
        : t("{value1} start and the end of sending were not recorded.", { value1: trafficSubject });
  const lines = [
    trafficRecap,
    t("{value1} reserved / {value2}; {value3} turned away because stock ran out.", {
      value1: count(counts.reservedUnits, "unit"),
      value2: count(counts.uniqueReservations, "unique reservation"),
      value3: count(counts.soldOutDecisions, "attempt"),
    }),
    t(
      "Orders reached their recorded outcome: {value1} confirmed, {value2} failed, {value3} awaiting confirmation.",
      {
        value1: value(counts.confirmedOrders),
        value2: value(counts.failedOrders),
        value3: value(counts.pendingOrders),
      },
    ),
    t("Run ended: {value1}.", { value1: time(run.finalizedAt) }),
  ];
  return lines;
}

function nullableMetricMs(value: number | null, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  return formatDurationMs(value, locale) ?? t("n/a");
}

function formatNumber(value: number, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  return formatCount(value, locale) ?? t("n/a");
}

/**
 * A percentage keeps its own decimal rule rather than inheriting a count formatter's default: a
 * 0-100 reading never needs grouping, and its precision must not move if the shared count policy
 * changes.
 */
function formatPercent(value: number, locale: Locale = "en"): string {
  const formatter = new Intl.NumberFormat(locale === "fr" ? "fr-FR" : "en-US", {
    maximumFractionDigits: 2,
  });
  return `${formatter.format(value * 100)}${locale === "fr" ? " %" : "%"}`;
}

/**
 * Renders the labelled UTC reading a person compares across routes while keeping the exact ISO
 * value in `<time dateTime>` for assistive technology and technical inspection. Both parts derive
 * from the same server-supplied string under a fixed zone, so hydration cannot disagree.
 */
function formatDate(value: string | undefined, locale: Locale = "en"): ReactNode {
  const t = getTranslation(locale);
  const text = formatInstantUtc(value, { locale });
  if (value === undefined || text === null) {
    return t("n/a");
  }

  return <time dateTime={value}>{text}</time>;
}

function formatSendingEnd(
  summary: Pick<
    PublicRunHistoryDetailResponse["summary"],
    "trafficDeliverySummary" | "transportAttemptCounts"
  >,
  locale: Locale = "en",
): ReactNode {
  const t = getTranslation(locale);
  const endedAt = deriveSendingEndedAt(summary.trafficDeliverySummary.requestArrivalSummary);
  return endedAt
    ? formatDate(endedAt, locale)
    : sentNoAttempt(summary)
      ? t("no attempt recorded")
      : t("not recorded");
}

/**
 * Only a known zero says that nothing was sent. Unknown counters (a lost report) leave an empty
 * arrival summary too, and must not read as an absence of traffic.
 */
function sentNoAttempt(
  summary: Pick<PublicRunHistoryDetailResponse["summary"], "transportAttemptCounts">,
): boolean {
  return summary.transportAttemptCounts.startedRequests === 0;
}

/** Configured guards are stored in seconds but are presented under the one duration policy. */
function formatDurationSeconds(value: number, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  return formatDurationMs(value * 1000, locale) ?? t("n/a");
}

function adminDeliveryLabel(
  status: AdminRunHistoryDetailResponse["summary"]["trafficDeliverySummary"]["trafficDeliveryStatus"],
  locale: Locale = "en",
): string {
  const t = getTranslation(locale);
  switch (status) {
    case "complete":
      return t("Delivery complete");
    case "warning":
      return t("Delivery warning");
    case "degraded":
      return t("Delivery degraded");
    case "failed":
      return t("Delivery failed");
  }
}

function codeValue(value: string): ReactNode {
  return <code>{value}</code>;
}
