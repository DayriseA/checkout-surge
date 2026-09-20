import type { NotificationRecordJob } from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  demoRuns,
  orderEvents,
  orders,
  simulatedNotifications,
} from "@checkout-surge/db";
import { and, eq } from "drizzle-orm";
import type { NotificationRecordPersistence } from "../application/notification-record-job-handler.js";

type DurableOrder = typeof orders.$inferSelect;
type Transaction = Parameters<Parameters<CheckoutSurgeDatabase["transaction"]>[0]>[0];

export class NotificationOrderNotFoundError extends Error {
  override readonly name = "NotificationOrderNotFoundError";

  constructor(readonly orderId: string) {
    super(`Order ${orderId} was not found for notification recording.`);
  }
}

export class NotificationOrderIdentityMismatchError extends Error {
  override readonly name = "NotificationOrderIdentityMismatchError";

  constructor(
    readonly orderId: string,
    readonly mismatchedFields: readonly string[],
  ) {
    super(
      `Notification job identity does not match durable order ${orderId}: ${mismatchedFields.join(", ")}.`,
    );
  }
}

export class NotificationBeforeConfirmationError extends Error {
  override readonly name = "NotificationBeforeConfirmationError";

  constructor(readonly orderId: string) {
    super(`Order ${orderId} is not confirmed; notification recording is not allowed.`);
  }
}

export class PostgresNotificationRecordPersistence implements NotificationRecordPersistence {
  constructor(
    private readonly db: CheckoutSurgeDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async isTerminalResetRun(runId: string): Promise<boolean> {
    const [run] = await this.db
      .select({ id: demoRuns.id })
      .from(demoRuns)
      .where(
        and(
          eq(demoRuns.id, runId),
          eq(demoRuns.status, "failed"),
          eq(demoRuns.failureReason, "admin_reset"),
        ),
      )
      .limit(1);
    return run !== undefined;
  }

  record(job: NotificationRecordJob): Promise<{ recorded: boolean }> {
    return this.db.transaction(async (tx) => {
      const order = await lockAndValidateOrder(tx, job);

      if (order.status !== "confirmed") {
        throw new NotificationBeforeConfirmationError(order.id);
      }

      const recordedAt = this.now();
      const inserted = await tx
        .insert(simulatedNotifications)
        .values({
          orderId: order.id,
          saleOfferId: order.saleOfferId,
          correlationId: order.correlationId,
          ...(order.runId ? { runId: order.runId } : {}),
          recipientPlaceholder: job.recipientPlaceholder,
          recordedAt,
          createdAt: recordedAt,
        })
        .onConflictDoNothing({
          target: simulatedNotifications.orderId,
        })
        .returning({ id: simulatedNotifications.id });

      if (inserted.length === 0) {
        return { recorded: false };
      }

      await tx.insert(orderEvents).values({
        orderId: order.id,
        reservationId: order.reservationId,
        saleOfferId: order.saleOfferId,
        ...(order.runId ? { runId: order.runId } : {}),
        correlationId: order.correlationId,
        eventName: "notification.recorded",
        payload: {
          recipientPlaceholder: job.recipientPlaceholder,
        },
        source: "worker",
        occurredAt: recordedAt,
      });

      return { recorded: true };
    });
  }
}

async function lockAndValidateOrder(
  tx: Transaction,
  job: NotificationRecordJob,
): Promise<DurableOrder> {
  const [order] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, job.orderId))
    .limit(1)
    .for("update");

  if (!order) {
    throw new NotificationOrderNotFoundError(job.orderId);
  }

  const mismatchedFields = findMismatchedIdentityFields(order, job);
  if (mismatchedFields.length > 0) {
    throw new NotificationOrderIdentityMismatchError(order.id, mismatchedFields);
  }

  return order;
}

function findMismatchedIdentityFields(order: DurableOrder, job: NotificationRecordJob): string[] {
  const mismatches: string[] = [];
  const compare = (field: string, durable: unknown, delivered: unknown) => {
    if (durable !== delivered) {
      mismatches.push(field);
    }
  };

  compare("saleOfferId", order.saleOfferId, job.saleOfferId);
  compare("correlationId", order.correlationId, job.correlationId);
  compare("runId", order.runId ?? undefined, job.runId);
  return mismatches;
}
