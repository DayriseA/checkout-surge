import { type CheckoutSurgeDatabase, erpAttempts, orderEvents } from "@checkout-surge/db";
import { and, desc, eq } from "drizzle-orm";
import type {
  ErpAttemptPersistence,
  ErpAttemptRecord,
  ReusableErpConfirmationAttempt,
} from "../application/erp-confirmation-client.js";

export class PostgresErpAttemptPersistence implements ErpAttemptPersistence {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async findSuccessfulAttempt(
    job: ErpAttemptRecord["job"],
  ): Promise<ReusableErpConfirmationAttempt | null> {
    const [attempt] = await this.db
      .select({
        orderId: erpAttempts.orderId,
        attemptNumber: erpAttempts.attemptNumber,
        httpStatus: erpAttempts.httpStatus,
        finishedAt: erpAttempts.finishedAt,
      })
      .from(erpAttempts)
      .where(and(eq(erpAttempts.orderId, job.orderId), eq(erpAttempts.status, "succeeded")))
      .orderBy(desc(erpAttempts.finishedAt), desc(erpAttempts.createdAt))
      .limit(1);

    return attempt
      ? {
          orderId: attempt.orderId,
          attemptNumber: attempt.attemptNumber,
          ...(attempt.httpStatus ? { httpStatus: attempt.httpStatus } : {}),
          finishedAt: attempt.finishedAt,
        }
      : null;
  }

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
