import { trafficDeliverySummarySchema, trafficHttpSummarySchema } from "@checkout-surge/contracts";
import type { CheckoutSurgeDatabase } from "@checkout-surge/db";
import { demoRunSummaries, demoRuns } from "@checkout-surge/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type {
  TerminalDemoRunStatus,
  TerminalDemoRunSummaryInput,
  TerminalDemoRunTransitionInput,
  TerminalDemoRunWriter,
} from "./terminal-demo-run-writer.js";

type TerminalDemoRunTransitionTransaction = Parameters<
  Parameters<CheckoutSurgeDatabase["transaction"]>[0]
>[0];

export function terminalDemoRunTransitionLockKey(runId: string): string {
  return `demo_run_finalize:${runId}`;
}

export class PostgresTerminalDemoRunSummaryWriter implements TerminalDemoRunWriter {
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

      return this.insertTerminalSummaryInsideLock(tx, input);
    });
  }

  /**
   * Inserts the immutable summary after a caller has already claimed the
   * terminal transition. Reset uses this split phase to fence admission before
   * it captures business state. Ordinary finalization should continue to use
   * write(), which keeps its claim and summary insert atomic.
   */
  async writeAfterTerminalClaim(input: TerminalDemoRunSummaryInput): Promise<boolean> {
    return (await this.writeAfterTerminalClaims([input])) === 1;
  }

  /**
   * Inserts all summaries in one transaction after their terminal claims. A
   * reset can therefore retry a failed batch without cleaning queues after a
   * subset of immutable summaries has already committed.
   */
  async writeAfterTerminalClaims(inputs: TerminalDemoRunSummaryInput[]): Promise<number> {
    if (inputs.length === 0) {
      return 0;
    }

    return this.db.transaction(async (tx) => {
      const orderedInputs = [...inputs].sort((left, right) =>
        left.run.id.localeCompare(right.run.id),
      );
      for (const input of orderedInputs) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${terminalDemoRunTransitionLockKey(input.run.id)}))`,
        );
      }

      let wroteSummaryCount = 0;
      for (const input of orderedInputs) {
        const [existingSummary] = await tx
          .select({ id: demoRunSummaries.id })
          .from(demoRunSummaries)
          .where(eq(demoRunSummaries.runId, input.run.id))
          .limit(1);

        if (existingSummary) {
          continue;
        }

        const [terminalRun] = await tx
          .select({ status: demoRuns.status })
          .from(demoRuns)
          .where(and(eq(demoRuns.id, input.run.id), eq(demoRuns.status, input.terminalStatus)))
          .limit(1);

        if (!terminalRun) {
          continue;
        }

        await this.insertTerminalSummaryInsideLock(tx, input);
        wroteSummaryCount += 1;
      }

      return wroteSummaryCount;
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

  private async insertTerminalSummaryInsideLock(
    tx: TerminalDemoRunTransitionTransaction,
    input: TerminalDemoRunSummaryInput,
  ): Promise<true> {
    const capturedAt = input.capturedAt ?? input.finalizedAt;
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
      capturedAt,
      createdAt: capturedAt,
    });

    return true;
  }
}
