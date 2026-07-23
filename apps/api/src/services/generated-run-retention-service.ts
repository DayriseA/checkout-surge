import {
  type AdminMaintenanceCleanupRunsResponse,
  adminMaintenanceCleanupRunsResponseSchema,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  demoRunSaleContexts,
  demoRuns,
  saleOffers,
} from "@checkout-surge/db";
import { and, asc, desc, eq, inArray, lt, notInArray } from "drizzle-orm";
import type { DemoMaintenanceAuthority } from "./demo-maintenance-authority.js";
import type { RetentionGeneratedRunTeardown } from "./generated-run-teardown-service.js";

export interface GeneratedRunRetentionInput {
  keepLatest: number;
  olderThanDays: number;
  correlationId: string;
}

export interface GeneratedRunRetentionWorkflow {
  cleanupOldRuns(input: GeneratedRunRetentionInput): Promise<AdminMaintenanceCleanupRunsResponse>;
}

export class GeneratedRunRetentionService implements GeneratedRunRetentionWorkflow {
  constructor(
    private readonly options: {
      db: CheckoutSurgeDatabase;
      generatedRunTeardown: RetentionGeneratedRunTeardown;
      maintenanceAuthority: DemoMaintenanceAuthority;
      now?: () => Date;
    },
  ) {}

  cleanupOldRuns(input: GeneratedRunRetentionInput): Promise<AdminMaintenanceCleanupRunsResponse> {
    return this.options.maintenanceAuthority.runExclusive(() =>
      this.cleanupOldRunsExclusive(input),
    );
  }

  private async cleanupOldRunsExclusive(
    input: GeneratedRunRetentionInput,
  ): Promise<AdminMaintenanceCleanupRunsResponse> {
    const now = this.options.now?.() ?? new Date();
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
      .select({ runId: demoRuns.id })
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
      const result = await this.options.generatedRunTeardown.teardownRetentionCandidate({
        runId: candidate.runId,
        correlationId: input.correlationId,
      });
      if (result.outcome === "deleted") {
        deletedRunCount += 1;
        deletedSaleOfferCount += 1;
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
}
