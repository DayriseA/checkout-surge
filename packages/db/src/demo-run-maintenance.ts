import { uuidSchema } from "@checkout-surge/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { CheckoutSurgeDatabase } from "./client.js";
import {
  demoRunFinalizations,
  demoRunSaleContexts,
  demoRunSoldOutCounts,
  demoRunSummaries,
  demoRuns,
  demoRunTeardownReceipts,
  erpAttempts,
  erpConfirmationResults,
  orderEvents,
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

export interface DeleteGeneratedRunResult {
  deletedRunCount: number;
  deletedSaleOfferCount: number;
}

export type PrepareGeneratedRunTeardownResult =
  | { outcome: "absent" }
  | { outcome: "non_terminal" }
  | { outcome: "ownership_mismatch" }
  | {
      outcome: "ready";
      runId: string;
      saleOfferId: string;
      presetName: string;
      durableDeleted: boolean;
    };

/**
 * Atomically establishes durable retry coordinates and deletes a terminal,
 * generated-owned run graph. An existing receipt resumes a post-commit retry.
 */
export async function prepareGeneratedRunTeardown(
  db: CheckoutSurgeDatabase,
  requestedRunId: string,
  now: Date = new Date(),
): Promise<PrepareGeneratedRunTeardownResult> {
  const runId = uuidSchema.parse(requestedRunId);
  return db.transaction(async (tx) => {
    const [receipt] = await tx
      .select()
      .from(demoRunTeardownReceipts)
      .where(eq(demoRunTeardownReceipts.runId, runId))
      .for("update");
    if (receipt) {
      return { outcome: "ready", ...receipt, durableDeleted: false };
    }

    const [run] = await tx
      .select({
        runId: demoRuns.id,
        saleOfferId: demoRuns.saleOfferId,
        presetName: demoRuns.presetName,
        status: demoRuns.status,
      })
      .from(demoRuns)
      .where(eq(demoRuns.id, runId))
      .for("update");
    if (!run) {
      const [committedReceipt] = await tx
        .select()
        .from(demoRunTeardownReceipts)
        .where(eq(demoRunTeardownReceipts.runId, runId))
        .for("update");
      return committedReceipt
        ? { outcome: "ready", ...committedReceipt, durableDeleted: false }
        : { outcome: "absent" };
    }
    if (!(["completed", "failed"] as string[]).includes(run.status)) {
      return { outcome: "non_terminal" };
    }
    const [ownership] = await tx
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

    const identity = {
      runId,
      saleOfferId: run.saleOfferId,
      presetName: run.presetName,
      durableDeletedAt: now,
    };
    await tx.insert(demoRunTeardownReceipts).values(identity);
    await deleteGeneratedRunRows(tx as CheckoutSurgeDatabase, identity);
    return { outcome: "ready", ...identity, durableDeleted: true };
  });
}

export async function completeGeneratedRunTeardown(
  db: CheckoutSurgeDatabase,
  runId: string,
): Promise<void> {
  await db
    .delete(demoRunTeardownReceipts)
    .where(eq(demoRunTeardownReceipts.runId, uuidSchema.parse(runId)));
}

/**
 * Deletes one terminal generated run and its durable subtree atomically.
 *
 * The ownership row is locked and revalidated inside the transaction so a
 * stale maintenance candidate cannot delete a catalog-backed or non-terminal
 * run. A failed revalidation is an idempotent skip.
 */
export async function deleteGeneratedRunDurable(
  db: CheckoutSurgeDatabase,
  identity: GeneratedRunIdentity,
): Promise<DeleteGeneratedRunResult> {
  const runId = uuidSchema.parse(identity.runId);
  const saleOfferId = uuidSchema.parse(identity.saleOfferId);

  return db.transaction(async (tx) => {
    const [ownedRun] = await tx
      .select({ runId: demoRuns.id })
      .from(demoRuns)
      .innerJoin(
        demoRunSaleContexts,
        and(
          eq(demoRunSaleContexts.runId, demoRuns.id),
          eq(demoRunSaleContexts.saleOfferId, demoRuns.saleOfferId),
        ),
      )
      .innerJoin(saleOffers, eq(saleOffers.id, demoRunSaleContexts.saleOfferId))
      .where(
        and(
          eq(demoRuns.id, runId),
          eq(demoRuns.saleOfferId, saleOfferId),
          inArray(demoRuns.status, ["completed", "failed"]),
          eq(saleOffers.purpose, "generated_run"),
        ),
      )
      .for("update");

    if (!ownedRun) {
      return { deletedRunCount: 0, deletedSaleOfferCount: 0 };
    }

    await deleteGeneratedRunRows(tx as CheckoutSurgeDatabase, { runId, saleOfferId });

    return { deletedRunCount: 1, deletedSaleOfferCount: 1 };
  });
}

async function deleteGeneratedRunRows(
  tx: CheckoutSurgeDatabase,
  identity: GeneratedRunIdentity,
): Promise<void> {
  const { runId, saleOfferId } = identity;
  await tx.delete(simulatedNotifications).where(eq(simulatedNotifications.runId, runId));
  await tx.delete(erpAttempts).where(eq(erpAttempts.runId, runId));
  await tx.delete(erpConfirmationResults).where(
    inArray(
      erpConfirmationResults.orderId,
      tx
        .select({ orderId: sql<string>`${orders.id}::text` })
        .from(orders)
        .where(eq(orders.runId, runId)),
    ),
  );
  await tx.delete(orderEvents).where(eq(orderEvents.runId, runId));
  await tx.delete(orders).where(eq(orders.runId, runId));
  await tx.delete(reservations).where(eq(reservations.runId, runId));
  await tx
    .delete(reservationPendingPersistence)
    .where(eq(reservationPendingPersistence.runId, runId));
  await tx.delete(demoRunSoldOutCounts).where(eq(demoRunSoldOutCounts.runId, runId));
  await tx.delete(demoRunFinalizations).where(eq(demoRunFinalizations.runId, runId));
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
