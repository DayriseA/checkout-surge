import type { RunHistoryListItem, RunHistoryListResponse } from "@checkout-surge/contracts";
import Link from "next/link";
import { formatCount, formatDurationMs, formatInstantUtc } from "../lib/presentation/format";
import {
  publicVocabulary,
  runResultOutcomeLabel,
  runResultOutcomeTone,
} from "../lib/presentation/public-vocabulary";
import { formatRunCount } from "../lib/presentation/run-history-count";
import { neutralLinkButtonClassName } from "./control-styles";
import { RelativeTime } from "./relative-time";
import { RunHistoryDeleteAllButton } from "./run-history-delete-all-button";
import { RunHistoryRowControls } from "./run-history-row-controls";
import { StatusPill } from "./status-pill";

export function RunHistoryList({ history }: { history: RunHistoryListResponse }) {
  if (history.summaries.length === 0) {
    return history.totalCount > 0 ? (
      <OutOfRangePageState history={history} />
    ) : (
      <section className="rounded-lg border border-border bg-surface p-4">
        <p className="m-0 text-xs font-bold uppercase text-muted">Finished runs</p>
        <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">No runs yet</h2>
        <p className="m-0 mt-3 max-w-[66ch] text-sm leading-6 text-muted">
          Finished runs appear here after their final evidence is recorded.
        </p>
        <Link className={`${neutralLinkButtonClassName} mt-3`} href="/">
          Start a simulation
        </Link>
      </section>
    );
  }

  const hasMultiplePages = history.totalCount > history.pageSize;
  return (
    <div className="grid gap-3">
      <div className="rounded-lg border border-border bg-surface p-4">
        <p className="m-0 text-sm leading-6 text-muted">
          Convergence measures from the end of traffic dispatch until every reserved order reached a
          confirmed or failed outcome. Overall duration covers the entire run.
        </p>
      </div>
      {history.summaries.map((summary) => (
        <RunHistoryRow key={summary.runId} summary={summary} />
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <RunHistoryDeleteAllButton />
        {hasMultiplePages ? <PaginationControls history={history} /> : null}
      </div>
    </div>
  );
}

function RunHistoryRow({ summary }: { summary: RunHistoryListItem }) {
  return (
    <article className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 basis-full flex-1 sm:basis-auto">
          <h2 className="m-0 break-words text-lg font-bold leading-tight text-ink">
            {summary.presetName}
          </h2>
          <p className="m-0 mt-1 text-sm font-semibold text-muted-strong">
            {number(summary.plannedAttempts)} attempts · {number(summary.startingStock)} units
          </p>
          <time className="mt-1 block text-sm text-muted" dateTime={summary.occurredAt}>
            {formatInstantUtc(summary.occurredAt)}
            <RelativeTime instant={summary.occurredAt} />
          </time>
        </div>
        <div className="min-w-0 break-words">
          <p className="m-0 text-xs font-bold uppercase text-muted">Result</p>
          <StatusPill
            status={{
              label: runResultOutcomeLabel(summary.resultOutcome),
              tone: runResultOutcomeTone(summary.resultOutcome),
            }}
          />
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Link className={neutralLinkButtonClassName} href={`/run-history/${summary.runId}`}>
            View report{" "}
            <span className="sr-only">
              {" "}
              for {summary.presetName} run from{" "}
              {formatInstantUtc(summary.occurredAt) ?? summary.occurredAt}
            </span>
          </Link>
          <RunHistoryRowControls presetName={summary.presetName} runId={summary.runId} />
        </div>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Fact label="Confirmed orders" value={number(summary.confirmedOrders)} />
        <Fact label="Failed orders" value={number(summary.failedOrders)} />
        <Fact
          label="Overall duration"
          value={formatDurationMs(summary.overallDurationMs) ?? "not recorded"}
        />
      </div>
      <div className="mt-4 grid gap-4 border-t border-border pt-4 sm:grid-cols-3">
        <Fact
          label={publicVocabulary.uniqueReservationsSecured}
          value={number(summary.uniqueReservations)}
        />
        <Fact label="Sold-out rejections" value={number(summary.soldOutRejections)} />
        <Fact
          label="Convergence duration"
          value={
            summary.convergenceDurationSeconds === null
              ? "not recorded"
              : (formatDurationMs(summary.convergenceDurationSeconds * 1_000) ?? "not recorded")
          }
        />
      </div>
    </article>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="m-0 text-xs font-bold uppercase text-muted">{label}</p>
      <p className="m-0 mt-1 text-sm font-semibold text-ink">{value}</p>
    </div>
  );
}

function OutOfRangePageState({ history }: { history: RunHistoryListResponse }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <p className="m-0 text-xs font-bold uppercase text-muted">Finished runs</p>
      <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">
        Page {history.page} does not exist
      </h2>
      <p className="m-0 mt-3 text-sm text-muted">
        {formatRunCount(history.totalCount)} {history.totalCount === 1 ? "exists" : "exist"}. Return
        to page 1 to view the latest runs.
      </p>
      <Link className={`${neutralLinkButtonClassName} mt-3`} href="/run-history">
        View page 1
      </Link>
    </section>
  );
}

function PaginationControls({ history }: { history: RunHistoryListResponse }) {
  const hasPrevious = history.page > 1;
  const hasNext = history.page * history.pageSize < history.totalCount;
  return (
    <nav
      aria-label="Run history pages"
      className="ml-auto flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3"
    >
      <p className="m-0 text-sm font-semibold text-muted-strong">
        Page {history.page} · {formatRunCount(history.totalCount)}
      </p>
      {hasPrevious ? <PaginationLink page={history.page - 1}>Previous</PaginationLink> : null}
      {hasNext ? <PaginationLink page={history.page + 1}>Next</PaginationLink> : null}
    </nav>
  );
}

function PaginationLink({ children, page }: { children: string; page: number }) {
  return (
    <Link className={neutralLinkButtonClassName} href={`/run-history?page=${page}`}>
      {children}
    </Link>
  );
}

function number(value: number): string {
  return formatCount(value) ?? "not recorded";
}
