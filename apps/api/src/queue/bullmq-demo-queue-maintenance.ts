import {
  notificationRecordBullMqQueueName,
  notificationRecordJobSchema,
  notificationRecordQueueName,
  orderProcessBullMqQueueName,
  orderProcessJobSchema,
  orderProcessQueueName,
} from "@checkout-surge/contracts";
import { type ConnectionOptions, Queue } from "bullmq";
import {
  type DemoQueueMaintenance,
  DemoQueueMaintenanceConflict,
  type QueueCleanupSummary,
} from "../services/demo-queue-maintenance.js";

const targetedStates = [
  "waiting",
  "delayed",
  "prioritized",
  "paused",
  "failed",
  "completed",
] as const;

export interface TargetQueueJob {
  id?: string | undefined;
  name: string;
  data: unknown;
  remove(): Promise<void>;
}

export interface TargetQueueBoundary {
  semanticName: string;
  parse(data: unknown): { runId?: string | undefined };
  isPaused(): Promise<boolean>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  getJobs(states: string[]): Promise<TargetQueueJob[]>;
  close(): Promise<void>;
}

export function createBullMqDemoQueueMaintenance(
  connection: ConnectionOptions,
): DemoQueueMaintenance & { close(): Promise<void> } {
  return createDemoQueueMaintenance([
    bullMqBoundary(
      orderProcessQueueName,
      new Queue(orderProcessBullMqQueueName, { connection }),
      (data) => orderProcessJobSchema.parse(data),
    ),
    bullMqBoundary(
      notificationRecordQueueName,
      new Queue(notificationRecordBullMqQueueName, { connection }),
      (data) => notificationRecordJobSchema.parse(data),
    ),
  ]);
}

export function createDemoQueueMaintenance(
  queues: TargetQueueBoundary[],
): DemoQueueMaintenance & { close(): Promise<void> } {
  let closePromise: Promise<void> | undefined;
  const maintenancePausedQueues = new Set<TargetQueueBoundary>();
  return {
    async cleanRuns(runIds): Promise<QueueCleanupSummary> {
      const targets = new Set(runIds);
      if (targets.size === 0) return { cleanedQueueCount: 0, cleanedJobCount: 0 };
      if (closePromise) {
        throw new Error("Queue maintenance is closing and cannot clean generated runs.");
      }

      const queuesToResume = new Set<TargetQueueBoundary>();
      let result: QueueCleanupSummary | undefined;
      let primaryError: unknown;
      try {
        for (const queue of queues) {
          if (maintenancePausedQueues.has(queue)) {
            queuesToResume.add(queue);
            if (!(await queue.isPaused())) await queue.pause();
            continue;
          }
          if (await queue.isPaused()) continue;
          maintenancePausedQueues.add(queue);
          queuesToResume.add(queue);
          await queue.pause();
        }
        result = await cleanExactJobs(queues, targets);
      } catch (error) {
        primaryError = error;
      } finally {
        const resumeErrors = await resumeQueues(queuesToResume, maintenancePausedQueues);
        if (resumeErrors.length > 0) {
          primaryError = primaryError
            ? new AggregateError(
                [primaryError, ...resumeErrors],
                "Queue maintenance failed and could not fully restore queue availability.",
              )
            : new AggregateError(
                resumeErrors,
                "Queue maintenance could not fully restore queue availability.",
              );
        }
      }
      if (primaryError) throw primaryError;
      if (!result) throw new Error("Queue maintenance completed without a cleanup result.");
      return result;
    },

    close() {
      closePromise ??= closeQueues(queues, maintenancePausedQueues);
      return closePromise;
    },
  };
}

function bullMqBoundary(
  semanticName: string,
  queue: Queue,
  parse: TargetQueueBoundary["parse"],
): TargetQueueBoundary {
  return {
    semanticName,
    parse,
    isPaused: () => queue.isPaused(),
    pause: () => queue.pause(),
    resume: () => queue.resume(),
    getJobs: (states) => queue.getJobs(states as Parameters<Queue["getJobs"]>[0], 0, -1, true),
    close: () => queue.close(),
  };
}

async function resumeQueues(
  queues: Iterable<TargetQueueBoundary>,
  maintenancePausedQueues: Set<TargetQueueBoundary>,
): Promise<unknown[]> {
  const attempted = [...queues];
  const results = await Promise.allSettled(attempted.map((queue) => queue.resume()));
  const failed = results.flatMap((result, index) => {
    const queue = attempted[index];
    if (!queue) return [];
    if (result.status === "rejected") return [{ queue, error: result.reason }];
    maintenancePausedQueues.delete(queue);
    return [];
  });
  const retryResults = await Promise.allSettled(failed.map(({ queue }) => queue.resume()));
  for (const [index, result] of retryResults.entries()) {
    if (result.status === "fulfilled") {
      const queue = failed[index]?.queue;
      if (queue) maintenancePausedQueues.delete(queue);
    }
  }
  return [
    ...failed.map(({ error }) => error),
    ...retryResults.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
  ];
}

async function closeQueues(
  queues: TargetQueueBoundary[],
  maintenancePausedQueues: Set<TargetQueueBoundary>,
): Promise<void> {
  const resumeErrors = await resumeQueues(maintenancePausedQueues, maintenancePausedQueues);
  const closeResults = await Promise.allSettled(queues.map((queue) => queue.close()));
  const errors = [
    ...resumeErrors,
    ...closeResults.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
  ];
  if (errors.length > 0) {
    throw new AggregateError(errors, "Could not fully close queue maintenance.");
  }
}

async function cleanExactJobs(
  queues: TargetQueueBoundary[],
  runIds: ReadonlySet<string>,
): Promise<QueueCleanupSummary> {
  const jobsToRemove: Array<{ queue: TargetQueueBoundary; job: TargetQueueJob; runId: string }> =
    [];
  for (const queue of queues) {
    for (const job of await queue.getJobs(["active"])) {
      const attribution = classifyJob(queue, job, runIds);
      if (attribution.kind === "malformed_target")
        throw malformedJobError(attribution.runId, queue, job);
      if (attribution.kind === "target") {
        throw new DemoQueueMaintenanceConflict(
          "active_job",
          `Run ${attribution.runId} has active work on ${queue.semanticName}; retry after it settles.`,
        );
      }
    }
    for (const job of await queue.getJobs([...targetedStates])) {
      const attribution = classifyJob(queue, job, runIds);
      if (attribution.kind === "malformed_target")
        throw malformedJobError(attribution.runId, queue, job);
      if (attribution.kind === "target") {
        jobsToRemove.push({ queue, job, runId: attribution.runId });
      }
    }
  }

  for (const { job } of jobsToRemove) {
    await job.remove();
  }
  return { cleanedQueueCount: queues.length, cleanedJobCount: jobsToRemove.length };
}

type JobAttribution =
  | { kind: "target"; runId: string }
  | { kind: "other" }
  | { kind: "malformed_target"; runId: string };

function classifyJob(
  queue: TargetQueueBoundary,
  job: Pick<TargetQueueJob, "data">,
  runIds: ReadonlySet<string>,
): JobAttribution {
  try {
    const runId = queue.parse(job.data).runId;
    return runId && runIds.has(runId) ? { kind: "target", runId } : { kind: "other" };
  } catch {
    const runId = (job.data as { runId?: unknown } | null)?.runId;
    return typeof runId === "string" && runIds.has(runId)
      ? { kind: "malformed_target", runId }
      : { kind: "other" };
  }
}

function malformedJobError(
  runId: string,
  queue: TargetQueueBoundary,
  job: Pick<TargetQueueJob, "id" | "name">,
): DemoQueueMaintenanceConflict {
  return new DemoQueueMaintenanceConflict(
    "malformed_claimed_job",
    `Malformed job ${job.id ?? job.name} claims run ${runId} on ${queue.semanticName}; preserve it and retry after operator review.`,
  );
}
