import type {
  OrderProcessJob,
  OrderWaitingReason,
  recoveryJobStatusValues,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import type { OrderJobPublisher } from "./order-job-publisher.js";
import type {
  OrderProcessJobHandler,
  OrderRecoveryHandoff,
  RecoverableOrderHandoff,
} from "./order-process-job-handler.js";
import { acceptedRunSnapshotFailureCode } from "./run-config.js";

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

/**
 * Durable per-order processing-control record (D01/D04). One row per order in
 * `order_recovery_jobs`; it carries the operational situation of the order
 * independent of queue deliveries.
 */
export interface OrderControlRecord {
  orderId: string;
  recoveryKey: string;
  status: (typeof recoveryJobStatusValues)[number];
  processingGeneration: number;
  attempts: number;
  leaseExpiresAt: Date | null;
  nextAttemptAt: Date | null;
  waitingReason: OrderWaitingReason | null;
  publicationOwner: string | null;
  unresolvedErpCallId: string | null;
}

export interface OrderRecoveryPersistence {
  isTerminalResetRun?(runId: string): Promise<boolean>;
  recordRecoverable(input: RecoverableOrderHandoff): Promise<void>;
  findRecoverable(input: { limit: number; now: Date }): Promise<RecoverableOrderJob[]>;
  readControlRecord(input: { orderId: string }): Promise<OrderControlRecord | null>;
  markEscalated(input: { recoveryKey: string; error: string }): Promise<void>;
  recordDeadLetter(input: DeadLetterRecord): Promise<void>;
  claimForPublication(input: {
    recoveryKey: string;
    now: Date;
    leaseMs: number;
  }): Promise<{ attempt: number; processingGeneration: number; jobId: string } | null>;
  markPublicationFailed(input: {
    recoveryKey: string;
    error: string;
    nextAttemptAt: Date;
    processingGeneration: number;
  }): Promise<void>;
  markResolved(input: { recoveryKey: string }): Promise<void>;
  reconcileTerminal(): Promise<number>;
  /**
   * Durably defers the order: stores the waiting reason and the next eligible
   * time and releases the current lease. A stale generation is rejected
   * without overwriting a newer owner.
   */
  defer(input: {
    orderId: string;
    waitingReason: OrderWaitingReason;
    nextEligibleAt: Date;
    processingGeneration: number;
  }): Promise<boolean>;
  /** Clears the unresolved dispatched-call identity once its outcome is known. */
  resolveDispatchedCall(input: { orderId: string; erpCallId: string }): Promise<boolean>;
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
  persistence: Pick<OrderRecoveryPersistence, "recordRecoverable" | "markResolved">,
): OrderRecoveryHandoff {
  return {
    handoff(input) {
      return persistence.recordRecoverable(input);
    },
    resolve(input) {
      return persistence.markResolved(input);
    },
  };
}

export function createOrderRecoveryScanner(dependencies: {
  persistence: OrderRecoveryPersistence;
  handler: OrderProcessJobHandler;
  publisher: OrderJobPublisher;
  logger: CheckoutSurgeLogger;
  scanIntervalMs: number;
  batchSize: number;
  maxRecoveryAttempts?: number;
  recoveryLeaseMs?: number;
  failedJobReader: FailedOrderJobReader;
  now?: () => Date;
}): OrderRecoveryScanner {
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let closed = false;
  // ERP request timeout defaults to 2s; this lease leaves room for DB writes,
  // BullMQ scheduling and transient latency before another scanner can reclaim.
  const recoveryLeaseMs = dependencies.recoveryLeaseMs ?? 30_000;

  const scanOnce = async () => {
    const now = dependencies.now?.() ?? new Date();
    await dependencies.persistence.reconcileTerminal();
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
    const candidates = await dependencies.persistence.findRecoverable({
      limit: dependencies.batchSize,
      now,
    });
    let enqueued = 0;
    let failed = 0;
    const escalated = 0;
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
      const claim = await dependencies.persistence.claimForPublication({
        recoveryKey: candidate.recoveryKey,
        now,
        leaseMs: recoveryLeaseMs,
      });
      if (!claim) continue;
      try {
        await dependencies.publisher.enqueue(
          { ...candidate.job, processingGeneration: claim.processingGeneration },
          { jobId: claim.jobId, attempts: 1 },
        );
        enqueued += 1;
      } catch (error) {
        const snapshotFailureCode = acceptedRunSnapshotFailureCode(error);
        if (snapshotFailureCode) {
          await dependencies.handler.handle(
            { ...candidate.job, processingGeneration: claim.processingGeneration },
            {
              attemptNumber: claim.attempt,
              attemptsMade: claim.attempt - 1,
              maxAttempts: 1,
              deliveryId: claim.jobId,
              processingGeneration: claim.processingGeneration,
            },
          );
          continue;
        }
        failed += 1;
        await dependencies.persistence.markPublicationFailed({
          recoveryKey: candidate.recoveryKey,
          error: error instanceof Error ? error.message : String(error),
          nextAttemptAt: new Date(now.getTime() + 1_000),
          processingGeneration: claim.processingGeneration,
        });
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
