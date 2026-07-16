import type { OrderProcessJob } from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import type { OrderJobPublisher } from "./order-job-publisher.js";
import type { OrderRecoveryHandoff, RecoverableOrderHandoff } from "./order-process-job-handler.js";

export type { RecoverableOrderHandoff } from "./order-process-job-handler.js";

export interface RecoverableOrderJob {
  recoveryKey: string;
  job: OrderProcessJob;
  reason: string;
  attempts: number;
  createdAt: Date;
  sourceJobId?: string;
  sourceDisposition?: string;
}

export interface OrderRecoveryPersistence {
  recordRecoverable(input: RecoverableOrderHandoff): Promise<void>;
  findRecoverable(input: { limit: number; now: Date }): Promise<RecoverableOrderJob[]>;
  markEnqueued(input: {
    recoveryKey: string;
    nextAttemptAt: Date;
    attempts: number;
  }): Promise<void>;
  markEscalated(input: { recoveryKey: string; error: string }): Promise<void>;
  recordDeadLetter(input: DeadLetterRecord): Promise<void>;
  claimForPublication?(input: {
    recoveryKey: string;
    now: Date;
    leaseMs: number;
  }): Promise<{ attempt: number } | null>;
  markPublicationFailed?(input: {
    recoveryKey: string;
    error: string;
    nextAttemptAt: Date;
  }): Promise<void>;
  markResolved?(input: { recoveryKey: string }): Promise<void>;
  reconcileTerminal?(): Promise<number>;
}

export interface DeadLetterRecord {
  jobId: string;
  jobName: string;
  queueName?: string | undefined;
  payload?: unknown;
  orderId?: string | undefined;
  reason: string;
  mismatchedFields?: readonly string[] | undefined;
  attemptsMade: number;
  correlationId?: string | undefined;
  observedAt: Date;
}

export interface RecoveryJobPublisher extends OrderJobPublisher {}

export interface FailedOrderJobReader {
  findFailedOrderJobs(limit: number): Promise<
    Array<{
      disposition?: "recoverable" | "dead_letter";
      job?: OrderProcessJob;
      rawData?: unknown;
      jobName?: string;
      attemptsMade: number;
      maxAttempts: number;
      failedReason: string;
      jobId?: string;
      dispositionId?: string;
      reason?: string;
      orderId?: string;
      mismatchedFields?: readonly string[];
      correlationId?: string;
    }>
  >;
}

export interface OrderRecoveryScanner {
  scanOnce(): Promise<{
    candidates: number;
    enqueued: number;
    failed: number;
    escalated: number;
    oldestAgeMs: number | null;
    maxObservedAttempts: number;
  }>;
  start(): void;
  close(): Promise<void>;
}

export function createOrderRecoveryHandoff(
  persistence: Pick<OrderRecoveryPersistence, "recordRecoverable"> &
    Partial<Pick<OrderRecoveryPersistence, "markResolved">>,
): OrderRecoveryHandoff {
  const handoff: OrderRecoveryHandoff = {
    handoff(input) {
      return persistence.recordRecoverable(input);
    },
  };
  if (persistence.markResolved) {
    handoff.resolve = persistence.markResolved;
  }
  return handoff;
}

export function createOrderRecoveryScanner(dependencies: {
  persistence: OrderRecoveryPersistence;
  publisher: RecoveryJobPublisher;
  logger: CheckoutSurgeLogger;
  scanIntervalMs: number;
  batchSize: number;
  maxRecoveryAttempts?: number;
  recoveryLeaseMs?: number;
  failedJobReader?: FailedOrderJobReader;
  now?: () => Date;
}): OrderRecoveryScanner {
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let closed = false;
  const maxRecoveryAttempts = dependencies.maxRecoveryAttempts ?? 100;
  // ERP request timeout defaults to 2s; this lease leaves room for DB writes,
  // BullMQ scheduling and transient latency before another scanner can reclaim.
  const recoveryLeaseMs = dependencies.recoveryLeaseMs ?? 30_000;

  const scanOnce = async () => {
    const now = dependencies.now?.() ?? new Date();
    await dependencies.persistence.reconcileTerminal?.();
    if (dependencies.failedJobReader) {
      const failedJobs = await dependencies.failedJobReader.findFailedOrderJobs(
        dependencies.batchSize,
      );
      for (const failed of failedJobs) {
        if (failed.disposition === "dead_letter") {
          await dependencies.persistence.recordDeadLetter({
            jobId: failed.jobId ?? `unknown:${failed.jobName ?? "order-process"}`,
            jobName: failed.jobName ?? "unknown",
            queueName: "orders:process",
            payload: failed.rawData,
            ...(failed.orderId ? { orderId: failed.orderId } : {}),
            reason: failed.reason ?? "dead_letter_reconciliation",
            ...(failed.mismatchedFields ? { mismatchedFields: failed.mismatchedFields } : {}),
            attemptsMade: failed.attemptsMade,
            ...(failed.correlationId ? { correlationId: failed.correlationId } : {}),
            observedAt: now,
          });
          continue;
        }
        if (!failed.job) continue;
        await dependencies.persistence.recordRecoverable({
          job: failed.job,
          delivery: {
            attemptNumber: failed.attemptsMade + 1,
            attemptsMade: failed.attemptsMade,
            maxAttempts: failed.maxAttempts,
            deliveryId: failed.jobId ?? failed.job.orderId,
          },
          reason: "failed_queue_job_reconciliation",
          error: new Error(failed.failedReason),
          ...(failed.jobId ? { sourceJobId: failed.jobId } : {}),
          ...(failed.dispositionId
            ? { sourceDisposition: failed.dispositionId }
            : failed.jobId
              ? { sourceDisposition: `${failed.jobId}:${failed.attemptsMade + 1}` }
              : {}),
        });
      }
    }
    const candidates = await dependencies.persistence.findRecoverable({
      limit: dependencies.batchSize,
      now,
    });
    let enqueued = 0;
    let failed = 0;
    let escalated = 0;
    const oldestAgeMs =
      candidates.length > 0
        ? Math.max(
            0,
            now.getTime() -
              Math.min(...candidates.map((candidate) => candidate.createdAt.getTime())),
          )
        : null;
    const maxObservedAttempts = candidates.reduce(
      (max, candidate) => Math.max(max, candidate.attempts),
      0,
    );
    for (const candidate of candidates) {
      if (candidate.attempts >= maxRecoveryAttempts) {
        await dependencies.persistence.markEscalated({
          recoveryKey: candidate.recoveryKey,
          error: "recovery_attempt_limit_exceeded",
        });
        escalated += 1;
        continue;
      }
      let publicationAttempt = candidate.attempts + 1;
      if (dependencies.persistence.claimForPublication) {
        const claim = await dependencies.persistence.claimForPublication({
          recoveryKey: candidate.recoveryKey,
          now,
          leaseMs: recoveryLeaseMs,
        });
        if (!claim) continue;
        publicationAttempt = claim.attempt;
      }
      try {
        await dependencies.publisher.enqueue(candidate.job, {
          jobId: `recovery-${candidate.job.orderId}-${publicationAttempt}`,
          // Recovery is deliberately not constrained by the normal delivery budget.
          attempts: 1,
        });
        if (!dependencies.persistence.claimForPublication) {
          await dependencies.persistence.markEnqueued({
            recoveryKey: candidate.recoveryKey,
            nextAttemptAt: new Date(now.getTime() + recoveryLeaseMs),
            attempts: publicationAttempt,
          });
        }
        enqueued += 1;
      } catch (error) {
        failed += 1;
        if (dependencies.persistence.markPublicationFailed) {
          await dependencies.persistence.markPublicationFailed({
            recoveryKey: candidate.recoveryKey,
            error: error instanceof Error ? error.message : String(error),
            nextAttemptAt: new Date(now.getTime() + 1_000),
          });
        }
        dependencies.logger.error(
          { err: error, recoveryKey: candidate.recoveryKey, orderId: candidate.job.orderId },
          "Order recovery job could not be enqueued.",
        );
      }
    }
    if (candidates.length > 0) {
      dependencies.logger.info(
        {
          candidates: candidates.length,
          enqueued,
          failed,
          escalated,
          oldestAgeMs,
          maxObservedAttempts,
        },
        "Order recovery scan completed.",
      );
    }
    return {
      candidates: candidates.length,
      enqueued,
      failed,
      escalated,
      oldestAgeMs,
      maxObservedAttempts,
    };
  };
  const run = () => {
    if (closed || running) return;
    running = scanOnce()
      .then(() => undefined)
      .catch((error) => {
        dependencies.logger.error({ err: error }, "Order recovery scan failed.");
      })
      .finally(() => {
        running = null;
      });
  };
  return {
    scanOnce,
    start() {
      if (timer) return;
      closed = false;
      run();
      timer = setInterval(run, dependencies.scanIntervalMs);
      timer.unref();
    },
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  };
}
