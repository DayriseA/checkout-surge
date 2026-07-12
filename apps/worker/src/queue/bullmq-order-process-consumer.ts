import {
  type OrderProcessJob,
  orderProcessBullMqQueueName,
  orderProcessJobName,
  orderProcessJobSchema,
  orderProcessQueueName,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { type ConnectionOptions, DelayedError, type Job, Worker } from "bullmq";
import { ErpCircuitOpenError } from "../application/erp-circuit-breaker.js";
import type { OrderProcessJobHandler } from "../application/order-process-job-handler.js";
import type { OrderRecoveryPersistence } from "../application/order-recovery-scanner.js";
import {
  OrderJobIdentityMismatchError,
  OrderNotFoundError,
} from "../persistence/postgres-order-transition-persistence.js";
import type { OrderProcessConsumer } from "./order-process-consumer.js";

export interface OrderProcessJobFailureReport {
  jobId?: string;
  jobName: string;
  attemptNumber: number;
  attemptsMade: number;
  error: Error;
}

export interface CreateBullMqOrderProcessConsumerOptions {
  connection: ConnectionOptions;
  concurrency: number;
  handler: OrderProcessJobHandler;
  logger: CheckoutSurgeLogger;
  reportFailure?: (report: OrderProcessJobFailureReport) => void | Promise<void>;
  recovery?: Pick<OrderRecoveryPersistence, "recordRecoverable" | "recordDeadLetter">;
}

export const orderProcessQueueNotReadyMessage =
  "The order-processing queue connection is not ready.";

/** Stable marker retained in BullMQ's failedReason when progress cannot be read. */
export const recoverableFailureMarker = "[CHECKOUT_SURGE_RECOVERY_REQUIRED]";
export const deadLetterFailureMarker = "[CHECKOUT_SURGE_DEAD_LETTER_REQUIRED]";

export class RecoverableOrderQueueFailureError extends Error {
  override readonly name = "RecoverableOrderQueueFailureError";

  constructor(readonly sourceError: unknown) {
    const sourceMessage = sourceError instanceof Error ? sourceError.message : String(sourceError);
    super(`${recoverableFailureMarker} ${sourceMessage}`, { cause: sourceError });
  }
}

export class DeadLetterQueueFailureError extends Error {
  override readonly name = "DeadLetterQueueFailureError";

  constructor(
    readonly input: {
      reason: string;
      orderId?: string | undefined;
      mismatchedFields?: readonly string[] | undefined;
      correlationId?: string | undefined;
    },
    readonly sourceError: unknown,
  ) {
    const sourceMessage = sourceError instanceof Error ? sourceError.message : String(sourceError);
    super(
      `${deadLetterFailureMarker} ${JSON.stringify({
        reason: input.reason,
        orderId: input.orderId ?? null,
        mismatchedFields: input.mismatchedFields ?? [],
        correlationId: input.correlationId ?? null,
        sourceError: sourceMessage,
      })}`,
      { cause: sourceError },
    );
  }
}

export function createBullMqOrderProcessConsumer(
  options: CreateBullMqOrderProcessConsumerOptions,
): OrderProcessConsumer {
  const worker = new Worker<OrderProcessJob, void, typeof orderProcessJobName>(
    orderProcessBullMqQueueName,
    async (job, token) => processJob(job, token, options),
    {
      autorun: false,
      concurrency: options.concurrency,
      connection: options.connection,
    },
  );

  let runPromise: Promise<void> | null = null;
  let isClosing = false;
  let isQueueConnectionReady = false;

  worker.on("failed", (job, error) => {
    const report: OrderProcessJobFailureReport = {
      ...(job?.id ? { jobId: job.id } : {}),
      jobName: job?.name ?? orderProcessJobName,
      attemptNumber: job?.attemptsMade ?? 0,
      attemptsMade: job?.attemptsMade ?? 0,
      error,
    };

    options.logger.error(
      {
        err: error,
        ...(report.jobId ? { jobId: report.jobId } : {}),
        jobName: report.jobName,
        attemptNumber: report.attemptNumber,
        attemptsMade: report.attemptsMade,
        ...correlationLogContext(job?.data),
      },
      "Order-processing job failed.",
    );
    reportFailureSafely(options, report);
  });

  worker.on("completed", (job) => {
    options.logger.info(
      {
        jobId: job.id,
        jobName: job.name,
        ...correlationLogContext(job.data),
      },
      "Order-processing job completed.",
    );
  });

  worker.on("error", (error) => {
    isQueueConnectionReady = false;
    options.logger.error({ err: error }, "Order-processing BullMQ worker error.");
  });

  worker.on("ready", () => {
    isQueueConnectionReady = !isClosing;
    options.logger.info(
      { queueName: orderProcessQueueName, physicalQueueName: orderProcessBullMqQueueName },
      "Order-processing BullMQ worker is ready.",
    );
  });

  worker.on("ioredis:close", () => {
    isQueueConnectionReady = false;
  });

  worker.on("closing", () => {
    isQueueConnectionReady = false;
  });

  worker.on("closed", () => {
    isQueueConnectionReady = false;
  });

  return {
    start() {
      if (runPromise) {
        return;
      }

      runPromise = worker.run().catch((error: unknown) => {
        isQueueConnectionReady = false;
        if (!isClosing) {
          options.logger.error(
            { err: error },
            "Order-processing BullMQ worker stopped unexpectedly.",
          );
        }
      });
    },
    async close() {
      isClosing = true;
      isQueueConnectionReady = false;
      await worker.close();
      await runPromise;
    },
    isRunning: () => worker.isRunning(),
    async checkConnectivity() {
      if (!isQueueConnectionReady) {
        throw new Error(orderProcessQueueNotReadyMessage);
      }
    },
  };
}

function reportFailureSafely(
  options: CreateBullMqOrderProcessConsumerOptions,
  report: OrderProcessJobFailureReport,
): void {
  if (!options.reportFailure) {
    return;
  }

  try {
    void Promise.resolve(options.reportFailure(report)).catch((error: unknown) =>
      logFailureReporterError(options.logger, error),
    );
  } catch (error) {
    logFailureReporterError(options.logger, error);
  }
}

function logFailureReporterError(logger: CheckoutSurgeLogger, error: unknown): void {
  logger.error({ err: error }, "Order-processing failure reporter threw an error.");
}

function correlationLogContext(data: unknown): { correlationId?: string } {
  if (
    typeof data === "object" &&
    data !== null &&
    "correlationId" in data &&
    typeof data.correlationId === "string"
  ) {
    return { correlationId: data.correlationId };
  }

  return {};
}

async function processJob(
  job: Job<OrderProcessJob, void, typeof orderProcessJobName>,
  token: string | undefined,
  options: CreateBullMqOrderProcessConsumerOptions,
): Promise<void> {
  if (job.name !== orderProcessJobName) {
    await recordDeadLetter(options, job, {
      jobId: String(job.id ?? `unknown:${job.name}`),
      jobName: job.name,
      queueName: orderProcessQueueName,
      payload: job.data,
      reason: "invalid_job_name",
      attemptsMade: job.attemptsMade,
      observedAt: new Date(),
    });
    return;
  }

  try {
    const parsed = orderProcessJobSchema.safeParse(job.data);
    if (!parsed.success) {
      await recordDeadLetter(options, job, {
        jobId: String(job.id ?? `unknown:${job.name}`),
        jobName: job.name,
        queueName: orderProcessQueueName,
        payload: job.data,
        reason: "invalid_job_payload",
        attemptsMade: job.attemptsMade,
        observedAt: new Date(),
      });
      return;
    }
    const recovery = readRecoveryMetadata(job.id, parsed.data.orderId);
    await options.handler.handle(parsed.data, {
      attemptNumber: job.attemptsMade + 1,
      attemptsMade: job.attemptsMade,
      maxAttempts: normalizeMaxAttempts(job.opts.attempts),
      deliveryId: String(job.id ?? parsed.data.orderId),
      ...(recovery ? { recoveryKey: recovery.recoveryKey, deliveryId: recovery.deliveryId } : {}),
    });
  } catch (error) {
    if (error instanceof OrderNotFoundError || error instanceof OrderJobIdentityMismatchError) {
      await recordDeadLetter(options, job, {
        jobId: String(job.id ?? `unknown:${job.name}`),
        jobName: job.name,
        queueName: orderProcessQueueName,
        payload: job.data,
        orderId: error.orderId,
        reason: error.name === "OrderNotFoundError" ? "order_not_found" : "order_identity_mismatch",
        ...(error instanceof OrderJobIdentityMismatchError
          ? { mismatchedFields: error.mismatchedFields }
          : {}),
        attemptsMade: job.attemptsMade,
        ...(readCorrelationId(job.data) ? { correlationId: readCorrelationId(job.data) } : {}),
        observedAt: new Date(),
      });
      return;
    }
    if (error instanceof ErpCircuitOpenError) {
      await job.moveToDelayed(Date.now() + Math.max(error.retryAfterMs, 0), token);
      throw new DelayedError();
    }

    if (
      options.recovery &&
      job.attemptsMade + 1 >= normalizeMaxAttempts(job.opts.attempts) &&
      isRecoverableFailure(error)
    ) {
      await markRecoverableDisposition(job, error);
      const parsed = orderProcessJobSchema.safeParse(job.data);
      if (parsed.success) {
        try {
          await options.recovery.recordRecoverable({
            job: parsed.data,
            delivery: {
              attemptNumber: job.attemptsMade + 1,
              attemptsMade: job.attemptsMade,
              maxAttempts: normalizeMaxAttempts(job.opts.attempts),
              deliveryId: String(job.id ?? parsed.data.orderId),
            },
            reason: "exhausted_order_processing_delivery",
            error,
            sourceJobId: String(job.id ?? parsed.data.orderId),
            sourceDisposition: `${String(job.id ?? parsed.data.orderId)}:${job.attemptsMade + 1}`,
          });
        } catch (handoffError) {
          throw new RecoverableOrderQueueFailureError(handoffError);
        }
      }
      throw new RecoverableOrderQueueFailureError(error);
    }
    throw error;
  }
}

async function recordDeadLetter(
  options: CreateBullMqOrderProcessConsumerOptions,
  job: Job<OrderProcessJob, void, typeof orderProcessJobName>,
  input: Parameters<
    NonNullable<CreateBullMqOrderProcessConsumerOptions["recovery"]>["recordDeadLetter"]
  >[0],
): Promise<void> {
  if (!options.recovery) throw new Error(`DLQ handoff unavailable: ${input.reason}`);
  try {
    await options.recovery.recordDeadLetter(input);
  } catch (error) {
    await markDeadLetterDisposition(job, input, error);
    throw new DeadLetterQueueFailureError(input, error);
  }
}

function readCorrelationId(data: unknown): string | undefined {
  return typeof data === "object" &&
    data !== null &&
    "correlationId" in data &&
    typeof data.correlationId === "string"
    ? data.correlationId
    : undefined;
}

function isRecoverableFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name.includes("PersistenceError") ||
      error.name === "ErpCircuitOpenError" ||
      error.name === "OrderRecoveryHandoffError" ||
      error.name === "RecoverableOrderQueueFailureError")
  );
}

async function markRecoverableDisposition(
  job: Job<OrderProcessJob, void, typeof orderProcessJobName>,
  error: unknown,
): Promise<void> {
  try {
    await job.updateProgress({
      type: "recoverable_order_processing_failure",
      marker: recoverableFailureMarker,
      sourceJobId: String(job.id ?? "unknown"),
      dispositionId: `${String(job.id ?? "unknown")}:${job.attemptsMade + 1}`,
      reason: error instanceof Error ? error.name : "recoverable_order_processing_failure",
      sourceMessage:
        error instanceof Error && "sourceError" in error
          ? String((error as { sourceError?: unknown }).sourceError)
          : error instanceof Error
            ? error.message
            : String(error),
      observedAt: new Date().toISOString(),
    });
  } catch {
    // A failed job remains durable in BullMQ even if progress metadata cannot be written.
  }
}

async function markDeadLetterDisposition(
  job: Job<OrderProcessJob, void, typeof orderProcessJobName>,
  input: Parameters<
    NonNullable<CreateBullMqOrderProcessConsumerOptions["recovery"]>["recordDeadLetter"]
  >[0],
  error: unknown,
): Promise<void> {
  try {
    await job.updateProgress({
      type: "dead_letter_required",
      marker: deadLetterFailureMarker,
      sourceJobId: String(job.id ?? "unknown"),
      jobName: input.jobName,
      reason: input.reason,
      orderId: input.orderId,
      mismatchedFields: input.mismatchedFields,
      attemptsMade: input.attemptsMade,
      correlationId: input.correlationId,
      payload: input.payload,
      handoffError: error instanceof Error ? error.message : String(error),
      observedAt: input.observedAt.toISOString(),
    });
  } catch {
    // The marker in the thrown error is the durable fallback when progress cannot be stored.
  }
}

function readRecoveryMetadata(
  jobId: string | undefined,
  orderId: string,
): { recoveryKey: string; deliveryId: string } | undefined {
  if (!jobId?.startsWith("recovery-")) return undefined;
  // Derive the durable key from the validated payload; delimiters in a key are
  // never parsed from the BullMQ id.
  return { recoveryKey: `order:${orderId}`, deliveryId: jobId };
}

function normalizeMaxAttempts(attempts: number | undefined): number {
  return attempts && attempts > 0 ? attempts : 1;
}
