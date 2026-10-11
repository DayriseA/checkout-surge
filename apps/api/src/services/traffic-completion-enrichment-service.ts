import type { InventoryStatus } from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  demoRunFinalizations,
  demoRunSoldOutCounts,
  demoRuns,
  InventoryNotInitializedError,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, eq } from "drizzle-orm";
import type { DashboardBusinessOutcomeReader } from "./dashboard-recovery-service.js";
import { toTerminalInventorySnapshot } from "./demo-run-projections.js";
import type { RunInventoryLifecycle } from "./run-inventory-lifecycle.js";

export type TrafficCompletionEnrichmentResult = "completed" | "already_completed" | "not_found";

export interface TrafficCompletionEnrichmentController {
  completePendingEnrichment(runId: string): Promise<TrafficCompletionEnrichmentResult>;
}

/**
 * Concludes the traffic-completion observation before opening its evidence
 * transaction. Competing attempts may observe the selected inventory backend,
 * but only the first compare-and-set can make its observation authoritative.
 */
export class TrafficCompletionEnrichmentService implements TrafficCompletionEnrichmentController {
  constructor(
    private readonly options: {
      db: CheckoutSurgeDatabase;
      inventory: Pick<RunInventoryLifecycle, "close" | "read">;
      redis: CheckoutSurgeRedis;
      businessOutcomeReader: DashboardBusinessOutcomeReader;
      logger: CheckoutSurgeLogger;
      now?: () => Date;
    },
  ) {}

  async completePendingEnrichment(runId: string): Promise<TrafficCompletionEnrichmentResult> {
    const [row] = await this.options.db
      .select({ run: demoRuns, finalization: demoRunFinalizations })
      .from(demoRuns)
      .innerJoin(demoRunFinalizations, eq(demoRunFinalizations.runId, demoRuns.id))
      .where(eq(demoRuns.id, runId))
      .limit(1);

    if (!row?.run.saleOfferId) {
      return "not_found";
    }

    // Re-drive fail-closed admission even when enrichment already completed.
    await this.closeAdmission(row.run);

    if (
      row.run.status !== "draining" ||
      row.finalization.completionEnrichmentStatus === "completed"
    ) {
      return "already_completed";
    }

    const capturedAt = this.now();
    const inventory = await this.captureInventory(row.run, capturedAt);
    const businessOutcome = await this.options.businessOutcomeReader.read({
      saleOfferId: row.run.saleOfferId,
      runId: row.run.id,
    });
    const terminalInventorySnapshot = inventory
      ? toTerminalInventorySnapshot({
          source: row.run.executionMode === "without_redis" ? "postgres" : "redis",
          saleOfferId: row.run.saleOfferId,
          inventory,
          businessOutcome,
          capturedAt,
        })
      : null;
    const authoritativeTrafficOutcome = withoutApiOwnedEnrichment(
      row.finalization.trafficOutcomeSummary,
    );

    const won = await this.options.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(demoRunFinalizations)
        .set({
          trafficOutcomeSummary: {
            ...authoritativeTrafficOutcome,
            businessOutcomeAtTrafficCompletion: businessOutcome,
            ...(terminalInventorySnapshot ? { terminalInventorySnapshot } : {}),
          },
          completionEnrichmentStatus: "completed",
          updatedAt: capturedAt,
        })
        .where(
          and(
            eq(demoRunFinalizations.runId, runId),
            eq(demoRunFinalizations.completionEnrichmentStatus, "pending"),
          ),
        )
        .returning({ runId: demoRunFinalizations.runId });

      if (!updated) {
        return false;
      }

      if (terminalInventorySnapshot) {
        await tx
          .insert(demoRunSoldOutCounts)
          .values({
            runId,
            count: terminalInventorySnapshot.soldOutRejections,
            latestObservedAt: terminalInventorySnapshot.soldOutRejections > 0 ? capturedAt : null,
            capturedAt,
            createdAt: capturedAt,
          })
          .onConflictDoUpdate({
            target: demoRunSoldOutCounts.runId,
            set: {
              count: terminalInventorySnapshot.soldOutRejections,
              latestObservedAt: terminalInventorySnapshot.soldOutRejections > 0 ? capturedAt : null,
              capturedAt,
            },
          });
      }

      return true;
    });

    return won ? "completed" : "already_completed";
  }

  private async captureInventory(
    run: typeof demoRuns.$inferSelect,
    capturedAt: Date,
  ): Promise<InventoryStatus | null> {
    try {
      if (!run.saleOfferId) return null;
      return await this.options.inventory.read(
        { runId: run.id, saleOfferId: run.saleOfferId, executionMode: run.executionMode },
        capturedAt,
      );
    } catch (error) {
      this.options.logger.warn(
        { err: error, runId: run.id, saleOfferId: run.saleOfferId },
        "Traffic-completion inventory capture concluded without a snapshot.",
      );
      return null;
    }
  }

  private async closeAdmission(run: typeof demoRuns.$inferSelect): Promise<void> {
    try {
      if (!run.saleOfferId) return;
      await this.options.inventory.close({
        runId: run.id,
        saleOfferId: run.saleOfferId,
        executionMode: run.executionMode,
      });
    } catch (error) {
      if (!(error instanceof InventoryNotInitializedError)) {
        throw error;
      }

      // Missing inventory cannot admit a buy and is therefore already
      // fail-closed. Other storage failures cannot prove closure and must retry.
      this.options.logger.warn(
        { err: error, runId: run.id, saleOfferId: run.saleOfferId },
        "Run inventory was already absent while re-driving traffic-completion sale closure.",
      );
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function withoutApiOwnedEnrichment(
  trafficOutcomeSummary: Record<string, unknown>,
): Record<string, unknown> {
  const {
    terminalInventorySnapshot: _terminalInventorySnapshot,
    businessOutcomeAtTrafficCompletion: _businessOutcomeAtTrafficCompletion,
    ...loadGeneratorOutcome
  } = trafficOutcomeSummary;
  return loadGeneratorOutcome;
}
