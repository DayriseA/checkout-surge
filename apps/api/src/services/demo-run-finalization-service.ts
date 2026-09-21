import {
  type AcceptedRunConfigSnapshot,
  type BusinessOutcomeSummary,
  businessOutcomeSummarySchema,
  type DemoRunSnapshot,
  emptyServerReservationTimingSummary,
  httpTimingBreakdownSummarySchema,
  type InternalRunFailureReason,
  type InventoryStatus,
  isReplayPossible,
  realLoadRunDiagnosticsSummarySchema,
  type TrafficDeliverySummary,
  type TrafficHttpSummary,
  type TransportAttemptCounts,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  demoRunFinalizations,
  demoRuns,
  getInventoryStatus,
  orderRecoveryJobs,
  orders,
  publishDashboardProjectionDirtySignal,
  readBusinessOutcomeSummary,
  readRunSignalTimeline,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, eq, inArray } from "drizzle-orm";
import { OperationDeadlineExceededError, settleWithAbort } from "../runtime/operation-lifecycle.js";
import {
  acceptedResponseAccountingWarning,
  reconcileAcceptedResponses,
} from "./accepted-response-accounting.js";
import { toDemoRunSnapshot, toRedisTerminalInventorySnapshot } from "./demo-run-projections.js";
import {
  parsePersistedAcceptedRunConfigSnapshot,
  parsePersistedState,
  parsePersistedTerminalInventorySnapshot,
} from "./persisted-demo-run-state.js";
import type { TerminalReservationTimingReader } from "./reservation-timing-observation.js";
import type { TerminalDemoRunWriter } from "./terminal-demo-run-writer.js";
import {
  classifyTrafficTransport,
  parsePersistedTrafficDeliverySummary,
  parsePersistedTrafficHttpSummary,
  parsePersistedTransportAttemptCounts,
} from "./traffic-delivery-classifier.js";

export interface TerminalInventoryReadOperation {
  read(input: {
    saleOfferId: string;
    observedAt: Date;
    signal: AbortSignal;
  }): Promise<InventoryStatus>;
}

export interface DemoRunFinalizationController {
  finalizeRun(runId: string, correlationId?: string): Promise<DemoRunSnapshot | null>;
  finalizeReadyRuns(): Promise<number>;
}

type FinalizationDecision = { ready: false; blockers: string[] } | { ready: true };
type FinalizationActor = "completion-report" | "sweep";

export class DemoRunFinalizationService implements DemoRunFinalizationController {
  constructor(
    private readonly options: {
      db: CheckoutSurgeDatabase;
      redis: CheckoutSurgeRedis;
      logger: CheckoutSurgeLogger;
      terminalRunWriter: Pick<TerminalDemoRunWriter, "writePrepared">;
      terminalInventoryRead: TerminalInventoryReadOperation;
      terminalInventoryReadTimeoutMs: number;
      reservationTiming?: TerminalReservationTimingReader;
      now?: () => Date;
    },
  ) {
    if (
      !Number.isSafeInteger(options.terminalInventoryReadTimeoutMs) ||
      options.terminalInventoryReadTimeoutMs <= 0
    ) {
      throw new RangeError("terminalInventoryReadTimeoutMs must be a positive integer.");
    }
  }

  async finalizeReadyRuns(): Promise<number> {
    const rows = await this.options.db
      .select({ id: demoRuns.id })
      .from(demoRuns)
      .innerJoin(demoRunFinalizations, eq(demoRunFinalizations.runId, demoRuns.id))
      .where(
        and(
          inArray(demoRuns.status, ["draining"]),
          eq(demoRunFinalizations.completionEnrichmentStatus, "completed"),
        ),
      );

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
    const finalization = row.finalization;

    if (finalization.completionEnrichmentStatus === "pending") {
      this.options.logger.debug(
        { runId },
        "Demo run remains draining while traffic-completion enrichment is pending.",
      );
      return toDemoRunSnapshot(row.run);
    }

    const decision = await this.decideFinalization({
      run: row.run,
      finalization,
      now,
    });

    if (!decision.ready) {
      this.options.logger.debug(
        {
          runId,
          blockers: decision.blockers,
        },
        "Demo run remains draining.",
      );
      return toDemoRunSnapshot(row.run);
    }

    const evidence = parseFinalizationEvidence(row.run, finalization);
    try {
      validateTrafficCompletionInventoryEvidence(finalization, runId);
    } catch (error) {
      this.options.logger.warn(
        { err: error, runId },
        "Demo run remains draining because its traffic-completion inventory evidence is invalid.",
      );
      return toDemoRunSnapshot(row.run);
    }
    const wroteSummary = await this.options.terminalRunWriter.writePrepared(
      runId,
      async (lockedDb) => {
        // The writer has already acquired the exclusive run lock and opened its
        // transaction. Every final PostgreSQL read must use this facade: using
        // options.db here would both escape the fence and nest a pool checkout.
        const latestBusinessOutcome = await readBusinessOutcomeSummary(lockedDb, {
          saleOfferId: requireSaleOfferId(row.run),
          runId: row.run.id,
        });
        let latestInventory: InventoryStatus;
        try {
          latestInventory = await this.readTerminalInventory(requireSaleOfferId(row.run), now);
        } catch (error) {
          this.options.logger.warn(
            { err: error, runId, saleOfferId: requireSaleOfferId(row.run) },
            "Could not recheck pending Redis reservations inside the terminal run fence.",
          );
          return null;
        }
        if (latestInventory.pendingPersistenceCount > 0) {
          this.options.logger.debug(
            { runId, pendingPersistenceCount: latestInventory.pendingPersistenceCount },
            "Demo run remains draining until every pending Redis hold is classified.",
          );
          return null;
        }
        if (
          latestInventory.soldOutPressure.rejectionCount !== latestBusinessOutcome.soldOutRejections
        ) {
          this.options.logger.warn(
            {
              runId,
              redisSoldOutRejections: latestInventory.soldOutPressure.rejectionCount,
              durableSoldOutRejections: latestBusinessOutcome.soldOutRejections,
            },
            "Demo run remains draining because Redis and durable sold-out evidence disagree.",
          );
          return null;
        }

        const latestRecoveryObligations = await readRecoveryObligations(lockedDb, row.run.id);
        const latestBusinessBlockers = businessDrainBlockers(
          latestBusinessOutcome,
          latestInventory.pendingPersistenceCount,
          latestRecoveryObligations,
        );
        const latestAccounting = reconcileAcceptedResponses({
          ...evidence,
          business: {
            ...latestBusinessOutcome,
            pendingPersistenceCount: latestInventory.pendingPersistenceCount,
          },
        });
        const latestBlockers = [
          ...latestBusinessBlockers,
          ...(latestAccounting.accounted ? [] : ["accepted_response_accounting"]),
        ];
        if (latestBlockers.length > 0) {
          this.options.logger.debug(
            { runId, blockers: latestBlockers },
            "Demo run remains draining after late business work was observed.",
          );
          return null;
        }

        const latestFailureReason = this.deriveFailureReason({
          delivery: evidence.delivery,
          http: evidence.http,
          transportAttemptCounts: evidence.transportAttemptCounts,
          trafficFailed: row.run.trafficStatus === "failed" || Boolean(finalization.errorMessage),
        });
        const accountingWarning = acceptedResponseAccountingWarning(latestAccounting);
        const loadRunDiagnosticsSummary = accountingWarning
          ? appendAccountingWarning(evidence.diagnostics, accountingWarning)
          : evidence.diagnostics;
        const runSignalTimelineSummary = await readRunSignalTimeline(
          lockedDb,
          {
            saleOfferId: requireSaleOfferId(row.run),
            runId: row.run.id,
          },
          {
            firstAttemptStartedAt: evidence.delivery.requestArrivalSummary.firstAttemptStartedAt,
            dispatchDurationSeconds:
              evidence.delivery.requestArrivalSummary.dispatchDurationSeconds,
            peakArrivalWindowSeconds:
              evidence.delivery.requestArrivalSummary.peakArrivalWindowSeconds,
            capturedAt: now,
          },
        );

        return {
          run: row.run,
          terminalStatus: latestFailureReason ? "failed" : "completed",
          failureReason: latestFailureReason,
          replayPossible: isReplayPossible(evidence.config),
          finalizedAt: now,
          transportAttemptCounts: evidence.transportAttemptCounts,
          httpSummary: evidence.http,
          trafficDeliverySummary: evidence.delivery,
          httpTimingBreakdownSummary: evidence.timing,
          serverReservationTimingSummary: await this.readReservationTiming(runId),
          loadRunDiagnosticsSummary,
          businessOutcome: latestBusinessOutcome,
          terminalInventorySnapshot: toRedisTerminalInventorySnapshot({
            saleOfferId: requireSaleOfferId(row.run),
            inventory: latestInventory,
            businessOutcome: latestBusinessOutcome,
            capturedAt: now,
          }),
          runSignalTimelineSummary,
          allowedCurrentStatuses: ["draining"],
        };
      },
    );
    const updatedRun = await this.readRun(runId);

    if (wroteSummary) {
      await this.publishTerminalProjectionDirty(
        updatedRun,
        correlationId ?? row.run.correlationId,
        correlationId ? "completion-report" : "sweep",
      );
    }

    return updatedRun;
  }

  private async decideFinalization(input: {
    run: typeof demoRuns.$inferSelect;
    finalization: typeof demoRunFinalizations.$inferSelect;
    now: Date;
  }): Promise<FinalizationDecision> {
    const businessOutcome = await readBusinessOutcomeSummary(this.options.db, {
      saleOfferId: requireSaleOfferId(input.run),
      runId: input.run.id,
    });
    let pendingRedisCount = 0;
    try {
      pendingRedisCount = (
        await getInventoryStatus(this.options.redis, requireSaleOfferId(input.run), input.now)
      ).pendingPersistenceCount;
    } catch (error) {
      this.options.logger.warn(
        { err: error, runId: input.run.id, saleOfferId: requireSaleOfferId(input.run) },
        "Could not read pending Redis reservations during finalization.",
      );
      pendingRedisCount = Number.POSITIVE_INFINITY;
    }
    const recoveryObligations = await readRecoveryObligations(this.options.db, input.run.id);
    const businessBlockers = businessDrainBlockers(
      businessOutcome,
      pendingRedisCount,
      recoveryObligations,
    );
    const evidence = parseFinalizationEvidence(input.run, input.finalization);
    const accounting = reconcileAcceptedResponses({
      ...evidence,
      business: { ...businessOutcome, pendingPersistenceCount: pendingRedisCount },
    });
    const blockers = [
      ...businessBlockers,
      ...(accounting.accounted ? [] : ["accepted_response_accounting"]),
    ];
    if (blockers.length > 0) {
      return { ready: false, blockers };
    }

    return { ready: true };
  }

  private async readTerminalInventory(
    saleOfferId: string,
    observedAt: Date,
  ): Promise<InventoryStatus> {
    const timeoutMs = this.options.terminalInventoryReadTimeoutMs;
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort(new OperationDeadlineExceededError(timeoutMs));
    }, timeoutMs);
    deadline.unref();

    try {
      return await settleWithAbort(
        this.options.terminalInventoryRead.read({
          saleOfferId,
          observedAt,
          signal: controller.signal,
        }),
        controller.signal,
      );
    } finally {
      clearTimeout(deadline);
    }
  }

  private deriveFailureReason(input: {
    delivery: TrafficDeliverySummary;
    http: TrafficHttpSummary;
    transportAttemptCounts: TransportAttemptCounts;
    trafficFailed: boolean;
  }): InternalRunFailureReason | null {
    if (input.delivery.trafficDeliveryStatus === "failed") {
      return "traffic_delivery_major_shortfall";
    }
    if (input.http.unexpectedResponses > 0) {
      return "traffic_outcome_unexpected_responses";
    }
    if (
      classifyTrafficTransport({
        startedRequests: input.transportAttemptCounts.startedRequests,
        transportFailures: input.http.transportFailures,
      }) === "failed"
    ) {
      return "traffic_transport_major_loss";
    }

    if (input.trafficFailed) {
      return "traffic_failed";
    }

    return null;
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

  private async publishTerminalProjectionDirty(
    run: DemoRunSnapshot,
    correlationId: string | null,
    finalizationActor: FinalizationActor,
  ): Promise<void> {
    try {
      await publishDashboardProjectionDirtySignal(this.options.redis, {
        type: "dashboard.projection.dirty",
        ...(correlationId ? { correlationId } : {}),
        ...(run.saleOfferId ? { scope: { runId: run.runId, saleOfferId: run.saleOfferId } } : {}),
      });
      this.options.logger.debug(
        { runId: run.runId, correlationId, finalizationActor },
        "Published terminal projection dirty signal.",
      );
    } catch (error) {
      this.options.logger.warn(
        { err: error, runId: run.runId, correlationId, finalizationActor },
        "Could not publish terminal projection dirty signal.",
      );
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async readReservationTiming(runId: string) {
    if (!this.options.reservationTiming) return emptyServerReservationTimingSummary;
    try {
      return await this.options.reservationTiming.readAndFence(runId);
    } catch (error) {
      this.options.logger.warn(
        { err: error, runId },
        "Could not capture advisory server-side reservation timing.",
      );
      return emptyServerReservationTimingSummary;
    }
  }
}

function parseFinalizationEvidence(
  run: typeof demoRuns.$inferSelect,
  finalization: typeof demoRunFinalizations.$inferSelect,
): {
  config: AcceptedRunConfigSnapshot;
  transportAttemptCounts: TransportAttemptCounts;
  delivery: TrafficDeliverySummary;
  http: TrafficHttpSummary;
  timing: ReturnType<typeof httpTimingBreakdownSummarySchema.parse>;
  diagnostics: ReturnType<typeof realLoadRunDiagnosticsSummarySchema.parse>;
} {
  const context = `demo run ${run.id} finalization`;
  const timing = parsePersistedState(
    httpTimingBreakdownSummarySchema,
    finalization.httpTimingBreakdownSummary,
    context,
    "httpTimingBreakdownSummary",
  );
  const diagnostics = parsePersistedState(
    realLoadRunDiagnosticsSummarySchema,
    finalization.loadRunDiagnosticsSummary,
    context,
    "loadRunDiagnosticsSummary",
  );
  const transportAttemptCounts = parsePersistedTransportAttemptCounts(
    finalization.transportAttemptCounts,
    context,
  );
  return {
    config: parsePersistedAcceptedRunConfigSnapshot(run.configSnapshot, context),
    transportAttemptCounts,
    delivery: parsePersistedTrafficDeliverySummary(
      finalization.trafficDeliverySummary,
      transportAttemptCounts,
      context,
    ),
    http: parsePersistedTrafficHttpSummary(finalization.httpSummary, context),
    timing,
    diagnostics,
  };
}

function appendAccountingWarning(
  diagnostics: Record<string, unknown>,
  warning: Record<string, unknown>,
): Record<string, unknown> {
  const existingWarnings = Array.isArray(diagnostics.accountingWarnings)
    ? diagnostics.accountingWarnings
    : [];
  return { ...diagnostics, accountingWarnings: [...existingWarnings, warning] };
}

function validateTrafficCompletionInventoryEvidence(
  finalization: typeof demoRunFinalizations.$inferSelect,
  runId: string,
): void {
  if (!("terminalInventorySnapshot" in finalization.trafficOutcomeSummary)) return;
  parsePersistedTerminalInventorySnapshot(
    finalization.trafficOutcomeSummary.terminalInventorySnapshot,
    `demo run ${runId} finalization trafficOutcomeSummary`,
  );
}

function businessDrainBlockers(
  outcome: BusinessOutcomeSummary,
  pendingRedisCount = 0,
  recovery: RecoveryObligations = emptyRecoveryObligations,
): string[] {
  const parsed = businessOutcomeSummarySchema.parse(outcome);
  const blockers: string[] = [];

  if (pendingRedisCount > 0) {
    blockers.push("pending_persistence");
  }
  if (recovery.pendingCount > 0) {
    blockers.push("reconciliation_pending");
  }
  if (recovery.unresolvedCallCount > 0) {
    blockers.push("uncertain_calls");
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

interface RecoveryObligations {
  pendingCount: number;
  unresolvedCallCount: number;
}

const emptyRecoveryObligations: RecoveryObligations = {
  pendingCount: 0,
  unresolvedCallCount: 0,
};

async function readRecoveryObligations(
  db: CheckoutSurgeDatabase,
  runId: string,
): Promise<RecoveryObligations> {
  const rows = await db
    .select({
      status: orderRecoveryJobs.status,
      unresolvedErpCallId: orderRecoveryJobs.unresolvedErpCallId,
    })
    .from(orderRecoveryJobs)
    .innerJoin(orders, eq(orders.id, orderRecoveryJobs.orderId))
    .where(eq(orders.runId, runId));
  return {
    pendingCount: rows.filter((row) => row.status !== "resolved").length,
    unresolvedCallCount: rows.filter((row) => row.unresolvedErpCallId !== null).length,
  };
}

function requireSaleOfferId(run: typeof demoRuns.$inferSelect): string {
  if (!run.saleOfferId) {
    throw new Error(`Demo run ${run.id} has no sale offer.`);
  }
  return run.saleOfferId;
}
