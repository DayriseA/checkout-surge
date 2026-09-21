import {
  internalRunFailureReasonSchema,
  runSignalTimelineSummarySchema,
  serverReservationTimingSummarySchema,
  trafficDeliverySummarySchema,
  trafficHttpSummarySchema,
  transportAttemptCountsSchema,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeDatabase } from "@checkout-surge/db";
import { demoRunSummaries, demoRuns, terminalDemoRunTransitionLockKey } from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { OrderProcessQueueLimits } from "./order-process-queue-limits.js";
import type {
  TerminalDemoRunStatus,
  TerminalDemoRunSummaryInput,
  TerminalDemoRunTransitionInput,
  TerminalDemoRunWriter,
} from "./terminal-demo-run-writer.js";

type TerminalDemoRunTransitionTransaction = Parameters<
  Parameters<CheckoutSurgeDatabase["transaction"]>[0]
>[0];

export { terminalDemoRunTransitionLockKey } from "@checkout-surge/db";

export class PostgresTerminalDemoRunSummaryWriter implements TerminalDemoRunWriter {
  constructor(
    private readonly db: CheckoutSurgeDatabase,
    private readonly queueLimits: OrderProcessQueueLimits,
    private readonly logger: Pick<CheckoutSurgeLogger, "error"> = console,
  ) {}

  async claimTerminalRun(input: TerminalDemoRunTransitionInput): Promise<boolean> {
    return this.withTerminalRunLock(input.runId, (tx) =>
      this.claimTerminalRunInsideLock(tx, input),
    );
  }

  async write(input: TerminalDemoRunSummaryInput): Promise<boolean> {
    return this.withTerminalRunLock(input.run.id, (tx) => this.writeInsideLock(tx, input));
  }

  async writePrepared(
    runId: string,
    prepare: (db: CheckoutSurgeDatabase) => Promise<TerminalDemoRunSummaryInput | null>,
  ): Promise<boolean> {
    return this.withTerminalRunLock(runId, async (tx) => {
      // Preparation deliberately receives this transaction facade. The caller
      // must not check out through its base pool while this exclusive lock is held.
      const input = await prepare(tx as CheckoutSurgeDatabase);
      if (!input) {
        return false;
      }
      if (input.run.id !== runId) {
        throw new Error(`Prepared terminal summary run ${input.run.id} does not match ${runId}.`);
      }
      return this.writeInsideLock(tx, input);
    });
  }

  private async writeInsideLock(
    tx: TerminalDemoRunTransitionTransaction,
    input: TerminalDemoRunSummaryInput,
  ): Promise<boolean> {
    const [existingSummary] = await tx
      .select()
      .from(demoRunSummaries)
      .where(eq(demoRunSummaries.runId, input.run.id))
      .limit(1);

    if (existingSummary) {
      await this.claimTerminalRunInsideLock(tx, {
        runId: input.run.id,
        terminalStatus: existingSummary.status as TerminalDemoRunStatus,
        failureReason: existingSummary.failureReason
          ? internalRunFailureReasonSchema.parse(existingSummary.failureReason)
          : null,
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
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${terminalDemoRunTransitionLockKey(runId)}))`,
      );

      return operation(tx);
    });
    await this.queueLimits.synchronize().catch((err: unknown) => {
      this.logger.error(
        { err, runId },
        "Terminal run committed; queue limits will retry on the next lifecycle poll.",
      );
    });
    return result;
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
      replayPossible: input.replayPossible,
      startedAt: input.run.startedAt,
      endedAt: input.finalizedAt,
      transportAttemptCounts: transportAttemptCountsSchema.parse(input.transportAttemptCounts),
      httpSummary: trafficHttpSummarySchema.parse(input.httpSummary),
      trafficDeliverySummary: trafficDeliverySummarySchema.parse(input.trafficDeliverySummary),
      httpTimingBreakdownSummary: input.httpTimingBreakdownSummary,
      serverReservationTimingSummary: serverReservationTimingSummarySchema.parse(
        input.serverReservationTimingSummary,
      ),
      loadRunDiagnosticsSummary: input.loadRunDiagnosticsSummary,
      businessOutcomeSummary: input.businessOutcome,
      terminalInventorySnapshot: input.terminalInventorySnapshot,
      runSignalTimelineSummary:
        input.runSignalTimelineSummary === null
          ? null
          : runSignalTimelineSummarySchema.parse(input.runSignalTimelineSummary),
      capturedAt,
      createdAt: capturedAt,
    });

    return true;
  }
}
