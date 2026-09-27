import type {
  AdminRunHistoryDetailResponse,
  PublicRunHistoryDetailResponse,
} from "@checkout-surge/contracts";
import { deriveLoadExecutionPlan, deriveRunResult } from "@checkout-surge/contracts";
import Link from "next/link";
import type { ReactNode } from "react";
import { formatCount, formatDurationMs, formatInstantUtc } from "../lib/presentation/format";
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
import { ConfigGroup, FieldRow } from "./config-presentation";
import { neutralLinkButtonClassName } from "./control-styles";
import { GoldSignals, PublicSignalChart } from "./gold-signals";
import { PublicRunConclusion, PublicRunConclusionProof, RunConclusion } from "./run-conclusion";
import { RunDiagnostics } from "./run-diagnostics";
import { StatusPill } from "./status-pill";
import {
  deriveTransportObservation,
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
  const { run, summary } = detail;
  if (summary.dataDiscarded) {
    return (
      <DiscardedRunDetail
        actions={actions}
        navigation={navigation}
        presetName={summary.presetName}
        automatic={summary.failureCategory === "automatic_reset"}
      />
    );
  }
  const config = run.configSnapshot;
  const result = deriveRunResult(evidenceFromRunHistoryDetail(detail));
  const runPresentation = deriveTerminalSummaryPresentation(result);
  const overallDuration =
    formatDurationMs(detail.overallDurationMs) ??
    (summary.startedAt ? "— unusable lifecycle boundary" : "— no recorded start");
  const failure = summary.failureCategory
    ? publicFailureExplanation(summary.failureCategory)
    : null;

  return (
    <div className="grid grid-cols-1 gap-4">
      {navigation}
      <header className="rounded-2xl border border-border bg-surface px-5 py-3.5 max-[560px]:px-4 min-[900px]:sticky min-[900px]:top-14 min-[900px]:z-[5] min-[900px]:shadow-[0_8px_24px_-18px_rgb(13_27_42/0.5)]">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
            <p className="sr-only">Run detail</p>
            <h1 className="type-display m-0 text-2xl leading-tight text-ink">
              {summary.presetName}
            </h1>
            <p className="m-0 [overflow-wrap:anywhere] font-mono text-xs text-muted">
              {summary.runId}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 max-[700px]:justify-start">
            <StatusPill
              status={{
                ...runPresentation,
                label: publicStatusLabel({
                  family: "run",
                  status: summary.status,
                  displayLabel: runPresentation.label,
                }),
              }}
            />
            <StatusPill status={{ label: `operator ${run.operatorMode}`, tone: "idle" }} />
            <StatusPill
              status={{
                label: adminDeliveryLabel(summary.trafficDeliverySummary.trafficDeliveryStatus),
                tone: trafficDeliveryStatusTone(
                  summary.trafficDeliverySummary.trafficDeliveryStatus,
                ),
              }}
            />
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
        aria-label="Run overview"
        className="rounded-2xl border border-border bg-surface p-5 max-[560px]:p-4"
      >
        <h2 className="type-title m-0 text-base leading-tight text-ink">Run overview</h2>
        <div className="mt-3 grid grid-cols-4 gap-x-6 gap-y-4 max-[1100px]:grid-cols-2 max-[700px]:grid-cols-1">
          <FactList
            facts={[
              ["Started", formatDate(summary.startedAt)],
              ["Overall run duration", overallDuration],
              ["Traffic started", formatDate(run.trafficStartedAt)],
              ["Traffic ended", formatDate(run.trafficEndedAt)],
              ["Finalized", formatDate(run.finalizedAt)],
              ["Evidence recorded", formatDate(summary.capturedAt)],
              ...(detail.internalFailureReason
                ? [["Failure code", codeValue(detail.internalFailureReason)] as [string, ReactNode]]
                : []),
            ]}
            title="Lifecycle"
          />
          <FactList
            caption={simulatedErpLens.caption}
            facts={[
              ["Simulated ERP call attempts", formatNumber(detail.erpAttemptSummary.totalCount)],
              ["Succeeded attempts", formatNumber(detail.erpAttemptSummary.byStatus.succeeded)],
              ...(detail.erpAttemptSummary.byStatus.failed > 0
                ? [
                    ["Failed attempts", formatNumber(detail.erpAttemptSummary.byStatus.failed)] as [
                      string,
                      ReactNode,
                    ],
                  ]
                : []),
              ...(detail.erpAttemptSummary.byStatus.timedOut > 0
                ? [
                    [
                      "Timed-out attempts",
                      formatNumber(detail.erpAttemptSummary.byStatus.timedOut),
                    ] as [string, ReactNode],
                  ]
                : []),
              [
                "Simulated ERP call average",
                nullableMetricMs(detail.erpAttemptSummary.averageLatencyMs),
              ],
              ["Simulated ERP call p95", nullableMetricMs(detail.erpAttemptSummary.p95LatencyMs)],
            ]}
            title={simulatedErpLens.title}
          />
          <FactList
            caption={durableCheckoutLens.caption}
            facts={[
              [
                publicVocabulary.uniqueReservationsSecured,
                formatNumber(summary.businessOutcomeSummary.acceptedReservations),
              ],
              ["Queued", formatNumber(summary.businessOutcomeSummary.queuedOrders)],
              ["Processing", formatNumber(summary.businessOutcomeSummary.processingOrders)],
              ["Retrying", formatNumber(summary.businessOutcomeSummary.retryingOrders)],
              [
                "Pending persistence",
                formatNumber(summary.businessOutcomeSummary.pendingPersistenceCount),
              ],
              ["Confirmed", formatNumber(summary.businessOutcomeSummary.confirmedOrders)],
              ["Failed", formatNumber(summary.businessOutcomeSummary.failedOrders)],
              [
                publicVocabulary.notifications,
                formatNumber(summary.businessOutcomeSummary.notificationsRecorded),
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
                      formatNumber(summary.terminalInventorySnapshot.startingStock),
                    ],
                    [
                      "Remaining stock",
                      formatNumber(summary.terminalInventorySnapshot.remainingStock),
                    ],
                    [
                      "Reserved stock",
                      formatNumber(summary.terminalInventorySnapshot.reservedStock),
                    ],
                    [
                      publicVocabulary.soldOutRejectionsRecorded,
                      formatNumber(summary.terminalInventorySnapshot.soldOutRejections),
                    ],
                    [
                      "Held awaiting persistence",
                      formatNumber(summary.terminalInventorySnapshot.pendingPersistenceCount),
                    ],
                  ]
                : [["Terminal inventory", "not recorded"]]
            }
            title="Terminal inventory"
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
      </section>

      <section className="rounded-2xl border border-border bg-surface p-5 max-[560px]:p-4">
        <h2 className="type-title m-0 text-base leading-tight text-ink">Run configuration</h2>
        <div className="mt-3 grid grid-cols-4 gap-x-6 gap-y-4 max-[1100px]:grid-cols-2 max-[700px]:grid-cols-1">
          <FactList
            facts={[
              [
                "Planned demand",
                formatNumber(deriveLoadExecutionPlan(config.trafficConfig).plannedEmittedAttempts),
              ],
              ...trafficConfigFacts(config.trafficConfig),
            ]}
            title="Traffic"
          />
          <FactList
            facts={[["Starting stock", formatNumber(config.inventoryConfig.startingStock)]]}
            title="Inventory"
          />
          <FactList
            facts={[
              [
                "Simulated ERP delay per order",
                formatDurationMs(config.erpConfig.latencyMs) ?? "n/a",
              ],
              ["Simulated ERP capacity (orders/s)", formatNumber(config.erpConfig.maxTps)],
              ["Simulated ERP failure rate (%)", formatPercent(config.erpConfig.errorRate)],
              ["Simulated ERP outage", config.erpConfig.forcedOutage ? "yes" : "no"],
            ]}
            title="Simulated ERP"
          />
          <FactList
            facts={[
              ["Concurrency", formatNumber(config.backpressureConfig.orderProcessConcurrency)],
              ["Logical queue", codeValue(config.backpressureConfig.queueName)],
              ["Physical queue", codeValue(config.backpressureConfig.physicalQueueName)],
            ]}
            title="Order processing"
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
          <h2 className="type-title m-0 text-base text-ink">What happened</h2>
          <p className="m-0 mt-2 text-sm text-muted-strong">{failure.explanation}</p>
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
  return (
    <ConfigGroup caption={caption} title={title}>
      {facts.map(([label, value]) => (
        <FieldRow key={label} label={label} value={value} />
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
  const exceptionEntries = [
    ["broken invariants", summary.brokenInvariants],
    ["failed orders", summary.failedOrders],
    ["pending work", summary.pendingWork],
    ["delivery exceptions", summary.partialDelivery],
  ] as const;
  const exceptions = exceptionEntries.filter(([, count]) => count > 0);
  const limitationEntries = [["Instrumentation limitations", summary.generatorWarnings]] as const;
  const limitations = limitationEntries.filter(([, count]) => count > 0);
  const classification =
    summary.maximumClassification === "expected_population_difference"
      ? null
      : summary.maximumClassification;
  const classificationLabel =
    outcome === "failed"
      ? "Run failed"
      : classification === "correctness_failure"
        ? "Correctness failure"
        : classification === "warning"
          ? "Reconciliation warning"
          : classification === "evidence_incomplete"
            ? "Evidence incomplete"
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
      aria-label="Exception summary"
    >
      <h2 className="type-title m-0 text-base text-ink">Exception summary</h2>
      <p
        className={`m-0 text-sm font-semibold ${
          isFailure ? "text-danger" : needsAttention ? "text-warning" : "text-accent"
        }`}
      >
        {!needsAttention
          ? "Clean run · no exceptions require attention."
          : [
              classificationLabel,
              ...exceptions.map(([label, count]) => `${formatNumber(count)} ${label}`),
            ]
              .filter(Boolean)
              .join(" · ")}
      </p>
      {limitations.length > 0 ? (
        <p className="m-0 text-sm text-muted-strong">
          Limitations ·{" "}
          {limitations.map(([label, count]) => `${label}: ${formatNumber(count)}`).join(" · ")}
        </p>
      ) : null}
    </section>
  );
}

function trafficConfigFacts(
  config: AdminRunHistoryDetailResponse["run"]["configSnapshot"]["trafficConfig"],
): Array<[string, ReactNode]> {
  if (config.mode === "buyer-spike") {
    return [
      ["Scenario", trafficModeLabel(config.mode)],
      ["Buyer count", formatNumber(config.buyerCount)],
      ["Duplicate attempts", config.duplicateEachBuyerAttempt ? "yes" : "no"],
      ["Configured start delay", formatDurationSeconds(config.startDelaySeconds)],
      ["Configured maximum dispatch time", formatDurationSeconds(config.maxDurationSeconds)],
      ["Quantity", formatNumber(config.quantityPerAttempt)],
    ];
  }

  return [
    ["Scenario", trafficModeLabel(config.mode)],
    ["Configured arrival rate (per second)", formatNumber(config.ratePerSecond)],
    ["Configured start delay", formatDurationSeconds(config.startDelaySeconds)],
    ["Configured traffic duration", formatDurationSeconds(config.durationSeconds)],
    ...(config.k6Vus
      ? [
          ["Pre-allocated k6 VUs", formatNumber(config.k6Vus.preAllocatedVus)] as [
            string,
            ReactNode,
          ],
          ["Maximum k6 VUs", formatNumber(config.k6Vus.maxVus)] as [string, ReactNode],
        ]
      : []),
    ["Quantity", formatNumber(config.quantityPerAttempt)],
  ];
}

export function PublicRunHistoryDetail({ detail }: { detail: PublicRunHistoryDetailResponse }) {
  const { run, summary } = detail;
  if (summary.dataDiscarded) {
    return (
      <DiscardedRunDetail
        navigation={
          <Link className={neutralLinkButtonClassName} href="/run-history">
            Back to run history
          </Link>
        }
        presetName={summary.presetName}
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
  const publicSummary = derivePublicRunSummary({
    result,
    trafficDeliveryStatus: summary.trafficDeliverySummary.trafficDeliveryStatus,
    transportObservation,
  });
  const finalCounts: Array<[string, number | null]> = [
    ["Units left", publicSummary.counts.remainingStock],
    ["Units reserved", publicSummary.counts.reservedUnits],
    ["Orders confirmed", publicSummary.counts.confirmedOrders],
    ["Awaiting confirmation", publicSummary.counts.pendingOrders],
    ["Orders failed", publicSummary.counts.failedOrders],
    ["Attempts turned away because stock ran out", publicSummary.counts.soldOutDecisions],
  ];
  const deliveryFigures: Array<[string, string, string | undefined]> = [
    [
      "Delivery coverage",
      transportObservation.coveragePercent === null
        ? "n/a"
        : `${transportObservation.coveragePercent}%`,
      "of dispatched attempts",
    ],
    [
      "Observed reservation p95",
      formatHistogramBoundMilliseconds(
        summary.serverReservationTimingSummary.redisAtomicReservation.p95Ms,
      ),
      "bounded p95 estimate",
    ],
    [
      "Checkout response p95 (client-observed)",
      formatMilliseconds(summary.httpSummary.p95LatencyMs),
      transportObservation.hasUnrecordedReplies ? "observed replies only" : undefined,
    ],
    [
      "Reservation-to-confirmation p95",
      nullableMetricMs(detail.runSignalTimelineSummary?.confirmationConvergence.p95LagMs ?? null),
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
          Final stock and orders
        </h2>
        <div className="mt-3 grid grid-cols-6 gap-3 max-[900px]:grid-cols-3 max-[600px]:grid-cols-2">
          {finalCounts.map(([label, value]) => (
            <div className="rounded-xl border border-border bg-surface-muted p-3" key={label}>
              <p className="type-title m-0 text-xl text-ink">{formatCount(value) ?? "—"}</p>
              <p className="m-0 mt-1 text-xs text-muted">{label}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-surface p-5 max-[560px]:p-4">
        <h2 className="type-title m-0 text-base leading-tight text-ink">What happened</h2>
        <ul className="mb-0 mt-3 grid gap-2 pl-5 text-sm leading-6 text-muted-strong">
          {runRecap(detail, publicSummary.counts).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <section className="grid gap-3" id="report-advanced-signals">
        <h2 className="type-title m-0 text-base leading-tight text-ink">Signals</h2>
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
        <h2 className="type-title m-0 text-base leading-tight text-ink">Scenario settings</h2>
        <div className="mt-3 grid grid-cols-4 gap-4 max-[1100px]:grid-cols-2 max-[700px]:grid-cols-1">
          <FactList
            facts={[
              ["Planned demand", formatNumber(detail.plannedAttempts)],
              ...trafficConfigFacts(config.trafficConfig),
            ]}
            title="Traffic"
          />
          <FactList
            facts={[
              [publicVocabulary.startingStock, formatNumber(config.inventoryConfig.startingStock)],
            ]}
            title="Inventory"
          />
          <FactList
            facts={[
              ["Delay per order", formatDurationMs(config.erpConfig.latencyMs) ?? "not recorded"],
              ["Capacity (orders/s)", formatNumber(config.erpConfig.maxTps)],
              ["Failure rate", formatPercent(config.erpConfig.errorRate)],
              ["Forced outage", config.erpConfig.forcedOutage ? "yes" : "no"],
            ]}
            title="Simulated ERP"
          />
          <FactList
            facts={[
              [
                "Order-processing concurrency",
                formatNumber(config.backpressureConfig.orderProcessConcurrency),
              ],
            ]}
            title="Backpressure"
          />
        </div>
      </section>

      <section
        className="rounded-2xl border border-border bg-surface p-5 max-[560px]:p-4"
        id="report-advanced-measurements"
        tabIndex={-1}
      >
        <h2 className="type-title m-0 text-base leading-tight text-ink">
          Delivery and measurements
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-muted-strong">Delivery quality</span>
          <StatusPill
            status={{
              label: publicStatusLabel({
                family: "traffic-delivery",
                status: summary.trafficDeliverySummary.trafficDeliveryStatus,
              }),
              tone: trafficDeliveryStatusTone(summary.trafficDeliverySummary.trafficDeliveryStatus),
            }}
          />
        </div>
        <div
          className="mt-3 grid grid-cols-4 gap-3 max-[900px]:grid-cols-2 max-[560px]:grid-cols-1"
          data-delivery-summary=""
        >
          {deliveryFigures.map(([label, value, note]) => (
            <div className="rounded-xl border border-border bg-surface-muted p-3" key={label}>
              <p className="type-title m-0 text-xl text-ink">{value}</p>
              <p className="m-0 mt-1 text-xs text-muted">{label}</p>
              {note ? <p className="m-0 mt-1 text-xs text-muted">{note}</p> : null}
            </div>
          ))}
        </div>
        {transportObservation.hasUnrecordedReplies ? (
          <p
            className="m-0 mt-3 rounded-lg border border-warning-line bg-warning-soft p-3 text-xs leading-5 text-warning"
            data-measurement-caveat=""
          >
            Checkout response p95 (client-observed) covers only the{" "}
            {formatCount(transportObservation.repliesRecorded) ?? "unavailable"} of{" "}
            {formatCount(transportObservation.counts.plannedRequests) ?? "unavailable"} planned
            attempts that recorded a reply. Server-observed reservation timing and durable
            reservation-to-confirmation timing use separate evidence.
          </p>
        ) : null}
        <p className="m-0 mt-3 rounded-lg border border-border bg-surface-muted p-3 text-xs leading-5 text-muted">
          Local run note: the load generator, API, database, order-processing service, and simulated
          ERP share one host. This is not hosted benchmark evidence.
        </p>
        <details className="mt-4 rounded border border-border px-3 py-2">
          <summary className="disclosure font-semibold text-ink">All measurements</summary>
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
                ["Simulated ERP call attempts", formatNumber(detail.erpAttempts.totalCount)],
                ["Succeeded attempts", formatNumber(detail.erpAttempts.byStatus.succeeded)],
                ...(detail.erpAttempts.byStatus.failed > 0
                  ? [
                      ["Failed attempts", formatNumber(detail.erpAttempts.byStatus.failed)] as [
                        string,
                        ReactNode,
                      ],
                    ]
                  : []),
                ...(detail.erpAttempts.byStatus.timedOut > 0
                  ? [
                      [
                        "Timed-out attempts",
                        formatNumber(detail.erpAttempts.byStatus.timedOut),
                      ] as [string, ReactNode],
                    ]
                  : []),
                [
                  "Simulated ERP call average",
                  nullableMetricMs(detail.erpAttempts.averageLatencyMs),
                ],
                ["Simulated ERP call p95", nullableMetricMs(detail.erpAttempts.p95LatencyMs)],
                [
                  "Reservation-to-confirmation p95",
                  nullableMetricMs(
                    detail.runSignalTimelineSummary?.confirmationConvergence.p95LagMs ?? null,
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
              Lifecycle and reference
            </h2>
          </summary>
          <div className="mt-3 grid grid-cols-2 gap-4 max-[800px]:grid-cols-1">
            <FactList
              facts={[
                ["Run accepted", formatDate(summary.startedAt)],
                ["Checkout traffic started", formatDate(run.trafficStartedAt)],
                ["Checkout traffic ended", formatDate(run.trafficEndedAt)],
                ["Run ended", formatDate(run.finalizedAt)],
              ]}
              title="Lifecycle"
            />
            <FactList
              facts={[
                ...(summary.terminalInventorySnapshot
                  ? [
                      [
                        publicVocabulary.startingStock,
                        formatNumber(summary.terminalInventorySnapshot.startingStock),
                      ] as [string, ReactNode],
                      [
                        "Remaining stock",
                        formatNumber(summary.terminalInventorySnapshot.remainingStock),
                      ] as [string, ReactNode],
                      [
                        "Reserved stock",
                        formatNumber(summary.terminalInventorySnapshot.reservedStock),
                      ] as [string, ReactNode],
                    ]
                  : [
                      [publicVocabulary.startingStock, "not recorded"] as [string, ReactNode],
                      ["Remaining stock", "not recorded"] as [string, ReactNode],
                      ["Reserved stock", "not recorded"] as [string, ReactNode],
                    ]),
                [
                  publicVocabulary.uniqueReservationsSecured,
                  formatNumber(summary.businessOutcomeSummary.acceptedReservations),
                ],
                [
                  publicVocabulary.soldOutRejectionsRecorded,
                  formatNumber(summary.businessOutcomeSummary.soldOutRejections),
                ],
                ["Confirmed orders", formatNumber(summary.businessOutcomeSummary.confirmedOrders)],
                ["Failed orders", formatNumber(summary.businessOutcomeSummary.failedOrders)],
              ]}
              title="Final evidence"
            />
          </div>
          <dl className="m-0 mt-4 grid gap-2 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-muted">Run UUID</dt>
              <dd className="m-0 [overflow-wrap:anywhere] text-sm font-semibold text-muted-strong">
                <code>{summary.runId}</code>
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted">Aggregate evidence recorded</dt>
              <dd className="m-0 text-sm font-semibold text-muted-strong">
                {formatDate(summary.capturedAt)}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted">Logical queue</dt>
              <dd className="m-0 [overflow-wrap:anywhere] text-sm font-semibold text-muted-strong">
                <code>{config.backpressureConfig.queueName}</code>
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted">Physical queue</dt>
              <dd className="m-0 [overflow-wrap:anywhere] text-sm font-semibold text-muted-strong">
                <code>{config.backpressureConfig.physicalQueueName}</code>
              </dd>
            </div>
          </dl>
        </details>
      </section>

      <nav aria-label="Report actions" className="flex flex-wrap gap-3">
        <Link className={neutralLinkButtonClassName} href="/run-history">
          Back to run history
        </Link>
        <Link className={neutralLinkButtonClassName} href="/demo">
          Choose another scenario
        </Link>
        <a className={neutralLinkButtonClassName} href="#main-content">
          Back to top
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
}: {
  actions?: ReactNode;
  navigation?: ReactNode;
  presetName: string;
  automatic: boolean;
}) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-5 max-[560px]:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {navigation}
        {actions}
      </div>
      <p className="m-0 mt-3 text-xs font-medium text-muted">Cancelled</p>
      <h1 className="type-display m-0 mt-1 text-[1.875rem] leading-tight text-ink">{presetName}</h1>
      <p className="m-0 mt-3 text-sm leading-6 text-muted-strong">
        This run was cancelled by {automatic ? "an automatic" : "an admin"} reset. Its experiment
        data was discarded.
      </p>
    </section>
  );
}

export function scenarioRecap(detail: PublicRunHistoryDetailResponse): string {
  const { configSnapshot } = detail.run;
  const traffic = configSnapshot.trafficConfig;
  const demand =
    traffic.mode === "buyer-spike"
      ? `${formatNumber(traffic.buyerCount)} buyers`
      : `${formatNumber(detail.plannedAttempts)} planned attempts`;
  const details = [
    `${trafficModeLabel(traffic.mode)} · ${demand} · ${formatNumber(configSnapshot.inventoryConfig.startingStock)} starting units`,
  ];
  if (traffic.mode === "buyer-spike" && traffic.duplicateEachBuyerAttempt) {
    details.push("duplicate attempts enabled");
  }
  if (configSnapshot.erpConfig.forcedOutage) details.push("simulated ERP outage forced");
  if (configSnapshot.erpConfig.errorRate > 0) {
    details.push(`${formatPercent(configSnapshot.erpConfig.errorRate)} simulated ERP failure rate`);
  }
  return details.join(" · ");
}

function runRecap(
  detail: PublicRunHistoryDetailResponse,
  counts: ReturnType<typeof derivePublicRunSummary>["counts"],
): string[] {
  const { run } = detail;
  const trafficSubject =
    run.configSnapshot.trafficConfig.mode === "buyer-spike" ? "Buyer traffic" : "Checkout attempts";
  const time = (value: string | undefined) =>
    formatInstantUtc(value, { variant: "timeOnly" }) ?? "not recorded";
  const count = (value: number | null) => formatCount(value) ?? "not recorded";
  const trafficRecap = run.trafficStartedAt
    ? run.trafficEndedAt
      ? `${trafficSubject} started at ${time(run.trafficStartedAt)} and ended at ${time(run.trafficEndedAt)}.`
      : `${trafficSubject} started at ${time(run.trafficStartedAt)}; its end was not recorded.`
    : run.trafficEndedAt
      ? `${trafficSubject} start was not recorded; it ended at ${time(run.trafficEndedAt)}.`
      : `${trafficSubject} start and end were not recorded.`;
  const lines = [
    trafficRecap,
    `${count(counts.reservedUnits)} units reserved / ${count(counts.uniqueReservations)} unique reservations; ${count(counts.soldOutDecisions)} attempts turned away because stock ran out.`,
    `Orders reached their recorded outcome: ${count(counts.confirmedOrders)} confirmed, ${count(counts.failedOrders)} failed, ${count(counts.pendingOrders)} awaiting confirmation.`,
    `Run ended: ${time(run.finalizedAt)}.`,
  ];
  return lines;
}

function nullableMetricMs(value: number | null): string {
  return formatDurationMs(value) ?? "n/a";
}

function formatNumber(value: number): string {
  return formatCount(value) ?? "n/a";
}

/**
 * A percentage keeps its own decimal rule rather than inheriting a count formatter's default: a
 * 0-100 reading never needs grouping, and its precision must not move if the shared count policy
 * changes.
 */
const percentFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function formatPercent(value: number): string {
  return `${percentFormatter.format(value * 100)}%`;
}

/**
 * Renders the labelled UTC reading a person compares across routes while keeping the exact ISO
 * value in `<time dateTime>` for assistive technology and technical inspection. Both parts derive
 * from the same server-supplied string under a fixed zone, so hydration cannot disagree.
 */
function formatDate(value: string | undefined): ReactNode {
  const text = formatInstantUtc(value);
  if (value === undefined || text === null) {
    return "n/a";
  }

  return <time dateTime={value}>{text}</time>;
}

/** Configured guards are stored in seconds but are presented under the one duration policy. */
function formatDurationSeconds(value: number): string {
  return formatDurationMs(value * 1000) ?? "n/a";
}

function adminDeliveryLabel(
  status: AdminRunHistoryDetailResponse["summary"]["trafficDeliverySummary"]["trafficDeliveryStatus"],
): string {
  switch (status) {
    case "complete":
      return "Delivery complete";
    case "warning":
      return "Delivery warning";
    case "degraded":
      return "Delivery degraded";
    case "failed":
      return "Delivery failed";
  }
}

function codeValue(value: string): ReactNode {
  return <code>{value}</code>;
}
