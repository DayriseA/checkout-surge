import {
  type BusinessOutcomeSummary,
  type TerminalInventorySnapshot,
  type TrafficDeliverySummary,
  type TrafficHttpSummary,
  trafficDeliverySummarySchema,
  trafficHttpSummarySchema,
} from "@checkout-surge/contracts";
import type {
  CheckoutSurgeDatabase,
  DemoRunStatus,
  DemoRunTrafficStatus,
} from "@checkout-surge/db";
import { demoRunSummaries, demoRuns } from "@checkout-surge/db";
import { and, eq, inArray, sql } from "drizzle-orm";

type TerminalDemoRunStatus = "completed" | "failed";
type TerminalDemoRunTransitionTransaction = Parameters<
  Parameters<CheckoutSurgeDatabase["transaction"]>[0]
>[0];

export interface TerminalDemoRunTransitionInput {
  runId: string;
  terminalStatus: TerminalDemoRunStatus;
  failureReason: string | null;
  finalizedAt: Date;
  allowedCurrentStatuses: DemoRunStatus[];
  terminalTrafficStatus?: DemoRunTrafficStatus;
}

export interface TerminalDemoRunSummaryInput {
  run: typeof demoRuns.$inferSelect;
  terminalStatus: TerminalDemoRunStatus;
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

export function terminalDemoRunTransitionLockKey(runId: string): string {
  return `demo_run_finalize:${runId}`;
}

export class PostgresTerminalDemoRunSummaryWriter {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async claimTerminalRun(input: TerminalDemoRunTransitionInput): Promise<boolean> {
    return this.withTerminalRunLock(input.runId, (tx) =>
      this.claimTerminalRunInsideLock(tx, input),
    );
  }

  async write(input: TerminalDemoRunSummaryInput): Promise<boolean> {
    return this.withTerminalRunLock(input.run.id, async (tx) => {
      const [existingSummary] = await tx
        .select()
        .from(demoRunSummaries)
        .where(eq(demoRunSummaries.runId, input.run.id))
        .limit(1);

      if (existingSummary) {
        await this.claimTerminalRunInsideLock(tx, {
          runId: input.run.id,
          terminalStatus: existingSummary.status as TerminalDemoRunStatus,
          failureReason: existingSummary.failureReason,
          finalizedAt: existingSummary.endedAt,
          allowedCurrentStatuses: input.allowedCurrentStatuses,
          ...(input.terminalTrafficStatus
            ? { terminalTrafficStatus: input.terminalTrafficStatus }
            : {}),
        });
        return false;
      }

      const claimedRun = await this.claimTerminalRunInsideLock(tx, {
        runId: input.run.id,
        terminalStatus: input.terminalStatus,
        failureReason: input.failureReason,
        finalizedAt: input.finalizedAt,
        allowedCurrentStatuses: input.allowedCurrentStatuses,
        ...(input.terminalTrafficStatus
          ? { terminalTrafficStatus: input.terminalTrafficStatus }
          : {}),
      });
      if (!claimedRun) {
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

      return true;
    });
  }

  private async withTerminalRunLock<T>(
    runId: string,
    operation: (tx: TerminalDemoRunTransitionTransaction) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${terminalDemoRunTransitionLockKey(runId)}))`,
      );

      return operation(tx);
    });
  }

  private async claimTerminalRunInsideLock(
    tx: TerminalDemoRunTransitionTransaction,
    input: TerminalDemoRunTransitionInput,
  ): Promise<boolean> {
    const [updatedRun] = await tx
      .update(demoRuns)
      .set({
        status: input.terminalStatus,
        ...(input.terminalTrafficStatus ? { trafficStatus: input.terminalTrafficStatus } : {}),
        failureReason: input.failureReason,
        finalizedAt: input.finalizedAt,
        updatedAt: input.finalizedAt,
      })
      .where(
        and(eq(demoRuns.id, input.runId), inArray(demoRuns.status, input.allowedCurrentStatuses)),
      )
      .returning({ id: demoRuns.id });

    return Boolean(updatedRun);
  }
}
