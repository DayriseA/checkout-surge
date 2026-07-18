import type { BackpressureConfig, OrderProcessJob } from "@checkout-surge/contracts";

export interface OrderProcessJobPublishOptions {
  retryPolicy: BackpressureConfig["retryPolicy"];
}

export interface OrderProcessJobPublisher {
  enqueue(job: OrderProcessJob, options?: OrderProcessJobPublishOptions): Promise<void>;
}
