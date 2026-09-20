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
