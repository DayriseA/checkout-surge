import {
  type AdminDeleteRunHistoryRequest,
  type AdminDeleteRunHistoryResponse,
  type AdminRunHistoryDetailResponse,
  adminDeleteRunHistoryResponseSchema,
  adminRunHistoryDetailResponseSchema,
  countUnavailableLoadRunDiagnosticProbes,
  deriveLoadExecutionPlan,
  deriveRecordedReplyCount,
  deriveRunResult,
  evaluateFastReservationTarget,
  httpTimingBreakdownSummarySchema,
  internalRunFailureReasonSchema,
  type LoadRunDiagnosticsSummary,
  loadRunDiagnosticsSummarySchema,
  type PublicRunHistoryDetailResponse,
  type PublicRunHistoryRun,
  type PublicRunHistorySummary,
  publicRunHistoryDetailResponseSchema,
  publicRunHistoryRunSchema,
  publicRunHistorySummarySchema,
  type RunHistoryErpAttempt,
  type RunHistoryEventTimelineEntry,
  type RunHistoryListItem,
  type RunHistoryListQuery,
  type RunHistoryListResponse,
  type RunHistoryNotification,
  type RunHistoryOrderOutcome,
  type RunHistorySummary,
  runHistoryErpAttemptSchema,
  runHistoryEventTimelineEntrySchema,
  runHistoryListItemSchema,
  runHistoryListResponseSchema,
  runHistoryNotificationSchema,
  runHistoryOrderOutcomeSchema,
  runHistorySummarySchema,
  runSignalTimelineSummarySchema,
  serverReservationTimingSummarySchema,
  toPublicRunFailureCategory,
  toRunSignalTimelineHeadline,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  demoRunSummaries,
  demoRuns,
  erpAttempts,
  orderEvents,
  orders,
  simulatedNotifications,
} from "@checkout-surge/db";
import { count, desc, eq, inArray, sql } from "drizzle-orm";
import { toDemoRunSnapshot } from "./demo-run-projections.js";
import {
  parsePersistedAcceptedRunConfigSnapshot,
  parsePersistedBusinessOutcomeSummary,
  parsePersistedState,
  parsePersistedTerminalInventorySnapshot,
} from "./persisted-demo-run-state.js";
import {
  parsePersistedTrafficDeliverySummary,
  parsePersistedTrafficHttpSummary,
  parsePersistedTransportAttemptCounts,
} from "./traffic-delivery-classifier.js";

const detailRecordLimit = 20;

export interface RunHistoryController {
  list(input: RunHistoryListQuery): Promise<RunHistoryListResponse>;
  detail(runId: string): Promise<PublicRunHistoryDetailResponse | null>;
  adminDetail(runId: string): Promise<AdminRunHistoryDetailResponse | null>;
  delete(
    input: AdminDeleteRunHistoryRequest,
    correlationId: string,
  ): Promise<AdminDeleteRunHistoryResponse>;
}

export class RunHistoryService implements RunHistoryController {
  constructor(
    private readonly options: {
      db: CheckoutSurgeDatabase;
      now?: () => Date;
    },
  ) {}

  async list(input: RunHistoryListQuery): Promise<RunHistoryListResponse> {
    const offset = (input.page - 1) * input.pageSize;
    const [rows, totalRows] = await Promise.all([
      this.options.db
        .select({
          summary: demoRunSummaries,
          configSnapshot: demoRuns.configSnapshot,
        })
        .from(demoRunSummaries)
        .innerJoin(demoRuns, eq(demoRuns.id, demoRunSummaries.runId))
        .orderBy(desc(demoRunSummaries.capturedAt), desc(demoRunSummaries.createdAt))
        .limit(input.pageSize)
        .offset(offset),
      this.options.db.select({ totalCount: count() }).from(demoRunSummaries),
    ]);

    return runHistoryListResponseSchema.parse({
      summaries: rows.map(({ configSnapshot, summary }) =>
        toRunHistoryListItem(summary, configSnapshot),
      ),
      page: input.page,
      pageSize: input.pageSize,
      totalCount: totalRows[0]?.totalCount ?? 0,
      timestamp: this.now().toISOString(),
    });
  }

  async detail(runId: string): Promise<PublicRunHistoryDetailResponse | null> {
    const source = await this.readDetailSource(runId);
    if (!source) return null;

    const attemptCounts = await this.options.db
      .select({
        totalCount: sql<number>`count(*)::int`,
        succeeded: sql<number>`(count(*) filter (where ${erpAttempts.status} = 'succeeded'))::int`,
        failed: sql<number>`(count(*) filter (where ${erpAttempts.status} = 'failed'))::int`,
        timedOut: sql<number>`(count(*) filter (where ${erpAttempts.status} = 'timed_out'))::int`,
        averageLatencyMs: sql<number | null>`avg(${erpAttempts.latencyMs})::double precision`,
        p95LatencyMs: sql<
          number | null
        >`percentile_cont(0.95) within group (order by ${erpAttempts.latencyMs})::double precision`,
      })
      .from(erpAttempts)
      .where(eq(erpAttempts.runId, runId));
    const attempt = attemptCounts[0];
    const summary = toPublicRunHistorySummary(source.summaryRow);
    const run = toPublicRunHistoryRun(source.runRow);
    return publicRunHistoryDetailResponseSchema.parse({
      summary,
      run,
      result: derivePublicRunResult(summary),
      overallDurationMs: deriveOverallDurationMs(summary.startedAt, summary.endedAt),
      plannedAttempts: deriveLoadExecutionPlan(run.configSnapshot.trafficConfig)
        .plannedEmittedAttempts,
      httpTimingBreakdownSummary: parsePersistedState(
        httpTimingBreakdownSummarySchema,
        source.summaryRow.httpTimingBreakdownSummary,
        `run summary ${source.summaryRow.id} for demo run ${source.summaryRow.runId}`,
        "httpTimingBreakdownSummary",
      ),
      erpAttempts: {
        totalCount: attempt?.totalCount ?? 0,
        byStatus: {
          succeeded: attempt?.succeeded ?? 0,
          failed: attempt?.failed ?? 0,
          timedOut: attempt?.timedOut ?? 0,
        },
        averageLatencyMs: attempt?.averageLatencyMs ?? null,
        p95LatencyMs: attempt?.p95LatencyMs ?? null,
      },
      runSignalTimelineSummary: parseRunSignalTimelineSummary(source.summaryRow),
      timestamp: this.now().toISOString(),
    });
  }

  async adminDetail(runId: string): Promise<AdminRunHistoryDetailResponse | null> {
    const source = await this.readDetailSource(runId);
    if (!source) return null;

    const [
      orderRows,
      orderTotalRows,
      erpAttemptRows,
      erpAttemptTotalRows,
      notificationRows,
      notificationTotalRows,
      eventRows,
      eventTotalRows,
    ] = await Promise.all([
      this.options.db
        .select()
        .from(orders)
        .where(eq(orders.runId, runId))
        .orderBy(desc(orders.queuedAt), desc(orders.createdAt))
        .limit(detailRecordLimit),
      this.options.db
        .select({
          totalCount: count(),
          warningCount: sql<number>`(count(*) filter (where ${orders.status} = 'failed'))::int`,
        })
        .from(orders)
        .where(eq(orders.runId, runId)),
      this.options.db
        .select({
          attemptId: erpAttempts.id,
          orderId: erpAttempts.orderId,
          publicOrderId: orders.publicOrderId,
          correlationId: erpAttempts.correlationId,
          attemptNumber: erpAttempts.attemptNumber,
          status: erpAttempts.status,
          terminal: erpAttempts.terminal,
          httpStatus: erpAttempts.httpStatus,
          errorCode: erpAttempts.errorCode,
          latencyMs: erpAttempts.latencyMs,
          startedAt: erpAttempts.startedAt,
          finishedAt: erpAttempts.finishedAt,
          createdAt: erpAttempts.createdAt,
        })
        .from(erpAttempts)
        .innerJoin(orders, eq(erpAttempts.orderId, orders.id))
        .where(eq(erpAttempts.runId, runId))
        .orderBy(desc(erpAttempts.finishedAt), desc(erpAttempts.createdAt))
        .limit(detailRecordLimit),
      this.options.db
        .select({
          totalCount: count(),
          warningCount: sql<number>`(count(*) filter (where ${erpAttempts.status} in ('failed', 'timed_out') or not ${erpAttempts.terminal}))::int`,
          succeeded: sql<number>`(count(*) filter (where ${erpAttempts.status} = 'succeeded'))::int`,
          failed: sql<number>`(count(*) filter (where ${erpAttempts.status} = 'failed'))::int`,
          timedOut: sql<number>`(count(*) filter (where ${erpAttempts.status} = 'timed_out'))::int`,
          averageLatencyMs: sql<number | null>`avg(${erpAttempts.latencyMs})::double precision`,
          p95LatencyMs: sql<
            number | null
          >`percentile_cont(0.95) within group (order by ${erpAttempts.latencyMs})::double precision`,
        })
        .from(erpAttempts)
        .where(eq(erpAttempts.runId, runId)),
      this.options.db
        .select({
          notificationId: simulatedNotifications.id,
          orderId: simulatedNotifications.orderId,
          publicOrderId: orders.publicOrderId,
          recordedAt: simulatedNotifications.recordedAt,
          createdAt: simulatedNotifications.createdAt,
        })
        .from(simulatedNotifications)
        .innerJoin(orders, eq(simulatedNotifications.orderId, orders.id))
        .where(eq(simulatedNotifications.runId, runId))
        .orderBy(desc(simulatedNotifications.recordedAt), desc(simulatedNotifications.createdAt))
        .limit(detailRecordLimit),
      this.options.db
        .select({ totalCount: count() })
        .from(simulatedNotifications)
        .where(eq(simulatedNotifications.runId, runId)),
      this.options.db
        .select({
          eventId: orderEvents.id,
          eventName: orderEvents.eventName,
          source: orderEvents.source,
          saleOfferId: orderEvents.saleOfferId,
          correlationId: orderEvents.correlationId,
          orderId: orderEvents.orderId,
          publicOrderId: orders.publicOrderId,
          occurredAt: orderEvents.occurredAt,
          createdAt: orderEvents.createdAt,
        })
        .from(orderEvents)
        .leftJoin(orders, eq(orderEvents.orderId, orders.id))
        .where(eq(orderEvents.runId, runId))
        .orderBy(desc(orderEvents.occurredAt), desc(orderEvents.createdAt))
        .limit(detailRecordLimit),
      this.options.db
        .select({ totalCount: count() })
        .from(orderEvents)
        .where(eq(orderEvents.runId, runId)),
    ]);

    const orderTotalCount = orderTotalRows[0]?.totalCount ?? 0;
    const erpAttemptTotalCount = erpAttemptTotalRows[0]?.totalCount ?? 0;
    const notificationTotalCount = notificationTotalRows[0]?.totalCount ?? 0;
    const eventTotalCount = eventTotalRows[0]?.totalCount ?? 0;
    const summary = toRunHistorySummary(source.summaryRow);
    const diagnostics = parseRunHistoryDiagnostics(
      source.summaryRow.loadRunDiagnosticsSummary,
      `run summary ${source.summaryRow.id} for demo run ${source.summaryRow.runId}`,
    );
    const truncatedCollections = [
      orderTotalCount,
      erpAttemptTotalCount,
      notificationTotalCount,
      eventTotalCount,
    ].filter((totalCount) => totalCount > detailRecordLimit).length;

    return adminRunHistoryDetailResponseSchema.parse({
      summary,
      run: toDemoRunSnapshot(source.runRow),
      exceptionSummary: toRunHistoryExceptionSummary(summary, diagnostics, truncatedCollections),
      ...(source.runRow.failureReason
        ? {
            internalFailureReason: internalRunFailureReasonSchema.parse(
              source.runRow.failureReason,
            ),
          }
        : {}),
      httpTimingBreakdownSummary: parsePersistedState(
        httpTimingBreakdownSummarySchema,
        source.summaryRow.httpTimingBreakdownSummary,
        `run summary ${source.summaryRow.id} for demo run ${source.summaryRow.runId}`,
        "httpTimingBreakdownSummary",
      ),
      loadRunDiagnosticsSummary: diagnostics,
      orders: {
        records: orderRows.map(toRunHistoryOrderOutcome),
        totalCount: orderTotalCount,
        warningCount: orderTotalRows[0]?.warningCount ?? 0,
        limit: detailRecordLimit,
        truncated: orderTotalCount > detailRecordLimit,
      },
      erpAttempts: {
        records: erpAttemptRows.map(toRunHistoryErpAttempt),
        totalCount: erpAttemptTotalCount,
        warningCount: erpAttemptTotalRows[0]?.warningCount ?? 0,
        limit: detailRecordLimit,
        truncated: erpAttemptTotalCount > detailRecordLimit,
      },
      erpAttemptSummary: {
        totalCount: erpAttemptTotalCount,
        byStatus: {
          succeeded: erpAttemptTotalRows[0]?.succeeded ?? 0,
          failed: erpAttemptTotalRows[0]?.failed ?? 0,
          timedOut: erpAttemptTotalRows[0]?.timedOut ?? 0,
        },
        averageLatencyMs: erpAttemptTotalRows[0]?.averageLatencyMs ?? null,
        p95LatencyMs: erpAttemptTotalRows[0]?.p95LatencyMs ?? null,
      },
      notifications: {
        records: notificationRows.map(toRunHistoryNotification),
        totalCount: notificationTotalCount,
        warningCount: 0,
        limit: detailRecordLimit,
        truncated: notificationTotalCount > detailRecordLimit,
      },
      eventTimeline: {
        records: eventRows.map(toRunHistoryEventTimelineEntry),
        totalCount: eventTotalCount,
        warningCount: 0,
        limit: detailRecordLimit,
        truncated: eventTotalCount > detailRecordLimit,
      },
      runSignalTimelineSummary: parseRunSignalTimelineSummary(source.summaryRow),
      timestamp: this.now().toISOString(),
    });
  }

  private async readDetailSource(runId: string) {
    const [summaryRow] = await this.options.db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, runId))
      .limit(1);
    if (!summaryRow) return null;
    const [runRow] = await this.options.db
      .select()
      .from(demoRuns)
      .where(eq(demoRuns.id, runId))
      .limit(1);
    return runRow ? { summaryRow, runRow } : null;
  }

  async delete(
    input: AdminDeleteRunHistoryRequest,
    correlationId: string,
  ): Promise<AdminDeleteRunHistoryResponse> {
    const now = this.now();
    const deletedRows = input.deleteAllConfirmation
      ? await this.options.db.delete(demoRunSummaries).returning({ runId: demoRunSummaries.runId })
      : await this.options.db
          .delete(demoRunSummaries)
          .where(inArray(demoRunSummaries.runId, input.runIds ?? []))
          .returning({ runId: demoRunSummaries.runId });

    return adminDeleteRunHistoryResponseSchema.parse({
      deletedSummaryCount: deletedRows.length,
      deletedAt: now.toISOString(),
      correlationId,
    });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function toRunHistoryExceptionSummary(
  summary: RunHistorySummary,
  diagnostics: LoadRunDiagnosticsSummary | null,
  truncatedCollections: number,
) {
  const result = deriveRunResult({
    runStatus: summary.status,
    failureCategory: summary.failureCategory ?? null,
    startingStock: summary.terminalInventorySnapshot?.startingStock ?? null,
    remainingStock: summary.terminalInventorySnapshot?.remainingStock ?? null,
    durable: {
      reservedUnits: summary.businessOutcomeSummary.reservedUnits,
      uniqueReservations: summary.businessOutcomeSummary.acceptedReservations,
      soldOutDecisions: summary.businessOutcomeSummary.soldOutRejections,
      confirmedOrders: summary.businessOutcomeSummary.confirmedOrders,
      failedOrders: summary.businessOutcomeSummary.failedOrders,
      queuedOrders: summary.businessOutcomeSummary.queuedOrders,
      processingOrders: summary.businessOutcomeSummary.processingOrders,
      durablePendingPersistenceRecords: summary.businessOutcomeSummary.pendingPersistenceCount,
      notificationsRecorded: summary.businessOutcomeSummary.notificationsRecorded,
    },
    heldReservationsAwaitingPersistence:
      summary.terminalInventorySnapshot?.pendingPersistenceCount ?? null,
    replayPossible: summary.replayPossible,
    generator: {
      transportAttemptCounts: summary.transportAttemptCounts,
      httpSummary: summary.httpSummary,
    },
  });

  return {
    maximumClassification: result.maximumClassification,
    brokenInvariants: result.invariants.filter(({ status }) => status === "broken").length,
    failedOrders: summary.businessOutcomeSummary.failedOrders,
    pendingWork:
      summary.businessOutcomeSummary.queuedOrders +
      summary.businessOutcomeSummary.processingOrders +
      summary.businessOutcomeSummary.pendingPersistenceCount,
    partialDelivery: summary.trafficDeliverySummary.trafficDeliveryStatus === "complete" ? 0 : 1,
    generatorWarnings: generatorWarningCount(diagnostics),
    truncatedCollections,
  };
}

function generatorWarningCount(summary: LoadRunDiagnosticsSummary | null): number {
  if (!summary) return countUnavailableLoadRunDiagnosticProbes(null);
  const sources = summary.terminalMetricSources;
  return (
    (summary.summaryExportWarnings?.length ?? 0) +
    (summary.stderrLineCountObserved > 0 ? 1 : 0) +
    (summary.stderrLineTruncatedCount > 0 ||
    summary.stderrLineCountObserved > summary.stderrLineCountRetained
      ? 1
      : 0) +
    (sources ? Object.values(sources).filter((source) => source === "point_stream").length : 0) +
    countUnavailableLoadRunDiagnosticProbes(summary)
  );
}

function toRunHistoryListItem(
  row: typeof demoRunSummaries.$inferSelect,
  persistedConfigSnapshot: (typeof demoRuns.$inferSelect)["configSnapshot"],
): RunHistoryListItem {
  const summary = toPublicRunHistorySummary(row);
  const result = derivePublicRunResult(summary);
  const config = parsePersistedAcceptedRunConfigSnapshot(
    persistedConfigSnapshot,
    `demo run ${row.runId}`,
  );
  return runHistoryListItemSchema.parse({
    runId: summary.runId,
    presetName: summary.presetName,
    occurredAt: summary.startedAt ?? summary.endedAt,
    overallDurationMs: deriveOverallDurationMs(summary.startedAt, summary.endedAt),
    resultOutcome: result.outcome,
    plannedAttempts: deriveLoadExecutionPlan(config.trafficConfig).plannedEmittedAttempts,
    startingStock: config.inventoryConfig.startingStock,
    uniqueReservations: summary.businessOutcomeSummary.acceptedReservations,
    soldOutRejections: summary.businessOutcomeSummary.soldOutRejections,
    confirmedOrders: summary.businessOutcomeSummary.confirmedOrders,
    failedOrders: summary.businessOutcomeSummary.failedOrders,
    convergenceDurationSeconds:
      summary.runSignalTimelineSummary?.convergenceDurationSeconds ?? null,
  });
}

function derivePublicRunResult(summary: PublicRunHistorySummary) {
  const inventory = summary.terminalInventorySnapshot;
  const business = summary.businessOutcomeSummary;
  return deriveRunResult({
    runStatus: summary.status,
    failureCategory: summary.failureCategory ?? null,
    startingStock: inventory?.startingStock ?? null,
    remainingStock: inventory?.remainingStock ?? null,
    durable: {
      reservedUnits: business.reservedUnits,
      uniqueReservations: business.acceptedReservations,
      soldOutDecisions: business.soldOutRejections,
      confirmedOrders: business.confirmedOrders,
      failedOrders: business.failedOrders,
      queuedOrders: business.queuedOrders,
      processingOrders: business.processingOrders,
      durablePendingPersistenceRecords: business.pendingPersistenceCount,
      notificationsRecorded: business.notificationsRecorded,
    },
    heldReservationsAwaitingPersistence: inventory?.pendingPersistenceCount ?? null,
    replayPossible: summary.replayPossible,
    generator: {
      transportAttemptCounts: summary.transportAttemptCounts,
      httpSummary: summary.httpSummary,
    },
  });
}

function deriveOverallDurationMs(startedAt: string | undefined, endedAt: string): number | null {
  if (!startedAt) return null;
  const duration = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function toPublicRunHistorySummary(
  row: typeof demoRunSummaries.$inferSelect,
): PublicRunHistorySummary {
  const context = `run summary ${row.id} for demo run ${row.runId}`;
  const inventory = row.terminalInventorySnapshot
    ? parsePersistedTerminalInventorySnapshot(row.terminalInventorySnapshot, context)
    : null;
  const transportAttemptCounts = parsePersistedTransportAttemptCounts(
    row.transportAttemptCounts,
    context,
  );
  const httpSummary = parsePersistedTrafficHttpSummary(row.httpSummary, context);
  const serverReservationTimingSummary = parsePersistedState(
    serverReservationTimingSummarySchema,
    row.serverReservationTimingSummary,
    context,
    "serverReservationTimingSummary",
  );
  const { notes: _notes, ...publicDeliverySummary } = parsePersistedTrafficDeliverySummary(
    row.trafficDeliverySummary,
    transportAttemptCounts,
    context,
  );
  return publicRunHistorySummarySchema.parse({
    runId: row.runId,
    presetName: row.presetName,
    status: row.status,
    replayPossible: row.replayPossible,
    ...(row.failureReason
      ? {
          failureCategory: toPublicRunFailureCategory(
            internalRunFailureReasonSchema.parse(row.failureReason),
          ),
        }
      : {}),
    ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
    endedAt: row.endedAt.toISOString(),
    transportAttemptCounts,
    httpSummary,
    trafficDeliverySummary: publicDeliverySummary,
    serverReservationTimingSummary,
    fastReservationTargetEvaluation: evaluateFastReservationTarget(
      serverReservationTimingSummary,
      deriveRecordedReplyCount(transportAttemptCounts, httpSummary.transportFailures),
    ),
    businessOutcomeSummary: parsePersistedBusinessOutcomeSummary(
      row.businessOutcomeSummary,
      context,
    ),
    ...(inventory
      ? {
          terminalInventorySnapshot: {
            startingStock: inventory.startingStock,
            remainingStock: inventory.remainingStock,
            reservedStock: inventory.reservedStock,
            acceptedReservations: inventory.acceptedReservations,
            soldOutRejections: inventory.soldOutRejections,
            pendingPersistenceCount: inventory.pendingPersistenceCount,
            capturedAt: inventory.capturedAt,
          },
        }
      : {}),
    runSignalTimelineSummary: toRunSignalTimelineHeadlineOrNull(row),
    capturedAt: row.capturedAt.toISOString(),
  });
}

function parseRunHistoryDiagnostics(
  value: unknown,
  context: string,
): LoadRunDiagnosticsSummary | null {
  // Synthetic pre-traffic summaries have no startedAt; real diagnostics always do.
  if (!value || typeof value !== "object" || !("startedAt" in value)) return null;
  const stored = value as Record<string, unknown>;
  return parsePersistedState(
    loadRunDiagnosticsSummarySchema.strip(),
    {
      ...stored,
      generatorCapacity: stored.generatorCapacity ?? null,
      generatorUtilisation: stored.generatorUtilisation ?? null,
    },
    context,
    "loadRunDiagnosticsSummary",
  );
}

function toPublicRunHistoryRun(row: typeof demoRuns.$inferSelect): PublicRunHistoryRun {
  const context = `demo run ${row.id}`;
  return publicRunHistoryRunSchema.parse({
    runId: row.id,
    presetName: row.presetName,
    operatorMode: row.operatorMode,
    status: row.status,
    trafficStatus: row.trafficStatus,
    configSnapshot: parsePersistedAcceptedRunConfigSnapshot(row.configSnapshot, context),
    ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
    ...(row.trafficStartedAt ? { trafficStartedAt: row.trafficStartedAt.toISOString() } : {}),
    ...(row.trafficEndedAt ? { trafficEndedAt: row.trafficEndedAt.toISOString() } : {}),
    ...(row.finalizedAt ? { finalizedAt: row.finalizedAt.toISOString() } : {}),
  });
}

function toRunHistorySummary(row: typeof demoRunSummaries.$inferSelect): RunHistorySummary {
  const context = `run summary ${row.id} for demo run ${row.runId}`;
  const transportAttemptCounts = parsePersistedTransportAttemptCounts(
    row.transportAttemptCounts,
    context,
  );
  const serverReservationTimingSummary = parsePersistedState(
    serverReservationTimingSummarySchema,
    row.serverReservationTimingSummary,
    context,
    "serverReservationTimingSummary",
  );
  const httpSummary = parsePersistedTrafficHttpSummary(row.httpSummary, context);
  return runHistorySummarySchema.parse({
    id: row.id,
    runId: row.runId,
    presetName: row.presetName,
    status: row.status,
    replayPossible: row.replayPossible,
    ...(row.failureReason
      ? {
          failureCategory: toPublicRunFailureCategory(
            internalRunFailureReasonSchema.parse(row.failureReason),
          ),
        }
      : {}),
    ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
    endedAt: row.endedAt.toISOString(),
    transportAttemptCounts,
    httpSummary,
    trafficDeliverySummary: parsePersistedTrafficDeliverySummary(
      row.trafficDeliverySummary,
      transportAttemptCounts,
      context,
    ),
    serverReservationTimingSummary,
    fastReservationTargetEvaluation: evaluateFastReservationTarget(
      serverReservationTimingSummary,
      deriveRecordedReplyCount(transportAttemptCounts, httpSummary.transportFailures),
    ),
    businessOutcomeSummary: parsePersistedBusinessOutcomeSummary(
      row.businessOutcomeSummary,
      context,
    ),
    ...(row.terminalInventorySnapshot
      ? {
          terminalInventorySnapshot: parsePersistedTerminalInventorySnapshot(
            row.terminalInventorySnapshot,
            context,
          ),
        }
      : {}),
    runSignalTimelineSummary: toRunSignalTimelineHeadlineOrNull(row),
    capturedAt: row.capturedAt.toISOString(),
  });
}

function parseRunSignalTimelineSummary(row: typeof demoRunSummaries.$inferSelect) {
  if (row.runSignalTimelineSummary === null) return null;
  return parsePersistedState(
    runSignalTimelineSummarySchema,
    row.runSignalTimelineSummary,
    `run summary ${row.id} for demo run ${row.runId}`,
    "runSignalTimelineSummary",
  );
}

function toRunSignalTimelineHeadlineOrNull(row: typeof demoRunSummaries.$inferSelect) {
  const summary = parseRunSignalTimelineSummary(row);
  return summary ? toRunSignalTimelineHeadline(summary) : null;
}

function toRunHistoryOrderOutcome(row: typeof orders.$inferSelect): RunHistoryOrderOutcome {
  return runHistoryOrderOutcomeSchema.parse({
    orderId: row.id,
    publicOrderId: row.publicOrderId,
    saleOfferId: row.saleOfferId,
    correlationId: row.correlationId,
    quantity: row.quantity,
    status: row.status,
    ...(row.failureCode ? { failureCode: row.failureCode } : {}),
    queuedAt: row.queuedAt.toISOString(),
    ...(row.processingAt ? { processingAt: row.processingAt.toISOString() } : {}),
    ...(row.confirmedAt ? { confirmedAt: row.confirmedAt.toISOString() } : {}),
    ...(row.failedAt ? { failedAt: row.failedAt.toISOString() } : {}),
  });
}

function toRunHistoryErpAttempt(row: {
  attemptId: string;
  orderId: string;
  publicOrderId: string;
  correlationId: string;
  attemptNumber: number;
  status: (typeof erpAttempts.$inferSelect)["status"];
  terminal: boolean;
  httpStatus: number | null;
  errorCode: string | null;
  latencyMs: number;
  startedAt: Date;
  finishedAt: Date;
}): RunHistoryErpAttempt {
  return runHistoryErpAttemptSchema.parse({
    attemptId: row.attemptId,
    orderId: row.orderId,
    publicOrderId: row.publicOrderId,
    correlationId: row.correlationId,
    attemptNumber: row.attemptNumber,
    status: row.status,
    terminal: row.terminal,
    ...(row.httpStatus ? { httpStatus: row.httpStatus } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    latencyMs: row.latencyMs,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString(),
  });
}

function toRunHistoryNotification(row: {
  notificationId: string;
  orderId: string;
  publicOrderId: string;
  recordedAt: Date;
}): RunHistoryNotification {
  return runHistoryNotificationSchema.parse({
    notificationId: row.notificationId,
    orderId: row.orderId,
    publicOrderId: row.publicOrderId,
    recordedAt: row.recordedAt.toISOString(),
  });
}

function toRunHistoryEventTimelineEntry(row: {
  eventId: string;
  eventName: (typeof orderEvents.$inferSelect)["eventName"];
  source: string;
  saleOfferId: string;
  correlationId: string;
  orderId: string | null;
  publicOrderId: string | null;
  occurredAt: Date;
}): RunHistoryEventTimelineEntry {
  return runHistoryEventTimelineEntrySchema.parse({
    eventId: row.eventId,
    eventName: row.eventName,
    source: row.source,
    saleOfferId: row.saleOfferId,
    correlationId: row.correlationId,
    ...(row.orderId ? { orderId: row.orderId } : {}),
    ...(row.publicOrderId ? { publicOrderId: row.publicOrderId } : {}),
    occurredAt: row.occurredAt.toISOString(),
  });
}
