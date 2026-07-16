import {
  type OrderProcessJob,
  orderProcessBullMqQueueName,
  orderProcessJobName,
  orderProcessJobSchema,
} from "@checkout-surge/contracts";
import { type ConnectionOptions, Queue } from "bullmq";
import type { OrderDispatchPublisher } from "../application/order-dispatch-scanner.js";
import type {
  FailedOrderJobReader,
  RecoveryJobPublisher,
} from "../application/order-recovery-scanner.js";
import type { RunConfigReader } from "../application/run-config.js";
import {
  deadLetterFailureMarker,
  recoverableFailureMarker,
} from "./bullmq-order-process-consumer.js";

export interface WorkerOrderProcessJobPublisher
  extends OrderDispatchPublisher,
    RecoveryJobPublisher,
    FailedOrderJobReader {
  close(): Promise<void>;
}

interface OrderProcessQueue {
  add(
    name: typeof orderProcessJobName,
    data: OrderProcessJob,
    options: {
      jobId: string;
      attempts: number;
      backoff: { type: "exponential"; delay: number };
    },
  ): Promise<unknown>;
  close(): Promise<void>;
  getJobs?(
    types: Array<"failed">,
    start: number,
    end: number,
  ): Promise<
    Array<{
      id?: string;
      name?: string;
      data: unknown;
      attemptsMade: number;
      opts: { attempts?: number };
      failedReason?: string;
      progress?: unknown;
    }>
  >;
}

export function createBullMqOrderProcessJobPublisher(
  connection: ConnectionOptions,
  retryOptions: { maxAttempts: number; backoffBaseMs: number } = {
    maxAttempts: 4,
    backoffBaseMs: 500,
  },
  runConfigReader?: RunConfigReader,
): WorkerOrderProcessJobPublisher {
  const queue = new Queue<OrderProcessJob, void, typeof orderProcessJobName>(
    orderProcessBullMqQueueName,
    { connection },
  );

  return createOrderProcessJobPublisher(queue, retryOptions, runConfigReader);
}

export function createOrderProcessJobPublisher(
  queue: OrderProcessQueue,
  retryOptions: { maxAttempts: number; backoffBaseMs: number } = {
    maxAttempts: 4,
    backoffBaseMs: 500,
  },
  runConfigReader?: RunConfigReader,
): WorkerOrderProcessJobPublisher {
  return {
    async enqueue(input, options?: { jobId?: string; attempts?: number }) {
      const job = orderProcessJobSchema.parse(input);
      const snapshot =
        job.runId && !options?.attempts ? await runConfigReader?.read(job.runId) : null;
      if (job.runId && !options?.attempts && !snapshot) {
        throw new Error(`Accepted run snapshot was not found for order job run ${job.runId}.`);
      }
      const retryPolicy = snapshot?.backpressureConfig.retryPolicy;
      await queue.add(orderProcessJobName, job, {
        attempts: options?.attempts ?? retryPolicy?.maxAttempts ?? retryOptions.maxAttempts,
        backoff: {
          type: "exponential",
          delay: retryPolicy?.initialBackoffMs ?? retryOptions.backoffBaseMs,
        },
        jobId: options?.jobId ?? job.orderId,
      });
    },
    async findFailedOrderJobs(limit) {
      if (!queue.getJobs) return [];
      const failedJobs = await queue.getJobs(["failed"], 0, Math.max(limit - 1, 0));
      const result = [];
      for (const failedJob of failedJobs) {
        const parsed = orderProcessJobSchema.safeParse(failedJob.data);
        const failedReason = failedJob.failedReason ?? "order-processing job failed";
        const deadLetter = readDeadLetterDisposition(failedJob.progress, failedReason);
        if (deadLetter) {
          result.push({
            disposition: "dead_letter" as const,
            jobId: failedJob.id ?? `unknown:${failedJob.name ?? orderProcessJobName}`,
            jobName: failedJob.name ?? orderProcessJobName,
            rawData: failedJob.data,
            attemptsMade: failedJob.attemptsMade,
            maxAttempts:
              failedJob.opts.attempts && failedJob.opts.attempts > 0 ? failedJob.opts.attempts : 1,
            failedReason,
            ...(deadLetter.reason ? { reason: deadLetter.reason } : {}),
            ...(deadLetter.orderId ? { orderId: deadLetter.orderId } : {}),
            ...(deadLetter.mismatchedFields
              ? { mismatchedFields: deadLetter.mismatchedFields }
              : {}),
            ...(deadLetter.correlationId ? { correlationId: deadLetter.correlationId } : {}),
          });
          continue;
        }
        if (!parsed.success || !isRecoverableFailedReason(failedReason, failedJob.progress))
          continue;
        const dispositionId = readDispositionId(
          failedJob.progress,
          failedJob.id,
          failedJob.attemptsMade,
        );
        result.push({
          job: parsed.data,
          attemptsMade: failedJob.attemptsMade,
          maxAttempts:
            failedJob.opts.attempts && failedJob.opts.attempts > 0 ? failedJob.opts.attempts : 1,
          failedReason,
          ...(failedJob.id ? { jobId: failedJob.id } : {}),
          ...(dispositionId ? { dispositionId } : {}),
        });
      }
      return result;
    },
    close: () => queue.close(),
  };
}

function isRecoverableFailedReason(reason: string, progress: unknown): boolean {
  if (
    typeof progress === "object" &&
    progress !== null &&
    "type" in progress &&
    progress.type === "recoverable_order_processing_failure" &&
    "marker" in progress &&
    progress.marker === recoverableFailureMarker
  ) {
    return true;
  }
  return reason.startsWith(recoverableFailureMarker);
}

function readDispositionId(progress: unknown, jobId: string | undefined, attemptsMade: number) {
  if (
    typeof progress === "object" &&
    progress !== null &&
    "dispositionId" in progress &&
    typeof progress.dispositionId === "string" &&
    progress.dispositionId.length > 0
  ) {
    return progress.dispositionId;
  }
  return jobId ? `${jobId}:${attemptsMade + 1}` : undefined;
}

function readDeadLetterDisposition(
  progress: unknown,
  reason: string,
): {
  reason?: string;
  orderId?: string;
  mismatchedFields?: readonly string[];
  correlationId?: string;
} | null {
  if (reason.startsWith(deadLetterFailureMarker)) {
    const envelope = reason.slice(deadLetterFailureMarker.length).trim();
    try {
      const parsed: unknown = JSON.parse(envelope);
      if (typeof parsed === "object" && parsed !== null) {
        const reasonValue = readString(parsed, "reason");
        const orderId = readString(parsed, "orderId");
        const correlationId = readString(parsed, "correlationId");
        const mismatchedFields = readStringArray(parsed, "mismatchedFields");
        return {
          ...(reasonValue ? { reason: reasonValue } : {}),
          ...(orderId ? { orderId } : {}),
          ...(correlationId ? { correlationId } : {}),
          ...(mismatchedFields ? { mismatchedFields } : {}),
        };
      }
    } catch {
      // Preserve a non-JSON legacy marker as a diagnostic reason.
    }
    return { reason: envelope || "dead_letter_required" };
  }
  if (
    typeof progress !== "object" ||
    progress === null ||
    !("type" in progress) ||
    progress.type !== "dead_letter_required" ||
    !("marker" in progress) ||
    progress.marker !== deadLetterFailureMarker
  ) {
    return null;
  }
  const reasonValue = readString(progress, "reason");
  const orderId = readString(progress, "orderId");
  const correlationId = readString(progress, "correlationId");
  const mismatchedFields = readStringArray(progress, "mismatchedFields");
  return {
    ...(reasonValue ? { reason: reasonValue } : { reason: "dead_letter_required" }),
    ...(orderId ? { orderId } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(mismatchedFields ? { mismatchedFields } : {}),
  };
}

function readString(value: object, key: string): string | undefined {
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function readStringArray(value: object, key: string): readonly string[] | undefined {
  const candidate = (value as Record<string, unknown>)[key];
  return Array.isArray(candidate) && candidate.every((item) => typeof item === "string")
    ? candidate
    : undefined;
}
