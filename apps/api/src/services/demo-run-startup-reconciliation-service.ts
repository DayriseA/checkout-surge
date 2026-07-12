import {
  type AcceptedRunConfigSnapshot,
  acceptedRunConfigSnapshotSchema,
  type BusinessOutcomeSummary,
  type TerminalInventorySnapshot,
  type TrafficConfig,
  type TrafficDeliverySummary,
  type TrafficHttpSummary,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  demoRunReservationOutcomes,
  demoRuns,
  getInventoryStatus,
  readBusinessOutcomeSummary,
  setRunSaleEligibility,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, eq, inArray } from "drizzle-orm";
import type { PendingPersistenceReconciler } from "./pending-persistence-reconciler.js";
import { PostgresTerminalDemoRunSummaryWriter } from "./terminal-demo-run-transition.js";

const apiRestartInterruptedRunReason = "api_restart_interrupted_run";

export interface DemoRunStartupReconciliationSummary {
  interruptedRunCount: number;
  closedSaleOfferCount: number;
  summaryCreatedCount: number;
  recoverableDrainingRunCount: number;
}

export class DemoRunStartupReconciliationService {
  private readonly summaryWriter: PostgresTerminalDemoRunSummaryWriter;

  constructor(
    private readonly options: {
      db: CheckoutSurgeDatabase;
      redis: CheckoutSurgeRedis;
      logger: CheckoutSurgeLogger;
      pendingPersistenceReconciler?: Pick<PendingPersistenceReconciler, "reconcileSaleOffer">;
      now?: () => Date;
    },
  ) {
    this.summaryWriter = new PostgresTerminalDemoRunSummaryWriter(options.db);
  }

  async reconcile(): Promise<DemoRunStartupReconciliationSummary> {
    const now = this.now();
    const runs = await this.options.db
      .select()
      .from(demoRuns)
      .where(inArray(demoRuns.status, ["starting", "active", "draining"]));
    const interruptedRuns = runs.filter(
      (run) => run.status === "starting" || run.status === "active",
    );
    const recoverableDrainingRuns = runs.filter((run) => run.status === "draining");
    const recoverableDrainingRunCount = recoverableDrainingRuns.length;
    let closedSaleOfferCount = 0;
    let summaryCreatedCount = 0;

    for (const run of interruptedRuns) {
      if (run.saleOfferId) {
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
            "Could not close run sale eligibility during API startup reconciliation.",
          );
        }
      }

      const configSnapshot = acceptedRunConfigSnapshotSchema.parse(run.configSnapshot);
      const businessOutcome = await this.readBusinessOutcome(run);
      const terminalInventorySnapshot = await this.captureTerminalInventorySnapshot({
        run,
        businessOutcome,
        capturedAt: now,
      });
      const trafficSummary = interruptedTrafficSummary(configSnapshot);
      const wroteSummary = await this.summaryWriter.write({
        run,
        terminalStatus: "failed",
        failureReason: apiRestartInterruptedRunReason,
        finalizedAt: now,
        httpSummary: trafficSummary.httpSummary,
        trafficDeliverySummary: trafficSummary.trafficDeliverySummary,
        httpTimingBreakdownSummary: {},
        loadRunDiagnosticsSummary: {
          interruption: apiRestartInterruptedRunReason,
          previousTrafficStatus: run.trafficStatus,
        },
        apiRequestLifecycleSummary: {
          failureReason: apiRestartInterruptedRunReason,
          previousStatus: run.status,
          previousTrafficStatus: run.trafficStatus,
          reconciledAt: now.toISOString(),
        },
        businessOutcome,
        terminalInventorySnapshot,
        allowedCurrentStatuses: ["starting", "active"],
        terminalTrafficStatus: "failed",
      });

      if (wroteSummary) {
        summaryCreatedCount += 1;
      }
    }

    for (const run of recoverableDrainingRuns) {
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
          "Could not repair run sale eligibility during API startup reconciliation.",
        );
      }

      if (this.options.pendingPersistenceReconciler) {
        try {
          await this.options.pendingPersistenceReconciler.reconcileSaleOffer(run.saleOfferId, {
            runId: run.id,
          });
        } catch (error) {
          this.options.logger.warn(
            { err: error, runId: run.id, saleOfferId: run.saleOfferId },
            "Pending Redis reservation reconciliation failed during API startup.",
          );
        }
      }
    }

    return {
      interruptedRunCount: interruptedRuns.length,
      closedSaleOfferCount,
      summaryCreatedCount,
      recoverableDrainingRunCount,
    };
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
        "Could not capture terminal inventory snapshot during API startup reconciliation.",
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

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function interruptedTrafficSummary(config: AcceptedRunConfigSnapshot): {
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
      notes: ["API startup reconciliation failed the interrupted run before traffic completion."],
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
