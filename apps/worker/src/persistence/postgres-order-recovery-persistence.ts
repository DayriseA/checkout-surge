import type { OrderProcessJob, OrderWaitingReason } from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  erpDispatchCalls,
  type JsonValue,
  orderDeadLetters,
  orderRecoveryJobs,
  orders,
} from "@checkout-surge/db";
import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { RecoverableOrderHandoff } from "../application/order-process-job-handler.js";
import type {
  DeadLetterRecord,
  OrderControlRecord,
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
    // Eligibility is fully filtered before the batch limit: pending rows must
    // also respect the next eligible time, leased rows wait for expiry, and
    // open interventions or terminal orders never occupy the front of a batch.
    // Ordering by next eligible time, then order creation time, keeps older
    // retries from being starved by new orders.
    const rows = await this.db
      .select({ job: orderRecoveryJobs })
      .from(orderRecoveryJobs)
      .innerJoin(orders, eq(orders.id, orderRecoveryJobs.orderId))
      .where(
        and(
          inArray(orderRecoveryJobs.status, ["pending", "enqueued"]),
          isNull(orderRecoveryJobs.interventionReason),
          or(
            isNull(orderRecoveryJobs.nextAttemptAt),
            lte(orderRecoveryJobs.nextAttemptAt, input.now),
          ),
          or(
            isNull(orderRecoveryJobs.leaseExpiresAt),
            lte(orderRecoveryJobs.leaseExpiresAt, input.now),
          ),
          inArray(orders.status, ["queued", "processing"]),
        ),
      )
      .orderBy(sql`${orderRecoveryJobs.nextAttemptAt} asc nulls first`, asc(orders.createdAt))
      .limit(input.limit);
    return rows.map(({ job: row }) => ({
      recoveryKey: row.recoveryKey,
      job: row.payload as unknown as OrderProcessJob,
      reason: row.reason,
      attempts: row.attempts,
      createdAt: row.createdAt,
      ...(row.sourceJobId ? { sourceJobId: row.sourceJobId } : {}),
      ...(row.sourceDisposition ? { sourceDisposition: row.sourceDisposition } : {}),
    }));
  }

  async readControlRecord(input: { orderId: string }): Promise<OrderControlRecord | null> {
    const [row] = await this.db
      .select()
      .from(orderRecoveryJobs)
      .where(eq(orderRecoveryJobs.orderId, input.orderId))
      .limit(1);
    if (!row) return null;
    return {
      orderId: row.orderId,
      recoveryKey: row.recoveryKey,
      status: row.status,
      processingGeneration: row.processingGeneration,
      attempts: row.attempts,
      leaseExpiresAt: row.leaseExpiresAt,
      nextAttemptAt: row.nextAttemptAt,
      waitingReason: row.waitingReason,
      publicationOwner: row.publicationOwner,
      interventionReason: row.interventionReason,
      unresolvedErpCallId: row.unresolvedErpCallId,
    };
  }

  async claimForPublication(input: {
    recoveryKey: string;
    now: Date;
    leaseMs: number;
  }): Promise<{ attempt: number; processingGeneration: number; jobId: string } | null> {
    // One conditional update is the atomic claim: eligibility is re-checked in
    // the WHERE clause, so only one concurrent claimer can take ownership and
    // move the generation forward.
    const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
    const [claimed] = await this.db
      .update(orderRecoveryJobs)
      .set({
        status: "enqueued",
        attempts: sql`${orderRecoveryJobs.attempts} + 1`,
        claimedAt: input.now,
        processingGeneration: sql`${orderRecoveryJobs.processingGeneration} + 1`,
        leaseExpiresAt,
        publicationOwner: sql`'recovery-' || ${orderRecoveryJobs.orderId} || '-' || (${orderRecoveryJobs.attempts} + 1)`,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(orderRecoveryJobs.recoveryKey, input.recoveryKey),
          inArray(orderRecoveryJobs.status, ["pending", "enqueued"]),
          isNull(orderRecoveryJobs.interventionReason),
          or(
            isNull(orderRecoveryJobs.nextAttemptAt),
            lte(orderRecoveryJobs.nextAttemptAt, input.now),
          ),
          or(
            isNull(orderRecoveryJobs.leaseExpiresAt),
            lte(orderRecoveryJobs.leaseExpiresAt, input.now),
          ),
        ),
      )
      .returning({
        jobId: sql<string>`${orderRecoveryJobs.publicationOwner}`,
        attempt: orderRecoveryJobs.attempts,
        processingGeneration: orderRecoveryJobs.processingGeneration,
      });
    return claimed ?? null;
  }

  async markPublicationFailed(input: {
    recoveryKey: string;
    error: string;
    nextAttemptAt: Date;
    processingGeneration: number;
  }): Promise<void> {
    const now = this.now();
    await this.db
      .update(orderRecoveryJobs)
      .set({
        status: "pending",
        lastError: input.error,
        nextAttemptAt: input.nextAttemptAt,
        leaseExpiresAt: null,
        publicationOwner: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(orderRecoveryJobs.recoveryKey, input.recoveryKey),
          inArray(orderRecoveryJobs.status, ["pending", "enqueued"]),
          eq(orderRecoveryJobs.processingGeneration, input.processingGeneration),
        ),
      );
  }

  async markResolved(input: { recoveryKey: string }): Promise<void> {
    const now = this.now();
    await this.db
      .update(orderRecoveryJobs)
      .set({
        status: "resolved",
        resolvedAt: now,
        nextAttemptAt: null,
        leaseExpiresAt: null,
        publicationOwner: null,
        updatedAt: now,
      })
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

  async defer(input: {
    orderId: string;
    waitingReason: OrderWaitingReason;
    nextEligibleAt: Date;
    processingGeneration: number;
  }): Promise<boolean> {
    const now = this.now();
    const [deferred] = await this.db
      .update(orderRecoveryJobs)
      .set({
        waitingReason: input.waitingReason,
        nextAttemptAt: input.nextEligibleAt,
        leaseExpiresAt: null,
        publicationOwner: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(orderRecoveryJobs.orderId, input.orderId),
          inArray(orderRecoveryJobs.status, ["pending", "enqueued"]),
          isNull(orderRecoveryJobs.interventionReason),
          eq(orderRecoveryJobs.processingGeneration, input.processingGeneration),
        ),
      )
      .returning({ id: orderRecoveryJobs.id });
    return deferred !== undefined;
  }

  async openIntervention(input: {
    orderId: string;
    reason: string;
    processingGeneration: number;
  }): Promise<boolean> {
    const now = this.now();
    const [opened] = await this.db
      .update(orderRecoveryJobs)
      .set({
        interventionReason: input.reason,
        waitingReason: "intervention_required",
        leaseExpiresAt: null,
        publicationOwner: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(orderRecoveryJobs.orderId, input.orderId),
          inArray(orderRecoveryJobs.status, ["pending", "enqueued"]),
          eq(orderRecoveryJobs.processingGeneration, input.processingGeneration),
        ),
      )
      .returning({ id: orderRecoveryJobs.id });
    return opened !== undefined;
  }

  async resumeFromIntervention(input: {
    orderId: string;
    nextEligibleAt: Date;
    processingGeneration?: number;
  }): Promise<boolean> {
    const now = this.now();
    const [resumed] = await this.db
      .update(orderRecoveryJobs)
      .set({
        interventionReason: null,
        waitingReason: null,
        nextAttemptAt: input.nextEligibleAt,
        leaseExpiresAt: null,
        publicationOwner: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(orderRecoveryJobs.orderId, input.orderId),
          isNotNull(orderRecoveryJobs.interventionReason),
          ...(input.processingGeneration === undefined
            ? []
            : [eq(orderRecoveryJobs.processingGeneration, input.processingGeneration)]),
        ),
      )
      .returning({ id: orderRecoveryJobs.id });
    return resumed !== undefined;
  }

  async resolveDispatchedCall(input: { orderId: string; erpCallId: string }): Promise<boolean> {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      await tx
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .for("update")
        .limit(1);
      await tx
        .select({ id: orderRecoveryJobs.id })
        .from(orderRecoveryJobs)
        .where(eq(orderRecoveryJobs.orderId, input.orderId))
        .for("update")
        .limit(1);
      const [resolved] = await tx
        .update(erpDispatchCalls)
        .set({ resolvedAt: now, updatedAt: now })
        .where(
          and(
            eq(erpDispatchCalls.id, input.erpCallId),
            eq(erpDispatchCalls.orderId, input.orderId),
            isNull(erpDispatchCalls.resolvedAt),
          ),
        )
        .returning({ id: erpDispatchCalls.id });
      if (!resolved) return false;
      await tx
        .update(orderRecoveryJobs)
        .set({
          unresolvedErpCallId: null,
          waitingReason: sql`CASE
            WHEN ${orderRecoveryJobs.waitingReason} = 'uncertain_result' THEN NULL
            ELSE ${orderRecoveryJobs.waitingReason}
          END`,
          updatedAt: now,
        })
        .where(
          and(
            eq(orderRecoveryJobs.orderId, input.orderId),
            eq(orderRecoveryJobs.unresolvedErpCallId, input.erpCallId),
          ),
        );
      return true;
    });
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
