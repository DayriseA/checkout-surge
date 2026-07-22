import type { OrderProcessJob } from "@checkout-surge/contracts";
import type { RunConfigReader } from "./run-config.js";

export interface OrderProcessAdmissionPermit {
  release(): Promise<void>;
}

export interface OrderProcessAdmission {
  tryAcquire(job: OrderProcessJob): Promise<OrderProcessAdmissionPermit | null>;
  close(): Promise<void>;
}

export class ProcessLocalOrderProcessAdmission implements OrderProcessAdmission {
  private readonly activeByScope = new Map<string, number>();
  private readonly permits = new Set<ProcessLocalPermit>();
  private closing = false;

  constructor(
    private readonly options: {
      runConfigReader: RunConfigReader;
      fallbackConcurrency: number;
    },
  ) {}

  async tryAcquire(job: OrderProcessJob): Promise<OrderProcessAdmissionPermit | null> {
    if (this.closing) return null;

    const limit = await this.resolveLimit(job);
    if (this.closing) return null;

    const scope = job.runId ?? "catalog";
    const active = this.activeByScope.get(scope) ?? 0;
    if (active >= limit) return null;

    this.activeByScope.set(scope, active + 1);
    const permit = new ProcessLocalPermit(() => {
      this.permits.delete(permit);
      const remaining = (this.activeByScope.get(scope) ?? 1) - 1;
      if (remaining === 0) {
        this.activeByScope.delete(scope);
      } else {
        this.activeByScope.set(scope, remaining);
      }
    });
    this.permits.add(permit);
    return permit;
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.permits].map((permit) => permit.release()));
  }

  private async resolveLimit(job: OrderProcessJob): Promise<number> {
    if (!job.runId) return this.options.fallbackConcurrency;

    const snapshot = await this.options.runConfigReader.read(job.runId);
    if (!snapshot) {
      throw new Error(`Accepted run snapshot was not found for order job run ${job.runId}.`);
    }
    return snapshot.backpressureConfig.orderProcessConcurrency;
  }
}

class ProcessLocalPermit implements OrderProcessAdmissionPermit {
  private released = false;

  constructor(private readonly onRelease: () => void) {}

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.onRelease();
  }
}
