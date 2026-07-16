import {
  type AcceptedRunConfigSnapshot,
  acceptedRunConfigSnapshotSchema,
  type BusinessOutcomeSummary,
  businessOutcomeSummarySchema,
  type DemoRunSnapshot,
  demoRunSnapshotSchema,
  type TerminalInventorySnapshot,
  type TrafficDeliverySummary,
  type TrafficHttpSummary,
  terminalInventorySnapshotSchema,
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
import {
  acceptedResponseAccountingWarning,
  reconcileAcceptedResponses,
} from "./accepted-response-accounting.js";
import type { PendingPersistenceReconciler } from "./pending-persistence-reconciler.js";
import type { TerminalDemoRunWriter } from "./terminal-demo-run-writer.js";
import { normalizeTrafficDeliverySummary } from "./traffic-delivery-classifier.js";

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

    let pendingReconciliationFailed = false;
    if (this.options.pendingPersistenceReconciler) {
      try {
        const reconciliation = await this.options.pendingPersistenceReconciler.reconcileSaleOffer(
          row.run.saleOfferId,
          {
            runId: row.run.id,
          },
        );
        if (reconciliation.failed > 0) {
          pendingReconciliationFailed = true;
          this.options.logger.warn(
            { runId, saleOfferId: row.run.saleOfferId, failed: reconciliation.failed },
            "Run remains draining while pending Redis reservations remain retryable.",
          );
        }
      } catch (error) {
        pendingReconciliationFailed = true;
        this.options.logger.warn(
          { err: error, runId, saleOfferId: row.run.saleOfferId },
          "Pending Redis reservation reconciliation failed during run finalization.",
        );
      }
    }

    const reconciliationTimedOut =
      pendingReconciliationFailed && now.getTime() >= this.drainTimeoutAt(row.run).getTime();
    if (pendingReconciliationFailed && !reconciliationTimedOut) {
      return toDemoRunSnapshot(row.run);
    }

    const decision = await this.decideFinalization({
      run: row.run,
      finalization: row.finalization,
      now,
      pendingReconciliationFailed,
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
    const latestBusinessBlockers = businessDrainBlockers(
      latestBusinessOutcome,
      latestPendingRedisCount,
      latestRecoveryPressure.pendingCount,
      latestRecoveryPressure.escalatedProcessingCount,
      latestRecoveryPressure.escalatedRetryingCount,
      latestRecoveryPressure.escalatedQueuedCount,
    );
    const evidence = parseFinalizationEvidence(row.run, row.finalization);
    const latestAccounting = reconcileAcceptedResponses({
      ...evidence,
      business: latestBusinessOutcome,
    });
    const latestBlockers = [
      ...latestBusinessBlockers,
      ...(latestAccounting.accounted ? [] : ["accepted_response_accounting"]),
      ...(pendingReconciliationFailed ? ["pending_persistence_reconciliation"] : []),
    ];
    if (latestBlockers.length > 0 && !timedOut) {
      this.options.logger.debug(
        { runId, blockers: latestBlockers },
        "Demo run remains draining after late business work was observed.",
      );
      return toDemoRunSnapshot(row.run);
    }

    const latestFailureReason = this.deriveFailureReason({
      delivery: evidence.delivery,
      http: evidence.http,
      trafficFailed: row.run.trafficStatus === "failed" || Boolean(row.finalization.errorMessage),
      businessTimedOut: latestBusinessBlockers.length > 0 && timedOut,
      accountingTimedOut:
        latestBusinessBlockers.length === 0 && !latestAccounting.accounted && timedOut,
      escalatedRecoveryCount: latestRecoveryPressure.escalatedCount,
      reconciliationTimedOut,
    });
    const accountingWarning = acceptedResponseAccountingWarning(latestAccounting);
    const loadRunDiagnosticsSummary = accountingWarning
      ? appendAccountingWarning(row.finalization.loadRunDiagnosticsSummary, accountingWarning)
      : row.finalization.loadRunDiagnosticsSummary;

    const wroteSummary = await this.options.terminalRunWriter.write({
      run: row.run,
      terminalStatus: latestFailureReason ? "failed" : "completed",
      failureReason: latestFailureReason,
      finalizedAt: now,
      httpSummary: evidence.http,
      trafficDeliverySummary: evidence.delivery,
      httpTimingBreakdownSummary: row.finalization.httpTimingBreakdownSummary,
      loadRunDiagnosticsSummary,
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
    pendingReconciliationFailed: boolean;
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
    const businessBlockers = businessDrainBlockers(
      businessOutcome,
      pendingRedisCount,
      recoveryPressure.pendingCount,
      recoveryPressure.escalatedProcessingCount,
      recoveryPressure.escalatedRetryingCount,
      recoveryPressure.escalatedQueuedCount,
    );
    const evidence = parseFinalizationEvidence(input.run, input.finalization);
    const accounting = reconcileAcceptedResponses({ ...evidence, business: businessOutcome });
    const blockers = [
      ...businessBlockers,
      ...(accounting.accounted ? [] : ["accepted_response_accounting"]),
      ...(input.pendingReconciliationFailed ? ["pending_persistence_reconciliation"] : []),
    ];
    const timedOut = input.now.getTime() >= timeoutAt.getTime();

    if (blockers.length > 0 && !timedOut) {
      return { ready: false, blockers, timeoutAt };
    }

    const terminalInventorySnapshot = extractTerminalInventorySnapshot(
      input.finalization.trafficOutcomeSummary,
    );
    const failureReason = this.deriveFailureReason({
      delivery: evidence.delivery,
      http: evidence.http,
      trafficFailed:
        input.run.trafficStatus === "failed" || Boolean(input.finalization.errorMessage),
      businessTimedOut: businessBlockers.length > 0 && timedOut,
      accountingTimedOut: businessBlockers.length === 0 && !accounting.accounted && timedOut,
      escalatedRecoveryCount: recoveryPressure.escalatedCount,
      reconciliationTimedOut: input.pendingReconciliationFailed && timedOut,
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
    delivery: TrafficDeliverySummary;
    http: TrafficHttpSummary;
    trafficFailed: boolean;
    businessTimedOut: boolean;
    accountingTimedOut: boolean;
    escalatedRecoveryCount?: number;
    reconciliationTimedOut?: boolean;
  }): string | null {
    if ((input.escalatedRecoveryCount ?? 0) > 0) {
      return "reconciliation_escalated";
    }
    if (input.reconciliationTimedOut) {
      return "pending_persistence_reconciliation_timeout";
    }
    if (input.businessTimedOut) {
      return "business_drain_timeout";
    }
    if (input.accountingTimedOut) {
      return "accepted_response_accounting_timeout";
    }
    if (input.http.unexpectedResponses > 0) {
      return "traffic_outcome_unexpected_responses";
    }
    if (input.delivery.trafficDeliveryStatus === "failed") {
      return "traffic_delivery_major_shortfall";
    }

    if (input.trafficFailed) {
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
        type: "load.run.updated",
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
}

function parseFinalizationEvidence(
  run: typeof demoRuns.$inferSelect,
  finalization: typeof demoRunFinalizations.$inferSelect,
): {
  config: AcceptedRunConfigSnapshot;
  delivery: TrafficDeliverySummary;
  http: TrafficHttpSummary;
} {
  return {
    config: acceptedRunConfigSnapshotSchema.parse(run.configSnapshot),
    delivery: normalizeTrafficDeliverySummary(finalization.trafficDeliverySummary),
    http: trafficHttpSummarySchema.parse(finalization.httpSummary),
  };
}

function appendAccountingWarning(
  diagnostics: Record<string, unknown>,
  warning: Record<string, unknown>,
): Record<string, unknown> {
  const existingWarnings = Array.isArray(diagnostics.accountingWarnings)
    ? diagnostics.accountingWarnings
    : [];
  return { ...diagnostics, accountingWarnings: [...existingWarnings, warning] };
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
