import type {
  AdminRunHistoryDetailResponse,
  PublicRunHistoryDetailResponse,
} from "@checkout-surge/contracts";
import { deriveLoadExecutionPlan, deriveRunResult } from "@checkout-surge/contracts";
import type { ReactNode } from "react";
import { formatCount, formatDurationMs, formatInstantUtc } from "../lib/presentation/format";
import {
  durableCheckoutLens,
  publicFailureExplanation,
  publicStatusLabel,
  publicVocabulary,
  simulatedErpLens,
  trafficDeliveryStatusTone,
  trafficModeLabel,
} from "../lib/presentation/public-vocabulary";
import { deriveOverallRunDuration } from "../lib/presentation/run-duration";
import { deriveTerminalSummaryPresentation } from "../lib/presentation/run-presentation-state";
import {
  evidenceFromRunHistoryDetail,
  oversoldUnitsFromTerminalInventory,
} from "../lib/presentation/run-result-presentation";
import { ConfigGroup, FieldRow } from "./config-presentation";
import { GoldSignals } from "./gold-signals";
import { RunConclusion } from "./run-conclusion";
import { RunDiagnostics } from "./run-diagnostics";
import { StatusPill } from "./status-pill";
import { TransportObservationSection } from "./transport-observation";

interface RunHistoryDetailProps {
  actions?: ReactNode;
  detail: AdminRunHistoryDetailResponse;
  navigation?: ReactNode;
}

export function AdminRunHistoryDetail({ actions, detail, navigation }: RunHistoryDetailProps) {
  const { run, summary } = detail;
  const config = run.configSnapshot;
  const result = deriveRunResult(evidenceFromRunHistoryDetail(detail));
  const runPresentation = deriveTerminalSummaryPresentation(result);
  const overallDuration = deriveOverallRunDuration(summary);
  const failure = summary.failureCategory
    ? publicFailureExplanation(summary.failureCategory)
    : null;

  return (
    <div className="grid gap-4">
      <header className="rounded-lg border border-border bg-surface p-4 min-[900px]:sticky min-[900px]:top-16 min-[900px]:z-[5]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {navigation}
            <p className="m-0 text-xs font-bold uppercase text-muted">Run detail</p>
            <h1 className="m-0 mt-1 text-2xl font-bold leading-tight text-ink">
              {summary.presetName}
            </h1>
            <p className="m-0 mt-2 [overflow-wrap:anywhere] text-sm font-semibold text-muted-strong">
              {summary.runId}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
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

      <section aria-label="Run overview" className="rounded-lg border border-border bg-surface p-4">
        <div className="mt-4 grid grid-cols-4 gap-4 max-[1100px]:grid-cols-2 max-[700px]:grid-cols-1">
          <FactList
            facts={[
              ["Started", formatDate(summary.startedAt)],
              ["Overall run duration", overallDuration.text],
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
          <TransportObservationSection
            arrivalSummary={summary.trafficDeliverySummary.requestArrivalSummary}
            counts={summary.transportAttemptCounts}
            fastReservationTargetEvaluation={summary.fastReservationTargetEvaluation}
            httpTimingBreakdownSummary={detail.httpTimingBreakdownSummary}
            httpSummary={summary.httpSummary}
            serverReservationTimingSummary={summary.serverReservationTimingSummary}
            startDelaySeconds={run.configSnapshot.trafficConfig.startDelaySeconds}
            surface="detail"
            {...(run.trafficStartedAt ? { trafficStartedAt: run.trafficStartedAt } : {})}
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
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="m-0 text-base font-bold leading-tight text-ink">Run configuration</h2>
        <div className="mt-3 grid grid-cols-4 gap-4 max-[1100px]:grid-cols-2 max-[700px]:grid-cols-1">
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
            facts={[
              ["Starting stock", formatNumber(config.inventoryConfig.startingStock)],
              ["Quantity", formatNumber(config.inventoryConfig.quantityPerCheckout)],
              // Native minutes because of the unit, not because it is configured: the tiered
              // formatter has no minute-native form and would render a 15 minute hold as
              // "15 min 0 s" under a label that declares minutes. The guards below are configured
              // too and are tiered. See the unit-choice table in docs/cross_service_conventions.md.
              [
                "Configured hold (minutes)",
                formatNumber(config.inventoryConfig.reservationHoldMinutes),
              ],
            ]}
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
              ["Request timeout", formatDurationMs(config.erpConfig.requestTimeoutMs) ?? "n/a"],
            ]}
            title="Simulated ERP"
          />
          <FactList
            facts={[
              ["Concurrency", formatNumber(config.backpressureConfig.orderProcessConcurrency)],
              ["Retry attempts", formatNumber(config.backpressureConfig.retryPolicy.maxAttempts)],
              [
                "Initial retry backoff",
                formatDurationMs(config.backpressureConfig.retryPolicy.initialBackoffMs) ?? "n/a",
              ],
              [
                "Configured drain timeout",
                formatDurationSeconds(config.backpressureConfig.drainTimeoutSeconds),
              ],
              [
                "Configured retry delay",
                formatDurationSeconds(
                  config.backpressureConfig.pendingPersistenceRetryAfterSeconds,
                ),
              ],
              [
                "Circuit-breaker failure threshold",
                formatNumber(config.backpressureConfig.circuitBreakerFailureThreshold),
              ],
              [
                "Circuit-breaker reset timeout",
                formatDurationMs(config.backpressureConfig.circuitBreakerResetTimeoutMs) ?? "n/a",
              ],
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

      {failure ? (
        <section className="rounded-lg border border-warning bg-warning-soft p-4">
          <h2 className="m-0 text-base font-bold text-ink">What happened</h2>
          <p className="m-0 mt-2 text-sm text-muted-strong">{failure.explanation}</p>
          <p className="m-0 mt-1 text-sm font-semibold text-muted-strong">{failure.action}</p>
        </section>
      ) : null}

      <ExceptionSummary outcome={result.outcome} summary={detail.exceptionSummary} />

      <GoldSignals
        acceptedReservations={summary.businessOutcomeSummary.acceptedReservations}
        arrivalSummary={summary.trafficDeliverySummary.requestArrivalSummary}
        oversoldUnits={oversoldUnitsFromTerminalInventory(summary)}
        runStatus={run.status}
        terminalSummary={detail.runSignalTimelineSummary}
      />

      <RunDiagnostics
        summary={detail.loadRunDiagnosticsSummary}
        warningCount={detail.exceptionSummary.generatorWarnings}
      />

      <section className="rounded-lg border border-border bg-surface p-4">
        <CollectionHeader
          warningCount={detail.orders.warningCount}
          title="Order outcomes"
          totalCount={detail.orders.totalCount}
          truncated={detail.orders.truncated}
        />
        <div className="mt-3 overflow-x-auto">
          {detail.orders.records.length > 0 ? (
            <DenseTable
              accessibleName="Order outcomes"
              headers={["Public order", "Status", "Quantity", "Terminal time", "Details"]}
              rows={detail.orders.records.map((order) => ({
                id: order.orderId,
                identity: `order ${order.publicOrderId}`,
                cells: [
                  order.publicOrderId,
                  <span className={order.status === "failed" ? "text-danger" : ""} key="status">
                    {order.status}
                    {order.failureCode ? (
                      <>
                        {" "}
                        · <code>{order.failureCode}</code>
                      </>
                    ) : null}
                  </span>,
                  formatNumber(order.quantity),
                  order.confirmedAt || order.failedAt ? (
                    formatDate(order.confirmedAt ?? order.failedAt)
                  ) : (
                    <span className="text-warning" key="terminal">
                      Missing terminal evidence
                    </span>
                  ),
                ],
                details: [
                  ["Internal order", codeValue(order.orderId)],
                  ["Correlation", codeValue(order.correlationId)],
                  ["Queued", formatDate(order.queuedAt)],
                  ...(order.processingAt
                    ? [["Processing", formatDate(order.processingAt)] as [string, ReactNode]]
                    : []),
                ],
              }))}
            />
          ) : (
            <EmptyCollection label="No order outcomes were recorded for this run." />
          )}
        </div>
      </section>

      <section className="grid grid-cols-3 gap-4 max-[1100px]:grid-cols-1">
        <CollectionPanel
          emptyLabel="No ERP attempts were recorded."
          headers={["Order / attempt", "Status", "Latency", "Finished", "Details"]}
          records={detail.erpAttempts.records.map((attempt) => ({
            id: attempt.attemptId,
            identity: `ERP attempt ${attempt.attemptId}`,
            cells: [
              `${attempt.publicOrderId} / ${attempt.attemptNumber}`,
              <span
                className={attempt.status === "succeeded" && attempt.terminal ? "" : "text-danger"}
                key="status"
              >
                {attempt.status}
                {!attempt.terminal ? " · missing terminal evidence" : ""}
                {attempt.errorCode ? (
                  <>
                    {" "}
                    · <code>{attempt.errorCode}</code>
                  </>
                ) : null}
              </span>,
              formatDurationMs(attempt.latencyMs) ?? "not recorded",
              formatDate(attempt.finishedAt),
            ],
            details: [
              ["Attempt", codeValue(attempt.attemptId)],
              ["Internal order", codeValue(attempt.orderId)],
              ["Correlation", codeValue(attempt.correlationId)],
              ["Started", formatDate(attempt.startedAt)],
              ...(attempt.httpStatus
                ? [["HTTP", String(attempt.httpStatus)] as [string, ReactNode]]
                : []),
            ],
          }))}
          title="ERP attempts"
          totalCount={detail.erpAttempts.totalCount}
          truncated={detail.erpAttempts.truncated}
          warningCount={detail.erpAttempts.warningCount}
        />
        <CollectionPanel
          emptyLabel="No simulated notifications were recorded."
          headers={["Public order", "Recorded", "Details"]}
          records={detail.notifications.records.map((notification) => ({
            id: notification.notificationId,
            identity: `notification ${notification.notificationId}`,
            cells: [notification.publicOrderId, formatDate(notification.recordedAt)],
            details: [
              ["Notification", codeValue(notification.notificationId)],
              ["Internal order", codeValue(notification.orderId)],
            ],
          }))}
          title={publicVocabulary.notifications}
          totalCount={detail.notifications.totalCount}
          truncated={detail.notifications.truncated}
          warningCount={detail.notifications.warningCount}
        />
        <CollectionPanel
          emptyLabel="No event timeline entries were recorded."
          headers={["Event", "Order", "Occurred", "Details"]}
          records={detail.eventTimeline.records.map((event) => ({
            id: event.eventId,
            identity: `event ${event.eventId}`,
            cells: [
              event.eventName,
              event.publicOrderId ?? "No order",
              formatDate(event.occurredAt),
            ],
            details: [
              ["Event", codeValue(event.eventId)],
              ["Source", event.source],
              ["Correlation", codeValue(event.correlationId)],
            ],
          }))}
          title="Event timeline"
          totalCount={detail.eventTimeline.totalCount}
          truncated={detail.eventTimeline.truncated}
          warningCount={detail.eventTimeline.warningCount}
        />
      </section>
    </div>
  );
}

function CollectionPanel({
  emptyLabel,
  headers,
  records,
  title,
  totalCount,
  truncated,
  warningCount,
}: {
  emptyLabel: string;
  headers: string[];
  records: Array<{
    id: string;
    identity: string;
    cells: ReactNode[];
    details: Array<[string, ReactNode]>;
  }>;
  title: string;
  totalCount: number;
  truncated: boolean;
  warningCount: number;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <CollectionHeader
        title={title}
        totalCount={totalCount}
        truncated={truncated}
        warningCount={warningCount}
      />
      <div className="mt-3 overflow-x-auto">
        {records.length > 0 ? (
          <DenseTable accessibleName={title} headers={headers} rows={records} />
        ) : (
          <EmptyCollection label={emptyLabel} />
        )}
      </div>
    </section>
  );
}

function CollectionHeader({
  title,
  totalCount,
  truncated,
  warningCount,
}: {
  title: string;
  totalCount: number;
  truncated: boolean;
  warningCount: number;
}) {
  const needsAttention = warningCount > 0 || truncated;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="m-0 text-base font-bold leading-tight text-ink">{title}</h2>
      <p
        className={`m-0 text-xs font-bold uppercase ${needsAttention ? "text-warning" : "text-muted"}`}
      >
        {formatNumber(totalCount)} total · {formatNumber(warningCount)} warnings
        {truncated ? " · truncated to recent records" : " · complete"}
      </p>
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

function DenseTable({
  accessibleName,
  headers,
  rows,
}: {
  accessibleName: string;
  headers: string[];
  rows: Array<{
    id: string;
    identity: string;
    cells: ReactNode[];
    details: Array<[string, ReactNode]>;
  }>;
}) {
  return (
    <table className="w-full min-w-[42rem] border-collapse text-left text-sm">
      <caption className="sr-only">{accessibleName}</caption>
      <thead>
        <tr className="border-b border-border text-xs uppercase text-muted">
          {headers.map((header) => (
            <th className="px-2 py-2 font-bold" key={header} scope="col">
              {header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr className="border-b border-border last:border-b-0" key={row.id}>
            {row.cells.map((cell, index) =>
              index === 0 ? (
                <th
                  className="px-2 py-2 align-top font-semibold text-muted-strong"
                  key={headers[index]}
                  scope="row"
                >
                  {cell}
                </th>
              ) : (
                <td
                  className="px-2 py-2 align-top font-semibold text-muted-strong"
                  key={headers[index]}
                >
                  {cell}
                </td>
              ),
            )}
            <td className="px-2 py-2 align-top">
              <details>
                <summary
                  aria-label={`Technical detail for ${row.identity}`}
                  className="cursor-pointer font-semibold text-muted-strong"
                >
                  Technical detail
                </summary>
                <dl className="mt-2 grid gap-1">
                  {row.details.map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-xs text-muted">{label}</dt>
                      <dd className="m-0 [overflow-wrap:anywhere] text-xs text-muted-strong">
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ExceptionSummary({
  outcome,
  summary,
}: {
  outcome: ReturnType<typeof deriveRunResult>["outcome"];
  summary: AdminRunHistoryDetailResponse["exceptionSummary"];
}) {
  const entries = [
    ["broken invariants", summary.brokenInvariants],
    ["failed orders", summary.failedOrders],
    ["pending work", summary.pendingWork],
    ["delivery exceptions", summary.partialDelivery],
    ["generator warnings", summary.generatorWarnings],
    ["truncated collections", summary.truncatedCollections],
  ] as const;
  const exceptions = entries.filter(([, count]) => count > 0);
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
      className={`rounded-lg border p-4 ${
        isFailure
          ? "border-danger bg-danger-soft"
          : needsAttention
            ? "border-warning bg-warning-soft"
            : "border-border bg-surface"
      }`}
      aria-label="Exception summary"
    >
      <h2 className="m-0 text-base font-bold text-ink">Exception summary</h2>
      <p
        className={`m-0 mt-2 text-sm font-semibold ${
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
    </section>
  );
}

function EmptyCollection({ label }: { label: string }) {
  return <p className="m-0 text-sm font-semibold text-muted">{label}</p>;
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
  const result = detail.result;
  const config = run.configSnapshot;
  const failure = summary.failureCategory
    ? publicFailureExplanation(summary.failureCategory)
    : null;
  return (
    <div className="grid gap-4">
      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="m-0 text-base font-bold leading-tight text-ink">Accepted configuration</h2>
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
              ["Quantity per checkout", formatNumber(config.inventoryConfig.quantityPerCheckout)],
              [
                "Configured hold (minutes)",
                formatNumber(config.inventoryConfig.reservationHoldMinutes),
              ],
            ]}
            title="Inventory"
          />
          <FactList
            facts={[
              ["Delay per order", formatDurationMs(config.erpConfig.latencyMs) ?? "not recorded"],
              ["Capacity (orders/s)", formatNumber(config.erpConfig.maxTps)],
              ["Failure rate", formatPercent(config.erpConfig.errorRate)],
              ["Forced outage", config.erpConfig.forcedOutage ? "yes" : "no"],
              [
                "Request timeout (configured safety limit)",
                formatDurationMs(config.erpConfig.requestTimeoutMs) ?? "not recorded",
              ],
            ]}
            title="Simulated ERP"
          />
          <FactList
            facts={[
              [
                "Order-processing concurrency",
                formatNumber(config.backpressureConfig.orderProcessConcurrency),
              ],
              [
                "Retry attempts (configured limit)",
                formatNumber(config.backpressureConfig.retryPolicy.maxAttempts),
              ],
              [
                "Initial retry backoff",
                formatDurationMs(config.backpressureConfig.retryPolicy.initialBackoffMs) ??
                  "not recorded",
              ],
              [
                "Drain safety limit (configured)",
                formatDurationSeconds(config.backpressureConfig.drainTimeoutSeconds),
              ],
              [
                "Pending-storage retry delay (configured)",
                formatDurationSeconds(
                  config.backpressureConfig.pendingPersistenceRetryAfterSeconds,
                ),
              ],
              [
                "Circuit-breaker failure threshold",
                formatNumber(config.backpressureConfig.circuitBreakerFailureThreshold),
              ],
              [
                "Circuit-breaker reset timeout",
                formatDurationMs(config.backpressureConfig.circuitBreakerResetTimeoutMs) ??
                  "not recorded",
              ],
            ]}
            title="Backpressure"
          />
        </div>
      </section>

      <RunConclusion
        result={result}
        runStatus={summary.status}
        showReconciliationStatus
        showSentence={false}
      />

      <section aria-labelledby="history-gold-signals" className="grid gap-3">
        <h2 id="history-gold-signals" className="m-0 text-base font-bold leading-tight text-ink">
          Gold signals
        </h2>
        <GoldSignals
          acceptedReservations={summary.businessOutcomeSummary.acceptedReservations}
          arrivalSummary={summary.trafficDeliverySummary.requestArrivalSummary}
          oversoldUnits={oversoldUnitsFromTerminalInventory(summary)}
          runStatus={run.status}
          terminalSummary={detail.runSignalTimelineSummary}
        />
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="m-0 text-base font-bold leading-tight text-ink">
          Client observation and delivery quality
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
        <div className="mt-3 grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
          <TransportObservationSection
            arrivalSummary={summary.trafficDeliverySummary.requestArrivalSummary}
            counts={summary.transportAttemptCounts}
            fastReservationTargetEvaluation={summary.fastReservationTargetEvaluation}
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
                    ["Timed-out attempts", formatNumber(detail.erpAttempts.byStatus.timedOut)] as [
                      string,
                      ReactNode,
                    ],
                  ]
                : []),
              ["Simulated ERP call average", nullableMetricMs(detail.erpAttempts.averageLatencyMs)],
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
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="m-0 text-base font-bold leading-tight text-ink">
          Lifecycle and final inventory
        </h2>
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
      </section>

      {failure ? (
        <section className="rounded-lg border border-warning bg-warning-soft p-4">
          <h2 className="m-0 text-base font-bold text-ink">What happened</h2>
          <p className="m-0 mt-2 text-sm text-muted-strong">{failure.explanation}</p>
          <p className="m-0 mt-1 text-sm font-semibold text-muted-strong">{failure.action}</p>
        </section>
      ) : null}

      <details className="rounded-lg border border-border bg-surface p-4">
        <summary className="cursor-pointer font-semibold text-ink">Technical details</summary>
        <dl className="m-0 mt-3 grid gap-2">
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
    </div>
  );
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
