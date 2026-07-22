import {
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  demoRunFinalizations,
  demoRunSoldOutCounts,
  demoRuns,
  getInventoryStatus,
  InventoryNotInitializedError,
  setRunSaleEligibility,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, eq } from "drizzle-orm";
import type { DashboardBusinessOutcomeReader } from "./dashboard-recovery-service.js";
import { toRedisTerminalInventorySnapshot } from "./demo-run-projections.js";

export type TrafficCompletionEnrichmentResult = "completed" | "already_completed" | "not_found";

export interface TrafficCompletionEnrichmentController {
  completePendingEnrichment(runId: string): Promise<TrafficCompletionEnrichmentResult>;
  reconcilePendingEnrichments(): Promise<number>;
}

/**
 * Concludes the cross-system traffic-completion observation without holding a
 * PostgreSQL transaction across Redis. Competing attempts may observe Redis,
 * but only the first compare-and-set can make its observation authoritative.
 */
export class TrafficCompletionEnrichmentService implements TrafficCompletionEnrichmentController {
  constructor(
    private readonly options: {
      db: CheckoutSurgeDatabase;
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
    await this.closeAdmission(row.run.id, row.run.saleOfferId);

    if (
      row.run.status !== "draining" ||
      row.finalization.completionEnrichmentStatus === "completed"
    ) {
      return "already_completed";
    }

    const capturedAt = this.now();
    const inventory = await this.captureInventory(row.run.id, row.run.saleOfferId, capturedAt);
    const businessOutcome = await this.options.businessOutcomeReader.read({
      saleOfferId: row.run.saleOfferId,
      runId: row.run.id,
    });
    const terminalInventorySnapshot = inventory
      ? toRedisTerminalInventorySnapshot({
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

  async reconcilePendingEnrichments(): Promise<number> {
    const rows = await this.options.db
      .select({ runId: demoRuns.id })
      .from(demoRuns)
      .innerJoin(demoRunFinalizations, eq(demoRunFinalizations.runId, demoRuns.id))
      .where(
        and(
          eq(demoRuns.status, "draining"),
          eq(demoRunFinalizations.completionEnrichmentStatus, "pending"),
        ),
      );
    let completedCount = 0;

    for (const row of rows) {
      try {
        if ((await this.completePendingEnrichment(row.runId)) === "completed") {
          completedCount += 1;
        }
      } catch (error) {
        this.options.logger.warn(
          { err: error, runId: row.runId },
          "Traffic-completion enrichment remains pending for lifecycle retry.",
        );
      }
    }

    return completedCount;
  }

  private async captureInventory(
    runId: string,
    saleOfferId: string,
    capturedAt: Date,
  ): Promise<Awaited<ReturnType<typeof getInventoryStatus>> | null> {
    try {
      return await getInventoryStatus(this.options.redis, saleOfferId, capturedAt);
    } catch (error) {
      this.options.logger.warn(
        { err: error, runId, saleOfferId },
        "Traffic-completion inventory capture concluded without a snapshot.",
      );
      return null;
    }
  }

  private async closeAdmission(runId: string, saleOfferId: string): Promise<void> {
    try {
      await setRunSaleEligibility(this.options.redis, {
        runId,
        saleOfferId,
        status: "closed",
      });
    } catch (error) {
      if (!(error instanceof InventoryNotInitializedError)) {
        throw error;
      }

      // Missing inventory cannot admit a buy and is therefore already
      // fail-closed. Other Redis failures cannot prove closure and must retry.
      this.options.logger.warn(
        { err: error, runId, saleOfferId },
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
