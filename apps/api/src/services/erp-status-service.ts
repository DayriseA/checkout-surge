import type {
  ErpCircuitBreakerSnapshot,
  ErpConfirmationDelay,
  ErpLatestAttemptSummary,
  ErpResilienceStatus,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  erpAttempts,
  getErpCircuitBreakerSnapshot,
  orders,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { desc, eq, gte, sql } from "drizzle-orm";
import type { QueueStatusService } from "./queue-status-service.js";

export interface ErpStatusReadModel {
  latestAttempt: ErpLatestAttemptSummary | null;
  recentAttemptWindowSeconds: number;
  recentAttemptCount: number;
  recentFailureCount: number;
  recentTimeoutCount: number;
  confirmationDelay: ErpConfirmationDelay;
}

export interface ErpAttemptStatusReader {
  readStatus(now: Date, recentAttemptWindowSeconds: number): Promise<ErpStatusReadModel>;
}

export interface ErpCircuitBreakerStateReader {
  readSnapshot(): Promise<ErpCircuitBreakerSnapshot | null>;
}

export class RedisErpCircuitBreakerStateReader implements ErpCircuitBreakerStateReader {
  constructor(private readonly redis: CheckoutSurgeRedis) {}

  readSnapshot(): Promise<ErpCircuitBreakerSnapshot | null> {
    return getErpCircuitBreakerSnapshot(this.redis);
  }
}

export class PostgresErpAttemptStatusReader implements ErpAttemptStatusReader {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async readStatus(now: Date, recentAttemptWindowSeconds: number): Promise<ErpStatusReadModel> {
    const recentSince = new Date(now.getTime() - recentAttemptWindowSeconds * 1000);
    const [latestAttemptRows, recentAttemptCountRows, processingOrderRows, confirmedOrderRows] =
      await Promise.all([
        this.db.select().from(erpAttempts).orderBy(desc(erpAttempts.finishedAt)).limit(1),
        this.db
          .select({
            recentAttemptCount: sql<number>`(count(*))::int`,
            recentFailureCount: sql<number>`(count(*) filter (where ${erpAttempts.status} = 'failed'))::int`,
            recentTimeoutCount: sql<number>`(count(*) filter (where ${erpAttempts.status} = 'timed_out'))::int`,
          })
          .from(erpAttempts)
          .where(gte(erpAttempts.finishedAt, recentSince)),
        this.db
          .select({ processingAt: orders.processingAt })
          .from(orders)
          .where(eq(orders.status, "processing"))
          .limit(1000),
        this.db
          .select({ queuedAt: orders.queuedAt, confirmedAt: orders.confirmedAt })
          .from(orders)
          .where(eq(orders.status, "confirmed"))
          .orderBy(desc(orders.confirmedAt))
          .limit(100),
      ]);

    const latestAttempt = latestAttemptRows[0]
      ? toLatestAttemptSummary(latestAttemptRows[0])
      : null;
    const recentAttemptCounts = recentAttemptCountRows[0] ?? {
      recentAttemptCount: 0,
      recentFailureCount: 0,
      recentTimeoutCount: 0,
    };

    return {
      latestAttempt,
      recentAttemptWindowSeconds,
      recentAttemptCount: recentAttemptCounts.recentAttemptCount,
      recentFailureCount: recentAttemptCounts.recentFailureCount,
      recentTimeoutCount: recentAttemptCounts.recentTimeoutCount,
      confirmationDelay: toConfirmationDelay(now, processingOrderRows, confirmedOrderRows),
    };
  }
}

export class ErpStatusService {
  constructor(
    private readonly options: {
      circuitBreakerStateReader: ErpCircuitBreakerStateReader;
      attemptStatusReader: ErpAttemptStatusReader;
      queueStatusService: QueueStatusService;
      logger: CheckoutSurgeLogger;
      recentAttemptWindowSeconds?: number;
      now?: () => Date;
    },
  ) {}

  async getStatus(): Promise<ErpResilienceStatus> {
    const now = this.options.now?.() ?? new Date();
    const recentAttemptWindowSeconds = this.options.recentAttemptWindowSeconds ?? 60;
    const [circuitResult, queueResult, attemptReadModel] = await Promise.all([
      readSafely(() => this.options.circuitBreakerStateReader.readSnapshot()),
      readSafely(() => this.options.queueStatusService.getStatus()),
      this.options.attemptStatusReader.readStatus(now, recentAttemptWindowSeconds),
    ]);
    const circuit = circuitResult.ok ? circuitResult.value : null;
    const queueStatus = queueResult.ok ? queueResult.value : null;
    const retryPressure = queueStatus?.retryPressure ?? {
      retryingJobCount: 0,
      retryAttemptCount: 0,
      inspectedJobCount: 0,
      inspectionLimit: 1,
      inspectionTruncated: false,
    };
    const derived = deriveDependencyState({
      circuit,
      isCircuitReadUnavailable: !circuitResult.ok,
      isQueueReadUnavailable: !queueResult.ok,
      latestAttempt: attemptReadModel.latestAttempt,
      recentFailureCount: attemptReadModel.recentFailureCount,
      recentTimeoutCount: attemptReadModel.recentTimeoutCount,
      retryingJobCount: retryPressure.retryingJobCount,
    });

    if (!circuitResult.ok) {
      this.options.logger.error(
        { err: circuitResult.error },
        "ERP circuit breaker state read failed.",
      );
    }
    if (!queueResult.ok) {
      this.options.logger.error({ err: queueResult.error }, "ERP retry-pressure read failed.");
    }

    return {
      status: derived.status,
      reason: derived.reason,
      circuit,
      retryPressure,
      latestAttempt: attemptReadModel.latestAttempt,
      recentAttemptWindowSeconds,
      recentAttemptCount: attemptReadModel.recentAttemptCount,
      recentFailureCount: attemptReadModel.recentFailureCount,
      recentTimeoutCount: attemptReadModel.recentTimeoutCount,
      confirmationDelay: attemptReadModel.confirmationDelay,
      updatedAt: now.toISOString(),
    };
  }
}

function deriveDependencyState(input: {
  circuit: ErpCircuitBreakerSnapshot | null;
  isCircuitReadUnavailable: boolean;
  isQueueReadUnavailable: boolean;
  latestAttempt: ErpLatestAttemptSummary | null;
  recentFailureCount: number;
  recentTimeoutCount: number;
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
  if (input.recentTimeoutCount > 0) {
    return { status: "degraded", reason: "recent_erp_timeouts" };
  }
  if (input.recentFailureCount > 0 || input.latestAttempt?.status === "failed") {
    return { status: "degraded", reason: "recent_erp_failures" };
  }

  return { status: "healthy", reason: null };
}

function toLatestAttemptSummary(attempt: typeof erpAttempts.$inferSelect): ErpLatestAttemptSummary {
  return {
    orderId: attempt.orderId,
    runId: attempt.runId,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    httpStatus: attempt.httpStatus,
    errorCode: attempt.errorCode,
    errorMessage: attempt.errorMessage,
    latencyMs: attempt.latencyMs,
    finishedAt: attempt.finishedAt.toISOString(),
  };
}

function toConfirmationDelay(
  now: Date,
  processingOrderRows: Array<{ processingAt: Date | null }>,
  confirmedOrderRows: Array<{ queuedAt: Date; confirmedAt: Date | null }>,
): ErpConfirmationDelay {
  const processingAges = processingOrderRows
    .flatMap((order) => (order.processingAt ? [elapsedSeconds(order.processingAt, now)] : []))
    .sort((left, right) => right - left);
  const confirmationDelays = confirmedOrderRows.flatMap((order) =>
    order.confirmedAt ? [order.confirmedAt.getTime() - order.queuedAt.getTime()] : [],
  );
  const totalDelayMs = confirmationDelays.reduce((total, delay) => total + delay, 0);

  return {
    processingOrderCount: processingOrderRows.length,
    oldestProcessingAgeSeconds: processingAges[0] ?? null,
    recentConfirmedCount: confirmationDelays.length,
    averageConfirmationDelayMs:
      confirmationDelays.length > 0 ? totalDelayMs / confirmationDelays.length : null,
  };
}

function elapsedSeconds(startedAt: Date, finishedAt: Date): number {
  return Math.max(0, (finishedAt.getTime() - startedAt.getTime()) / 1000);
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
