import type {
  DashboardProjectionScope,
  ErpCircuitBreakerSnapshot,
  ErpCumulativeOutcomeCounts,
  ErpLatestAttemptSummary,
  RunErpOutcomeSummary,
  SharedErpProtectionStatus,
} from "@checkout-surge/contracts";
import { erpAttemptHistoryRetentionLimit } from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  type ErpCircuitBreakerScope,
  erpAttempts,
  getErpCircuitBreakerSnapshot,
  readCumulativeErpOutcomeCounts,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { QueueStatusService } from "./queue-status-service.js";

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

export interface ErpCircuitBreakerStateReader {
  readSnapshot(scope: ErpCircuitBreakerScope): Promise<ErpCircuitBreakerSnapshot | null>;
}

export class RedisErpCircuitBreakerStateReader implements ErpCircuitBreakerStateReader {
  constructor(private readonly redis: CheckoutSurgeRedis) {}

  readSnapshot(scope: ErpCircuitBreakerScope): Promise<ErpCircuitBreakerSnapshot | null> {
    return getErpCircuitBreakerSnapshot(this.redis, scope);
  }
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

export class SharedErpProtectionService {
  constructor(
    private readonly options: {
      circuitBreakerStateReader: ErpCircuitBreakerStateReader;
      queueStatusService: Pick<QueueStatusService, "getStatus">;
      logger: CheckoutSurgeLogger;
      now?: () => Date;
    },
  ) {}

  async getStatus(): Promise<SharedErpProtectionStatus> {
    const now = this.options.now?.() ?? new Date();
    const [circuitResult, queueResult] = await Promise.all([
      readSafely(() => this.options.circuitBreakerStateReader.readSnapshot({ type: "catalog" })),
      readSafely(() => this.options.queueStatusService.getStatus()),
    ]);
    const circuit = circuitResult.ok ? circuitResult.value : null;
    const retryPressure = queueResult.ok
      ? queueResult.value.retryPressure
      : {
          retryingJobCount: 0,
          retryAttemptCount: 0,
          inspectedJobCount: 0,
          inspectionLimit: 1,
          inspectionTruncated: false,
        };
    const derived = deriveSharedProtectionState({
      circuit,
      isCircuitReadUnavailable: !circuitResult.ok,
      isQueueReadUnavailable: !queueResult.ok,
      retryingJobCount: retryPressure.retryingJobCount,
    });

    if (!circuitResult.ok) {
      this.options.logger.error(
        { err: circuitResult.error },
        "Shared ERP circuit breaker state read failed.",
      );
    }
    if (!queueResult.ok) {
      this.options.logger.error(
        { err: queueResult.error },
        "Shared ERP retry-pressure read failed.",
      );
    }

    return {
      status: derived.status,
      reason: derived.reason,
      circuit,
      retryPressure,
      observedAt: now.toISOString(),
    };
  }
}

export class RunErpOutcomeService {
  constructor(
    private readonly options: {
      circuitBreakerStateReader: ErpCircuitBreakerStateReader;
      attemptStatusReader: ErpAttemptStatusReader;
      logger: CheckoutSurgeLogger;
      recentAttemptWindowSeconds?: number;
      now?: () => Date;
    },
  ) {}

  async getOutcomes(scope: Pick<DashboardProjectionScope, "runId">): Promise<RunErpOutcomeSummary> {
    const now = this.options.now?.() ?? new Date();
    const recentAttemptWindowSeconds = this.options.recentAttemptWindowSeconds ?? 60;
    const [circuitResult, attemptReadModel] = await Promise.all([
      readSafely(() =>
        this.options.circuitBreakerStateReader.readSnapshot({
          type: "run",
          runId: scope.runId,
        }),
      ),
      this.options.attemptStatusReader.readStatus(scope, now, recentAttemptWindowSeconds),
    ]);

    if (!circuitResult.ok) {
      this.options.logger.error(
        { err: circuitResult.error, runId: scope.runId },
        "Run ERP circuit breaker state read failed.",
      );
    }

    return {
      runId: scope.runId,
      circuit: circuitResult.ok ? circuitResult.value : null,
      circuitReadStatus: circuitResult.ok ? "available" : "unavailable",
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

function deriveSharedProtectionState(input: {
  circuit: ErpCircuitBreakerSnapshot | null;
  isCircuitReadUnavailable: boolean;
  isQueueReadUnavailable: boolean;
  retryingJobCount: number;
}): { status: "healthy" | "degraded" | "unavailable"; reason: string | null } {
  if (input.circuit?.state === "open") {
    return { status: "unavailable", reason: "circuit_open" };
  }
  if (input.isCircuitReadUnavailable) {
    return { status: "unavailable", reason: "circuit_state_unavailable" };
  }
  if (!input.circuit) {
    return { status: "degraded", reason: "circuit_state_missing" };
  }
  if (input.circuit.state === "half_open") {
    return { status: "degraded", reason: "circuit_half_open" };
  }
  if (input.isQueueReadUnavailable) {
    return { status: "degraded", reason: "retry_pressure_unavailable" };
  }
  if (input.retryingJobCount > 0) {
    return { status: "degraded", reason: "erp_retries_pending" };
  }
  return { status: "healthy", reason: null };
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

async function readSafely<T>(
  read: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error };
  }
}
