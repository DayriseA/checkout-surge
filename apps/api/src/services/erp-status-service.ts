import type {
  DashboardProjectionScope,
  ErpCumulativeOutcomeCounts,
  ErpLatestAttemptSummary,
  RunErpOutcomeSummary,
} from "@checkout-surge/contracts";
import { erpAttemptHistoryRetentionLimit } from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  erpAttempts,
  readCumulativeErpOutcomeCounts,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, desc, eq, gte, sql } from "drizzle-orm";

export interface ErpStatusReadModel {
  latestAttempt: ErpLatestAttemptSummary | null;
  recentAttemptWindowSeconds: number;
  recentAttemptCount: number;
  recentFailureCount: number;
  recentTimeoutCount: number;
  cumulativeOutcomeCounts?: ErpCumulativeOutcomeCounts | undefined;
}

export interface ErpAttemptStatusReader {
  readStatus(
    scope: Pick<DashboardProjectionScope, "runId">,
    now: Date,
    recentAttemptWindowSeconds: number,
  ): Promise<ErpStatusReadModel>;
}

export class PostgresErpAttemptStatusReader implements ErpAttemptStatusReader {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async readStatus(
    scope: Pick<DashboardProjectionScope, "runId">,
    now: Date,
    recentAttemptWindowSeconds: number,
  ): Promise<ErpStatusReadModel> {
    const recentSince = new Date(now.getTime() - recentAttemptWindowSeconds * 1000);
    const [latestAttemptRows, recentAttemptCountRows, cumulativeOutcomeCounts] = await Promise.all([
      this.db
        .select({
          runId: erpAttempts.runId,
          status: erpAttempts.status,
          finishedAt: erpAttempts.finishedAt,
        })
        .from(erpAttempts)
        .where(eq(erpAttempts.runId, scope.runId))
        .orderBy(desc(erpAttempts.finishedAt))
        .limit(1),
      this.db
        .select({
          recentAttemptCount: sql<number>`(count(*))::int`,
          recentFailureCount: sql<number>`(count(*) filter (where ${erpAttempts.status} = 'failed'))::int`,
          recentTimeoutCount: sql<number>`(count(*) filter (where ${erpAttempts.status} = 'timed_out'))::int`,
        })
        .from(erpAttempts)
        .where(and(eq(erpAttempts.runId, scope.runId), gte(erpAttempts.finishedAt, recentSince))),
      readCumulativeErpOutcomeCounts(this.db, scope),
    ]);

    const recentAttemptCounts = recentAttemptCountRows[0] ?? {
      recentAttemptCount: 0,
      recentFailureCount: 0,
      recentTimeoutCount: 0,
    };

    return {
      latestAttempt: latestAttemptRows[0] ? toLatestAttemptSummary(latestAttemptRows[0]) : null,
      recentAttemptWindowSeconds,
      recentAttemptCount: recentAttemptCounts.recentAttemptCount,
      recentFailureCount: recentAttemptCounts.recentFailureCount,
      recentTimeoutCount: recentAttemptCounts.recentTimeoutCount,
      cumulativeOutcomeCounts,
    };
  }
}

export class RunErpOutcomeService {
  constructor(
    private readonly options: {
      attemptStatusReader: ErpAttemptStatusReader;
      logger: CheckoutSurgeLogger;
      recentAttemptWindowSeconds?: number;
      now?: () => Date;
    },
  ) {}

  async getOutcomes(scope: Pick<DashboardProjectionScope, "runId">): Promise<RunErpOutcomeSummary> {
    const now = this.options.now?.() ?? new Date();
    const recentAttemptWindowSeconds = this.options.recentAttemptWindowSeconds ?? 60;
    const attemptReadModel = await this.options.attemptStatusReader.readStatus(
      scope,
      now,
      recentAttemptWindowSeconds,
    );

    return {
      runId: scope.runId,
      latestAttempt: attemptReadModel.latestAttempt,
      recentAttemptWindowSeconds,
      recentAttemptCount: attemptReadModel.recentAttemptCount,
      recentFailureCount: attemptReadModel.recentFailureCount,
      recentTimeoutCount: attemptReadModel.recentTimeoutCount,
      recentAttemptCoverage: "retained_history",
      attemptRetentionLimitPerOrder: erpAttemptHistoryRetentionLimit,
      cumulativeOutcomeCounts: attemptReadModel.cumulativeOutcomeCounts,
      observedAt: now.toISOString(),
    };
  }
}

function toLatestAttemptSummary(
  attempt: Pick<typeof erpAttempts.$inferSelect, "runId" | "status" | "finishedAt">,
): ErpLatestAttemptSummary {
  return {
    runId: attempt.runId,
    status: attempt.status,
    finishedAt: attempt.finishedAt.toISOString(),
  };
}
