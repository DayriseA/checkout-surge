import type {
  AdminRunHistoryDetailResponse,
  PublicRunHistoryDetailResponse,
} from "@checkout-surge/contracts";
import { deriveOversoldUnits } from "@checkout-surge/contracts";
import { deriveTerminalSummaryPresentation } from "../lib/presentation/run-presentation-state";
import { GoldSignals } from "./gold-signals";
import { RunDiagnostics } from "./run-diagnostics";
import { StatusPill } from "./status-pill";
import { systemOfRecordLens, TransportObservationSection } from "./transport-observation";

interface RunHistoryDetailProps {
  detail: AdminRunHistoryDetailResponse;
}

export function AdminRunHistoryDetail({ detail }: RunHistoryDetailProps) {
  const { run, summary } = detail;
  const config = run.configSnapshot;
  const runPresentation = terminalSummaryPresentation(summary);

  return (
    <div className="grid gap-4">
      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="m-0 text-xs font-bold uppercase text-muted">Terminal detail</p>
            <h2 className="m-0 mt-1 text-2xl font-bold leading-tight text-ink">
              {summary.presetName}
            </h2>
            <p className="m-0 mt-2 [overflow-wrap:anywhere] text-sm font-semibold text-muted-strong">
              {summary.runId}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <StatusPill status={runPresentation} />
            <StatusPill status={{ label: `operator ${run.operatorMode}`, tone: "idle" }} />
            <StatusPill
              status={{
                label: `traffic ${summary.trafficDeliverySummary.trafficDeliveryStatus}`,
                tone:
                  summary.trafficDeliverySummary.trafficDeliveryStatus === "failed"
                    ? "danger"
                    : "ok",
              }}
            />
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-4 max-[900px]:grid-cols-1">
          <FactList
            facts={[
              ["Started", formatDate(summary.startedAt)],
              ["Traffic started", formatDate(run.trafficStartedAt)],
              ["Traffic ended", formatDate(run.trafficEndedAt)],
              ["Finalized", formatDate(run.finalizedAt)],
              ["Captured", formatDate(summary.capturedAt)],
              ["Failure", summary.failureReason ?? "none"],
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
            caption={systemOfRecordLens.caption}
            facts={[
              ["Reservations", formatNumber(summary.businessOutcomeSummary.acceptedReservations)],
              ["Queued", formatNumber(summary.businessOutcomeSummary.queuedOrders)],
              ["Processing", formatNumber(summary.businessOutcomeSummary.processingOrders)],
              ["Retrying", formatNumber(summary.businessOutcomeSummary.retryingOrders)],
              ["Confirmed", formatNumber(summary.businessOutcomeSummary.confirmedOrders)],
              ["Failed", formatNumber(summary.businessOutcomeSummary.failedOrders)],
              ["Notifications", formatNumber(summary.businessOutcomeSummary.notificationsRecorded)],
            ]}
            title={systemOfRecordLens.title}
          />
        </div>
      </section>

      <GoldSignals
        acceptedReservations={summary.businessOutcomeSummary.acceptedReservations}
        arrivalSummary={summary.trafficDeliverySummary.requestArrivalSummary}
        oversoldUnits={
          summary.terminalInventorySnapshot
            ? deriveOversoldUnits(summary.terminalInventorySnapshot)
            : 0
        }
        terminalSummary={detail.runSignalTimelineSummary}
      />

      <RunDiagnostics summary={detail.loadRunDiagnosticsSummary} />

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="m-0 text-base font-bold leading-tight text-ink">Accepted configuration</h2>
        <div className="mt-3 grid grid-cols-4 gap-4 max-[1100px]:grid-cols-2 max-[700px]:grid-cols-1">
          <FactList facts={trafficConfigFacts(config.trafficConfig)} title="Traffic" />
          <FactList
            facts={[
              ["Starting stock", formatNumber(config.inventoryConfig.startingStock)],
              ["Quantity", formatNumber(config.inventoryConfig.quantityPerCheckout)],
              ["Hold minutes", formatNumber(config.inventoryConfig.reservationHoldMinutes)],
            ]}
            title="Inventory"
          />
          <FactList
            facts={[
              ["Latency", `${formatNumber(config.erpConfig.latencyMs)}ms`],
              ["Max TPS", formatNumber(config.erpConfig.maxTps)],
              ["Error rate", formatPercent(config.erpConfig.errorRate)],
              ["Forced outage", config.erpConfig.forcedOutage ? "yes" : "no"],
            ]}
            title="ERP"
          />
          <FactList
            facts={[
              ["Concurrency", formatNumber(config.backpressureConfig.orderProcessConcurrency)],
              ["Drain timeout", `${formatNumber(config.backpressureConfig.drainTimeoutSeconds)}s`],
              [
                "Retry delay",
                `${formatNumber(config.backpressureConfig.pendingPersistenceRetryAfterSeconds)}s`,
              ],
            ]}
            title="Backpressure"
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
              ["Latency", `${formatNumber(attempt.latencyMs)}ms`],
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
          title="Notifications"
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
  records: Array<{ id: string; title: string; facts: Array<[string, string]> }>;
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
  facts: Array<[string, string]>;
  title: string;
}) {
  return (
    <section className="min-w-0 border-t border-border pt-3">
      <h3 className="m-0 text-sm font-bold text-ink">{title}</h3>
      {caption ? <p className="m-0 mt-0.5 text-xs text-muted">{caption}</p> : null}
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
    </section>
  );
}

function RecordRow({ facts, title }: { facts: Array<[string, string]>; title: string }) {
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
): Array<[string, string]> {
  if (config.mode === "buyer-spike") {
    return [
      ["Mode", "buyer spike"],
      ["Buyer count", formatNumber(config.buyerCount)],
      ["Duplicate attempts", config.duplicateEachBuyerAttempt ? "yes" : "no"],
      ["Dispatch window", `${formatNumber(config.maxDurationSeconds)}s`],
      ["Quantity", formatNumber(config.quantityPerAttempt)],
    ];
  }

  return [
    ["Mode", "constant arrival"],
    ["Rate", `${formatNumber(config.ratePerSecond)}/s`],
    ["Duration", `${formatNumber(config.durationSeconds)}s`],
    ["Quantity", formatNumber(config.quantityPerAttempt)],
    ["Max VUs", config.k6Vus ? formatNumber(config.k6Vus.maxVus) : "n/a"],
  ];
}

export function PublicRunHistoryDetail({ detail }: { detail: PublicRunHistoryDetailResponse }) {
  const { run, summary } = detail;
  const runPresentation = terminalSummaryPresentation(summary);
  return (
    <div className="grid gap-4">
      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="m-0 text-xs font-bold uppercase text-muted">Terminal detail</p>
            <h2 className="m-0 mt-1 text-2xl font-bold leading-tight text-ink">
              {summary.presetName}
            </h2>
            <p className="m-0 mt-2 text-sm font-semibold text-muted-strong">{summary.runId}</p>
          </div>
          <StatusPill status={runPresentation} />
        </div>
        <div className="mt-4 grid grid-cols-4 gap-4 max-[1100px]:grid-cols-2 max-[700px]:grid-cols-1">
          <FactList
            title="Lifecycle"
            facts={[
              ["Started", formatDate(summary.startedAt)],
              ["Traffic started", formatDate(run.trafficStartedAt)],
              ["Traffic ended", formatDate(run.trafficEndedAt)],
              ["Finalized", formatDate(run.finalizedAt)],
              ["Captured", formatDate(summary.capturedAt)],
            ]}
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
            caption="what the API recorded"
            title="Order aggregates"
            facts={[
              ["Total", formatNumber(detail.orders.totalCount)],
              ["Queued", formatNumber(detail.orders.byStatus.queued)],
              ["Processing", formatNumber(detail.orders.byStatus.processing)],
              ["Confirmed", formatNumber(detail.orders.byStatus.confirmed)],
              ["Failed", formatNumber(detail.orders.byStatus.failed)],
            ]}
          />
          <FactList
            caption="what the ERP dependency recorded"
            title="ERP aggregates"
            facts={[
              ["Attempts", formatNumber(detail.erpAttempts.totalCount)],
              ["Succeeded", formatNumber(detail.erpAttempts.byStatus.succeeded)],
              ["Failed", formatNumber(detail.erpAttempts.byStatus.failed)],
              ["Timed out", formatNumber(detail.erpAttempts.byStatus.timedOut)],
              ["Average latency", nullableMetricMs(detail.erpAttempts.averageLatencyMs)],
              ["p95 latency", nullableMetricMs(detail.erpAttempts.p95LatencyMs)],
            ]}
          />
        </div>
      </section>
      <GoldSignals
        acceptedReservations={summary.businessOutcomeSummary.acceptedReservations}
        arrivalSummary={summary.trafficDeliverySummary.requestArrivalSummary}
        oversoldUnits={
          summary.terminalInventorySnapshot
            ? deriveOversoldUnits(summary.terminalInventorySnapshot)
            : 0
        }
        terminalSummary={detail.runSignalTimelineSummary}
      />
      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="m-0 text-base font-bold leading-tight text-ink">Public activity totals</h2>
        <div className="mt-3 grid grid-cols-2 gap-4 max-[700px]:grid-cols-1">
          <FactList
            title="Notifications"
            facts={[["Recorded", formatNumber(detail.notifications.totalCount)]]}
          />
          <FactList title="Events" facts={[["Recorded", formatNumber(detail.events.totalCount)]]} />
        </div>
      </section>
      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="m-0 text-base font-bold leading-tight text-ink">Accepted configuration</h2>
        <div className="mt-3">
          <FactList facts={trafficConfigFacts(run.configSnapshot.trafficConfig)} title="Traffic" />
        </div>
      </section>
    </div>
  );
}

function nullableMetricMs(value: number | null): string {
  return value === null ? "n/a" : `${formatNumber(value)}ms`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(value: number): string {
  return `${formatNumber(value * 100)}%`;
}

function terminalSummaryPresentation(
  summary: AdminRunHistoryDetailResponse["summary"] | PublicRunHistoryDetailResponse["summary"],
) {
  const business = summary.businessOutcomeSummary;
  return deriveTerminalSummaryPresentation({
    runStatus: summary.status,
    ...(summary.terminalInventorySnapshot
      ? { startingStock: summary.terminalInventorySnapshot.startingStock }
      : {}),
    acceptedReservations: business.acceptedReservations,
    confirmedOrders: business.confirmedOrders,
    failedOrders: business.failedOrders,
    pendingPersistenceCount: business.pendingPersistenceCount,
  });
}

function formatDate(value: string | undefined): string {
  if (!value) {
    return "n/a";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}
