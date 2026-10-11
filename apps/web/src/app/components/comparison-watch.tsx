"use client";

import type {
  ComparisonDetailResponse,
  ComparisonStage,
  DashboardProjection,
} from "@checkout-surge/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { BackendRead } from "../lib/api";
import {
  comparisonProgress,
  comparisonStageEvidence,
  comparisonStageLabels,
} from "../lib/presentation/comparison";
import { formatCount, formatDurationMs, formatInstantUtc } from "../lib/presentation/format";
import { runResultOutcomeLabel } from "../lib/presentation/public-vocabulary";
import { neutralLinkButtonClassName, textLinkClassName } from "./control-styles";
import { useComparison } from "./realtime/use-comparison";
import { useDashboardProjections } from "./realtime/use-dashboard-projections";

export function ComparisonWatch({
  comparisonId,
  initialRead,
}: {
  comparisonId: string;
  initialRead: BackendRead<ComparisonDetailResponse>;
}) {
  const { detail, unavailable, notFound, refreshing, retriesExhausted, retryScheduled, refresh } =
    useComparison(comparisonId, initialRead);
  if (notFound)
    return (
      <section className="rounded-2xl border border-border bg-surface p-5">
        <h1 className="type-title m-0 text-xl">This comparison could not be found</h1>
        <p>
          The saved report may have been removed from run history. There is no report to check
          again.
        </p>
        <div className="flex gap-4">
          <Link className={textLinkClassName} href="/run-history">
            Run history
          </Link>
          <Link className={textLinkClassName} href="/demo">
            Back to the demo
          </Link>
        </div>
      </section>
    );
  const current = detail?.stages[detail.currentStage];
  const liveChild =
    detail?.state === "running" &&
    current?.availability === "pending" &&
    current.run.status !== "completed" &&
    current.run.status !== "failed"
      ? current
      : null;
  return (
    <div className="grid gap-5">
      <header>
        <h1 className="type-display m-0 text-[clamp(2rem,4vw,2.75rem)] text-ink">
          {detail?.state === "completed"
            ? "Comparison results"
            : "Redis and order queue comparison"}
        </h1>
        <p aria-live="polite" className="mt-2 leading-6 text-muted-strong">
          {detail
            ? comparisonProgress(detail)
            : unavailable
              ? "The comparison is temporarily unavailable."
              : "Loading your comparison…"}
        </p>
        {detail ? (
          <p className="text-sm text-muted">
            Started {formatInstantUtc(detail.acceptedAt)} · Simulated buyers and orders.
          </p>
        ) : null}
        <Link className={textLinkClassName} href={`/comparisons/${comparisonId}`}>
          Saved comparison report
        </Link>
      </header>
      {unavailable ? (
        <section
          aria-live="polite"
          role="status"
          className="rounded-xl border border-warning-line bg-warning-soft p-4"
        >
          <p className="m-0">
            {detail
              ? "These are the last results we received. Updates are temporarily unavailable."
              : "We could not load this comparison."}
          </p>
          <p className="mb-0 mt-1 text-sm">
            {retriesExhausted ? "Automatic checks have stopped." : "We will check again shortly."}
          </p>
          {!retryScheduled ? (
            <button
              className={`${neutralLinkButtonClassName} mt-2`}
              disabled={refreshing}
              onClick={refresh}
              type="button"
            >
              Check again
            </button>
          ) : null}
        </section>
      ) : null}
      {liveChild ? (
        <ComparisonLiveChild
          key={liveChild.runId}
          comparisonId={comparisonId}
          runId={liveChild.runId}
        />
      ) : null}
      {detail ? <ComparisonReport detail={detail} /> : null}
      <div className="flex gap-4">
        <Link className={textLinkClassName} href="/run-history">
          Run history
        </Link>
        <Link className={textLinkClassName} href="/demo">
          Back to the demo
        </Link>
      </div>
    </div>
  );
}

function ComparisonLiveChild({ comparisonId, runId }: { comparisonId: string; runId: string }) {
  const [projection, setProjection] = useState<DashboardProjection | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const terminal =
    projection?.currentRun?.status === "completed" || projection?.currentRun?.status === "failed";
  const business = projection?.businessOutcome;
  return (
    <section
      aria-label="Current simulation"
      className="rounded-2xl border border-border bg-surface p-5"
    >
      {!terminal ? (
        <ComparisonChildTransport
          comparisonId={comparisonId}
          runId={runId}
          onProjection={(next) =>
            setProjection((previous) =>
              previous && previous.revision >= next.revision ? previous : next,
            )
          }
          onConnectionChange={setDisconnected}
        />
      ) : null}
      <h2 className="type-title m-0 text-lg">Current simulation</h2>
      <p className="mt-2 text-sm text-muted">
        {projection
          ? `Last live update: ${formatInstantUtc(projection.recoveredAt)}`
          : "Waiting for live measurements…"}
      </p>
      {disconnected && !terminal ? (
        <p role="status" className="text-sm text-muted">
          Live updates are unavailable. Comparison progress is still being checked.
        </p>
      ) : null}
      {business ? (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <ComparisonFact
            label="Orders reserved"
            value={formatCount(business.acceptedReservations) ?? "Not recorded"}
          />
          <ComparisonFact
            label="Orders confirmed"
            value={formatCount(business.confirmedOrders) ?? "Not recorded"}
          />
          <ComparisonFact
            label="Orders failed"
            value={formatCount(business.failedOrders) ?? "Not recorded"}
          />
          <ComparisonFact
            label="Awaiting confirmation"
            value={formatCount(business.queuedOrders + business.processingOrders) ?? "Not recorded"}
          />
        </dl>
      ) : null}
    </section>
  );
}

function ComparisonChildTransport({
  comparisonId,
  runId,
  onProjection,
  onConnectionChange,
}: {
  comparisonId: string;
  runId: string;
  onProjection: (projection: DashboardProjection) => void;
  onConnectionChange: (disconnected: boolean) => void;
}) {
  const { status } = useDashboardProjections({
    onProjection: (next) => {
      if (next.currentRun?.runId === runId && next.currentRun.comparisonId === comparisonId)
        onProjection(next);
    },
    onOpen: () => onConnectionChange(false),
    onDisconnect: () => onConnectionChange(true),
  });
  useEffect(
    () => onConnectionChange(status === "disconnected" || status === "unsupported"),
    [status, onConnectionChange],
  );
  return null;
}

export function ComparisonReport({ detail }: { detail: ComparisonDetailResponse }) {
  return (
    <div className="grid gap-5">
      <p className="m-0 max-w-[80ch] text-sm leading-6 text-muted-strong">
        Within each pair, the buyer workload, stock, and simulated order processor use the same
        settings. The two pairs test different workloads.
      </p>
      <ComparisonPair
        title="Stock checks"
        explanation="Redis answers sold-out buyers without asking PostgreSQL."
        cohort="sold-out"
        stages={[detail.stages[0], detail.stages[1]]}
      />
      <ComparisonPair
        title="Order processing"
        explanation="An order queue lets buyers hear the answer while processing continues. It does not make the simulated order processor faster."
        cohort="accepted"
        stages={[detail.stages[2], detail.stages[3]]}
      />
    </div>
  );
}

function ComparisonPair({
  title,
  explanation,
  cohort,
  stages,
}: {
  title: string;
  explanation: string;
  cohort: "sold-out" | "accepted";
  stages: [ComparisonStage, ComparisonStage];
}) {
  return (
    <section aria-label={title} className="rounded-2xl border border-border bg-surface p-5">
      <h2 className="type-title m-0 text-xl text-ink">{title}</h2>
      <p className="mt-2 max-w-[80ch] leading-6 text-muted-strong">{explanation}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {stages.map((stage) => {
          const evidence = comparisonStageEvidence(stage);
          const timing = evidence?.timing;
          const result = evidence?.result;
          const status =
            stage.availability === "not_run"
              ? "Not run"
              : stage.availability === "unavailable"
                ? "Report unavailable"
                : stage.availability === "pending"
                  ? "Result not ready yet"
                  : stage.detail.summary.dataDiscarded
                    ? "Cancelled"
                    : runResultOutcomeLabel(stage.detail.result.outcome);
          return (
            <article key={stage.runId} className="rounded-xl bg-surface-muted p-4">
              <h3 className="type-title m-0 text-base">{comparisonStageLabels[stage.role]}</h3>
              <p className="mt-1 text-sm text-muted">{status}</p>
              <dl className="grid gap-3">
                <ComparisonFact
                  label={`95% of ${cohort} replies arrived within`}
                  value={
                    timing ? (formatDurationMs(timing.p95Ms) ?? "Not recorded") : "Not recorded"
                  }
                />
                <ComparisonFact
                  label="Recorded replies"
                  value={formatCount(timing?.sampleCount) ?? "Not recorded"}
                />
                <ComparisonFact
                  label="Orders reserved"
                  value={formatCount(result?.uniqueReservations) ?? "Not recorded"}
                />
                <ComparisonFact
                  label="Orders confirmed"
                  value={formatCount(result?.confirmedOrders) ?? "Not recorded"}
                />
                <ComparisonFact
                  label="Orders failed"
                  value={formatCount(result?.failedOrders) ?? "Not recorded"}
                />
                <ComparisonFact
                  label="Awaiting confirmation"
                  value={formatCount(result?.pendingOrders) ?? "Not recorded"}
                />
              </dl>
              <Link className={`${textLinkClassName} text-sm`} href={`/run-history/${stage.runId}`}>
                View this simulation’s report
              </Link>
            </article>
          );
        })}
      </div>
      {cohort === "accepted" ? (
        <p className="mb-0 mt-3 text-sm text-muted">
          Accepted replies can include repeat requests. Orders reserved counts unique orders.
        </p>
      ) : null}
    </section>
  );
}

function ComparisonFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="m-0 mt-1 font-semibold text-ink">{value}</dd>
    </div>
  );
}
