import {
  type OrderProcessJob,
  orderProcessBullMqQueueName,
  type orderProcessJobName,
  orderProcessQueueName,
  type QueueStatus,
  queueStatusSchema,
} from "@checkout-surge/contracts";
import { type ConnectionOptions, type Job, type JobType, Queue } from "bullmq";
import type {
  OrderProcessQueueInspector,
  QueueConnectivityChecker,
} from "../services/queue-status-service.js";

export const queueRetryInspectionLimit = 100;
export const recentFailedJobInspectionLimit = 20;

type OrderProcessBullMqJob = Job<OrderProcessJob, void, typeof orderProcessJobName>;

export interface BullMqQueueInspectionClient {
  getJobCounts(...types: JobType[]): Promise<Record<string, number>>;
  getJobs(
    types: JobType[],
    start: number,
    end: number,
    asc?: boolean,
  ): Promise<OrderProcessBullMqJob[]>;
  close(): Promise<void>;
  disconnect?(): Promise<void>;
}

export interface BullMqOrderProcessQueueInspector
  extends OrderProcessQueueInspector,
    QueueConnectivityChecker {
  close(): Promise<void>;
  disconnect(): Promise<void>;
}

const observedCountTypes = [
  "waiting",
  "prioritized",
  "paused",
  "delayed",
  "active",
  "failed",
] as const;
const retryCandidateTypes = ["waiting", "prioritized", "paused", "delayed", "active"] as const;
const waitingAgeCandidateTypes = ["waiting", "prioritized", "paused"] as const;

export function createBullMqOrderProcessQueueInspector(
  connection: ConnectionOptions,
): BullMqOrderProcessQueueInspector {
  const queue = new Queue<OrderProcessJob, void, typeof orderProcessJobName>(
    orderProcessBullMqQueueName,
    { connection },
  );

  return createOrderProcessQueueInspector(queue);
}

export function createOrderProcessQueueInspector(
  queue: BullMqQueueInspectionClient,
  options: {
    now?: () => Date;
    retryInspectionLimit?: number;
    failedJobInspectionLimit?: number;
  } = {},
): BullMqOrderProcessQueueInspector {
  const now = options.now ?? (() => new Date());
  const retryInspectionLimit = options.retryInspectionLimit ?? queueRetryInspectionLimit;
  const failedJobInspectionLimit =
    options.failedJobInspectionLimit ?? recentFailedJobInspectionLimit;
  const retryRangeEnd = Math.ceil(retryInspectionLimit / retryCandidateTypes.length) - 1;

  return {
    async inspect(): Promise<QueueStatus> {
      const measuredAt = now();
      const [counts, oldestWaitingJobs, retryCandidateJobs, failedJobs] = await Promise.all([
        queue.getJobCounts(...observedCountTypes),
        queue.getJobs([...waitingAgeCandidateTypes], 0, 0, true),
        // BullMQ applies the range to each state, so divide the limit to keep total reads bounded.
        queue.getJobs([...retryCandidateTypes], 0, retryRangeEnd, true),
        queue.getJobs(["failed"], 0, failedJobInspectionLimit - 1, false),
      ]);
      const normalizedCounts = {
        waiting: count(counts, "waiting"),
        prioritized: count(counts, "prioritized"),
        paused: count(counts, "paused"),
        delayed: count(counts, "delayed"),
        active: count(counts, "active"),
        failed: count(counts, "failed"),
      };
      const retryEligibleJobCount =
        normalizedCounts.waiting +
        normalizedCounts.prioritized +
        normalizedCounts.paused +
        normalizedCounts.delayed +
        normalizedCounts.active;
      const inspectedRetryJobs = retryCandidateJobs.slice(0, retryInspectionLimit);
      const oldestWaitingTimestamp = oldestWaitingJobs.reduce<number | null>(
        (oldest, job) => (oldest === null || job.timestamp < oldest ? job.timestamp : oldest),
        null,
      );

      return queueStatusSchema.parse({
        name: orderProcessQueueName,
        connectivity: "reachable",
        // Backlog covers every non-flow state observed here that awaits execution.
        depth:
          normalizedCounts.waiting +
          normalizedCounts.prioritized +
          normalizedCounts.paused +
          normalizedCounts.delayed,
        counts: normalizedCounts,
        oldestWaitingAgeSeconds:
          oldestWaitingTimestamp === null
            ? null
            : Math.max(0, (measuredAt.getTime() - oldestWaitingTimestamp) / 1000),
        retryPressure: {
          inspectedJobCount: inspectedRetryJobs.length,
          inspectionLimit: retryInspectionLimit,
          retryingJobCount: inspectedRetryJobs.filter((job) => job.attemptsMade > 0).length,
          retryAttemptCount: inspectedRetryJobs.reduce((total, job) => total + job.attemptsMade, 0),
          inspectionTruncated: retryEligibleJobCount > inspectedRetryJobs.length,
        },
        failedJobs: {
          totalCount: normalizedCounts.failed,
          recent: failedJobs.slice(0, failedJobInspectionLimit).map((job) => ({
            jobId: job.id ?? "unknown",
            jobName: job.name,
            attemptsMade: job.attemptsMade,
            failedReason: job.failedReason?.trim() || "Unknown failure.",
            failedAt: job.finishedOn === undefined ? null : new Date(job.finishedOn).toISOString(),
          })),
          inspectionLimit: failedJobInspectionLimit,
          inspectionTruncated: normalizedCounts.failed > failedJobs.length,
        },
        observedAt: measuredAt.toISOString(),
      });
    },
    async checkConnectivity(): Promise<void> {
      await queue.getJobCounts("waiting");
    },
    close: () => queue.close(),
    disconnect: () => queue.disconnect?.() ?? queue.close(),
  };
}

function count(counts: Record<string, number>, type: string): number {
  return counts[type] ?? 0;
}
