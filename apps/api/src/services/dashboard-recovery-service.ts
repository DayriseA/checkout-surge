import {
  type BusinessOutcomeSummary,
  type CompletionOutcome,
  type ConsistencyLagSummary,
  type DashboardRecoveryResponse,
  type DemoRunSnapshot,
  dashboardRecoveryResponseSchema,
  demoRunSnapshotSchema,
  type MetricSample,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  demoRuns,
  readBusinessOutcomeSummary,
  readConsistencyLagSummary,
  readRecentCompletionOutcomes,
  saleOffers,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type { DashboardTrafficMetricReader } from "./demo-run-service.js";
import type { ErpStatusService } from "./erp-status-service.js";
import type { InventoryStatusService } from "./inventory-status-service.js";
import type { QueueStatusService } from "./queue-status-service.js";

export interface DashboardRecoveryContext {
  currentRun: DemoRunSnapshot | null;
  saleOfferId: string | null;
}

export interface DashboardRecoveryContextReader {
  readContext(now: Date): Promise<DashboardRecoveryContext>;
}

export interface DashboardBusinessOutcomeReader {
  read(scope: { saleOfferId: string; runId?: string }): Promise<BusinessOutcomeSummary>;
}

export interface DashboardConsistencyLagReader {
  read(
    scope: { saleOfferId: string; runId?: string },
    measuredAt: Date,
  ): Promise<ConsistencyLagSummary>;
}

export interface DashboardCompletionOutcomeReader {
  read(scope: { saleOfferId: string; runId?: string }, now: Date): Promise<CompletionOutcome[]>;
}

export class PostgresDashboardRecoveryContextReader implements DashboardRecoveryContextReader {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async readContext(now: Date): Promise<DashboardRecoveryContext> {
    const [currentRunRow] = await this.db
      .select()
      .from(demoRuns)
      .where(inArray(demoRuns.status, ["starting", "active", "draining"]))
      .orderBy(desc(demoRuns.updatedAt))
      .limit(1);

    if (currentRunRow) {
      const currentRun = toDemoRunSnapshot(currentRunRow);

      return {
        currentRun,
        saleOfferId: currentRun.saleOfferId ?? null,
      };
    }

    const [catalogOffer] = await this.db
      .select({ id: saleOffers.id })
      .from(saleOffers)
      .where(
        and(
          eq(saleOffers.purpose, "catalog"),
          eq(saleOffers.isActive, true),
          lte(saleOffers.saleStartsAt, now),
          gte(saleOffers.saleEndsAt, now),
        ),
      )
      .orderBy(desc(saleOffers.updatedAt))
      .limit(1);

    return {
      currentRun: null,
      saleOfferId: catalogOffer?.id ?? null,
    };
  }
}

export class PostgresDashboardBusinessOutcomeReader implements DashboardBusinessOutcomeReader {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  read(scope: { saleOfferId: string; runId?: string }): Promise<BusinessOutcomeSummary> {
    return readBusinessOutcomeSummary(this.db, scope);
  }
}

export class PostgresDashboardConsistencyLagReader implements DashboardConsistencyLagReader {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  read(
    scope: { saleOfferId: string; runId?: string },
    measuredAt: Date,
  ): Promise<ConsistencyLagSummary> {
    return readConsistencyLagSummary(this.db, scope, measuredAt);
  }
}

export class PostgresDashboardCompletionOutcomeReader implements DashboardCompletionOutcomeReader {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  read(scope: { saleOfferId: string; runId?: string }, now: Date): Promise<CompletionOutcome[]> {
    return readRecentCompletionOutcomes(this.db, scope, { now });
  }
}

export class DashboardRecoveryService {
  constructor(
    private readonly options: {
      contextReader: DashboardRecoveryContextReader;
      businessOutcomeReader: DashboardBusinessOutcomeReader;
      consistencyLagReader: DashboardConsistencyLagReader;
      completionOutcomeReader: DashboardCompletionOutcomeReader;
      inventoryStatusService: InventoryStatusService;
      queueStatusService: QueueStatusService;
      erpStatusService: ErpStatusService;
      logger: CheckoutSurgeLogger;
      trafficMetricReader?: DashboardTrafficMetricReader;
      now?: () => Date;
    },
  ) {}

  async getRecovery(): Promise<DashboardRecoveryResponse> {
    const now = this.options.now?.() ?? new Date();
    const contextResult = await readSafely("dashboard_run_context", () =>
      this.options.contextReader.readContext(now),
    );
    const context = contextResult.ok
      ? contextResult.value
      : { currentRun: null, saleOfferId: null };
    const scope = context.saleOfferId
      ? {
          saleOfferId: context.saleOfferId,
          ...(context.currentRun ? { runId: context.currentRun.runId } : {}),
        }
      : null;

    const [
      inventoryResult,
      queueResult,
      erpResult,
      businessOutcomeResult,
      consistencyLagResult,
      trafficMetricResult,
      completionOutcomeResult,
    ] = await Promise.all([
      scope
        ? readSafely("dashboard_inventory", () =>
            this.options.inventoryStatusService.getStatus(scope.saleOfferId),
          )
        : Promise.resolve({ ok: true as const, value: null }),
      readSafely("dashboard_queue", () => this.options.queueStatusService.getStatus()),
      readSafely("dashboard_erp", () => this.options.erpStatusService.getStatus()),
      scope
        ? readSafely("dashboard_business_outcome", () =>
            this.options.businessOutcomeReader.read(scope),
          )
        : Promise.resolve({ ok: true as const, value: null }),
      scope
        ? readSafely("dashboard_consistency_lag", () =>
            this.options.consistencyLagReader.read(scope, now),
          )
        : Promise.resolve({ ok: true as const, value: null }),
      readSafely("dashboard_traffic_metrics", () =>
        this.options.trafficMetricReader
          ? this.options.trafficMetricReader.readRecent(context.currentRun?.runId ?? null)
          : Promise.resolve([] satisfies MetricSample[]),
      ),
      scope
        ? readSafely("dashboard_completion_outcomes", () =>
            this.options.completionOutcomeReader.read(scope, now),
          )
        : Promise.resolve({ ok: true as const, value: [] }),
    ]);

    for (const result of [
      contextResult,
      inventoryResult,
      queueResult,
      erpResult,
      businessOutcomeResult,
      consistencyLagResult,
      trafficMetricResult,
      completionOutcomeResult,
    ]) {
      if (!result.ok) {
        this.options.logger.warn(
          { err: result.error, projection: result.projection },
          "Dashboard recovery projection unavailable.",
        );
      }
    }

    return dashboardRecoveryResponseSchema.parse({
      currentRun: context.currentRun,
      inventory: inventoryResult.ok ? inventoryResult.value : null,
      recentMetrics: trafficMetricResult.ok ? trafficMetricResult.value : [],
      queue: queueResult.ok ? queueResult.value : null,
      erp: erpResult.ok ? erpResult.value : null,
      businessOutcome: businessOutcomeResult.ok ? businessOutcomeResult.value : null,
      consistencyLag: consistencyLagResult.ok ? consistencyLagResult.value : null,
      recentCompletionOutcomes: completionOutcomeResult.ok ? completionOutcomeResult.value : [],
      recoveredAt: now.toISOString(),
    });
  }
}

function toDemoRunSnapshot(run: typeof demoRuns.$inferSelect): DemoRunSnapshot {
  return demoRunSnapshotSchema.parse({
    runId: run.id,
    presetId: run.presetId,
    presetName: run.presetName,
    operatorMode: run.operatorMode,
    status: run.status,
    trafficStatus: run.trafficStatus,
    ...(run.saleOfferId ? { saleOfferId: run.saleOfferId } : {}),
    configSnapshot: run.configSnapshot,
    ...(run.startedAt ? { startedAt: run.startedAt.toISOString() } : {}),
    ...(run.trafficStartedAt ? { trafficStartedAt: run.trafficStartedAt.toISOString() } : {}),
    ...(run.trafficEndedAt ? { trafficEndedAt: run.trafficEndedAt.toISOString() } : {}),
    ...(run.finalizedAt ? { finalizedAt: run.finalizedAt.toISOString() } : {}),
    ...(run.failureReason ? { failureReason: run.failureReason } : {}),
  });
}

async function readSafely<T>(
  projection: string,
  read: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; projection: string; error: unknown }> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, projection, error };
  }
}
