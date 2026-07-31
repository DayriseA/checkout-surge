import {
  confirmationLagBoundary,
  queueBacklogDefinition,
  queueBacklogDrainDurationBoundary,
  type RunSignalTimelineSummary,
  runSignalBucketCount,
  runSignalBucketElapsedSeconds,
  runSignalTimelineSummarySchema,
} from "@checkout-surge/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { readConsistencyLagSummary } from "./business-outcome-dashboard.js";
import type { CheckoutSurgeDatabase } from "./client.js";
import { orders, reservations, saleOffers } from "./schema.js";

export interface RunSignalTimelineScope {
  runId: string;
  saleOfferId: string;
}

export interface RunSignalTimelineWindow {
  firstAttemptStartedAt: string | null;
  dispatchDurationSeconds: number;
  peakArrivalWindowSeconds: number;
  capturedAt: Date;
}

type BacklogSummaryRow = {
  peakBacklog: number;
  peakAt: Date | string | null;
  backlogDrainedAt: Date | string | null;
};

type DepletionRow = { depletedAt: Date | string | null };
type SeriesRow = {
  bucketIndex: number;
  remainingStock: number;
  backlog: number;
  cumulativeConfirmedOrderCount: number;
  cumulativeSettledOrderCount: number;
};

/**
 * The anchor is observed by k6 while the derived facts are PostgreSQL rows.
 * Both processes share the host kernel clock in this deployment. Discovering
 * the anchor from reservations would hide arrivals before the first hold.
 * The terminal boundary is the later of dispatch completion or retained
 * reservation/order activity; it is not necessarily a settled outcome.
 */
export async function readRunSignalTimeline(
  db: CheckoutSurgeDatabase,
  scope: RunSignalTimelineScope,
  window: RunSignalTimelineWindow,
): Promise<RunSignalTimelineSummary | null> {
  if (window.firstAttemptStartedAt === null) return null;
  const anchoredAt = new Date(window.firstAttemptStartedAt);
  const dispatchEndedAt = new Date(
    anchoredAt.getTime() + Math.max(0, window.dispatchDurationSeconds) * 1_000,
  );
  const orderFilter = eq(orders.runId, scope.runId);
  const reservationFilter = eq(reservations.runId, scope.runId);

  const [offerRows, reservationRows, orderRows, lag, backlogRows, depletionRows] =
    await Promise.all([
      db
        .select({ startingStock: saleOffers.allocatedStock })
        .from(saleOffers)
        .where(eq(saleOffers.id, scope.saleOfferId))
        .limit(1),
      db
        .select({
          acceptedUnits: sql<number>`coalesce(sum(${reservations.quantity}), 0)::int`,
          latestSecuredAt: sql<Date | null>`max(${reservations.securedAt})`,
        })
        .from(reservations)
        .where(reservationFilter),
      db
        .select({
          confirmedOrderCount: sql<number>`(count(*) filter (where ${orders.status} = 'confirmed'))::int`,
          failedOrderCount: sql<number>`(count(*) filter (where ${orders.status} = 'failed'))::int`,
          pendingAtCaptureCount: sql<number>`(count(*) filter (where ${orders.status} in ('queued', 'processing')))::int`,
          latestActivityAt: sql<Date | null>`max(greatest(
            ${orders.queuedAt},
            coalesce(${orders.processingAt}, ${orders.queuedAt}),
            coalesce(${orders.confirmedAt}, ${orders.queuedAt}),
            coalesce(${orders.failedAt}, ${orders.queuedAt})
          ))`,
          lastSettledAt: sql<Date | null>`max(coalesce(${orders.confirmedAt}, ${orders.failedAt}))`,
        })
        .from(orders)
        .where(orderFilter),
      readConsistencyLagSummary(db, scope, window.capturedAt),
      db.execute<BacklogSummaryRow>(sql`
        with event_deltas as (
          select event_at, sum(delta)::int as delta
          from (
            select ${orders.queuedAt} as event_at, 1 as delta
            from ${orders}
            where ${orders.runId} = ${scope.runId}
            union all
            select ${orders.processingAt} as event_at, -1 as delta
            from ${orders}
            where ${orders.runId} = ${scope.runId} and ${orders.processingAt} is not null
          ) events
          group by event_at
        ),
        backlog as (
          select event_at, sum(delta) over (order by event_at)::int as value
          from event_deltas
        )
        select
          coalesce(max(value), 0)::int as "peakBacklog",
          (select event_at from backlog order by value desc, event_at asc limit 1) as "peakAt",
          case
            when coalesce((select value from backlog order by event_at desc limit 1), 0) = 0
              then (select event_at from backlog where value = 0 order by event_at desc limit 1)
            else null
          end as "backlogDrainedAt"
        from backlog
      `),
      db.execute<DepletionRow>(sql`
        with cumulative_reservations as (
          select
            ${reservations.securedAt} as secured_at,
            sum(${reservations.quantity}) over (
              order by ${reservations.securedAt}, ${reservations.id}
            ) as accepted_units
          from ${reservations}
          where ${reservations.runId} = ${scope.runId}
        )
        select min(secured_at) as "depletedAt"
        from cumulative_reservations
        where accepted_units >= (
          select ${saleOffers.allocatedStock}
          from ${saleOffers}
          where ${saleOffers.id} = ${scope.saleOfferId}
        )
      `),
    ]);

  const startingStock = offerRows[0]?.startingStock;
  if (startingStock === undefined) {
    throw new Error(`Sale offer ${scope.saleOfferId} was not found while deriving run signals.`);
  }
  const reservation = reservationRows[0];
  const order = orderRows[0];
  const latestActivityOrDispatchBoundary = latestDate([
    anchoredAt,
    dispatchEndedAt,
    reservation?.latestSecuredAt ?? null,
    order?.latestActivityAt ?? null,
  ]);
  const noRetainedActivityOrDispatchBoundaryAfterAnchor =
    latestActivityOrDispatchBoundary.getTime() === anchoredAt.getTime();
  const endedAt = noRetainedActivityOrDispatchBoundaryAfterAnchor
    ? new Date(anchoredAt.getTime() + window.peakArrivalWindowSeconds * 1_000)
    : latestActivityOrDispatchBoundary;
  const bucketWidthSeconds =
    (endedAt.getTime() - anchoredAt.getTime()) / 1_000 / runSignalBucketCount;

  const seriesRows = await db.execute<SeriesRow>(sql`
    with buckets as (
      select
        bucket_index,
        ${anchoredAt.toISOString()}::timestamptz
          + (${bucketWidthSeconds}::double precision * bucket_index) * interval '1 second'
          as bucket_ended_at
      from generate_series(1, ${runSignalBucketCount}::integer) as bucket_index
    )
    select
      bucket_index::int as "bucketIndex",
      greatest(
        ${startingStock} - (
          select coalesce(sum(${reservations.quantity}), 0)::int
          from ${reservations}
          where ${reservations.runId} = ${scope.runId}
            and ${reservations.securedAt} <= bucket_ended_at
        ),
        0
      )::int as "remainingStock",
      greatest(
        (
          select count(*)::int
          from ${orders}
          where ${orders.runId} = ${scope.runId}
            and ${orders.queuedAt} <= bucket_ended_at
        ) - (
          select count(*)::int
          from ${orders}
          where ${orders.runId} = ${scope.runId}
            and ${orders.processingAt} <= bucket_ended_at
        ),
        0
      )::int as backlog,
      (
        select count(*)::int
        from ${orders}
        where ${orders.runId} = ${scope.runId}
          and ${orders.confirmedAt} <= bucket_ended_at
      ) as "cumulativeConfirmedOrderCount",
      (
        select count(*)::int
        from ${orders}
        where ${orders.runId} = ${scope.runId}
          and (
            ${orders.confirmedAt} <= bucket_ended_at
            or ${orders.failedAt} <= bucket_ended_at
          )
      ) as "cumulativeSettledOrderCount"
    from buckets
    order by bucket_index
  `);

  const acceptedUnits = toNumber(reservation?.acceptedUnits ?? 0);
  const depletedAt = toDate(depletionRows[0]?.depletedAt ?? null);
  const backlog = backlogRows[0];
  const peakAt = toDate(backlog?.peakAt ?? null);
  const backlogDrainedAt = toDate(backlog?.backlogDrainedAt ?? null);
  const firstQueuedAt = await readFirstQueuedAt(db, scope.runId);
  const pendingAtCaptureCount = toNumber(order?.pendingAtCaptureCount ?? 0);
  const lastSettledAt = toDate(order?.lastSettledAt ?? null);

  return runSignalTimelineSummarySchema.parse({
    window: {
      anchoredAt: anchoredAt.toISOString(),
      endedAt: endedAt.toISOString(),
      bucketCount: runSignalBucketCount,
      bucketWidthSeconds,
    },
    inventoryDrain: {
      startingStock,
      remainingStock: Math.max(0, startingStock - acceptedUnits),
      depletedAt: depletedAt?.toISOString() ?? null,
      timeToDepletionSeconds: depletedAt ? elapsedSeconds(anchoredAt, depletedAt) : null,
      remainingStockSeries: seriesRows.map((row) => ({
        elapsedSeconds: runSignalBucketElapsedSeconds(
          toNumber(row.bucketIndex) - 1,
          bucketWidthSeconds,
        ),
        remainingStock: toNumber(row.remainingStock),
      })),
    },
    queueBacklog: {
      peakBacklog: toNumber(backlog?.peakBacklog ?? 0),
      peakAtElapsedSeconds: peakAt ? elapsedSeconds(anchoredAt, peakAt) : null,
      backlogDrainedAt: backlogDrainedAt?.toISOString() ?? null,
      drainDurationSeconds:
        firstQueuedAt && backlogDrainedAt ? elapsedSeconds(firstQueuedAt, backlogDrainedAt) : null,
      drainDurationBoundary: queueBacklogDrainDurationBoundary,
      definition: queueBacklogDefinition,
      backlogSeries: seriesRows.map((row) => ({
        elapsedSeconds: runSignalBucketElapsedSeconds(
          toNumber(row.bucketIndex) - 1,
          bucketWidthSeconds,
        ),
        backlog: toNumber(row.backlog),
      })),
    },
    confirmationConvergence: {
      confirmedOrderCount: toNumber(order?.confirmedOrderCount ?? 0),
      failedOrderCount: toNumber(order?.failedOrderCount ?? 0),
      pendingAtCaptureCount,
      averageLagMs: lag.averageLagMs,
      p95LagMs: lag.p95LagMs,
      maxLagMs: lag.maxLagMs,
      boundary: confirmationLagBoundary,
      convergenceSeries: seriesRows.map((row) => ({
        elapsedSeconds: runSignalBucketElapsedSeconds(
          toNumber(row.bucketIndex) - 1,
          bucketWidthSeconds,
        ),
        cumulativeConfirmedOrderCount: toNumber(row.cumulativeConfirmedOrderCount),
        cumulativeSettledOrderCount: toNumber(row.cumulativeSettledOrderCount),
      })),
    },
    convergenceDurationSeconds:
      pendingAtCaptureCount === 0 && lastSettledAt
        ? elapsedSeconds(dispatchEndedAt, lastSettledAt)
        : null,
  });
}

async function readFirstQueuedAt(db: CheckoutSurgeDatabase, runId: string): Promise<Date | null> {
  const [row] = await db
    .select({ firstQueuedAt: sql<Date | null>`min(${orders.queuedAt})` })
    .from(orders)
    .where(
      and(
        eq(orders.runId, runId),
        inArray(orders.status, ["queued", "processing", "confirmed", "failed"]),
      ),
    );
  return toDate(row?.firstQueuedAt ?? null);
}

function elapsedSeconds(startedAt: Date, endedAt: Date): number {
  return Math.max(0, (endedAt.getTime() - startedAt.getTime()) / 1_000);
}

function latestDate(values: Array<Date | string | null>): Date {
  return values.reduce<Date>((latest, value) => {
    const candidate = toDate(value);
    return candidate && candidate.getTime() > latest.getTime() ? candidate : latest;
  }, new Date(0));
}

function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toNumber(value: number | string): number {
  return Number(value);
}
