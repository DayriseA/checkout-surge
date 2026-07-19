import type { RunHistoryListResponse, RunHistorySummary } from "@checkout-surge/contracts";
import Link from "next/link";
import { StatusPill } from "./status-pill";

interface RunHistoryListProps {
  history: RunHistoryListResponse;
}

export function RunHistoryList({ history }: RunHistoryListProps) {
  if (history.summaries.length === 0) {
    if (history.totalCount > 0) {
      return <OutOfRangePageState history={history} />;
    }

    return (
      <section className="rounded-lg border border-border bg-surface p-4">
        <p className="m-0 text-xs font-bold uppercase text-muted">Completed runs</p>
        <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">No history yet</h2>
        <p className="m-0 mt-3 max-w-[66ch] text-sm leading-6 text-muted">
          Terminal summaries appear here after a load run reaches API-owned finalization.
        </p>
      </section>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-3">
        {history.summaries.map((summary) => (
          <RunHistorySummaryArticle key={summary.id} summary={summary} />
        ))}
      </div>
      <PaginationControls history={history} />
    </div>
  );
}

function OutOfRangePageState({ history }: { history: RunHistoryListResponse }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <p className="m-0 text-xs font-bold uppercase text-muted">Completed runs</p>
      <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">
        Page {history.page} has no summaries
      </h2>
      <p className="m-0 mt-3 max-w-[66ch] text-sm leading-6 text-muted">
        {formatNumber(history.totalCount)} summaries exist, but this page is outside the available
        range.
      </p>
      <Link
        className="mt-3 inline-flex min-h-10 items-center rounded-lg border border-border px-3.5 py-2.5 text-sm font-semibold text-muted-strong"
        href="/run-history"
      >
        View latest summaries
      </Link>
    </section>
  );
}

function RunHistorySummaryArticle({ summary }: { summary: RunHistorySummary }) {
  return (
    <article className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="m-0 text-xs font-bold uppercase text-muted">Terminal summary</p>
          <h2 className="m-0 mt-1 text-xl font-bold leading-tight text-ink">
            {summary.presetName}
          </h2>
          <p className="m-0 mt-2 [overflow-wrap:anywhere] text-sm font-semibold text-muted-strong">
            {summary.runId}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <StatusPill
            label={summary.status}
            tone={summary.status === "completed" ? "ok" : "blocked"}
          />
          <StatusPill
            label={`traffic ${summary.trafficDeliverySummary.trafficDeliveryStatus}`}
            tone={trafficDeliveryTone(summary.trafficDeliverySummary.trafficDeliveryStatus)}
          />
          <Link
            className="inline-flex min-h-8 items-center rounded-lg border border-border px-3 text-sm font-semibold text-muted-strong"
            href={`/run-history/${summary.runId}`}
          >
            View details
          </Link>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4 max-[900px]:grid-cols-1">
        <SummarySection
          facts={[
            ["Started", formatDate(summary.startedAt)],
            ["Ended", formatDate(summary.endedAt)],
            ["Captured", formatDate(summary.capturedAt)],
            ["Failure", summary.failureReason ?? "none"],
          ]}
          title="Lifecycle"
        />
        <SummarySection
          facts={[
            ["Planned", formatNumber(summary.httpSummary.plannedRequests)],
            ["Started", formatNumber(summary.httpSummary.startedRequests)],
            ["Responses completed", formatNumber(summary.httpSummary.completedRequests)],
            ["Interrupted", formatNumber(summary.httpSummary.interruptedRequests)],
            ["Unstarted", formatNumber(summary.httpSummary.unstartedRequests)],
            ["Accepted", formatNumber(summary.httpSummary.acceptedResponses)],
            ["Sold out", formatNumber(summary.httpSummary.soldOutResponses)],
            ["Unexpected", formatNumber(summary.httpSummary.unexpectedResponses)],
            ["p95 latency", nullableMs(summary.httpSummary.p95LatencyMs)],
          ]}
          title="Traffic"
        />
        <SummarySection
          facts={[
            [
              "Accepted reservations",
              formatNumber(summary.businessOutcomeSummary.acceptedReservations),
            ],
            ["Sold-out decisions", formatNumber(summary.businessOutcomeSummary.soldOutRejections)],
            ["Confirmed orders", formatNumber(summary.businessOutcomeSummary.confirmedOrders)],
            ["Failed orders", formatNumber(summary.businessOutcomeSummary.failedOrders)],
            ["Notifications", formatNumber(summary.businessOutcomeSummary.notificationsRecorded)],
            [
              "Pending persistence",
              formatNumber(summary.businessOutcomeSummary.pendingPersistenceCount),
            ],
          ]}
          title="Business"
        />
      </div>
      <TerminalInventorySnapshot summary={summary} />
    </article>
  );
}

function SummarySection({ facts, title }: { facts: Array<[string, string]>; title: string }) {
  return (
    <section className="min-w-0 border-t border-border pt-3">
      <h3 className="m-0 text-sm font-bold text-ink">{title}</h3>
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

function TerminalInventorySnapshot({ summary }: { summary: RunHistorySummary }) {
  const snapshot = summary.terminalInventorySnapshot;

  if (!snapshot) {
    return (
      <section className="mt-4 border-t border-border pt-3">
        <h3 className="m-0 text-sm font-bold text-ink">Terminal inventory</h3>
        <p className="m-0 mt-2 text-sm font-semibold text-muted">No terminal snapshot captured.</p>
      </section>
    );
  }

  return (
    <section className="mt-4 border-t border-border pt-3">
      <h3 className="m-0 text-sm font-bold text-ink">Terminal inventory</h3>
      <dl className="m-0 mt-3 grid grid-cols-6 gap-3 max-[900px]:grid-cols-2">
        <Fact label="Starting stock" value={formatNumber(snapshot.startingStock)} />
        <Fact label="Remaining" value={formatNumber(snapshot.remainingStock)} />
        <Fact label="Reserved" value={formatNumber(snapshot.reservedStock)} />
        <Fact label="Accepted" value={formatNumber(snapshot.acceptedReservations)} />
        <Fact label="Sold out" value={formatNumber(snapshot.soldOutRejections)} />
        <Fact label="Pending" value={formatNumber(snapshot.pendingPersistenceCount)} />
      </dl>
      <p className="m-0 mt-3 [overflow-wrap:anywhere] text-xs font-semibold text-muted">
        {snapshot.source} snapshot captured {formatDate(snapshot.capturedAt)} for{" "}
        {snapshot.saleOfferId}
      </p>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-bold uppercase text-muted">{label}</dt>
      <dd className="m-0 mt-1 [overflow-wrap:anywhere] text-base font-bold text-ink">{value}</dd>
    </div>
  );
}

function PaginationControls({ history }: { history: RunHistoryListResponse }) {
  const hasPrevious = history.page > 1;
  const hasNext = history.page * history.pageSize < history.totalCount;

  return (
    <nav className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-4">
      <p className="m-0 text-sm font-semibold text-muted-strong">
        Page {history.page} · {formatNumber(history.totalCount)} summaries
      </p>
      <div className="flex gap-2">
        <PaginationLink disabled={!hasPrevious} page={history.page - 1}>
          Previous
        </PaginationLink>
        <PaginationLink disabled={!hasNext} page={history.page + 1}>
          Next
        </PaginationLink>
      </div>
    </nav>
  );
}

function PaginationLink({
  children,
  disabled,
  page,
}: {
  children: string;
  disabled: boolean;
  page: number;
}) {
  if (disabled) {
    return (
      <span className="inline-flex min-h-10 items-center rounded-lg border border-border px-3.5 py-2.5 text-sm font-semibold text-muted opacity-60">
        {children}
      </span>
    );
  }

  return (
    <Link
      className="inline-flex min-h-10 items-center rounded-lg border border-border px-3.5 py-2.5 text-sm font-semibold text-muted-strong"
      href={`/run-history?page=${page}`}
    >
      {children}
    </Link>
  );
}

function trafficDeliveryTone(
  status: RunHistorySummary["trafficDeliverySummary"]["trafficDeliveryStatus"],
) {
  if (status === "complete") {
    return "ok";
  }

  if (status === "failed") {
    return "blocked";
  }

  return "pending";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
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

function nullableMs(value: number | undefined): string {
  return value === undefined ? "n/a" : `${formatNumber(value)}ms`;
}
