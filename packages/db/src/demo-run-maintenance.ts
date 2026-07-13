import { uuidSchema } from "@checkout-surge/contracts";
import { and, eq, inArray } from "drizzle-orm";
import type { CheckoutSurgeDatabase } from "./client.js";
import {
  demoRunFinalizations,
  demoRunReservationOutcomes,
  demoRunSaleContexts,
  demoRunSummaries,
  demoRuns,
  erpAttempts,
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

    await tx.delete(simulatedNotifications).where(eq(simulatedNotifications.runId, runId));
    await tx.delete(erpAttempts).where(eq(erpAttempts.runId, runId));
    await tx.delete(orderEvents).where(eq(orderEvents.runId, runId));
    await tx.delete(orders).where(eq(orders.runId, runId));
    await tx.delete(reservations).where(eq(reservations.runId, runId));
    await tx
      .delete(reservationPendingPersistence)
      .where(eq(reservationPendingPersistence.runId, runId));
    await tx.delete(demoRunReservationOutcomes).where(eq(demoRunReservationOutcomes.runId, runId));
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

    return { deletedRunCount: 1, deletedSaleOfferCount: 1 };
  });
}
