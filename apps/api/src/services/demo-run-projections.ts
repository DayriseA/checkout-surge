import {
  type BusinessOutcomeSummary,
  type DemoRunSnapshot,
  demoRunSnapshotSchema,
  type InventoryStatus,
  internalRunFailureReasonSchema,
  type TerminalInventorySnapshot,
  toPublicRunFailureCategory,
} from "@checkout-surge/contracts";
import type { demoRuns } from "@checkout-surge/db";
import { parsePersistedAcceptedRunConfigSnapshot } from "./persisted-demo-run-state.js";

export function toDemoRunSnapshot(run: typeof demoRuns.$inferSelect): DemoRunSnapshot {
  const context = `demo run ${run.id}`;
  return demoRunSnapshotSchema.parse({
    runId: run.id,
    presetId: run.presetId,
    presetName: run.presetName,
    operatorMode: run.operatorMode,
    status: run.status,
    trafficStatus: run.trafficStatus,
    ...(run.saleOfferId ? { saleOfferId: run.saleOfferId } : {}),
    configSnapshot: parsePersistedAcceptedRunConfigSnapshot(run.configSnapshot, context),
    ...(run.startedAt ? { startedAt: run.startedAt.toISOString() } : {}),
    ...(run.trafficStartedAt ? { trafficStartedAt: run.trafficStartedAt.toISOString() } : {}),
    ...(run.trafficEndedAt ? { trafficEndedAt: run.trafficEndedAt.toISOString() } : {}),
    ...(run.finalizedAt ? { finalizedAt: run.finalizedAt.toISOString() } : {}),
    ...(run.adminResetCompletedAt
      ? { adminResetCompletedAt: run.adminResetCompletedAt.toISOString() }
      : {}),
    ...(run.failureReason
      ? {
          failureCategory: toPublicRunFailureCategory(
            internalRunFailureReasonSchema.parse(run.failureReason),
          ),
        }
      : {}),
  });
}

export function toRedisTerminalInventorySnapshot(input: {
  saleOfferId: string;
  inventory: InventoryStatus;
  businessOutcome: Pick<BusinessOutcomeSummary, "acceptedReservations">;
  capturedAt: Date;
}): TerminalInventorySnapshot {
  return {
    saleOfferId: input.saleOfferId,
    startingStock: input.inventory.allocatedStock,
    remainingStock: input.inventory.remainingStock,
    reservedStock: input.inventory.reservedStock,
    acceptedReservations: input.businessOutcome.acceptedReservations,
    soldOutRejections: input.inventory.soldOutPressure.rejectionCount,
    pendingPersistenceCount: input.inventory.pendingPersistenceCount,
    capturedAt: input.capturedAt.toISOString(),
    source: "redis",
  };
}

export function emptyBusinessOutcomeSummary(): BusinessOutcomeSummary {
  return {
    acceptedReservations: 0,
    reservedUnits: 0,
    soldOutRejections: 0,
    queuedOrders: 0,
    processingOrders: 0,
    retryingOrders: 0,
    confirmedOrders: 0,
    failedOrders: 0,
    businessRejectedOrders: 0,
    technicallyFailedOrders: 0,
    administrativelyDisposedOrders: 0,
    pendingPersistenceCount: 0,
    notificationsRecorded: 0,
  };
}
