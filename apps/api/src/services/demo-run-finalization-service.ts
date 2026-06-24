import { randomUUID } from "node:crypto";
import {
  type AcceptedRunConfigSnapshot,
  acceptedRunConfigSnapshotSchema,
  type BusinessOutcomeSummary,
  businessOutcomeSummarySchema,
  type DemoRunSnapshot,
  demoRunSnapshotSchema,
  type TerminalInventorySnapshot,
  type TrafficDeliverySummary,
  type TrafficHttpSummary,
  trafficDeliverySummarySchema,
  trafficHttpSummarySchema,
} from "@checkout-surge/contracts";
import type { DemoRunStatus, DemoRunTrafficStatus } from "@checkout-surge/db";
import {
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  demoRunFinalizations,
  demoRunReservationOutcomes,
  demoRunSummaries,
  demoRuns,
  getInventoryStatus,
  publishDashboardEvent,
  readBusinessOutcomeSummary,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, eq, inArray, sql } from "drizzle-orm";

export interface DemoRunFinalizationController {
  finalizeRun(runId: string, correlationId?: string): Promise<DemoRunSnapshot | null>;
  finalizeReadyRuns(): Promise<number>;
}

type FinalizationDecision =
  | { ready: false; blockers: string[]; timeoutAt: Date }
  | {
      ready: true;
      terminalStatus: "completed" | "failed";
      failureReason: string | null;
      businessOutcome: BusinessOutcomeSummary;
      terminalInventorySnapshot: TerminalInventorySnapshot | null;
    };

export interface TerminalDemoRunSummaryInput {
  run: typeof demoRuns.$inferSelect;
  terminalStatus: "completed" | "failed";
  failureReason: string | null;
  finalizedAt: Date;
  httpSummary: TrafficHttpSummary;
  trafficDeliverySummary: TrafficDeliverySummary;
  httpTimingBreakdownSummary: Record<string, unknown>;
  loadRunDiagnosticsSummary: Record<string, unknown>;
  apiRequestLifecycleSummary: Record<string, unknown>;
  businessOutcome: BusinessOutcomeSummary;
  terminalInventorySnapshot: TerminalInventorySnapshot | null;
  allowedCurrentStatuses: DemoRunStatus[];
  terminalTrafficStatus?: DemoRunTrafficStatus;
}

export class PostgresTerminalDemoRunSummaryWriter {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async write(input: TerminalDemoRunSummaryInput): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`demo_run_finalize:${input.run.id}`}))`,
      );

      const [existingSummary] = await tx
        .select()
        .from(demoRunSummaries)
        .where(eq(demoRunSummaries.runId, input.run.id))
        .limit(1);

      if (existingSummary) {
        await tx
          .update(demoRuns)
          .set({
            status: existingSummary.status,
            ...(input.terminalTrafficStatus ? { trafficStatus: input.terminalTrafficStatus } : {}),
            failureReason: existingSummary.failureReason,
            finalizedAt: existingSummary.endedAt,
            updatedAt: input.finalizedAt,
          })
          .where(
            and(
              eq(demoRuns.id, input.run.id),
              inArray(demoRuns.status, input.allowedCurrentStatuses),
            ),
          );
        return false;
      }

      await tx.insert(demoRunSummaries).values({
        runId: input.run.id,
        presetName: input.run.presetName,
        status: input.terminalStatus,
        failureReason: input.failureReason,
        startedAt: input.run.startedAt,
        endedAt: input.finalizedAt,
        httpSummary: trafficHttpSummarySchema.parse(input.httpSummary),
        trafficDeliverySummary: trafficDeliverySummarySchema.parse(input.trafficDeliverySummary),
        httpTimingBreakdownSummary: input.httpTimingBreakdownSummary,
        loadRunDiagnosticsSummary: input.loadRunDiagnosticsSummary,
        apiRequestLifecycleSummary: input.apiRequestLifecycleSummary,
        businessOutcomeSummary: input.businessOutcome,
        terminalInventorySnapshot: input.terminalInventorySnapshot,
        capturedAt: input.finalizedAt,
        createdAt: input.finalizedAt,
      });

      await tx
        .update(demoRuns)
        .set({
          status: input.terminalStatus,
          ...(input.terminalTrafficStatus ? { trafficStatus: input.terminalTrafficStatus } : {}),
          failureReason: input.failureReason,
          finalizedAt: input.finalizedAt,
          updatedAt: input.finalizedAt,
        })
        .where(
          and(
            eq(demoRuns.id, input.run.id),
            inArray(demoRuns.status, input.allowedCurrentStatuses),
          ),
        );

      return true;
    });
  }
}

export class DemoRunFinalizationService implements DemoRunFinalizationController {
  private readonly summaryWriter: PostgresTerminalDemoRunSummaryWriter;

  constructor(
    private readonly options: {
      db: CheckoutSurgeDatabase;
      redis: CheckoutSurgeRedis;
      logger: CheckoutSurgeLogger;
      now?: () => Date;
      generateId?: () => string;
    },
  ) {
    this.summaryWriter = new PostgresTerminalDemoRunSummaryWriter(options.db);
  }

  async finalizeReadyRuns(): Promise<number> {
    const rows = await this.options.db
      .select({ id: demoRuns.id })
      .from(demoRuns)
      .where(inArray(demoRuns.status, ["draining"]));

    let finalizedCount = 0;
    for (const row of rows) {
      const finalized = await this.finalizeRun(row.id);
      if (finalized?.status === "completed" || finalized?.status === "failed") {
        finalizedCount += 1;
      }
    }

    return finalizedCount;
  }

  async finalizeRun(runId: string, correlationId?: string): Promise<DemoRunSnapshot | null> {
    const now = this.now();
    const [row] = await this.options.db
      .select({ run: demoRuns, finalization: demoRunFinalizations })
      .from(demoRuns)
      .leftJoin(demoRunFinalizations, eq(demoRunFinalizations.runId, demoRuns.id))
      .where(eq(demoRuns.id, runId))
      .limit(1);

    if (!row) {
      return null;
    }

    if (row.run.status === "completed" || row.run.status === "failed") {
      return toDemoRunSnapshot(row.run);
    }

    if (row.run.status !== "draining" || !row.finalization || !row.run.saleOfferId) {
      return toDemoRunSnapshot(row.run);
    }

    const decision = await this.decideFinalization({
      run: row.run,
      finalization: row.finalization,
      now,
    });

    if (!decision.ready) {
      this.options.logger.debug(
        {
          runId,
          blockers: decision.blockers,
          timeoutAt: decision.timeoutAt.toISOString(),
        },
        "Demo run remains draining.",
      );
      return toDemoRunSnapshot(row.run);
    }

    const wroteSummary = await this.summaryWriter.write({
      run: row.run,
      terminalStatus: decision.terminalStatus,
      failureReason: decision.failureReason,
      finalizedAt: now,
      httpSummary: trafficHttpSummarySchema.parse(row.finalization.httpSummary),
      trafficDeliverySummary: trafficDeliverySummarySchema.parse(
        row.finalization.trafficDeliverySummary,
      ),
      httpTimingBreakdownSummary: row.finalization.httpTimingBreakdownSummary,
      loadRunDiagnosticsSummary: row.finalization.loadRunDiagnosticsSummary,
      apiRequestLifecycleSummary: row.finalization.apiRequestLifecycleSummary,
      businessOutcome: decision.businessOutcome,
      terminalInventorySnapshot: decision.terminalInventorySnapshot,
      allowedCurrentStatuses: ["draining"],
    });
    const updatedRun = await this.readRun(runId);

    if (wroteSummary) {
      await this.publishTerminalRunEvent(updatedRun, correlationId, now);
    }

    return updatedRun;
  }

  private async decideFinalization(input: {
    run: typeof demoRuns.$inferSelect;
    finalization: typeof demoRunFinalizations.$inferSelect;
    now: Date;
  }): Promise<FinalizationDecision> {
    const config = acceptedRunConfigSnapshotSchema.parse(input.run.configSnapshot);
    const timeoutAt = this.drainTimeoutAt(input.run, config);
    const businessOutcome = await readBusinessOutcomeSummary(this.options.db, {
      saleOfferId: requireSaleOfferId(input.run),
      runId: input.run.id,
    });
    const blockers = businessDrainBlockers(businessOutcome);
    const timedOut = input.now.getTime() >= timeoutAt.getTime();

    if (blockers.length > 0 && !timedOut) {
      return { ready: false, blockers, timeoutAt };
    }

    const terminalInventorySnapshot = await this.captureTerminalInventorySnapshot({
      run: input.run,
      businessOutcome,
      capturedAt: input.now,
    });
    const failureReason = this.deriveFailureReason({
      run: input.run,
      finalization: input.finalization,
      timedOut: blockers.length > 0 && timedOut,
    });

    return {
      ready: true,
      terminalStatus: failureReason ? "failed" : "completed",
      failureReason,
      businessOutcome,
      terminalInventorySnapshot,
    };
  }

  private drainTimeoutAt(
    run: typeof demoRuns.$inferSelect,
    config: AcceptedRunConfigSnapshot,
  ): Date {
    const startedAt = run.trafficEndedAt ?? run.updatedAt;
    return new Date(startedAt.getTime() + config.backpressureConfig.drainTimeoutSeconds * 1000);
  }

  private deriveFailureReason(input: {
    run: typeof demoRuns.$inferSelect;
    finalization: typeof demoRunFinalizations.$inferSelect;
    timedOut: boolean;
  }): string | null {
    if (input.timedOut) {
      return "business_drain_timeout";
    }

    const trafficDelivery = trafficDeliverySummarySchema.parse(
      input.finalization.trafficDeliverySummary,
    );
    if (trafficDelivery.trafficDeliveryStatus === "failed") {
      return "traffic_delivery_major_shortfall";
    }

    if (input.run.trafficStatus === "failed" || input.finalization.errorMessage) {
      return "traffic_failed";
    }

    return null;
  }

  private async captureTerminalInventorySnapshot(input: {
    run: typeof demoRuns.$inferSelect;
    businessOutcome: BusinessOutcomeSummary;
    capturedAt: Date;
  }): Promise<TerminalInventorySnapshot | null> {
    const saleOfferId = requireSaleOfferId(input.run);

    try {
      const inventory = await getInventoryStatus(this.options.redis, saleOfferId, input.capturedAt);
      return {
        saleOfferId,
        startingStock: inventory.allocatedStock,
        remainingStock: inventory.remainingStock,
        reservedStock: inventory.reservedStock,
        acceptedReservations: input.businessOutcome.acceptedReservations,
        soldOutRejections: await this.readSoldOutRejections(input.run.id, inventory),
        pendingPersistenceCount: inventory.pendingPersistenceCount,
        capturedAt: input.capturedAt.toISOString(),
        source: "redis",
      };
    } catch (error) {
      this.options.logger.warn(
        { err: error, runId: input.run.id, saleOfferId },
        "Could not capture terminal inventory snapshot during run finalization.",
      );
      return null;
    }
  }

  private async readSoldOutRejections(
    runId: string,
    inventory: Awaited<ReturnType<typeof getInventoryStatus>>,
  ): Promise<number> {
    const [row] = await this.options.db
      .select({ count: demoRunReservationOutcomes.count })
      .from(demoRunReservationOutcomes)
      .where(
        and(
          eq(demoRunReservationOutcomes.runId, runId),
          eq(demoRunReservationOutcomes.outcome, "api_sold_out_decision"),
        ),
      )
      .limit(1);

    return row?.count ?? inventory.soldOutPressure.rejectionCount;
  }

  private async readRun(runId: string): Promise<DemoRunSnapshot> {
    const [run] = await this.options.db
      .select()
      .from(demoRuns)
      .where(eq(demoRuns.id, runId))
      .limit(1);

    if (!run) {
      throw new Error(`Demo run ${runId} disappeared during finalization.`);
    }

    return toDemoRunSnapshot(run);
  }

  private async publishTerminalRunEvent(
    run: DemoRunSnapshot,
    correlationId: string | undefined,
    occurredAt: Date,
  ): Promise<void> {
    try {
      await publishDashboardEvent(this.options.redis, {
        type: run.status === "completed" ? "run.completed" : "run.failed",
        eventId: this.generateId(),
        runId: run.runId,
        ...(correlationId ? { correlationId } : {}),
        run,
        occurredAt: occurredAt.toISOString(),
      });
    } catch (error) {
      this.options.logger.warn(
        { err: error, runId: run.runId },
        "Could not publish terminal run dashboard event.",
      );
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private generateId(): string {
    return this.options.generateId?.() ?? randomUUID();
  }
}

function businessDrainBlockers(outcome: BusinessOutcomeSummary): string[] {
  const parsed = businessOutcomeSummarySchema.parse(outcome);
  const blockers: string[] = [];

  if (parsed.pendingPersistenceCount > 0) {
    blockers.push("pending_persistence");
  }
  if (parsed.queuedOrders > 0) {
    blockers.push("queued_orders");
  }
  if (parsed.processingOrders > 0) {
    blockers.push("processing_orders");
  }
  if (parsed.retryingOrders > 0) {
    blockers.push("retrying_orders");
  }
  if (parsed.notificationsRecorded < parsed.confirmedOrders) {
    blockers.push("missing_notifications");
  }

  return blockers;
}

function requireSaleOfferId(run: typeof demoRuns.$inferSelect): string {
  if (!run.saleOfferId) {
    throw new Error(`Demo run ${run.id} has no sale offer.`);
  }
  return run.saleOfferId;
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
