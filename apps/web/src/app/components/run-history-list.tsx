import type { RunHistoryListItem, RunHistoryListResponse } from "@checkout-surge/contracts";
import Link from "next/link";
import { formatCount, formatDurationMs, formatInstantUtc } from "../lib/presentation/format";
import {
  publicVocabulary,
  runResultOutcomeLabel,
  runResultOutcomeTone,
} from "../lib/presentation/public-vocabulary";
import { formatRunCount } from "../lib/presentation/run-history-count";
import type { PresentationTone } from "../lib/presentation/run-presentation-state";
import { neutralLinkButtonClassName, primaryButtonClassName } from "./control-styles";
import { RelativeTime } from "./relative-time";
import { RunHistoryDeleteAllButton } from "./run-history-delete-all-button";
import { RunHistoryRowControls } from "./run-history-row-controls";
import { StatusPill } from "./status-pill";

export function RunHistoryList({ history }: { history: RunHistoryListResponse }) {
  if (history.summaries.length === 0) {
    return history.totalCount > 0 ? (
      <OutOfRangePageState history={history} />
    ) : (
      <section className="rounded-2xl border border-border bg-surface p-6">
        <p className="m-0 text-xs font-medium text-muted">Finished runs</p>
        <h2 className="type-title m-0 mt-0.5 text-lg leading-tight text-ink">No runs yet</h2>
        <p className="m-0 mt-3 max-w-[66ch] text-sm leading-6 text-muted">
          Finished runs appear here after their final evidence is recorded.
        </p>
        <Link className={`${primaryButtonClassName} mt-4`} href="/demo">
          Start a simulation
        </Link>
      </section>
    );
  }

  const hasMultiplePages = history.totalCount > history.pageSize;
  return (
    <div className="grid gap-2">
      <div className="px-1 pb-1">
        <p className="m-0 max-w-[90ch] text-sm leading-6 text-muted">
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

const resultStripeClassNames: Record<PresentationTone, string> = {
  danger: "before:bg-danger",
  idle: "before:bg-control-border",
  ok: "before:bg-ok",
  progress: "before:bg-info",
  warning: "before:bg-signal",
};

function RunHistoryRow({ summary }: { summary: RunHistoryListItem }) {
  const tone = summary.dataDiscarded ? "idle" : runResultOutcomeTone(summary.resultOutcome);
  return (
    <article
      className={`relative overflow-hidden rounded-xl border border-border bg-surface py-3.5 pl-6 pr-4 before:absolute before:inset-y-0 before:left-0 before:w-1 ${resultStripeClassNames[tone]}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 basis-full flex-1 sm:basis-auto">
          <h2 className="type-title m-0 break-words text-base leading-tight text-ink">
            {summary.presetName}
          </h2>
          <p className="m-0 mt-0.5 flex flex-wrap gap-x-3 text-sm text-muted">
            {!summary.dataDiscarded ? (
              <span className="font-medium text-muted-strong">
                {number(summary.plannedAttempts)} attempts · {number(summary.startingStock)} units
              </span>
            ) : null}
            <time dateTime={summary.occurredAt}>
              {formatInstantUtc(summary.occurredAt)}
              <RelativeTime instant={summary.occurredAt} />
            </time>
          </p>
        </div>
        <div className="min-w-0 break-words">
          <p className="sr-only">Result</p>
          <StatusPill
            status={
              summary.dataDiscarded
                ? { label: "Cancelled", tone: "idle" }
                : {
                    label: runResultOutcomeLabel(summary.resultOutcome),
                    tone: runResultOutcomeTone(summary.resultOutcome),
                  }
            }
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
      {!summary.dataDiscarded ? (
        <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-x-5 gap-y-3 border-t border-border pt-3">
          <div className="contents">
            <Fact label="Confirmed orders" value={number(summary.confirmedOrders)} />
            {summary.businessRejectedOrders === undefined ||
            summary.technicallyFailedOrders === undefined ? (
              <Fact label="Failed orders" value={number(summary.failedOrders)} />
            ) : (
              <>
                <Fact
                  label="Business-rejected orders"
                  value={number(summary.businessRejectedOrders)}
                />
                <Fact
                  label="Technically failed orders"
                  value={number(summary.technicallyFailedOrders)}
                />
              </>
            )}
            <Fact
              label="Overall duration"
              value={formatDurationMs(summary.overallDurationMs) ?? "not recorded"}
            />
          </div>
          <div className="contents">
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
        </div>
      ) : null}
    </article>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="m-0 text-xs text-muted">{label}</p>
      <p className="m-0 mt-0.5 text-sm font-semibold text-ink">{value}</p>
    </div>
  );
}

function OutOfRangePageState({ history }: { history: RunHistoryListResponse }) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-6">
      <p className="m-0 text-xs font-medium text-muted">Finished runs</p>
      <h2 className="type-title m-0 mt-0.5 text-lg leading-tight text-ink">
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
    <nav aria-label="Run history pages" className="ml-auto flex flex-wrap items-center gap-3">
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
