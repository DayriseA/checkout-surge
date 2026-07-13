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
  readMaintenancePauseOwner(): Promise<string | null>;
  claimMaintenancePauseOwnership(
    runId: string,
  ): Promise<
    { outcome: "claimed" | "already_owned" } | { outcome: "foreign_owner"; runId: string }
  >;
  clearMaintenancePauseOwnership(runId: string): Promise<boolean>;
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
  const ownedPauseRestorations = new Map<TargetQueueBoundary, string>();
  let quiescenceTail = Promise.resolve();
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

    async acquireGeneratedRunQuiescence(runId) {
      if (closePromise) {
        throw new Error("Queue maintenance is closing and cannot acquire quiescence.");
      }

      const previousTurn = quiescenceTail;
      let finishTurn!: () => void;
      // Reserving a new unresolved tail before waiting makes acquisitions FIFO:
      // every later caller waits for this lease's complete release path.
      quiescenceTail = new Promise<void>((resolve) => {
        finishTurn = resolve;
      });
      await previousTurn;

      const newlyClaimed = new Set<TargetQueueBoundary>();
      const leaseOwnedQueues = new Set<TargetQueueBoundary>();
      try {
        for (const queue of queues) {
          const existingOwner =
            ownedPauseRestorations.get(queue) ?? (await queue.readMaintenancePauseOwner());
          if (existingOwner) {
            if (existingOwner !== runId) throw foreignOwnerError(queue, existingOwner, runId);
            ownedPauseRestorations.set(queue, runId);
            leaseOwnedQueues.add(queue);
            if (!(await queue.isPaused())) await queue.pause();
            continue;
          }
          if (await queue.isPaused()) continue;
          const claim = await queue.claimMaintenancePauseOwnership(runId);
          if (claim.outcome === "foreign_owner") {
            throw foreignOwnerError(queue, claim.runId, runId);
          }
          if (claim.outcome === "claimed") newlyClaimed.add(queue);
          leaseOwnedQueues.add(queue);
          ownedPauseRestorations.set(queue, runId);
          await queue.pause();
        }
      } catch (error) {
        const rollbackErrors = await restoreQueueStates(
          newlyClaimed,
          runId,
          ownedPauseRestorations,
        );
        finishTurn();
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
        async release(options) {
          if (released) return;
          released = true;
          try {
            if (options.disposition === "retain_owned_pauses") return;
            const errors = await restoreQueueStates(
              leaseOwnedQueues,
              runId,
              ownedPauseRestorations,
            );
            if (errors.length > 0) {
              throw new AggregateError(errors, "Could not fully restore queue pause state.");
            }
            await options.afterRestored?.();
          } finally {
            finishTurn();
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
      closePromise ??= (async () => {
        await quiescenceTail;
        await Promise.all(queues.map((queue) => queue.close()));
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
  const maintenancePauseOwnershipKey = queue.toKey(
    "checkout-surge:generated-run-maintenance-pause-owned",
  );
  let scriptsDefined = false;
  const maintenancePauseClaimCommand = "checkoutSurgeClaimGeneratedRunMaintenancePause";
  const maintenancePauseClearCommand = "checkoutSurgeClearGeneratedRunMaintenancePause";
  const maintenanceClient = async () => {
    const client = await queue.client;
    if (!scriptsDefined) {
      client.defineCommand(maintenancePauseClaimCommand, {
        numberOfKeys: 1,
        lua: `
          local current = redis.call("GET", KEYS[1])
          if not current then
            redis.call("SET", KEYS[1], ARGV[1])
            return {"claimed", ARGV[1]}
          end
          if current == ARGV[1] then
            return {"already_owned", current}
          end
          return {"foreign_owner", current}
        `,
      });
      client.defineCommand(maintenancePauseClearCommand, {
        numberOfKeys: 1,
        lua: `
          if redis.call("GET", KEYS[1]) == ARGV[1] then
            return redis.call("DEL", KEYS[1])
          end
          return 0
        `,
      });
      scriptsDefined = true;
    }
    return client;
  };
  return {
    semanticName,
    parse,
    isPaused: () => queue.isPaused(),
    pause: () => queue.pause(),
    resume: () => queue.resume(),
    drain: (delayed) => queue.drain(delayed),
    clean: (grace, limit, state) => queue.clean(grace, limit, state),
    getJobs: (states) => queue.getJobs(states as Parameters<Queue["getJobs"]>[0], 0, -1, true),
    readMaintenancePauseOwner: async () =>
      (await maintenanceClient()).get(maintenancePauseOwnershipKey),
    claimMaintenancePauseOwnership: async (runId) => {
      const result = (await (
        await maintenanceClient()
      ).runCommand(maintenancePauseClaimCommand, [maintenancePauseOwnershipKey, runId])) as [
        "claimed" | "already_owned" | "foreign_owner",
        string,
      ];
      return result[0] === "foreign_owner"
        ? { outcome: result[0], runId: result[1] }
        : { outcome: result[0] };
    },
    clearMaintenancePauseOwnership: async (runId) =>
      Number(
        await (await maintenanceClient()).runCommand(maintenancePauseClearCommand, [
          maintenancePauseOwnershipKey,
          runId,
        ]),
      ) === 1,
    close: () => queue.close(),
  };
}

async function restoreQueueStates(
  queues: Iterable<TargetQueueBoundary>,
  runId: string,
  ownedPauseRestorations: Map<TargetQueueBoundary, string>,
): Promise<unknown[]> {
  const attempted = [...queues];
  const results = await Promise.allSettled(
    attempted.map(async (queue) => {
      const owner = await queue.readMaintenancePauseOwner();
      if (owner !== runId) {
        throw new Error(
          `Cannot restore ${queue.semanticName}: maintenance pause is owned by ${owner ?? "no run"}, not ${runId}.`,
        );
      }
      await queue.resume();
      if (!(await queue.clearMaintenancePauseOwnership(runId))) {
        await queue.pause();
        throw new Error(
          `Could not clear ${queue.semanticName} maintenance pause ownership for run ${runId}.`,
        );
      }
    }),
  );
  const errors: unknown[] = [];
  results.forEach((result, index) => {
    const queue = attempted[index];
    if (!queue) return;
    if (result.status === "fulfilled") ownedPauseRestorations.delete(queue);
    else errors.push(result.reason);
  });
  return errors;
}

function foreignOwnerError(
  queue: TargetQueueBoundary,
  ownerRunId: string,
  requestedRunId: string,
): DemoQueueMaintenanceConflict {
  return new DemoQueueMaintenanceConflict(
    "maintenance_owned_by_other_run",
    `${queue.semanticName} is paused for generated-run maintenance owned by run ${ownerRunId}; retry run ${requestedRunId} after the owning teardown completes.`,
  );
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
