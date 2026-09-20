import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  type ErpCallReference,
  type ErpOutcomeDisposition,
  erpAttemptHistoryRetentionLimit,
  erpConfirmationResponseSchema,
  erpErrorCodeSchema,
  erpPermanentRejectionCodeValues,
  recognizedErpErrorCodeDispositions,
  technicalOrderFailureCodeSchema,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  demoRuns,
  erpAttempts,
  erpDispatchCalls,
  orderEvents,
  orderRecoveryJobs,
  orders,
} from "@checkout-surge/db";
import { and, asc, count, desc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type {
  ErpAttemptPersistence,
  ErpAttemptRecord,
  ReusableErpConfirmationAttempt,
} from "../application/erp-confirmation-client.js";

export class PostgresErpAttemptPersistence implements ErpAttemptPersistence {
  constructor(
    private readonly db: CheckoutSurgeDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

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

  async findTechnicalFailure(job: ErpAttemptRecord["job"]) {
    const [attempt] = await this.db
      .select({ errorCode: erpAttempts.errorCode, errorMessage: erpAttempts.errorMessage })
      .from(erpAttempts)
      .where(
        and(eq(erpAttempts.orderId, job.orderId), eq(erpAttempts.disposition, "technical_failure")),
      )
      .orderBy(desc(erpAttempts.finishedAt), desc(erpAttempts.createdAt))
      .limit(1);
    return attempt
      ? {
          errorCode: technicalOrderFailureCodeSchema.parse(attempt.errorCode),
          errorMessage:
            attempt.errorMessage ?? "The ERP returned a non-transient technical failure.",
        }
      : null;
  }

  async findUnresolvedCall(orderId: string): Promise<ErpCallReference | null> {
    const [call] = await this.db
      .select({
        erpCallId: erpDispatchCalls.id,
        orderId: erpDispatchCalls.orderId,
        idempotencyKey: erpDispatchCalls.idempotencyKey,
        processingGeneration: erpDispatchCalls.processingGeneration,
        dispatchedAt: erpDispatchCalls.dispatchedAt,
      })
      .from(erpDispatchCalls)
      .where(and(eq(erpDispatchCalls.orderId, orderId), isNull(erpDispatchCalls.resolvedAt)))
      .orderBy(desc(erpDispatchCalls.dispatchedAt))
      .limit(1);
    return call ? { ...call, dispatchedAt: call.dispatchedAt.toISOString() } : null;
  }

  async recordDispatchIntent(input: {
    job: ErpAttemptRecord["job"];
    idempotencyKey: string;
    dispatchedAt: Date;
    expectedProcessingGeneration: number;
    supersedesErpCallId?: string;
  }): Promise<ErpCallReference> {
    const recoveryKey = `order:${input.job.orderId}`;
    const eligibilityAt = this.now();
    return this.db.transaction(async (tx) => {
      // All processing writes lock order, then control, then call.
      const [order] = await tx
        .select({ status: orders.status })
        .from(orders)
        .where(eq(orders.id, input.job.orderId))
        .for("update")
        .limit(1);
      // Fail closed: without the one-per-order control record there is no
      // processing ownership, so no dispatch intent may be recorded.
      const [control] = await tx
        .select({
          generation: orderRecoveryJobs.processingGeneration,
          status: orderRecoveryJobs.status,
          nextAttemptAt: orderRecoveryJobs.nextAttemptAt,
          leaseExpiresAt: orderRecoveryJobs.leaseExpiresAt,
        })
        .from(orderRecoveryJobs)
        .where(eq(orderRecoveryJobs.recoveryKey, recoveryKey))
        .limit(1)
        .for("update");
      if (!control) {
        throw new Error(
          `No durable control record exists for order ${input.job.orderId}; dispatch intent refused.`,
        );
      }
      const generation = input.expectedProcessingGeneration;
      const [run] = input.job.runId
        ? await tx
            .select({ administrativeStop: demoRuns.administrativeStop })
            .from(demoRuns)
            .where(eq(demoRuns.id, input.job.runId))
            .limit(1)
        : [];
      if (
        generation !== control.generation ||
        (control.status !== "pending" && control.status !== "enqueued") ||
        (order?.status !== "queued" && order?.status !== "processing") ||
        run?.administrativeStop != null ||
        (control.nextAttemptAt !== null && control.nextAttemptAt > eligibilityAt) ||
        (control.leaseExpiresAt !== null && control.leaseExpiresAt <= eligibilityAt)
      ) {
        throw new Error(
          `Order ${input.job.orderId} is not eligible for ERP dispatch by processing generation ${generation}.`,
        );
      }
      const unresolvedCalls = await tx
        .select({ id: erpDispatchCalls.id, idempotencyKey: erpDispatchCalls.idempotencyKey })
        .from(erpDispatchCalls)
        .where(
          and(eq(erpDispatchCalls.orderId, input.job.orderId), isNull(erpDispatchCalls.resolvedAt)),
        );
      if (
        unresolvedCalls.some(
          (call) =>
            call.id !== input.supersedesErpCallId || call.idempotencyKey !== input.idempotencyKey,
        ) ||
        (input.supersedesErpCallId !== undefined && unresolvedCalls.length !== 1)
      ) {
        throw new Error(
          `Order ${input.job.orderId} already has an unresolved ERP dispatch; new intent refused.`,
        );
      }
      if (input.supersedesErpCallId) {
        await tx
          .update(erpDispatchCalls)
          .set({ resolvedAt: input.dispatchedAt, updatedAt: input.dispatchedAt })
          .where(eq(erpDispatchCalls.id, input.supersedesErpCallId));
      }
      const erpCallId = randomUUID();
      const [call] = await tx
        .insert(erpDispatchCalls)
        .values({
          id: erpCallId,
          orderId: input.job.orderId,
          processingGeneration: generation,
          idempotencyKey: input.idempotencyKey,
          publicOrderId: input.job.publicOrderId,
          reservationId: input.job.reservationId,
          saleOfferId: input.job.saleOfferId,
          ...(input.job.runId ? { runId: input.job.runId } : {}),
          quantity: input.job.quantity,
          correlationId: input.job.correlationId,
          dispatchedAt: input.dispatchedAt,
        })
        .returning({ processingGeneration: erpDispatchCalls.processingGeneration });
      if (!call) {
        throw new Error(`Dispatch intent for order ${input.job.orderId} could not be recorded.`);
      }
      // Stamp the unresolved dispatched-call identity onto the control record.
      // A generation moved between the read and this write matches zero rows,
      // so a stale dispatcher never overwrites a newer owner.
      const [stamped] = await tx
        .update(orderRecoveryJobs)
        .set({ unresolvedErpCallId: erpCallId, updatedAt: input.dispatchedAt })
        .where(
          and(
            eq(orderRecoveryJobs.recoveryKey, recoveryKey),
            eq(orderRecoveryJobs.processingGeneration, generation),
            inArray(orderRecoveryJobs.status, ["pending", "enqueued"]),
            or(
              isNull(orderRecoveryJobs.nextAttemptAt),
              lte(orderRecoveryJobs.nextAttemptAt, eligibilityAt),
            ),
            or(
              isNull(orderRecoveryJobs.leaseExpiresAt),
              gt(orderRecoveryJobs.leaseExpiresAt, eligibilityAt),
            ),
          ),
        )
        .returning({ id: orderRecoveryJobs.id });
      if (!stamped) {
        throw new Error(
          `Processing ownership for order ${input.job.orderId} changed before dispatch intent was recorded.`,
        );
      }
      // Crash-left intents never reach recordAttempt, so bound call rows here too.
      await pruneDispatchCalls(tx, input.job.orderId, erpCallId);
      return {
        erpCallId,
        orderId: input.job.orderId,
        idempotencyKey: input.idempotencyKey,
        processingGeneration: call.processingGeneration,
        dispatchedAt: input.dispatchedAt.toISOString(),
      };
    });
  }

  async recordAttempt(record: ErpAttemptRecord): Promise<boolean> {
    const deliveryId = record.delivery.deliveryId ?? record.job.orderId;
    const idempotencyKey = successfulIdempotencyKey(record);
    return this.db.transaction(async (tx) => {
      await tx
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.id, record.job.orderId))
        .for("update")
        .limit(1);
      await tx
        .select({ id: orderRecoveryJobs.id })
        .from(orderRecoveryJobs)
        .where(eq(orderRecoveryJobs.orderId, record.job.orderId))
        .for("update")
        .limit(1);

      if (record.call) {
        const [storedCall] = await tx
          .select({ id: erpDispatchCalls.id })
          .from(erpDispatchCalls)
          .where(eq(erpDispatchCalls.id, record.call.erpCallId))
          .for("update")
          .limit(1);
        if (!storedCall) return false;
        const [existingCall] = await tx
          .select()
          .from(erpAttempts)
          .where(eq(erpAttempts.erpCallId, record.call.erpCallId))
          .limit(1);
        if (existingCall) {
          if (!sameAttempt(existingCall, record)) {
            throw new ErpAttemptContradictionError(record.job.orderId);
          }
          return false;
        }
      }
      if (!record.call) {
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
      }
      let canonicalSuccessExists = false;
      if (idempotencyKey) {
        const [existingSuccess] = await tx
          .select()
          .from(erpAttempts)
          .where(eq(erpAttempts.idempotencyKey, idempotencyKey))
          .limit(1);
        if (existingSuccess && !sameExternalSuccess(existingSuccess, record)) {
          throw new ErpAttemptContradictionError(record.job.orderId);
        }
        if (existingSuccess && !record.call) return false;
        canonicalSuccessExists = existingSuccess !== undefined;
      }

      const attemptValues = {
        orderId: record.job.orderId,
        deliveryId,
        correlationId: record.job.correlationId,
        ...(record.job.runId ? { runId: record.job.runId } : {}),
        ...(record.call ? { erpCallId: record.call.erpCallId } : {}),
        attemptNumber: record.delivery.attemptNumber,
        status: record.status,
        disposition: attemptCountCategory(record),
        terminal: record.terminal,
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
        ...(idempotencyKey && !canonicalSuccessExists ? { idempotencyKey } : {}),
      };
      let insertedCanonical = idempotencyKey !== undefined && !canonicalSuccessExists;
      let inserted = await tx
        .insert(erpAttempts)
        .values(attemptValues)
        // The delivery identity, the durable call identity, and the external
        // success key are all unique boundaries. Resolve any conflict by
        // reading the canonical row.
        .onConflictDoNothing()
        .returning({ id: erpAttempts.id });
      if (inserted.length === 0) {
        if (record.call) {
          const [canonicalByCall] = await tx
            .select()
            .from(erpAttempts)
            .where(eq(erpAttempts.erpCallId, record.call.erpCallId))
            .limit(1);
          if (canonicalByCall) {
            if (!sameAttempt(canonicalByCall, record)) {
              throw new ErpAttemptContradictionError(record.job.orderId);
            }
            return false;
          }
        }
        if (record.call && idempotencyKey) {
          const [canonicalSuccess] = await tx
            .select()
            .from(erpAttempts)
            .where(eq(erpAttempts.idempotencyKey, idempotencyKey))
            .limit(1);
          if (canonicalSuccess) {
            if (!sameExternalSuccess(canonicalSuccess, record)) {
              throw new ErpAttemptContradictionError(record.job.orderId);
            }
            inserted = await tx
              .insert(erpAttempts)
              .values({ ...attemptValues, idempotencyKey: null })
              .onConflictDoNothing()
              .returning({ id: erpAttempts.id });
            insertedCanonical = false;
          }
        }
        if (inserted.length > 0) {
          // The canonical success won concurrently; this call still gets its
          // own accounted attempt without duplicating canonical evidence.
        } else if (!record.call) {
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
        } else {
          throw new ErpAttemptContradictionError(record.job.orderId);
        }
      }

      if (record.call) {
        await accountForCall(tx, record, record.call);
      }

      const attemptId = inserted[0]?.id;
      if (!attemptId) {
        throw new Error(`ERP attempt for order ${record.job.orderId} could not be recorded.`);
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
          erpAttemptId: attemptId,
          disposition: attemptCountCategory(record),
          canonical: insertedCanonical,
          terminal: record.terminal,
          attemptNumber: record.delivery.attemptNumber,
          attemptsMade: record.delivery.attemptsMade,
          latencyMs: record.latencyMs,
          ...(record.httpStatus ? { httpStatus: record.httpStatus } : {}),
          ...(record.errorCode ? { errorCode: record.errorCode } : {}),
          ...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
          ...(record.operation ? { operation: record.operation } : {}),
          ...(record.replayed !== undefined ? { replayed: record.replayed } : {}),
          ...(record.call ? { erpCallId: record.call.erpCallId } : {}),
          ...(record.response?.confirmationId
            ? { confirmationId: record.response.confirmationId }
            : {}),
        },
        source: "worker",
        occurredAt: record.finishedAt,
      });
      await pruneAttemptHistory(tx, record.job.orderId);
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

type Transaction = Parameters<Parameters<CheckoutSurgeDatabase["transaction"]>[0]>[0];

async function pruneAttemptHistory(tx: Transaction, orderId: string): Promise<void> {
  const [control] = await tx
    .select({ unresolvedErpCallId: orderRecoveryJobs.unresolvedErpCallId })
    .from(orderRecoveryJobs)
    .where(eq(orderRecoveryJobs.orderId, orderId))
    .limit(1);
  const [attemptTotal] = await tx
    .select({ value: count() })
    .from(erpAttempts)
    .where(eq(erpAttempts.orderId, orderId))
    .limit(1);
  const attemptsToPrune = Math.max(0, (attemptTotal?.value ?? 0) - erpAttemptHistoryRetentionLimit);

  if (attemptsToPrune > 0) {
    const candidates = await tx
      .select({ id: erpAttempts.id, erpCallId: erpAttempts.erpCallId })
      .from(erpAttempts)
      .where(
        and(
          eq(erpAttempts.orderId, orderId),
          isNull(erpAttempts.idempotencyKey),
          or(isNull(erpAttempts.disposition), ne(erpAttempts.disposition, "permanent_rejection")),
          control?.unresolvedErpCallId
            ? or(
                isNull(erpAttempts.erpCallId),
                ne(erpAttempts.erpCallId, control.unresolvedErpCallId),
              )
            : undefined,
        ),
      )
      .orderBy(asc(erpAttempts.finishedAt), asc(erpAttempts.createdAt), asc(erpAttempts.id))
      .limit(attemptsToPrune);
    const attemptIds = candidates.map(({ id }) => id);
    const callIds = candidates.flatMap(({ erpCallId }) => (erpCallId ? [erpCallId] : []));
    if (attemptIds.length > 0) {
      await tx
        .delete(orderEvents)
        .where(inArray(sql<string>`${orderEvents.payload} ->> 'erpAttemptId'`, attemptIds));
      await tx.delete(erpAttempts).where(inArray(erpAttempts.id, attemptIds));
    }
    if (callIds.length > 0) {
      await tx.delete(erpDispatchCalls).where(inArray(erpDispatchCalls.id, callIds));
    }
  }

  await pruneDispatchCalls(tx, orderId, control?.unresolvedErpCallId ?? null);
  await pruneAttemptEvents(tx, orderId, control?.unresolvedErpCallId ?? null);
}

async function pruneDispatchCalls(
  tx: Transaction,
  orderId: string,
  unresolvedErpCallId: string | null,
): Promise<void> {
  const [callTotal] = await tx
    .select({ value: count() })
    .from(erpDispatchCalls)
    .where(eq(erpDispatchCalls.orderId, orderId))
    .limit(1);
  const callsToPrune = Math.max(0, (callTotal?.value ?? 0) - erpAttemptHistoryRetentionLimit);
  if (callsToPrune === 0) return;

  const candidates = await tx
    .select({ id: erpDispatchCalls.id })
    .from(erpDispatchCalls)
    .where(
      and(
        eq(erpDispatchCalls.orderId, orderId),
        unresolvedErpCallId ? ne(erpDispatchCalls.id, unresolvedErpCallId) : undefined,
        sql`not exists (
          select 1 from ${erpAttempts}
          where ${erpAttempts.erpCallId} = ${erpDispatchCalls.id}
            and (${erpAttempts.idempotencyKey} is not null or ${erpAttempts.disposition} = 'permanent_rejection')
        )`,
      ),
    )
    // Discard crash-left call intents before sacrificing retained attempt diagnostics.
    .orderBy(
      sql`case when exists (
        select 1 from ${erpAttempts}
        where ${erpAttempts.erpCallId} = ${erpDispatchCalls.id}
      ) then 1 else 0 end`,
      asc(erpDispatchCalls.dispatchedAt),
      asc(erpDispatchCalls.createdAt),
      asc(erpDispatchCalls.id),
    )
    .limit(callsToPrune);
  const callIds = candidates.map(({ id }) => id);
  if (callIds.length === 0) return;

  const linkedAttempts = await tx
    .select({ id: erpAttempts.id })
    .from(erpAttempts)
    .where(inArray(erpAttempts.erpCallId, callIds));
  const attemptIds = linkedAttempts.map(({ id }) => id);
  if (attemptIds.length > 0) {
    await tx
      .delete(orderEvents)
      .where(inArray(sql<string>`${orderEvents.payload} ->> 'erpAttemptId'`, attemptIds));
    await tx.delete(erpAttempts).where(inArray(erpAttempts.id, attemptIds));
  }
  await tx.delete(erpDispatchCalls).where(inArray(erpDispatchCalls.id, callIds));
}

async function pruneAttemptEvents(
  tx: Transaction,
  orderId: string,
  unresolvedErpCallId: string | null,
): Promise<void> {
  const attemptEventNames = ["erp.attempt.failed", "erp.attempt.succeeded"] as const;
  const [eventTotal] = await tx
    .select({ value: count() })
    .from(orderEvents)
    .where(and(eq(orderEvents.orderId, orderId), inArray(orderEvents.eventName, attemptEventNames)))
    .limit(1);
  const eventsToPrune = Math.max(0, (eventTotal?.value ?? 0) - erpAttemptHistoryRetentionLimit);
  if (eventsToPrune === 0) return;

  const candidates = await tx
    .select({ id: orderEvents.id })
    .from(orderEvents)
    .where(
      and(
        eq(orderEvents.orderId, orderId),
        inArray(orderEvents.eventName, attemptEventNames),
        sql`coalesce(${orderEvents.payload} ->> 'canonical', 'false') <> 'true'`,
        sql`coalesce(${orderEvents.payload} ->> 'disposition', '') <> 'permanent_rejection'`,
        unresolvedErpCallId
          ? sql`coalesce(${orderEvents.payload} ->> 'erpCallId', '') <> ${unresolvedErpCallId}`
          : undefined,
      ),
    )
    .orderBy(asc(orderEvents.occurredAt), asc(orderEvents.createdAt), asc(orderEvents.id))
    .limit(eventsToPrune);
  const eventIds = candidates.map(({ id }) => id);
  if (eventIds.length > 0) {
    await tx.delete(orderEvents).where(inArray(orderEvents.id, eventIds));
  }
}

/**
 * Per-call cumulative accounting (D09): the counters are incremented exactly
 * once per durable call identity because only the first successful attempt
 * insert reaches this point. A canonical terminal result resolves every
 * outstanding call for the same order and idempotency key.
 */
async function accountForCall(
  tx: Transaction,
  record: ErpAttemptRecord,
  call: ErpCallReference,
): Promise<void> {
  const recoveryKey = `order:${record.job.orderId}`;
  const category = attemptCountCategory(record);
  await tx
    .update(orderRecoveryJobs)
    .set({
      attemptCounts: sql`coalesce(${orderRecoveryJobs.attemptCounts}, '{}'::jsonb) || jsonb_build_object(${category}::text, coalesce((${orderRecoveryJobs.attemptCounts} ->> ${category}::text)::int, 0) + 1)`,
      updatedAt: record.finishedAt,
    })
    .where(eq(orderRecoveryJobs.recoveryKey, recoveryKey));
  if (isDefinitiveCallOutcome(record)) {
    const resolvedCalls = await tx
      .update(erpDispatchCalls)
      .set({ resolvedAt: record.finishedAt, updatedAt: record.finishedAt })
      .where(
        and(
          isNull(erpDispatchCalls.resolvedAt),
          isCanonicalTerminalOutcome(record)
            ? and(
                eq(erpDispatchCalls.orderId, record.job.orderId),
                eq(erpDispatchCalls.idempotencyKey, call.idempotencyKey),
              )
            : eq(erpDispatchCalls.id, call.erpCallId),
        ),
      )
      .returning({ id: erpDispatchCalls.id });
    await tx
      .update(orderRecoveryJobs)
      .set({ unresolvedErpCallId: null, updatedAt: record.finishedAt })
      .where(
        and(
          eq(orderRecoveryJobs.recoveryKey, recoveryKey),
          inArray(
            orderRecoveryJobs.unresolvedErpCallId,
            resolvedCalls.map(({ id }) => id),
          ),
        ),
      );
  }
}

function isCanonicalTerminalOutcome(record: ErpAttemptRecord): boolean {
  const parsedResponse = erpConfirmationResponseSchema.safeParse(record.response);
  if (parsedResponse.success && parsedResponse.data.status === "succeeded") return true;
  if (
    record.errorCode &&
    (erpPermanentRejectionCodeValues as readonly string[]).includes(record.errorCode)
  ) {
    return true;
  }
  return false;
}

function isDefinitiveCallOutcome(record: ErpAttemptRecord): boolean {
  if (isCanonicalTerminalOutcome(record)) return true;
  return (
    record.disposition === "technical_failure" ||
    record.disposition === "capacity_rejected" ||
    // Availability also includes transport failures without authoritative ERP evidence.
    (record.disposition === "temporarily_unavailable" && record.response !== undefined)
  );
}

/**
 * Accounting category of an observed attempt outcome, expressed strictly in
 * the shared `ErpOutcomeDisposition` vocabulary (D03/D09).
 */
function attemptCountCategory(record: ErpAttemptRecord): ErpOutcomeDisposition {
  if (record.disposition !== undefined) return record.disposition;
  if (record.status === "succeeded") return "succeeded";
  if (record.status === "timed_out") return "uncertain_result";
  if (record.errorCode === "erp_request_failed") return "temporarily_unavailable";
  const recognizedCode = erpErrorCodeSchema.safeParse(record.errorCode);
  if (recognizedCode.success) return recognizedErpErrorCodeDispositions[recognizedCode.data];
  if (record.errorCode !== undefined) return "technical_failure";
  return "temporarily_unavailable";
}

function sameAttempt(existing: typeof erpAttempts.$inferSelect, record: ErpAttemptRecord): boolean {
  const deliveryId = record.delivery.deliveryId ?? record.job.orderId;
  return (
    (record.call !== undefined || (existing.deliveryId ?? record.job.orderId) === deliveryId) &&
    existing.status === record.status &&
    existing.terminal === record.terminal &&
    existing.httpStatus === (record.httpStatus ?? null) &&
    existing.errorCode === (record.errorCode ?? null) &&
    existing.errorMessage === (record.errorMessage ?? null) &&
    existing.confirmationId === (record.response?.confirmationId ?? null) &&
    (record.call !== undefined ||
      existing.idempotencyKey === (successfulIdempotencyKey(record) ?? null)) &&
    isDeepStrictEqual(existing.response, record.response ?? null)
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
    existing.terminal === record.terminal &&
    existing.httpStatus === (record.httpStatus ?? null) &&
    existing.confirmationId === (record.response?.confirmationId ?? null) &&
    isDeepStrictEqual(existing.response, record.response ?? null)
  );
}
