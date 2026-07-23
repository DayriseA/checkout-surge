import {
  type BusinessOutcomeSummary,
  type CompletionOutcome,
  type ConsistencyLagSummary,
  type DashboardProjection,
  type DashboardProjectionScope,
  type DemoRunSnapshot,
  dashboardProjectionSchema,
  dashboardProjectionSchemaName,
  dashboardProjectionSchemaVersion,
  dashboardProjectionScopeId,
  type MetricSample,
  type TransportAttemptCounts,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  demoRunFinalizations,
  demoRuns,
  incrementDashboardProjectionRevision,
  incrementIdleDashboardProjectionRevision,
  readBusinessOutcomeSummary,
  readConsistencyLagSummary,
  readRecentCompletionOutcomes,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { desc, eq, inArray } from "drizzle-orm";
import { runWithResourceCleanup } from "../runtime/api-resource-cleanup.js";
import { abortReason, settleWithAbort } from "../runtime/operation-lifecycle.js";
import type { DashboardTrafficMetricReader } from "./dashboard-traffic-metric-store.js";
import { toDemoRunSnapshot } from "./demo-run-projections.js";
import type { ErpStatusService } from "./erp-status-service.js";
import type { InventoryStatusService } from "./inventory-status-service.js";
import type { QueueStatusService } from "./queue-status-service.js";
import { parsePersistedTransportAttemptCounts } from "./traffic-delivery-classifier.js";

export interface DashboardRecoveryContext {
  currentRun: DemoRunSnapshot | null;
  saleOfferId: string | null;
}

export interface DashboardRecoveryContextReader {
  readContext(scope?: DashboardProjectionScope): Promise<DashboardRecoveryContext>;
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

/**
 * Projects terminal transport-attempt accounting for the selected run from its
 * traffic-completion evidence. Returns `null` while no completion evidence
 * exists (the run is still starting or executing).
 */
export interface DashboardTransportAttemptCountsReader {
  read(runId: string): Promise<TransportAttemptCounts | null>;
}

export class PostgresDashboardTransportAttemptCountsReader
  implements DashboardTransportAttemptCountsReader
{
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async read(runId: string): Promise<TransportAttemptCounts | null> {
    const [row] = await this.db
      .select({ transportAttemptCounts: demoRunFinalizations.transportAttemptCounts })
      .from(demoRunFinalizations)
      .where(eq(demoRunFinalizations.runId, runId))
      .limit(1);

    if (!row) return null;
    return parsePersistedTransportAttemptCounts(
      row.transportAttemptCounts,
      `demo run ${runId} finalization`,
    );
  }
}

export class PostgresDashboardRecoveryContextReader implements DashboardRecoveryContextReader {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async readContext(scope?: DashboardProjectionScope): Promise<DashboardRecoveryContext> {
    const [currentRunRow] = await this.db
      .select()
      .from(demoRuns)
      .where(
        scope
          ? eq(demoRuns.id, scope.runId)
          : inArray(demoRuns.status, ["starting", "active", "draining"]),
      )
      .orderBy(desc(demoRuns.startedAt), desc(demoRuns.createdAt), desc(demoRuns.id))
      .limit(1);

    if (currentRunRow) {
      if (!currentRunRow.startedAt) {
        throw new Error(`Current demo run ${currentRunRow.id} has no startedAt timestamp.`);
      }
      if (!currentRunRow.saleOfferId) {
        throw new Error(`Current demo run ${currentRunRow.id} has no saleOfferId.`);
      }
      if (scope && currentRunRow.saleOfferId !== scope.saleOfferId) {
        throw new Error(
          `Demo run ${currentRunRow.id} does not belong to sale offer ${scope.saleOfferId}.`,
        );
      }
      const currentRun = toDemoRunSnapshot(currentRunRow);

      return {
        currentRun,
        saleOfferId: currentRunRow.saleOfferId,
      };
    }

    return {
      currentRun: null,
      saleOfferId: null,
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

export interface DashboardProjectionRevisionAllocator {
  allocate(scope: DashboardProjectionScope | null): Promise<number>;
}

export class RedisDashboardProjectionRevisionAllocator
  implements DashboardProjectionRevisionAllocator
{
  constructor(private readonly redis: CheckoutSurgeRedis) {}

  async allocate(scope: DashboardProjectionScope | null): Promise<number> {
    if (scope) return incrementDashboardProjectionRevision(this.redis, scope);
    return incrementIdleDashboardProjectionRevision(this.redis);
  }
}

export class DashboardProjectionService {
  private buildTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      logger: CheckoutSurgeLogger;
      now?: () => Date;
      openOperation: DashboardRecoveryOperationFactory;
    },
  ) {}

  build(input: {
    correlationId: string;
    signal?: AbortSignal;
    scope?: DashboardProjectionScope;
  }): Promise<DashboardProjection> {
    const signal = input.signal ?? new AbortController().signal;
    const queuedBuild = this.buildTail.then(async () => {
      if (signal.aborted) throw abortReason(signal);
      const operation = await this.options.openOperation(signal);

      return await runWithResourceCleanup(
        () =>
          this.assembleProjection(input.correlationId, signal, operation.dependencies, input.scope),
        () => operation.close(),
        "Dashboard projection operation and cleanup failed.",
      );
    });
    this.buildTail = queuedBuild.then(
      () => undefined,
      () => undefined,
    );
    return settleWithAbort(queuedBuild, signal);
  }

  /** Current recovery adapter; Task 38 live publication calls `build` directly. */
  getRecovery(input: {
    correlationId: string;
    signal?: AbortSignal;
  }): Promise<DashboardProjection> {
    return this.build(input);
  }

  private async assembleProjection(
    correlationId: string,
    signal: AbortSignal,
    dependencies: DashboardRecoveryDependencies,
    requestedScope?: DashboardProjectionScope,
  ): Promise<DashboardProjection> {
    const now = this.options.now?.() ?? new Date();
    const context = await settleWithAbort(
      dependencies.contextReader.readContext(requestedScope),
      signal,
    );
    if ((context.currentRun === null) !== (context.saleOfferId === null)) {
      throw new Error("Dashboard projection context must select a run and sale offer together.");
    }
    if (
      context.currentRun &&
      context.saleOfferId &&
      context.currentRun.saleOfferId !== context.saleOfferId
    ) {
      throw new Error("Dashboard projection context run and sale offer must agree.");
    }
    if (requestedScope && (!context.currentRun || !context.saleOfferId)) {
      throw new Error(
        `Dashboard projection scope ${dashboardProjectionScopeId(requestedScope)} was not found.`,
      );
    }
    const scope =
      context.currentRun && context.saleOfferId
        ? Object.freeze({
            runId: context.currentRun.runId,
            saleOfferId: context.saleOfferId,
          })
        : null;
    const saleScope = scope?.saleOfferId
      ? Object.freeze({ runId: scope.runId, saleOfferId: scope.saleOfferId })
      : null;

    const [
      inventoryResult,
      queueResult,
      erpResult,
      businessOutcomeResult,
      consistencyLagResult,
      trafficMetricResult,
      completionOutcomeResult,
      transportAttemptCountsResult,
    ] = await Promise.all([
      saleScope
        ? readSafely("dashboard_inventory", signal, () =>
            dependencies.inventoryStatusService.getStatus(saleScope.saleOfferId),
          )
        : Promise.resolve({ ok: true as const, value: null }),
      readSafely("dashboard_queue", signal, () => dependencies.queueStatusService.getStatus()),
      readSafely("dashboard_erp", signal, () => dependencies.erpStatusService.getStatus()),
      saleScope
        ? readSafely("dashboard_business_outcome", signal, () =>
            dependencies.businessOutcomeReader.read(saleScope),
          )
        : Promise.resolve({ ok: true as const, value: null }),
      saleScope
        ? readSafely("dashboard_consistency_lag", signal, () =>
            dependencies.consistencyLagReader.read(saleScope, now),
          )
        : Promise.resolve({ ok: true as const, value: null }),
      scope
        ? readSafely("dashboard_traffic_metrics", signal, () =>
            dependencies.trafficMetricReader.readRecent(scope.runId),
          )
        : Promise.resolve({ ok: true as const, value: [] satisfies MetricSample[] }),
      saleScope
        ? readSafely("dashboard_completion_outcomes", signal, () =>
            dependencies.completionOutcomeReader.read(saleScope, now),
          )
        : Promise.resolve({ ok: true as const, value: [] }),
      scope
        ? readSafely("dashboard_transport_attempt_counts", signal, () =>
            dependencies.transportAttemptCountsReader.read(scope.runId),
          )
        : Promise.resolve({ ok: true as const, value: null }),
    ]);

    for (const result of [
      inventoryResult,
      queueResult,
      erpResult,
      businessOutcomeResult,
      consistencyLagResult,
      trafficMetricResult,
      completionOutcomeResult,
      transportAttemptCountsResult,
    ]) {
      if (!result.ok) {
        this.options.logger.warn(
          { err: result.error, projection: result.projection },
          "Dashboard recovery projection unavailable.",
        );
      }
    }

    const revision = await settleWithAbort(dependencies.revisionAllocator.allocate(scope), signal);
    return dashboardProjectionSchema.parse({
      schema: dashboardProjectionSchemaName,
      version: dashboardProjectionSchemaVersion,
      correlationId,
      scopeId: dashboardProjectionScopeId(scope),
      revision,
      scope,
      currentRun: context.currentRun,
      inventory: inventoryResult.ok ? inventoryResult.value : null,
      recentMetrics: trafficMetricResult.ok ? trafficMetricResult.value : [],
      queue: queueResult.ok ? queueResult.value : null,
      erp: erpResult.ok ? erpResult.value : null,
      businessOutcome: businessOutcomeResult.ok ? businessOutcomeResult.value : null,
      consistencyLag: consistencyLagResult.ok ? consistencyLagResult.value : null,
      recentCompletionOutcomes: completionOutcomeResult.ok ? completionOutcomeResult.value : [],
      transportAttemptCounts: transportAttemptCountsResult.ok
        ? transportAttemptCountsResult.value
        : null,
      recoveredAt: now.toISOString(),
    });
  }
}

export interface DashboardRecoveryDependencies {
  contextReader: DashboardRecoveryContextReader;
  businessOutcomeReader: DashboardBusinessOutcomeReader;
  consistencyLagReader: DashboardConsistencyLagReader;
  completionOutcomeReader: DashboardCompletionOutcomeReader;
  inventoryStatusService: Pick<InventoryStatusService, "getStatus">;
  queueStatusService: Pick<QueueStatusService, "getStatus">;
  erpStatusService: Pick<ErpStatusService, "getStatus">;
  trafficMetricReader: DashboardTrafficMetricReader;
  transportAttemptCountsReader: DashboardTransportAttemptCountsReader;
  revisionAllocator: DashboardProjectionRevisionAllocator;
}

export interface DashboardRecoveryOperation {
  dependencies: DashboardRecoveryDependencies;
  close(): void | Promise<void>;
}

export type DashboardRecoveryOperationFactory = (
  signal: AbortSignal,
) => DashboardRecoveryOperation | Promise<DashboardRecoveryOperation>;

async function readSafely<T>(
  projection: string,
  signal: AbortSignal,
  read: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; projection: string; error: unknown }> {
  try {
    if (signal.aborted) throw abortReason(signal);
    return { ok: true, value: await settleWithAbort(read(), signal) };
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    return { ok: false, projection, error };
  }
}
