import {
  type BusinessOutcomeSummary,
  type DashboardRecoveryResponse,
  type DemoRunSnapshot,
  dashboardRecoveryResponseSchema,
  demoRunSnapshotSchema,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  demoRuns,
  readBusinessOutcomeSummary,
  saleOffers,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
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

export class DashboardRecoveryService {
  constructor(
    private readonly options: {
      contextReader: DashboardRecoveryContextReader;
      businessOutcomeReader: DashboardBusinessOutcomeReader;
      inventoryStatusService: InventoryStatusService;
      queueStatusService: QueueStatusService;
      erpStatusService: ErpStatusService;
      logger: CheckoutSurgeLogger;
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

    const [inventoryResult, queueResult, erpResult, businessOutcomeResult] = await Promise.all([
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
    ]);

    for (const result of [
      contextResult,
      inventoryResult,
      queueResult,
      erpResult,
      businessOutcomeResult,
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
      recentMetrics: [],
      queue: queueResult.ok ? queueResult.value : null,
      erp: erpResult.ok ? erpResult.value : null,
      businessOutcome: businessOutcomeResult.ok ? businessOutcomeResult.value : null,
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
