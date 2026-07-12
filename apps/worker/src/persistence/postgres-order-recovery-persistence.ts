import type { OrderProcessJob } from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  type JsonValue,
  orderDeadLetters,
  orderRecoveryJobs,
  orders,
} from "@checkout-surge/db";
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import type { RecoverableOrderHandoff } from "../application/order-process-job-handler.js";
import type {
  DeadLetterRecord,
  OrderRecoveryPersistence,
  RecoverableOrderJob,
} from "../application/order-recovery-scanner.js";

export class PostgresOrderRecoveryPersistence implements OrderRecoveryPersistence {
  constructor(
    private readonly db: CheckoutSurgeDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async recordRecoverable(input: RecoverableOrderHandoff): Promise<void> {
    const recoveryKey = `order:${input.job.orderId}`;
    const payload = input.job as unknown as Record<string, unknown>;
    const now = this.now();
    const sourceJobId = input.sourceJobId ?? input.delivery.deliveryId ?? input.job.orderId;
    const sourceDisposition =
      input.sourceDisposition ?? `${sourceJobId}:${input.delivery.attemptNumber}`;
    const result = toJsonRecord(input.attempt);
    const lastError = input.error instanceof Error ? input.error.message : String(input.error);
    const [existing] = await this.db
      .select({
        status: orderRecoveryJobs.status,
      })
      .from(orderRecoveryJobs)
      .where(eq(orderRecoveryJobs.recoveryKey, recoveryKey))
      .limit(1);
    if (existing?.status === "resolved") return;
    // A recovery row is one workflow per order. Retained failed-set jobs and
    // later recovery deliveries only enrich diagnostics; they never reopen,
    // reset attempts, or replace the active lease/source identity.
    if (existing) {
      await this.db
        .update(orderRecoveryJobs)
        .set({
          reason: input.reason,
          payload,
          ...(result ? { result } : {}),
          lastError,
          updatedAt: now,
        })
        .where(eq(orderRecoveryJobs.recoveryKey, recoveryKey));
      return;
    }
    await this.db
      .insert(orderRecoveryJobs)
      .values({
        recoveryKey,
        jobId: sourceJobId,
        sourceJobId,
        sourceDisposition,
        orderId: input.job.orderId,
        payload,
        ...(result ? { result } : {}),
        reason: input.reason,
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
      })
      .onConflictDoUpdate({
        target: orderRecoveryJobs.recoveryKey,
        set: {
          reason: input.reason,
          payload,
          ...(result ? { result } : {}),
          lastError,
          updatedAt: now,
        },
      });
  }

  async findRecoverable(input: { limit: number; now: Date }): Promise<RecoverableOrderJob[]> {
    const rows = await this.db
      .select()
      .from(orderRecoveryJobs)
      .innerJoin(orders, eq(orders.id, orderRecoveryJobs.orderId))
      .where(
        and(
          inArray(orders.status, ["queued", "processing"]),
          or(
            and(
              eq(orderRecoveryJobs.status, "enqueued"),
              or(
                isNull(orderRecoveryJobs.nextAttemptAt),
                lte(orderRecoveryJobs.nextAttemptAt, input.now),
              ),
            ),
            eq(orderRecoveryJobs.status, "pending"),
          ),
        ),
      )
      .orderBy(orderRecoveryJobs.createdAt)
      .limit(input.limit);
    return rows.map(({ order_recovery_jobs: row }) => ({
      recoveryKey: row.recoveryKey,
      job: row.payload as unknown as OrderProcessJob,
      reason: row.reason,
      attempts: row.attempts,
      createdAt: row.createdAt,
      ...(row.sourceJobId ? { sourceJobId: row.sourceJobId } : {}),
      ...(row.sourceDisposition ? { sourceDisposition: row.sourceDisposition } : {}),
    }));
  }

  async markEnqueued(input: {
    recoveryKey: string;
    nextAttemptAt: Date;
    attempts: number;
  }): Promise<void> {
    await this.db
      .update(orderRecoveryJobs)
      .set({
        status: "enqueued",
        attempts: input.attempts,
        nextAttemptAt: input.nextAttemptAt,
        updatedAt: this.now(),
      })
      .where(eq(orderRecoveryJobs.recoveryKey, input.recoveryKey));
  }

  async claimForPublication(input: {
    recoveryKey: string;
    now: Date;
    leaseMs: number;
  }): Promise<{ attempt: number } | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(orderRecoveryJobs)
        .where(
          and(
            eq(orderRecoveryJobs.recoveryKey, input.recoveryKey),
            or(
              eq(orderRecoveryJobs.status, "pending"),
              and(
                eq(orderRecoveryJobs.status, "enqueued"),
                or(
                  isNull(orderRecoveryJobs.nextAttemptAt),
                  lte(orderRecoveryJobs.nextAttemptAt, input.now),
                ),
              ),
            ),
          ),
        )
        .limit(1)
        .for("update");
      if (!row) return null;
      const attempt = row.attempts + 1;
      await tx
        .update(orderRecoveryJobs)
        .set({
          status: "enqueued",
          attempts: attempt,
          claimedAt: input.now,
          nextAttemptAt: new Date(input.now.getTime() + input.leaseMs),
          updatedAt: input.now,
        })
        .where(eq(orderRecoveryJobs.recoveryKey, input.recoveryKey));
      return { attempt };
    });
  }

  async markPublicationFailed(input: {
    recoveryKey: string;
    error: string;
    nextAttemptAt: Date;
  }): Promise<void> {
    await this.db
      .update(orderRecoveryJobs)
      .set({
        status: "pending",
        lastError: input.error,
        nextAttemptAt: input.nextAttemptAt,
        updatedAt: this.now(),
      })
      .where(eq(orderRecoveryJobs.recoveryKey, input.recoveryKey));
  }

  async markResolved(input: { recoveryKey: string }): Promise<void> {
    const now = this.now();
    await this.db
      .update(orderRecoveryJobs)
      .set({ status: "resolved", resolvedAt: now, nextAttemptAt: null, updatedAt: now })
      .where(eq(orderRecoveryJobs.recoveryKey, input.recoveryKey));
  }

  async reconcileTerminal(): Promise<number> {
    const rows = await this.db
      .select({ recoveryKey: orderRecoveryJobs.recoveryKey })
      .from(orderRecoveryJobs)
      .innerJoin(orders, eq(orders.id, orderRecoveryJobs.orderId))
      .where(
        and(
          inArray(orderRecoveryJobs.status, ["pending", "enqueued"]),
          inArray(orders.status, ["confirmed", "failed"]),
        ),
      );
    for (const row of rows) await this.markResolved({ recoveryKey: row.recoveryKey });
    return rows.length;
  }

  async markEscalated(input: { recoveryKey: string; error: string }): Promise<void> {
    const now = this.now();
    await this.db
      .update(orderRecoveryJobs)
      .set({ status: "escalated", lastError: input.error, escalatedAt: now, updatedAt: now })
      .where(eq(orderRecoveryJobs.recoveryKey, input.recoveryKey));
  }

  async recordDeadLetter(input: DeadLetterRecord): Promise<void> {
    await this.db
      .insert(orderDeadLetters)
      .values({
        jobId: input.jobId,
        jobName: input.jobName,
        ...(input.queueName ? { queueName: input.queueName } : {}),
        ...(input.orderId ? { claimedOrderId: input.orderId } : {}),
        ...(toJsonValue(input.payload) !== undefined
          ? { payload: toJsonValue(input.payload) }
          : {}),
        reason: input.reason,
        ...(input.mismatchedFields ? { mismatchedFields: [...input.mismatchedFields] } : {}),
        attemptsMade: input.attemptsMade,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        observedAt: input.observedAt,
      })
      .onConflictDoNothing({
        target: [orderDeadLetters.queueName, orderDeadLetters.jobId, orderDeadLetters.jobName],
      });
  }
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .filter((item) => toJsonValue(item) !== undefined)
      .map((item) => toJsonValue(item) as JsonValue);
  }
  if (typeof value === "object" && value !== null) {
    const record: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = toJsonValue(item);
      if (converted !== undefined) record[key] = converted;
    }
    return record;
  }
  return undefined;
}

function toJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const response = candidate.response;
  if (response && typeof response === "object" && !Array.isArray(response)) {
    return { ...candidate, response: { ...(response as Record<string, unknown>) } };
  }
  return candidate;
}
