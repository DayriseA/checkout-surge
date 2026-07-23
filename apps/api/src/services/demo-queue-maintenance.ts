export interface QueueCleanupSummary {
  cleanedQueueCount: number;
  cleanedJobCount: number;
}

export interface ResetQueueMaintenance {
  cleanResetOwnedQueues(): Promise<QueueCleanupSummary>;
}

export interface DemoQueueQuiescenceLease {
  /** Restores every queue pause introduced by this maintenance operation. */
  release(): Promise<void>;
}

export interface GeneratedRunQueueMaintenance {
  acquireGeneratedRunQuiescence(runId: string): Promise<DemoQueueQuiescenceLease>;
  preflightGeneratedRun(runId: string): Promise<void>;
  cleanGeneratedRun(runId: string): Promise<{ deletedJobCount: number }>;
}

export type DemoQueueMaintenance = ResetQueueMaintenance & GeneratedRunQueueMaintenance;

export type DemoQueueMaintenanceConflictCode =
  | "active_job"
  | "malformed_claimed_job"
  | "not_quiescent";

export class DemoQueueMaintenanceConflict extends Error {
  constructor(
    readonly code: DemoQueueMaintenanceConflictCode,
    message: string,
  ) {
    super(message);
    this.name = "DemoQueueMaintenanceConflict";
  }
}
