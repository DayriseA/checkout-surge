import {
  type AdminDemoResetResponse,
  type AdminGeneratedRunTeardownResponse,
  type AdminMaintenanceCleanupRunsResponse,
  adminDemoResetResponseSchema,
  adminGeneratedRunTeardownResponseSchema,
  adminMaintenanceCleanupRunsResponseSchema,
  type BusinessOutcomeSummary,
  emptyHttpTimingBreakdownSummary,
  httpTimingBreakdownSummarySchema,
  realLoadRunDiagnosticsSummarySchema,
  type TerminalInventorySnapshot,
  type TrafficDeliverySummary,
  type TrafficHttpSummary,
  type TransportAttemptCounts,
  transportAttemptCountsSchema,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  type completeGeneratedRunTeardown,
  type deleteGeneratedRunDurable,
  type deleteGeneratedRunRedisState,
  demoRunFinalizations,
  demoRunSaleContexts,
  demoRunSoldOutCounts,
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
import { emptyBusinessOutcomeSummary } from "./demo-run-projections.js";
import { parsePersistedAcceptedRunConfigSnapshot } from "./persisted-demo-run-state.js";
import type { DemoResetWorkflowFence } from "./postgres-demo-reset-workflow-fence.js";
import type {
  TerminalDemoRunSummaryInput,
  TerminalDemoRunWriter,
} from "./terminal-demo-run-writer.js";
import {
  parsePersistedTrafficDeliverySummary,
  parsePersistedTrafficHttpSummary,
} from "./traffic-delivery-classifier.js";
import { syntheticFailedTrafficSummary } from "./traffic-delivery-plan.js";
import type { TrafficAbortGateway } from "./traffic-execution-gateway.js";

export interface QueueCleanupSummary {
  cleanedQueueCount: number;
  cleanedJobCount: number;
}

export interface DemoQueueQuiescenceLease {
  /** Restores every queue pause introduced by this maintenance operation. */
  release(): Promise<void>;
}

export interface DemoQueueMaintenance {
  cleanResetOwnedQueues(): Promise<QueueCleanupSummary>;
  acquireGeneratedRunQuiescence(runId: string): Promise<DemoQueueQuiescenceLease>;
  preflightGeneratedRun(runId: string): Promise<void>;
  cleanGeneratedRun(runId: string): Promise<{ deletedJobCount: number }>;
}

export type DemoQueueMaintenanceConflictCode =
  | "active_job"
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

export interface DashboardLiveStateReset {
  fenceRun(runId: string): Promise<void>;
  clearRun(runId: string): Promise<void>;
  hasRunState(runId: string): Promise<boolean>;
}

export class DemoMaintenanceService {
  private maintenanceTail: Promise<void> = Promise.resolve();
  private resetPendingCount = 0;

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
      trafficAborter: TrafficAbortGateway;
      dashboardLiveStateReset: DashboardLiveStateReset;
      resetWorkflowFence: DemoResetWorkflowFence;
      now?: () => Date;
    },
  ) {}

  async reset(correlationId: string): Promise<AdminDemoResetResponse> {
    const arrivedDuringReset = this.resetPendingCount > 0;
    this.resetPendingCount += 1;
    const operation = this.runSerializedMaintenance(() =>
      this.options.resetWorkflowFence.runExclusive(() =>
        this.resetWithoutConcurrentReset(correlationId, arrivedDuringReset),
      ),
    );
    return operation.finally(() => {
      this.resetPendingCount -= 1;
    });
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
        transportAttemptCounts: trafficSummary.transportAttemptCounts,
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
    return this.runSerializedMaintenance(() => this.cleanupOldRunsSerialized(input));
  }

  private async cleanupOldRunsSerialized(input: {
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
    return this.runSerializedMaintenance(() => this.teardownGeneratedRunSerialized(input));
  }

  private async teardownGeneratedRunSerialized(input: {
    runId: string;
    correlationId: string;
  }): Promise<AdminGeneratedRunTeardownResponse> {
    const targeted = this.options.queueMaintenance;
    let lease: Awaited<ReturnType<typeof targeted.acquireGeneratedRunQuiescence>> | undefined;
    let result: AdminGeneratedRunTeardownResponse | undefined;
    let primaryError: unknown;
    try {
      lease = await targeted.acquireGeneratedRunQuiescence(input.runId);
      result = await this.teardownQuiescedGeneratedRun(input, targeted);
    } catch (error) {
      primaryError = mapQueueMaintenanceError(error);
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
    } finally {
      if (lease) {
        try {
          await lease.release();
        } catch (error) {
          this.options.logger.warn(
            { err: error, runId: input.runId, correlationId: input.correlationId },
            "Generated-run teardown could not restore queue availability; retry the same cleanup request.",
          );
          primaryError = primaryError
            ? new AggregateError(
                [primaryError, error],
                `Generated-run teardown failed and queue state restoration also failed: ${messageOf(primaryError)}`,
              )
            : error;
        }
      }
    }
    if (primaryError) throw primaryError;
    if (!result) throw new Error("Generated-run teardown completed without a response.");
    if (result.outcome === "deleted") {
      try {
        await this.options.completeGeneratedRunTeardown(this.options.db, input.runId);
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
        code: "run_cleanup_conflict",
        message:
          prepared.outcome === "non_terminal"
            ? "The generated run must be terminal before teardown."
            : "The run is not owned by a matching generated sale offer.",
        details: { conflictReason: prepared.outcome },
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
          queueResumeWillBeAttempted: true,
        },
        "Generated-run queue convergence failed after durable deletion; queue availability will be restored before returning the retryable failure.",
      );
      throw error;
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

  private runSerializedMaintenance<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.maintenanceTail.then(operation);
    this.maintenanceTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
      .select({ count: demoRunSoldOutCounts.count })
      .from(demoRunSoldOutCounts)
      .where(eq(demoRunSoldOutCounts.runId, runId))
      .limit(1);

    return row?.count ?? inventory.soldOutPressure.rejectionCount;
  }
}

function mapQueueMaintenanceError(error: unknown): unknown {
  if (!(error instanceof DemoQueueMaintenanceConflict)) return error;
  return new ApiHttpError({
    statusCode: 409,
    code: "run_cleanup_conflict",
    message: error.message,
    details: { conflictReason: error.code },
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function adminResetTrafficSummary(
  run: typeof demoRuns.$inferSelect,
  finalization: typeof demoRunFinalizations.$inferSelect | null,
): {
  transportAttemptCounts: TransportAttemptCounts;
  httpSummary: TrafficHttpSummary;
  trafficDeliverySummary: TrafficDeliverySummary;
  httpTimingBreakdownSummary: Record<string, unknown>;
  loadRunDiagnosticsSummary: Record<string, unknown>;
} {
  if (finalization) {
    const context = `demo run ${run.id} finalization used by admin reset`;
    const timing = httpTimingBreakdownSummarySchema.safeParse(
      finalization.httpTimingBreakdownSummary,
    );
    if (!timing.success) {
      throw invalidAdminResetFinalizationField(context, "httpTimingBreakdownSummary", timing.error);
    }
    const diagnostics = realLoadRunDiagnosticsSummarySchema.safeParse(
      finalization.loadRunDiagnosticsSummary,
    );
    if (!diagnostics.success) {
      throw invalidAdminResetFinalizationField(
        context,
        "loadRunDiagnosticsSummary",
        diagnostics.error,
      );
    }
    const transportAttemptCounts = transportAttemptCountsSchema.safeParse(
      finalization.transportAttemptCounts,
    );
    if (!transportAttemptCounts.success) {
      throw invalidAdminResetFinalizationField(
        context,
        "transportAttemptCounts",
        transportAttemptCounts.error,
      );
    }
    return {
      transportAttemptCounts: transportAttemptCounts.data,
      httpSummary: parsePersistedTrafficHttpSummary(finalization.httpSummary, context),
      trafficDeliverySummary: parsePersistedTrafficDeliverySummary(
        finalization.trafficDeliverySummary,
        transportAttemptCounts.data,
        context,
      ),
      httpTimingBreakdownSummary: timing.data,
      loadRunDiagnosticsSummary: diagnostics.data,
    };
  }

  const summary = syntheticFailedTrafficSummary(
    parsePersistedAcceptedRunConfigSnapshot(run.configSnapshot, `demo run ${run.id} admin reset`),
    ["Admin reset failed the run before traffic completion."],
  );

  return {
    transportAttemptCounts: summary.transportAttemptCounts,
    httpSummary: summary.httpSummary,
    trafficDeliverySummary: summary.trafficDeliverySummary,
    httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
    loadRunDiagnosticsSummary: {},
  };
}

function invalidAdminResetFinalizationField(
  context: string,
  field: string,
  error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> },
): Error {
  const issues = error.issues
    .map((issue) => `${field}.${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  return new Error(`Invalid persisted ${field} for ${context}: ${issues}`, { cause: error });
}
