import {
  type BusinessOutcomeSummary,
  businessOutcomeSummarySchema,
  type CompletionOutcome,
  type ConsistencyLagSummary,
  completionOutcomeSchema,
  consistencyLagSummarySchema,
} from "@checkout-surge/contracts";
import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { CheckoutSurgeDatabase } from "./client.js";
import {
  demoRunSoldOutCounts,
  erpAttempts,
  orders,
  reservationPendingPersistence,
  reservations,
  simulatedNotifications,
} from "./schema.js";

export interface BusinessOutcomeProjectionScope {
  saleOfferId: string;
  runId?: string;
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

const delayedOutcomeThresholdMs = 5_000;

export async function readRecentCompletionOutcomes(
  db: CheckoutSurgeDatabase,
  scope: BusinessOutcomeProjectionScope,
  options: { limit?: number; now?: Date } = {},
): Promise<CompletionOutcome[]> {
  const limit = options.limit ?? 8;
  const measuredAt = options.now ?? new Date();
  const orderFilter = scope.runId
    ? eq(orders.runId, scope.runId)
    : eq(orders.saleOfferId, scope.saleOfferId);

  const latestNotification = db
    .select({
      id: simulatedNotifications.id,
      recordedAt: simulatedNotifications.recordedAt,
    })
    .from(simulatedNotifications)
    .where(eq(simulatedNotifications.orderId, orders.id))
    .orderBy(desc(simulatedNotifications.recordedAt), desc(simulatedNotifications.id))
    .limit(1)
    .as("latest_completion_notification");
  const latestAttempt = db
    .select({
      id: erpAttempts.id,
      status: erpAttempts.status,
      errorCode: erpAttempts.errorCode,
    })
    .from(erpAttempts)
    .where(eq(erpAttempts.orderId, orders.id))
    .orderBy(desc(erpAttempts.startedAt), desc(erpAttempts.createdAt), desc(erpAttempts.id))
    .limit(1)
    .as("latest_completion_erp_attempt");

  const rows = await db
    .select({
      order: orders,
      notificationId: latestNotification.id,
      notificationRecordedAt: latestNotification.recordedAt,
      attemptId: latestAttempt.id,
      attemptStatus: latestAttempt.status,
      attemptErrorCode: latestAttempt.errorCode,
    })
    .from(orders)
    .leftJoinLateral(latestNotification, sql`true`)
    .leftJoinLateral(latestAttempt, sql`true`)
    .where(orderFilter)
    .orderBy(
      desc(
        sql`coalesce(${orders.confirmedAt}, ${orders.failedAt}, ${orders.processingAt}, ${orders.queuedAt})`,
      ),
    )
    .limit(limit);

  return rows.map((row) => {
    const order = row.order;
    const notification =
      order.status === "confirmed" && row.notificationId && row.notificationRecordedAt
        ? {
            id: row.notificationId,
            recordedAt: row.notificationRecordedAt,
          }
        : null;
    const attempt =
      row.attemptId && row.attemptStatus
        ? {
            id: row.attemptId,
            status: row.attemptStatus,
            errorCode: row.attemptErrorCode,
          }
        : null;
    const latestEventAt =
      notification?.recordedAt ??
      order.confirmedAt ??
      order.failedAt ??
      order.processingAt ??
      order.queuedAt;

    return completionOutcomeSchema.parse({
      orderId: order.id,
      publicOrderId: order.publicOrderId,
      saleOfferId: order.saleOfferId,
      ...(order.runId ? { runId: order.runId } : {}),
      correlationId: order.correlationId,
      orderStatus: order.status,
      displayStatus: deriveCompletionOutcomeStatus(order, attempt, notification, measuredAt),
      queuedAt: order.queuedAt.toISOString(),
      ...(order.processingAt ? { processingAt: order.processingAt.toISOString() } : {}),
      ...(order.confirmedAt ? { confirmedAt: order.confirmedAt.toISOString() } : {}),
      ...(order.failedAt ? { failedAt: order.failedAt.toISOString() } : {}),
      ...(notification ? { notificationRecordedAt: notification.recordedAt.toISOString() } : {}),
      ...(attempt ? { latestErpAttemptStatus: attempt.status } : {}),
      ...(attempt?.errorCode ? { latestErpErrorCode: attempt.errorCode } : {}),
      latestEventAt: latestEventAt.toISOString(),
    });
  });
}

function deriveCompletionOutcomeStatus(
  order: typeof orders.$inferSelect,
  latestAttempt: Pick<typeof erpAttempts.$inferSelect, "id" | "status" | "errorCode"> | null,
  latestNotification: Pick<typeof simulatedNotifications.$inferSelect, "id" | "recordedAt"> | null,
  measuredAt: Date,
): CompletionOutcome["displayStatus"] {
  if (latestNotification) {
    return "notification_recorded";
  }
  if (order.status === "confirmed") {
    return "confirmed";
  }
  if (order.status === "failed") {
    return "failed";
  }
  if (latestAttempt && ["failed", "timed_out"].includes(latestAttempt.status)) {
    return "retrying";
  }

  const waitingSince = order.processingAt ?? order.queuedAt;
  if (measuredAt.getTime() - waitingSince.getTime() >= delayedOutcomeThresholdMs) {
    return "delayed";
  }

  return order.status;
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
