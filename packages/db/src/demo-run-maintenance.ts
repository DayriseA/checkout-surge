import { uuidSchema } from "@checkout-surge/contracts";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { CheckoutSurgeDatabase } from "./client.js";
import {
  demoRunFinalizations,
  demoRunSaleContexts,
  demoRunSoldOutCounts,
  demoRunSummaries,
  demoRuns,
  erpAttempts,
  erpConfirmationLedger,
  erpDispatchCalls,
  erpScopeResilienceState,
  orderEvents,
  orderRecoveryJobs,
  orders,
  reservationPendingPersistence,
  reservations,
  saleOffers,
  simulatedNotifications,
} from "./schema.js";

export interface GeneratedRunIdentity {
  runId: string;
  saleOfferId: string;
}

export type InspectGeneratedRunTeardownResult =
  | { outcome: "absent" }
  | { outcome: "non_terminal" }
  | { outcome: "outstanding_work" }
  | { outcome: "ownership_mismatch" }
  | {
      outcome: "ready";
      runId: string;
      saleOfferId: string;
    };

/** Reads the terminal generated-run identity used for exact external cleanup. */
export async function inspectGeneratedRunTeardown(
  db: CheckoutSurgeDatabase,
  requestedRunId: string,
): Promise<InspectGeneratedRunTeardownResult> {
  const runId = uuidSchema.parse(requestedRunId);
  return db.transaction((tx) =>
    inspectLockedGeneratedRunTeardown(tx as CheckoutSurgeDatabase, runId),
  );
}

export type DeleteGeneratedRunDurableResult =
  | { outcome: "deleted" }
  | Exclude<InspectGeneratedRunTeardownResult, { outcome: "ready" }>;

/**
 * Revalidates terminal generated ownership and transactionally deletes exactly
 * the identity whose queue and Redis state was already cleaned.
 */
export async function deleteGeneratedRunDurable(
  db: CheckoutSurgeDatabase,
  requestedIdentity: GeneratedRunIdentity,
): Promise<DeleteGeneratedRunDurableResult> {
  const identity = {
    runId: uuidSchema.parse(requestedIdentity.runId),
    saleOfferId: uuidSchema.parse(requestedIdentity.saleOfferId),
  };
  return db.transaction(async (tx) => {
    const inspected = await inspectLockedGeneratedRunTeardown(
      tx as CheckoutSurgeDatabase,
      identity.runId,
    );
    if (inspected.outcome !== "ready") return inspected;
    if (inspected.saleOfferId !== identity.saleOfferId) {
      return { outcome: "ownership_mismatch" };
    }
    await deleteGeneratedRunRows(tx as CheckoutSurgeDatabase, identity);
    return { outcome: "deleted" };
  });
}

/** Deletes a reset run's internal data while retaining its history identity. */
export async function purgeResetRunDurable(
  db: CheckoutSurgeDatabase,
  input: { runId: string; failureReason: "admin_reset" },
): Promise<void> {
  const runId = uuidSchema.parse(input.runId);
  await db.transaction(async (tx) => {
    const [run] = await tx
      .select({ status: demoRuns.status, failureReason: demoRuns.failureReason })
      .from(demoRuns)
      .where(eq(demoRuns.id, runId))
      // Workers holding an order lock take KEY SHARE on the run through foreign keys.
      .for("no key update");
    if (run?.status !== "failed" || run.failureReason !== input.failureReason) {
      throw new Error(`Demo run ${runId} is not a ${input.failureReason} run.`);
    }
    await tx.select({ id: orders.id }).from(orders).where(eq(orders.runId, runId)).for("update");
    await deleteGeneratedRunInternalRows(tx as CheckoutSurgeDatabase, runId);
  });
}

async function inspectLockedGeneratedRunTeardown(
  db: CheckoutSurgeDatabase,
  runId: string,
): Promise<InspectGeneratedRunTeardownResult> {
  const [run] = await db
    .select({
      runId: demoRuns.id,
      saleOfferId: demoRuns.saleOfferId,
      status: demoRuns.status,
    })
    .from(demoRuns)
    .where(eq(demoRuns.id, runId))
    .for("update");
  if (!run) return { outcome: "absent" };
  if (!(["completed", "failed"] as string[]).includes(run.status)) {
    return { outcome: "non_terminal" };
  }
  const [ownership] = await db
    .select({
      contextSaleOfferId: demoRunSaleContexts.saleOfferId,
      offerPurpose: saleOffers.purpose,
    })
    .from(demoRunSaleContexts)
    .innerJoin(saleOffers, eq(saleOffers.id, demoRunSaleContexts.saleOfferId))
    .where(eq(demoRunSaleContexts.runId, runId))
    .for("update");
  if (
    !run.saleOfferId ||
    ownership?.contextSaleOfferId !== run.saleOfferId ||
    ownership.offerPurpose !== "generated_run"
  ) {
    return { outcome: "ownership_mismatch" };
  }
  if (await hasOutstandingGeneratedRunWork(db, runId)) {
    return { outcome: "outstanding_work" };
  }

  return {
    outcome: "ready",
    runId,
    saleOfferId: run.saleOfferId,
  };
}

async function deleteGeneratedRunRows(
  tx: CheckoutSurgeDatabase,
  identity: GeneratedRunIdentity,
): Promise<void> {
  const { runId, saleOfferId } = identity;
  await deleteGeneratedRunInternalRows(tx, runId);
  await tx.delete(demoRunSummaries).where(eq(demoRunSummaries.runId, runId));
  await tx.delete(demoRunSaleContexts).where(eq(demoRunSaleContexts.runId, runId));

  const deletedRuns = await tx
    .delete(demoRuns)
    .where(
      and(
        eq(demoRuns.id, runId),
        eq(demoRuns.saleOfferId, saleOfferId),
        inArray(demoRuns.status, ["completed", "failed"]),
      ),
    )
    .returning({ id: demoRuns.id });
  if (deletedRuns.length !== 1) {
    throw new Error(`Generated run ${runId} changed during durable deletion.`);
  }

  const deletedSaleOffers = await tx
    .delete(saleOffers)
    .where(and(eq(saleOffers.id, saleOfferId), eq(saleOffers.purpose, "generated_run")))
    .returning({ id: saleOffers.id });
  if (deletedSaleOffers.length !== 1) {
    throw new Error(`Generated sale offer ${saleOfferId} changed during durable deletion.`);
  }
}

async function deleteGeneratedRunInternalRows(
  tx: CheckoutSurgeDatabase,
  runId: string,
): Promise<void> {
  await tx.delete(simulatedNotifications).where(eq(simulatedNotifications.runId, runId));
  await tx.delete(erpAttempts).where(eq(erpAttempts.runId, runId));
  await tx.delete(erpConfirmationLedger).where(eq(erpConfirmationLedger.runId, runId));
  await tx.delete(erpDispatchCalls).where(eq(erpDispatchCalls.runId, runId));
  await tx.delete(orderEvents).where(eq(orderEvents.runId, runId));
  await tx.delete(orders).where(eq(orders.runId, runId));
  await tx.delete(reservations).where(eq(reservations.runId, runId));
  await tx
    .delete(reservationPendingPersistence)
    .where(eq(reservationPendingPersistence.runId, runId));
  await tx.delete(demoRunSoldOutCounts).where(eq(demoRunSoldOutCounts.runId, runId));
  await tx.delete(demoRunFinalizations).where(eq(demoRunFinalizations.runId, runId));
  await tx.delete(erpScopeResilienceState).where(eq(erpScopeResilienceState.scope, `run:${runId}`));
}

async function hasOutstandingGeneratedRunWork(
  db: CheckoutSurgeDatabase,
  runId: string,
): Promise<boolean> {
  const [outstanding] = await db
    .select({ orderId: orders.id })
    .from(orders)
    .leftJoin(orderRecoveryJobs, eq(orderRecoveryJobs.orderId, orders.id))
    .leftJoin(erpDispatchCalls, eq(erpDispatchCalls.orderId, orders.id))
    .leftJoin(simulatedNotifications, eq(simulatedNotifications.orderId, orders.id))
    .where(
      and(
        eq(orders.runId, runId),
        or(
          inArray(orders.status, ["queued", "processing"]),
          and(isNotNull(erpDispatchCalls.id), isNull(erpDispatchCalls.resolvedAt)),
          and(eq(orders.status, "confirmed"), isNull(simulatedNotifications.id)),
        ),
      ),
    )
    .limit(1);
  return outstanding !== undefined;
}
