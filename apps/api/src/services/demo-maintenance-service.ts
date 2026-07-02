import {
  type AcceptedRunConfigSnapshot,
  type AdminDemoResetResponse,
  type AdminMaintenanceCleanupRunsResponse,
  acceptedRunConfigSnapshotSchema,
  adminDemoResetResponseSchema,
  adminMaintenanceCleanupRunsResponseSchema,
  type BusinessOutcomeSummary,
  type TerminalInventorySnapshot,
  type TrafficConfig,
  type TrafficDeliverySummary,
  type TrafficHttpSummary,
  trafficDeliverySummarySchema,
  trafficHttpSummarySchema,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  demoRunFinalizations,
  demoRunReservationOutcomes,
  demoRunSaleContexts,
  demoRunSummaries,
  demoRuns,
  erpAttempts,
  getInventoryStatus,
  orderEvents,
  orders,
  readBusinessOutcomeSummary,
  reservationPendingPersistence,
  reservations,
  saleOffers,
  setRunSaleEligibility,
  simulatedNotifications,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, desc, eq, inArray, lt, notInArray } from "drizzle-orm";
import { PostgresTerminalDemoRunSummaryWriter } from "./terminal-demo-run-transition.js";

export interface QueueCleanupSummary {
  cleanedQueueCount: number;
  cleanedJobCount: number;
}

export interface DemoQueueMaintenance {
  cleanResetOwnedQueues(): Promise<QueueCleanupSummary>;
}

export class DemoMaintenanceService {
  private readonly terminalRunWriter: PostgresTerminalDemoRunSummaryWriter;

  constructor(
    private readonly options: {
      db: CheckoutSurgeDatabase;
      redis: CheckoutSurgeRedis;
      queueMaintenance: DemoQueueMaintenance;
      logger: CheckoutSurgeLogger;
      now?: () => Date;
    },
  ) {
    this.terminalRunWriter = new PostgresTerminalDemoRunSummaryWriter(options.db);
  }

  async reset(correlationId: string): Promise<AdminDemoResetResponse> {
    const now = this.now();
    const activeRuns = await this.options.db
      .select({ run: demoRuns, finalization: demoRunFinalizations })
      .from(demoRuns)
      .leftJoin(demoRunFinalizations, eq(demoRunFinalizations.runId, demoRuns.id))
      .where(inArray(demoRuns.status, ["starting", "active", "draining"]));

    let failedRunCount = 0;
    let closedSaleOfferCount = 0;
    for (const row of activeRuns) {
      const businessOutcome = await this.readBusinessOutcome(row.run);
      const terminalInventorySnapshot = await this.captureTerminalInventorySnapshot({
        run: row.run,
        businessOutcome,
        capturedAt: now,
      });
      const trafficSummary = adminResetTrafficSummary(row.run, row.finalization);
      const wroteSummary = await this.terminalRunWriter.write({
        run: row.run,
        terminalStatus: "failed",
        failureReason: "admin_reset",
        finalizedAt: now,
        httpSummary: trafficSummary.httpSummary,
        trafficDeliverySummary: trafficSummary.trafficDeliverySummary,
        httpTimingBreakdownSummary: trafficSummary.httpTimingBreakdownSummary,
        loadRunDiagnosticsSummary: {
          ...trafficSummary.loadRunDiagnosticsSummary,
          failureReason: "admin_reset",
          previousStatus: row.run.status,
          previousTrafficStatus: row.run.trafficStatus,
        },
        apiRequestLifecycleSummary: {
          ...trafficSummary.apiRequestLifecycleSummary,
          failureReason: "admin_reset",
          previousStatus: row.run.status,
          previousTrafficStatus: row.run.trafficStatus,
          resetAt: now.toISOString(),
          correlationId,
        },
        businessOutcome,
        terminalInventorySnapshot,
        allowedCurrentStatuses: ["starting", "active", "draining"],
        terminalTrafficStatus: "failed",
      });
      if (!wroteSummary) {
        continue;
      }

      failedRunCount += 1;
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
        this.options.logger.warn(
          { err: error, runId: row.run.id, saleOfferId: row.run.saleOfferId },
          "Could not close run sale eligibility during admin reset.",
        );
      }
    }

    const queueCleanup = await this.options.queueMaintenance.cleanResetOwnedQueues();

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
    const deletableRuns = await this.options.db
      .select({ id: demoRuns.id, saleOfferId: demoRuns.saleOfferId })
      .from(demoRuns)
      .where(and(...filters));
    const runIds = deletableRuns.map((run) => run.id);

    let deletedSaleOfferCount = 0;
    if (runIds.length > 0) {
      deletedSaleOfferCount = await this.options.db.transaction(async (tx) => {
        const generatedSaleOfferRows = await tx
          .select({ id: saleOffers.id })
          .from(demoRuns)
          .innerJoin(
            demoRunSaleContexts,
            and(
              eq(demoRunSaleContexts.runId, demoRuns.id),
              eq(demoRunSaleContexts.saleOfferId, demoRuns.saleOfferId),
            ),
          )
          .innerJoin(saleOffers, eq(saleOffers.id, demoRunSaleContexts.saleOfferId))
          .where(and(inArray(demoRuns.id, runIds), eq(saleOffers.purpose, "generated_run")));
        const generatedSaleOfferIds = generatedSaleOfferRows.map((row) => row.id);

        await tx
          .delete(simulatedNotifications)
          .where(inArray(simulatedNotifications.runId, runIds));
        await tx.delete(erpAttempts).where(inArray(erpAttempts.runId, runIds));
        await tx.delete(orderEvents).where(inArray(orderEvents.runId, runIds));
        await tx.delete(orders).where(inArray(orders.runId, runIds));
        await tx.delete(reservations).where(inArray(reservations.runId, runIds));
        await tx
          .delete(reservationPendingPersistence)
          .where(inArray(reservationPendingPersistence.runId, runIds));
        await tx
          .delete(demoRunReservationOutcomes)
          .where(inArray(demoRunReservationOutcomes.runId, runIds));
        await tx.delete(demoRunFinalizations).where(inArray(demoRunFinalizations.runId, runIds));
        await tx.delete(demoRunSummaries).where(inArray(demoRunSummaries.runId, runIds));
        await tx.delete(demoRunSaleContexts).where(inArray(demoRunSaleContexts.runId, runIds));
        await tx.delete(demoRuns).where(inArray(demoRuns.id, runIds));
        if (generatedSaleOfferIds.length === 0) {
          return 0;
        }
        const deletedSaleOffers = await tx
          .delete(saleOffers)
          .where(
            and(
              inArray(saleOffers.id, generatedSaleOfferIds),
              eq(saleOffers.purpose, "generated_run"),
            ),
          )
          .returning({ id: saleOffers.id });

        return deletedSaleOffers.length;
      });
    }

    return adminMaintenanceCleanupRunsResponseSchema.parse({
      deletedRunCount: runIds.length,
      deletedSaleOfferCount,
      preservedLatestCount: latestRunIds.length,
      preservedActiveRunCount: activeRunIds.length,
      cutoffBefore: cutoffBefore.toISOString(),
      cleanedAt: now.toISOString(),
      correlationId: input.correlationId,
    });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
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
      httpSummary: trafficHttpSummarySchema.parse(finalization.httpSummary),
      trafficDeliverySummary: trafficDeliverySummarySchema.parse(
        finalization.trafficDeliverySummary,
      ),
      httpTimingBreakdownSummary: finalization.httpTimingBreakdownSummary,
      loadRunDiagnosticsSummary: finalization.loadRunDiagnosticsSummary,
      apiRequestLifecycleSummary: finalization.apiRequestLifecycleSummary,
    };
  }

  const summary = failedBeforeTrafficCompletionSummary(
    acceptedRunConfigSnapshotSchema.parse(run.configSnapshot),
  );

  return {
    httpSummary: summary.httpSummary,
    trafficDeliverySummary: summary.trafficDeliverySummary,
    httpTimingBreakdownSummary: {},
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
      emittedRequests: 0,
      completedRequests: 0,
      failedRequests: 0,
      acceptedResponses: 0,
      soldOutResponses: 0,
      unexpectedResponses: 0,
      failureRate: 0,
    },
    trafficDeliverySummary: {
      plannedRequests,
      emittedRequests: 0,
      droppedIterations: plannedRequests,
      trafficDeliveryStatus: "failed",
      notes: ["Admin reset failed the run before traffic completion."],
    },
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
