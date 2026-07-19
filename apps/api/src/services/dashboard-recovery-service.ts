import {
  type BusinessOutcomeSummary,
  type CompletionOutcome,
  type ConsistencyLagSummary,
  type DashboardRecoveryResponse,
  type DemoRunSnapshot,
  dashboardRecoveryResponseSchema,
  demoRunSnapshotSchema,
  type MetricSample,
  type TransportAttemptCounts,
  transportAttemptCountsSchema,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  demoRunFinalizations,
  demoRuns,
  readBusinessOutcomeSummary,
  readConsistencyLagSummary,
  readRecentCompletionOutcomes,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { abortReason, settleWithAbort } from "../runtime/operation-lifecycle.js";
import type { DashboardTrafficMetricReader } from "./demo-run-service.js";
import type { ErpStatusService } from "./erp-status-service.js";
import type { InventoryStatusService } from "./inventory-status-service.js";
import type { QueueStatusService } from "./queue-status-service.js";
import { normalizeTrafficDeliverySummary } from "./traffic-delivery-classifier.js";

export interface DashboardRecoveryContext {
  currentRun: DemoRunSnapshot | null;
  saleOfferId: string | null;
}

export interface DashboardRecoveryContextReader {
  readContext(): Promise<DashboardRecoveryContext>;
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
export interface DashboardTransportAccountingReader {
  read(runId: string): Promise<TransportAttemptCounts | null>;
}

export class PostgresDashboardTransportAccountingReader
  implements DashboardTransportAccountingReader
{
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async read(runId: string): Promise<TransportAttemptCounts | null> {
    const [row] = await this.db
      .select({ trafficDeliverySummary: demoRunFinalizations.trafficDeliverySummary })
      .from(demoRunFinalizations)
      .where(eq(demoRunFinalizations.runId, runId))
      .limit(1);

    if (!row) return null;
    const delivery = normalizeTrafficDeliverySummary(row.trafficDeliverySummary);
    return transportAttemptCountsSchema.parse({
      plannedRequests: delivery.plannedRequests,
      startedRequests: delivery.startedRequests,
      completedRequests: delivery.completedRequests,
      interruptedRequests: delivery.interruptedRequests,
      unstartedRequests: delivery.unstartedRequests,
    });
  }
}

export class PostgresDashboardRecoveryContextReader implements DashboardRecoveryContextReader {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async readContext(): Promise<DashboardRecoveryContext> {
    const [currentRunRow] = await this.db
      .select()
      .from(demoRuns)
      .where(inArray(demoRuns.status, ["starting", "active", "draining"]))
      .orderBy(
        desc(sql`coalesce(${demoRuns.startedAt}, ${demoRuns.createdAt})`),
        desc(demoRuns.createdAt),
        desc(demoRuns.id),
      )
      .limit(1);

    if (currentRunRow) {
      const currentRun = toDemoRunSnapshot(currentRunRow);

      return {
        currentRun,
        saleOfferId: currentRun.saleOfferId ?? null,
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

export class DashboardRecoveryService {
  constructor(
    private readonly options: {
      contextReader?: DashboardRecoveryContextReader;
      businessOutcomeReader?: DashboardBusinessOutcomeReader;
      consistencyLagReader?: DashboardConsistencyLagReader;
      completionOutcomeReader?: DashboardCompletionOutcomeReader;
      inventoryStatusService?: InventoryStatusService;
      queueStatusService?: QueueStatusService;
      erpStatusService?: ErpStatusService;
      logger: CheckoutSurgeLogger;
      trafficMetricReader?: DashboardTrafficMetricReader;
      transportAccountingReader?: DashboardTransportAccountingReader;
      now?: () => Date;
      openOperation?: DashboardRecoveryOperationFactory;
    },
  ) {}

  async getRecovery(input: {
    correlationId: string;
    signal?: AbortSignal;
  }): Promise<DashboardRecoveryResponse> {
    const signal = input.signal ?? new AbortController().signal;
    if (signal.aborted) throw abortReason(signal);
    const operation = this.options.openOperation
      ? await this.options.openOperation(signal)
      : { dependencies: this.fixedDependencies() };

    try {
      return await this.assembleRecovery(input.correlationId, signal, operation.dependencies);
    } finally {
      await operation.close?.();
    }
  }

  private async assembleRecovery(
    correlationId: string,
    signal: AbortSignal,
    dependencies: DashboardRecoveryDependencies,
  ): Promise<DashboardRecoveryResponse> {
    const now = this.options.now?.() ?? new Date();
    const contextResult = await readSafely("dashboard_run_context", signal, () =>
      dependencies.contextReader.readContext(),
    );
    const context = contextResult.ok
      ? contextResult.value
      : { currentRun: null, saleOfferId: null };
    const scope = context.currentRun
      ? Object.freeze({
          runId: context.currentRun.runId,
          saleOfferId: context.currentRun.saleOfferId ?? null,
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
      transportAccountingResult,
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
            dependencies.trafficMetricReader
              ? dependencies.trafficMetricReader.readRecent(scope.runId)
              : Promise.resolve([] satisfies MetricSample[]),
          )
        : Promise.resolve({ ok: true as const, value: [] satisfies MetricSample[] }),
      saleScope
        ? readSafely("dashboard_completion_outcomes", signal, () =>
            dependencies.completionOutcomeReader.read(saleScope, now),
          )
        : Promise.resolve({ ok: true as const, value: [] }),
      scope
        ? readSafely("dashboard_transport_accounting", signal, () =>
            dependencies.transportAccountingReader
              ? dependencies.transportAccountingReader.read(scope.runId)
              : Promise.resolve(null),
          )
        : Promise.resolve({ ok: true as const, value: null }),
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
      transportAccountingResult,
    ]) {
      if (!result.ok) {
        this.options.logger.warn(
          { err: result.error, projection: result.projection },
          "Dashboard recovery projection unavailable.",
        );
      }
    }

    return dashboardRecoveryResponseSchema.parse({
      correlationId,
      scope,
      currentRun: context.currentRun,
      inventory: inventoryResult.ok ? inventoryResult.value : null,
      recentMetrics: trafficMetricResult.ok ? trafficMetricResult.value : [],
      queue: queueResult.ok ? queueResult.value : null,
      erp: erpResult.ok ? erpResult.value : null,
      businessOutcome: businessOutcomeResult.ok ? businessOutcomeResult.value : null,
      consistencyLag: consistencyLagResult.ok ? consistencyLagResult.value : null,
      recentCompletionOutcomes: completionOutcomeResult.ok ? completionOutcomeResult.value : [],
      transportAccounting: transportAccountingResult.ok ? transportAccountingResult.value : null,
      recoveredAt: now.toISOString(),
    });
  }

  private fixedDependencies(): DashboardRecoveryDependencies {
    const required = {
      contextReader: this.options.contextReader,
      businessOutcomeReader: this.options.businessOutcomeReader,
      consistencyLagReader: this.options.consistencyLagReader,
      completionOutcomeReader: this.options.completionOutcomeReader,
      inventoryStatusService: this.options.inventoryStatusService,
      queueStatusService: this.options.queueStatusService,
      erpStatusService: this.options.erpStatusService,
    };

    for (const [name, dependency] of Object.entries(required)) {
      if (!dependency) throw new Error(`Dashboard recovery dependency ${name} is not configured.`);
    }

    return {
      contextReader: required.contextReader as DashboardRecoveryContextReader,
      businessOutcomeReader: required.businessOutcomeReader as DashboardBusinessOutcomeReader,
      consistencyLagReader: required.consistencyLagReader as DashboardConsistencyLagReader,
      completionOutcomeReader: required.completionOutcomeReader as DashboardCompletionOutcomeReader,
      inventoryStatusService: required.inventoryStatusService as InventoryStatusService,
      queueStatusService: required.queueStatusService as QueueStatusService,
      erpStatusService: required.erpStatusService as ErpStatusService,
      ...(this.options.trafficMetricReader
        ? { trafficMetricReader: this.options.trafficMetricReader }
        : {}),
      ...(this.options.transportAccountingReader
        ? { transportAccountingReader: this.options.transportAccountingReader }
        : {}),
    };
  }
}

export interface DashboardRecoveryDependencies {
  contextReader: DashboardRecoveryContextReader;
  businessOutcomeReader: DashboardBusinessOutcomeReader;
  consistencyLagReader: DashboardConsistencyLagReader;
  completionOutcomeReader: DashboardCompletionOutcomeReader;
  inventoryStatusService: InventoryStatusService;
  queueStatusService: QueueStatusService;
  erpStatusService: ErpStatusService;
  trafficMetricReader?: DashboardTrafficMetricReader;
  transportAccountingReader?: DashboardTransportAccountingReader;
}

export interface DashboardRecoveryOperation {
  dependencies: DashboardRecoveryDependencies;
  close?(): void | Promise<void>;
}

export type DashboardRecoveryOperationFactory = (
  signal: AbortSignal,
) => DashboardRecoveryOperation | Promise<DashboardRecoveryOperation>;

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
