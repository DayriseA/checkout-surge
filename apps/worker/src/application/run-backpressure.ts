import type { OrderProcessJob } from "@checkout-surge/contracts";
import type {
  OrderConfirmation,
  OrderProcessDeliveryMetadata,
} from "./order-process-job-handler.js";
import type { RunConfigReader } from "./run-config.js";

export class RunScopedBackpressureOrderConfirmation implements OrderConfirmation {
  private readonly semaphores = new Map<string, Semaphore>();

  constructor(
    private readonly options: {
      inner: OrderConfirmation;
      runConfigReader: RunConfigReader;
    },
  ) {}

  async confirm(job: OrderProcessJob, delivery: OrderProcessDeliveryMetadata): Promise<unknown> {
    if (!job.runId) {
      return this.options.inner.confirm(job, delivery);
    }

    const snapshot = await this.options.runConfigReader.read(job.runId);
    if (!snapshot) {
      return this.options.inner.confirm(job, delivery);
    }

    const concurrency = snapshot.backpressureConfig.orderProcessConcurrency;
    const semaphore = this.getSemaphore(job.runId, concurrency);
    return semaphore.run(() => this.options.inner.confirm(job, delivery));
  }

  private getSemaphore(runId: string, concurrency: number): Semaphore {
    const key = `${runId}:${concurrency}`;
    let semaphore = this.semaphores.get(key);

    if (!semaphore) {
      semaphore = new Semaphore(concurrency);
      this.semaphores.set(key, semaphore);
    }

    return semaphore;
  }
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maxActive: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxActive) {
      this.active += 1;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    next?.();
  }
}
