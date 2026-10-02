import type { CheckoutSurgeDatabase } from "@checkout-surge/db";
import { demoRuns, orders, simulatedNotifications } from "@checkout-surge/db";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type {
  NotificationRecoveryPersistence,
  RecoverableNotificationOrder,
} from "../application/notification-recovery-scanner.js";

export class PostgresNotificationRecoveryPersistence implements NotificationRecoveryPersistence {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async findConfirmedOrdersMissingNotifications(input: {
    limit: number;
  }): Promise<RecoverableNotificationOrder[]> {
    const rows = await this.db
      .select({ order: orders })
      .from(orders)
      .leftJoin(simulatedNotifications, eq(simulatedNotifications.orderId, orders.id))
      .innerJoin(demoRuns, eq(demoRuns.id, orders.runId))
      .where(
        and(
          eq(orders.status, "confirmed"),
          isNotNull(orders.confirmedAt),
          isNull(simulatedNotifications.id),
          inArray(demoRuns.status, ["starting", "active", "draining"]),
        ),
      )
      .orderBy(asc(orders.confirmedAt), asc(orders.createdAt))
      .limit(input.limit);

    return rows.map(({ order }) => ({
      job: {
        orderId: order.id,
        publicOrderId: order.publicOrderId,
        reservationId: order.reservationId,
        saleOfferId: order.saleOfferId,
        correlationId: order.correlationId,
        runId: order.runId,
        quantity: order.quantity,
        queuedAt: order.queuedAt.toISOString(),
        processingGeneration: 0,
      },
      confirmedAt: requireConfirmedAt(order).toISOString(),
    }));
  }
}

function requireConfirmedAt(order: typeof orders.$inferSelect): Date {
  if (!order.confirmedAt) {
    throw new Error(`Confirmed order ${order.id} has no confirmed_at timestamp.`);
  }
  return order.confirmedAt;
}
