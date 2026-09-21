import {
  type OrderProcessJob,
  orderProcessBullMqQueueName,
  orderProcessJobName,
  orderProcessJobSchema,
} from "@checkout-surge/contracts";
import { type ConnectionOptions, Queue } from "bullmq";
import type { GeneratedRunPublicationFence } from "../application/generated-run-publication-fence.js";
import type { OrderJobPublisher } from "../application/order-job-publisher.js";
import type {
  FailedOrderJobReader,
  OrderDeliveryStateReader,
} from "../application/order-recovery-scanner.js";
import {
  deadLetterFailureMarker,
  recoverableFailureMarker,
} from "./bullmq-order-process-consumer.js";

export interface WorkerOrderProcessJobPublisher
  extends OrderJobPublisher,
    FailedOrderJobReader,
    OrderDeliveryStateReader {
  pauseDelivery(durationMs: number): Promise<void>;
  close(): Promise<void>;
}

interface OrderProcessQueue {
  rateLimit(durationMs: number): Promise<void>;
  add(
    name: typeof orderProcessJobName,
    data: OrderProcessJob,
    options: {
      jobId: string;
      attempts: number;
    },
  ): Promise<unknown>;
  close(): Promise<void>;
  getJobState?(jobId: string): Promise<string | null>;
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
  publicationFence?: GeneratedRunPublicationFence,
): WorkerOrderProcessJobPublisher {
  const queue = new Queue<OrderProcessJob, void, typeof orderProcessJobName>(
    orderProcessBullMqQueueName,
    { connection },
  );

  return createOrderProcessJobPublisher(queue, publicationFence);
}

export function createOrderProcessJobPublisher(
  queue: OrderProcessQueue,
  publicationFence?: GeneratedRunPublicationFence,
): WorkerOrderProcessJobPublisher {
  return {
    pauseDelivery: (durationMs) => queue.rateLimit(durationMs),
    async isDeliveryPending(jobId) {
      if (!queue.getJobState) return false;
      const state = await queue.getJobState(jobId);
      return (
        state === "waiting" || state === "active" || state === "delayed" || state === "prioritized"
      );
    },
    async enqueue(input, options?: { jobId?: string; attempts?: number }) {
      const job = orderProcessJobSchema.parse(input);
      const add = async () => {
        await queue.add(orderProcessJobName, job, {
          attempts: 1,
          jobId: options?.jobId ?? job.orderId,
        });
      };

      if (!job.runId) {
        await add();
        return;
      }
      if (!publicationFence) {
        throw new Error("Generated-run order publication requires a PostgreSQL publication fence.");
      }
      await publicationFence.publish({
        runId: job.runId,
        saleOfferId: job.saleOfferId,
        operation: add,
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
      // Invalid failedReason metadata is not a dead-letter disposition.
    }
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
