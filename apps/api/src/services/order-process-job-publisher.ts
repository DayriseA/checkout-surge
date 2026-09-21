import type { OrderProcessJob } from "@checkout-surge/contracts";

export interface OrderProcessJobPublisher {
  enqueue(job: OrderProcessJob): Promise<void>;
}
