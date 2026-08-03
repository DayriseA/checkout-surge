import {
  type BusinessOutcomeSummary,
  type ConsistencyLagSummary,
  type DashboardProjection,
  type DashboardProjectionScope,
  type DemoRunSnapshot,
  dashboardProjectionSchema,
  dashboardProjectionSchemaName,
  dashboardProjectionSchemaVersion,
  dashboardProjectionScopeId,
  type MetricSample,
  type RunSignalTimelineSummary,
  runSignalTimelineSummarySchema,
  type TrafficHttpSummary,
  type TransportAttemptCounts,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  demoRunFinalizations,
  demoRunSummaries,
  demoRuns,
  incrementDashboardProjectionRevision,
  incrementIdleDashboardProjectionRevision,
  readBusinessOutcomeSummary,
  readConsistencyLagSummary,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { runWithResourceCleanup } from "../runtime/api-resource-cleanup.js";
import { abortReason, settleWithAbort } from "../runtime/operation-lifecycle.js";
import type { DashboardTrafficMetricReader } from "./dashboard-traffic-metric-store.js";
import { toDemoRunSnapshot } from "./demo-run-projections.js";
import type { RunErpOutcomeService, SharedErpProtectionService } from "./erp-status-service.js";
import type { InventoryStatusService } from "./inventory-status-service.js";
import type { QueueStatusService } from "./queue-status-service.js";
import {
  parsePersistedTrafficDeliverySummary,
  parsePersistedTrafficHttpSummary,
  parsePersistedTransportAttemptCounts,
} from "./traffic-delivery-classifier.js";

export interface DashboardRecoveryContext {
  currentRun: DemoRunSnapshot | null;
  saleOfferId: string | null;
}

export interface DashboardRecoveryContextReader {
  readContext(
    scope?: DashboardProjectionScope,
    knownScope?: DashboardProjectionScope,
  ): Promise<DashboardRecoveryContext>;
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

/**
 * Projects terminal transport observation for the selected run from its
 * traffic-completion evidence. Returns `null` while no completion evidence
 * exists (the run is still starting or executing).
 */
export interface DashboardTransportObservationReader {
  read(runId: string): Promise<{
    transportAttemptCounts: TransportAttemptCounts;
    httpSummary: TrafficHttpSummary;
    persistedTrafficDeliverySummary: unknown;
    runSignalTimelineSummary: RunSignalTimelineSummary | null;
  } | null>;
}

export class PostgresDashboardTransportObservationReader
  implements DashboardTransportObservationReader
{
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async read(runId: string) {
    const [row] = await this.db
      .select({
        transportAttemptCounts: demoRunFinalizations.transportAttemptCounts,
        httpSummary: demoRunFinalizations.httpSummary,
        trafficDeliverySummary: demoRunFinalizations.trafficDeliverySummary,
        runSignalTimelineSummary: demoRunSummaries.runSignalTimelineSummary,
      })
      .from(demoRunFinalizations)
      .leftJoin(demoRunSummaries, eq(demoRunSummaries.runId, demoRunFinalizations.runId))
      .where(eq(demoRunFinalizations.runId, runId))
      .limit(1);

    if (!row) return null;
    const context = `demo run ${runId} finalization`;
    const transportAttemptCounts = parsePersistedTransportAttemptCounts(
      row.transportAttemptCounts,
      context,
    );
    return {
      transportAttemptCounts,
      httpSummary: parsePersistedTrafficHttpSummary(row.httpSummary, context),
      persistedTrafficDeliverySummary: row.trafficDeliverySummary,
      runSignalTimelineSummary:
        row.runSignalTimelineSummary === null
          ? null
          : runSignalTimelineSummarySchema.parse(row.runSignalTimelineSummary),
    };
  }
}

export class PostgresDashboardRecoveryContextReader implements DashboardRecoveryContextReader {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async readContext(
    scope?: DashboardProjectionScope,
    knownScope?: DashboardProjectionScope,
  ): Promise<DashboardRecoveryContext> {
    if (scope && knownScope) {
      throw new Error("Dashboard context cannot select an exact and fallback scope together.");
    }
    const rows = await this.db
      .select()
      .from(demoRuns)
      .where(
        scope
          ? eq(demoRuns.id, scope.runId)
          : knownScope
            ? or(
                inArray(demoRuns.status, ["starting", "active", "draining"]),
                and(
                  eq(demoRuns.id, knownScope.runId),
                  eq(demoRuns.saleOfferId, knownScope.saleOfferId),
                ),
              )
            : inArray(demoRuns.status, ["starting", "active", "draining"]),
      )
      .orderBy(desc(demoRuns.startedAt), desc(demoRuns.createdAt), desc(demoRuns.id))
      .limit(knownScope ? 2 : 1);
    const currentRunRow = knownScope
      ? (rows.find((row) => ["starting", "active", "draining"].includes(row.status)) ??
        rows.find(
          (row) => row.id === knownScope.runId && row.saleOfferId === knownScope.saleOfferId,
        ))
      : rows[0];

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
    knownScope?: DashboardProjectionScope;
  }): Promise<DashboardProjection> {
    if (input.scope && input.knownScope) {
      return Promise.reject(
        new Error("Dashboard projection cannot select an exact and fallback scope together."),
      );
    }
    const signal = input.signal ?? new AbortController().signal;
    const queuedBuild = this.buildTail.then(async () => {
      if (signal.aborted) throw abortReason(signal);
      const operation = await this.options.openOperation(signal);

      return await runWithResourceCleanup(
        () =>
          this.assembleProjection(
            input.correlationId,
            signal,
            operation.dependencies,
            input.scope,
            input.knownScope,
          ),
        () => operation.close(),
        "Dashboard projection operation and cleanup failed.",
      );
    });
    const settledBuild = settleWithAbort(queuedBuild, signal);
    this.buildTail = queuedBuild.then(
      () => undefined,
      () => undefined,
    );
    return settledBuild;
  }

  private async assembleProjection(
    correlationId: string,
    signal: AbortSignal,
    dependencies: DashboardRecoveryDependencies,
    requestedScope?: DashboardProjectionScope,
    knownScope?: DashboardProjectionScope,
  ): Promise<DashboardProjection> {
    const now = this.options.now?.() ?? new Date();
    const context = await settleWithAbort(
      dependencies.contextReader.readContext(requestedScope, knownScope),
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
      sharedErpProtectionResult,
      runErpOutcomeResult,
      businessOutcomeResult,
      consistencyLagResult,
      trafficMetricResult,
      transportObservationResult,
    ] = await Promise.all([
      saleScope
        ? readSafely("dashboard_inventory", signal, () =>
            dependencies.inventoryStatusService.getStatus(saleScope.saleOfferId),
          )
        : Promise.resolve({ ok: true as const, value: null }),
      readSafely("dashboard_queue", signal, () => dependencies.queueStatusService.getStatus()),
      readSafely("dashboard_shared_erp_protection", signal, () =>
        dependencies.sharedErpProtectionService.getStatus(),
      ),
      scope
        ? readSafely("dashboard_run_erp_outcome", signal, () =>
            dependencies.runErpOutcomeService.getOutcomes(scope),
          )
        : Promise.resolve({ ok: true as const, value: null }),
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
      scope
        ? readSafely("dashboard_transport_observation", signal, () =>
            dependencies.transportObservationReader.read(scope.runId),
          )
        : Promise.resolve({ ok: true as const, value: null }),
    ]);
    const transportObservation = transportObservationResult.ok
      ? transportObservationResult.value
      : null;
    const requestArrivalResult =
      transportObservation !== null
        ? await readSafely("dashboard_request_arrival_summary", signal, async () => {
            return parsePersistedTrafficDeliverySummary(
              transportObservation.persistedTrafficDeliverySummary,
              transportObservation.transportAttemptCounts,
              scope ? `demo run ${scope.runId} finalization` : "dashboard transport observation",
            ).requestArrivalSummary;
          })
        : { ok: true as const, value: null };

    for (const result of [
      inventoryResult,
      queueResult,
      sharedErpProtectionResult,
      runErpOutcomeResult,
      businessOutcomeResult,
      consistencyLagResult,
      trafficMetricResult,
      transportObservationResult,
      requestArrivalResult,
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
      erp: runErpOutcomeResult.ok ? runErpOutcomeResult.value : null,
      systemStatus:
        queueResult.ok && sharedErpProtectionResult.ok
          ? {
              queue: queueResult.value,
              erpProtection: sharedErpProtectionResult.value,
            }
          : null,
      businessOutcome: businessOutcomeResult.ok ? businessOutcomeResult.value : null,
      consistencyLag: consistencyLagResult.ok ? consistencyLagResult.value : null,
      transportAttemptCounts: transportObservationResult.ok
        ? (transportObservationResult.value?.transportAttemptCounts ?? null)
        : null,
      httpSummary: transportObservationResult.ok
        ? (transportObservationResult.value?.httpSummary ?? null)
        : null,
      requestArrivalSummary: requestArrivalResult.ok ? requestArrivalResult.value : null,
      runSignalTimelineSummary: transportObservationResult.ok
        ? (transportObservationResult.value?.runSignalTimelineSummary ?? null)
        : null,
      recoveredAt: now.toISOString(),
    });
  }
}

export interface DashboardRecoveryDependencies {
  contextReader: DashboardRecoveryContextReader;
  businessOutcomeReader: DashboardBusinessOutcomeReader;
  consistencyLagReader: DashboardConsistencyLagReader;
  inventoryStatusService: Pick<InventoryStatusService, "getStatus">;
  queueStatusService: Pick<QueueStatusService, "getStatus">;
  sharedErpProtectionService: Pick<SharedErpProtectionService, "getStatus">;
  runErpOutcomeService: Pick<RunErpOutcomeService, "getOutcomes">;
  trafficMetricReader: DashboardTrafficMetricReader;
  transportObservationReader: DashboardTransportObservationReader;
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
