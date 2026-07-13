import { randomUUID } from "node:crypto";
import {
  type BusinessOutcomeSummary,
  businessOutcomeSummarySchema,
  type DemoRunSnapshot,
  demoRunSnapshotSchema,
  type TerminalInventorySnapshot,
  terminalInventorySnapshotSchema,
  trafficDeliverySummarySchema,
  trafficHttpSummarySchema,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  demoRunFinalizations,
  demoRuns,
  erpAttempts,
  getInventoryStatus,
  orderRecoveryJobs,
  orders,
  publishDashboardEvent,
  readBusinessOutcomeSummary,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, eq, inArray } from "drizzle-orm";
import type { PendingPersistenceReconciler } from "./pending-persistence-reconciler.js";
import type { TerminalDemoRunWriter } from "./terminal-demo-run-writer.js";

export interface DemoRunFinalizationController {
  finalizeRun(runId: string, correlationId?: string): Promise<DemoRunSnapshot | null>;
  finalizeReadyRuns(): Promise<number>;
}

type FinalizationDecision =
  | { ready: false; blockers: string[]; timeoutAt: Date }
  | {
      ready: true;
      terminalStatus: "completed" | "failed";
      failureReason: string | null;
      businessOutcome: BusinessOutcomeSummary;
      terminalInventorySnapshot: TerminalInventorySnapshot | null;
    };

export class DemoRunFinalizationService implements DemoRunFinalizationController {
  constructor(
    private readonly options: {
      db: CheckoutSurgeDatabase;
      redis: CheckoutSurgeRedis;
      logger: CheckoutSurgeLogger;
      pendingPersistenceReconciler?: Pick<PendingPersistenceReconciler, "reconcileSaleOffer">;
      terminalRunWriter: Pick<TerminalDemoRunWriter, "write">;
      drainTimeoutSeconds: number;
      now?: () => Date;
      generateId?: () => string;
    },
  ) {}

  async finalizeReadyRuns(): Promise<number> {
    const rows = await this.options.db
      .select({ id: demoRuns.id })
      .from(demoRuns)
      .innerJoin(demoRunFinalizations, eq(demoRunFinalizations.runId, demoRuns.id))
      .where(
        and(
          inArray(demoRuns.status, ["draining"]),
          eq(demoRunFinalizations.completionEnrichmentStatus, "completed"),
        ),
      );

    let finalizedCount = 0;
    for (const row of rows) {
      const finalized = await this.finalizeRun(row.id);
      if (finalized?.status === "completed" || finalized?.status === "failed") {
        finalizedCount += 1;
      }
    }

    return finalizedCount;
  }

  async finalizeRun(runId: string, correlationId?: string): Promise<DemoRunSnapshot | null> {
    const now = this.now();
    const [row] = await this.options.db
      .select({ run: demoRuns, finalization: demoRunFinalizations })
      .from(demoRuns)
      .leftJoin(demoRunFinalizations, eq(demoRunFinalizations.runId, demoRuns.id))
      .where(eq(demoRuns.id, runId))
      .limit(1);

    if (!row) {
      return null;
    }

    if (row.run.status === "completed" || row.run.status === "failed") {
      return toDemoRunSnapshot(row.run);
    }

    if (row.run.status !== "draining" || !row.finalization || !row.run.saleOfferId) {
      return toDemoRunSnapshot(row.run);
    }

    if (row.finalization.completionEnrichmentStatus === "pending") {
      this.options.logger.debug(
        { runId },
        "Demo run remains draining while traffic-completion enrichment is pending.",
      );
      return toDemoRunSnapshot(row.run);
    }

    if (this.options.pendingPersistenceReconciler) {
      try {
        await this.options.pendingPersistenceReconciler.reconcileSaleOffer(row.run.saleOfferId, {
          runId: row.run.id,
        });
      } catch (error) {
        this.options.logger.warn(
          { err: error, runId, saleOfferId: row.run.saleOfferId },
          "Pending Redis reservation reconciliation failed during run finalization.",
        );
      }
    }

    const decision = await this.decideFinalization({
      run: row.run,
      finalization: row.finalization,
      now,
    });

    if (!decision.ready) {
      this.options.logger.debug(
        {
          runId,
          blockers: decision.blockers,
          timeoutAt: decision.timeoutAt.toISOString(),
        },
        "Demo run remains draining.",
      );
      return toDemoRunSnapshot(row.run);
    }

    // A request that crossed the admission boundary before the run closed can
    // finish while the first readiness query is in flight. Recompute all
    // business blockers immediately before the terminal transition.
    const latestBusinessOutcome = await readBusinessOutcomeSummary(this.options.db, {
      saleOfferId: requireSaleOfferId(row.run),
      runId: row.run.id,
    });
    const timeoutAt = this.drainTimeoutAt(row.run);
    const timedOut = now.getTime() >= timeoutAt.getTime();
    let latestPendingRedisCount = 0;
    try {
      latestPendingRedisCount = (
        await getInventoryStatus(this.options.redis, requireSaleOfferId(row.run), now)
      ).pendingPersistenceCount;
    } catch (error) {
      this.options.logger.warn(
        { err: error, runId, saleOfferId: requireSaleOfferId(row.run) },
        "Could not recheck pending Redis reservations before terminal transition.",
      );
      latestPendingRedisCount = Number.POSITIVE_INFINITY;
    }
    const latestRecoveryPressure = await readRecoveryPressure(this.options.db, row.run.id);
    const latestBlockers = businessDrainBlockers(
      latestBusinessOutcome,
      latestPendingRedisCount,
      latestRecoveryPressure.pendingCount,
      latestRecoveryPressure.escalatedProcessingCount,
      latestRecoveryPressure.escalatedRetryingCount,
      latestRecoveryPressure.escalatedQueuedCount,
    );
    if (latestBlockers.length > 0 && !timedOut) {
      this.options.logger.debug(
        { runId, blockers: latestBlockers },
        "Demo run remains draining after late business work was observed.",
      );
      return toDemoRunSnapshot(row.run);
    }

    const latestTimedOut = latestBlockers.length > 0 && timedOut;
    const latestFailureReason = this.deriveFailureReason({
      run: row.run,
      finalization: row.finalization,
      timedOut: latestTimedOut,
      escalatedRecoveryCount: latestRecoveryPressure.escalatedCount,
    });

    const wroteSummary = await this.options.terminalRunWriter.write({
      run: row.run,
      terminalStatus: latestFailureReason ? "failed" : "completed",
      failureReason: latestFailureReason,
      finalizedAt: now,
      httpSummary: trafficHttpSummarySchema.parse(row.finalization.httpSummary),
      trafficDeliverySummary: trafficDeliverySummarySchema.parse(
        row.finalization.trafficDeliverySummary,
      ),
      httpTimingBreakdownSummary: row.finalization.httpTimingBreakdownSummary,
      loadRunDiagnosticsSummary: row.finalization.loadRunDiagnosticsSummary,
      apiRequestLifecycleSummary: row.finalization.apiRequestLifecycleSummary,
      businessOutcome: latestBusinessOutcome,
      terminalInventorySnapshot: decision.terminalInventorySnapshot,
      allowedCurrentStatuses: ["draining"],
    });
    const updatedRun = await this.readRun(runId);

    if (wroteSummary) {
      await this.publishTerminalRunEvent(updatedRun, correlationId, now);
    }

    return updatedRun;
  }

  private async decideFinalization(input: {
    run: typeof demoRuns.$inferSelect;
    finalization: typeof demoRunFinalizations.$inferSelect;
    now: Date;
  }): Promise<FinalizationDecision> {
    const timeoutAt = this.drainTimeoutAt(input.run);
    const businessOutcome = await readBusinessOutcomeSummary(this.options.db, {
      saleOfferId: requireSaleOfferId(input.run),
      runId: input.run.id,
    });
    let pendingRedisCount = 0;
    try {
      pendingRedisCount = (
        await getInventoryStatus(this.options.redis, requireSaleOfferId(input.run), input.now)
      ).pendingPersistenceCount;
    } catch (error) {
      this.options.logger.warn(
        { err: error, runId: input.run.id, saleOfferId: requireSaleOfferId(input.run) },
        "Could not read pending Redis reservations during finalization.",
      );
      pendingRedisCount = Number.POSITIVE_INFINITY;
    }
    const recoveryPressure = await readRecoveryPressure(this.options.db, input.run.id);
    const blockers = businessDrainBlockers(
      businessOutcome,
      pendingRedisCount,
      recoveryPressure.pendingCount,
      recoveryPressure.escalatedProcessingCount,
      recoveryPressure.escalatedRetryingCount,
      recoveryPressure.escalatedQueuedCount,
    );
    const timedOut = input.now.getTime() >= timeoutAt.getTime();

    if (blockers.length > 0 && !timedOut) {
      return { ready: false, blockers, timeoutAt };
    }

    const terminalInventorySnapshot = extractTerminalInventorySnapshot(
      input.finalization.trafficOutcomeSummary,
    );
    const failureReason = this.deriveFailureReason({
      run: input.run,
      finalization: input.finalization,
      timedOut: blockers.length > 0 && timedOut,
      escalatedRecoveryCount: recoveryPressure.escalatedCount,
    });

    return {
      ready: true,
      terminalStatus: failureReason ? "failed" : "completed",
      failureReason,
      businessOutcome,
      terminalInventorySnapshot,
    };
  }

  private drainTimeoutAt(run: typeof demoRuns.$inferSelect): Date {
    const startedAt = run.trafficEndedAt ?? run.updatedAt;
    return new Date(startedAt.getTime() + this.options.drainTimeoutSeconds * 1000);
  }

  private deriveFailureReason(input: {
    run: typeof demoRuns.$inferSelect;
    finalization: typeof demoRunFinalizations.$inferSelect;
    timedOut: boolean;
    escalatedRecoveryCount?: number;
  }): string | null {
    if ((input.escalatedRecoveryCount ?? 0) > 0) {
      return "reconciliation_escalated";
    }
    if (input.timedOut) {
      return "business_drain_timeout";
    }

    const trafficDelivery = trafficDeliverySummarySchema.parse(
      input.finalization.trafficDeliverySummary,
    );
    if (trafficDelivery.trafficDeliveryStatus === "failed") {
      return "traffic_delivery_major_shortfall";
    }

    if (input.run.trafficStatus === "failed" || input.finalization.errorMessage) {
      return "traffic_failed";
    }

    return null;
  }

  private async readRun(runId: string): Promise<DemoRunSnapshot> {
    const [run] = await this.options.db
      .select()
      .from(demoRuns)
      .where(eq(demoRuns.id, runId))
      .limit(1);

    if (!run) {
      throw new Error(`Demo run ${runId} disappeared during finalization.`);
    }

    return toDemoRunSnapshot(run);
  }

  private async publishTerminalRunEvent(
    run: DemoRunSnapshot,
    correlationId: string | undefined,
    occurredAt: Date,
  ): Promise<void> {
    try {
      await publishDashboardEvent(this.options.redis, {
        type: run.status === "completed" ? "run.completed" : "run.failed",
        eventId: this.generateId(),
        runId: run.runId,
        ...(correlationId ? { correlationId } : {}),
        run,
        occurredAt: occurredAt.toISOString(),
      });
    } catch (error) {
      this.options.logger.warn(
        { err: error, runId: run.runId },
        "Could not publish terminal run dashboard event.",
      );
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private generateId(): string {
    return this.options.generateId?.() ?? randomUUID();
  }
}

function businessDrainBlockers(
  outcome: BusinessOutcomeSummary,
  pendingRedisCount = 0,
  pendingRecoveryCount = 0,
  escalatedProcessingCount = 0,
  escalatedRetryingCount = 0,
  escalatedQueuedCount = 0,
): string[] {
  const parsed = businessOutcomeSummarySchema.parse(outcome);
  const blockers: string[] = [];

  if (parsed.pendingPersistenceCount > 0 || pendingRedisCount > 0) {
    blockers.push("pending_persistence");
  }
  if (pendingRecoveryCount > 0) {
    blockers.push("reconciliation_pending");
  }
  if (parsed.queuedOrders > escalatedQueuedCount) {
    blockers.push("queued_orders");
  }
  if (parsed.processingOrders > escalatedProcessingCount) {
    blockers.push("processing_orders");
  }
  if (parsed.retryingOrders > escalatedRetryingCount) {
    blockers.push("retrying_orders");
  }
  if (parsed.notificationsRecorded < parsed.confirmedOrders) {
    blockers.push("missing_notifications");
  }

  return blockers;
}

async function readRecoveryPressure(
  db: CheckoutSurgeDatabase,
  runId: string,
): Promise<{
  pendingCount: number;
  escalatedCount: number;
  escalatedProcessingCount: number;
  escalatedRetryingCount: number;
  escalatedQueuedCount: number;
}> {
  const rows = await db
    .select({
      status: orderRecoveryJobs.status,
      orderId: orderRecoveryJobs.orderId,
      orderStatus: orders.status,
      attemptStatus: erpAttempts.status,
    })
    .from(orderRecoveryJobs)
    .innerJoin(orders, eq(orders.id, orderRecoveryJobs.orderId))
    .leftJoin(erpAttempts, eq(erpAttempts.orderId, orderRecoveryJobs.orderId))
    .where(eq(orders.runId, runId));
  const escalated = rows.filter((row) => row.status === "escalated");
  const escalatedProcessingIds = new Set(
    escalated.filter((row) => row.orderStatus === "processing").map((row) => row.orderId),
  );
  const escalatedQueuedIds = new Set(
    escalated.filter((row) => row.orderStatus === "queued").map((row) => row.orderId),
  );
  const escalatedRetryingIds = new Set(
    escalated
      .filter(
        (row) =>
          row.orderStatus === "processing" &&
          (row.attemptStatus === "failed" || row.attemptStatus === "timed_out"),
      )
      .map((row) => row.orderId),
  );
  return {
    pendingCount: rows.filter((row) => row.status === "pending" || row.status === "enqueued")
      .length,
    escalatedCount: rows.filter((row) => row.status === "escalated").length,
    escalatedProcessingCount: escalatedProcessingIds.size,
    escalatedRetryingCount: escalatedRetryingIds.size,
    escalatedQueuedCount: escalatedQueuedIds.size,
  };
}

function extractTerminalInventorySnapshot(
  trafficOutcomeSummary: unknown,
): TerminalInventorySnapshot | null {
  if (
    typeof trafficOutcomeSummary !== "object" ||
    trafficOutcomeSummary === null ||
    !Object.hasOwn(trafficOutcomeSummary, "terminalInventorySnapshot")
  ) {
    return null;
  }

  return terminalInventorySnapshotSchema.parse(
    (trafficOutcomeSummary as Record<string, unknown>).terminalInventorySnapshot,
  );
}

function requireSaleOfferId(run: typeof demoRuns.$inferSelect): string {
  if (!run.saleOfferId) {
    throw new Error(`Demo run ${run.id} has no sale offer.`);
  }
  return run.saleOfferId;
}

function toDemoRunSnapshot(run: typeof demoRuns.$inferSelect): DemoRunSnapshot {
  return demoRunSnapshotSchema.parse({
    runId: run.id,
    presetId: run.presetId,
    presetName: run.presetName,
    operatorMode: run.operatorMode,
    status: run.status,
    trafficStatus: run.trafficStatus,
    ...(run.saleOfferId ? { saleOfferId: run.saleOfferId } : {}),
    configSnapshot: run.configSnapshot,
    ...(run.startedAt ? { startedAt: run.startedAt.toISOString() } : {}),
    ...(run.trafficStartedAt ? { trafficStartedAt: run.trafficStartedAt.toISOString() } : {}),
    ...(run.trafficEndedAt ? { trafficEndedAt: run.trafficEndedAt.toISOString() } : {}),
    ...(run.finalizedAt ? { finalizedAt: run.finalizedAt.toISOString() } : {}),
    ...(run.failureReason ? { failureReason: run.failureReason } : {}),
  });
}
