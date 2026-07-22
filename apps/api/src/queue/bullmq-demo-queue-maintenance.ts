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
} from "../services/demo-maintenance-service.js";

const cleanedJobGraceMs = 0;
const cleanedJobLimit = 10_000;
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
  drain(delayed?: boolean): Promise<void>;
  clean(grace: number, limit: number, state: "completed" | "failed"): Promise<string[]>;
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
  const queuesNeedingResume = new Set<TargetQueueBoundary>();
  let activeLeaseDone: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  return {
    async cleanResetOwnedQueues(): Promise<QueueCleanupSummary> {
      let cleanedJobCount = 0;
      for (const queue of queues) {
        await queue.drain(true);
        for (const status of ["completed", "failed"] as const) {
          cleanedJobCount += (await queue.clean(cleanedJobGraceMs, cleanedJobLimit, status)).length;
        }
      }
      return { cleanedQueueCount: queues.length, cleanedJobCount };
    },

    async acquireGeneratedRunQuiescence(_runId) {
      if (closePromise) {
        throw new Error("Queue maintenance is closing and cannot acquire quiescence.");
      }
      if (activeLeaseDone) {
        throw new Error("Queue maintenance already has an active quiescence lease.");
      }

      let finishActiveLease!: () => void;
      activeLeaseDone = new Promise<void>((resolve) => {
        finishActiveLease = () => {
          activeLeaseDone = undefined;
          resolve();
        };
      });

      const queuesToResume = new Set<TargetQueueBoundary>();
      try {
        for (const queue of queues) {
          if (queuesNeedingResume.has(queue)) {
            queuesToResume.add(queue);
            if (!(await queue.isPaused())) await queue.pause();
            continue;
          }
          if (await queue.isPaused()) continue;
          queuesToResume.add(queue);
          queuesNeedingResume.add(queue);
          await queue.pause();
        }
      } catch (error) {
        const rollbackErrors = await resumeQueues(queuesToResume, queuesNeedingResume);
        finishActiveLease();
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [error, ...rollbackErrors],
            "Could not acquire queue quiescence and could not fully restore queue state.",
          );
        }
        throw error;
      }

      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          try {
            const errors = await resumeQueues(queuesToResume, queuesNeedingResume);
            if (errors.length > 0) {
              throw new AggregateError(errors, "Could not fully restore queue pause state.");
            }
          } finally {
            finishActiveLease();
          }
        },
      };
    },

    async preflightGeneratedRun(runId: string): Promise<void> {
      await assertNoConflictingJobs(queues, runId, ["active"]);
    },

    async cleanGeneratedRun(runId: string): Promise<{ deletedJobCount: number }> {
      const removed = new Set<string>();
      for (let pass = 0; pass < 3; pass += 1) {
        await assertNoConflictingJobs(queues, runId, ["active"]);
        let found = false;
        for (const queue of queues) {
          for (const job of await queue.getJobs([...targetedStates])) {
            const attribution = classifyJob(queue, job, runId);
            if (attribution === "malformed_target") throw malformedJobError(runId, queue, job);
            if (attribution !== "target") continue;
            found = true;
            try {
              await job.remove();
              removed.add(`${queue.semanticName}:${job.id ?? job.name}`);
            } catch {
              // The rescan decides whether a state change is safely retryable.
            }
          }
        }
        await assertNoConflictingJobs(queues, runId, ["active"]);
        if (!found || !(await hasTargetedJobs(queues, runId))) {
          return { deletedJobCount: removed.size };
        }
      }
      throw new DemoQueueMaintenanceConflict(
        "not_quiescent",
        "Run-owned queue jobs changed state during teardown; retry after workers settle.",
      );
    },

    close() {
      const leaseDone = activeLeaseDone;
      closePromise ??= (async () => {
        await leaseDone;
        await closeQueues(queues, queuesNeedingResume);
      })();
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
    drain: (delayed) => queue.drain(delayed),
    clean: (grace, limit, state) => queue.clean(grace, limit, state),
    getJobs: (states) => queue.getJobs(states as Parameters<Queue["getJobs"]>[0], 0, -1, true),
    close: () => queue.close(),
  };
}

async function resumeQueues(
  queues: Iterable<TargetQueueBoundary>,
  queuesNeedingResume: Set<TargetQueueBoundary>,
): Promise<unknown[]> {
  const attempted = [...queues];
  const results = await Promise.allSettled(attempted.map((queue) => queue.resume()));
  const errors: unknown[] = [];
  results.forEach((result, index) => {
    const queue = attempted[index];
    if (!queue) return;
    if (result.status === "fulfilled") queuesNeedingResume.delete(queue);
    else errors.push(result.reason);
  });
  return errors;
}

async function closeQueues(
  queues: TargetQueueBoundary[],
  queuesNeedingResume: Set<TargetQueueBoundary>,
): Promise<void> {
  const resumeErrors = await resumeQueues(queuesNeedingResume, queuesNeedingResume);
  const closeResults = await Promise.allSettled(queues.map((queue) => queue.close()));
  const errors = [
    ...resumeErrors,
    ...closeResults.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
  ];
  if (errors.length > 0) {
    throw new AggregateError(errors, "Could not fully restore and close queue maintenance.");
  }
}

async function assertNoConflictingJobs(
  queues: TargetQueueBoundary[],
  runId: string,
  states: string[],
): Promise<void> {
  for (const queue of queues) {
    for (const job of await queue.getJobs(states)) {
      const attribution = classifyJob(queue, job, runId);
      if (attribution === "malformed_target") throw malformedJobError(runId, queue, job);
      if (attribution === "target") {
        throw new DemoQueueMaintenanceConflict(
          "active_job",
          `Run ${runId} has active work on ${queue.semanticName}; retry after it settles.`,
        );
      }
    }
  }
}

type JobAttribution = "target" | "other" | "malformed_target";

function classifyJob(
  queue: TargetQueueBoundary,
  job: Pick<TargetQueueJob, "data">,
  runId: string,
): JobAttribution {
  try {
    return queue.parse(job.data).runId === runId ? "target" : "other";
  } catch {
    return (job.data as { runId?: unknown } | null)?.runId === runId ? "malformed_target" : "other";
  }
}

async function hasTargetedJobs(queues: TargetQueueBoundary[], runId: string): Promise<boolean> {
  for (const queue of queues) {
    for (const job of await queue.getJobs([...targetedStates, "active"])) {
      const attribution = classifyJob(queue, job, runId);
      if (attribution === "malformed_target") throw malformedJobError(runId, queue, job);
      if (attribution === "target") return true;
    }
  }
  return false;
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
