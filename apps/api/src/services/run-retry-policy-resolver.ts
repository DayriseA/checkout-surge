import type { BackpressureConfig } from "@checkout-surge/contracts";

export interface RunRetryPolicyResolver {
  resolve(runId: string): Promise<BackpressureConfig["retryPolicy"] | null>;
}
