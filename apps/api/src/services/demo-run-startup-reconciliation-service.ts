import type { demoRuns } from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import type { PendingPersistenceReconciler } from "./pending-persistence-reconciler.js";
import type { TrafficCompletionEnrichmentController } from "./traffic-completion-enrichment-service.js";

type DemoRunRow = typeof demoRuns.$inferSelect;

export type DemoRunStartupReconciliationFailureStage =
  | "missing_sale_offer"
  | "eligibility_close"
  | "completion_enrichment"
  | "pending_reconciliation"
  | "recovery_workflow";

export interface DemoRunStartupReconciliationFailure {
  runId: string;
  saleOfferId: string | null;
  stages: DemoRunStartupReconciliationFailureStage[];
}

export interface DemoRunStartupReconciliationSummary {
  discoveredRunCount: number;
  succeededRunCount: number;
  failedRunCount: number;
  closedSaleOfferCount: number;
  completionEnrichedRunCount: number;
  pendingPersistenceEffectCount: number;
  failures: DemoRunStartupReconciliationFailure[];
}

interface PerRunRecoveryResult {
  closedSaleOfferCount: number;
  completionEnrichedRunCount: number;
  pendingPersistenceEffectCount: number;
  failureStages: DemoRunStartupReconciliationFailureStage[];
}

/**
 * Repairs API-owned projections for draining runs before the first finalizer
 * tick. Starting and active execution remain owned by the traffic orchestrator
 * and its durable completion journal.
 */
export class DemoRunStartupReconciliationService {
  constructor(
    private readonly options: {
      logger: CheckoutSurgeLogger;
      pendingPersistenceReconciler: Pick<PendingPersistenceReconciler, "reconcileSaleOffer">;
      completionEnrichmentService: Pick<
        TrafficCompletionEnrichmentController,
        "completePendingEnrichment"
      >;
      listDrainingRuns: () => Promise<DemoRunRow[]>;
      closeRunSaleEligibility: (input: { runId: string; saleOfferId: string }) => Promise<boolean>;
    },
  ) {}

  async reconcile(): Promise<DemoRunStartupReconciliationSummary> {
    // A list failure is startup-wide. Once discovery succeeds, every candidate
    // gets an independent recovery attempt.
    const runs = await this.options.listDrainingRuns();
    const summary: DemoRunStartupReconciliationSummary = {
      discoveredRunCount: runs.length,
      succeededRunCount: 0,
      failedRunCount: 0,
      closedSaleOfferCount: 0,
      completionEnrichedRunCount: 0,
      pendingPersistenceEffectCount: 0,
      failures: [],
    };

    for (const run of runs) {
      let result: PerRunRecoveryResult;
      try {
        result = await this.recoverRun(run);
      } catch (error) {
        this.logStageFailure(run, "recovery_workflow", error);
        result = {
          closedSaleOfferCount: 0,
          completionEnrichedRunCount: 0,
          pendingPersistenceEffectCount: 0,
          failureStages: ["recovery_workflow"],
        };
      }
      summary.closedSaleOfferCount += result.closedSaleOfferCount;
      summary.completionEnrichedRunCount += result.completionEnrichedRunCount;
      summary.pendingPersistenceEffectCount += result.pendingPersistenceEffectCount;

      if (result.failureStages.length === 0) {
        summary.succeededRunCount += 1;
      } else {
        summary.failedRunCount += 1;
        summary.failures.push({
          runId: run.id,
          saleOfferId: run.saleOfferId,
          stages: result.failureStages,
        });
      }
    }

    return summary;
  }

  private async recoverRun(run: DemoRunRow): Promise<PerRunRecoveryResult> {
    if (!run.saleOfferId) {
      this.logStageFailure(run, "missing_sale_offer", new Error("Draining run has no sale offer."));
      return {
        closedSaleOfferCount: 0,
        completionEnrichedRunCount: 0,
        pendingPersistenceEffectCount: 0,
        failureStages: ["missing_sale_offer"],
      };
    }

    const result: PerRunRecoveryResult = {
      closedSaleOfferCount: 0,
      completionEnrichedRunCount: 0,
      pendingPersistenceEffectCount: 0,
      failureStages: [],
    };

    try {
      if (
        await this.options.closeRunSaleEligibility({
          runId: run.id,
          saleOfferId: run.saleOfferId,
        })
      ) {
        result.closedSaleOfferCount = 1;
      }
    } catch (error) {
      result.failureStages.push("eligibility_close");
      this.logStageFailure(run, "eligibility_close", error);
    }

    try {
      const enrichment = await this.options.completionEnrichmentService.completePendingEnrichment(
        run.id,
      );
      if (enrichment === "not_found") {
        throw new Error("Draining run completion enrichment was not found.");
      }
      if (enrichment === "completed") {
        result.completionEnrichedRunCount = 1;
      }
    } catch (error) {
      result.failureStages.push("completion_enrichment");
      this.logStageFailure(run, "completion_enrichment", error);
    }

    try {
      const reconciliation = await this.options.pendingPersistenceReconciler.reconcileSaleOffer(
        run.saleOfferId,
        { runId: run.id },
      );
      result.pendingPersistenceEffectCount = reconciliation.reconciled + reconciliation.reversed;
      if (reconciliation.failed > 0) {
        throw new Error(
          `Pending persistence reconciliation left ${reconciliation.failed} item(s) retryable.`,
        );
      }
    } catch (error) {
      result.failureStages.push("pending_reconciliation");
      this.logStageFailure(run, "pending_reconciliation", error);
    }

    return result;
  }

  private logStageFailure(
    run: DemoRunRow,
    stage: DemoRunStartupReconciliationFailureStage,
    error: unknown,
  ): void {
    this.options.logger.warn(
      { err: error, runId: run.id, saleOfferId: run.saleOfferId, stage },
      "Demo-run startup recovery stage failed and remains retryable.",
    );
  }
}
