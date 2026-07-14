import {
  type AdminDeleteRunHistoryRequest,
  type AdminDeleteRunHistoryResponse,
  adminDeleteRunHistoryResponseSchema,
  type DemoRunSnapshot,
  demoRunSnapshotSchema,
  type RunHistoryDetailResponse,
  type RunHistoryErpAttempt,
  type RunHistoryEventTimelineEntry,
  type RunHistoryListQuery,
  type RunHistoryListResponse,
  type RunHistoryNotification,
  type RunHistoryOrderOutcome,
  type RunHistorySummary,
  runHistoryDetailResponseSchema,
  runHistoryErpAttemptSchema,
  runHistoryEventTimelineEntrySchema,
  runHistoryListResponseSchema,
  runHistoryNotificationSchema,
  runHistoryOrderOutcomeSchema,
  runHistorySummarySchema,
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
import { count, desc, eq, inArray } from "drizzle-orm";
import { normalizeTrafficDeliverySummary } from "./traffic-delivery-classifier.js";

const detailRecordLimit = 20;

export interface RunHistoryController {
  list(input: RunHistoryListQuery): Promise<RunHistoryListResponse>;
  detail(runId: string): Promise<RunHistoryDetailResponse | null>;
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
        .select()
        .from(demoRunSummaries)
        .orderBy(desc(demoRunSummaries.capturedAt), desc(demoRunSummaries.createdAt))
        .limit(input.pageSize)
        .offset(offset),
      this.options.db.select({ totalCount: count() }).from(demoRunSummaries),
    ]);

    return runHistoryListResponseSchema.parse({
      summaries: rows.map(toRunHistorySummary),
      page: input.page,
      pageSize: input.pageSize,
      totalCount: totalRows[0]?.totalCount ?? 0,
      timestamp: this.now().toISOString(),
    });
  }

  async detail(runId: string): Promise<RunHistoryDetailResponse | null> {
    const [summaryRow] = await this.options.db
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, runId))
      .limit(1);

    if (!summaryRow) {
      return null;
    }

    const [runRow] = await this.options.db
      .select()
      .from(demoRuns)
      .where(eq(demoRuns.id, runId))
      .limit(1);

    if (!runRow) {
      return null;
    }

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
      this.options.db.select({ totalCount: count() }).from(orders).where(eq(orders.runId, runId)),
      this.options.db
        .select({
          attemptId: erpAttempts.id,
          orderId: erpAttempts.orderId,
          publicOrderId: orders.publicOrderId,
          correlationId: erpAttempts.correlationId,
          attemptNumber: erpAttempts.attemptNumber,
          status: erpAttempts.status,
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
        .select({ totalCount: count() })
        .from(erpAttempts)
        .where(eq(erpAttempts.runId, runId)),
      this.options.db
        .select({
          notificationId: simulatedNotifications.id,
          orderId: simulatedNotifications.orderId,
          publicOrderId: orders.publicOrderId,
          channel: simulatedNotifications.channel,
          status: simulatedNotifications.status,
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

    return runHistoryDetailResponseSchema.parse({
      summary: toRunHistorySummary(summaryRow),
      run: toDemoRunSnapshot(runRow),
      orders: {
        records: orderRows.map(toRunHistoryOrderOutcome),
        totalCount: orderTotalCount,
        limit: detailRecordLimit,
        truncated: orderTotalCount > detailRecordLimit,
      },
      erpAttempts: {
        records: erpAttemptRows.map(toRunHistoryErpAttempt),
        totalCount: erpAttemptTotalCount,
        limit: detailRecordLimit,
        truncated: erpAttemptTotalCount > detailRecordLimit,
      },
      notifications: {
        records: notificationRows.map(toRunHistoryNotification),
        totalCount: notificationTotalCount,
        limit: detailRecordLimit,
        truncated: notificationTotalCount > detailRecordLimit,
      },
      eventTimeline: {
        records: eventRows.map(toRunHistoryEventTimelineEntry),
        totalCount: eventTotalCount,
        limit: detailRecordLimit,
        truncated: eventTotalCount > detailRecordLimit,
      },
      timestamp: this.now().toISOString(),
    });
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

function toRunHistorySummary(row: typeof demoRunSummaries.$inferSelect): RunHistorySummary {
  return runHistorySummarySchema.parse({
    id: row.id,
    runId: row.runId,
    presetName: row.presetName,
    status: row.status,
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
    ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
    endedAt: row.endedAt.toISOString(),
    httpSummary: row.httpSummary,
    trafficDeliverySummary: normalizeTrafficDeliverySummary(row.trafficDeliverySummary),
    businessOutcomeSummary: row.businessOutcomeSummary,
    ...(row.terminalInventorySnapshot
      ? { terminalInventorySnapshot: row.terminalInventorySnapshot }
      : {}),
    capturedAt: row.capturedAt.toISOString(),
  });
}

function toDemoRunSnapshot(row: typeof demoRuns.$inferSelect): DemoRunSnapshot {
  return demoRunSnapshotSchema.parse({
    runId: row.id,
    presetId: row.presetId,
    presetName: row.presetName,
    operatorMode: row.operatorMode,
    status: row.status,
    trafficStatus: row.trafficStatus,
    ...(row.saleOfferId ? { saleOfferId: row.saleOfferId } : {}),
    configSnapshot: row.configSnapshot,
    ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
    ...(row.trafficStartedAt ? { trafficStartedAt: row.trafficStartedAt.toISOString() } : {}),
    ...(row.trafficEndedAt ? { trafficEndedAt: row.trafficEndedAt.toISOString() } : {}),
    ...(row.finalizedAt ? { finalizedAt: row.finalizedAt.toISOString() } : {}),
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
  });
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
  channel: (typeof simulatedNotifications.$inferSelect)["channel"];
  status: (typeof simulatedNotifications.$inferSelect)["status"];
  recordedAt: Date;
}): RunHistoryNotification {
  return runHistoryNotificationSchema.parse({
    notificationId: row.notificationId,
    orderId: row.orderId,
    publicOrderId: row.publicOrderId,
    channel: row.channel,
    status: row.status,
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
