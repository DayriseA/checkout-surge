import { catalogErpDispatchLimits, erpDispatchRateLimit } from "@checkout-surge/contracts";
import { type CheckoutSurgeDatabase, demoRuns } from "@checkout-surge/db";
import { inArray } from "drizzle-orm";
import { parsePersistedAcceptedRunConfigSnapshot } from "./persisted-demo-run-state.js";

export interface OrderProcessQueueLimits {
  synchronize(): Promise<void>;
}

export interface OrderProcessQueueLimitsWriter {
  setLimits(input: { concurrency: number; max: number; duration: number }): Promise<void>;
}

/** API-only owner. Read inside the serialized operation so an old terminal
 * callback cannot overwrite a newly accepted run's limits with catalog defaults. */
export class DemoRunQueueLimits implements OrderProcessQueueLimits {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: CheckoutSurgeDatabase,
    private readonly queue: OrderProcessQueueLimitsWriter,
  ) {}

  synchronize(): Promise<void> {
    const operation = this.pending
      .catch(() => undefined)
      .then(async () => {
        const [run] = await this.db
          .select({ id: demoRuns.id, snapshot: demoRuns.configSnapshot })
          .from(demoRuns)
          .where(inArray(demoRuns.status, ["starting", "active", "draining"]))
          .limit(1);
        const snapshot = run
          ? parsePersistedAcceptedRunConfigSnapshot(run.snapshot, `demo run ${run.id} queue limits`)
          : null;
        await this.queue.setLimits({
          concurrency:
            snapshot?.backpressureConfig.orderProcessConcurrency ??
            catalogErpDispatchLimits.concurrency,
          ...erpDispatchRateLimit(snapshot?.erpConfig.maxTps ?? catalogErpDispatchLimits.maxTps),
        });
      });
    this.pending = operation;
    return operation;
  }
}
