import type {
  AdminRunHistoryDetailResponse,
  PublicRunHistoryDetailResponse,
} from "@checkout-surge/contracts";
import { deriveRunResult } from "@checkout-surge/contracts";
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
  detail: AdminRunHistoryDetailResponse;
}

export function AdminRunHistoryDetail({ detail }: RunHistoryDetailProps) {
  const { run, summary } = detail;
  const config = run.configSnapshot;
  const result = deriveRunResult(evidenceFromRunHistoryDetail(detail));
  const runPresentation = deriveTerminalSummaryPresentation(result);
  const overallDuration = deriveOverallRunDuration(summary);

  return (
    <div className="grid gap-4">
      <RunConclusion result={result} runStatus={summary.status} />
      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="m-0 text-xs font-bold uppercase text-muted">Run detail</p>
            <h2 className="m-0 mt-1 text-2xl font-bold leading-tight text-ink">
              {summary.presetName}
            </h2>
            <p className="m-0 mt-2 [overflow-wrap:anywhere] text-sm font-semibold text-muted-strong">
              {summary.runId}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
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
                label: publicStatusLabel({
                  family: "traffic-delivery",
                  status: summary.trafficDeliverySummary.trafficDeliveryStatus,
                }),
                tone: trafficDeliveryStatusTone(
                  summary.trafficDeliverySummary.trafficDeliveryStatus,
                ),
              }}
            />
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-4 max-[900px]:grid-cols-1">
          <FactList
            facts={[
              ["Started", formatDate(summary.startedAt)],
              ["Overall run duration", overallDuration.text],
              ["Traffic started", formatDate(run.trafficStartedAt)],
              ["Traffic ended", formatDate(run.trafficEndedAt)],
              ["Finalized", formatDate(run.finalizedAt)],
              ["Evidence recorded", formatDate(summary.capturedAt)],
              ["Failure", detail.internalFailureReason ?? "none"],
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
            caption={durableCheckoutLens.caption}
            facts={[
              [
                publicVocabulary.uniqueReservationsSecured,
                formatNumber(summary.businessOutcomeSummary.acceptedReservations),
              ],
              ["Queued", formatNumber(summary.businessOutcomeSummary.queuedOrders)],
              ["Processing", formatNumber(summary.businessOutcomeSummary.processingOrders)],
              ["Retrying", formatNumber(summary.businessOutcomeSummary.retryingOrders)],
              ["Confirmed", formatNumber(summary.businessOutcomeSummary.confirmedOrders)],
              ["Failed", formatNumber(summary.businessOutcomeSummary.failedOrders)],
              [
                publicVocabulary.notifications,
                formatNumber(summary.businessOutcomeSummary.notificationsRecorded),
              ],
            ]}
            title={durableCheckoutLens.title}
          />
        </div>
      </section>

      <GoldSignals
        acceptedReservations={summary.businessOutcomeSummary.acceptedReservations}
        arrivalSummary={summary.trafficDeliverySummary.requestArrivalSummary}
        oversoldUnits={oversoldUnitsFromTerminalInventory(summary)}
        runStatus={run.status}
        terminalSummary={detail.runSignalTimelineSummary}
      />

      <RunDiagnostics summary={detail.loadRunDiagnosticsSummary} />

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="m-0 text-base font-bold leading-tight text-ink">Run configuration</h2>
        <div className="mt-3 grid grid-cols-4 gap-4 max-[1100px]:grid-cols-2 max-[700px]:grid-cols-1">
          <FactList facts={trafficConfigFacts(config.trafficConfig)} title="Traffic" />
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
            ]}
            title="Simulated ERP"
          />
          <FactList
            facts={[
              ["Concurrency", formatNumber(config.backpressureConfig.orderProcessConcurrency)],
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
            ]}
            title="Order processing"
          />
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <CollectionHeader
          title="Order outcomes"
          totalCount={detail.orders.totalCount}
          truncated={detail.orders.truncated}
        />
        <div className="mt-3 grid gap-3">
          {detail.orders.records.length > 0 ? (
            detail.orders.records.map((order) => (
              <RecordRow
                facts={[
                  ["Public order", order.publicOrderId],
                  ["Status", order.status],
                  ["Quantity", formatNumber(order.quantity)],
                  ["Queued", formatDate(order.queuedAt)],
                  ["Confirmed", formatDate(order.confirmedAt)],
                  ["Failed", formatDate(order.failedAt)],
                  ["Failure code", order.failureCode ?? "none"],
                  ["Correlation", order.correlationId],
                ]}
                key={order.orderId}
                title={order.orderId}
              />
            ))
          ) : (
            <EmptyCollection label="No order outcomes were recorded for this run." />
          )}
        </div>
      </section>

      <section className="grid grid-cols-3 gap-4 max-[1100px]:grid-cols-1">
        <CollectionPanel
          emptyLabel="No ERP attempts were recorded."
          records={detail.erpAttempts.records.map((attempt) => ({
            id: attempt.attemptId,
            title: `${attempt.publicOrderId} attempt ${attempt.attemptNumber}`,
            facts: [
              ["Status", attempt.status],
              ["Terminal", attempt.terminal ? "yes" : "no"],
              ["HTTP", attempt.httpStatus ? String(attempt.httpStatus) : "n/a"],
              ["Error", attempt.errorCode ?? "none"],
              ["Observed latency", formatDurationMs(attempt.latencyMs) ?? "n/a"],
              ["Finished", formatDate(attempt.finishedAt)],
            ],
          }))}
          title="ERP attempts"
          totalCount={detail.erpAttempts.totalCount}
          truncated={detail.erpAttempts.truncated}
        />
        <CollectionPanel
          emptyLabel="No simulated notifications were recorded."
          records={detail.notifications.records.map((notification) => ({
            id: notification.notificationId,
            title: notification.publicOrderId,
            facts: [["Recorded", formatDate(notification.recordedAt)]],
          }))}
          title={publicVocabulary.notifications}
          totalCount={detail.notifications.totalCount}
          truncated={detail.notifications.truncated}
        />
        <CollectionPanel
          emptyLabel="No event timeline entries were recorded."
          records={detail.eventTimeline.records.map((event) => ({
            id: event.eventId,
            title: event.eventName,
            facts: [
              ["Source", event.source],
              ["Order", event.publicOrderId ?? "n/a"],
              ["Occurred", formatDate(event.occurredAt)],
            ],
          }))}
          title="Event timeline"
          totalCount={detail.eventTimeline.totalCount}
          truncated={detail.eventTimeline.truncated}
        />
      </section>
    </div>
  );
}

function CollectionPanel({
  emptyLabel,
  records,
  title,
  totalCount,
  truncated,
}: {
  emptyLabel: string;
  records: Array<{ id: string; title: string; facts: Array<[string, ReactNode]> }>;
  title: string;
  totalCount: number;
  truncated: boolean;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <CollectionHeader title={title} totalCount={totalCount} truncated={truncated} />
      <div className="mt-3 grid gap-3">
        {records.length > 0 ? (
          records.map((record) => (
            <RecordRow facts={record.facts} key={record.id} title={record.title} />
          ))
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
}: {
  title: string;
  totalCount: number;
  truncated: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="m-0 text-base font-bold leading-tight text-ink">{title}</h2>
      <p className="m-0 text-xs font-bold uppercase text-muted">
        {formatNumber(totalCount)} total{truncated ? " · showing recent" : ""}
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

function RecordRow({ facts, title }: { facts: Array<[string, ReactNode]>; title: string }) {
  return (
    <article className="min-w-0 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <h3 className="m-0 [overflow-wrap:anywhere] text-sm font-bold text-ink">{title}</h3>
      <dl className="m-0 mt-3 grid gap-2">
        {facts.map(([label, value]) => (
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3" key={label}>
            <dt className="text-sm text-muted">{label}</dt>
            <dd className="m-0 max-w-48 [overflow-wrap:anywhere] text-right text-sm font-semibold text-muted-strong">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </article>
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
