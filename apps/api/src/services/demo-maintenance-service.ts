import {
  type AdminDemoResetResponse,
  type AdminMaintenanceCleanupRunsResponse,
  adminDemoResetResponseSchema,
  adminMaintenanceCleanupRunsResponseSchema,
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
  orderEvents,
  orders,
  reservationPendingPersistence,
  reservations,
  saleOffers,
  setRunSaleEligibility,
  simulatedNotifications,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, desc, inArray, lt, notInArray } from "drizzle-orm";
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
      .select({ id: demoRuns.id, saleOfferId: demoRuns.saleOfferId })
      .from(demoRuns)
      .where(inArray(demoRuns.status, ["starting", "active", "draining"]));

    let failedRunCount = 0;
    let closedSaleOfferCount = 0;
    for (const run of activeRuns) {
      const claimedRun = await this.terminalRunWriter.claimTerminalRun({
        runId: run.id,
        terminalStatus: "failed",
        terminalTrafficStatus: "failed",
        failureReason: "admin_reset",
        finalizedAt: now,
        allowedCurrentStatuses: ["starting", "active", "draining"],
      });
      if (!claimedRun) {
        continue;
      }

      failedRunCount += 1;
      if (!run.saleOfferId) {
        continue;
      }
      try {
        await setRunSaleEligibility(this.options.redis, {
          runId: run.id,
          saleOfferId: run.saleOfferId,
          status: "closed",
        });
        closedSaleOfferCount += 1;
      } catch (error) {
        this.options.logger.warn(
          { err: error, runId: run.id, saleOfferId: run.saleOfferId },
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
    const saleOfferIds = deletableRuns
      .map((run) => run.saleOfferId)
      .filter((id): id is string => Boolean(id));

    if (runIds.length > 0) {
      await this.options.db.transaction(async (tx) => {
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
        if (saleOfferIds.length > 0) {
          await tx.delete(saleOffers).where(inArray(saleOffers.id, saleOfferIds));
        }
      });
    }

    return adminMaintenanceCleanupRunsResponseSchema.parse({
      deletedRunCount: runIds.length,
      deletedSaleOfferCount: saleOfferIds.length,
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
}
