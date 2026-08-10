import {
  type AdminDemoResetResponse,
  adminDemoResetResponseSchema,
  type BusinessOutcomeSummary,
  emptyHttpTimingBreakdownSummary,
  emptyServerReservationTimingSummary,
  httpTimingBreakdownSummarySchema,
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
  demoRunFinalizations,
  demoRunSoldOutCounts,
  demoRunSummaries,
  demoRuns,
  getInventoryStatus,
  InventoryNotInitializedError,
  readBusinessOutcomeSummary,
  setRunSaleEligibility,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { DemoMaintenanceAuthority } from "./demo-maintenance-authority.js";
import type { ExactRunQueueMaintenance } from "./demo-queue-maintenance.js";
import { emptyBusinessOutcomeSummary } from "./demo-run-projections.js";
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

export interface AdminDemoResetWorkflow {
  reset(correlationId: string): Promise<AdminDemoResetResponse>;
}

export class AdminDemoResetService implements AdminDemoResetWorkflow {
  constructor(
    private readonly options: {
      db: CheckoutSurgeDatabase;
      redis: CheckoutSurgeRedis;
      queueMaintenance: ExactRunQueueMaintenance;
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
      now?: () => Date;
    },
  ) {}

  async reset(correlationId: string): Promise<AdminDemoResetResponse> {
    return this.options.maintenanceAuthority.runExclusive(() =>
      this.options.resetWorkflowFence.runExclusive(() =>
        this.resetWithoutConcurrentReset(correlationId),
      ),
    );
  }

  private async resetWithoutConcurrentReset(
    correlationId: string,
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
            isNull(demoRuns.adminResetCompletedAt),
          ),
        ),
      );

    const projectionRetryRows = await this.options.db
      .select({ runId: demoRuns.id })
      .from(demoRuns)
      .where(
        and(
          eq(demoRuns.status, "failed"),
          eq(demoRuns.failureReason, "admin_reset"),
          isNotNull(demoRuns.adminResetCompletedAt),
        ),
      );

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
      fencedRuns.length > 0
        ? await this.options.queueMaintenance.cleanRuns(fencedRuns.map(({ run }) => run.id))
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
        replayPossible: isReplayPossible(
          parsePersistedAcceptedRunConfigSnapshot(
            latest.run.configSnapshot,
            `demo run ${latest.run.id}`,
          ),
        ),
        finalizedAt: fencedRun.finalizedAt,
        capturedAt: now,
        adminResetCompletedAt: now,
        transportAttemptCounts: trafficSummary.transportAttemptCounts,
        httpSummary: trafficSummary.httpSummary,
        trafficDeliverySummary: trafficSummary.trafficDeliverySummary,
        httpTimingBreakdownSummary: trafficSummary.httpTimingBreakdownSummary,
        serverReservationTimingSummary: await this.readReservationTiming(latest.run.id),
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
        runSignalTimelineSummary: null,
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
      try {
        await this.options.reservationTiming?.clearRun(runId);
      } catch (error) {
        this.options.logger.warn(
          { err: error, runId, correlationId },
          "Could not clear advisory reservation timing after admin reset.",
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
