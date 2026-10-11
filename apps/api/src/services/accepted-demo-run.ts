import type {
  AcceptedRunConfigSnapshot,
  DemoRunSnapshot,
  OperatorMode,
  RunExecutionMode,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  demoComparisons,
  demoRunSaleContexts,
  demoRuns,
  products,
  saleOffers,
} from "@checkout-surge/db";
import { desc, eq, inArray } from "drizzle-orm";
import { toDemoRunSnapshot } from "./demo-run-projections.js";
import { DemoRunValidationError } from "./demo-run-validation-error.js";
import { incompleteAdminResetPredicate } from "./incomplete-admin-reset.js";

export type DemoRunTransaction = Parameters<Parameters<CheckoutSurgeDatabase["transaction"]>[0]>[0];

/** Affirmative launch evidence: no traffic was dispatched, or dispatch was rejected. */
export class AcceptedRunLaunchRejectedError extends Error {
  constructor(cause: unknown) {
    super("Accepted run launch was rejected before traffic.", { cause });
  }
}

/** Caller owns the START advisory lock and the control maintenance authority. */
export async function requireDemoStartSlot(tx: DemoRunTransaction): Promise<void> {
  const [existingRun] = await tx
    .select({ id: demoRuns.id, status: demoRuns.status })
    .from(demoRuns)
    .where(inArray(demoRuns.status, ["starting", "active", "draining"]))
    .limit(1);
  if (existingRun)
    throw new DemoRunValidationError(
      "run_conflict",
      "A demo run is already starting, active, or draining.",
      { conflictReason: "active_run_exists", runId: existingRun.id, status: existingRun.status },
    );
  const [incompleteReset] = await tx
    .select({ runId: demoRuns.id })
    .from(demoRuns)
    .where(incompleteAdminResetPredicate())
    .limit(1);
  if (incompleteReset)
    throw new DemoRunValidationError(
      "run_conflict",
      "The prior demo reset must be repaired before another run can start.",
      { conflictReason: "reset_incomplete", runId: incompleteReset.runId },
    );
  const [comparison] = await tx
    .select({ id: demoComparisons.id })
    .from(demoComparisons)
    .where(inArray(demoComparisons.state, ["running", "cleanup_pending"]))
    .limit(1);
  if (comparison)
    throw new DemoRunValidationError("run_conflict", "A comparison still owns the demo run slot.", {
      conflictReason: "comparison_in_progress",
      comparisonId: comparison.id,
    });
}

/** Inserts a trusted, validated immutable snapshot; never acquires locks or charges budget. */
export async function insertStartingRun(
  tx: DemoRunTransaction,
  input: {
    runId: string;
    saleOfferId: string;
    presetId: string;
    presetName: string;
    snapshot: AcceptedRunConfigSnapshot;
    executionMode: RunExecutionMode;
    operatorMode: OperatorMode;
    correlationId: string;
    acceptedAt: Date;
    comparisonId?: string;
  },
): Promise<DemoRunSnapshot> {
  const [product] = await tx
    .select({ id: products.id })
    .from(products)
    .where(eq(products.isActive, true))
    .orderBy(desc(products.updatedAt))
    .limit(1);
  if (!product)
    throw new DemoRunValidationError(
      "resource_not_found",
      "No active product is available for demo runs.",
    );
  const now = input.acceptedAt;
  await tx.insert(saleOffers).values({
    id: input.saleOfferId,
    productId: product.id,
    name: `${input.presetName} Generated Run Offer`,
    allocatedStock: input.snapshot.inventoryConfig.startingStock,
    saleStartsAt: now,
    saleEndsAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });
  const [run] = await tx
    .insert(demoRuns)
    .values({
      id: input.runId,
      presetId: input.presetId,
      presetName: input.presetName,
      operatorMode: input.operatorMode,
      executionMode: input.executionMode,
      comparisonId: input.comparisonId,
      status: "starting",
      trafficStatus: "starting",
      configSnapshot: input.snapshot,
      correlationId: input.correlationId,
      saleOfferId: input.saleOfferId,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!run) throw new Error("Failed to create demo run.");
  await tx
    .insert(demoRunSaleContexts)
    .values({ runId: input.runId, saleOfferId: input.saleOfferId, createdAt: now, updatedAt: now });
  return toDemoRunSnapshot(run);
}
