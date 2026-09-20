import {
  type BusinessOutcomeSummary,
  businessOutcomeSummarySchema,
  type ConsistencyLagSummary,
  consistencyLagSummarySchema,
  type ErpCumulativeOutcomeCounts,
} from "@checkout-surge/contracts";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { CheckoutSurgeDatabase } from "./client.js";
import {
  demoRunSoldOutCounts,
  erpAttempts,
  orderRecoveryJobs,
  orders,
  reservationPendingPersistence,
  reservations,
  simulatedNotifications,
} from "./schema.js";

export interface BusinessOutcomeProjectionScope {
  saleOfferId: string;
  runId?: string;
}

export async function readCumulativeErpOutcomeCounts(
  db: CheckoutSurgeDatabase,
  scope: { runId: string } | { saleOfferId: string },
): Promise<ErpCumulativeOutcomeCounts> {
  const orderFilter =
    "runId" in scope ? eq(orders.runId, scope.runId) : eq(orders.saleOfferId, scope.saleOfferId);
  const [row] = await db
    .select({
      capacityRejected: sumAttemptCount("capacity_rejected"),
      temporarilyUnavailable: sumAttemptCount("temporarily_unavailable"),
      uncertainResult: sumAttemptCount("uncertain_result"),
      permanentRejected: sumAttemptCount("permanent_rejection"),
    })
    .from(orderRecoveryJobs)
    .innerJoin(orders, eq(orders.id, orderRecoveryJobs.orderId))
    .where(orderFilter);

  return {
    capacityRejected: row?.capacityRejected ?? 0,
    temporarilyUnavailable: row?.temporarilyUnavailable ?? 0,
    uncertainResult: row?.uncertainResult ?? 0,
    permanentRejected: row?.permanentRejected ?? 0,
  };
}

export async function readBusinessOutcomeSummary(
  db: CheckoutSurgeDatabase,
  scope: BusinessOutcomeProjectionScope,
): Promise<BusinessOutcomeSummary> {
  const reservationFilter = scope.runId
    ? eq(reservations.runId, scope.runId)
    : eq(reservations.saleOfferId, scope.saleOfferId);
  const orderFilter = scope.runId
    ? eq(orders.runId, scope.runId)
    : eq(orders.saleOfferId, scope.saleOfferId);
  const pendingFilter = scope.runId
    ? eq(reservationPendingPersistence.runId, scope.runId)
    : eq(reservationPendingPersistence.saleOfferId, scope.saleOfferId);
  const notificationFilter = scope.runId
    ? eq(simulatedNotifications.runId, scope.runId)
    : eq(simulatedNotifications.saleOfferId, scope.saleOfferId);

  const [
    acceptedReservations,
    reservedUnits,
    soldOutRejections,
    queuedOrders,
    processingOrders,
    retryingOrders,
    confirmedOrders,
    failedOrders,
    businessRejectedOrders,
    technicallyFailedOrders,
    administrativelyDisposedOrders,
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
      orders,
      and(
        orderFilter,
        eq(orders.status, "failed"),
        eq(orders.failureCategory, "business_rejection"),
      ),
    ),
    countRows(
      db,
      orders,
      and(orderFilter, eq(orders.status, "failed"), eq(orders.failureCategory, "technical")),
    ),
    countRows(
      db,
      orders,
      and(orderFilter, eq(orders.status, "failed"), eq(orders.failureCategory, "administrative")),
    ),
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
    businessRejectedOrders,
    technicallyFailedOrders,
    administrativelyDisposedOrders,
    pendingPersistenceCount,
    notificationsRecorded,
  });
}

export async function readConsistencyLagSummary(
  db: CheckoutSurgeDatabase,
  scope: BusinessOutcomeProjectionScope,
  measuredAt: Date = new Date(),
): Promise<ConsistencyLagSummary> {
  const orderFilter = scope.runId
    ? eq(orders.runId, scope.runId)
    : eq(orders.saleOfferId, scope.saleOfferId);

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

async function readSoldOutRejections(
  db: CheckoutSurgeDatabase,
  runId: string | undefined,
): Promise<number> {
  if (!runId) {
    return 0;
  }

  const [row] = await db
    .select({ value: demoRunSoldOutCounts.count })
    .from(demoRunSoldOutCounts)
    .where(eq(demoRunSoldOutCounts.runId, runId))
    .limit(1);

  return row?.value ?? 0;
}
