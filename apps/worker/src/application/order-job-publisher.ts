import type { OrderProcessJob } from "@checkout-surge/contracts";

export interface OrderJobPublisher {
  enqueue(job: OrderProcessJob, options?: { jobId?: string; attempts?: number }): Promise<void>;
}
