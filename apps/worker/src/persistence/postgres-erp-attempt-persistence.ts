import { type CheckoutSurgeDatabase, erpAttempts, orderEvents } from "@checkout-surge/db";
import type {
  ErpAttemptPersistence,
  ErpAttemptRecord,
} from "../application/erp-confirmation-client.js";

export class PostgresErpAttemptPersistence implements ErpAttemptPersistence {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async recordAttempt(record: ErpAttemptRecord): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(erpAttempts).values({
        orderId: record.job.orderId,
        correlationId: record.job.correlationId,
        ...(record.job.runId ? { runId: record.job.runId } : {}),
        attemptNumber: record.delivery.attemptNumber,
        status: record.status,
        ...(record.httpStatus ? { httpStatus: record.httpStatus } : {}),
        ...(record.errorCode ? { errorCode: record.errorCode } : {}),
        ...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
        latencyMs: record.latencyMs,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
      });

      await tx.insert(orderEvents).values({
        orderId: record.job.orderId,
        reservationId: record.job.reservationId,
        saleOfferId: record.job.saleOfferId,
        ...(record.job.runId ? { runId: record.job.runId } : {}),
        correlationId: record.job.correlationId,
        eventName: record.status === "succeeded" ? "erp.attempt.succeeded" : "erp.attempt.failed",
        payload: {
          erpAttemptStatus: record.status,
          attemptNumber: record.delivery.attemptNumber,
          attemptsMade: record.delivery.attemptsMade,
          latencyMs: record.latencyMs,
          ...(record.httpStatus ? { httpStatus: record.httpStatus } : {}),
          ...(record.errorCode ? { errorCode: record.errorCode } : {}),
          ...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
        },
        source: "worker",
        occurredAt: record.finishedAt,
      });
    });
  }
}
