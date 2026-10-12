import type { OrderProcessJob } from "@checkout-surge/contracts";

export interface OrderJobPublisher {
  enqueue(job: OrderProcessJob, options?: { jobId?: string }): Promise<void>;
}

export interface OrderJobPresence {
  /** The given job IDs that have no job in the queue, in any state. */
  missingJobIds(jobIds: string[]): Promise<string[]>;
}
