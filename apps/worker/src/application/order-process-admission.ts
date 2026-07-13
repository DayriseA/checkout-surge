import type { OrderProcessJob } from "@checkout-surge/contracts";

export interface OrderProcessAdmissionLease {
  release(): Promise<void>;
}

export interface OrderProcessAdmission {
  tryAcquire(job: OrderProcessJob): Promise<OrderProcessAdmissionLease | null>;
  close(): Promise<void>;
}
