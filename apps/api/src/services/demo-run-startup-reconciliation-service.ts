import type { TrafficExecutionStartResponse } from "@checkout-surge/contracts";
import { type CheckoutSurgeDatabase, demoRuns } from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, eq } from "drizzle-orm";
import type { DemoMaintenanceAuthority } from "./demo-maintenance-authority.js";
import { parsePersistedAcceptedRunConfigSnapshot } from "./persisted-demo-run-state.js";
import type { TrafficCompletionEnrichmentController } from "./traffic-completion-enrichment-service.js";
import type { TrafficExecutionGateway } from "./traffic-execution-gateway.js";

type DemoRunRow = typeof demoRuns.$inferSelect;

export type DemoRunStartupReconciliationFailureStage =
  | "missing_sale_offer"
  | "eligibility_close"
  | "completion_enrichment"
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
  failures: DemoRunStartupReconciliationFailure[];
}

interface PerRunRecoveryResult {
  closedSaleOfferCount: number;
  completionEnrichedRunCount: number;
  failureStages: DemoRunStartupReconciliationFailureStage[];
}

export interface StartingDemoRunReconciliationStore {
  listStartingRuns(): Promise<DemoRunRow[]>;
  activateStartingRun(
    runId: string,
    trafficResponse: TrafficExecutionStartResponse,
    updatedAt: Date,
  ): Promise<boolean>;
}

export class PostgresStartingDemoRunReconciliationStore
  implements StartingDemoRunReconciliationStore
{
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  listStartingRuns(): Promise<DemoRunRow[]> {
    return this.db.select().from(demoRuns).where(eq(demoRuns.status, "starting"));
  }

  async activateStartingRun(
    runId: string,
    trafficResponse: TrafficExecutionStartResponse,
    updatedAt: Date,
  ): Promise<boolean> {
    const [run] = await this.db
      .update(demoRuns)
      .set({
        status: "active",
        trafficStatus: trafficResponse.status,
        trafficStartedAt: new Date(trafficResponse.startedAt),
        updatedAt,
      })
      .where(and(eq(demoRuns.id, runId), eq(demoRuns.status, "starting")))
      .returning({ id: demoRuns.id });

    return Boolean(run);
  }
}

/**
 * Reconciles durable starting traffic intents and repairs API-owned draining
 * projections. Traffic execution remains owned by the load orchestrator and
 * its durable completion journal.
 */
export class DemoRunStartupReconciliationService {
  constructor(
    private readonly options: {
      maintenanceAuthority: DemoMaintenanceAuthority;
      logger: CheckoutSurgeLogger;
      completionEnrichmentService: Pick<
        TrafficCompletionEnrichmentController,
        "completePendingEnrichment"
      >;
      startingRunStore: StartingDemoRunReconciliationStore;
      trafficExecutionGateway: Pick<TrafficExecutionGateway, "start">;
      apiBaseUrl: string;
      listDrainingRuns: () => Promise<DemoRunRow[]>;
      closeRunSaleEligibility: (input: { runId: string; saleOfferId: string }) => Promise<boolean>;
      now?: () => Date;
    },
  ) {}

  async reconcileStartingRuns(): Promise<number> {
    return this.options.maintenanceAuthority.runExclusive(() =>
      this.reconcileStartingRunsExclusive(),
    );
  }

  private async reconcileStartingRunsExclusive(): Promise<number> {
    const runs = await this.options.startingRunStore.listStartingRuns();
    let reconciledCount = 0;

    for (const run of runs) {
      if (!run.saleOfferId) continue;
      const correlationId = `traffic-reconcile-${run.id}`;
      try {
        const response = await this.options.trafficExecutionGateway.start({
          runId: run.id,
          saleOfferId: run.saleOfferId,
          apiBaseUrl: this.options.apiBaseUrl,
          correlationId,
          configSnapshot: parsePersistedAcceptedRunConfigSnapshot(
            run.configSnapshot,
            `demo run ${run.id} starting reconciliation`,
          ),
        });
        await this.options.startingRunStore.activateStartingRun(run.id, response, this.now());
        reconciledCount += 1;
      } catch (error) {
        this.options.logger.warn(
          { err: error, runId: run.id },
          "Starting traffic intent remains pending reconciliation.",
        );
      }
    }

    return reconciledCount;
  }

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
          failureStages: ["recovery_workflow"],
        };
      }
      summary.closedSaleOfferCount += result.closedSaleOfferCount;
      summary.completionEnrichedRunCount += result.completionEnrichedRunCount;

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
        failureStages: ["missing_sale_offer"],
      };
    }

    const result: PerRunRecoveryResult = {
      closedSaleOfferCount: 0,
      completionEnrichedRunCount: 0,
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

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
