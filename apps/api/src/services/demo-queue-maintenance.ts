export interface QueueCleanupSummary {
  cleanedQueueCount: number;
  cleanedJobCount: number;
}

export interface ExactRunQueueMaintenance {
  cleanRuns(
    runIds: readonly string[],
    settlement?: { deadline: number },
  ): Promise<QueueCleanupSummary>;
}

export type DemoQueueMaintenance = ExactRunQueueMaintenance;

export interface CompletedOrderJobRemoval {
  /** Removes those of the given order jobs that are completed, without pausing any queue. */
  removeCompletedOrderJobs(jobIds: readonly string[]): Promise<number>;
}

export type DemoQueueMaintenanceConflictCode = "active_job" | "malformed_claimed_job";

export class DemoQueueMaintenanceConflict extends Error {
  constructor(
    readonly code: DemoQueueMaintenanceConflictCode,
    message: string,
  ) {
    super(message);
    this.name = "DemoQueueMaintenanceConflict";
  }
}
