import {
  type BusinessOutcomeSummary,
  businessOutcomeSummarySchema,
  type ConsistencyLagSummary,
  consistencyLagSummarySchema,
  type DownstreamErpStatus,
  type ErpCumulativeOutcomeCounts,
} from "@checkout-surge/contracts";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { CheckoutSurgeDatabase } from "./client.js";
import {
  demoRunSoldOutCounts,
  erpAttempts,
  erpScopeResilienceState,
  orderRecoveryJobs,
  orders,
  reservationPendingPersistence,
  reservations,
  simulatedNotifications,
} from "./schema.js";

export interface BusinessOutcomeProjectionScope {
  saleOfferId: string;
  runId: string;
}

export async function readCumulativeErpOutcomeCounts(
  db: CheckoutSurgeDatabase,
  scope: { runId: string },
): Promise<ErpCumulativeOutcomeCounts> {
  const orderFilter = eq(orders.runId, scope.runId);
  const [row] = await db
    .select({
      capacityRejected: sumAttemptCount("capacity_rejected"),
      temporarilyUnavailable: sumAttemptCount("temporarily_unavailable"),
      uncertainResult: sumAttemptCount("uncertain_result"),
    })
    .from(orderRecoveryJobs)
    .innerJoin(orders, eq(orders.id, orderRecoveryJobs.orderId))
    .where(orderFilter);

  return {
    capacityRejected: row?.capacityRejected ?? 0,
    temporarilyUnavailable: row?.temporarilyUnavailable ?? 0,
    uncertainResult: row?.uncertainResult ?? 0,
  };
}

export async function readBusinessOutcomeSummary(
  db: CheckoutSurgeDatabase,
  scope: BusinessOutcomeProjectionScope,
): Promise<BusinessOutcomeSummary> {
  const reservationFilter = eq(reservations.runId, scope.runId);
  const orderFilter = eq(orders.runId, scope.runId);
  const pendingFilter = eq(reservationPendingPersistence.runId, scope.runId);
  const notificationFilter = eq(simulatedNotifications.runId, scope.runId);

  const [
    acceptedReservations,
    reservedUnits,
    soldOutRejections,
    queuedOrders,
    processingOrders,
    retryingOrders,
    confirmedOrders,
    failedOrders,
    pendingPersistenceCount,
    notificationsRecorded,
  ] = await Promise.all([
    countRows(db, reservations, reservationFilter),
    db
      .select({ total: sql<number>`coalesce(sum(${reservations.quantity}), 0)::int` })
      .from(reservations)
      .where(reservationFilter)
      .then((rows) => rows[0]?.total ?? 0),
    readSoldOutRejections(db, scope.runId),
    countRows(db, orders, and(orderFilter, eq(orders.status, "queued"))),
    countRows(db, orders, and(orderFilter, eq(orders.status, "processing"))),
    countRetryingOrders(db, orderFilter),
    countRows(db, orders, and(orderFilter, eq(orders.status, "confirmed"))),
    countRows(db, orders, and(orderFilter, eq(orders.status, "failed"))),
    countRows(
      db,
      reservationPendingPersistence,
      and(
        pendingFilter,
        inArray(reservationPendingPersistence.status, ["pending_reconciliation", "exhausted"]),
      ),
    ),
    countRows(db, simulatedNotifications, notificationFilter),
  ]);

  return businessOutcomeSummarySchema.parse({
    acceptedReservations,
    reservedUnits,
    soldOutRejections,
    queuedOrders,
    processingOrders,
    retryingOrders,
    confirmedOrders,
    failedOrders,
    pendingPersistenceCount,
    notificationsRecorded,
  });
}

export async function readConsistencyLagSummary(
  db: CheckoutSurgeDatabase,
  scope: BusinessOutcomeProjectionScope,
  measuredAt: Date = new Date(),
): Promise<ConsistencyLagSummary> {
  const orderFilter = eq(orders.runId, scope.runId);

  const [confirmedRow, pendingRow] = await Promise.all([
    db
      .select({
        confirmedOrderCount: sql<number>`count(*)::int`,
        averageLagMs: sql<
          number | null
        >`avg(extract(epoch from (${orders.confirmedAt} - ${reservations.securedAt})) * 1000)`,
        p95LagMs: sql<
          number | null
        >`percentile_cont(0.95) within group (order by extract(epoch from (${orders.confirmedAt} - ${reservations.securedAt})) * 1000)`,
        maxLagMs: sql<
          number | null
        >`max(extract(epoch from (${orders.confirmedAt} - ${reservations.securedAt})) * 1000)`,
      })
      .from(orders)
      .innerJoin(reservations, eq(reservations.id, orders.reservationId))
      .where(
        and(orderFilter, eq(orders.status, "confirmed"), sql`${orders.confirmedAt} is not null`),
      ),
    db
      .select({
        pendingConfirmationCount: sql<number>`count(*)::int`,
        oldestPendingSecuredAt: sql<Date | null>`min(${reservations.securedAt})`,
      })
      .from(orders)
      .innerJoin(reservations, eq(reservations.id, orders.reservationId))
      .where(and(orderFilter, inArray(orders.status, ["queued", "processing"]))),
  ]);

  const oldestPendingSecuredAt = toDateOrNull(pendingRow[0]?.oldestPendingSecuredAt ?? null);

  return consistencyLagSummarySchema.parse({
    confirmedOrderCount: confirmedRow[0]?.confirmedOrderCount ?? 0,
    pendingConfirmationCount: pendingRow[0]?.pendingConfirmationCount ?? 0,
    averageLagMs: clampNonnegative(toNumberOrNull(confirmedRow[0]?.averageLagMs ?? null)),
    p95LagMs: clampNonnegative(toNumberOrNull(confirmedRow[0]?.p95LagMs ?? null)),
    maxLagMs: clampNonnegative(toNumberOrNull(confirmedRow[0]?.maxLagMs ?? null)),
    oldestPendingAgeSeconds: oldestPendingSecuredAt
      ? elapsedSeconds(oldestPendingSecuredAt, measuredAt)
      : null,
    measuredAt: measuredAt.toISOString(),
  });
}

/**
 * Runtime-progress read model for one run, read from the same durable
 * order records as the business-outcome and lag projections. `processingStartedAt`
 * is the earliest moment one of the run's orders entered processing; it bounds
 * the confirmation-rate window so a run that started processing moments ago is
 * not divided by the full stated window.
 */
export interface RunRuntimeProgressReadModel {
  outstandingOrders: number;
  oldestOutstandingAgeSeconds: number | null;
  confirmedOrdersInWindow: number;
  processingStartedAt: Date | null;
}

export async function readRunRuntimeProgress(
  db: CheckoutSurgeDatabase,
  scope: { runId: string },
  windowStartedAt: Date,
  measuredAt: Date = new Date(),
): Promise<RunRuntimeProgressReadModel> {
  const orderFilter = eq(orders.runId, scope.runId);

  const [outstandingRow, windowRow] = await Promise.all([
    db
      .select({
        outstandingOrders: sql<number>`count(*)::int`,
        oldestOutstandingSecuredAt: sql<Date | null>`min(${reservations.securedAt})`,
      })
      .from(orders)
      .innerJoin(reservations, eq(reservations.id, orders.reservationId))
      .where(and(orderFilter, inArray(orders.status, ["queued", "processing"]))),
    db
      .select({
        confirmedOrdersInWindow: sql<number>`(count(*) filter (
          where ${orders.status} = 'confirmed' and ${orders.confirmedAt} >= ${windowStartedAt.toISOString()}::timestamptz
            and ${orders.confirmedAt} <= ${measuredAt.toISOString()}::timestamptz
        ))::int`,
        processingStartedAt: sql<Date | null>`min(${orders.processingAt})`,
      })
      .from(orders)
      .where(orderFilter),
  ]);

  const oldestOutstandingSecuredAt = toDateOrNull(
    outstandingRow[0]?.oldestOutstandingSecuredAt ?? null,
  );

  return {
    outstandingOrders: outstandingRow[0]?.outstandingOrders ?? 0,
    oldestOutstandingAgeSeconds: oldestOutstandingSecuredAt
      ? elapsedSeconds(oldestOutstandingSecuredAt, measuredAt)
      : null,
    confirmedOrdersInWindow: windowRow[0]?.confirmedOrdersInWindow ?? 0,
    processingStartedAt: toDateOrNull(windowRow[0]?.processingStartedAt ?? null),
  };
}

/**
 * One downstream status for the run scope, derived read-only from the worker's
 * durable safety authority (`erp_scope_resilience_state`, scope `run:<id>`):
 * `erp_unavailable` while the availability circuit is open with an unexpired
 * availability retry, circuit expiry, or next-probe deadline (the worker restore
 * predicate), else `erp_limiting` while a capacity cooldown is still
 * in the future, else `nominal`. Exposes the status only — no cooldown times,
 * circuit detail, or probe schedules.
 */
export async function readDownstreamErpStatus(
  db: CheckoutSurgeDatabase,
  runId: string,
  now: Date = new Date(),
): Promise<DownstreamErpStatus> {
  const [row] = await db
    .select({
      cooldownExpiresAt: erpScopeResilienceState.cooldownExpiresAt,
      availabilityCircuitOpen: erpScopeResilienceState.availabilityCircuitOpen,
      circuitOpenExpiresAt: erpScopeResilienceState.circuitOpenExpiresAt,
      availabilityRetryAt: erpScopeResilienceState.availabilityRetryAt,
      nextProbeAt: erpScopeResilienceState.nextProbeAt,
    })
    .from(erpScopeResilienceState)
    .where(eq(erpScopeResilienceState.scope, `run:${runId}`))
    .limit(1);

  if (!row) return "nominal";
  if (
    row.availabilityCircuitOpen &&
    Math.max(
      row.availabilityRetryAt?.getTime() ?? 0,
      row.circuitOpenExpiresAt?.getTime() ?? 0,
      row.nextProbeAt?.getTime() ?? 0,
    ) > now.getTime()
  ) {
    return "erp_unavailable";
  }
  if (row.cooldownExpiresAt !== null && row.cooldownExpiresAt > now) {
    return "erp_limiting";
  }
  return "nominal";
}

async function countRows(
  db: CheckoutSurgeDatabase,
  table:
    | typeof reservations
    | typeof orders
    | typeof reservationPendingPersistence
    | typeof simulatedNotifications,
  where: SQL<unknown> | undefined,
): Promise<number> {
  const [row] = await db.select({ value: sql<number>`count(*)::int` }).from(table).where(where);

  return row?.value ?? 0;
}

function sumAttemptCount(category: string) {
  return sql<number>`coalesce(sum(coalesce((${orderRecoveryJobs.attemptCounts} ->> ${category})::int, 0)), 0)::int`;
}

function clampNonnegative(value: number | null): number | null {
  if (value === null) {
    return null;
  }

  return Math.max(0, value);
}

function toNumberOrNull(value: number | string | null): number | null {
  if (value === null) {
    return null;
  }

  return Number(value);
}

function toDateOrNull(value: Date | string | null): Date | null {
  if (value === null) {
    return null;
  }

  return value instanceof Date ? value : new Date(value);
}

function elapsedSeconds(startedAt: Date, finishedAt: Date): number {
  return Math.max(0, (finishedAt.getTime() - startedAt.getTime()) / 1000);
}

async function countRetryingOrders(
  db: CheckoutSurgeDatabase,
  orderFilter: ReturnType<typeof eq>,
): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(distinct ${orders.id})::int` })
    .from(orders)
    .innerJoin(erpAttempts, eq(erpAttempts.orderId, orders.id))
    .where(
      and(
        orderFilter,
        eq(orders.status, "processing"),
        inArray(erpAttempts.status, ["failed", "timed_out"]),
      ),
    );

  return row?.value ?? 0;
}

async function readSoldOutRejections(db: CheckoutSurgeDatabase, runId: string): Promise<number> {
  const [row] = await db
    .select({ value: demoRunSoldOutCounts.count })
    .from(demoRunSoldOutCounts)
    .where(eq(demoRunSoldOutCounts.runId, runId))
    .limit(1);

  return row?.value ?? 0;
}
