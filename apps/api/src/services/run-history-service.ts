import {
  type AdminDeleteRunHistoryRequest,
  type AdminDeleteRunHistoryResponse,
  adminDeleteRunHistoryResponseSchema,
  type RunHistoryListQuery,
  type RunHistoryListResponse,
  type RunHistorySummary,
  runHistoryListResponseSchema,
  runHistorySummarySchema,
} from "@checkout-surge/contracts";
import { type CheckoutSurgeDatabase, demoRunSummaries } from "@checkout-surge/db";
import { count, desc, inArray } from "drizzle-orm";

export interface RunHistoryController {
  list(input: RunHistoryListQuery): Promise<RunHistoryListResponse>;
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
    trafficDeliverySummary: row.trafficDeliverySummary,
    businessOutcomeSummary: row.businessOutcomeSummary,
    ...(row.terminalInventorySnapshot
      ? { terminalInventorySnapshot: row.terminalInventorySnapshot }
      : {}),
    capturedAt: row.capturedAt.toISOString(),
  });
}
