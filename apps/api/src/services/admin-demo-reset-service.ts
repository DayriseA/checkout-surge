import {
  type AdminDemoResetResponse,
  adminDemoResetResponseSchema,
  automaticRunResetDeadlineSeconds,
  type BusinessOutcomeSummary,
  type DestructiveResetReason,
  destructiveResetReasonValues,
  emptyHttpTimingBreakdownSummary,
  emptyServerReservationTimingSummary,
  httpTimingBreakdownSummarySchema,
  isDestructiveResetReason,
  isReplayPossible,
  realLoadRunDiagnosticsSummarySchema,
  type TerminalInventorySnapshot,
  type TrafficDeliverySummary,
  type TrafficHttpSummary,
  type TransportAttemptCounts,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  deleteGeneratedRunRedisState,
  demoRunFinalizations,
  demoRunSoldOutCounts,
  demoRunSummaries,
  demoRuns,
  getInventoryStatus,
  InventoryNotInitializedError,
  publishDashboardProjectionDirtySignal,
  purgeResetRunDurable,
  readBusinessOutcomeSummary,
  setRunSaleEligibility,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { ApiHttpError } from "../runtime/errors.js";
import type { DemoMaintenanceAuthority } from "./demo-maintenance-authority.js";
import type { ExactRunQueueMaintenance } from "./demo-queue-maintenance.js";
import { DemoQueueMaintenanceConflict } from "./demo-queue-maintenance.js";
import { emptyBusinessOutcomeSummary } from "./demo-run-projections.js";
import {
  publishDemoRunProjectionDirty,
  readDemoRunSnapshot,
} from "./demo-run-snapshot-operations.js";
import { incompleteAdminResetPredicate } from "./incomplete-admin-reset.js";
import type { OrderProcessQueueLimits } from "./order-process-queue-limits.js";
import {
  parsePersistedAcceptedRunConfigSnapshot,
  parsePersistedState,
} from "./persisted-demo-run-state.js";
import type { DemoResetWorkflowFence } from "./postgres-demo-reset-workflow-fence.js";
import type { ReservationTimingLifecycle } from "./reservation-timing-observation.js";
import type {
  TerminalDemoRunSummaryInput,
  TerminalDemoRunWriter,
} from "./terminal-demo-run-writer.js";
import {
  parsePersistedTrafficDeliverySummary,
  parsePersistedTrafficHttpSummary,
  parsePersistedTransportAttemptCounts,
} from "./traffic-delivery-classifier.js";
import { syntheticFailedTrafficSummary } from "./traffic-delivery-plan.js";
import type { TrafficAbortGateway } from "./traffic-execution-gateway.js";

// Projection/shared-state retries must survive metric deletion and API recreation.
const pendingResetProjectionKey = "demo-reset:pending-projection-runs";

type FencedResetRun = {
  run: typeof demoRuns.$inferSelect;
  finalization: typeof demoRunFinalizations.$inferSelect | null;
  finalizedAt: Date;
  reason: DestructiveResetReason;
  previousStatus?: typeof demoRuns.$inferSelect.status;
  previousTrafficStatus?: typeof demoRuns.$inferSelect.trafficStatus;
};

export interface DashboardLiveStateReset {
  fenceRun(runId: string): Promise<void>;
  clearRun(runId: string): Promise<void>;
  hasRunState(runId: string): Promise<boolean>;
}

export interface AdminDemoResetWorkflow {
  reset(correlationId: string, reason: DestructiveResetReason): Promise<AdminDemoResetResponse>;
}

export class AdminDemoResetService implements AdminDemoResetWorkflow {
  constructor(
    private readonly options: {
      db: CheckoutSurgeDatabase;
      redis: CheckoutSurgeRedis;
      queueMaintenance: ExactRunQueueMaintenance;
      queueLimits: OrderProcessQueueLimits;
      terminalRunWriter: Pick<
        TerminalDemoRunWriter,
        "claimTerminalRun" | "writeAfterTerminalClaims"
      >;
      logger: CheckoutSurgeLogger;
      clearErpCircuitBreakerState: () => Promise<void>;
      trafficAborter: TrafficAbortGateway;
      dashboardLiveStateReset: DashboardLiveStateReset;
      reservationTiming?: ReservationTimingLifecycle;
      resetWorkflowFence: DemoResetWorkflowFence;
      maintenanceAuthority: DemoMaintenanceAuthority;
      deleteGeneratedRunRedisState?: typeof deleteGeneratedRunRedisState;
      purgeResetRunDurable?: typeof purgeResetRunDurable;
      now?: () => Date;
      elapsedNow?: () => number;
    },
  ) {}

  async reset(
    correlationId: string,
    reason: DestructiveResetReason = "admin_reset",
  ): Promise<AdminDemoResetResponse> {
    return this.options.maintenanceAuthority.runExclusive(() =>
      this.options.resetWorkflowFence.runExclusive(async () => {
        const result = await this.resetWithoutConcurrentReset(correlationId, reason);
        await this.options.queueLimits.synchronize();
        return result;
      }),
    );
  }

  async hasPendingAutomaticResetCleanup(): Promise<boolean> {
    // This marker survives durable purge and dashboard metric deletion until all cleanup succeeds.
    const runIds = await this.options.redis.smembers(pendingResetProjectionKey);
    if (runIds.length === 0) return false;
    const [run] = await this.options.db
      .select({ id: demoRuns.id })
      .from(demoRuns)
      .where(
        and(
          inArray(demoRuns.id, runIds),
          eq(demoRuns.status, "failed"),
          eq(demoRuns.failureReason, "auto_reset"),
        ),
      )
      .limit(1);
    return run !== undefined;
  }

  private async resetWithoutConcurrentReset(
    correlationId: string,
    reason: DestructiveResetReason,
  ): Promise<AdminDemoResetResponse> {
    const now = this.now();
    const elapsedNow = this.options.elapsedNow ?? (() => performance.now());
    const requestStartedAt = elapsedNow();
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
            reason === "auto_reset"
              ? lte(
                  demoRuns.startedAt,
                  new Date(now.getTime() - automaticRunResetDeadlineSeconds * 1000),
                )
              : undefined,
          ),
          incompleteAdminResetPredicate(),
        ),
      );

    const projectionRetryRows = await this.options.db
      .select({ runId: demoRuns.id })
      .from(demoRuns)
      .where(
        and(
          eq(demoRuns.status, "failed"),
          inArray(demoRuns.failureReason, destructiveResetReasonValues),
          isNotNull(demoRuns.adminResetCompletedAt),
        ),
      );

    const pendingProjectionRunIds = new Set(
      await this.options.redis.smembers(pendingResetProjectionKey),
    );
    if (pendingProjectionRunIds.size > 0) {
      const existingPendingRows = await this.options.db
        .select({ runId: demoRuns.id })
        .from(demoRuns)
        .where(inArray(demoRuns.id, [...pendingProjectionRunIds]));
      const existingPendingRunIds = new Set(existingPendingRows.map((row) => row.runId));
      const orphanedRunIds = [...pendingProjectionRunIds].filter(
        (runId) => !existingPendingRunIds.has(runId),
      );
      if (orphanedRunIds.length > 0) {
        await this.options.redis.srem(pendingResetProjectionKey, ...orphanedRunIds);
      }
    }
    const projectionRunIds = new Set<string>();
    for (const row of projectionRetryRows) {
      try {
        if (
          pendingProjectionRunIds.has(row.runId) ||
          (await this.options.dashboardLiveStateReset.hasRunState(row.runId))
        ) {
          projectionRunIds.add(row.runId);
        }
      } catch (error) {
        this.options.logger.error(
          { err: error, runId: row.runId, correlationId },
          "Could not inspect dashboard live traffic metrics during admin reset retry.",
        );
        throw new ApiHttpError({
          statusCode: 503,
          code: "run_cleanup_conflict",
          message:
            "Admin reset could not verify dashboard projection cleanup. Retry reset to finish projection cleanup.",
          details: { conflictReason: "projection_cleanup_incomplete" },
        });
      }
    }

    const fencedRuns: FencedResetRun[] = [];
    for (const candidate of resetCandidates) {
      // Finish a previous marker-backed projection retry before stopping a successor.
      if (projectionRunIds.size > 0 && candidate.run.status !== "failed") continue;
      if (candidate.run.status === "failed") {
        fencedRuns.push({
          run: candidate.run,
          finalization: candidate.finalization,
          finalizedAt: candidate.run.finalizedAt ?? now,
          reason: isDestructiveResetReason(candidate.run.failureReason)
            ? candidate.run.failureReason
            : reason,
        });
        continue;
      }

      const claimed = await this.options.terminalRunWriter.claimTerminalRun({
        runId: candidate.run.id,
        terminalStatus: "failed",
        failureReason: reason,
        finalizedAt: now,
        allowedCurrentStatuses: ["starting", "active", "draining"],
        terminalTrafficStatus: "failed",
      });
      if (claimed) {
        fencedRuns.push({
          run: candidate.run,
          finalization: candidate.finalization,
          finalizedAt: now,
          reason,
          previousStatus: candidate.run.status,
          previousTrafficStatus: candidate.run.trafficStatus,
        });
      }
    }

    // A poll can lose to a completed reset and a newly admitted successor.
    // Do not clear the successor's shared state when nothing is due anymore.
    if (reason === "auto_reset" && fencedRuns.length === 0 && projectionRunIds.size === 0) {
      return adminDemoResetResponseSchema.parse({
        failedRunCount: 0,
        closedSaleOfferCount: 0,
        cleanedQueueCount: 0,
        cleanedJobCount: 0,
        resetAt: now.toISOString(),
        correlationId,
      });
    }

    for (const row of fencedRuns) {
      if (row.reason === "auto_reset") {
        this.options.logger.info(
          { runId: row.run.id, correlationId },
          "Automatically resetting overdue demo run.",
        );
      }
      await this.publishRecoveryDirty(row.run.id, correlationId);
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
        reason: row.reason,
        correlationId,
      });
    }

    const queueCleanup =
      fencedRuns.length > 0
        ? await this.options.queueMaintenance
            .cleanRuns(
              fencedRuns.map(({ run }) => run.id),
              {
                // Abort permits 20s; runtime-reset allows 30s per response. Caddy and
                // Fastify configure no shorter response deadline. Allow at most 5s
                // settlement, stop by request elapsed 25s, reserving 5s for evidence,
                // history and response. This bounds polling, not all dependency I/O.
                deadline: Math.min(elapsedNow() + 5_000, requestStartedAt + 25_000),
              },
            )
            .catch((error: unknown) => {
              if (!(error instanceof DemoQueueMaintenanceConflict)) throw error;
              throw new ApiHttpError({
                statusCode: 409,
                code: "run_cleanup_conflict",
                message: error.message,
                details: { conflictReason: error.code },
              });
            })
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
        capturedAt: this.now(),
      });
      const trafficSummary = adminResetTrafficSummary(latest.run, latest.finalization);
      summaryInputs.push({
        run: latest.run,
        terminalStatus: "failed",
        failureReason: fencedRun.reason,
        replayPossible: isReplayPossible(
          parsePersistedAcceptedRunConfigSnapshot(
            latest.run.configSnapshot,
            `demo run ${latest.run.id}`,
          ),
        ),
        finalizedAt: fencedRun.finalizedAt,
        transportAttemptCounts: trafficSummary.transportAttemptCounts,
        httpSummary: trafficSummary.httpSummary,
        trafficDeliverySummary: trafficSummary.trafficDeliverySummary,
        httpTimingBreakdownSummary: trafficSummary.httpTimingBreakdownSummary,
        serverReservationTimingSummary: await this.readReservationTiming(latest.run.id),
        loadRunDiagnosticsSummary: {
          ...trafficSummary.loadRunDiagnosticsSummary,
          failureReason: fencedRun.reason,
          ...(fencedRun.previousStatus ? { previousStatus: fencedRun.previousStatus } : {}),
          ...(fencedRun.previousTrafficStatus
            ? { previousTrafficStatus: fencedRun.previousTrafficStatus }
            : {}),
        },
        businessOutcome,
        terminalInventorySnapshot,
        runSignalTimelineSummary: null,
        allowedCurrentStatuses: ["failed"],
        terminalTrafficStatus: "failed",
        capturedAt: this.now(),
      });
    }
    if (fencedRuns.length > 0) {
      await this.options.redis.sadd(
        pendingResetProjectionKey,
        ...fencedRuns.map((row) => row.run.id),
      );
    }
    const failedRunCount =
      await this.options.terminalRunWriter.writeAfterTerminalClaims(summaryInputs);

    for (const row of fencedRuns) await this.publishRecoveryDirty(row.run.id, correlationId);

    for (const row of fencedRuns) {
      await (this.options.purgeResetRunDurable ?? purgeResetRunDurable)(this.options.db, {
        runId: row.run.id,
        failureReason: row.reason,
      });
      await (this.options.deleteGeneratedRunRedisState ?? deleteGeneratedRunRedisState)(
        this.options.redis,
        {
          runId: row.run.id,
          saleOfferId: row.run.saleOfferId,
        },
      );
      await this.options.db
        .update(demoRuns)
        .set({ adminResetCompletedAt: this.now() })
        .where(and(eq(demoRuns.id, row.run.id), isNull(demoRuns.adminResetCompletedAt)));
    }

    for (const row of fencedRuns) projectionRunIds.add(row.run.id);
    for (const runId of projectionRunIds) {
      try {
        await this.options.dashboardLiveStateReset.clearRun(runId);
      } catch (error) {
        this.options.logger.error(
          { err: error, runId, correlationId },
          "Could not clear dashboard live traffic metrics after admin reset summary.",
        );
        throw new ApiHttpError({
          statusCode: 503,
          code: "run_cleanup_conflict",
          message:
            "Admin reset terminalized the run but could not clear its dashboard projection. Retry reset to finish projection cleanup.",
          details: { conflictReason: "projection_cleanup_incomplete" },
        });
      }
      try {
        await this.options.reservationTiming?.clearRun(runId);
      } catch (error) {
        this.options.logger.warn(
          { err: error, runId, correlationId },
          "Could not clear advisory reservation timing after admin reset.",
        );
      }
    }
    await this.options.clearErpCircuitBreakerState().catch(() => {
      throw new ApiHttpError({
        statusCode: 503,
        code: "run_cleanup_conflict",
        message: "Work cleanup and history completed; retry Reset to finish shared-state cleanup.",
        details: { conflictReason: "projection_cleanup_incomplete" },
      });
    });

    if (projectionRunIds.size > 0) {
      await publishDashboardProjectionDirtySignal(this.options.redis, {
        type: "dashboard.projection.dirty",
        correlationId,
      }).catch((error: unknown) => {
        this.options.logger.warn(
          { err: error, correlationId },
          "Could not publish the ready projection after admin reset.",
        );
      });
    }
    if (projectionRunIds.size > 0) {
      await this.options.redis.srem(pendingResetProjectionKey, ...projectionRunIds);
    }

    return adminDemoResetResponseSchema.parse({
      failedRunCount,
      closedSaleOfferCount,
      cleanedQueueCount: queueCleanup.cleanedQueueCount,
      cleanedJobCount: queueCleanup.cleanedJobCount,
      resetAt: now.toISOString(),
      correlationId,
    });
  }

  private async publishRecoveryDirty(runId: string, correlationId: string): Promise<void> {
    try {
      const run = await readDemoRunSnapshot(this.options.db, runId);
      await publishDemoRunProjectionDirty(this.options.redis, this.options.logger, {
        run,
        correlationId,
      });
    } catch (error) {
      this.options.logger.warn(
        { err: error, runId, correlationId },
        "Could not read run snapshot for admin reset projection publication.",
      );
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async readReservationTiming(runId: string) {
    if (!this.options.reservationTiming) return emptyServerReservationTimingSummary;
    try {
      return await this.options.reservationTiming.readAndFence(runId);
    } catch (error) {
      this.options.logger.warn(
        { err: error, runId },
        "Could not capture advisory server-side reservation timing during admin reset.",
      );
      return emptyServerReservationTimingSummary;
    }
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
    const timing = parsePersistedState(
      httpTimingBreakdownSummarySchema,
      finalization.httpTimingBreakdownSummary,
      context,
      "httpTimingBreakdownSummary",
    );
    const diagnostics = parsePersistedState(
      realLoadRunDiagnosticsSummarySchema,
      finalization.loadRunDiagnosticsSummary,
      context,
      "loadRunDiagnosticsSummary",
    );
    const transportAttemptCounts = parsePersistedTransportAttemptCounts(
      finalization.transportAttemptCounts,
      context,
    );
    return {
      transportAttemptCounts,
      httpSummary: parsePersistedTrafficHttpSummary(finalization.httpSummary, context),
      trafficDeliverySummary: parsePersistedTrafficDeliverySummary(
        finalization.trafficDeliverySummary,
        transportAttemptCounts,
        context,
      ),
      httpTimingBreakdownSummary: timing,
      loadRunDiagnosticsSummary: diagnostics,
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
