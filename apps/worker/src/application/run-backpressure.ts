import type { AcceptedRunConfigSnapshot, OrderProcessJob } from "@checkout-surge/contracts";
import type {
  OrderConfirmation,
  OrderProcessDeliveryMetadata,
} from "./order-process-job-handler.js";
import type { RunConfigReader } from "./run-config.js";

export type RunCircuitBreakerFactory = (
  snapshot: AcceptedRunConfigSnapshot,
  runId: string,
) => OrderConfirmation;

interface RunCircuitBreakerEntry {
  configKey: string;
  confirmation: OrderConfirmation;
  activeConfirmationCount: number;
  lastUsedAtMs: number;
  retentionMs: number;
}

export class RunScopedBackpressureOrderConfirmation implements OrderConfirmation {
  private readonly semaphores = new Map<string, Semaphore>();
  private readonly runCircuitBreakers = new Map<string, RunCircuitBreakerEntry>();

  constructor(
    private readonly options: {
      inner: OrderConfirmation;
      runConfigReader: RunConfigReader;
      circuitBreakerFactory?: RunCircuitBreakerFactory;
      breakerRetentionMs?: number;
      now?: () => Date;
      onMissingRunSnapshot?: (runId: string) => void | Promise<void>;
    },
  ) {}

  async confirm(job: OrderProcessJob, delivery: OrderProcessDeliveryMetadata): Promise<unknown> {
    if (!job.runId) {
      return this.options.inner.confirm(job, delivery);
    }

    const snapshot = await this.options.runConfigReader.read(job.runId);
    if (!snapshot) {
      this.reportMissingRunSnapshot(job.runId);
      return this.options.inner.confirm(job, delivery);
    }

    const nowMs = this.nowMs();
    this.evictExpiredCircuitBreakers(nowMs);
    const concurrency = snapshot.backpressureConfig.orderProcessConcurrency;
    const semaphore = this.getSemaphore(job.runId, concurrency);
    const entry = this.getCircuitBreaker(job.runId, snapshot, nowMs);
    if (!entry) return semaphore.run(() => this.options.inner.confirm(job, delivery));
    entry.activeConfirmationCount += 1;
    try {
      return await semaphore.run(() => entry.confirmation.confirm(job, delivery));
    } finally {
      entry.activeConfirmationCount -= 1;
      entry.lastUsedAtMs = this.nowMs();
    }
  }

  private getCircuitBreaker(
    runId: string,
    snapshot: AcceptedRunConfigSnapshot,
    nowMs: number,
  ): RunCircuitBreakerEntry | null {
    if (!this.options.circuitBreakerFactory) return null;
    const configKey = JSON.stringify({
      failureThreshold: snapshot.backpressureConfig.circuitBreakerFailureThreshold,
      resetTimeoutMs: snapshot.backpressureConfig.circuitBreakerResetTimeoutMs,
    });
    const existing = this.runCircuitBreakers.get(runId);
    if (existing?.configKey === configKey) {
      existing.lastUsedAtMs = nowMs;
      return existing;
    }
    const confirmation = this.options.circuitBreakerFactory(snapshot, runId);
    const entry = {
      configKey,
      confirmation,
      activeConfirmationCount: 0,
      lastUsedAtMs: nowMs,
      retentionMs: Math.max(
        this.options.breakerRetentionMs ?? 86_400_000,
        doubledDurationMs(snapshot.backpressureConfig.circuitBreakerResetTimeoutMs),
      ),
    };
    this.runCircuitBreakers.set(runId, entry);
    return entry;
  }

  private evictExpiredCircuitBreakers(nowMs: number): void {
    for (const [runId, entry] of this.runCircuitBreakers) {
      if (entry.activeConfirmationCount === 0 && nowMs - entry.lastUsedAtMs >= entry.retentionMs) {
        this.runCircuitBreakers.delete(runId);
      }
    }
  }

  private nowMs(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }

  private reportMissingRunSnapshot(runId: string): void {
    if (!this.options.onMissingRunSnapshot) return;
    try {
      void Promise.resolve(this.options.onMissingRunSnapshot(runId)).catch(() => undefined);
    } catch {
      // Observability must never prevent the explicitly configured fallback path.
    }
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

function doubledDurationMs(durationMs: number): number {
  return durationMs > Number.MAX_SAFE_INTEGER / 2 ? Number.MAX_SAFE_INTEGER : durationMs * 2;
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
