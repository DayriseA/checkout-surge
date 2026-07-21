import {
  type AcceptedRunConfigSnapshot,
  type AdminDemoResetResponse,
  type AdminGeneratedRunTeardownResponse,
  type AdminMaintenanceCleanupRunsResponse,
  acceptedRunConfigSnapshotSchema,
  adminDemoResetResponseSchema,
  adminGeneratedRunTeardownResponseSchema,
  adminMaintenanceCleanupRunsResponseSchema,
  type BusinessOutcomeSummary,
  emptyHttpTimingBreakdownSummary,
  normalizeLegacyApiRequestLifecycleSummaryJson,
  normalizeLegacyLoadRunDiagnosticsSummaryJson,
  type TerminalInventorySnapshot,
  type TrafficConfig,
  type TrafficDeliverySummary,
  type TrafficHttpSummary,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  type completeGeneratedRunTeardown,
  type deleteGeneratedRunDurable,
  type deleteGeneratedRunRedisState,
  demoRunFinalizations,
  demoRunReservationOutcomes,
  demoRunSaleContexts,
  demoRunSummaries,
  demoRuns,
  getInventoryStatus,
  InventoryNotInitializedError,
  type prepareGeneratedRunTeardown,
  readBusinessOutcomeSummary,
  saleOffers,
  setRunSaleEligibility,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, asc, desc, eq, inArray, isNull, lt, notInArray, or } from "drizzle-orm";
import { ApiHttpError } from "../runtime/errors.js";
import type { DemoResetWorkflowFence } from "./postgres-demo-reset-workflow-fence.js";
import type {
  TerminalDemoRunSummaryInput,
  TerminalDemoRunWriter,
} from "./terminal-demo-run-writer.js";
import {
  normalizePersistedTrafficHttpSummary,
  normalizeTrafficDeliverySummary,
} from "./traffic-delivery-classifier.js";
import { syntheticTrafficDeliverySummary } from "./traffic-delivery-plan.js";

export interface QueueCleanupSummary {
  cleanedQueueCount: number;
  cleanedJobCount: number;
}

export interface DemoQueueQuiescenceLease {
  /**
   * Relinquishes the adapter's exclusive turn. Safe restoration resumes only
   * maintenance-owned pauses and runs finalization before another lease enters;
   * unsafe post-commit queue failures retain those pauses for a later retry.
   */
  release(options: DemoQueueQuiescenceRelease): Promise<void>;
}

export type DemoQueueQuiescenceRelease =
  | { disposition: "retain_owned_pauses" }
  | {
      disposition: "restore_owned_pauses";
      afterRestored?: () => Promise<void>;
    };

export interface DemoQueueMaintenance {
  cleanResetOwnedQueues(): Promise<QueueCleanupSummary>;
  acquireGeneratedRunQuiescence(runId: string): Promise<DemoQueueQuiescenceLease>;
  preflightGeneratedRun(runId: string): Promise<void>;
  cleanGeneratedRun(runId: string): Promise<{ deletedJobCount: number }>;
}

export type DemoQueueMaintenanceConflictCode =
  | "active_job"
  | "maintenance_owned_by_other_run"
  | "malformed_claimed_job"
  | "not_quiescent";

export class DemoQueueMaintenanceConflict extends Error {
  constructor(
    readonly code: DemoQueueMaintenanceConflictCode,
    message: string,
  ) {
    super(message);
    this.name = "DemoQueueMaintenanceConflict";
  }
}

type FencedResetRun = {
  run: typeof demoRuns.$inferSelect;
  finalization: typeof demoRunFinalizations.$inferSelect | null;
  finalizedAt: Date;
  previousStatus?: typeof demoRuns.$inferSelect.status;
  previousTrafficStatus?: typeof demoRuns.$inferSelect.trafficStatus;
};

export interface DemoRunTrafficAborter {
  abortCurrent(input: {
    runId: string;
    reason: string;
    correlationId: string;
  }): Promise<{ outcome: "no_current_run" | "current_run_aborted" }>;
}

export interface DashboardLiveStateReset {
  fenceRun(runId: string): Promise<void>;
  clearRun(runId: string): Promise<void>;
  hasRunState(runId: string): Promise<boolean>;
}

export class DemoMaintenanceService {
  private static resetTail: Promise<void> = Promise.resolve();
  private static resetPendingCount = 0;

  constructor(
    private readonly options: {
      db: CheckoutSurgeDatabase;
      redis: CheckoutSurgeRedis;
      queueMaintenance: DemoQueueMaintenance;
      terminalRunWriter: Pick<
        TerminalDemoRunWriter,
        "claimTerminalRun" | "writeAfterTerminalClaims"
      >;
      logger: CheckoutSurgeLogger;
      deleteGeneratedRunDurable: typeof deleteGeneratedRunDurable;
      deleteGeneratedRunRedisState: typeof deleteGeneratedRunRedisState;
      prepareGeneratedRunTeardown: typeof prepareGeneratedRunTeardown;
      completeGeneratedRunTeardown: typeof completeGeneratedRunTeardown;
      clearErpCircuitBreakerState: () => Promise<void>;
      trafficAborter: DemoRunTrafficAborter;
      dashboardLiveStateReset: DashboardLiveStateReset;
      resetWorkflowFence: DemoResetWorkflowFence;
      now?: () => Date;
    },
  ) {}

  async reset(correlationId: string): Promise<AdminDemoResetResponse> {
    const arrivedDuringReset = DemoMaintenanceService.resetPendingCount > 0;
    DemoMaintenanceService.resetPendingCount += 1;
    const operation = DemoMaintenanceService.resetTail.then(() => {
      const reset = () => this.resetWithoutConcurrentReset(correlationId, arrivedDuringReset);
      return this.options.resetWorkflowFence.runExclusive(reset);
    });
    DemoMaintenanceService.resetTail = operation.then(
      () => {
        DemoMaintenanceService.resetPendingCount -= 1;
      },
      () => {
        DemoMaintenanceService.resetPendingCount -= 1;
      },
    );
    return operation;
  }

  private async resetWithoutConcurrentReset(
    correlationId: string,
    arrivedDuringReset: boolean,
  ): Promise<AdminDemoResetResponse> {
    const now = this.now();
    const resetCandidates = await this.options.db
      .select({
        run: demoRuns,
        finalization: demoRunFinalizations,
        summary: demoRunSummaries,
      })
      .from(demoRuns)
      .leftJoin(demoRunFinalizations, eq(demoRunFinalizations.runId, demoRuns.id))
      .leftJoin(demoRunSummaries, eq(demoRunSummaries.runId, demoRuns.id))
      .where(
        or(
          and(
            inArray(demoRuns.status, ["starting", "active", "draining"]),
            isNull(demoRunSummaries.id),
          ),
          and(
            eq(demoRuns.status, "failed"),
            eq(demoRuns.failureReason, "admin_reset"),
            isNull(demoRunSummaries.id),
          ),
        ),
      );

    const projectionRetryRows = await this.options.db
      .select({ runId: demoRuns.id })
      .from(demoRuns)
      .innerJoin(demoRunSummaries, eq(demoRunSummaries.runId, demoRuns.id))
      .where(and(eq(demoRuns.status, "failed"), eq(demoRuns.failureReason, "admin_reset")));

    const fencedRuns: FencedResetRun[] = [];
    for (const candidate of resetCandidates) {
      if (candidate.run.status === "failed") {
        fencedRuns.push({
          run: candidate.run,
          finalization: candidate.finalization,
          finalizedAt: candidate.run.finalizedAt ?? now,
        });
        continue;
      }

      const claimed = await this.options.terminalRunWriter.claimTerminalRun({
        runId: candidate.run.id,
        terminalStatus: "failed",
        failureReason: "admin_reset",
        finalizedAt: now,
        allowedCurrentStatuses: ["starting", "active", "draining"],
        terminalTrafficStatus: "failed",
      });
      if (claimed) {
        fencedRuns.push({
          run: candidate.run,
          finalization: candidate.finalization,
          finalizedAt: now,
          previousStatus: candidate.run.status,
          previousTrafficStatus: candidate.run.trafficStatus,
        });
      }
    }

    let closedSaleOfferCount = 0;
    const closureFailures: unknown[] = [];
    for (const row of fencedRuns) {
      if (!row.run.saleOfferId) {
        continue;
      }
      try {
        await setRunSaleEligibility(this.options.redis, {
          runId: row.run.id,
          saleOfferId: row.run.saleOfferId,
          status: "closed",
        });
        closedSaleOfferCount += 1;
      } catch (error) {
        if (error instanceof InventoryNotInitializedError) {
          // A run that never initialized inventory has no Redis admission to
          // close; it is already fenced by the PostgreSQL terminal claim.
          continue;
        }
        closureFailures.push(error);
        this.options.logger.warn(
          { err: error, runId: row.run.id, saleOfferId: row.run.saleOfferId },
          "Could not close run sale eligibility during admin reset.",
        );
      }
    }

    if (closureFailures.length > 0) {
      throw new Error(
        `Admin reset could not close sale eligibility for ${closureFailures.length} run(s). Retry reset to resume the fenced transition.`,
      );
    }

    for (const row of fencedRuns) {
      try {
        await this.options.dashboardLiveStateReset.fenceRun(row.run.id);
      } catch (error) {
        this.options.logger.error(
          { err: error, runId: row.run.id, correlationId },
          "Could not fence dashboard metric ingestion during admin reset.",
        );
        throw new Error(
          "Admin reset could not fence dashboard metric ingestion. Retry reset to resume the fenced transition.",
        );
      }

      await this.options.trafficAborter.abortCurrent({
        runId: row.run.id,
        reason: "admin_reset",
        correlationId,
      });
    }

    const queueCleanup =
      fencedRuns.length > 0 || !arrivedDuringReset
        ? await this.options.queueMaintenance.cleanResetOwnedQueues()
        : { cleanedQueueCount: 0, cleanedJobCount: 0 };

    const summaryInputs: TerminalDemoRunSummaryInput[] = [];
    for (const fencedRun of fencedRuns) {
      const latest = await this.readResetRun(fencedRun.run.id);
      if (!latest) {
        continue;
      }

      const businessOutcome = await this.readBusinessOutcome(latest.run);
      const terminalInventorySnapshot = await this.captureTerminalInventorySnapshot({
        run: latest.run,
        businessOutcome,
        capturedAt: now,
      });
      const trafficSummary = adminResetTrafficSummary(latest.run, latest.finalization);
      summaryInputs.push({
        run: latest.run,
        terminalStatus: "failed",
        failureReason: "admin_reset",
        finalizedAt: fencedRun.finalizedAt,
        capturedAt: now,
        httpSummary: trafficSummary.httpSummary,
        trafficDeliverySummary: trafficSummary.trafficDeliverySummary,
        httpTimingBreakdownSummary: trafficSummary.httpTimingBreakdownSummary,
        loadRunDiagnosticsSummary: {
          ...trafficSummary.loadRunDiagnosticsSummary,
          failureReason: "admin_reset",
          ...(fencedRun.previousStatus ? { previousStatus: fencedRun.previousStatus } : {}),
          ...(fencedRun.previousTrafficStatus
            ? { previousTrafficStatus: fencedRun.previousTrafficStatus }
            : {}),
        },
        apiRequestLifecycleSummary: {
          ...trafficSummary.apiRequestLifecycleSummary,
          failureReason: "admin_reset",
          ...(fencedRun.previousStatus ? { previousStatus: fencedRun.previousStatus } : {}),
          ...(fencedRun.previousTrafficStatus
            ? { previousTrafficStatus: fencedRun.previousTrafficStatus }
            : {}),
          resetAt: fencedRun.finalizedAt.toISOString(),
          correlationId,
        },
        businessOutcome,
        terminalInventorySnapshot,
        allowedCurrentStatuses: ["failed"],
        terminalTrafficStatus: "failed",
      });
    }
    const failedRunCount =
      await this.options.terminalRunWriter.writeAfterTerminalClaims(summaryInputs);

    const projectionRunIds = new Set(fencedRuns.map((row) => row.run.id));
    for (const row of projectionRetryRows) {
      try {
        if (await this.options.dashboardLiveStateReset.hasRunState(row.runId)) {
          projectionRunIds.add(row.runId);
        }
      } catch (error) {
        this.options.logger.error(
          { err: error, runId: row.runId, correlationId },
          "Could not inspect dashboard live traffic metrics during admin reset retry.",
        );
        throw new Error(
          "Admin reset could not verify dashboard projection cleanup. Retry reset to finish projection cleanup.",
        );
      }
    }
    for (const runId of projectionRunIds) {
      try {
        await this.options.dashboardLiveStateReset.clearRun(runId);
      } catch (error) {
        this.options.logger.error(
          { err: error, runId, correlationId },
          "Could not clear dashboard live traffic metrics after admin reset summary.",
        );
        throw new Error(
          "Admin reset terminalized the run but could not clear its dashboard projection. Retry reset to finish projection cleanup.",
        );
      }
    }
    await this.options.clearErpCircuitBreakerState();

    return adminDemoResetResponseSchema.parse({
      failedRunCount,
      closedSaleOfferCount,
      cleanedQueueCount: queueCleanup.cleanedQueueCount,
      cleanedJobCount: queueCleanup.cleanedJobCount,
      resetAt: now.toISOString(),
      correlationId,
    });
  }

  async cleanupOldRuns(input: {
    keepLatest: number;
    olderThanDays: number;
    correlationId: string;
  }): Promise<AdminMaintenanceCleanupRunsResponse> {
    const now = this.now();
    const cutoffBefore = new Date(now.getTime() - input.olderThanDays * 24 * 60 * 60 * 1000);
    const latestRows = await this.options.db
      .select({ id: demoRuns.id })
      .from(demoRuns)
      .orderBy(desc(demoRuns.createdAt))
      .limit(input.keepLatest);
    const latestRunIds = latestRows.map((row) => row.id);
    const activeRows = await this.options.db
      .select({ id: demoRuns.id })
      .from(demoRuns)
      .where(inArray(demoRuns.status, ["starting", "active", "draining"]));
    const activeRunIds = activeRows.map((row) => row.id);

    const filters = [
      inArray(demoRuns.status, ["completed", "failed"]),
      lt(demoRuns.createdAt, cutoffBefore),
      ...(latestRunIds.length > 0 ? [notInArray(demoRuns.id, latestRunIds)] : []),
      ...(activeRunIds.length > 0 ? [notInArray(demoRuns.id, activeRunIds)] : []),
    ];
    const generatedRunCandidates = await this.options.db
      .select({ runId: demoRuns.id, saleOfferId: demoRunSaleContexts.saleOfferId })
      .from(demoRuns)
      .innerJoin(
        demoRunSaleContexts,
        and(
          eq(demoRunSaleContexts.runId, demoRuns.id),
          eq(demoRunSaleContexts.saleOfferId, demoRuns.saleOfferId),
        ),
      )
      .innerJoin(saleOffers, eq(saleOffers.id, demoRunSaleContexts.saleOfferId))
      .where(and(...filters, eq(saleOffers.purpose, "generated_run")))
      .orderBy(asc(demoRuns.createdAt));

    let deletedRunCount = 0;
    let deletedSaleOfferCount = 0;
    for (const candidate of generatedRunCandidates) {
      const result = await this.options.deleteGeneratedRunDurable(this.options.db, candidate);
      deletedRunCount += result.deletedRunCount;
      deletedSaleOfferCount += result.deletedSaleOfferCount;

      if (result.deletedRunCount === 0) {
        continue;
      }

      try {
        await this.options.deleteGeneratedRunRedisState(this.options.redis, candidate);
      } catch (error) {
        this.options.logger.warn(
          {
            err: error,
            runId: candidate.runId,
            saleOfferId: candidate.saleOfferId,
            correlationId: input.correlationId,
          },
          "Could not remove generated-run Redis state after durable cleanup.",
        );
      }
    }

    return adminMaintenanceCleanupRunsResponseSchema.parse({
      deletedRunCount,
      deletedSaleOfferCount,
      preservedLatestCount: latestRunIds.length,
      preservedActiveRunCount: activeRunIds.length,
      cutoffBefore: cutoffBefore.toISOString(),
      cleanedAt: now.toISOString(),
      correlationId: input.correlationId,
    });
  }

  async teardownGeneratedRun(input: {
    runId: string;
    correlationId: string;
  }): Promise<AdminGeneratedRunTeardownResponse> {
    const targeted = this.options.queueMaintenance;
    let lease: Awaited<ReturnType<typeof targeted.acquireGeneratedRunQuiescence>> | undefined;
    let result: AdminGeneratedRunTeardownResponse | undefined;
    let primaryError: unknown;
    let retainOwnedQueuePauses = false;
    try {
      lease = await targeted.acquireGeneratedRunQuiescence(input.runId);
      result = await this.teardownQuiescedGeneratedRun(input, targeted);
    } catch (error) {
      const failure = unwrapQueueConvergenceError(error);
      retainOwnedQueuePauses = failure.retainOwnedQueuePauses;
      primaryError = mapQueueMaintenanceError(failure.error);
      if (primaryError instanceof ApiHttpError && primaryError.statusCode === 409) {
        this.options.logger.warn(
          {
            runId: input.runId,
            correlationId: input.correlationId,
            code: primaryError.code,
          },
          "Generated demo run teardown was refused.",
        );
      }
    }

    let releaseError: unknown;
    if (lease) {
      try {
        await lease.release(
          retainOwnedQueuePauses
            ? { disposition: "retain_owned_pauses" }
            : {
                disposition: "restore_owned_pauses",
                ...(result?.outcome === "deleted"
                  ? {
                      afterRestored: async () => {
                        try {
                          await this.options.completeGeneratedRunTeardown(
                            this.options.db,
                            input.runId,
                          );
                        } catch (error) {
                          this.options.logger.warn(
                            {
                              err: error,
                              runId: input.runId,
                              saleOfferId: result.saleOfferId,
                              correlationId: input.correlationId,
                            },
                            "Generated-run external cleanup succeeded but receipt completion requires retry.",
                          );
                          throw error;
                        }
                      },
                    }
                  : {}),
              },
        );
      } catch (error) {
        releaseError = error;
      }
    }
    if (primaryError && releaseError) {
      throw new AggregateError(
        [primaryError, releaseError],
        `Generated-run teardown failed and queue state restoration also failed: ${messageOf(primaryError)}`,
      );
    }
    if (primaryError) throw primaryError;
    if (releaseError) throw releaseError;
    if (!result) throw new Error("Generated-run teardown completed without a response.");
    if (result.outcome === "deleted") {
      this.options.logger.info(result, "Generated demo run teardown completed.");
    } else {
      this.options.logger.info(result, "Generated demo run teardown was already absent.");
    }
    return result;
  }

  private async teardownQuiescedGeneratedRun(
    input: {
      runId: string;
      correlationId: string;
    },
    targeted: DemoQueueMaintenance,
  ): Promise<AdminGeneratedRunTeardownResponse> {
    const now = this.now();
    await targeted.preflightGeneratedRun(input.runId);

    const prepared = await this.options.prepareGeneratedRunTeardown(
      this.options.db,
      input.runId,
      now,
    );
    if (prepared.outcome === "absent") {
      return adminGeneratedRunTeardownResponseSchema.parse({
        outcome: "already_absent",
        runId: input.runId,
        cleanedAt: now.toISOString(),
        correlationId: input.correlationId,
      });
    }
    if (prepared.outcome !== "ready") {
      throw new ApiHttpError({
        statusCode: 409,
        code: prepared.outcome === "non_terminal" ? "run_not_terminal" : "run_ownership_mismatch",
        message:
          prepared.outcome === "non_terminal"
            ? "The generated run must be terminal before teardown."
            : "The run is not owned by a matching generated sale offer.",
      });
    }

    let queueCleanup: Awaited<ReturnType<DemoQueueMaintenance["cleanGeneratedRun"]>>;
    try {
      queueCleanup = await targeted.cleanGeneratedRun(input.runId);
    } catch (error) {
      this.options.logger.warn(
        {
          err: error,
          runId: input.runId,
          saleOfferId: prepared.saleOfferId,
          correlationId: input.correlationId,
          queuePausesRetained: true,
        },
        "Generated-run queue convergence failed after durable deletion; maintenance-owned queues remain paused for retry.",
      );
      throw new PostCommitQueueConvergenceError(error);
    }

    try {
      const redisCleanup = await this.options.deleteGeneratedRunRedisState(
        this.options.redis,
        prepared,
      );
      return adminGeneratedRunTeardownResponseSchema.parse({
        outcome: "deleted",
        runId: input.runId,
        saleOfferId: prepared.saleOfferId,
        cleanup: {
          redisKeysDeleted: redisCleanup.deletedKeyCount,
          queueJobsDeleted: queueCleanup.deletedJobCount,
        },
        cleanedAt: now.toISOString(),
        correlationId: input.correlationId,
      });
    } catch (error) {
      this.options.logger.warn(
        {
          err: error,
          runId: input.runId,
          saleOfferId: prepared.saleOfferId,
          correlationId: input.correlationId,
        },
        "Generated demo run teardown requires retry after durable deletion.",
      );
      throw error;
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async readResetRun(runId: string): Promise<{
    run: typeof demoRuns.$inferSelect;
    finalization: typeof demoRunFinalizations.$inferSelect | null;
  } | null> {
    const [row] = await this.options.db
      .select({ run: demoRuns, finalization: demoRunFinalizations })
      .from(demoRuns)
      .leftJoin(demoRunFinalizations, eq(demoRunFinalizations.runId, demoRuns.id))
      .where(eq(demoRuns.id, runId))
      .limit(1);

    return row ?? null;
  }

  private async readBusinessOutcome(
    run: typeof demoRuns.$inferSelect,
  ): Promise<BusinessOutcomeSummary> {
    if (!run.saleOfferId) {
      return emptyBusinessOutcomeSummary();
    }

    return readBusinessOutcomeSummary(this.options.db, {
      saleOfferId: run.saleOfferId,
      runId: run.id,
    });
  }

  private async captureTerminalInventorySnapshot(input: {
    run: typeof demoRuns.$inferSelect;
    businessOutcome: BusinessOutcomeSummary;
    capturedAt: Date;
  }): Promise<TerminalInventorySnapshot | null> {
    if (!input.run.saleOfferId) {
      return null;
    }

    try {
      const inventory = await getInventoryStatus(
        this.options.redis,
        input.run.saleOfferId,
        input.capturedAt,
      );
      return {
        saleOfferId: input.run.saleOfferId,
        startingStock: inventory.allocatedStock,
        remainingStock: inventory.remainingStock,
        reservedStock: inventory.reservedStock,
        acceptedReservations: input.businessOutcome.acceptedReservations,
        soldOutRejections: await this.readSoldOutRejections(input.run.id, inventory),
        pendingPersistenceCount: inventory.pendingPersistenceCount,
        capturedAt: input.capturedAt.toISOString(),
        source: "redis",
      };
    } catch (error) {
      this.options.logger.warn(
        { err: error, runId: input.run.id, saleOfferId: input.run.saleOfferId },
        "Could not capture terminal inventory snapshot during admin reset.",
      );
      return null;
    }
  }

  private async readSoldOutRejections(
    runId: string,
    inventory: Awaited<ReturnType<typeof getInventoryStatus>>,
  ): Promise<number> {
    const [row] = await this.options.db
      .select({ count: demoRunReservationOutcomes.count })
      .from(demoRunReservationOutcomes)
      .where(
        and(
          eq(demoRunReservationOutcomes.runId, runId),
          eq(demoRunReservationOutcomes.outcome, "api_sold_out_decision"),
        ),
      )
      .limit(1);

    return row?.count ?? inventory.soldOutPressure.rejectionCount;
  }
}

function mapQueueMaintenanceError(error: unknown): unknown {
  if (!(error instanceof DemoQueueMaintenanceConflict)) return error;
  const code =
    error.code === "active_job"
      ? "run_queue_job_active"
      : error.code === "maintenance_owned_by_other_run"
        ? "run_queue_maintenance_owned_by_other_run"
        : error.code === "malformed_claimed_job"
          ? "run_queue_job_malformed"
          : "run_queue_not_quiescent";
  return new ApiHttpError({ statusCode: 409, code, message: error.message });
}

class PostCommitQueueConvergenceError extends Error {
  constructor(readonly originalError: unknown) {
    super("Generated-run queue convergence failed after durable deletion.", {
      cause: originalError,
    });
    this.name = "PostCommitQueueConvergenceError";
  }
}

function unwrapQueueConvergenceError(error: unknown): {
  error: unknown;
  retainOwnedQueuePauses: boolean;
} {
  return error instanceof PostCommitQueueConvergenceError
    ? { error: error.originalError, retainOwnedQueuePauses: true }
    : { error, retainOwnedQueuePauses: false };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function adminResetTrafficSummary(
  run: typeof demoRuns.$inferSelect,
  finalization: typeof demoRunFinalizations.$inferSelect | null,
): {
  httpSummary: TrafficHttpSummary;
  trafficDeliverySummary: TrafficDeliverySummary;
  httpTimingBreakdownSummary: Record<string, unknown>;
  loadRunDiagnosticsSummary: Record<string, unknown>;
  apiRequestLifecycleSummary: Record<string, unknown>;
} {
  if (finalization) {
    return {
      httpSummary: normalizePersistedTrafficHttpSummary(finalization.httpSummary),
      trafficDeliverySummary: normalizeTrafficDeliverySummary(finalization.trafficDeliverySummary),
      httpTimingBreakdownSummary: finalization.httpTimingBreakdownSummary,
      loadRunDiagnosticsSummary: normalizeLegacyLoadRunDiagnosticsSummaryJson(
        finalization.loadRunDiagnosticsSummary,
      ),
      apiRequestLifecycleSummary: normalizeLegacyApiRequestLifecycleSummaryJson(
        finalization.apiRequestLifecycleSummary,
        finalization.httpSummary.plannedRequests,
      ),
    };
  }

  const summary = failedBeforeTrafficCompletionSummary(
    acceptedRunConfigSnapshotSchema.parse(run.configSnapshot),
  );

  return {
    httpSummary: summary.httpSummary,
    trafficDeliverySummary: summary.trafficDeliverySummary,
    httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
    loadRunDiagnosticsSummary: {},
    apiRequestLifecycleSummary: {},
  };
}

function failedBeforeTrafficCompletionSummary(config: AcceptedRunConfigSnapshot): {
  httpSummary: TrafficHttpSummary;
  trafficDeliverySummary: TrafficDeliverySummary;
} {
  const plannedRequests = plannedTrafficRequests(config.trafficConfig);

  return {
    httpSummary: {
      plannedRequests,
      startedRequests: 0,
      completedRequests: 0,
      interruptedRequests: 0,
      unstartedRequests: plannedRequests,
      failedRequests: 0,
      acceptedResponses: 0,
      soldOutResponses: 0,
      unexpectedResponses: 0,
      failureRate: 0,
    },
    trafficDeliverySummary: syntheticTrafficDeliverySummary(config, [
      "Admin reset failed the run before traffic completion.",
    ]),
  };
}

function plannedTrafficRequests(config: TrafficConfig): number {
  if (config.mode === "buyer-spike") {
    return config.buyerCount * (config.duplicateEachBuyerAttempt ? 2 : 1);
  }

  return config.ratePerSecond * config.durationSeconds;
}

function emptyBusinessOutcomeSummary(): BusinessOutcomeSummary {
  return {
    acceptedReservations: 0,
    soldOutRejections: 0,
    queuedOrders: 0,
    processingOrders: 0,
    retryingOrders: 0,
    confirmedOrders: 0,
    failedOrders: 0,
    pendingPersistenceCount: 0,
    notificationsRecorded: 0,
  };
}
