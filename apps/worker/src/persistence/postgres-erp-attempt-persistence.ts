import {
  type CheckoutSurgeDatabase,
  erpAttempts,
  jsonDeepEqual,
  orderEvents,
} from "@checkout-surge/db";
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

  async recordAttempt(record: ErpAttemptRecord): Promise<boolean> {
    const deliveryId = record.delivery.deliveryId ?? record.job.orderId;
    const idempotencyKey = successfulIdempotencyKey(record);
    return this.db.transaction(async (tx) => {
      if (idempotencyKey) {
        const [existingSuccess] = await tx
          .select()
          .from(erpAttempts)
          .where(eq(erpAttempts.idempotencyKey, idempotencyKey))
          .limit(1);
        if (existingSuccess) {
          if (!sameExternalSuccess(existingSuccess, record)) {
            throw new ErpAttemptContradictionError(record.job.orderId);
          }
          return false;
        }
      }
      const [existingAttempt] = await tx
        .select()
        .from(erpAttempts)
        .where(
          and(
            eq(erpAttempts.orderId, record.job.orderId),
            eq(erpAttempts.deliveryId, deliveryId),
            eq(erpAttempts.attemptNumber, record.delivery.attemptNumber),
          ),
        )
        .limit(1);
      if (existingAttempt) {
        if (!sameAttempt(existingAttempt, record)) {
          throw new ErpAttemptContradictionError(record.job.orderId);
        }
        return false;
      }

      const attemptValues = {
        orderId: record.job.orderId,
        deliveryId,
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
        ...(record.response?.confirmationId
          ? { confirmationId: record.response.confirmationId }
          : {}),
        ...(record.response ? { response: record.response } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      };
      const inserted = await tx
        .insert(erpAttempts)
        .values(attemptValues)
        // Both the delivery identity and the external success key are unique
        // boundaries. Resolve either conflict by reading the canonical row.
        .onConflictDoNothing()
        .returning({ id: erpAttempts.id });
      if (inserted.length === 0) {
        const [canonical] = await tx
          .select()
          .from(erpAttempts)
          .where(
            and(
              eq(erpAttempts.orderId, record.job.orderId),
              eq(erpAttempts.deliveryId, deliveryId),
              eq(erpAttempts.attemptNumber, record.delivery.attemptNumber),
            ),
          )
          .limit(1);
        if (canonical) {
          if (!sameAttempt(canonical, record)) {
            throw new ErpAttemptContradictionError(record.job.orderId);
          }
          return false;
        }
        if (idempotencyKey) {
          const [canonicalSuccess] = await tx
            .select()
            .from(erpAttempts)
            .where(eq(erpAttempts.idempotencyKey, idempotencyKey))
            .limit(1);
          if (canonicalSuccess && sameExternalSuccess(canonicalSuccess, record)) return false;
        }
        throw new ErpAttemptContradictionError(record.job.orderId);
      }

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
          ...(record.response?.confirmationId
            ? { confirmationId: record.response.confirmationId }
            : {}),
        },
        source: "worker",
        occurredAt: record.finishedAt,
      });
      return true;
    });
  }
}

export class ErpAttemptContradictionError extends Error {
  override readonly name = "ErpAttemptContradictionError";

  constructor(readonly orderId: string) {
    super(`A contradictory ERP attempt result was supplied for order ${orderId}.`);
  }
}

function sameAttempt(existing: typeof erpAttempts.$inferSelect, record: ErpAttemptRecord): boolean {
  const deliveryId = record.delivery.deliveryId ?? record.job.orderId;
  return (
    (existing.deliveryId ?? record.job.orderId) === deliveryId &&
    existing.status === record.status &&
    existing.httpStatus === (record.httpStatus ?? null) &&
    existing.errorCode === (record.errorCode ?? null) &&
    existing.errorMessage === (record.errorMessage ?? null) &&
    existing.confirmationId === (record.response?.confirmationId ?? null) &&
    existing.idempotencyKey === (successfulIdempotencyKey(record) ?? null) &&
    jsonDeepEqual(existing.response, record.response ?? null)
  );
}

function successfulIdempotencyKey(record: ErpAttemptRecord): string | undefined {
  return record.status === "succeeded" && record.response
    ? `erp-confirmation:${record.job.orderId}`
    : undefined;
}

function sameExternalSuccess(
  existing: typeof erpAttempts.$inferSelect,
  record: ErpAttemptRecord,
): boolean {
  return (
    existing.status === "succeeded" &&
    existing.httpStatus === (record.httpStatus ?? null) &&
    existing.confirmationId === (record.response?.confirmationId ?? null) &&
    jsonDeepEqual(existing.response, record.response ?? null)
  );
}
