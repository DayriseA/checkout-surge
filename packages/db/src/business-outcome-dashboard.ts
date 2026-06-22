import { randomUUID } from "node:crypto";
import {
  type BusinessOutcomeDashboardEvent,
  type BusinessOutcomeSummary,
  businessOutcomeSummarySchema,
} from "@checkout-surge/contracts";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { CheckoutSurgeDatabase } from "./client.js";
import type { CheckoutSurgeRedis } from "./redis.js";
import { publishDashboardEvent } from "./redis-dashboard-events.js";
import {
  demoRunReservationOutcomes,
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

export interface PublishBusinessOutcomeDashboardUpdateInput extends BusinessOutcomeProjectionScope {
  correlationId?: string;
  occurredAt?: Date;
  eventId?: string;
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
    countRows(db, reservations, and(reservationFilter, eq(reservations.status, "secured"))),
    readSoldOutRejections(db, scope.runId),
    countRows(db, orders, and(orderFilter, eq(orders.status, "queued"))),
    countRows(db, orders, and(orderFilter, eq(orders.status, "processing"))),
    countRetryingOrders(db, orderFilter),
    countRows(db, orders, and(orderFilter, eq(orders.status, "confirmed"))),
    countRows(db, orders, and(orderFilter, eq(orders.status, "failed"))),
    countRows(
      db,
      reservationPendingPersistence,
      and(pendingFilter, eq(reservationPendingPersistence.status, "pending_reconciliation")),
    ),
    countRows(
      db,
      simulatedNotifications,
      and(notificationFilter, eq(simulatedNotifications.status, "recorded")),
    ),
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

export async function publishBusinessOutcomeDashboardUpdate(
  db: CheckoutSurgeDatabase,
  redis: CheckoutSurgeRedis,
  input: PublishBusinessOutcomeDashboardUpdateInput,
): Promise<number> {
  const outcome = await readBusinessOutcomeSummary(db, input);
  const event: BusinessOutcomeDashboardEvent = {
    type: "business.outcome.updated",
    eventId: input.eventId ?? randomUUID(),
    saleOfferId: input.saleOfferId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    outcome,
  };

  return publishDashboardEvent(redis, event);
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
    .select({ value: demoRunReservationOutcomes.count })
    .from(demoRunReservationOutcomes)
    .where(
      and(
        eq(demoRunReservationOutcomes.runId, runId),
        eq(demoRunReservationOutcomes.outcome, "api_sold_out_decision"),
      ),
    )
    .limit(1);

  return row?.value ?? 0;
}
